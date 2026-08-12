/**
 * supervisor entrypoint.
 *
 *   node dist/main.js --run-dir <dir> --sessiond-entry <sessiond/dist/main.js> \
 *     --worker-entry <agent/dist/main.js> [--health-timeout-ms <n>] -- <worker args...>
 *
 * The supervisor owns the sessiond socket (`<run-dir>/sd.sock`) and injects
 * `--sessiond <sock> --supervised` into the worker; pass the rest (--hub,
 * --device-id, --key, …) after `--`.
 */
import { Supervisor } from "./supervisor.js";
import { startControlSocket } from "./control.js";

function parseArgs(argv: string[]): {
  runDir: string;
  sessiondEntry: string;
  workerEntry: string;
  workerArgs: string[];
  healthTimeoutMs?: number;
} {
  const dd = argv.indexOf("--");
  const before = dd < 0 ? argv : argv.slice(0, dd);
  const workerArgs = dd < 0 ? [] : argv.slice(dd + 1);
  const flag = (n: string): string | undefined => {
    const i = before.indexOf(n);
    return i >= 0 ? before[i + 1] : undefined;
  };
  const runDir = flag("--run-dir");
  const sessiondEntry = flag("--sessiond-entry");
  const workerEntry = flag("--worker-entry");
  const health = flag("--health-timeout-ms");
  if (!runDir || !sessiondEntry || !workerEntry) {
    throw new Error("usage: supervisor --run-dir <dir> --sessiond-entry <path> --worker-entry <path> -- <worker args>");
  }
  return { runDir, sessiondEntry, workerEntry, workerArgs, ...(health !== undefined ? { healthTimeoutMs: Number(health) } : {}) };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const supervisor = new Supervisor(opts);
  await supervisor.start();
  const control = startControlSocket(supervisor, `${opts.runDir}/supervisor.sock`);
  console.error(`supervisor: up (pid ${process.pid}); control at ${opts.runDir}/supervisor.sock`);

  const shutdown = (): void => {
    control.close();
    void supervisor.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("supervisor: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
