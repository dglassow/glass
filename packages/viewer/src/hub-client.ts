/**
 * Viewer hub client — the browser (and PWA) end of the protocol.
 *
 * Deliberately DOM-free: it uses only the standard `WebSocket` global (present
 * in browsers and in Node ≥22), so the exact same module runs in the desktop
 * webview, the mobile PWA, and the headless acceptance test. The terminal UI
 * (xterm.js) is a thin layer on top of this; nothing here touches the DOM.
 *
 * It owns the connection lifecycle and the request/reply correlation, and it
 * implements the viewer-driven recovery the design depends on: when an agent
 * drops and later re-registers (a `device.state` transition), the viewer
 * re-sends `session.attach` for every session it holds on that agent, and
 * sessiond replays the scrollback that accumulated while the worker was gone.
 */
import {
  makeEnvelope,
  parseEnvelope,
  buildHandshakePayload,
  base64urlEncode,
  randomNonce,
  verifyHubAuth,
  PROTOCOL_VERSION,
  HUB,
  DeviceId,
  SessionId,
  type Body,
  type Envelope,
  type DeviceRecord,
  type SessionRecord,
  type SessionKind,
  type Signer,
} from "@glass/protocol";

const APP_VERSION = "0.0.0";

export interface HubClientEvents {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onDevices?: (devices: DeviceRecord[]) => void;
  onDeviceState?: (device: DeviceRecord) => void;
  /** Full buffer replayed on (re)attach — the UI should reset the pane first. */
  onScrollback?: (sessionId: string, scrollback: string) => void;
  onOutput?: (sessionId: string, data: string, seq: number) => void;
  onExited?: (sessionId: string, exitCode: number | null, signal: string | null) => void;
  onError?: (code: string, message: string) => void;
}

