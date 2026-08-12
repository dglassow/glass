/**
 * Chat session provider (plan §1, §5). Each user message is one non-interactive
 * `etch -z` invocation; the returned assistant text is rendered into the same
 * output/scrollback stream a PTY uses, so a Viewer (or the chat-only PWA) drives
 * it over the identical session protocol. No service, no API, no callback.
 *
 * Messages are serialized: a new message queues behind the in-flight etch call.
 */
import { randomUUID } from "node:crypto";
import { SessionId, type DeviceId } from "@glass/protocol";
import type { OutputChunk, ExitInfo } from "./pty.js";
import type { Session } from "./session.js";
import { runEtch } from "./etch.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class ChatSession implements Session {
  readonly id: SessionId;
  readonly kind = "chat" as const;
  readonly deviceId: DeviceId;
  readonly title = "chat";
  readonly createdAt: number;

  private seq = 0;
  private readonly ring: OutputChunk[] = [];
  private ringBytes = 0;
  private readonly maxBytes: number;
  private _alive = true;
  private _exit: ExitInfo | null = null;
  private readonly chunkListeners = new Set<(c: OutputChunk) => void>();
  private readonly exitListeners = new Set<(e: ExitInfo) => void>();
  private readonly queue: string[] = [];
  private busy = false;

  constructor(opts: { deviceId: DeviceId; maxBytes?: number }) {
    this.id = SessionId.parse(randomUUID());
    this.deviceId = opts.deviceId;
    this.createdAt = Date.now();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.emit("\x1b[2mchat session — each message runs etch\x1b[0m\r\n");
  }

  write(message: string): void {
    const msg = message.replace(/[\r\n]+$/, "");
    if (!msg || !this._alive) return;
    this.queue.push(msg);
    if (!this.busy) void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    while (this.queue.length && this._alive) {
      const msg = this.queue.shift() as string;
      this.emit(`\r\n\x1b[36myou:\x1b[0m ${msg}\r\n`);
      try {
        const reply = await runEtch(msg);
        this.emit(`\x1b[35metch:\x1b[0m ${reply.replace(/\n/g, "\r\n")}\r\n`);
      } catch (err) {
        this.emit(`\r\n\x1b[31m[chat error: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\r\n`);
      }
    }
    this.busy = false;
  }

  private emit(data: string): void {
    const chunk: OutputChunk = { seq: ++this.seq, data };
    this.ring.push(chunk);
    this.ringBytes += Buffer.byteLength(data, "utf8");
    while (this.ringBytes > this.maxBytes && this.ring.length > 1) {
      const dropped = this.ring.shift();
      if (dropped) this.ringBytes -= Buffer.byteLength(dropped.data, "utf8");
    }
    for (const listener of this.chunkListeners) listener(chunk);
  }

  get alive(): boolean {
    return this._alive;
  }
  get exit(): ExitInfo | null {
    return this._exit;
  }
  get lastSeq(): number {
    return this.seq;
  }
  scrollback(): string {
    let out = "";
    for (const chunk of this.ring) out += chunk.data;
    return out;
  }
  resize(): void {
    /* chat has no geometry */
  }
  kill(): void {
    if (!this._alive) return;
    this._alive = false;
    this._exit = { exitCode: 0, signal: null };
    for (const listener of this.exitListeners) listener(this._exit);
  }
  subscribe(onChunk: (c: OutputChunk) => void, onExit: (e: ExitInfo) => void): () => void {
    this.chunkListeners.add(onChunk);
    this.exitListeners.add(onExit);
    return () => {
      this.chunkListeners.delete(onChunk);
      this.exitListeners.delete(onExit);
    };
  }
}
