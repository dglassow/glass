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
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage } from "node:http";
import { randomUUID, randomInt } from "node:crypto";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  parseEnvelope,
  makeEnvelope,
  checkCompatibility,
  verifyHandshakeProof,
  isValidPublicKey,
  randomNonce,
  buildHubAuthPayload,
  base64urlEncode,
  HUB,
  DeviceId,
  PROTOCOL_VERSION,
  type Envelope,
  type Body,
  type DeviceRecord,
  type DeviceRole,
  type EnrollCompanion,
  type Signer,
  MAX_ENROLL_COMPANIONS,
} from "@glass/protocol";
import type { TrustStore } from "./trust-store.js";
import type { CredentialStore } from "./credential-store.js";
import { Passkey, responseCredentialId } from "./passkey.js";
import type { Vault } from "./vault/vault.js";
import type { GitStore } from "./git/git-store.js";
import { createGitHttpHandler } from "./git/git-http.js";
import { createStaticHandler } from "./web-static.js";
import { createUpdatesHandler } from "./updates-http.js";

const APP_VERSION = "0.0.0";
const HANDSHAKE_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 15000;
const BUFFER_CAP_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_ENROLL_TTL_MS = 120_000;
// Cap concurrent pending enrollments so an unauthenticated internet client on
// the exposed listener can't allocate unbounded pending entries or spam owner
// devices with enroll-pending broadcasts. Normal onboarding needs only a few.
const MAX_PENDING_ENROLLMENTS = 32;
// Global sliding-window rate limit on the pre-auth enroll lane. Tunneled clients
// all share the relay's source IP, so per-IP throttling can't distinguish them;
// this bounds the connect→request→disconnect flood + owner-prompt fan-out.
const ENROLL_RATE_WINDOW_MS = 10_000;
const ENROLL_RATE_MAX = 12;

/** Hub-minted 6-digit verification code (CSPRNG) — the joiner never chooses it. */
function genEnrollCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Enrollment never grants the privileged "hub" role; fall back to a safe default. */
function clampEnrollRoles(roles: DeviceRole[], fallback: DeviceRole): DeviceRole[] {
  const r = roles.filter((x) => x !== "hub");
  return r.length ? r : [fallback];
}

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
  imessagePresent: boolean;
  imessageAccount?: string;
}

interface PendingEnroll {
  deviceId: string;
  deviceName: string;
  roles: DeviceRole[];
  publicKey: string;
  companions: EnrollCompanion[];
  code: string;
  expiresAt: number;
  requester: WebSocket;
  status: "pending" | "approved";
  timer: ReturnType<typeof setTimeout>;
}

export interface HubListener {
  /** ws:// or wss:// URL this listener is bound to. */
  readonly url: string;
  readonly port: number;
  readonly tls: boolean;
}

export interface HubServer {
  /** First listener's URL (back-compat; equals listeners[0].url). */
  readonly url: string;
  /** Every bound listener, in the order requested. */
  readonly listeners: HubListener[];
  readonly deviceCount: () => number;
  readonly close: () => Promise<void>;
}

/**
 * One listener the hub binds. A hub may run several at once, all sharing the
 * same registry + trust + auth handler: e.g. a plaintext loopback ws:// for the
 * local viewer (no cert) alongside a TLS wss:// exposed over the relay for
 * remote spokes and the PWA. Channel binding is per-connection, so only the TLS
 * listener's sockets bind to the exporter; loopback sockets get cb="".
 */
