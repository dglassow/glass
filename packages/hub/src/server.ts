/**
 * Hub — registry + relay (plan §2), with device-key authentication (Phase 2).
 *
 * A peer's first frame is either `hello` (to authenticate) or
 * `device.enroll.request` (to join). In TRUST mode the hub admits only
 * deviceIds in its trust store, and only after a challenge/response proof of
 * key possession: hello -> hello.challenge{nonce} -> hello.proof{signature} ->
 * hello.ack. Crucially, registration AND stale-socket eviction happen only
 * AFTER the proof verifies, so an unauthenticated impostor claiming a trusted
 * id can neither register nor knock the real device offline.
 *
 * Enrollment (plan §8) rides a frame-locked pre-auth lane: the requester sends
 * exactly one device.enroll.request; the hub broadcasts a pending notice to
 * authenticated devices; an approver echoes the matching code; the hub adds the
 * key and closes the requester, which then reconnects and authenticates for
 * real. The enrollment socket is never promoted.
 *
 * OPEN mode (`--open`) skips all of this and behaves like Phase 1 — used only by
 * the pre-auth acceptance harnesses. The hub refuses to start in neither mode.
 *
 * Routing itself is unchanged: verbatim forward by envelope.to, from bound to
 * the authenticated identity, explicit errors instead of silent drops.
 */
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import {
  parseEnvelope,
  makeEnvelope,
  checkCompatibility,
  verifyHandshakeProof,
  isValidPublicKey,
  randomNonce,
  HUB,
  DeviceId,
  PROTOCOL_VERSION,
  type Envelope,
  type Body,
  type DeviceRecord,
  type DeviceRole,
} from "@glass/protocol";
import type { TrustStore } from "./trust-store.js";
import type { CredentialStore } from "./credential-store.js";
import { Passkey, responseCredentialId } from "./passkey.js";

const APP_VERSION = "0.0.0";
const HANDSHAKE_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 15000;
const BUFFER_CAP_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_ENROLL_TTL_MS = 120_000;

interface Entry {
  socket: WebSocket | null;
  record: DeviceRecord;
  epoch: number;
}

interface PendingProof {
  deviceId: DeviceId;
  nonce: string;
  publicKey: string;
  helloId: string;
  name: string;
  roles: DeviceRole[];
  appVersion: string;
  etchPresent: boolean;
}

interface PendingEnroll {
  deviceId: string;
  deviceName: string;
  roles: DeviceRole[];
  publicKey: string;
  code: string;
  expiresAt: number;
  requester: WebSocket;
  status: "pending" | "approved";
  timer: ReturnType<typeof setTimeout>;
}

export interface HubServer {
  readonly url: string;
  readonly deviceCount: () => number;
  readonly close: () => Promise<void>;
}

