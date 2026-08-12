/**
 * agent (worker) entrypoint. Two modes, which can run together:
 *
 *   --listen <sock>                          M1 local loop: serve clients directly
 *   --hub <ws-url> --device-id <id> --name … M2: register with a Hub and bridge
 *
 * Both bridge down to sessiond over --sessiond. Meant to be launched (and
 * blue/green-swapped) by the supervisor; runnable by hand and for the tests.
 */
import { startAgent } from "./relay.js";
import { startHubLink } from "./hub-link.js";

interface Args {
  sessiond: string;
  listen: string | null;
  hub: string | null;
  deviceId: string;
  name: string;
}

function parseArgs(argv: string[]): Args {
  let sessiond = "";
  let listen: string | null = null;
  let hub: string | null = null;
  let deviceId = "";
  let name = "";
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--sessiond": sessiond = argv[++i] ?? ""; break;
      case "--listen": listen = argv[++i] ?? ""; break;
      case "--hub": hub = argv[++i] ?? ""; break;
      case "--device-id": deviceId = argv[++i] ?? ""; break;
      case "--name": name = argv[++i] ?? ""; break;
    }
  }
  if (!sessiond) throw new Error("usage: agent --sessiond <path> (--listen <sock> | --hub <url> --device-id <id> [--name <name>])");
  if (!listen && !hub) throw new Error("agent needs at least one of --listen or --hub");
  if (hub && !deviceId) throw new Error("--hub requires --device-id");
  return { sessiond, listen, hub, deviceId, name: name || deviceId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.listen) {
    await startAgent({
      sessiondPath: args.sessiond,
      listenPath: args.listen,
      onSessiondClosed: () => {
        console.error("agent: sessiond connection closed; exiting");
        process.exit(0);
      },
    });
    console.error(`agent: listening on ${args.listen}, relaying to ${args.sessiond} (pid ${process.pid})`);
  }

  if (args.hub) {
    await startHubLink({
      sessiondPath: args.sessiond,
      hubUrl: args.hub,
      deviceId: args.deviceId,
      deviceName: args.name,
      onSessiondClosed: () => {
        console.error("agent: sessiond connection closed; exiting");
        process.exit(0);
      },
    });
    console.error(`agent: hub mode as ${args.deviceId}, bridging ${args.hub} <-> ${args.sessiond} (pid ${process.pid})`);
  }
}

main().catch((err) => {
  console.error("agent: fatal:", err);
  process.exit(1);
});
