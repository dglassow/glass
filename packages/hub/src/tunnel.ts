/**
 * Reverse-tunnel keeper (plan §2/§4). The hub dials OUT to the relay VPS and
 * holds a reverse forward of the VPS's :443 down to the hub's local TLS
 * listener, so an off-tailnet spoke can reach the hub. The VPS runs stock sshd
 * and never sees plaintext. This just keeps the tunnel process alive with
 * capped backoff; the command is injectable so tests exercise the same path
 * with a stand-in instead of real sshd.
 *
 *   production:  ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
 *                    -R 0.0.0.0:443:127.0.0.1:<hub-tls-port> tunnel@<relay>
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface TunnelOptions {
  command: string;
  args: string[];
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onSpawn?: (pid: number) => void;
}

export class TunnelKeeper {
  private cp: ChildProcess | null = null;
  private stopped = false;
  private backoff: number;

  constructor(private readonly opts: TunnelOptions) {
    this.backoff = opts.minBackoffMs ?? 250;
  }

  start(): void {
    this.spawn();
  }

  private spawn(): void {
    if (this.stopped) return;
    const cp = spawn(this.opts.command, this.opts.args, { stdio: ["ignore", "inherit", "inherit"] });
    this.cp = cp;
    if (cp.pid) this.opts.onSpawn?.(cp.pid);
    const settle = setTimeout(() => {
      if (this.cp === cp) this.backoff = this.opts.minBackoffMs ?? 250;
    }, 10_000);
    cp.once("exit", () => {
      clearTimeout(settle);
      if (this.stopped) return;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 5000);
      setTimeout(() => this.spawn(), delay);
    });
    cp.once("error", () => {
      /* exit follows / respawn handles it */
    });
  }

  stop(): void {
    this.stopped = true;
    try {
      this.cp?.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
}
