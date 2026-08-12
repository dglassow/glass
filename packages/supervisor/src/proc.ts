/**
 * A supervised child worker. Spawned with fd 3 as a status pipe (the worker
 * writes READY / FAILED / SKEW lines) and stdin as a command channel (the
 * supervisor writes standby / resume / drain). Deliberately protocol-free — the
 * supervisor manages processes, not conversations.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export class Worker {
  readonly cp: ChildProcess;
  private ready = false;
  private failure: string | null = null;
  private waiters: Array<{ res: () => void; rej: (e: Error) => void }> = [];
  private buf = "";

  constructor(
    readonly entry: string,
    readonly args: string[],
    readonly generation: number,
    private readonly onStatus?: (line: string) => void,
  ) {
    this.cp = spawn("node", [entry, ...args], { stdio: ["pipe", "inherit", "inherit", "pipe"] });
    const status = this.cp.stdio[3] as Readable | null;
    status?.on("data", (d: Buffer) => this.ingest(d.toString("utf8")));
    this.cp.once("exit", (code) => {
      const err = new Error(`worker gen${this.generation} exited before ready (code ${code})`);
      for (const w of this.waiters) w.rej(err);
      this.waiters = [];
    });
  }

  private ingest(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      this.onStatus?.(line);
      if (line === "READY") {
        this.ready = true;
        for (const w of this.waiters) w.res();
        this.waiters = [];
      } else if (line.startsWith("FAILED")) {
        this.failure = line;
        for (const w of this.waiters) w.rej(new Error(line));
        this.waiters = [];
      }
    }
  }

  waitReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.failure) return Promise.reject(new Error(this.failure));
    return new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("health-check timeout")), timeoutMs);
      this.waiters.push({ res: () => (clearTimeout(timer), res()), rej: (e) => (clearTimeout(timer), rej(e)) });
    });
  }

  send(cmd: string): void {
    this.cp.stdin?.write(cmd + "\n");
  }
  get pid(): number | undefined {
    return this.cp.pid;
  }
  kill(sig: NodeJS.Signals = "SIGTERM"): void {
    try {
      this.cp.kill(sig);
    } catch {
      /* already gone */
    }
  }
}
