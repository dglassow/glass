/**
 * Hub — registry + relay (plan §2). A pure WebSocket router.
 *
 * Every peer (agent or viewer) opens a WS and its FIRST frame must be a `hello`
 * envelope addressed to "hub". The hub validates identity, registers
 * deviceId -> socket, and thereafter forwards envelopes VERBATIM to the socket
 * named by envelope.to. It never rewrites from/to/id/replyTo and never invents
 * session messages — session death is sessiond's fact alone.
 *
 * Auth is stubbed for Phase 1: `authorize()` accepts everyone. But routing is
 * NOT loose — the hub binds envelope.from to the handshaked identity, refuses
 * the reserved id "hub", and answers unroutable envelopes with explicit errors
 * (never a silent drop). That way Phase 2 enrollment slots into `authorize()`
 * without the addressing model resting on a forgeable field.
 */
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import {
  parseEnvelope,
  makeEnvelope,
  checkCompatibility,
  HUB,
  PROTOCOL_VERSION,
  type Envelope,
  type Body,
  type DeviceRecord,
} from "@glass/protocol";

const APP_VERSION = "0.0.0";
const HANDSHAKE_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 15000;
const BUFFER_CAP_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

interface Entry {
  socket: WebSocket | null;
  record: DeviceRecord;
  /** Monotonic per-registration id; guards the close handler against races. */
  epoch: number;
}

export interface HubServer {
  readonly url: string;
  readonly deviceCount: () => number;
  readonly close: () => Promise<void>;
}

