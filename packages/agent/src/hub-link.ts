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
  DeviceId,
  SessionId,
  HUB,
  PROTOCOL_VERSION,
  type Body,
  type Envelope,
  type DeviceRole,
  type Signer,
} from "@glass/protocol";

const APP_VERSION = "0.0.0";
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

export interface HubLinkOptions {
  readonly sessiondPath: string;
  readonly hubUrl: string;
  readonly deviceId: string;
  readonly deviceName: string;
  /** Signs the hub's auth challenge. Omit only when the hub runs in --open mode. */
  readonly signer?: Signer;
  readonly onRegistered?: () => void;
  readonly onSessiondClosed?: () => void;
}

export interface RunningHubLink {
  readonly close: () => Promise<void>;
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

  let hub: WebSocket | null = null;
  let closed = false;
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
      case "device.state": {
        // A viewer went away: prune it so we don't fan out to a dead address.
        if (body.device.state !== "connected") pruneViewer(body.device.id);
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
    const ws = new WebSocket(opts.hubUrl);
    hub = ws;

    const reader = new FrameReader();
    let handshakeDone = false;

    ws.on("open", () => {
      const helloBody: Body = {
        type: "hello",
        deviceId: DeviceId.parse(self),
        deviceName: opts.deviceName,
        roles: ["agent"] as DeviceRole[],
        protocolVersion: PROTOCOL_VERSION,
        appVersion: APP_VERSION,
        etch: { present: false },
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
          const { nonce } = env.body;
          const signer = opts.signer;
          if (!signer) {
            console.error("agent: hub requires device-key auth but no signer was provided (--key)");
            ws.close();
            return;
          }
          void (async () => {
            const signature = base64urlEncode(await signer.sign(buildHandshakePayload(self, nonce)));
            ws.send(
              JSON.stringify(
                makeEnvelope({
                  id: randomUUID(),
                  ts: Date.now(),
                  from: self,
                  to: HUB,
                  body: { type: "hello.proof", deviceId: DeviceId.parse(self), signature },
                }),
              ),
            );
          })();
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
      if (closed) return;
      hub = null;
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
        hub?.close();
        sd.destroy();
        resolve();
      }),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
