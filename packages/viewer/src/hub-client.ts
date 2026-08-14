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
  type DeviceRole,
  type EnrollCompanion,
  type SessionRecord,
  type SessionKind,
  type Signer,
} from "@glass/protocol";

/** Lets an untrusted device self-enroll (number match) instead of failing. */
export interface EnrollConfig {
  deviceName: string;
  roles: DeviceRole[];
  /** Extra keys trusted under the same approval (e.g. this Mac's shell agent). */
  companions: EnrollCompanion[];
}

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
  /** A session (possibly on another device) was created somewhere in the fleet. */
  onSessionAppeared?: (session: SessionRecord) => void;
  onError?: (code: string, message: string) => void;
  /** The hub reports a build available at its update origin. Advisory: the UI
   *  compares it to the running app version and may nag. Install stays gated. */
  onUpdateAvailable?: (version: string) => void;
  // --- enrollment (self-serve device join) ---
  /** Joining device: our request is pending — display this 6-digit code. */
  onEnrollWaiting?: (code: string) => void;
  /** Joining device: approved — the client reconnects as a trusted device. */
  onEnrollApproved?: () => void;
  /** Joining device: declined or expired. */
  onEnrollDenied?: (reason: string) => void;
  /** Approver device: another device wants to join. Shows what will be granted
   *  (device name, roles, companion keys); the human types the code they read
   *  off the JOINING device's screen (the code is never broadcast to approvers). */
  onEnrollRequest?: (req: { requestId: string; deviceName: string; roles: DeviceRole[]; companions: EnrollCompanion[] }) => void;
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
  /** Enrollment (self-serve join): active when this device isn't trusted yet. */
  private enrolling = false;
  private enrollOutcome: "none" | "approved" | "denied" = "none";

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
    /**
     * If set, this device may self-enroll: when the hub refuses it as untrusted
     * (close 4007), it sends a device.enroll.request (showing a 6-digit code)
     * instead of reconnect-looping, and reconnects as trusted once approved.
     */
    private readonly enroll?: EnrollConfig,
  ) {}

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.acked = false;
    this.clientNonce = randomNonce();

    ws.addEventListener("open", () => {
      // On the join path the first frame is an enroll request, not a hello.
      if (this.enrolling) {
        this.sendEnrollRequest();
        return;
      }
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

    ws.addEventListener("close", (ev: CloseEvent) => {
      this.acked = false;
      this.events.onDisconnected?.();
      if (this.closed) return;
      // 4007 = the hub refused us as untrusted. If we can self-enroll, do so
      // (once); if we were already declined, stop looping.
      if (ev.code === 4007 && this.enroll) {
        if (this.enrollOutcome === "denied") {
          this.closed = true;
          return;
        }
        if (this.enrollOutcome === "none" && !this.enrolling) {
          this.enrolling = true;
          setTimeout(() => this.connect(), 100);
          return;
        }
        // "approved" (trust just added) or already enrolling → retry a hello.
      }
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
    if (env.body.type !== "session.created") throw requestError(env, "create");
    this.active.set(env.body.session.id, agentId);
    return env.body.session;
  }

  /** Attach to an existing session; the scrollback arrives via onScrollback. */
  async attach(agentId: string, sessionId: string): Promise<SessionRecord> {
    this.active.set(sessionId, agentId);
    const env = await this.request(agentId, { type: "session.attach", sessionId: SessionId.parse(sessionId) });
    if (env.body.type !== "session.attached") {
      const err = requestError(env, "attach");
      // A missing session is gone for good (sessiond restarted, or the shell
      // exited while we were away) — stop holding it, or every reconnect would
      // retry an attach that can never succeed.
      if (err.code === "session_not_found") this.active.delete(sessionId);
      throw err;
    }
    return env.body.session;
  }

  /** Enumerate the sessions an agent currently owns (for fleet-wide discovery). */
  async listSessions(agentId: string): Promise<SessionRecord[]> {
    const env = await this.request(agentId, { type: "session.list" });
    if (env.body.type !== "session.listed") throw requestError(env, "list");
    return env.body.sessions;
  }

  /** Ask an agent (normally THIS Mac's own) to run a local SOCKS5 forwarder
   *  whose traffic egresses through `exitDeviceId` (plan §7). Idempotent per
   *  exit device; resolves with the forwarder's loopback port. */
  async openProxyForward(agentId: string, exitDeviceId: string): Promise<number> {
    const env = await this.request(agentId, { type: "proxy.forward.open", exitDeviceId });
    if (env.body.type !== "proxy.forward.opened") throw requestError(env, "proxy forward");
    return env.body.port;
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

  /** Approver: approve a pending enrollment (echoing the matching code) or decline it. */
  sendEnrollDecision(requestId: string, approved: boolean, code?: string): void {
    this.rawSend(
      this.deviceId,
      HUB,
      approved && code
        ? { type: "device.enroll.decision", requestId, approved: true, verificationCode: code }
        : { type: "device.enroll.decision", requestId, approved: false },
    );
  }

  // --- internals ---------------------------------------------------------

  /** Joining device's first frame: ask to be trusted (viewer + companion agent).
   *  The hub mints the verification code — we never choose it — and proves its
   *  pinned identity against clientNonce before we display anything. */
  private sendEnrollRequest(): void {
    const cfg = this.enroll;
    const signer = this.signer;
    if (!cfg || !signer) return;
    this.rawSend(this.deviceId, HUB, {
      type: "device.enroll.request",
      deviceId: DeviceId.parse(this.deviceId),
      deviceName: cfg.deviceName,
      roles: cfg.roles,
      publicKey: signer.publicKey,
      ...(this.hubKeyPin ? { clientNonce: this.clientNonce } : {}),
      ...(cfg.companions.length ? { companions: cfg.companions } : {}),
    });
  }

  private dispatch(env: Envelope): void {
    const body = env.body;

    // Enrollment runs pre-ack on a dedicated socket; handle its frames first.
    if (this.enrolling) {
      if (body.type === "device.enroll.pending") {
        const pending = body;
        const pin = this.hubKeyPin;
        void (async () => {
          // Verify the hub proved its pinned identity on THIS lane before we show
          // a code / trust the flow — a MITM hub can't forge this signature.
          if (pin) {
            const proof = pending.hubProof;
            const ok = !!proof && proof.key === pin && (await verifyHubAuth(pin, this.deviceId, this.clientNonce, "enroll", "", proof.signature));
            if (!ok) {
              this.enrolling = false;
              this.enrollOutcome = "denied";
              this.closed = true;
              this.ws?.close();
              this.events.onEnrollDenied?.("hub identity could not be verified");
              return;
            }
          }
          if (pending.verificationCode) this.events.onEnrollWaiting?.(pending.verificationCode);
        })();
      } else if (body.type === "device.enroll.decision") {
        this.enrolling = false;
        if (body.approved) {
          this.enrollOutcome = "approved"; // hub closes this socket; we reconnect with hello
          this.events.onEnrollApproved?.();
        } else {
          this.enrollOutcome = "denied";
          this.events.onEnrollDenied?.("declined");
        }
      }
      return;
    }

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
      case "session.created":
        // Unsolicited (a create reply is matched above by replyTo): a session
        // appeared elsewhere in the fleet — surface it for the sidebar.
        this.events.onSessionAppeared?.(body.session);
        break;
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
      case "device.enroll.pending":
        // We're trusted; another device wants to join — surface WHAT will be
        // granted. The code isn't broadcast; the human types it from that device.
        this.events.onEnrollRequest?.({ requestId: body.requestId, deviceName: body.deviceName, roles: body.roles ?? [], companions: body.companions ?? [] });
        break;
      case "error":
        this.events.onError?.(body.code, body.message);
        break;
      case "update.available":
        this.events.onUpdateAvailable?.(body.version);
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
    } catch (err) {
      // Permanent failure: the session no longer exists anywhere. Surface it as
      // an exit so the UI marks the pane dead instead of leaving a zombie pane
      // that keeps its scrollback and silently swallows keystrokes.
      if (err instanceof RequestError && err.code === "session_not_found") {
        this.events.onExited?.(sessionId, null, null);
        return;
      }
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

/** A request that came back as a protocol error (or an unexpected body). */
export class RequestError extends Error {
  constructor(
    message: string,
    /** Structured protocol error code (e.g. "session_not_found"), if the reply was an error body. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function requestError(env: Envelope, what: string): RequestError {
  return env.body.type === "error"
    ? new RequestError(`${what}: ${env.body.code} — ${env.body.message}`, env.body.code)
    : new RequestError(`${what}: unexpected ${env.body.type}`);
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
