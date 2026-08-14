/**
 * Agent hub-mode: bridge the Hub (upstream, WebSocket) to sessiond (downstream,
 * Unix socket), for Phase 1 milestone 2.
 *
 * The agent is the sole address-translation boundary. It keeps TWO soft tables:
 *
 *   pending:  forwarded-request id -> viewer address   (correlates replies)
 *   attached: sessionId -> Set<viewer address>         (fans out output/exit)
 *
 * Both are reconstructible by a viewer re-sending create/attach, so the worker
 * stays disposable: nothing here is the only copy of anything. Toward sessiond
 * the agent always uses from=<its own deviceId>, so sessiond's per-connection
 * `conn.peer` never flaps and sessiond needs zero changes. Output is fanned out
 * strictly by the attachment table — sessiond's `to` is ignored.
 *
 * Only sessiond may originate session.exited. When the hub link drops the agent
 * reconnects and re-hellos; the viewer, told by the hub's device.state, re-sends
 * session.attach and sessiond replays the scrollback that accumulated meanwhile.
 */
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  FrameReader,
  encodeFrame,
  makeEnvelope,
  parseEnvelope,
  buildHandshakePayload,
  base64urlEncode,
  randomNonce,
  verifyHubAuth,
  DeviceId,
  SessionId,
  HUB,
  PROTOCOL_VERSION,
  type Body,
  type Envelope,
  type DeviceRole,
  type Signer,
} from "@glass/protocol";
import { ProxyExit, ProxyForwarder } from "./proxy/index.js";

const APP_VERSION = "0.0.0";
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

export interface HubLinkOptions {
  readonly sessiondPath: string;
  readonly hubUrl: string;
  readonly deviceId: string;
  readonly deviceName: string;
  /** Etch presence, reported in the device record (detected, never managed). */
  readonly etch?: { present: boolean; version?: string };
  /** Signs the hub's auth challenge. Omit only when the hub runs in --open mode. */
  readonly signer?: Signer;
  /** Pinned hub public key (mutual auth) — the hub must prove this identity, or we refuse. */
  readonly hubKey?: string;
  /** Accept a self-signed hub cert (dev/test only; identity still rests on hubKey). */
  readonly insecureTls?: boolean;
  readonly onRegistered?: () => void;
  readonly onSessiondClosed?: () => void;
}

export interface RunningHubLink {
  readonly close: () => Promise<void>;
  /** Park the hub link (blue on standby during a blue/green swap). */
  readonly standby: () => void;
  /** Un-park and reconnect (rollback if the green worker failed). */
  readonly resume: () => void;
}

async function connectSessiond(path: string, attempts = 30, delayMs = 100): Promise<net.Socket> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(path);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`could not connect to sessiond at ${path}`);
}

