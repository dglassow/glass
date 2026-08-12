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
import { readFileSync } from "node:fs";
import { isValidPublicKey, DeviceRole } from "@glass/protocol";
import { startHubServer } from "./server.js";
import { FileTrustStore } from "./trust-store.js";
import { CredentialStore } from "./credential-store.js";
import { Passkey } from "./passkey.js";
import { Vault, VaultError } from "./vault/vault.js";
import { createBundle, restoreBundle } from "./vault/backup.js";
import { loadOrCreateHubSigner } from "./hub-key.js";
import { TunnelKeeper } from "./tunnel.js";
import { Updater, requestSwap } from "./updater/index.js";
import { GitStore } from "./git/git-store.js";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1] as string);
  return out;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Vault CLI (plan §9). Passphrases/recovery keys and secret values arrive on
 * STDIN, never argv/env — nothing lands in shell history or `ps` output.
 *   init:            line 1 = passphrase, line 2 = recovery key
 *   add/update:      line 1 = passphrase, remainder to EOF = value (verbatim)
 *   others:          line 1 = passphrase (or recovery key for check-recovery)
 */
function runVaultCli(argv: string[]): void {
  const action = argv[0];
  const dbPath = flag(argv, "--vault");
  if (!dbPath) throw new Error("vault: --vault <db> is required");
  const stdin = readStdin();
  const firstLine = (): string => stdin.split("\n")[0] ?? "";
  const afterFirstLine = (): string => {
    const nl = stdin.indexOf("\n");
    return nl < 0 ? "" : stdin.slice(nl + 1);
  };
  const name = (): string => {
    const n = flag(argv, "--name");
    if (!n) throw new Error("vault: --name is required");
    return n;
  };
  const openUnlocked = (): Vault => {
    const v = Vault.open(dbPath);
    if (!v.unlock(firstLine())) {
      v.close();
      process.stderr.write("vault unlock failed\n");
      process.exit(5);
    }
    return v;
  };

  try {
    switch (action) {
      case "init": {
        const lines = stdin.split("\n");
        Vault.init(dbPath, lines[0] ?? "", lines[1] ?? "").close();
        process.stderr.write("vault: initialized\n");
        break;
      }
      case "add": {
        const v = openUnlocked();
        const cls = flag(argv, "--class") === "personal" ? "personal" : "workflow";
        v.createSecret(name(), Buffer.from(afterFirstLine(), "utf8"), cls, flags(argv, "--tag"));
        v.close();
        break;
      }
      case "update": {
        const v = openUnlocked();
        v.updateSecret(name(), Buffer.from(afterFirstLine(), "utf8"));
        v.close();
        break;
      }
      case "remove": {
        const v = openUnlocked();
        v.removeSecret(name());
        v.close();
        break;
      }
      case "reveal": {
        const v = openUnlocked();
        const value = v.reveal(name());
        v.close();
        process.stdout.write(value);
        break;
      }
      case "list": {
        const v = openUnlocked();
        for (const s of v.list()) process.stdout.write(JSON.stringify(s) + "\n");
        v.close();
        break;
      }
      case "allow": {
        const v = openUnlocked();
        v.allow(name(), flag(argv, "--device-id") ?? "");
        v.close();
        break;
      }
      case "deny": {
        const v = openUnlocked();
        v.deny(name(), flag(argv, "--device-id") ?? "");
        v.close();
        break;
      }
      case "tag": {
        const v = openUnlocked();
        v.tag(name(), flag(argv, "--tag") ?? "");
        v.close();
        break;
      }
      case "untag": {
        const v = openUnlocked();
        v.untag(name(), flag(argv, "--tag") ?? "");
        v.close();
        break;
      }
      case "check-recovery": {
        const v = Vault.open(dbPath);
        const ok = v.checkRecovery(firstLine());
        v.close();
        process.exit(ok ? 0 : 1);
        break;
      }
      case "audit": {
        const v = Vault.open(dbPath);
        for (const row of v.auditRows()) process.stdout.write(JSON.stringify(row) + "\n");
        v.close();
        break;
      }
      default:
        throw new Error(`vault: unknown action "${action ?? ""}"`);
    }
  } catch (err) {
    if (err instanceof VaultError) {
      process.stderr.write(err.message + "\n");
      const code = err.code === "weak_recovery_key" ? 3 : err.code === "already_initialized" ? 2 : err.code === "tamper" ? 8 : 1;
      process.exit(code);
    }
    throw err;
  }
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

  // Optional vault (plan §9). Requires authenticated mode; unlocked from stdin at boot.
  const vaultPath = flag(argv, "--vault");
  let vaultConfig = {};
  if (vaultPath) {
    if (open) throw new Error("--vault cannot be combined with --open (vault requires device auth)");
    const vault = Vault.open(vaultPath);
    const passphrase = argv.includes("--vault-passphrase-stdin") ? (readStdin().split("\n")[0] ?? "") : "";
    if (!vault.unlock(passphrase)) {
      console.error("vault unlock failed");
      process.exit(1);
    }
    console.error("vault: unlocked (slot=passphrase)");
    vaultConfig = { vault };
  }

  // Optional TLS (terminates in the hub; the relay only sees ciphertext) + hub identity key.
  const tlsCert = flag(argv, "--tls-cert");
  const tlsKey = flag(argv, "--tls-key");
  const hubKeyPath = flag(argv, "--hub-key");
  let tlsConfig = {};
  if (tlsCert && tlsKey) tlsConfig = { tls: { cert: readFileSync(tlsCert, "utf8"), key: readFileSync(tlsKey, "utf8") } };
  let hubSignerConfig = {};
  if (hubKeyPath) {
    const hubSigner = await loadOrCreateHubSigner(hubKeyPath);
    hubSignerConfig = { hubSigner };
    console.error(`hub: identity key ${hubSigner.publicKey} (pin this on spokes)`);
  }

  // Optional git hosting (plan §13/Phase 7). Served only over the TLS listener
  // (the tunnel), and only with device auth — never in --open mode.
  const gitRoot = flag(argv, "--git-root");
  let gitConfig = {};
  if (gitRoot) {
    if (open) throw new Error("--git-root cannot be combined with --open (git hosting requires device auth)");
    if (!(tlsCert && tlsKey)) throw new Error("--git-root requires TLS (--tls-cert/--tls-key); git is served only over the TLS listener");
    gitConfig = { gitStore: new GitStore(gitRoot) };
  }

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
          ...vaultConfig,
          ...tlsConfig,
          ...hubSignerConfig,
          ...gitConfig,
        },
  );
  if (gitRoot) console.error(`hub: git hosting enabled from ${gitRoot} (served under /git/)`);
  console.error(`hub: listening on ${hub.url} (pid ${process.pid}, ${open ? "OPEN — no auth" : "trust mode"})`);
  if (credStorePath) console.error(`hub: passkey bootstrap enabled (rpID=${rpID})`);
  if (open) console.error("hub: WARNING running in --open mode; device-key auth is disabled");

  const shutdown = (): void => void hub.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Backup bundle CLI (plan §10). Passphrase on stdin line 1. */