interface Pending {
  resolve: (env: Envelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HubClient {
  private ws: WebSocket | null = null;
  private acked = false;
  private pending = new Map<string, Pending>();
  /** Sessions this viewer holds, sessionId -> agentId, for auto re-attach. */
  private readonly active = new Map<string, string>();
  private reconnectDelay = 250;
  private closed = false;
  /** Fresh per-connection nonce the hub must sign when a pin is set (mutual auth). */
  private clientNonce = "";

  constructor(
    private readonly url: string,
    private readonly deviceId: string,
    private readonly deviceName: string,
    private readonly events: HubClientEvents = {},
    /** Signs the hub's auth challenge. Injected by the container; omit for an --open hub. */
    private readonly signer?: Signer,
    /**
     * Pinned hub public key (mutual auth) — the hub must prove this identity or
     * we refuse to connect. Browsers cannot export TLS keying material, so the
     * viewer does NOT do channel binding: the hub signs its proof with cb=""
     * and we verify with cb="". Transport confidentiality comes from wss://.
     */
    private readonly hubKeyPin?: string,
  ) {}

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.acked = false;
    this.clientNonce = randomNonce();

    ws.addEventListener("open", () => {
      this.rawSend(
        this.deviceId,
        HUB,
        {
          type: "hello",
          deviceId: DeviceId.parse(this.deviceId),
          deviceName: this.deviceName,
          roles: ["viewer"],
          protocolVersion: PROTOCOL_VERSION,
          appVersion: APP_VERSION,
          etch: { present: false },
          // Ask the hub to prove its pinned identity. channelBinding stays
          // false/omitted: no TLS exporter in browsers (see hubKeyPin above).
          ...(this.hubKeyPin ? { clientNonce: this.clientNonce } : {}),
        },
      );
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      const res = parseEnvelope(safeJson(ev.data));
      if (res.ok) this.dispatch(res.envelope);
    });

    ws.addEventListener("close", () => {
      this.acked = false;
      this.events.onDisconnected?.();
      if (this.closed) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
      setTimeout(() => this.connect(), delay);
    });

    ws.addEventListener("error", () => {
      /* 'close' follows and drives the reconnect */
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  /** List all devices the hub knows about. */
  listDevices(): Promise<DeviceRecord[]> {
    return this.request(HUB, { type: "device.list" }).then((env) =>
      env.body.type === "device.listed" ? env.body.devices : [],
    );
  }

  /** Create a pty/chat session on an agent and start receiving its output. */
  async createSession(
    agentId: string,
    opts: { kind?: SessionKind; cols?: number; rows?: number } = {},
  ): Promise<SessionRecord> {
    const env = await this.request(agentId, {
      type: "session.create",
      kind: opts.kind ?? "pty",
      deviceId: DeviceId.parse(agentId),
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    });
    if (env.body.type !== "session.created") throw new Error(bodyError(env, "create"));
    this.active.set(env.body.session.id, agentId);
    return env.body.session;
  }

  /** Attach to an existing session; the scrollback arrives via onScrollback. */
  async attach(agentId: string, sessionId: string): Promise<SessionRecord> {
    this.active.set(sessionId, agentId);
    const env = await this.request(agentId, { type: "session.attach", sessionId: SessionId.parse(sessionId) });
    if (env.body.type !== "session.attached") throw new Error(bodyError(env, "attach"));
    return env.body.session;
  }

  input(agentId: string, sessionId: string, data: string): void {
    this.rawSend(this.deviceId, agentId, { type: "session.input", sessionId: SessionId.parse(sessionId), data });
  }
  resize(agentId: string, sessionId: string, cols: number, rows: number): void {
    this.rawSend(this.deviceId, agentId, { type: "session.resize", sessionId: SessionId.parse(sessionId), cols, rows });
  }
  closeSession(agentId: string, sessionId: string): void {
    this.rawSend(this.deviceId, agentId, { type: "session.close", sessionId: SessionId.parse(sessionId) });
  }

  // --- internals ---------------------------------------------------------

  private dispatch(env: Envelope): void {
    const body = env.body;

    if (!this.acked) {
      if (body.type === "hello.challenge") {
        const signer = this.signer;
        if (signer) {
          const { nonce } = body;
          const pin = this.hubKeyPin;
          const hubProof = body.hub;
          const clientNonce = this.clientNonce;
          void (async () => {
            if (pin) {
              // Mutual auth: the hub must prove the pinned identity BEFORE we
              // sign anything. cb="" — the viewer does no channel binding.
              const ok =
                !!hubProof &&
                hubProof.key === pin &&
                (await verifyHubAuth(pin, this.deviceId, clientNonce, nonce, "", hubProof.signature));
              if (!ok) {
                this.refuseHub();
                return;
              }
            }
            const signature = base64urlEncode(await signer.sign(buildHandshakePayload(this.deviceId, nonce)));
            this.rawSend(this.deviceId, HUB, { type: "hello.proof", deviceId: DeviceId.parse(this.deviceId), signature });
          })();
        }
        return;
      }
      if (body.type === "hello.ack") {
        this.acked = true;
        this.reconnectDelay = 250;
        this.events.onConnected?.();
        // Re-attach anything we were holding (viewer-driven recovery after our
        // own reconnect). Agent-side recovery is handled by onDeviceState below.
        for (const [sessionId, agentId] of this.active) void this.reattach(agentId, sessionId);
      }
      return;
    }

    if (env.replyTo) {
      const p = this.pending.get(env.replyTo);
      if (p) {
        this.pending.delete(env.replyTo);
        clearTimeout(p.timer);
        p.resolve(env);
        // Correlated replies also carry a scrollback we want the UI to paint.
        if (body.type === "session.attached") this.events.onScrollback?.(body.session.id, body.scrollback);
        return;
      }
    }

    switch (body.type) {
      case "session.output":
        this.events.onOutput?.(body.sessionId, body.data, body.seq);
        break;
      case "session.exited":
        this.active.delete(body.sessionId);
        this.events.onExited?.(body.sessionId, body.exitCode, body.signal);
        break;
      case "device.listed":
        this.events.onDevices?.(body.devices);
        break;
      case "device.state":
        this.events.onDeviceState?.(body.device);
        // Agent came back: re-attach the sessions we hold on it.
        if (body.device.state === "connected") {
          for (const [sessionId, agentId] of this.active) {
            if (agentId === body.device.id) void this.reattach(agentId, sessionId);
          }
        }
        break;
      case "error":
        this.events.onError?.(body.code, body.message);
        break;
      default:
        break;
    }
  }

  /**
   * The hub failed to prove the pinned identity. This is not transient — a
   * wrong pin (or an impostor) will never verify — so surface the failure and
   * stop for good instead of reconnect-looping into the same refusal.
   */
  private refuseHub(): void {
    this.closed = true;
    this.events.onError?.("hub_identity", "hub identity verification failed — refusing to connect");
    try {
      this.ws?.close(4010, "hub identity not verified");
    } catch {
      /* already closed */
    }
  }

  private async reattach(agentId: string, sessionId: string): Promise<void> {
    try {
      await this.attach(agentId, sessionId);
    } catch {
      /* the agent may not be ready yet; a later device.state will retry */
    }
  }

  private request(to: string, body: Body, timeoutMs = 8000): Promise<Envelope> {
    return new Promise<Envelope>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.acked) {
        reject(new Error("hub client is not connected"));
        return;
      }
      const id = this.rawSend(this.deviceId, to, body);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${body.type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private rawSend(from: string, to: string, body: Body): string {
    const env = makeEnvelope({ id: randomId(), ts: Date.now(), from, to, body });
    this.ws?.send(JSON.stringify(env));
    return env.id;
  }
}

function bodyError(env: Envelope, what: string): string {
  return env.body.type === "error" ? `${what}: ${env.body.code} — ${env.body.message}` : `${what}: unexpected ${env.body.type}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function randomId(): string {
  // crypto.randomUUID is available in browsers and Node ≥ (globalThis.crypto).
  return globalThis.crypto.randomUUID();
}
