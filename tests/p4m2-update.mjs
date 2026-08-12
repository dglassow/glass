/**
 * Phase 4 · Milestone 2 — adversarial acceptance test for the self-update gate.
 *
 * The updater is the highest-value target in Glass: it runs code unattended on
 * every host with full shell + vault reach, so a hole here is arbitrary code
 * execution fleet-wide (plan §4). This harness builds throwaway git repos with
 * real SSH-signed tags and proves the gate refuses every tampering path:
 *   - only a tag signed by the PINNED key is ever applied;
 *   - a newer unsigned / foreign-signed tag is skipped, never masking an older
 *     verified one, and never applied;
 *   - a tag re-pointed after signing fails verification;
 *   - the pinned allowed-signers file must live OUTSIDE the repo it verifies;
 *   - no downgrade, no protocol downgrade, no >1 protocol jump;
 *   - the staged tree is exactly the signed tree (not repo HEAD);
 *   - manifest and tag versions must agree; entry paths can't escape staging.
 *
 * Run after `pnpm build`:  node tests/p4m2-update.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import(new URL("../packages/hub/dist/updater/index.js", import.meta.url).href);
const { Updater, GitUpdateSource, verifyTagSignature, UpdateVerifyError, compareSemVer, isNewer, parseSemVer } = mod;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const throws = (fn, rx) => {
  try {
    fn();
    return false;
  } catch (e) {
    return rx ? rx.test(String(e.message ?? e)) : true;
  }
};

const ROOT = mkdtempSync(join(tmpdir(), "glass-p4m2-"));
const keys = join(ROOT, "keys");
mkdirSync(keys, { recursive: true });

function keygen(name, label) {
  const path = join(keys, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-f", path, "-N", "", "-C", label]);
  return { priv: path, pub: `${path}.pub`, pubLine: readFileSync(`${path}.pub`, "utf8").trim() };
}
// The pinned release key, and an attacker key that is NOT pinned.
const RELEASE = keygen("release", "glass-release");
const EVIL = keygen("evil", "attacker");

function allowedSigners(dir, ...keyObjs) {
  const path = join(dir, "allowed_signers");
  writeFileSync(path, keyObjs.map((k, i) => `glass-release-${i} ${k.pubLine}`).join("\n") + "\n");
  return path;
}
// Pinned file lives in its own dir, OUTSIDE any repo.
const pinDir = join(ROOT, "pin");
mkdirSync(pinDir, { recursive: true });
const PINNED = allowedSigners(pinDir, RELEASE);

let repoN = 0;
function newRepo() {
  const dir = join(ROOT, `repo${repoN++}`);
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q");
  g("config", "user.name", "glass");
  g("config", "user.email", "release@glass");
  g("config", "commit.gpgsign", "false");
  return { dir, g };
}
// `entry` is what the (signed) manifest claims; `entryFile` is where the real
// file is written on disk. They default to the same normal path, but the
// negative tests set `entry` to a bad value while keeping a valid file on disk.
function commitRelease(repo, { version, protocolVersion = 1, entry = "packages/hub/dist/main.js", entryFile = "packages/hub/dist/main.js", entryContent, minPeerProtocol }) {
  const manifest = { version, protocolVersion, entry };
  if (minPeerProtocol !== undefined) manifest.minPeerProtocol = minPeerProtocol;
  writeFileSync(join(repo.dir, "release.json"), JSON.stringify(manifest, null, 2));
  const entryAbs = join(repo.dir, entryFile);
  mkdirSync(join(entryAbs, ".."), { recursive: true });
  writeFileSync(entryAbs, entryContent ?? `// glass hub ${version}\nconsole.log(${JSON.stringify(version)});\n`);
  repo.g("add", "-A");
  repo.g("commit", "-qm", `release ${version}`);
  return repo.g("rev-parse", "HEAD").trim();
}
const signTag = (repo, tag, key = RELEASE) =>
  repo.g("-c", "gpg.format=ssh", "-c", `user.signingkey=${key.pub}`, "tag", "-s", tag, "-m", tag);
const annotateTag = (repo, tag) => repo.g("tag", "-a", tag, "-m", tag); // unsigned
const lightTag = (repo, tag) => repo.g("tag", tag);

function updater(dir, { current = "1.0.0", localProtocol = 1 } = {}, pinned = PINNED) {
  return new Updater({ repoDir: dir, allowedSignersPath: pinned, stagingRoot: join(ROOT, `stage${repoN}`), currentVersion: current, localProtocol });
}

console.log("Phase 4 · M2 — self-update verification gate\n");

// ── unit: version ordering (the no-downgrade predicate) ──
check("semver: 1.10.0 > 1.9.0", compareSemVer(parseSemVer("1.10.0"), parseSemVer("1.9.0")) > 0);
check("semver: release > pre-release", compareSemVer(parseSemVer("1.0.0"), parseSemVer("1.0.0-rc.1")) > 0);
check("semver: isNewer strict (equal is not newer)", !isNewer(parseSemVer("1.2.3"), parseSemVer("1.2.3")));

// ── happy path: pinned-signed newer release is applied, exact tree staged ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0", protocolVersion: 1, entryContent: "// V110\n" });
  signTag(r, "v1.1.0");
  const up = updater(r.dir);
  const d = up.checkForUpdate();
  check("apply: newest pinned-signed release selected", d.action === "apply" && d.tag === "v1.1.0", d.action);
  if (d.action === "apply") {
    const s = up.stage(d.tag);
    check("stage: returns entry that exists", existsSync(s.entryPath), s.entryPath);
    check("stage: version + protocol from signed manifest", s.version === "1.1.0" && s.protocolVersion === 1);
    check("stage: staged tree is the SIGNED tree, not HEAD", readFileSync(s.entryPath, "utf8").includes("V110"));
  }
}

// ── foreign-signed newer tag is refused and does not mask the good one ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0" });
  signTag(r, "v1.1.0", RELEASE);
  commitRelease(r, { version: "2.0.0", entryContent: "// PWNED\n" });
  signTag(r, "v2.0.0", EVIL); // attacker's key, not pinned
  const d = updater(r.dir).checkForUpdate();
  check("attacker: foreign-signed v2.0.0 rejected, falls back to v1.1.0", d.action === "apply" && d.tag === "v1.1.0", d.tag);
  check("attacker: rejection is recorded for audit", d.rejected.some((x) => x.tag === "v2.0.0"));
}

// ── unsigned newer tag is refused ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0" });
  signTag(r, "v1.1.0");
  commitRelease(r, { version: "1.2.0", entryContent: "// unsigned\n" });
  annotateTag(r, "v1.2.0");
  const d = updater(r.dir).checkForUpdate();
  check("unsigned: annotated-but-unsigned v1.2.0 skipped, applies v1.1.0", d.action === "apply" && d.tag === "v1.1.0", d.tag);
}

// ── tag re-pointed AFTER signing must fail verification ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0" });
  signTag(r, "v1.1.0");
  const good = commitRelease(r, { version: "3.0.0", entryContent: "// good v3\n" });
  signTag(r, "v3.0.0"); // properly signed at `good`
  const evilCommit = commitRelease(r, { version: "3.0.0-evil", entryContent: "// PWNED v3\n" });
  r.g("tag", "-f", "v3.0.0", evilCommit); // move the tag, do NOT re-sign
  const src = new GitUpdateSource(r.dir, PINNED);
  check("tamper: re-pointed v3.0.0 is NOT trusted", src.verifyTag("v3.0.0").trusted === false);
  const d = updater(r.dir).checkForUpdate();
  check("tamper: re-pointed tag skipped, applies v1.1.0", d.action === "apply" && d.tag === "v1.1.0", d.tag);
}

// ── pinned allowed-signers must live OUTSIDE the repo it verifies ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0" });
  signTag(r, "v1.1.0");
  const insidePin = allowedSigners(r.dir, RELEASE); // inside the repo — the anti-pattern
  check(
    "pinning: allowed-signers inside repo is refused",
    throws(() => verifyTagSignature(r.dir, "v1.1.0", insidePin), /OUTSIDE the repo/),
  );
  check(
    "pinning: missing allowed-signers fails closed",
    throws(() => verifyTagSignature(r.dir, "v1.1.0", join(ROOT, "nope")), /not found/),
  );
  const emptyPin = join(pinDir, "empty");
  writeFileSync(emptyPin, "");
  check(
    "pinning: empty allowed-signers fails closed",
    throws(() => verifyTagSignature(r.dir, "v1.1.0", emptyPin), /empty/),
  );
}

// ── no downgrade ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0" });
  signTag(r, "v1.1.0");
  const up = updater(r.dir, { current: "2.0.0" });
  const d = up.checkForUpdate();
  check("downgrade: older signed release is not offered", d.action === "none");
  check("downgrade: stage() refuses an older tag outright", throws(() => up.stage("v1.1.0"), /downgrade/));
}

// ── manifest version must agree with the signed tag ──
{
  const r = newRepo();
  commitRelease(r, { version: "9.9.9" }); // manifest claims 9.9.9
  signTag(r, "v1.5.0"); // but the tag says 1.5.0
  const up = updater(r.dir);
  check("consistency: manifest/tag version mismatch is refused", throws(() => up.stage("v1.5.0"), /disagrees with tag/));
}

// ── protocol advance rules ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0", protocolVersion: 2 });
  signTag(r, "v1.1.0");
  check("protocol: local→local+1 advance is allowed", updater(r.dir, { localProtocol: 1 }).stage("v1.1.0").protocolVersion === 2);
  check("protocol: downgrade (2→1 target) refused", throws(() => updater(r.dir, { localProtocol: 3 }).stage("v1.1.0"), /downgrade/));
}
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0", protocolVersion: 3 });
  signTag(r, "v1.1.0");
  check("protocol: jump of >1 (1→3) refused", throws(() => updater(r.dir, { localProtocol: 1 }).stage("v1.1.0"), /jump/));
}

// ── manifest hygiene: entry can't escape, must exist ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0", entry: "../../etc/passwd", entryFile: "packages/hub/dist/main.js" });
  signTag(r, "v1.1.0");
  check("manifest: traversal entry refused", throws(() => updater(r.dir).stage("v1.1.0"), /entry/));
}
{
  const r = newRepo();
  // Manifest points at nope.js, but the only file on disk is main.js.
  commitRelease(r, { version: "1.1.0", entry: "packages/hub/dist/nope.js", entryFile: "packages/hub/dist/main.js" });
  signTag(r, "v1.1.0");
  check("manifest: missing entry file refused", throws(() => updater(r.dir).stage("v1.1.0"), /not present/));
}

// ── non-version tags ignored ──
{
  const r = newRepo();
  commitRelease(r, { version: "1.1.0" });
  signTag(r, "v1.1.0");
  signTag(r, "nightly"); // signed but not a release version
  const d = updater(r.dir).checkForUpdate();
  check("tags: signed non-version tag 'nightly' ignored", d.action === "apply" && d.tag === "v1.1.0");
}

// ── distribution: fetch from a remote clone still verifies against the pin ──
{
  const upstream = newRepo();
  commitRelease(upstream, { version: "1.1.0", entryContent: "// remote 110\n" });
  signTag(upstream, "v1.1.0");
  const cloneDir = join(ROOT, "clone");
  execFileSync("git", ["clone", "-q", upstream.dir, cloneDir]);
  // A new signed release lands upstream AFTER the clone.
  commitRelease(upstream, { version: "1.2.0", entryContent: "// remote 120\n" });
  signTag(upstream, "v1.2.0");
  const up = updater(cloneDir); // checkForUpdate() calls fetch() first
  const d = up.checkForUpdate();
  check("distribution: fetch picks up the new signed v1.2.0", d.action === "apply" && d.tag === "v1.2.0", d.tag);
  if (d.action === "apply") check("distribution: staged tree matches fetched release", updater(cloneDir).stage("v1.2.0").version === "1.2.0");
}

rmSync(ROOT, { recursive: true, force: true });

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
