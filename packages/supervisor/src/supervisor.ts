/**
 * Supervisor — the lifecycle tier (plan §3, §4). Spawns and monitors sessiond
 * and the worker, and performs the blue/green worker swap: standby blue, spawn
 * green, health-check green (it must reach sessiond AND complete the
 * authenticated hub handshake before writing READY), and only THEN retire blue.
 * If green fails, blue is resumed — it was never actually torn down, so it is
 * the instant rollback. Outside a swap, an unexpected worker exit is restarted
 * against the surviving sessiond; a sessiond exit replaces both processes.
 * Sessions are untouched by worker recovery because PTY fds live in sessiond.
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
  /** Initial/recovery start may accept a live sessiond link before Hub trust is
   * granted. Blue/green swaps always require full authenticated READY. */
  allowUnregisteredStart?: boolean;
}

export class Supervisor {
  private sessiond: ChildProcess | null = null;
  private worker: Worker | null = null;
  private generation = 0;
  private lastSkew: string | null = null;
  private lastSwapAt = 0;
  private started = false;
  private stopping = false;
  private swapping = false;
  private swapCandidate: Worker | null = null;
  private recovery: Promise<void> | null = null;
  private recoveryReason: string | null = null;
  private workerRestarts = 0;
  private sessiondRestarts = 0;
  private desiredWorkerEntry: string;
  private readonly sessiondSocket: string;

  constructor(private readonly opts: SupervisorOptions) {
    this.sessiondSocket = `${opts.runDir}/sd.sock`;
    this.desiredWorkerEntry = opts.workerEntry;
  }

  async start(): Promise<void> {
    mkdirSync(this.opts.runDir, { recursive: true, mode: 0o700 });
    const sessiond = await this.launchSessiond();
    this.adoptSessiond(sessiond);
    const worker = this.spawn(this.desiredWorkerEntry);
    this.adoptWorker(worker);
    try {
      await worker.waitReady(this.healthTimeoutMs, this.opts.allowUnregisteredStart);
      if (!worker.running) throw new Error(`worker gen${worker.generation} exited after reporting ready`);
      this.started = true;
      this.writeCurrent(this.desiredWorkerEntry);
    } catch (err) {
      this.worker = null;
      this.sessiond = null;
      worker.kill("SIGKILL");
      sessiond.kill("SIGTERM");
      throw err;
    }
  }

  /** Blue/green swap to a new worker entry. Progress lines are externally observable. */
  async swap(newEntry: string, progress: (line: string) => void): Promise<void> {
    if (!this.worker || !this.started) throw new Error("supervisor not started");
    if (this.recovery || this.swapping) throw new Error("supervisor is busy recovering or swapping");
    const blue = this.worker;
    this.swapping = true;

    blue.send("standby"); // reversible — blue keeps serving, just stops reconnecting
    progress("standby");

    const green = this.spawn(newEntry);
    this.swapCandidate = green;
    progress(`spawned gen${green.generation}`);
    try {
      await green.waitReady(this.healthTimeoutMs); // health BEFORE retire
      if (this.stopping) throw new Error("supervisor is stopping");
      if (!green.running) throw new Error(`worker gen${green.generation} exited after reporting ready`);
    } catch (err) {
      this.swapCandidate = null;
      green.kill("SIGKILL");
      if (this.worker === blue && blue.running) blue.send("resume"); // rollback: blue re-registers within ~250ms
      progress(`failed ${err instanceof Error ? err.message : String(err)}`);
      this.swapping = false;
      if (!this.worker) this.scheduleRecovery("worker-exit-during-swap");
      throw err;
    }
    progress("ready");

    // Green is healthy and has taken over hub routing (its registration evicted
    // blue's). Only now retire blue.
    this.swapCandidate = null;
    this.adoptWorker(green);
    this.desiredWorkerEntry = newEntry;
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
    this.swapping = false;
    if (!this.worker) this.scheduleRecovery("worker-exit-after-swap");
  }

