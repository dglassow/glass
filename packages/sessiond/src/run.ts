import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DeviceId,
  RunId,
  sanitizeRunUsage,
  type RunControl,
  type RunCreate,
  type RunEventKind,
  type RunEventRecord,
  type RunRecord,
  type RunRespond,
  type RunQueryName,
} from "@glass/protocol";
import { CodexAppServer } from "./codex-app-server.js";

const MAX_EVENTS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function genericArgv(): string[] | null {
  const raw = process.env["GLASS_GENERIC_AGENT_ARGV"];
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)
      ? value
      : null;
  } catch {
    return null;
  }
}

type RunListener = (event: RunEventRecord | RunRecord) => void;

export class ManagedRun {
  readonly id = RunId.parse(randomUUID());
  readonly events: RunEventRecord[] = [];
  readonly record: RunRecord;
  private readonly listeners = new Set<RunListener>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private etch: EtchSurface | null = null;
  private etchLegacy = false;
  private codex: CodexAppServer | null = null;
  private codexLegacy = false;
  private busy = false;
  private closed = false;
  private readonly queue: string[] = [];
  private readonly pendingInputs = new Map<string, "clarify" | "approval">();
  private model?: string;
  private profile?: string;
  private modelProvider?: string;
  private reasoningEffort?: string;
  private fast?: boolean;
  private lastSessionInfo: Record<string, unknown> = {};
  private statusSemantic = "";
  private readonly statusTimer: ReturnType<typeof setInterval>;