export interface HubServerOptions {
  host?: string;
  port?: number;
  /** "trust" enforces device-key auth against `trustStore`; "open" is Phase 1 behavior. */
  mode: "trust" | "open";
  trustStore?: TrustStore;
  enrollTtlMs?: number;
  /** Passkey bootstrap (plan §8.4). All three are set together or not at all. */
  credentialStore?: CredentialStore;
  passkey?: Passkey;
  registerToken?: string;
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

export function startHubServer(opts: HubServerOptions): Promise<HubServer> {
  const host = opts.host ?? "127.0.0.1";
  const enrollTtlMs = opts.enrollTtlMs ?? DEFAULT_ENROLL_TTL_MS;
  const trustStore = opts.trustStore;
  if (opts.mode === "trust" && !trustStore) throw new Error("trust mode requires a trust store");

  const registry = new Map<string, Entry>();
  const pendingEnrollments = new Map<string, PendingEnroll>();
  const credentialSessions = new Set<WebSocket>();
  const liveness = new WeakMap<WebSocket, boolean>();
  const credentialStore = opts.credentialStore;
  const passkey = opts.passkey;
  let epochCounter = 0;

  const wss = new WebSocketServer({ host, port: opts.port ?? 0, maxPayload: MAX_PAYLOAD_BYTES });

  function rawSend(socket: WebSocket, env: Envelope): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > BUFFER_CAP_BYTES) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(env));
  }

  function reply(socket: WebSocket, to: string, body: Body, inReplyTo?: string): void {
    rawSend(
      socket,
      makeEnvelope(
        inReplyTo === undefined
          ? { id: randomUUID(), ts: Date.now(), from: HUB, to, body }
          : { id: randomUUID(), ts: Date.now(), from: HUB, to, body, replyTo: inReplyTo },
      ),
    );
  }

  function broadcastToAuthenticated(body: (record: DeviceRecord) => Body): void {
    for (const entry of registry.values()) {
      if (entry.socket && entry.socket.readyState === WebSocket.OPEN && entry.record.state === "connected") {
        reply(entry.socket, entry.record.id, body(entry.record));
      }
    }
  }

  /** Pending enrollments go to authenticated devices AND passkey-authed owner sessions. */
  function broadcastEnrollPending(body: Body): void {
    broadcastToAuthenticated(() => body);
    for (const socket of credentialSessions) {
      if (socket.readyState === WebSocket.OPEN) reply(socket, "hub-credential", body);
    }
  }

  function registerAuthenticated(socket: WebSocket, pp: PendingProof): number {
    const prev = registry.get(pp.deviceId);
    if (prev && prev.socket && prev.socket !== socket) prev.socket.terminate();
    const epoch = ++epochCounter;
    const record: DeviceRecord = {
      id: pp.deviceId,
      name: pp.name,
      roles: pp.roles,
      state: "connected",
      lastSeen: Date.now(),
      appVersion: pp.appVersion,
      etchPresent: pp.etchPresent,
    };
    registry.set(pp.deviceId, { socket, record, epoch });
    reply(
      socket,
      pp.deviceId,
      { type: "hello.ack", protocolVersion: PROTOCOL_VERSION, appVersion: APP_VERSION, compatibility: "ok" },
      pp.helloId,
    );
    broadcastToAuthenticated(() => ({ type: "device.state", device: record }));
    return epoch;
  }

  wss.on("connection", (socket) => {
    let state: "first" | "await-proof" | "verifying" | "enroll-locked" | "cred-ceremony" | "credential-authed" | "registered" = "first";
    let deviceId: string | null = null;
    let epoch = -1;
    let pendingProof: PendingProof | null = null;
    let credChallenge: { scope: "register" | "auth"; challenge: string; name: string } | null = null;
    liveness.set(socket, true);
    socket.on("pong", () => liveness.set(socket, true));

    const handshakeTimer = setTimeout(() => {
      if (state !== "registered") socket.close(4001, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    function refuseUnexpected(): void {
      socket.close(4009, "unexpected frame");
    }

    function handleHello(env: Envelope): void {
      if (env.body.type !== "hello") {
        socket.close(4003, "expected hello or device.enroll.request as the first frame");
        return;
      }
      const hello = env.body;
      if (env.from !== hello.deviceId) return void socket.close(4004, "envelope.from must equal hello.deviceId");
      if (hello.deviceId === HUB) return void socket.close(4005, 'the device id "hub" is reserved');

      const verdict = checkCompatibility(hello.protocolVersion);
      if (verdict.status !== "ok") {
        reply(socket, hello.deviceId, { type: "hello.ack", protocolVersion: PROTOCOL_VERSION, appVersion: APP_VERSION, compatibility: verdict.status }, env.id);
        socket.close(4006, `incompatible protocol version: ${verdict.status}`);
        return;
      }

      if (opts.mode === "open") {
        // Phase 1 behavior: register immediately, no proof.
        pendingProof = {
          deviceId: hello.deviceId, nonce: "", publicKey: "", helloId: env.id,
          name: hello.deviceName, roles: hello.roles, appVersion: hello.appVersion, etchPresent: hello.etch.present,
        };
        epoch = registerAuthenticated(socket, pendingProof);
        deviceId = hello.deviceId;
        state = "registered";
        clearTimeout(handshakeTimer);
        pendingProof = null;
        return;
      }

      // trust mode: challenge only known devices.
      const trusted = trustStore!.get(hello.deviceId);
      if (!trusted) return void socket.close(4007, "device not in trust store");
      const nonce = randomNonce();
      pendingProof = {
        deviceId: hello.deviceId, nonce, publicKey: trusted.publicKey, helloId: env.id,
        name: trusted.name, roles: trusted.roles, appVersion: hello.appVersion, etchPresent: hello.etch.present,
      };
      state = "await-proof";
      reply(socket, hello.deviceId, { type: "hello.challenge", nonce, alg: "ed25519" }, env.id);
    }

    function handleProof(env: Envelope): void {
      if (env.body.type !== "hello.proof" || !pendingProof) return void refuseUnexpected();
      const proof = env.body;
      const pp = pendingProof;
      if (env.from !== pp.deviceId || proof.deviceId !== pp.deviceId) return void socket.close(4008, "proof identity mismatch");
      state = "verifying";
      pendingProof = null;
      void verifyHandshakeProof(pp.publicKey, pp.deviceId, pp.nonce, proof.signature).then((ok) => {
        if (!ok) {
          socket.close(4008, "invalid proof");
          return;
        }
        epoch = registerAuthenticated(socket, pp);
        deviceId = pp.deviceId;
        state = "registered";
        clearTimeout(handshakeTimer);
      });
    }

    function handleEnrollRequest(env: Envelope): void {
      if (opts.mode === "open" || env.body.type !== "device.enroll.request") {
        socket.close(4003, "expected hello as the first frame");
        return;
      }
      const req = env.body;
      if (env.from !== req.deviceId) return void socket.close(4004, "envelope.from must equal deviceId");
      if (req.deviceId === HUB) return void socket.close(4005, 'the device id "hub" is reserved');
      if (trustStore!.has(req.deviceId)) {
        reply(socket, req.deviceId, { type: "error", code: "unauthorized", message: "device already enrolled" }, env.id);
        socket.close(4007, "already enrolled");
        return;
      }
      state = "enroll-locked"; // frame-lock synchronously; no self-approval, no second frame
      void (async () => {
        if (!(await isValidPublicKey(req.publicKey))) {
          socket.close(4008, "invalid public key");
          return;
        }
        for (const [rid, pe] of pendingEnrollments) {
          if (pe.deviceId === req.deviceId) {
            clearTimeout(pe.timer);
            pendingEnrollments.delete(rid);
          }
        }
        const requestId = randomUUID();
        const expiresAt = Date.now() + enrollTtlMs;
        const timer = setTimeout(() => {
          const pe = pendingEnrollments.get(requestId);
          pendingEnrollments.delete(requestId);
          if (pe && pe.status === "pending") {
            reply(pe.requester, pe.deviceId, { type: "device.enroll.decision", requestId, approved: false });
            pe.requester.close(4001, "enrollment expired");
          }
        }, enrollTtlMs);
        (timer as { unref?: () => void }).unref?.();
        pendingEnrollments.set(requestId, {
          deviceId: req.deviceId, deviceName: req.deviceName, roles: req.roles, publicKey: req.publicKey,
          code: req.verificationCode, expiresAt, requester: socket, status: "pending", timer,
        });
        reply(socket, req.deviceId, { type: "device.enroll.pending", requestId, deviceName: req.deviceName, verificationCode: req.verificationCode, expiresAt }, env.id);
        broadcastEnrollPending({ type: "device.enroll.pending", requestId, deviceName: req.deviceName, verificationCode: req.verificationCode, expiresAt });
      })();
    }

    function handleCredentialBegin(env: Envelope): void {
      if (!passkey || !credentialStore) return void socket.close(4003, "passkey not enabled");
      const body = env.body;
      if (body.type === "credential.register.begin") {
        // Token-gated bootstrap: only someone with local hub access can register the first passkey.
        if (!opts.registerToken || body.token !== opts.registerToken) return void socket.close(4007, "invalid registration token");
        const name = body.name;
        state = "cred-ceremony";
        void (async () => {
          const { options, challenge } = await passkey.registrationOptions(name);
          credChallenge = { scope: "register", challenge, name };
          reply(socket, "hub-credential", { type: "credential.options", scope: "register", options }, env.id);
        })();
        return;
      }
      if (body.type === "credential.auth.begin") {
        if (credentialStore.isEmpty()) return void socket.close(4007, "no credentials registered");
        state = "cred-ceremony";
        void (async () => {
          const { options, challenge } = await passkey.authenticationOptions(credentialStore.list().map((c) => c.id));
          credChallenge = { scope: "auth", challenge, name: "" };
          reply(socket, "hub-credential", { type: "credential.options", scope: "auth", options }, env.id);
        })();
        return;
      }
      socket.close(4003, "expected a credential ceremony frame");
    }

    function promoteToCredentialAuthed(): void {
      credentialSessions.add(socket);
      state = "credential-authed";
      clearTimeout(handshakeTimer);
    }

    function handleCredentialCeremony(env: Envelope): void {
      const chal = credChallenge;
      if (!passkey || !credentialStore || !chal) return void refuseUnexpected();
      const body = env.body;
      if (chal.scope === "register" && body.type === "credential.register.finish") {
        state = "verifying";
        credChallenge = null;
        void (async () => {
          const cred = await passkey.verifyRegistration(body.response, chal.challenge, chal.name);
          if (!cred) {
            reply(socket, "hub-credential", { type: "credential.result", scope: "register", ok: false, message: "registration failed" }, env.id);
            socket.close(4008, "registration failed");
            return;
          }
          credentialStore.add(cred);
          reply(socket, "hub-credential", { type: "credential.result", scope: "register", ok: true }, env.id);
          promoteToCredentialAuthed();
        })();
        return;
      }
      if (chal.scope === "auth" && body.type === "credential.auth.finish") {
        const credId = responseCredentialId(body.response);
        const stored = credId ? credentialStore.get(credId) : undefined;
        state = "verifying";
        credChallenge = null;
        if (!stored) {
          reply(socket, "hub-credential", { type: "credential.result", scope: "auth", ok: false, message: "unknown credential" }, env.id);
          socket.close(4008, "unknown credential");
          return;
        }
        void (async () => {
          const newCounter = await passkey.verifyAuthentication(body.response, chal.challenge, stored);
          if (newCounter === null) {
            reply(socket, "hub-credential", { type: "credential.result", scope: "auth", ok: false, message: "authentication failed" }, env.id);
            socket.close(4008, "authentication failed");
            return;
          }
          credentialStore.updateCounter(stored.id, newCounter);
          reply(socket, "hub-credential", { type: "credential.result", scope: "auth", ok: true }, env.id);
          promoteToCredentialAuthed();
        })();
        return;
      }
      refuseUnexpected();
    }

    function handleCredentialAuthed(env: Envelope): void {
      if (env.to !== HUB) return;
      const body = env.body;
      switch (body.type) {
        case "device.list":
          reply(socket, "hub-credential", { type: "device.listed", devices: [...registry.values()].map((e) => e.record) }, env.id);
          break;
        case "device.enroll.decision":
          handleDecision(socket, "hub-credential", env, body.requestId, body.approved, body.verificationCode);
          break;
        case "heartbeat":
          reply(socket, "hub-credential", { type: "heartbeat.ack", sentAt: body.sentAt, receivedAt: Date.now() }, env.id);
          break;
        default:
          break;
      }
    }

    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return void socket.close(4002, "binary frames are not part of the protocol");
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawToString(raw));
      } catch {
        return;
      }
      const res = parseEnvelope(parsed);
      if (!res.ok) return;
      const env = res.envelope;

      switch (state) {
        case "registered":
          handleAuthenticated(socket, deviceId as string, env);
          return;
        case "credential-authed":
          handleCredentialAuthed(env);
          return;
        case "await-proof":
          handleProof(env);
          return;
        case "cred-ceremony":
          handleCredentialCeremony(env);
          return;
        case "verifying":
        case "enroll-locked":
          refuseUnexpected();
          return;
        case "first":
          if (env.body.type === "hello") handleHello(env);
          else if (env.body.type === "device.enroll.request") handleEnrollRequest(env);
          else if (env.body.type === "credential.register.begin" || env.body.type === "credential.auth.begin") handleCredentialBegin(env);
          else socket.close(4003, "expected hello, device.enroll.request, or a credential ceremony");
          return;
      }
    });

    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      credentialSessions.delete(socket);
      // A dead enrollment requester voids its pending request (no blind approval).
      for (const [rid, pe] of pendingEnrollments) {
        if (pe.requester === socket && pe.status === "pending") {
          clearTimeout(pe.timer);
          pendingEnrollments.delete(rid);
        }
      }
      if (deviceId === null) return;
      const entry = registry.get(deviceId);
      if (entry && entry.epoch === epoch) {
        entry.socket = null;
        entry.record.state = "waiting";
        entry.record.lastSeen = Date.now();
        broadcastToAuthenticated(() => ({ type: "device.state", device: entry.record }));
      }
    });

    socket.on("error", () => {
      /* 'close' follows */
    });
  });

  function handleAuthenticated(socket: WebSocket, deviceId: string, env: Envelope): void {
    if (env.from !== deviceId) {
      return void reply(socket, deviceId, { type: "error", code: "unauthorized", message: "from does not match handshake identity" }, env.id);
    }
    if (checkCompatibility(env.v).status !== "ok") {
      return void reply(socket, deviceId, { type: "error", code: "version_incompatible", message: `envelope v=${env.v} is not supported` }, env.id);
    }
    const self = registry.get(deviceId);
    if (self) self.record.lastSeen = Date.now();

    if (env.to === HUB) return void handleHubMessage(socket, deviceId, env);
    route(socket, deviceId, env);
  }

  function handleHubMessage(socket: WebSocket, deviceId: string, env: Envelope): void {
    switch (env.body.type) {
      case "device.list":
        reply(socket, deviceId, { type: "device.listed", devices: [...registry.values()].map((e) => e.record) }, env.id);
        break;
      case "heartbeat":
        reply(socket, deviceId, { type: "heartbeat.ack", sentAt: env.body.sentAt, receivedAt: Date.now() }, env.id);
        break;
      case "device.enroll.decision":
        handleDecision(socket, deviceId, env, env.body.requestId, env.body.approved, env.body.verificationCode);
        break;
      default:
        break;
    }
  }

  function handleDecision(
    approver: WebSocket,
    approverId: string,
    env: Envelope,
    requestId: string,
    approved: boolean,
    code: string | undefined,
  ): void {
    const pe = pendingEnrollments.get(requestId);
    if (!pe || pe.expiresAt < Date.now()) {
      return void reply(approver, approverId, { type: "error", code: "enroll_unknown_request", message: "no such pending enrollment" }, env.id);
    }
    if (!approved) {
      clearTimeout(pe.timer);
      pendingEnrollments.delete(requestId);
      reply(pe.requester, pe.deviceId, { type: "device.enroll.decision", requestId, approved: false });
      pe.requester.close(1000, "enrollment denied");
      reply(approver, approverId, { type: "device.enroll.decision", requestId, approved: false, approvedBy: DeviceId.parse(approverId) }, env.id);
      return;
    }
    // Number matching is enforced here, not just in the UI.
    if (code !== pe.code) {
      clearTimeout(pe.timer);
      pendingEnrollments.delete(requestId);
      reply(approver, approverId, { type: "error", code: "enroll_code_mismatch", message: "verification code does not match" }, env.id);
      if (pe.status === "pending") {
        reply(pe.requester, pe.deviceId, { type: "device.enroll.decision", requestId, approved: false });
        pe.requester.close(1000, "code mismatch");
      }
      return;
    }
    if (pe.status === "pending") {
      trustStore!.add(pe.deviceId, {
        publicKey: pe.publicKey, name: pe.deviceName, roles: pe.roles, enrolledAt: Date.now(), approvedBy: approverId,
      });
      pe.status = "approved";
      reply(pe.requester, pe.deviceId, { type: "device.enroll.decision", requestId, approved: true, approvedBy: DeviceId.parse(approverId) });
      pe.requester.close(1000, "enrolled");
    }
    // Idempotent: a repeat correct approval within the TTL succeeds without re-adding.
    reply(approver, approverId, { type: "device.enroll.decision", requestId, approved: true, approvedBy: DeviceId.parse(approverId) }, env.id);
  }

  function route(socket: WebSocket, deviceId: string, env: Envelope): void {
    const target = registry.get(env.to);
    if (!target) {
      return void reply(socket, deviceId, { type: "error", code: "device_unknown", message: `no device registered as ${env.to}` }, env.id);
    }
    if (!target.socket || target.socket.readyState !== WebSocket.OPEN || target.record.state !== "connected") {
      return void reply(socket, deviceId, { type: "error", code: "device_unreachable", message: `device ${env.to} is not connected` }, env.id);
    }
    rawSend(target.socket, env);
  }

  const pingTimer = setInterval(() => {
    for (const entry of registry.values()) {
      const socket = entry.socket;
      if (!socket) continue;
      if (liveness.get(socket) === false) {
        socket.terminate();
        continue;
      }
      liveness.set(socket, false);
      socket.ping();
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref();

  return new Promise<HubServer>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? 0);
      resolve({
        url: `ws://${host}:${port}`,
        deviceCount: () => registry.size,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(pingTimer);
            for (const entry of registry.values()) entry.socket?.close();
            wss.close(() => res());
          }),
      });
    });
  });
}