  status(): Record<string, unknown> {
    return {
      sessiond: { pid: this.sessiond?.pid ?? null, socket: this.sessiondSocket, entry: this.opts.sessiondEntry },
      worker: { pid: this.worker?.pid ?? null, entry: this.worker?.entry ?? null, generation: this.worker?.generation ?? 0 },
      recovery: {
        active: this.recovery !== null,
        reason: this.recoveryReason,
        workerRestarts: this.workerRestarts,
        sessiondRestarts: this.sessiondRestarts,
      },
      lastSkew: this.lastSkew,
      lastSwapAt: this.lastSwapAt,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    const worker = this.worker;
    const swapCandidate = this.swapCandidate;
    const sessiond = this.sessiond;
    this.worker = null;
    this.swapCandidate = null;
    this.sessiond = null;
    worker?.kill("SIGTERM");
    swapCandidate?.kill("SIGTERM");
    try {
      sessiond?.kill("SIGTERM");
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

  private get healthTimeoutMs(): number {
    return this.opts.healthTimeoutMs ?? 10_000;
  }

  private adoptWorker(worker: Worker): void {
    this.worker = worker;
    let handled = false;
    const onExit = (): void => {
      if (handled) return;
      handled = true;
      if (this.worker !== worker) return; // retired blue or failed green
      this.worker = null;
      if (!this.started || this.stopping) return;
      this.workerRestarts += 1;
      if (!this.swapping) this.scheduleRecovery("worker-exit");
    };
    worker.cp.once("exit", onExit);
    if (!worker.running) queueMicrotask(onExit);
  }

  private adoptSessiond(sessiond: ChildProcess): void {
    this.sessiond = sessiond;
    let handled = false;
    const onExit = (): void => {
      if (handled) return;
      handled = true;
      if (this.sessiond !== sessiond) return;
      this.sessiond = null;
      const worker = this.worker;
      this.worker = null;
      worker?.kill("SIGTERM");
      if (!this.started || this.stopping) return;
      this.sessiondRestarts += 1;
      if (!this.swapping) this.scheduleRecovery("sessiond-exit");
    };
    sessiond.once("exit", onExit);
    if (sessiond.exitCode !== null || sessiond.signalCode !== null) queueMicrotask(onExit);
  }

  private scheduleRecovery(reason: string): void {
    if (this.stopping || !this.started) return;
    this.recoveryReason = reason;
    if (this.recovery) return;
    this.recovery = this.recover().finally(() => {
      this.recovery = null;
      if (!this.stopping && this.started && (!this.sessiond || !this.worker)) {
        this.scheduleRecovery(this.recoveryReason ?? "incomplete-recovery");
      } else {
        this.recoveryReason = null;
      }
    });
  }

  private async recover(): Promise<void> {
    let delayMs = 100;
    while (!this.stopping && this.started) {
      try {
        if (!this.sessiond) {
          const sessiond = await this.launchSessiond();
          if (this.stopping || !this.started) {
            sessiond.kill("SIGTERM");
            return;
          }
          this.adoptSessiond(sessiond);
        }
        if (this.stopping || !this.started) return;
        if (!this.worker) {
          const worker = this.spawn(this.desiredWorkerEntry);
          this.adoptWorker(worker);
          try {
            await worker.waitReady(this.healthTimeoutMs, this.opts.allowUnregisteredStart);
            if (!worker.running) throw new Error(`worker gen${worker.generation} exited after reporting ready`);
          } catch (err) {
            if (this.worker === worker) this.worker = null;
            worker.kill("SIGKILL");
            throw err;
          }
          this.writeCurrent(this.desiredWorkerEntry);
        }
        if (this.sessiond && this.worker) return;
      } catch (err) {
        console.error(`supervisor: recovery failed (${err instanceof Error ? err.message : String(err)}); retrying in ${delayMs}ms`);
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 5000);
      }
    }
  }

  private async launchSessiond(): Promise<ChildProcess> {
    const sessiond = spawn(process.execPath, [this.opts.sessiondEntry, "--socket", this.sessiondSocket], { stdio: ["ignore", "inherit", "inherit"] });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (sessiond.exitCode !== null || sessiond.signalCode !== null) {
        throw new Error(`sessiond exited before becoming reachable (code ${sessiond.exitCode ?? sessiond.signalCode})`);
      }
      if (await this.probe()) return sessiond;
      await sleep(50);
    }
    sessiond.kill("SIGKILL");
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
