/**
 * hub entrypoint.
 *
 *   node dist/main.js --listen 127.0.0.1:0
 *
 * Prints the bound URL to stderr so a supervisor (or the acceptance test) can
 * discover the ephemeral port.
 */
import { startHubServer } from "./server.js";

function parseArgs(argv: string[]): { host: string; port: number } {
  let listen = "127.0.0.1:0";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--listen") listen = argv[++i] ?? listen;
  }
  const idx = listen.lastIndexOf(":");
  const host = idx >= 0 ? listen.slice(0, idx) : "127.0.0.1";
  const port = idx >= 0 ? Number(listen.slice(idx + 1)) : 0;
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --listen ${listen}`);
  }
  return { host: host || "127.0.0.1", port };
}

async function main(): Promise<void> {
  const { host, port } = parseArgs(process.argv.slice(2));
  const hub = await startHubServer({ host, port });
  console.error(`hub: listening on ${hub.url} (pid ${process.pid})`);

  const shutdown = (): void => {
    void hub.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("hub: fatal:", err);
  process.exit(1);
});
