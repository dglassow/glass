/**
 * Client for the supervisor's control socket (see supervisor/src/control.ts).
 * After the updater has *verified and staged* a release, it asks the supervisor
 * to blue/green-swap the worker to the staged entry. The supervisor streams
 * progress lines and only retires the old worker once the new one passes its
 * health check — so a staged build that fails to come up rolls back on its own.
 */
import net from "node:net";

export interface SwapOutcome {
  ok: boolean;
  progress: string[];
  error?: string;
}

/** Send `swap <entry>` and collect progress until the socket closes. */
export function requestSwap(socketPath: string, entryPath: string, timeoutMs = 30_000): Promise<SwapOutcome> {
  return new Promise((resolve) => {
    const progress: string[] = [];
    let settled = false;
    const sock = net.connect(socketPath);
    const done = (o: SwapOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(o);
    };
    const timer = setTimeout(() => done({ ok: false, progress, error: "swap timed out" }), timeoutMs);

    let buf = "";
    sock.on("connect", () => sock.write(`swap ${entryPath}\n`));
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) progress.push(line);
        if (line === "ok") return done({ ok: true, progress });
        if (line.startsWith("failed ")) return done({ ok: false, progress, error: line.slice(7) });
        if (line.startsWith("error ")) return done({ ok: false, progress, error: line.slice(6) });
      }
    });
    sock.on("error", (e) => done({ ok: false, progress, error: e.message }));
    sock.on("close", () => done({ ok: progress[progress.length - 1] === "ok", progress }));
  });
}
