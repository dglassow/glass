/**
 * A single PTY-backed session. The daemon owns the master fd for the child's
 * entire life — this is what lets the worker be killed and restarted without
 * the shell noticing.
 *
 * Output is drained continuously, even with no subscriber attached, into a
 * bounded ring. That is the load-bearing behavior: output produced while the
 * worker is down is buffered rather than lost, and the kernel PTY buffer never
 * fills and blocks the child. `seq` is assigned here and never resets, so a
 * reattaching viewer can tell continuous output from a gap.
 */
import { spawn, type IPty } from "node-pty";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { SessionId, type DeviceId } from "@glass/protocol";

export interface OutputChunk {
  readonly seq: number;
  readonly data: string;
}

export interface ExitInfo {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

type ChunkListener = (chunk: OutputChunk) => void;
type ExitListener = (exit: ExitInfo) => void;

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB of scrollback per session

export class PtySession {
  readonly id: SessionId;
  readonly kind = "pty" as const;
  readonly deviceId: DeviceId;
  readonly title: string;
  readonly createdAt: number;

  private readonly pty: IPty;
  private seq = 0;
  private readonly ring: OutputChunk[] = [];
  private ringBytes = 0;
  private readonly maxBytes: number;

  private _alive = true;
  private _exit: ExitInfo | null = null;

  private readonly chunkListeners = new Set<ChunkListener>();
  private readonly exitListeners = new Set<ExitListener>();

  constructor(opts: {
    deviceId: DeviceId;
    cwd?: string;
    cols: number;
    rows: number;
    maxBytes?: number;
  }) {
    this.id = SessionId.parse(randomUUID());
    this.deviceId = opts.deviceId;
    this.createdAt = Date.now();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

    const shell = process.env["SHELL"] ?? "/bin/bash";
    this.title = basename(shell);

    // Clean env: node-pty wants string values, process.env is string|undefined.
    const env: { [key: string]: string } = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }

    this.pty = spawn(shell, [], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? env["HOME"] ?? process.cwd(),
      env,
    });

    this.pty.onData((data) => this.ingest(data));
    this.pty.onExit(({ exitCode, signal }) =>
      this.finish(exitCode, signal === undefined ? null : String(signal)),
    );
  }

  private ingest(data: string): void {
    const chunk: OutputChunk = { seq: ++this.seq, data };
    this.ring.push(chunk);
    this.ringBytes += Buffer.byteLength(data, "utf8");
    // Evict whole chunks (never a partial one) so a replayed buffer is never
    // severed through a multibyte codepoint. Always keep at least the newest.
    while (this.ringBytes > this.maxBytes && this.ring.length > 1) {
      const dropped = this.ring.shift();
      if (dropped) this.ringBytes -= Buffer.byteLength(dropped.data, "utf8");
    }
    for (const listener of this.chunkListeners) listener(chunk);
  }

  private finish(exitCode: number | null, signal: string | null): void {
    this._alive = false;
    this._exit = { exitCode, signal };
    for (const listener of this.exitListeners) listener(this._exit);
  }

  get alive(): boolean {
    return this._alive;
  }

  get exit(): ExitInfo | null {
    return this._exit;
  }

  /** Sequence number of the most recent output chunk (0 before any output). */
  get lastSeq(): number {
    return this.seq;
  }

  /** Everything currently retained, concatenated, for replay on attach. */
  scrollback(): string {
    let out = "";
    for (const chunk of this.ring) out += chunk.data;
    return out;
  }

  write(data: string): void {
    if (this._alive) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this._alive) this.pty.resize(cols, rows);
  }

  kill(): void {
    if (this._alive) this.pty.kill();
  }

  /** Register a live subscriber. Returns an unsubscribe function. */
  subscribe(onChunk: ChunkListener, onExit: ExitListener): () => void {
    this.chunkListeners.add(onChunk);
    this.exitListeners.add(onExit);
    return () => {
      this.chunkListeners.delete(onChunk);
      this.exitListeners.delete(onExit);
    };
  }
}