/** Phase 2 enrollment seam. For now every device is trusted. */
function authorize(_deviceId: string): boolean {
  return true;
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

export function startHubServer(opts: { host?: string; port?: number }): Promise<HubServer> {
  const host = opts.host ?? "127.0.0.1";
  const registry = new Map<string, Entry>();
  const liveness = new WeakMap<WebSocket, boolean>();
  let epochCounter = 0;

  const wss = new WebSocketServer({ host, port: opts.port ?? 0, maxPayload: MAX_PAYLOAD_BYTES });

  function rawSend(socket: WebSocket, env: Envelope): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > BUFFER_CAP_BYTES) {
      // Flow control by disconnection: safe because sessiond holds the scrollback
      // and seq, so a kicked peer reattaches and replays.
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(env));
  }

  function replyTo(socket: WebSocket, to: string, body: Body, inReplyTo?: string): void {
    rawSend(
      socket,
      makeEnvelope(
        inReplyTo === undefined
          ? { id: randomUUID(), ts: Date.now(), from: HUB, to, body }
          : { id: randomUUID(), ts: Date.now(), from: HUB, to, body, replyTo: inReplyTo },
      ),
    );
  }

  function broadcastDeviceState(record: DeviceRecord): void {
    for (const entry of registry.values()) {
      if (entry.socket && entry.socket.readyState === WebSocket.OPEN && entry.record.state === "connected") {
        replyTo(entry.socket, entry.record.id, { type: "device.state", device: record });
      }
    }
  }

  wss.on("connection", (socket) => {
    let deviceId: string | null = null;
    let epoch = -1;
    liveness.set(socket, true);
    socket.on("pong", () => liveness.set(socket, true));

    const handshakeTimer = setTimeout(() => {
      if (deviceId === null) socket.close(4001, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(4002, "binary frames are not part of the protocol");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawToString(raw));
      } catch {
        return; // ignore garbage; a real hub could close, but be lenient in M2
      }
      const res = parseEnvelope(parsed);
      if (!res.ok) return;
      const env = res.envelope;

      if (deviceId === null) {
        handleHandshake(socket, env, (id, ep) => {
          deviceId = id;
          epoch = ep;
          clearTimeout(handshakeTimer);
        });
        return;
      }

      // Bind from to the handshaked identity — routing hygiene, not crypto.
      if (env.from !== deviceId) {
        replyTo(socket, deviceId, { type: "error", code: "unauthorized", message: "from does not match handshake identity" }, env.id);
        return;
      }
      // Version rides every envelope (plan §4), not just the handshake.
      if (checkCompatibility(env.v).status !== "ok") {
        replyTo(socket, deviceId, { type: "error", code: "version_incompatible", message: `envelope v=${env.v} is not supported` }, env.id);
        return;
      }
      const self = registry.get(deviceId);
      if (self) self.record.lastSeen = Date.now();

      if (env.to === HUB) {
        handleHubMessage(socket, deviceId, env);
        return;
      }
      route(socket, deviceId, env);
    });

    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      if (deviceId === null) return;
      const entry = registry.get(deviceId);
      if (entry && entry.epoch === epoch) {
        // Keep the record (state=waiting) so routes get device_unreachable, not
        // device_unknown, and viewers learn the device bounced.
        entry.socket = null;
        entry.record.state = "waiting";
        entry.record.lastSeen = Date.now();
        broadcastDeviceState(entry.record);
      }
    });

    socket.on("error", () => {
      /* 'close' follows and does the cleanup */
    });
  });

  function handleHandshake(socket: WebSocket, env: Envelope, onRegistered: (id: string, epoch: number) => void): void {
    if (env.body.type !== "hello") {
      socket.close(4003, "expected hello as the first frame");
      return;
    }
    const hello = env.body;
    if (env.from !== hello.deviceId) {
      socket.close(4004, "envelope.from must equal hello.deviceId");
      return;
    }
    if (hello.deviceId === HUB) {
      socket.close(4005, 'the device id "hub" is reserved');
      return;
    }
    if (!authorize(hello.deviceId)) {
      socket.close(4007, "not authorized");
      return;
    }

    const verdict = checkCompatibility(hello.protocolVersion);
    const epoch = ++epochCounter;

    // Evict a stale registration for this id (a SIGKILLed agent's half-open
    // socket, or a genuine duplicate). Last writer wins so restart recovery works.
    const prev = registry.get(hello.deviceId);
    if (prev && prev.socket && prev.socket !== socket) prev.socket.terminate();

    const record: DeviceRecord = {
      id: hello.deviceId,
      name: hello.deviceName,
      roles: hello.roles,
      state: "connected",
      lastSeen: Date.now(),
      appVersion: hello.appVersion,
      etchPresent: hello.etch.present,
    };
    registry.set(hello.deviceId, { socket, record, epoch });
    onRegistered(hello.deviceId, epoch);

    replyTo(
      socket,
      hello.deviceId,
      { type: "hello.ack", protocolVersion: PROTOCOL_VERSION, appVersion: APP_VERSION, compatibility: verdict.status },
      env.id,
    );

    if (verdict.status !== "ok") {
      // Peer is too old (or ahead of the hub mid-rollout): it saw the verdict, now refuse it.
      socket.close(4006, `incompatible protocol version: ${verdict.status}`);
      return;
    }
    broadcastDeviceState(record);
  }

  function handleHubMessage(socket: WebSocket, deviceId: string, env: Envelope): void {
    switch (env.body.type) {
      case "device.list":
        replyTo(socket, deviceId, { type: "device.listed", devices: [...registry.values()].map((e) => e.record) }, env.id);
        break;
      case "heartbeat":
        replyTo(socket, deviceId, { type: "heartbeat.ack", sentAt: env.body.sentAt, receivedAt: Date.now() }, env.id);
        break;
      default:
        break;
    }
  }

  function route(socket: WebSocket, deviceId: string, env: Envelope): void {
    const target = registry.get(env.to);
    if (!target) {
      replyTo(socket, deviceId, { type: "error", code: "device_unknown", message: `no device registered as ${env.to}` }, env.id);
      return;
    }
    if (!target.socket || target.socket.readyState !== WebSocket.OPEN || target.record.state !== "connected") {
      replyTo(socket, deviceId, { type: "error", code: "device_unreachable", message: `device ${env.to} is not connected` }, env.id);
      return;
    }
    rawSend(target.socket, env); // verbatim
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
