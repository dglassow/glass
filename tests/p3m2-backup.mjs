/**
 * Phase 3 · Milestone 2 — acceptance test for the encrypted backup bundle.
 *
 * Simulates the §16 recovery drill: init a vault with secrets + a trust store,
 * write a bundle, WIPE everything, restore from the bundle on "clean hardware",
 * and prove the secret and the trust store come back and the recovery key still
 * unlocks. Also proves the bundle is encrypted at rest and that a wrong
 * passphrase or a tampered bundle refuses to restore.
 *
 * Run after `pnpm build`:  node tests/p3m2-backup.mjs
 */
import { spawnSync, execFileSync, } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const realPubKey = () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("base64url");
};

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const RUN = `/tmp/glass-p3m2-${process.pid}`;
const TS = `${RUN}/trust.json`;
const DB = `${RUN}/vault.db`;
const BUNDLE = `${RUN}/backup.glassbundle`;
const PASS = "fixture passphrase 9 lively";
const REC = "JBSWY3DPEHPK3PXPJBSWY3DPEH";
const MARK = "tok_BACKUP_SECRET_9z8y7x";

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const hub = (args, input) => spawnSync("node", [HUB, ...args], { input, encoding: "utf8" });
const vaultReveal = () => spawnSync("node", [HUB, "vault", "reveal", "--name", "s1", "--vault", DB], { input: `${PASS}\n` }).stdout.toString();

function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P3 M2 backup bundle\x1b[0m\n");

  // Setup: vault + secret + trusted device.
  hub(["vault", "init", "--vault", DB], `${PASS}\n${REC}\n`);
  hub(["vault", "add", "--name", "s1", "--class", "workflow", "--tag", "prod", "--vault", DB], `${PASS}\n${MARK}`);
  execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", "pro", "--name", "Pro", "--public-key", realPubKey(), "--roles", "agent"]).toString();
  const trustBefore = readFileSync(TS, "utf8");

  // CHECK 1 — create the bundle.
  const created = hub(["backup", "create", "--vault", DB, "--trust-store", TS, "--out", BUNDLE], `${PASS}\n`);
  check("backup create", created.status === 0 && existsSync(BUNDLE));

  // CHECK 2 — the bundle is encrypted at rest.
  const bundleBytes = readFileSync(BUNDLE);
  check("bundle is encrypted (secret/passphrase/recovery absent)", [MARK, PASS, REC].every((s) => !bundleBytes.includes(Buffer.from(s, "utf8"))), `${bundleBytes.length} bytes`);

  // Wipe everything — simulate clean hardware.
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, TS]) rmSync(f, { force: true });
  check("state wiped", !existsSync(DB) && !existsSync(TS));

  // CHECK 3 — wrong passphrase refuses to restore.
  const badRestore = hub(["backup", "restore", "--in", BUNDLE, "--vault", DB, "--trust-store", TS], `wrong passphrase here\n`);
  check("wrong passphrase refuses restore", badRestore.status === 1 && !existsSync(DB));

  // CHECK 4 — restore with the correct passphrase.
  const restored = hub(["backup", "restore", "--in", BUNDLE, "--vault", DB, "--trust-store", TS], `${PASS}\n`);
  check("restore succeeds", restored.status === 0 && existsSync(DB) && existsSync(TS));

  // CHECK 5 — the secret survived the snapshot + restore.
  check("secret intact after restore", vaultReveal() === MARK);

  // CHECK 6 — the trust store came back verbatim.
  check("trust store restored", readFileSync(TS, "utf8") === trustBefore);

  // CHECK 7 — the recovery key still unlocks the restored vault (the §16 drill).
  check("recovery key unlocks restored vault", spawnSync("node", [HUB, "vault", "check-recovery", "--vault", DB], { input: `${REC}\n` }).status === 0);

  // CHECK 8 — a tampered bundle refuses to restore.
  const b = JSON.parse(readFileSync(BUNDLE, "utf8"));
  const ct = Buffer.from(b.ct, "base64"); ct[0] ^= 0xff; b.ct = ct.toString("base64");
  const tampered = `${RUN}/tampered.glassbundle`;
  writeFileSync(tampered, JSON.stringify(b));
  const tRestore = hub(["backup", "restore", "--in", tampered, "--vault", `${RUN}/v2.db`], `${PASS}\n`);
  check("tampered bundle refuses restore", tRestore.status === 1 && !existsSync(`${RUN}/v2.db`));
}

try {
  run();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`);
  rmSync(RUN, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`);
  rmSync(RUN, { recursive: true, force: true });
  process.exit(1);
}
