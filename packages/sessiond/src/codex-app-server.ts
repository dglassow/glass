import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type Json = Record<string, any>;
type EventSink = (kind: string, data: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}

interface InboundRequest {
  id: string | number;
  method: string;
  params: Json;
}

/** Owns Codex's public app-server process and thread across Agent swaps. */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inbound = new Map<string, InboundRequest>();
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private threadId = "";
  private activeTurnId = "";
  private turnResolve: (() => void) | null = null;
  private turnReject: ((error: Error) => void) | null = null;
  private failed: Error | null = null;

  constructor(binary: string, env: NodeJS.ProcessEnv, private readonly onEvent: EventSink) {
    this.child = spawn(binary, ["app-server", "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-64 * 1024); });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code) => this.fail(new Error(this.stderr.trim() || `Codex app-server exited with code ${code}`)));
    // A dead app-server must surface via close/fail, not as an unhandled stdin
    // EPIPE that would take down sessiond (and every PTY with it).
    this.child.stdin.on("error", () => {});
  }

  async initialize(input: { cwd?: string; model?: string; modelProvider?: string; resumeThreadId?: string }): Promise<string> {
    await this.withTimeout(
      this.request("initialize", { clientInfo: { name: "glass", title: "Glass", version: "0.0.0" } }),
      "Codex app-server handshake timed out",
    );
    this.notify("initialized", {});
    const result = input.resumeThreadId
      ? await this.request("thread/resume", {
          threadId: input.resumeThreadId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
        })
      : await this.request("thread/start", {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
        });
    const thread = result.thread as Json | undefined;
    if (!thread || typeof thread.id !== "string") throw new Error("Codex app-server did not return a thread id");
    this.threadId = thread.id;
    return this.threadId;
  }

  turn(prompt: string, effort?: string): Promise<void> {
    if (!this.threadId) return Promise.reject(new Error("Codex app-server thread is not ready"));
    if (this.turnResolve) return Promise.reject(new Error("Codex turn already running"));
    return new Promise<void>((resolveTurn, rejectTurn) => {
      this.turnResolve = resolveTurn;
      this.turnReject = rejectTurn;
      void this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
        ...(effort ? { effort } : {}),
      }).then((result) => {
        const turn = result.turn as Json | undefined;
        if (turn && typeof turn.id === "string") this.activeTurnId = turn.id;
      }).catch((error: Error) => this.finishTurn(error));
    });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) return;
    await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
  }

  respond(requestId: string, response: string): void {
    const request = this.inbound.get(requestId);
    if (!request) throw new Error("Codex input request is no longer pending");
    this.inbound.delete(requestId);
    let result: Record<string, unknown>;
    if (request.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(request.params.questions) ? request.params.questions as Json[] : [];
      result = {
        answers: Object.fromEntries(questions
          .filter((question) => typeof question.id === "string")
          .map((question) => [question.id, { answers: [response] }])),
      };
    } else if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      const decision = response === "once" ? "accept" : response === "session" || response === "always" ? "acceptForSession" : "decline";
      result = { decision };
    } else {
      throw new Error(`unsupported Codex response method ${request.method}`);
    }
    this.write({ jsonrpc: "2.0", id: request.id, result });
  }

  close(): void { this.child.kill("SIGTERM"); }

  private request(method: string, params: Json): Promise<Json> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Json): void { this.write({ jsonrpc: "2.0", method, params }); }
  private write(frame: Json): void {
    if (this.failed || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private consume(chunk: string): void {
    this.stdout += chunk;
    let newline: number;
    while ((newline = this.stdout.indexOf("\n")) >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      try { this.frame(JSON.parse(line) as Json); }
      catch { /* app-server stdout is protocol-only; ignore malformed frames */ }
    }
  }

  private frame(frame: Json): void {
    if (frame.method && frame.id !== undefined) {
      const request: InboundRequest = {
        id: frame.id as string | number,
        method: String(frame.method),
        params: frame.params && typeof frame.params === "object" ? frame.params as Json : {},
      };
      const requestId = `codex:${String(frame.id)}`;
      const supported = request.method === "item/tool/requestUserInput"
        || request.method === "item/commandExecution/requestApproval"
        || request.method === "item/fileChange/requestApproval";
      if (!supported) {
        this.write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Glass does not support Codex server request ${request.method}` },
        });
        return;
      }
      this.inbound.set(requestId, request);
      const kind = request.method === "item/tool/requestUserInput" ? "input.required" : "approval.required";
      this.onEvent(kind, { ...request.params, requestId, method: request.method });
      return;
    }
    if (typeof frame.id === "number") {
      const request = this.pending.get(frame.id);
      if (!request) return;
      this.pending.delete(frame.id);
      if (frame.error) request.reject(new Error(String(frame.error.message || "Codex app-server RPC failed")));
      else request.resolve((frame.result || {}) as Json);
      return;
    }
    if (typeof frame.method !== "string") return;
    const params = frame.params && typeof frame.params === "object" ? frame.params as Json : {};
    switch (frame.method) {
      case "turn/started": {
        const turn = params.turn as Json | undefined;
        if (turn && typeof turn.id === "string") this.activeTurnId = turn.id;
        this.onEvent("assistant.start", params);
        break;
      }
      case "item/agentMessage/delta":
        if (typeof params.delta === "string") this.onEvent("assistant.delta", { text: params.delta });
        break;
      case "thread/tokenUsage/updated":
        this.onEvent("usage", (params.tokenUsage && typeof params.tokenUsage === "object" ? params.tokenUsage : params) as Record<string, unknown>);
        break;
      case "turn/completed": {
        const turn = params.turn as Json | undefined;
        this.onEvent("assistant.complete", params);
        const status = typeof turn?.status === "string" ? turn.status : "completed";
        this.finishTurn(status === "failed" ? new Error(String(turn?.error?.message || "Codex turn failed")) : undefined);
        break;
      }
      case "item/started":
      case "item/completed":
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.onEvent("tool", { method: frame.method, ...params });
        break;
      default:
        if (frame.method.startsWith("turn/") || frame.method.startsWith("thread/")) {
          this.onEvent("status", { method: frame.method, ...params });
        }
    }
  }

  private finishTurn(error?: Error): void {
    const resolve = this.turnResolve;
    const reject = this.turnReject;
    this.turnResolve = null;
    this.turnReject = null;
    this.activeTurnId = "";
    if (error) reject?.(error);
    else resolve?.();
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.finishTurn(error);
  }

  private async withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), 10_000);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }
}
