/**
 * hub entrypoint.
 *
 *   node dist/main.js --listen 127.0.0.1:0 --trust-store <path> [--enroll-ttl-ms <n>]
 *   node dist/main.js --listen 127.0.0.1:0 --open           # Phase 1 behavior, no auth
 *
 * Fail-closed: refuses to start with neither --trust-store nor --open.
 *
 * Bootstrap CLI (the marked M1 stand-in for the Q2 passkey/TOTP path):
 *   node dist/main.js trust add    --trust-store <p> --device-id <id> --name <n> --public-key <b64url> [--roles agent,viewer]
 *   node dist/main.js trust list   --trust-store <p>
 *   node dist/main.js trust remove --trust-store <p> --device-id <id>
 */
import { isValidPublicKey, DeviceRole } from "@glass/protocol";
import { startHubServer } from "./server.js";
import { FileTrustStore } from "./trust-store.js";
import { CredentialStore } from "./credential-store.js";
import { Passkey } from "./passkey.js";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function runTrustCli(argv: string[]): Promise<void> {
  const action = argv[0];
  const storePath = flag(argv, "--trust-store");
  if (!storePath) throw new Error("trust: --trust-store <path> is required");
  const store = new FileTrustStore(storePath);

  if (action === "add") {
    const deviceId = flag(argv, "--device-id");
    const name = flag(argv, "--name");
    const publicKey = flag(argv, "--public-key");
    const roles = (flag(argv, "--roles") ?? "agent").split(",").map((r) => DeviceRole.parse(r.trim()));
    if (!deviceId || !name || !publicKey) throw new Error("trust add: --device-id, --name, --public-key are required");
    if (!(await isValidPublicKey(publicKey))) throw new Error("trust add: --public-key is not a valid Ed25519 public key");
    const existing = store.get(deviceId);
    if (existing && existing.publicKey !== publicKey) {
      console.error(`trust add: ${deviceId} already exists with a different key; refuse to overwrite (remove it first)`);
      process.exit(1);
    }
    store.add(deviceId, { publicKey, name, roles, enrolledAt: Date.now(), approvedBy: "cli-bootstrap" });
    console.error(`trust add: ${deviceId} is now trusted`);
    return;
  }
  if (action === "list") {
    for (const d of store.list()) console.log(`${d.deviceId} ${d.publicKey} [${d.roles.join(",")}] ${d.name}`);
    return;
  }
  if (action === "remove") {
    const deviceId = flag(argv, "--device-id");
    if (!deviceId) throw new Error("trust remove: --device-id is required");
    console.error(store.remove(deviceId) ? `trust remove: ${deviceId} removed` : `trust remove: ${deviceId} not found`);
    return;
  }
  throw new Error(`trust: unknown action "${action ?? ""}" (expected add | list | remove)`);
}

async function runServer(argv: string[]): Promise<void> {
  const listen = flag(argv, "--listen") ?? "127.0.0.1:0";
  const open = argv.includes("--open");
  const storePath = flag(argv, "--trust-store");
  const enrollTtl = flag(argv, "--enroll-ttl-ms");

  if (!open && !storePath) {
    throw new Error("hub refuses to start: pass --trust-store <path> (auth enforced) or --open (Phase 1, no auth)");
  }

  const idx = listen.lastIndexOf(":");
  const host = idx >= 0 ? listen.slice(0, idx) || "127.0.0.1" : "127.0.0.1";
  const port = idx >= 0 ? Number(listen.slice(idx + 1)) : 0;
  if (!Number.isInteger(port) || port < 0) throw new Error(`invalid --listen ${listen}`);

  // Optional passkey bootstrap (plan §8.4).
  const credStorePath = flag(argv, "--cred-store");
  const registerToken = flag(argv, "--register-token");
  const rpID = flag(argv, "--rp-id") ?? "localhost";
  const rpName = flag(argv, "--rp-name") ?? "Glass Hub";
  const origin = flag(argv, "--origin") ?? `http://${rpID}`;
  const credentialConfig = credStorePath
    ? {
        credentialStore: new CredentialStore(credStorePath),
        passkey: new Passkey({ rpID, rpName, origin }),
        ...(registerToken !== undefined ? { registerToken } : {}),
      }
    : {};

  const hub = await startHubServer(
    open
      ? { host, port, mode: "open" }
      : {
          host,
          port,
          mode: "trust",
          trustStore: new FileTrustStore(storePath as string),
          ...(enrollTtl !== undefined ? { enrollTtlMs: Number(enrollTtl) } : {}),
          ...credentialConfig,
        },
  );
  console.error(`hub: listening on ${hub.url} (pid ${process.pid}, ${open ? "OPEN — no auth" : "trust mode"})`);
  if (credStorePath) console.error(`hub: passkey bootstrap enabled (rpID=${rpID})`);
  if (open) console.error("hub: WARNING running in --open mode; device-key auth is disabled");

  const shutdown = (): void => void hub.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "trust") await runTrustCli(argv.slice(1));
  else await runServer(argv);
}

main().catch((err) => {
  console.error("hub: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
