/**
 * agent (worker) entrypoint. Two modes, which can run together:
 *
 *   --listen <sock>                          M1 local loop: serve clients directly
 *   --hub <ws-url> --device-id <id> --name … M2: register with a Hub and bridge
 *
 * Both bridge down to sessiond over --sessiond. Meant to be launched (and
 * blue/green-swapped) by the supervisor; runnable by hand and for the tests.
 */
import { writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { startAgent } from "./relay.js";
import { startHubLink } from "./hub-link.js";
import { loadOrCreateSigner } from "./keystore.js";

/** Detect the Etch CLI (detected, never managed — plan §0). */
function detectEtch(): { present: boolean; version?: string } {
  try {
    const r = spawnSync(process.env["GLASS_ETCH_BIN"] || "etch", ["--version"], { encoding: "utf8", timeout: 5000 });
    if (r.error) return { present: false };
    const line = (r.stdout || r.stderr || "").trim().split("\n")[0]?.trim();
    return line ? { present: true, version: line } : { present: true };
  } catch {
    return { present: false };
  }
}

/** Report supervised-worker status on fd 3 (a pipe the supervisor reads). Best-effort. */
function statusLine(supervised: boolean, line: string): void {
  if (!supervised) return;
  try {
    writeSync(3, line + "\n");
  } catch {
    /* fd 3 not present */
  }
}

interface Args {
  sessiond: string;
  listen: string | null;
  hub: string | null;
  deviceId: string;
  name: string;
  key: string | null;
  supervised: boolean;
}

function parseArgs(argv: string[]): Args {
  let sessiond = "";
  let listen: string | null = null;
  let hub: string | null = null;
  let deviceId = "";
  let name = "";
  let key: string | null = null;
  let supervised = false;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--sessiond": sessiond = argv[++i] ?? ""; break;
      case "--listen": listen = argv[++i] ?? ""; break;
      case "--hub": hub = argv[++i] ?? ""; break;
      case "--device-id": deviceId = argv[++i] ?? ""; break;
      case "--name": name = argv[++i] ?? ""; break;
      case "--key": key = argv[++i] ?? ""; break;
      case "--supervised": supervised = true; break;
    }
  }
  if (!sessiond) throw new Error("usage: agent --sessiond <path> (--listen <sock> | --hub <url> --device-id <id> [--name <name>] [--key <path>] [--supervised])");
  if (!listen && !hub) throw new Error("agent needs at least one of --listen or --hub");
  if (hub && !deviceId) throw new Error("--hub requires --device-id");
  return { sessiond, listen, hub, deviceId, name: name || deviceId, key, supervised };
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
    const signer = args.key ? await loadOrCreateSigner(args.key, args.deviceId) : undefined;
    const link = await startHubLink({
      sessiondPath: args.sessiond,
      hubUrl: args.hub,
      deviceId: args.deviceId,
      deviceName: args.name,
      etch: detectEtch(),
      ...(signer ? { signer } : {}),
      onRegistered: () => statusLine(args.supervised, "READY"),
      onSessiondClosed: () => {
        statusLine(args.supervised, "FAILED sessiond-closed");
        console.error("agent: sessiond connection closed; exiting");
        process.exit(0);
      },
    });

    if (args.supervised) {
      // Newline commands from the supervisor on stdin (protocol-free).
      let buf = "";
      process.stdin.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const cmd = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (cmd === "standby") link.standby();
          else if (cmd === "resume") link.resume();
          else if (cmd === "drain") void link.close().then(() => process.exit(0));
        }
      });
      process.stdin.resume();
    }
    console.error(`agent: hub mode as ${args.deviceId}, bridging ${args.hub} <-> ${args.sessiond} (pid ${process.pid})`);
  }
}

main().catch((err) => {
  console.error("agent: fatal:", err);
  process.exit(1);
});
