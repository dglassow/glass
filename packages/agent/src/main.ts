/**
 * agent (worker) entrypoint.
 *
 *   node dist/main.js --sessiond /tmp/glass-<uid>/sd.sock --listen /tmp/glass-<uid>/agent.sock
 *
 * Meant to be launched (and blue/green-swapped) by the supervisor; runnable by
 * hand for development and the M1 acceptance test.
 */
import { startAgent } from "./relay.js";

function parseArgs(argv: string[]): { sessiond: string; listen: string } {
  let sessiond = "";
  let listen = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sessiond") sessiond = argv[++i] ?? "";
    else if (argv[i] === "--listen") listen = argv[++i] ?? "";
  }
  if (!sessiond || !listen) {
    throw new Error("usage: agent --sessiond <path> --listen <path>");
  }
  return { sessiond, listen };
}

async function main(): Promise<void> {
  const { sessiond, listen } = parseArgs(process.argv.slice(2));
  await startAgent({
    sessiondPath: sessiond,
    listenPath: listen,
    onSessiondClosed: () => {
      console.error("agent: sessiond connection closed; exiting");
      process.exit(0);
    },
  });
  console.error(`agent: listening on ${listen}, relaying to ${sessiond} (pid ${process.pid})`);
}

main().catch((err) => {
  console.error("agent: fatal:", err);
  process.exit(1);
});
