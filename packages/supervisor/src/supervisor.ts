/**
 * Supervisor — the lifecycle tier (plan §3, §4). Spawns and monitors sessiond
 * and the worker, and performs the blue/green worker swap: standby blue, spawn
 * green, health-check green (it must reach sessiond AND complete the
 * authenticated hub handshake before writing READY), and only THEN retire blue.
 * If green fails, blue is resumed — it was never actually torn down, so it is
 * the instant rollback. Sessions are untouched throughout: PTY fds live in
 * sessiond, which is not part of the swap.
 */
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "./proc.js";

export interface SupervisorOptions {
  runDir: string;
  sessiondEntry: string;
  workerEntry: string;
  workerArgs: string[];
  healthTimeoutMs?: number;
}

export class Supervisor {
  private sessiond: ChildProcess | null = null;
  private worker: Worker | null = null;
  private generation = 0;
  private lastSkew: string | null = null;
  private lastSwapAt = 0;
  private readonly sessiondSocket: string;

  constructor(private readonly opts: SupervisorOptions) {
    this.sessiondSocket = `${opts.runDir}/sd.sock`;
  }

  async start(): Promise<void> {
    mkdirSync(this.opts.runDir, { recursive: true, mode: 0o700 });
    await this.startSessiond();
    this.worker = this.spawn(this.opts.workerEntry);
    await this.worker.waitReady(this.opts.healthTimeoutMs ?? 10_000);
    this.writeCurrent(this.opts.workerEntry);
  }

  /** Blue/green swap to a new worker entry. Progress lines are externally observable. */
  async swap(newEntry: string, progress: (line: string) => void): Promise<void> {
    if (!this.worker) throw new Error("supervisor not started");
    const blue = this.worker;

    blue.send("standby"); // reversible — blue keeps serving, just stops reconnecting
    progress("standby");

    const green = this.spawn(newEntry);
    progress(`spawned gen${green.generation}`);
    try {
      await green.waitReady(this.opts.healthTimeoutMs ?? 10_000); // health BEFORE retire
    } catch (err) {
      green.kill("SIGKILL");
      blue.send("resume"); // rollback: blue re-registers within ~250ms
      progress(`failed ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    progress("ready");

    // Green is healthy and has taken over hub routing (its registration evicted
    // blue's). Only now retire blue.
    this.worker = green;
    this.writeCurrent(newEntry);
    this.lastSwapAt = Date.now();
    blue.send("drain");
    void (async () => {
      await sleep(5000);
      blue.kill("SIGTERM");
      await sleep(2000);
      blue.kill("SIGKILL");
    })();
    progress("retired");
    progress("ok");
  }

  status(): Record<string, unknown> {
    return {
      sessiond: { pid: this.sessiond?.pid ?? null, socket: this.sessiondSocket },
      worker: { pid: this.worker?.pid ?? null, entry: this.worker?.entry ?? null, generation: this.worker?.generation ?? 0 },
      lastSkew: this.lastSkew,
      lastSwapAt: this.lastSwapAt,
    };
  }

  async stop(): Promise<void> {
    this.worker?.kill("SIGTERM");
    try {
      this.sessiond?.kill("SIGTERM");
    } catch {
      /* gone */
    }
    await sleep(100);
  }

  private spawn(entry: string): Worker {
    this.generation += 1;
    const args = [...this.opts.workerArgs, "--sessiond", this.sessiondSocket, "--supervised"];
    return new Worker(entry, args, this.generation, (line) => {
      if (line.startsWith("SKEW")) this.lastSkew = line;
    });
  }

  private async startSessiond(): Promise<void> {
    this.sessiond = spawn("node", [this.opts.sessiondEntry, "--socket", this.sessiondSocket], { stdio: ["ignore", "inherit", "inherit"] });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await this.probe()) return;
      await sleep(50);
    }
    throw new Error("sessiond did not become reachable");
  }

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.connect(this.sessiondSocket);
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
  }

  private writeCurrent(entry: string): void {
    writeFileSync(`${this.opts.runDir}/current.json`, JSON.stringify({ entry, args: this.opts.workerArgs, generation: this.generation }, null, 2), { mode: 0o600 });
  }
}