function runBackupCli(argv: string[]): void {
  const action = argv[0];
  const passphrase = readStdin().split("\n")[0] ?? "";
  const req = (name: string): string => {
    const v = flag(argv, name);
    if (!v) throw new Error(`backup: ${name} is required`);
    return v;
  };
  const targets = () => ({
    vaultDb: req("--vault"),
    ...(flag(argv, "--trust-store") ? { trustStore: flag(argv, "--trust-store") as string } : {}),
    ...(flag(argv, "--cred-store") ? { credStore: flag(argv, "--cred-store") as string } : {}),
    ...(flag(argv, "--git-root") ? { gitRoot: flag(argv, "--git-root") as string } : {}),
  });
  try {
    if (action === "create") {
      createBundle({ ...targets(), out: req("--out"), passphrase });
      process.stderr.write("backup: created\n");
    } else if (action === "restore") {
      restoreBundle({ ...targets(), in: req("--in"), passphrase });
      process.stderr.write("backup: restored\n");
    } else {
      throw new Error(`backup: unknown action "${action ?? ""}" (expected create | restore)`);
    }
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  }
}

/** Reverse-tunnel keeper CLI: `hub tunnel -- <command> [args]`. */
function runTunnelCli(argv: string[]): void {
  const dd = argv.indexOf("--");
  const cmd = dd < 0 ? [] : argv.slice(dd + 1);
  if (cmd.length === 0) throw new Error("usage: hub tunnel -- <command> [args]");
  const keeper = new TunnelKeeper({ command: cmd[0] as string, args: cmd.slice(1), onSpawn: (pid) => console.error(`tunnel: up (pid ${pid})`) });
  keeper.start();
  console.error("tunnel: keeper started");
  const shutdown = (): void => {
    keeper.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Self-update CLI (plan §4). `check` is a read-only decision; `stage`
 * verifies+exports one tag; `apply` runs check → stage → ask the supervisor to
 * blue/green swap. The pinned --allowed-signers file MUST live outside --repo,
 * and nothing is ever swapped in that did not pass signature verification.
 *   hub update check  --repo <clone> --allowed-signers <pinned> [--current v] [--staging d]
 *   hub update stage  --repo <clone> --allowed-signers <pinned> --tag <vX.Y.Z> [--current v]
 *   hub update apply  --repo <clone> --allowed-signers <pinned> --current <v> --control <sup.sock>
 */
async function runUpdateCli(argv: string[]): Promise<void> {
  const action = argv[0];
  const req = (name: string): string => {
    const v = flag(argv, name);
    if (!v) throw new Error(`update: ${name} is required`);
    return v;
  };
  const mkUpdater = (): Updater =>
    new Updater({
      repoDir: req("--repo"),
      allowedSignersPath: req("--allowed-signers"),
      stagingRoot: flag(argv, "--staging") ?? `${req("--repo")}/.glass-staging`,
      currentVersion: flag(argv, "--current") ?? "0.0.0",
      ...(flag(argv, "--local-protocol") ? { localProtocol: Number(flag(argv, "--local-protocol")) } : {}),
      ...(flag(argv, "--remote") ? { remote: flag(argv, "--remote") as string } : {}),
    });
  try {
    if (action === "check") {
      const d = mkUpdater().checkForUpdate();
      const out =
        d.action === "apply"
          ? { action: d.action, tag: d.tag, version: d.version.raw, rejected: d.rejected }
          : { action: d.action, reason: d.reason, rejected: d.rejected };
      process.stdout.write(JSON.stringify(out) + "\n");
    } else if (action === "stage") {
      const s = mkUpdater().stage(req("--tag"));
      process.stdout.write(JSON.stringify({ tag: s.tag, version: s.version, protocolVersion: s.protocolVersion, entry: s.entryPath }) + "\n");
    } else if (action === "apply") {
      const up = mkUpdater();
      const d = up.checkForUpdate();
      if (d.action !== "apply") {
        process.stderr.write(`update: nothing to apply (${d.reason})\n`);
        return;
      }
      const s = up.stage(d.tag);
      process.stderr.write(`update: staged ${s.tag} (${s.version}, proto ${s.protocolVersion}) at ${s.entryPath}\n`);
      const outcome = await requestSwap(req("--control"), s.entryPath);
      for (const line of outcome.progress) process.stderr.write(`  swap: ${line}\n`);
      if (!outcome.ok) {
        process.stderr.write(`update: swap failed: ${outcome.error ?? "unknown"}\n`);
        process.exit(1);
      }
      process.stderr.write(`update: applied ${s.version}\n`);
    } else {
      throw new Error(`update: unknown action "${action ?? ""}" (expected check | stage | apply)`);
    }
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  }
}

/**
 * Git hosting management CLI (plan §13/Phase 7).
 *   hub git init   --git-root <dir> --name <repo>
 *   hub git allow  --git-root <dir> --name <repo> --device <id> [--write]
 *   hub git revoke --git-root <dir> --name <repo> --device <id>
 *   hub git list   --git-root <dir>
 *   hub git token  --git-root <dir> --device <id>     # prints the bearer token ONCE
 */
function runGitCli(argv: string[]): void {
  const action = argv[0];
  const root = flag(argv, "--git-root");
  if (!root) throw new Error("git: --git-root <dir> is required");
  const store = new GitStore(root);
  const req = (name: string): string => {
    const v = flag(argv, name);
    if (!v) throw new Error(`git: ${name} is required`);
    return v;
  };
  try {
    if (action === "init") {
      const name = req("--name");
      store.initRepo(name);
      process.stderr.write(`git: initialized ${name}\n`);
    } else if (action === "allow") {
      const name = req("--name");
      const device = req("--device");
      const write = argv.includes("--write");
      store.allow(name, device, write);
      process.stderr.write(`git: ${device} granted ${write ? "write" : "read"} on ${name}\n`);
    } else if (action === "revoke") {
      store.revoke(req("--name"), req("--device"));
      process.stderr.write(`git: revoked ${req("--device")} on ${req("--name")}\n`);
    } else if (action === "list") {
      process.stdout.write(JSON.stringify(store.listRepos(), null, 2) + "\n");
    } else if (action === "token") {
      const device = req("--device");
      const token = store.mintToken(device);
      process.stdout.write(token + "\n"); // shown ONCE; store in the device's config
      process.stderr.write(`git: minted token for ${device} (shown once — not recoverable)\n`);
    } else {
      throw new Error(`git: unknown action "${action ?? ""}" (expected init | allow | revoke | list | token)`);
    }
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "trust") await runTrustCli(argv.slice(1));
  else if (argv[0] === "vault") runVaultCli(argv.slice(1));
  else if (argv[0] === "backup") runBackupCli(argv.slice(1));
  else if (argv[0] === "tunnel") runTunnelCli(argv.slice(1));
  else if (argv[0] === "update") await runUpdateCli(argv.slice(1));
  else if (argv[0] === "git") runGitCli(argv.slice(1));
  else await runServer(argv);
}

main().catch((err) => {
  console.error("hub: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
