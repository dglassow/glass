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

const { GitStore } = await import(new URL("../packages/hub/dist/git/index.js", import.meta.url).href);

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
const GITROOT = `${RUN}/git`;
const PASS = "fixture passphrase 9 lively";
const REC = "JBSWY3DPEHPK3PXPJBSWY3DPEH";
const MARK = "tok_BACKUP_SECRET_9z8y7x";
const GITMARK = "hosted-repo-content-Q7w8e9";

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

  // Setup: hosted git repos (Phase 7) — one with a commit, one empty — plus a
  // grant and a token, so the whole thing rides the backup bundle.
  hub(["git", "init", "--git-root", GITROOT, "--name", "alpha"]);
  hub(["git", "init", "--git-root", GITROOT, "--name", "empty"]);
  hub(["git", "allow", "--git-root", GITROOT, "--name", "alpha", "--device", "pro", "--write"]);
  const gitToken = hub(["git", "token", "--git-root", GITROOT, "--device", "pro"]).stdout.trim();
  const WT = `${RUN}/wt`;
  mkdirSync(WT, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", WT]);
  execFileSync("git", ["-C", WT, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", WT, "config", "user.name", "t"]);
  writeFileSync(`${WT}/README`, `${GITMARK}\n`);
  execFileSync("git", ["-C", WT, "add", "-A"]);
  execFileSync("git", ["-C", WT, "commit", "-qm", "c"]);
  execFileSync("git", ["-C", WT, "push", "-q", `${GITROOT}/alpha.git`, "main:main"]);

  // CHECK 1 — create the bundle (now including the hosted git repos).
  const created = hub(["backup", "create", "--vault", DB, "--trust-store", TS, "--git-root", GITROOT, "--out", BUNDLE], `${PASS}\n`);
  check("backup create", created.status === 0 && existsSync(BUNDLE));

  // CHECK 2 — the bundle is encrypted at rest (hosted repo content included).
  const bundleBytes = readFileSync(BUNDLE);
  check("bundle is encrypted (secret/passphrase/recovery/git absent)", [MARK, PASS, REC, GITMARK].every((s) => !bundleBytes.includes(Buffer.from(s, "utf8"))), `${bundleBytes.length} bytes`);

  // Wipe everything — simulate clean hardware.
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, TS]) rmSync(f, { force: true });
  rmSync(GITROOT, { recursive: true, force: true });
  check("state wiped", !existsSync(DB) && !existsSync(TS) && !existsSync(GITROOT));

  // CHECK 3 — wrong passphrase refuses to restore.
  const badRestore = hub(["backup", "restore", "--in", BUNDLE, "--vault", DB, "--trust-store", TS], `wrong passphrase here\n`);
  check("wrong passphrase refuses restore", badRestore.status === 1 && !existsSync(DB));

  // CHECK 4 — restore with the correct passphrase (including hosted git repos).
  const restored = hub(["backup", "restore", "--in", BUNDLE, "--vault", DB, "--trust-store", TS, "--git-root", GITROOT], `${PASS}\n`);
  check("restore succeeds", restored.status === 0 && existsSync(DB) && existsSync(TS));

  // CHECK 4b — hosted git repos survived: the commit, the empty repo, and the
  // per-device access (ACL + token hash) all come back.
  {
    const CLONE = `${RUN}/alpha-clone`;
    execFileSync("git", ["clone", "-q", `${GITROOT}/alpha.git`, CLONE]);
    check("hosted repo restored with its commit", existsSync(`${CLONE}/README`) && readFileSync(`${CLONE}/README`, "utf8").includes(GITMARK));
    check("empty hosted repo restored (bare)", existsSync(`${GITROOT}/empty.git/HEAD`));
    const rstore = new GitStore(GITROOT);
    check("hosted repo ACL restored (pro has write on alpha)", rstore.canWrite("alpha", "pro"));
    check("hosted git token survives backup", rstore.verifyToken("pro", gitToken));
  }

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
