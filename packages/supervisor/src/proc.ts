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
  private sessiondReady = false;
  private failure: string | null = null;
  private waiters: Array<{ acceptSessiond: boolean; res: () => void; rej: (e: Error) => void }> = [];
  private buf = "";

  constructor(
    readonly entry: string,
    readonly args: string[],
    readonly generation: number,
    private readonly onStatus?: (line: string) => void,
  ) {
    this.cp = spawn(process.execPath, [entry, ...args], { stdio: ["pipe", "inherit", "inherit", "pipe"] });
    this.cp.stdin?.on("error", () => {
      /* the worker may exit between a liveness check and a control write */
    });
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
      } else if (line === "SESSIOND_READY") {
        this.sessiondReady = true;
        const accepted = this.waiters.filter((w) => w.acceptSessiond);
        this.waiters = this.waiters.filter((w) => !w.acceptSessiond);
        for (const w of accepted) w.res();
      } else if (line.startsWith("FAILED")) {
        this.failure = line;
        for (const w of this.waiters) w.rej(new Error(line));
        this.waiters = [];
      }
    }
  }

  waitReady(timeoutMs: number, acceptSessiond = false): Promise<void> {
    if (this.ready || (acceptSessiond && this.sessiondReady)) return Promise.resolve();
    if (this.failure) return Promise.reject(new Error(this.failure));
    return new Promise<void>((res, rej) => {
      const waiter = {
        acceptSessiond,
        res: (): void => {
          clearTimeout(timer);
          res();
        },
        rej: (e: Error): void => {
          clearTimeout(timer);
          rej(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        rej(new Error("health-check timeout"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  send(cmd: string): void {
    this.cp.stdin?.write(cmd + "\n");
  }
  get pid(): number | undefined {
    return this.cp.pid;
  }
  get running(): boolean {
    return this.cp.exitCode === null && this.cp.signalCode === null;
  }
  kill(sig: NodeJS.Signals = "SIGTERM"): void {
    try {
      this.cp.kill(sig);
    } catch {
      /* already gone */
    }
  }
}
