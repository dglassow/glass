/**
 * Supervisor control socket — a protocol-free, newline-text Unix socket.
 *   status            -> one JSON line of process state
 *   swap <entry.js>   -> progress lines (standby, spawned, ready, retired, ok)
 *                        or (standby, spawned, failed <reason>) on rollback
 */
import net from "node:net";
import { rmSync, chmodSync } from "node:fs";
import type { Supervisor } from "./supervisor.js";

export function startControlSocket(sup: Supervisor, path: string): net.Server {
  rmSync(path, { force: true });
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        void handle(line, socket, sup);
      }
    });
    socket.on("error", () => {});
  });
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  });
  return server;
}

async function handle(line: string, socket: net.Socket, sup: Supervisor): Promise<void> {
  if (line === "status") {
    socket.write(JSON.stringify(sup.status()) + "\n");
    return;
  }
  if (line.startsWith("swap ")) {
    const entry = line.slice(5).trim();
    try {
      await sup.swap(entry, (p) => socket.write(p + "\n"));
    } catch {
      /* swap() already emitted a `failed <reason>` progress line */
    }
    return;
  }
  socket.write("error unknown command\n");
}