export interface ListenerSpec {
  host?: string;
  port?: number;
  tls?: { cert: string; key: string };
  /** Git hosting under /git/ (TLS listeners only). */
  gitStore?: GitStore;
  /** Viewer PWA static root, after the git route (TLS listeners only). */
  webRoot?: string;
  /** Desktop auto-update artifacts served under /updates/ (TLS listeners only). */
  updatesRoot?: string;
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
  /** Unlocked vault for machine secret retrieval (plan §9). */
  vault?: Vault;
  /** TLS for the hub endpoint (PEM strings). Terminates in the hub; the relay only sees ciphertext. */
  tls?: { cert: string; key: string };
  /** Hub identity key (mutual auth). When set, the hub proves itself to spokes that send a clientNonce. */
  hubSigner?: Signer;
  /** Git hosting for spokes (plan §13/Phase 7). Served over the same TLS listener under /git/. */
  gitStore?: GitStore;
  /** Viewer PWA build output (plan §5). Served over the same TLS listener, after the git route. */
  webRoot?: string;
  /** Desktop auto-update artifacts (latest.json + signed .app.tar.gz) under /updates/. */
  updatesRoot?: string;
  /**
   * Additional listeners beyond the primary (host/port/tls/gitStore/webRoot).
   * All share this hub's registry, trust store, and auth handler. Used to run a
   * loopback ws:// for the local viewer next to a TLS wss:// over the relay.
   */
  listeners?: ListenerSpec[];
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

export function startHubServer(opts: HubServerOptions): Promise<HubServer> {
  const enrollTtlMs = opts.enrollTtlMs ?? DEFAULT_ENROLL_TTL_MS;
  const trustStore = opts.trustStore;
  if (opts.mode === "trust" && !trustStore) throw new Error("trust mode requires a trust store");

  const registry = new Map<string, Entry>();
  // Owner-set device names in OPEN mode, where there is no trust store to
  // persist them — keeps a rename sticky across re-hellos for this process's
  // lifetime. (Trust mode persists renames in the trust store instead, which
  // registration already prefers over the hello's self-reported name.)
  const openModeNames = new Map<string, string>();
  const pendingEnrollments = new Map<string, PendingEnroll>();
  const enrollWindow: number[] = []; // recent enroll-request timestamps (rate limit)
  const credentialSessions = new Set<WebSocket>();
  const liveness = new WeakMap<WebSocket, boolean>();
  const credentialStore = opts.credentialStore;
  const passkey = opts.passkey;
  let epochCounter = 0;

  // Listeners are created after the connection handler is defined (see the
  // multi-listener build near the end of this function). They all share the
  // registry/trust/auth state closed over here.

  /** TLS-exporter channel binding for this connection, or "" (no TLS / spoke opted out). */
  function channelBinding(request: IncomingMessage, wants: boolean): string {
    if (!wants) return "";
    const sock = request.socket as unknown as { exportKeyingMaterial?: (len: number, label: string) => Buffer };
    try {
      return sock.exportKeyingMaterial ? base64urlEncode(new Uint8Array(sock.exportKeyingMaterial(32, "glass/cb/v1"))) : "";
    } catch {
      return "";
    }
  }

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

  // Live "update available" signal. Read the served manifest's version and push
  // it to each viewer on auth + whenever latest.json changes, so a running spoke
  // learns a new build is out without reconnecting. Advisory only — the install
  // itself stays minisign-gated on the device, so a bogus version at worst
  // triggers a no-op update check. --tls-listen puts updatesRoot on the listener
  // spec, so resolve from either place.
  const updatesDir = opts.updatesRoot ?? opts.listeners?.find((l) => l.updatesRoot !== undefined)?.updatesRoot;
  let latestUpdateVersion: string | undefined;
  let latestUpdateNotes: string | undefined;
  let updatesWatcher: FSWatcher | undefined;
  function readManifest(): { version: string; notes?: string } | undefined {
    if (!updatesDir) return undefined;
    try {
      const m = JSON.parse(readFileSync(join(updatesDir, "latest.json"), "utf8")) as {
        version?: unknown;
        notes?: unknown;
      };
      const v = m.version;
      if (typeof v !== "string" || v.length === 0 || v.length > 64) return undefined;
      // Notes are display-only text; clamp to the protocol bound so an oversized
      // manifest can't make our own push fail schema validation on the far side.
      const notes = typeof m.notes === "string" && m.notes.length > 0 ? m.notes.slice(0, 16384) : undefined;
      return { version: v, ...(notes !== undefined ? { notes } : {}) };
    } catch {
      return undefined;
    }
  }
  function updateAvailableBody(): Body | undefined {
    if (!latestUpdateVersion) return undefined;
    return {
      type: "update.available",
      version: latestUpdateVersion,
      ...(latestUpdateNotes !== undefined ? { notes: latestUpdateNotes } : {}),
    };
  }
  if (updatesDir) {
    const m = readManifest();
    latestUpdateVersion = m?.version;
    latestUpdateNotes = m?.notes;
    try {
      updatesWatcher = watch(updatesDir, (_evt, filename) => {
        if (filename && filename !== "latest.json") return;
        const next = readManifest();
        if (next && next.version !== latestUpdateVersion) {
          latestUpdateVersion = next.version;
          latestUpdateNotes = next.notes;
          const body = updateAvailableBody();
          if (body) broadcastToAuthenticated(() => body);
        }
      });
      updatesWatcher.unref();
    } catch {
      /* fs.watch unsupported here — connect-time push (registerAuthenticated) still works */
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
      imessagePresent: pp.imessagePresent,
      ...(pp.imessageAccount !== undefined ? { imessageAccount: pp.imessageAccount } : {}),
    };
    registry.set(pp.deviceId, { socket, record, epoch });
    reply(
      socket,
      pp.deviceId,
      { type: "hello.ack", protocolVersion: PROTOCOL_VERSION, appVersion: APP_VERSION, compatibility: "ok" },
      pp.helloId,
    );
    broadcastToAuthenticated(() => ({ type: "device.state", device: record }));
    // Tell the freshly-authed device if a newer build is already published, so a
    // spoke that connects after a release still learns to nag (not only on live change).
    const updateBody = updateAvailableBody();
    if (updateBody) reply(socket, pp.deviceId, updateBody);
    return epoch;
  }

  function onConnection(socket: WebSocket, request: IncomingMessage): void {
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
          name: openModeNames.get(hello.deviceId) ?? hello.deviceName, roles: hello.roles, appVersion: hello.appVersion, etchPresent: hello.etch.present,
          imessagePresent: hello.imessage?.present ?? false,
          ...(hello.imessage?.account !== undefined ? { imessageAccount: hello.imessage.account } : {}),
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
        imessagePresent: hello.imessage?.present ?? false,
        ...(hello.imessage?.account !== undefined ? { imessageAccount: hello.imessage.account } : {}),
      };
      state = "await-proof";

      // Mutual auth: if the spoke sent a clientNonce and we hold a hub key, prove
      // our identity, bound to the TLS channel so a MITM relay can't forward it.
      const clientNonce = hello.clientNonce;
      const hubSigner = opts.hubSigner;
      if (clientNonce && hubSigner) {
        const cb = channelBinding(request, hello.channelBinding === true);
        void (async () => {
          const signature = base64urlEncode(await hubSigner.sign(buildHubAuthPayload(hello.deviceId, clientNonce, nonce, cb)));
          reply(socket, hello.deviceId, { type: "hello.challenge", nonce, alg: "ed25519", hub: { key: hubSigner.publicKey, signature } }, env.id);
        })();
      } else {
        reply(socket, hello.deviceId, { type: "hello.challenge", nonce, alg: "ed25519" }, env.id);
      }
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
      // Rate-limit the pre-auth lane (sliding window; all tunneled clients share
      // the relay IP) plus the concurrent-pending cap.
      const now = Date.now();
      while (enrollWindow.length && (enrollWindow[0] ?? 0) < now - ENROLL_RATE_WINDOW_MS) enrollWindow.shift();
      if (enrollWindow.length >= ENROLL_RATE_MAX || pendingEnrollments.size >= MAX_PENDING_ENROLLMENTS) {
        reply(socket, req.deviceId, { type: "error", code: "rate_limited", message: "too many enrollments; try again shortly" }, env.id);
        socket.close(4013, "enroll rate/pending cap");
        return;
      }
      enrollWindow.push(now);
      state = "enroll-locked"; // frame-lock synchronously; no self-approval, no second frame
      // The enroll socket never reaches "registered", so the 5s handshake
      // watchdog would force-close it (and void the pending) long before an
      // approver can act. Cancel it; the enrollment TTL now bounds this socket.
      clearTimeout(handshakeTimer);
      const companionsIn = req.companions ?? []; // already capped by the schema (.max)
      const clientNonce = req.clientNonce;
      void (async () => {
        if (!(await isValidPublicKey(req.publicKey))) {
          socket.close(4008, "invalid public key");
          return;
        }
        // Roles are clamped to strip the privileged "hub" role (the escalation),
        // so a joiner can never self-grant hub. Companions must be distinct valid
        // keys, not the hub or the requester itself.
        const reqRoles = clampEnrollRoles(req.roles, "viewer");
        const companions: EnrollCompanion[] = [];
        for (const c of companionsIn) {
          if (c.deviceId === HUB || c.deviceId === req.deviceId || !(await isValidPublicKey(c.publicKey))) {
            socket.close(4008, "invalid companion");
            return;
          }
          companions.push({ deviceId: c.deviceId, publicKey: c.publicKey, roles: clampEnrollRoles(c.roles, "agent") });
        }
        for (const [rid, pe] of pendingEnrollments) {
          if (pe.deviceId === req.deviceId) {
            clearTimeout(pe.timer);
            pendingEnrollments.delete(rid);
            // Close the superseded socket too. With the handshake watchdog cleared
            // and pre-auth sockets absent from the liveness ping, nothing else
            // would ever reap it — leaving a leaked fd per dedup (DoS).
            if (pe.requester !== socket) pe.requester.close(4001, "enrollment superseded");
          }
        }
        const requestId = randomUUID();
        const expiresAt = Date.now() + enrollTtlMs;
        const code = genEnrollCode(); // HUB mints it — never the joiner
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
          deviceId: req.deviceId, deviceName: req.deviceName, roles: reqRoles, publicKey: req.publicKey,
          companions, code, expiresAt, requester: socket, status: "pending", timer,
        });
        // To the JOINER only: the code (shown on its screen) + the hub's identity
        // proof so it can verify it's talking to the pinned hub on this lane too.
        let hubProof: { key: string; signature: string } | undefined;
        if (opts.hubSigner && clientNonce) {
          const sig = base64urlEncode(await opts.hubSigner.sign(buildHubAuthPayload(req.deviceId, clientNonce, "enroll", "")));
          hubProof = { key: opts.hubSigner.publicKey, signature: sig };
        }
        reply(socket, req.deviceId, { type: "device.enroll.pending", requestId, deviceName: req.deviceName, expiresAt, verificationCode: code, ...(hubProof ? { hubProof } : {}) }, env.id);
        // To APPROVERS: WHAT will be trusted (roles + companion keys) but NEVER
        // the code — a human must read it off the joining device and type it, so a
        // compromised device that gets the broadcast still cannot self-approve.
        broadcastEnrollPending({ type: "device.enroll.pending", requestId, deviceName: req.deviceName, expiresAt, roles: reqRoles, companions });
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
  }

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
      case "device.rename": {
        // Any trusted device may name any fleet device (same authority model as
        // enrollment approval — every trusted device is the owner's).
        const name = env.body.name.trim();
        if (!name) {
          reply(socket, deviceId, { type: "error", code: "invalid_name", message: "device name must not be blank" }, env.id);
          break;
        }
        const entry = registry.get(env.body.deviceId);
        if (!entry) {
          reply(socket, deviceId, { type: "error", code: "device_unknown", message: `no device registered as ${env.body.deviceId}` }, env.id);
          break;
        }
        const trusted = trustStore?.get(env.body.deviceId);
        if (trusted) trustStore!.add(env.body.deviceId, { ...trusted, name });
        else openModeNames.set(env.body.deviceId, name);
        entry.record.name = name;
        reply(socket, deviceId, { type: "device.renamed", device: entry.record }, env.id);
        broadcastToAuthenticated(() => ({ type: "device.state", device: entry.record }));
        break;
      }
      case "session.created":
      case "session.exited":
      case "session.renamed":
        // An agent announced a change to its session set (a new shell opened,
        // one exited, or one was renamed). Fan it out to every connected device
        // so all viewers keep a live, fleet-wide session list — not just the
        // viewer that made the change. The record carries deviceId, so viewers
        // know which agent it belongs to.
        broadcastToAuthenticated(() => env.body);
        break;
      case "vault.get": {
        if (!opts.vault) {
          reply(socket, deviceId, { type: "error", code: "internal", message: "vault not enabled" }, env.id);
          break;
        }
        const result = opts.vault.getForDevice(deviceId, env.body.name);
        if (result.ok) reply(socket, deviceId, { type: "vault.secret", name: env.body.name, value: result.value.toString("utf8") }, env.id);
        else reply(socket, deviceId, { type: "error", code: result.code, message: `vault: ${result.code}` }, env.id);
        break;
      }
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
      // Trust the companions under the same approval (e.g. the joining Mac's
      // shell agent alongside its viewer). Name them distinctly so they show up
      // separately in device.list and can be revoked independently.
      for (const c of pe.companions) {
        if (!trustStore!.has(c.deviceId)) {
          trustStore!.add(c.deviceId, {
            publicKey: c.publicKey, name: `${pe.deviceName} · agent`, roles: c.roles, enrolledAt: Date.now(), approvedBy: approverId,
          });
        }
      }
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