  constructor(
    request: RunCreate,
    private readonly statusDir: string,
  ) {
    const now = Date.now();
    if (request.model) this.model = request.model;
    if (request.profile) this.profile = request.profile;
    if (request.modelProvider) this.modelProvider = request.modelProvider;
    if (request.reasoningEffort) this.reasoningEffort = request.reasoningEffort;
    if (request.fast !== undefined) this.fast = request.fast;
    this.record = {
      id: this.id,
      deviceId: DeviceId.parse(request.deviceId),
      provider: request.provider,
      title: request.title?.trim() || `${request.provider} run`,
      state: "starting",
      ...(request.cwd ? { cwd: resolve(request.cwd) } : {}),
      ...(request.providerSessionId ? { providerSessionId: request.providerSessionId } : {}),
      ...(request.providerStoredSessionId ? { providerStoredSessionId: request.providerStoredSessionId } : {}),
      ...(request.worktreeRef ? { worktreeRef: request.worktreeRef } : {}),
      ...(request.profile ? { profile: request.profile } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.modelProvider ? { modelProvider: request.modelProvider } : {}),
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      worktreeMode: request.worktreeMode,
      capabilities: [],
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 0,
    };
    mkdirSync(statusDir, { recursive: true, mode: 0o700 });
    this.statusTimer = setInterval(() => this.pollStatus(), 500);
    this.statusTimer.unref();
    queueMicrotask(() => void this.start(request.prompt));
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(text: string): void {
    if (this.closed) return;
    this.queue.push(text);
    if (!this.busy) void this.drain();
  }

  async respond(request: RunRespond): Promise<void> {
    if (this.codex) {
      try {
        this.codex.respond(request.requestId, request.response);
        this.pendingInputs.delete(request.requestId);
        delete this.record.attention;
        this.setState("running");
      } catch (error) {
        this.emit("error", { message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (!this.etch) {
      this.emit("notice", { message: "This provider does not expose interactive responses; submit a new message instead." });
      return;
    }
    const kind = this.pendingInputs.get(request.requestId);
    if (kind === "approval") {
      const choice = ["once", "session", "always", "deny"].includes(request.response) ? request.response : "deny";
      await this.etch.request("approval.respond", { session_id: this.record.providerSessionId, choice });
    } else {
      await this.etch.request("clarify.respond", { request_id: request.requestId, answer: request.response });
    }
    this.pendingInputs.delete(request.requestId);
    delete this.record.attention;
    this.setState("running");
  }

  async control(request: RunControl): Promise<void> {
    if (request.action === "close") {
      if (this.etch && this.record.providerSessionId) {
        await this.etch.request("session.close", { session_id: this.record.providerSessionId }).catch(() => undefined);
      }
      this.close();
      return;
    }
    if (this.etch) {
      if (request.action === "interrupt-subagent" && request.targetId) {
        await this.etch.request("subagent.interrupt", { subagent_id: request.targetId });
      } else if (request.action === "pause-delegation" || request.action === "resume-delegation") {
        await this.etch.request("delegation.pause", { paused: request.action === "pause-delegation" });
      } else if (request.action === "interrupt" && this.record.providerSessionId) {
        await this.etch.request("session.interrupt", { session_id: this.record.providerSessionId });
      }
    } else if (this.codex && request.action === "interrupt") {
      await this.codex.interrupt();
    } else if (request.action === "interrupt") {
      this.child?.kill("SIGINT");
    }
    if (request.action === "interrupt") {
      this.setState("interrupted");
      // The structured-etch drain loop parks with busy=true awaiting
      // message.complete, which an interrupted turn may never emit.
      if (this.etch) this.busy = false;
    }
  }

  async query(query: RunQueryName): Promise<Record<string, unknown>> {
    if (!this.etch) throw new Error(`${this.record.provider} does not expose structured queries`);
    if (query === "session.info") return structuredClone(this.lastSessionInfo);
    const method = {
      "sessions.active": "session.active_list",
      "commands.catalog": "commands.catalog",
      "delegation.status": "delegation.status",
      "orchestration.status": "orchestration.status",
    }[query];
    return await this.etch.request(method, {
      ...(query === "sessions.active" ? { current_session_id: this.record.providerSessionId } : {}),
      ...(query === "commands.catalog" ? { session_id: this.record.providerSessionId, surface: "desktop" } : {}),
      ...(query === "orchestration.status" ? { session_id: this.record.providerSessionId } : {}),
    });
  }

  async attachFile(input: { path?: string; dataUrl?: string; name?: string }): Promise<Record<string, unknown>> {
    if (!this.etch || !this.record.providerSessionId) throw new Error(`${this.record.provider} does not expose structured attachments`);
    if (!input.path && !input.dataUrl) throw new Error("file attachment requires path or dataUrl");
    return await this.etch.request("file.attach", {
      session_id: this.record.providerSessionId,
      ...(input.path ? { path: input.path } : {}),
      ...(input.dataUrl ? { data_url: input.dataUrl } : {}),
      ...(input.name ? { name: input.name } : {}),
    });
  }

  close(state: "closed" | "interrupted" = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill("SIGTERM");
    this.etch?.close();
    this.codex?.close();
    clearInterval(this.statusTimer);
    this.setState(state);
  }

  private async start(initial?: string): Promise<void> {
    try {
      if (this.record.worktreeMode === "read-only") throw new Error("read-only agent runs are not implemented; choose an isolated or shared checkout");
      if (this.record.provider !== "etch" && this.record.worktreeMode === "isolated") {
        throw new Error(`${this.record.provider} does not expose provider-owned isolated worktrees; choose shared mode`);
      }
      if (this.record.provider === "etch") await this.startEtch();
      else if (this.record.provider === "codex") await this.startCodex();
      else this.setCapabilities(this.record.provider === "generic" ? ["stdio", "interrupt"] : ["stream", "sessions", "interrupt"]);
      this.setState("idle");
      if (initial) this.submit(initial);
    } catch (error) {
      this.emit("error", { message: error instanceof Error ? error.message : String(error) });
      this.setState("failed");
    }
  }

  private prepareEtchWorktree(): void {
    if (!this.record.cwd) throw new Error("isolated Etch runs require a working directory");
    const binary = process.env["GLASS_ETCH_BIN"] || "etch";
    const name = `glass-${this.id.slice(0, 8)}`;
    const created = spawnSync(binary, ["worktree", "create", name, "--json"], {
      cwd: this.record.cwd,
      encoding: "utf8",
      timeout: 90_000,
      env: this.providerEnv(),
    });
    if (created.error || created.status !== 0) {
      throw new Error((created.stderr || created.stdout || created.error?.message || "Etch worktree creation failed").trim());
    }
    let result: { path?: unknown; branch?: unknown };
    try { result = JSON.parse(created.stdout) as { path?: unknown; branch?: unknown }; }
    catch { throw new Error("Etch worktree create returned invalid JSON"); }
    if (typeof result.path !== "string" || typeof result.branch !== "string") throw new Error("Etch worktree create omitted path or branch");
    const locked = spawnSync(binary, ["worktree", "lock", name, "--task-id", this.id, "--expiry", "1440"], {
      cwd: this.record.cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: this.providerEnv(),
    });
    if (locked.error || locked.status !== 0) throw new Error((locked.stderr || locked.stdout || locked.error?.message || "Etch worktree lock failed").trim());
    this.record.worktreeRef = { name, path: result.path, branch: result.branch };
    this.record.cwd = resolve(result.path);
    this.touch();
  }

  private async startEtch(): Promise<void> {
    const binary = process.env["GLASS_ETCH_BIN"] || "etch";
    const env = this.providerEnv();
    const etch = new EtchSurface(binary, env, (type, payload, sessionId) => this.onEtchEvent(type, payload, sessionId));
    this.etch = etch;
    let ready: Record<string, any>;
    try {
      ready = await withTimeout(etch.ready(), 10_000, "Etch surface handshake timed out");
    } catch (error) {
      etch.close();
      this.etch = null;
      this.etchLegacy = true;
      if (this.record.worktreeMode === "isolated") this.record.worktreeMode = "shared";
      this.setCapabilities(["oneshot", "reduced"]);
      this.emit("notice", {
        message: "Etch does not expose the Glass surface; using the reduced etch -z compatibility adapter.",
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.setCapabilities(Array.isArray(ready.capabilities?.required)
      ? [...ready.capabilities.required, ...(Array.isArray(ready.capabilities?.optional) ? ready.capabilities.optional : [])]
      : []);
    const resumeId = this.record.providerStoredSessionId || this.record.providerSessionId;
    if (this.record.worktreeMode === "isolated" && !resumeId) this.prepareEtchWorktree();
    const created = resumeId
      ? await etch.request("session.resume", {
          session_id: resumeId,
          ...(this.profile ? { profile: this.profile } : {}),
          lazy: false,
          close_on_disconnect: false,
        })
      : await etch.request("session.create", {
          ...(this.record.cwd ? { cwd: this.record.cwd } : {}),
          ...(this.profile ? { profile: this.profile } : {}),
          ...(this.model ? { model: this.model } : {}),
          ...(this.modelProvider ? { provider: this.modelProvider } : {}),
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
          ...(this.fast !== undefined ? { fast: this.fast } : {}),
          title: this.record.title,
          close_on_disconnect: false,
        });
    const sessionId = typeof created.session_id === "string" ? created.session_id : "";
    if (!sessionId) throw new Error("Etch did not return a session_id");
    this.record.providerSessionId = sessionId;
    const activated = await etch.request("session.activate", { session_id: sessionId });
    if (activated.info && typeof activated.info === "object") {
      this.lastSessionInfo = structuredClone(activated.info as Record<string, unknown>);
    } else if (created.info && typeof created.info === "object") {
      this.lastSessionInfo = structuredClone(created.info as Record<string, unknown>);
    }
    const storedId = typeof created.stored_session_id === "string"
      ? created.stored_session_id
      : typeof created.resumed === "string"
        ? created.resumed
        : resumeId;
    if (storedId) this.record.providerStoredSessionId = storedId;
    this.touch();
  }

  private async startCodex(): Promise<void> {
    const codex = new CodexAppServer(
      process.env["GLASS_CODEX_BIN"] || "codex",
      this.providerEnv(),
      (kind, data) => this.onCodexEvent(kind, data),
    );
    this.codex = codex;
    try {
      this.record.providerSessionId = await codex.initialize({
        ...(this.record.cwd ? { cwd: this.record.cwd } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...(this.modelProvider ? { modelProvider: this.modelProvider } : {}),
        ...(this.record.providerSessionId ? { resumeThreadId: this.record.providerSessionId } : {}),
      });
      this.setCapabilities(["app-server", "stream", "sessions", "approval", "clarify", "interrupt", "usage"]);
      this.touch();
    } catch (error) {
      codex.close();
      this.codex = null;
      this.codexLegacy = true;
      this.setCapabilities(["jsonl", "sessions", "interrupt", "reduced"]);
      this.emit("notice", {
        message: "Codex app-server is unavailable; using the reduced codex exec --json adapter.",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async drain(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    while (this.queue.length && !this.closed) {
      const prompt = this.queue.shift() as string;
      this.setState("running");
      try {
        if (this.record.provider === "etch") {
          if (this.etchLegacy) {
            await this.runOneShot(prompt);
            this.setState("completed");
          } else {
            if (!this.etch || !this.record.providerSessionId) throw new Error("Etch surface is not ready");
            await this.etch.request("prompt.submit", { session_id: this.record.providerSessionId, text: prompt });
            // Completion is asynchronous and changes state from onEtchEvent.
            break;
          }
        } else if (this.record.provider === "codex" && this.codex && !this.codexLegacy) {
          await this.codex.turn(prompt, this.reasoningEffort);
          if (!this.closed && this.record.state !== "interrupted") this.setState("completed");
        } else {
          await this.runOneShot(prompt);
          this.setState("completed");
        }
      } catch (error) {
        if (!this.closed) {
          this.emit("error", { message: error instanceof Error ? error.message : String(error) });
          this.setState("failed");
        }
      }
    }
    this.busy = false;
  }

  private runOneShot(prompt: string): Promise<void> {
    const provider = this.record.provider;
    let command: string;
    let args: string[];
    if (provider === "etch") {
      command = process.env["GLASS_ETCH_BIN"] || "etch";
      args = ["-z", prompt];
    } else if (provider === "codex") {
      command = process.env["GLASS_CODEX_BIN"] || "codex";
      args = this.record.providerSessionId
        ? ["exec", "resume", this.record.providerSessionId, "--json", "-"]
        : ["exec", "--json", "-", ...(this.record.cwd ? ["--cd", this.record.cwd] : []), ...(this.model ? ["--model", this.model] : [])];
    } else if (provider === "claude") {
      command = process.env["GLASS_CLAUDE_BIN"] || "claude";
      args = ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
      if (this.record.providerSessionId) args.push("--resume", this.record.providerSessionId);
      if (this.model) args.push("--model", this.model);
    } else {
      const configured = genericArgv();
      if (!configured) return Promise.reject(new Error("generic provider is not configured (set GLASS_GENERIC_AGENT_ARGV to a JSON argv array)"));
      command = configured[0] as string;
      args = configured.slice(1);
    }
    return new Promise((resolveRun, reject) => {
      const child = spawn(command, args, {
        cwd: this.record.cwd,
        env: this.providerEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.emit("assistant.start", {});
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        let newline: number;
        while ((newline = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (line) this.onProviderLine(provider, line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024); });
      child.once("error", reject);
      child.once("close", (code) => {
        this.child = null;
        if (stdout.trim()) this.onProviderLine(provider, stdout.trim());
        if (code === 0) {
          this.emit("assistant.complete", {});
          resolveRun();
        } else reject(new Error(stderr.trim() || `${provider} exited with code ${code}`));
      });
      // A spawn failure or early exit must reject via the child handlers, not
      // crash sessiond with an unhandled stdin EPIPE.
      child.stdin.on("error", () => {});
      if (provider === "etch") child.stdin.end();
      else child.stdin.end(prompt);
    });
  }

  private onProviderLine(provider: RunRecord["provider"], line: string): void {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch { this.emit("assistant.delta", { text: line + "\n" }); return; }
    const type = String(value.type || "event");
    if (provider === "codex") {
      if (type === "thread.started" && typeof value.thread_id === "string") {
        this.record.providerSessionId = value.thread_id;
        this.touch();
      }
      const item = value.item as Record<string, unknown> | undefined;
      if (item && typeof item.text === "string") this.emit("assistant.delta", { text: item.text, itemType: item.type });
      else if (type.includes("error")) this.emit("error", value);
      else if (type.includes("usage")) {
        this.record.usage = sanitizeRunUsage(value);
        this.emit("usage", value);
        this.touch();
      } else this.emit("tool", value);
      return;
    }
    if (provider === "claude") {
      if (type === "system" && typeof value.session_id === "string") {
        this.record.providerSessionId = value.session_id;
        this.touch();
      }
      const event = value.event as Record<string, unknown> | undefined;
      const delta = event?.delta as Record<string, unknown> | undefined;
      if (type === "result" && value.usage && typeof value.usage === "object") {
        this.record.usage = sanitizeRunUsage(value.usage);
        this.emit("usage", value.usage as Record<string, unknown>);
        this.touch();
      }
      if (typeof delta?.text === "string") this.emit("assistant.delta", { text: delta.text });
      else if (type === "result" && typeof value.result === "string") this.emit("assistant.delta", { text: value.result });
      else if (!(type === "result" && value.usage && typeof value.usage === "object")) this.emit(type.includes("error") ? "error" : "tool", value);
      return;
    }
    this.emit("assistant.delta", { text: typeof value.text === "string" ? value.text : line + "\n" });
  }

  private onCodexEvent(kind: string, data: Record<string, unknown>): void {
    if (kind === "input.required" || kind === "approval.required") {
      const requestId = String(data.requestId || randomUUID());
      this.pendingInputs.set(requestId, kind === "input.required" ? "clarify" : "approval");
      this.record.attention = kind === "input.required" ? "clarification" : "approval";
      this.emit(kind as RunEventKind, { ...data, requestId });
      this.setState("needs-input");
      return;
    }
    if (kind === "usage") {
      this.record.usage = sanitizeRunUsage(data);
      this.emit("usage", data);
      this.touch();
      return;
    }
    this.emit(kind as RunEventKind, data);
  }

  private onEtchEvent(type: string, payload: Record<string, unknown>, sessionId?: string): void {
    if (sessionId && this.record.providerSessionId && sessionId !== this.record.providerSessionId) return;
    if (type === "message.start") this.emit("assistant.start", payload);
    else if (type === "message.delta") this.emit("assistant.delta", payload);
    else if (type === "message.complete") {
      if (payload.usage && typeof payload.usage === "object") {
        this.record.usage = sanitizeRunUsage(payload.usage);
        this.emit("usage", payload.usage as Record<string, unknown>);
      }
      this.emit("assistant.complete", payload);
      this.setState("completed");
      this.busy = false;
      if (this.queue.length) void this.drain();
    } else if (type === "clarify.request" || type === "approval.request") {
      const requestId = String(payload.request_id || randomUUID());
      this.pendingInputs.set(requestId, type === "clarify.request" ? "clarify" : "approval");
      this.record.attention = type === "clarify.request" ? "clarification" : "approval";
      this.emit(type === "clarify.request" ? "input.required" : "approval.required", { ...payload, requestId });
      this.setState("needs-input");
    } else if (type.startsWith("subagent.")) this.emit(type as RunEventKind, payload);
    else if (type === "error") {
      this.emit("error", payload);
      this.setState("failed");
      // A failed turn never emits message.complete; release the drain loop so
      // later submits aren't queued forever.
      this.busy = false;
      if (this.queue.length) void this.drain();
    } else if (type === "session.info") {
      this.lastSessionInfo = structuredClone(payload);
      this.emit("status", payload);
    }
  }

  private providerEnv(): NodeJS.ProcessEnv {
    const file = `${this.statusDir}/${this.id}.json`;
    return {
      ...process.env,
      GLASS_TERMINAL_SESSION_ID: this.id,
      GLASS_TERMINAL_STATUS_DIR: this.statusDir,
      GLASS_AGENT_STATUS_FILE: file,
      PRISM_TERMINAL_SESSION_ID: this.id,
      PRISM_TERMINAL_STATUS_DIR: this.statusDir,
      PRISM_AGENT_STATUS_FILE: file,
    };
  }

  private pollStatus(): void {
    try {
      const raw = JSON.parse(readFileSync(`${this.statusDir}/${this.id}.json`, "utf8")) as Record<string, any>;
      if (raw.schemaVersion !== 2 || raw.agent?.id !== "etch") return;
      const input = raw.input && typeof raw.input === "object" ? raw.input : null;
      const completion = raw.completion && typeof raw.completion === "object" ? raw.completion : null;
      const semantic = JSON.stringify([raw.instanceId, raw.turnId, raw.turnEpoch, raw.phase, input?.requestId, input?.kind, completion?.reviewId]);
      if (semantic === this.statusSemantic) return;
      this.statusSemantic = semantic;
      this.emit("status", {
        source: "status-file",
        phase: String(raw.phase || "unknown"),
        turnId: String(raw.turnId || ""),
        ...(input ? { input: { requestId: String(input.requestId || ""), kind: String(input.kind || "input") } } : {}),
        ...(completion ? { completion: { reviewId: String(completion.reviewId || "") } } : {}),
      });
      if (raw.phase === "needs-input") {
        const kind = String(input?.kind || "").toLowerCase();
        this.record.attention = kind.includes("approval") ? "approval" : kind.includes("clarif") ? "clarification" : "provider-input";
        this.setState("needs-input");
        this.touch();
      }
      else if (raw.phase === "working") this.setState("running");
      else if (raw.phase === "completed" && this.record.state === "running") this.setState("completed");
      else if (raw.phase === "exited" && !this.closed) this.setState("failed");
    } catch {
      // Status publication is best-effort and may not exist for non-Etch providers.
    }
  }

  private setCapabilities(capabilities: string[]): void {
    this.record.capabilities = [...new Set(capabilities)].sort();
    this.touch();
  }

  private setState(state: RunRecord["state"]): void {
    if (this.record.state === state) return;
    this.record.state = state;
    if (state !== "needs-input") delete this.record.attention;
    this.emit("status", { state });
    this.touch();
  }

  private touch(): void {
    this.record.updatedAt = Date.now();
    for (const listener of this.listeners) listener(structuredClone(this.record));
  }

  private emit(kind: RunEventKind, data: Record<string, unknown>): void {
    const event: RunEventRecord = {
      runId: this.id,
      seq: ++this.record.lastEventSeq,
      at: Date.now(),
      kind,
      data,
    };
    this.record.updatedAt = event.at;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const listener of this.listeners) listener(structuredClone(event));
  }
}

class EtchSurface {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private failed: Error | null = null;
  private readyResolve!: (payload: Record<string, any>) => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<Record<string, any>>;
  private readonly pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void }>();

  constructor(binary: string, env: NodeJS.ProcessEnv, private readonly onEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void) {
    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    this.child = spawn(binary, ["surface", "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-64 * 1024); });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code) => this.fail(new Error(this.stderr.trim() || `Etch surface exited with code ${code}`)));
    // A dead surface must surface via close/fail, not as an unhandled stdin
    // EPIPE that would take down sessiond (and every PTY with it).
    this.child.stdin.on("error", () => {});
  }

  ready(): Promise<Record<string, any>> { return this.readyPromise; }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  close(): void { this.child.kill("SIGTERM"); }

  private consume(chunk: string): void {
    this.stdout += chunk;
    let newline: number;
    while ((newline = this.stdout.indexOf("\n")) >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      try { this.frame(JSON.parse(line) as Record<string, any>); }
      catch { /* stdout is protocol-only; malformed frames are ignored and the process remains observable */ }
    }
  }

  private frame(frame: Record<string, any>): void {
    if (frame.method === "event") {
      const params = frame.params as Record<string, any> | undefined;
      const type = String(params?.type || "");
      const payload = (params?.payload && typeof params.payload === "object" ? params.payload : {}) as Record<string, unknown>;
      if (type === "gateway.ready") this.readyResolve(payload as Record<string, any>);
      else this.onEvent(type, payload, typeof params?.session_id === "string" ? params.session_id : undefined);
      return;
    }
    if (typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(String(frame.error.message || "Etch RPC failed")));
      else pending.resolve((frame.result || {}) as Record<string, any>);
    }
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    this.readyReject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
