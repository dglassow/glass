/**
 * sessiond entrypoint.
 *
 *   node dist/main.js --socket /tmp/glass-<uid>/sd.sock
 *
 * Owns PTYs and exposes them over a Unix domain socket. Meant to be launched by
 * the supervisor; runnable by hand for development and the M1 acceptance test.
 */
import { mkdirSync, rmSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createSessiondServer } from "./server.js";
import { ensureSpawnHelper } from "./spawn-helper.js";

function parseArgs(argv: string[]): { socket: string } {
  let socket = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--socket") socket = argv[++i] ?? "";
  }
  if (!socket) {
    throw new Error("usage: sessiond --socket <path>");
  }
  return { socket };
}

function main(): void {
  const { socket } = parseArgs(process.argv.slice(2));

  // AF_UNIX paths are capped (~104 bytes on macOS); fail loudly, not at bind.
  if (Buffer.byteLength(socket) >= 104) {
    throw new Error(`socket path too long for AF_UNIX (${Buffer.byteLength(socket)} bytes): ${socket}`);
  }

  ensureSpawnHelper();

  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  rmSync(socket, { force: true }); // clear a stale socket from a prior crash

  const sd = createSessiondServer();
  sd.server.on("error", (err) => {
    console.error("sessiond: server error:", err);
    process.exit(1);
  });
  sd.server.listen(socket, () => {
    chmodSync(socket, 0o600);
    console.error(`sessiond: listening on ${socket} (pid ${process.pid})`);
  });

  const shutdown = (): void => {
    void sd.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