  // Build every listener from the primary opts plus any extras, all wired to the
  // same onConnection handler (shared registry/trust/auth). Route order on a TLS
  // listener's plain-HTTP requests: git (/git/ auth+ACL), then static PWA, then 404.
  const primarySpec: ListenerSpec = {
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
    ...(opts.gitStore !== undefined ? { gitStore: opts.gitStore } : {}),
    ...(opts.webRoot !== undefined ? { webRoot: opts.webRoot } : {}),
    ...(opts.updatesRoot !== undefined ? { updatesRoot: opts.updatesRoot } : {}),
  };
  const specs: ListenerSpec[] = [primarySpec, ...(opts.listeners ?? [])];

  interface Built {
    wss: WebSocketServer;
    httpsServer: HttpsServer | undefined;
    host: string;
    declaredPort: number | undefined;
    tls: boolean;
  }
  const built: Built[] = specs.map((spec) => {
    const lhost = spec.host ?? "127.0.0.1";
    let httpsServer: HttpsServer | undefined;
    const w = spec.tls
      ? new WebSocketServer({ server: (httpsServer = createHttpsServer({ cert: spec.tls.cert, key: spec.tls.key })), maxPayload: MAX_PAYLOAD_BYTES })
      : new WebSocketServer({ host: lhost, port: spec.port ?? 0, maxPayload: MAX_PAYLOAD_BYTES });
    if (httpsServer) {
      // Bound the HTTP request phase (slow-header/slow-body slowloris) and total
      // connections. These apply to the request phase only — an upgraded WS relay
      // socket is unaffected — and artifact flood/slow-read is capped separately in
      // the /updates/ handler, so a file-serving abuse can't starve the relay.
      httpsServer.maxConnections = 1024;
      httpsServer.headersTimeout = 15_000;
      httpsServer.requestTimeout = 30_000;
    }
    if (httpsServer && (spec.gitStore || spec.webRoot || spec.updatesRoot)) {
      const gitHandler = spec.gitStore ? createGitHttpHandler(spec.gitStore) : null;
      const updatesHandler = spec.updatesRoot ? createUpdatesHandler(spec.updatesRoot) : null;
      const staticHandler = spec.webRoot ? createStaticHandler(spec.webRoot) : null;
      httpsServer.on("request", (req, res) => {
        if (gitHandler && gitHandler(req, res)) return;
        if (updatesHandler && updatesHandler(req, res)) return;
        if (staticHandler && staticHandler(req, res)) return;
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      });
    }
    w.on("connection", onConnection);
    if (httpsServer) httpsServer.listen(spec.port ?? 0, lhost);
    return { wss: w, httpsServer, host: lhost, declaredPort: spec.port, tls: !!spec.tls };
  });