export async function startHubLink(opts: HubLinkOptions): Promise<RunningHubLink> {
  const self = opts.deviceId;

  // --- downstream: sessiond (connect FIRST, so a fast re-attach never lands on
  //     an agent whose sessiond link isn't up yet) ---
  const sd = await connectSessiond(opts.sessiondPath);
  const sdReader = new FrameReader();
  const sdDecoder = new StringDecoder("utf8");

  // --- translation tables (soft state) ---
  const pending = new Map<string, string>(); // request id -> viewer address
  const attached = new Map<string, Set<string>>(); // sessionId -> viewers

  // --- browser proxy (plan §7) ---
  // Exits are per REQUESTING peer, so replies are bound to the device that
  // opened the channel and one peer's frames can never touch another's
  // channels. Forwarders are per EXIT device (reused across clicks); their
  // SOCKS listeners bind loopback only. All of it is soft state in the worker:
  // a blue/green swap drops live proxied connections (unlike sessions) — the
  // browser just reconnects through a fresh forwarder.
  const exits = new Map<string, ProxyExit>(); // requesting peer -> exit
  const forwarders = new Map<string, { fwd: ProxyForwarder; port: Promise<number> }>(); // exit device -> forwarder

  function exitFor(peer: string): ProxyExit {
    let e = exits.get(peer);
    if (!e) {
      e = new ProxyExit((msg) => toHub(peer, msg), {
        // Egress audit trail: every destination dialled on this device's behalf.
        onOpen: (host, port) => console.error(`agent: proxy egress for ${peer} -> ${host}:${port}`),
      });
      exits.set(peer, e);
    }
    return e;
  }

  function forwarderFor(exitDeviceId: string): { fwd: ProxyForwarder; port: Promise<number> } {
    let f = forwarders.get(exitDeviceId);
    if (!f) {
      const fwd = new ProxyForwarder((msg) => toHub(exitDeviceId, msg));
      f = { fwd, port: fwd.listen() };
      forwarders.set(exitDeviceId, f);
    }
    return f;
  }

  function closeProxyPeer(deviceId: string): void {
    const ex = exits.get(deviceId);
    if (ex) {
      exits.delete(deviceId);
      ex.closeAll();
    }
    const f = forwarders.get(deviceId);
    if (f) {
      forwarders.delete(deviceId);
      f.fwd.close();
    }
  }

  let hub: WebSocket | null = null;
  let closed = false;
  let parked = false;
  let reconnectDelay = RECONNECT_MIN_MS;

  function toSessiond(id: string, body: Body): void {
    const env = makeEnvelope({ id, ts: Date.now(), from: self, to: "sessiond", body });
    sd.write(encodeFrame(env));
  }
  function toHub(to: string, body: Body, replyTo?: string): void {
    if (!hub || hub.readyState !== WebSocket.OPEN) return;
    const env = makeEnvelope(
      replyTo === undefined
        ? { id: randomUUID(), ts: Date.now(), from: self, to, body }
        : { id: randomUUID(), ts: Date.now(), from: self, to, body, replyTo },
    );
    hub.send(JSON.stringify(env));
  }
  function addAttach(sessionId: string, viewer: string): void {
    let set = attached.get(sessionId);
    if (!set) {
      set = new Set();
      attached.set(sessionId, set);
    }
    set.add(viewer);
  }

  // sessiond -> agent -> hub
  sd.on("data", (buf: Buffer) => {
    for (const res of sdReader.push(sdDecoder.write(buf))) {
      if (res.ok) fromSessiond(res.envelope);
    }
  });
  sd.on("close", () => {
    if (!closed && opts.onSessiondClosed) opts.onSessiondClosed();
  });

  function fromSessiond(env: Envelope): void {
    const body = env.body;
    switch (body.type) {
      case "session.created":
      case "session.attached": {
        const viewer = env.replyTo ? pending.get(env.replyTo) : undefined;
        if (env.replyTo) pending.delete(env.replyTo);
        if (viewer) {
          addAttach(body.session.id, viewer);
          toHub(viewer, body, env.replyTo);
        }
        // A newly created session is announced to the hub for fleet-wide fan-out
        // so every viewer's list updates live. (attach is a private subscription
        // to an existing session, so it is NOT announced.)
        if (body.type === "session.created") toHub(HUB, body);
        break;
      }
      case "session.listed":
      case "error": {
        const viewer = env.replyTo ? pending.get(env.replyTo) : undefined;
        if (env.replyTo) pending.delete(env.replyTo);
        if (viewer) toHub(viewer, body, env.replyTo);
        break;
      }
      case "session.output": {
        const set = attached.get(body.sessionId);
        if (set) for (const viewer of set) toHub(viewer, body);
        break;
      }
      case "session.exited": {
        const set = attached.get(body.sessionId);
        if (set) {
          for (const viewer of set) toHub(viewer, body);
          attached.delete(body.sessionId);
        }
        // Announce fleet-wide so non-attached viewers drop it from their lists too.
        toHub(HUB, body);
        break;
      }
      default:
        break;
    }
  }

  // hub -> agent -> sessiond
  function fromHub(env: Envelope): void {
    const viewer = env.from;
    const body = env.body;
    switch (body.type) {
      case "session.create": {
        pending.set(env.id, viewer);
        // Normalize the record's owning device to us; the viewer's body.deviceId
        // is advisory and must not let a record claim it lives elsewhere.
        toSessiond(env.id, { ...body, deviceId: DeviceId.parse(self) });
        break;
      }
      case "session.attach": {
        pending.set(env.id, viewer);
        addAttach(body.sessionId, viewer);
        toSessiond(env.id, body);
        break;
      }
      case "session.list": {
        pending.set(env.id, viewer);
        toSessiond(env.id, body);
        break;
      }
      case "session.detach": {
        const set = attached.get(body.sessionId);
        if (set) {
          set.delete(viewer);
          if (set.size === 0) {
            attached.delete(body.sessionId);
            toSessiond(env.id, body); // last viewer left — release the sessiond sub
          }
        }
        break;
      }
      case "session.input":
      case "session.resize":
      case "session.close":
        toSessiond(env.id, body);
        break;
      case "proxy.forward.open": {
        // Viewer asks US (its local agent) to run a SOCKS forwarder that
        // egresses through body.exitDeviceId. Idempotent: same exit -> same
        // listener; the reply carries the loopback port to point a browser at.
        const f = forwarderFor(body.exitDeviceId);
        void f.port.then((port) => toHub(viewer, { type: "proxy.forward.opened", exitDeviceId: body.exitDeviceId, port }, env.id));
        break;
      }
      case "proxy.forward.close": {
        // Close ONLY the forwarder aimed at this exit — not any exit channels
        // where that same device is the requesting peer (it may be browsing
        // through us at the same time).
        const f = forwarders.get(body.exitDeviceId);
        if (f) {
          forwarders.delete(body.exitDeviceId);
          f.fwd.close();
        }
        break;
      }
      case "proxy.open":
        // A peer wants to egress through THIS device.
        exitFor(viewer).handle(body);
        break;
      case "proxy.opened":
        // Only an exit device answers opens; dispatch to the forwarder aimed at it.
        forwarders.get(viewer)?.fwd.handle(body);
        break;
      case "proxy.data":
      case "proxy.close":
        // Direction is ambiguous (exit channel this peer opened, or forwarder
        // channel egressing through it). Channel ids are UUIDs and both halves
        // ignore ids they don't own, so deliver to both of this peer's halves.
        exits.get(viewer)?.handle(body);
        forwarders.get(viewer)?.fwd.handle(body);
        break;
      case "device.state": {
        // A viewer went away: prune it so we don't fan out to a dead address,
        // and drop any proxy state bound to it (its exit channels, or the
        // forwarder whose egress device just vanished).
        if (body.device.state !== "connected") {
          pruneViewer(body.device.id);
          closeProxyPeer(body.device.id);
        }
        break;
      }
      default:
        break;
    }
  }

  function pruneViewer(viewer: string): void {
    for (const [sessionId, set] of attached) {
      if (set.delete(viewer) && set.size === 0) {
        attached.delete(sessionId);
        toSessiond(randomUUID(), { type: "session.detach", sessionId: SessionId.parse(sessionId) });
      }
    }
  }

  // --- upstream: hub, with reconnect + re-hello ---
  function connectHub(): void {
    if (closed) return;
    const ws = opts.insecureTls ? new WebSocket(opts.hubUrl, { rejectUnauthorized: false }) : new WebSocket(opts.hubUrl);
    hub = ws;

    const reader = new FrameReader();
    let handshakeDone = false;
    const clientNonce = randomNonce(); // for mutual auth (hub proves itself over this)

    const sendProof = (nonce: string): void => {
      const signer = opts.signer;
      if (!signer) {
        console.error("agent: hub requires device-key auth but no signer was provided (--key)");
        ws.close();
        return;
      }
      void (async () => {
        const signature = base64urlEncode(await signer.sign(buildHandshakePayload(self, nonce)));
        ws.send(JSON.stringify(makeEnvelope({ id: randomUUID(), ts: Date.now(), from: self, to: HUB, body: { type: "hello.proof", deviceId: DeviceId.parse(self), signature } })));
      })();
    };

    ws.on("open", () => {
      const helloBody: Body = {
        type: "hello",
        deviceId: DeviceId.parse(self),
        deviceName: opts.deviceName,
        roles: ["agent"] as DeviceRole[],
        protocolVersion: PROTOCOL_VERSION,
        appVersion: APP_VERSION,
        etch: opts.etch ?? { present: false },
        ...(opts.hubKey ? { clientNonce, channelBinding: true } : {}),
      };
      ws.send(JSON.stringify(makeEnvelope({ id: randomUUID(), ts: Date.now(), from: self, to: HUB, body: helloBody })));
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      // WS is message-framed, but reuse parseEnvelope for validation.
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
      const res = parseEnvelope(safeJson(text));
      if (!res.ok) return;
      const env = res.envelope;
      if (!handshakeDone) {
        if (env.body.type === "hello.challenge") {
          const challenge = env.body;
          if (opts.hubKey) {
            // Mutual auth: the hub must prove its pinned identity, bound to this TLS channel.
            const pinned = opts.hubKey;
            const cb = spokeChannelBinding(ws);
            void (async () => {
              const hub = challenge.hub;
              const ok = !!hub && hub.key === pinned && (await verifyHubAuth(pinned, self, clientNonce, challenge.nonce, cb, hub.signature));
              if (!ok) {
                console.error("agent: HUB IDENTITY VERIFICATION FAILED — refusing to connect");
                ws.close(4010, "hub identity not verified");
                return;
              }
              sendProof(challenge.nonce);
            })();
            return;
          }
          sendProof(challenge.nonce);
          return;
        }
        if (env.body.type === "hello.ack") {
          handshakeDone = true;
          reconnectDelay = RECONNECT_MIN_MS;
          if (env.body.compatibility === "ok") {
            console.error(`agent: registered with hub as ${self}`);
            if (opts.onRegistered) opts.onRegistered();
          }
        }
        return;
      }
      fromHub(env);
    });

    const scheduleReconnect = (): void => {
      hub = null;
      // Parked (blue on standby during a blue/green swap): stay disconnected so
      // we don't fight the green worker's registration at the hub.
      if (closed || parked) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      setTimeout(connectHub, delay);
    };
    ws.on("close", scheduleReconnect);
    ws.on("error", () => {
      /* 'close' follows */
    });
  }

  connectHub();

  return {
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        for (const e of exits.values()) e.closeAll();
        exits.clear();
        for (const f of forwarders.values()) f.fwd.close();
        forwarders.clear();
        hub?.close();
        sd.destroy();
        resolve();
      }),
    standby: () => {
      parked = true;
      hub?.close(); // drop the hub link but keep sessiond; green will take over routing
    },
    resume: () => {
      parked = false;
      if (!hub || hub.readyState !== WebSocket.OPEN) connectHub();
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** TLS-exporter channel binding for a ws client's underlying socket, or "" (no TLS). */
function spokeChannelBinding(ws: WebSocket): string {
  const sock = (ws as unknown as { _socket?: { exportKeyingMaterial?: (len: number, label: string) => Buffer } })._socket;
  try {
    return sock?.exportKeyingMaterial ? base64urlEncode(new Uint8Array(sock.exportKeyingMaterial(32, "glass/cb/v1"))) : "";
  } catch {
    return "";
  }
}