  return new Promise<HubServer>((resolve, reject) => {
    const listeners: HubListener[] = new Array(built.length);
    let remaining = built.length;
    let settled = false;
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      // Best-effort teardown of anything that did bind before the failure — mirror
      // close() so a startup failure doesn't leave the ping timer or fs.watch handle.
      clearInterval(pingTimer);
      updatesWatcher?.close();
      for (const b of built) {
        try { b.wss.close(); b.httpsServer?.close(); } catch { /* ignore */ }
      }
      reject(e);
    };
    built.forEach((b, i) => {
      const target = b.httpsServer ?? b.wss;
      target.once("error", fail);
      target.once("listening", () => {
        const addr = (b.httpsServer ?? b.wss).address();
        const port = typeof addr === "object" && addr !== null ? addr.port : (b.declaredPort ?? 0);
        listeners[i] = { url: `${b.tls ? "wss" : "ws"}://${b.host}:${port}`, port, tls: b.tls };
        if (--remaining !== 0 || settled) return;
        settled = true;
        resolve({
          url: listeners[0]!.url,
          listeners,
          deviceCount: () => registry.size,
          close: () =>
            new Promise<void>((res) => {
              clearInterval(pingTimer);
              updatesWatcher?.close();
              for (const entry of registry.values()) entry.socket?.close();
              let closing = built.length;
              const done = (): void => {
                if (--closing === 0) res();
              };
              for (const b2 of built) {
                b2.wss.close(() => (b2.httpsServer ? b2.httpsServer.close(() => done()) : done()));
              }
            }),
        });
      });
    });
  });
}
