/**
 * Phase 3 · Milestone 1 — acceptance test for the vault.
 *
 * Independent + adversarial. Drives the real hub `vault` CLI, the hub server,
 * and the `glass` CLI; authenticates a device with a reimplemented Ed25519
 * handshake; and opens the SQLite file with its OWN node:sqlite handle to scan
 * raw bytes and to tamper. Proves: recovery-key entropy gate, CRUD, envelope
 * round-trip, ciphertext-at-rest, wrong-passphrase + GCM tamper + row-transplant
 * detection, recovery-only unlock, per-device scoping, personal-class refusal,
 * audit completeness, and that glass run injects a secret into a child's env
 * without it reaching argv or the diagnostic log.
 *
 * Run after `pnpm build`:  node tests/p3m1-vault.mjs
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const CLI = `${ROOT}packages/cli/dist/main.js`;
const RUN = `/tmp/glass-p3m1-${process.pid}`;
const TS = `${RUN}/trust.json`;
const DB = `${RUN}/vault.db`;
const PASS = "fixture passphrase 9 lively";
const REC = "JBSWY3DPEHPK3PXPJBSWY3DPEH"; // 26 base32 chars, ~134 bits
const MARK1 = "tok_SUPERSECRET_a1b2c3";
const MARK2 = "tok_ROTATED_d4e5f6";

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const b64u = (b) => Buffer.from(b).toString("base64url");

// ---- Ed25519 device identity ----------------------------------------------
async function makeIdentity(deviceId) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const pkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  return { deviceId, publicKey: pub, keyFileJson: JSON.stringify({ v: 1, deviceId, publicKey: pub, privateKeyPkcs8: pkcs8 }), async sign(bytes) { return b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes))); } };
}
const hsPayload = (id, nonce) => new TextEncoder().encode(`glass:handshake:v1\n${id}\n${nonce}`);

// ---- helpers --------------------------------------------------------------
const vault = (args, input) => spawnSync("node", [HUB, "vault", ...args, "--vault", DB], input === undefined ? {} : { input });
const vaultOut = (args, input) => spawnSync("node", [HUB, "vault", ...args, "--vault", DB], { input });
const trustAdd = (id, name, pub, roles) => execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", name, "--public-key", pub, "--roles", roles]);

function startHub(input) {
  const cp = spawn("node", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--vault", DB, "--vault-passphrase-stdin"], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  cp.stdin.write(input);
  cp.stdin.end();
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => { const m = err.match(/listening on (ws:\/\/\S+)/); if (m) { clearInterval(iv); resolve({ url: m[1], err: () => err }); } }, 25);
    cp.once("exit", (c) => { clearInterval(iv); reject(new Error(`hub exited (${c}): ${err}`)); });
    setTimeout(() => { clearInterval(iv); reject(new Error(`hub not ready: ${err}`)); }, 8000);
  });
  return { cp, ready, err: () => err };
}

class Peer {
  constructor(url, id) { this.id = id; this.envs = []; this.waiters = []; this.ws = new WebSocket(url); this.opened = new Promise((r) => this.ws.addEventListener("open", r, { once: true })); this.ws.addEventListener("message", (ev) => { let e; try { e = JSON.parse(ev.data); } catch { return; } this.envs.push(e); this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true)); }); this.ws.addEventListener("close", () => { for (const w of this.waiters) w.reject(new Error("closed")); this.waiters = []; }); this.ws.addEventListener("error", () => {}); }
  send(body, to = "hub") { const id = randomUUID(); this.ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), from: this.id, to, body })); return id; }
  waitFor(pred, ms = 5000) { const h = this.envs.find(pred); if (h) return Promise.resolve(h); return new Promise((res, rej) => { const w = { pred, resolve: res, reject: rej }; this.waiters.push(w); setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("timeout")); }, ms); }); }
  close() { try { this.ws.close(); } catch {} }
}
async function authenticate(url, id) {
  const p = new Peer(url, id.deviceId); await p.opened;
  const hid = p.send({ type: "hello", deviceId: id.deviceId, deviceName: id.deviceId, roles: ["agent"], protocolVersion: 1, appVersion: "harness", etch: { present: false } });
  const ch = await p.waitFor((e) => e.body?.type === "hello.challenge" && e.replyTo === hid);
  p.send({ type: "hello.proof", deviceId: id.deviceId, signature: await id.sign(hsPayload(id.deviceId, ch.body.nonce)) });
  await p.waitFor((e) => e.body?.type === "hello.ack");
  return p;
}
async function vaultGet(peer, name) {
  const id = peer.send({ type: "vault.get", name });
  const r = await peer.waitFor((e) => e.replyTo === id && (e.body?.type === "vault.secret" || e.body?.type === "error"));
  return r.body.type === "vault.secret" ? { ok: true, value: r.body.value } : { ok: false, code: r.body.code };
}

// ---- the test -------------------------------------------------------------
let hub;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P3 M1 vault\x1b[0m\n");

  // CHECK 1 — recovery-key entropy gate rejects weak keys.
  const weak = ["password123", "correct horse battery staple", "deadbeefdeadbeef"];
  let allRejected = true;
  for (const w of weak) { const r = vault(["init"], `${PASS}\n${w}\n`); if (r.status !== 3) allRejected = false; }
  check("weak recovery keys rejected (exit 3)", allRejected && !existsSync(DB));

  // CHECK 2 — init with a strong recovery key.
  const init = vault(["init"], `${PASS}\n${REC}\n`);
  check("vault init with strong recovery key", init.status === 0 && existsSync(DB));
  {
    const db = new DatabaseSync(DB, { readOnly: true });
    const slots = db.prepare("SELECT slot FROM key_slots ORDER BY slot").all().map((r) => r.slot);
    db.close();
    check("exactly two keyslots (passphrase, recovery)", slots.length === 2 && slots.includes("passphrase") && slots.includes("recovery"));
  }

  // CHECK 3 — re-init refused.
  check("re-init refused (exit 2)", vault(["init"], `${PASS}\n${REC}\n`).status === 2);

  // CHECK 4/5 — add + list + reveal round-trip.
  vault(["add", "--name", "deploy_token", "--class", "workflow", "--tag", "ci", "--tag", "prod"], `${PASS}\n${MARK1}`);
  const listed = JSON.parse(spawnSync("node", [HUB, "vault", "list", "--vault", DB], { input: `${PASS}\n`, encoding: "utf8" }).stdout.trim());
  check("add + list", listed.name === "deploy_token" && listed.class === "workflow" && listed.tags.join(",") === "ci,prod" && listed.version === 1);
  const rev1 = spawnSync("node", [HUB, "vault", "reveal", "--name", "deploy_token", "--vault", DB], { input: `${PASS}\n` });
  check("reveal round-trips exact bytes", rev1.stdout.toString("utf8") === MARK1);

  // CHECK 6 — update bumps version.
  vault(["update", "--name", "deploy_token"], `${PASS}\n${MARK2}`);
  const rev2 = spawnSync("node", [HUB, "vault", "reveal", "--name", "deploy_token", "--vault", DB], { input: `${PASS}\n` });
  check("update + reveal new value (version 2)", rev2.stdout.toString("utf8") === MARK2);

  // CHECK 7 — ciphertext at rest: plaintext absent from the DB files.
  let blob = Buffer.alloc(0);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) blob = Buffer.concat([blob, readFileSync(f)]);
  const plainAbsent = [MARK1, MARK2, PASS, REC].every((s) => !blob.includes(Buffer.from(s, "utf8")));
  check("ciphertext at rest (plaintext absent from DB)", plainAbsent, `scanned ${blob.length} bytes`);

  // CHECK 8 — wrong passphrase fails to unlock/reveal.
  const badRev = spawnSync("node", [HUB, "vault", "reveal", "--name", "deploy_token", "--vault", DB], { input: `wrong passphrase\n` });
  check("wrong passphrase refused (exit 5, no output)", badRev.status === 5 && badRev.stdout.length === 0);

  // CHECK 9 — recovery-key-only verification.
  check("check-recovery accepts the recovery key", spawnSync("node", [HUB, "vault", "check-recovery", "--vault", DB], { input: `${REC}\n` }).status === 0);
  check("check-recovery rejects a wrong key", spawnSync("node", [HUB, "vault", "check-recovery", "--vault", DB], { input: `nope nope nope\n` }).status !== 0);

  // CHECK 10 — GCM tamper (byte-flip) detected.
  {
    const db = new DatabaseSync(DB);
    const row = db.prepare("SELECT ct FROM secrets WHERE name='deploy_token'").get();
    const ct = Buffer.from(row.ct); const orig = Buffer.from(ct); ct[0] ^= 0xff;
    db.prepare("UPDATE secrets SET ct=? WHERE name='deploy_token'").run(ct);
    db.close();
    const r = spawnSync("node", [HUB, "vault", "reveal", "--name", "deploy_token", "--vault", DB], { input: `${PASS}\n` });
    check("GCM tamper detected (exit 8, no plaintext)", r.status === 8 && r.stdout.length === 0);
    const db2 = new DatabaseSync(DB); db2.prepare("UPDATE secrets SET ct=? WHERE name='deploy_token'").run(orig); db2.close();
  }

  // CHECK 11 — row transplant defeated by AAD binding.
  {
    vault(["add", "--name", "other_token", "--class", "workflow"], `${PASS}\nzzz_other_value`);
    const db = new DatabaseSync(DB);
    const a = db.prepare("SELECT ct,iv,tag,wrapped_dek,dek_iv,dek_tag FROM secrets WHERE name='deploy_token'").get();
    const b = db.prepare("SELECT ct,iv,tag,wrapped_dek,dek_iv,dek_tag FROM secrets WHERE name='other_token'").get();
    db.prepare("UPDATE secrets SET ct=?,iv=?,tag=?,wrapped_dek=?,dek_iv=?,dek_tag=? WHERE name='deploy_token'").run(b.ct, b.iv, b.tag, b.wrapped_dek, b.dek_iv, b.dek_tag);
    db.close();
    const r = spawnSync("node", [HUB, "vault", "reveal", "--name", "deploy_token", "--vault", DB], { input: `${PASS}\n` });
    check("row transplant defeated (exit 8)", r.status === 8);
    // restore
    const db2 = new DatabaseSync(DB); db2.prepare("UPDATE secrets SET ct=?,iv=?,tag=?,wrapped_dek=?,dek_iv=?,dek_tag=? WHERE name='deploy_token'").run(a.ct, a.iv, a.tag, a.wrapped_dek, a.dek_iv, a.dek_tag); db2.prepare("DELETE FROM secrets WHERE name='other_token'").run(); db2.close();
  }

  // CHECK 12 — per-device scoping + machine retrieval through the hub.
  const agentA = await makeIdentity("agent-a");
  const agentB = await makeIdentity("agent-b");
  writeFileSync(`${RUN}/agent-a.json`, agentA.keyFileJson, { mode: 0o600 });
  trustAdd("agent-a", "A", agentA.publicKey, "agent");
  trustAdd("agent-b", "B", agentB.publicKey, "agent");
  vault(["allow", "--name", "deploy_token", "--device-id", "agent-a"], `${PASS}\n`);
  vault(["add", "--name", "personal_note", "--class", "personal"], `${PASS}\nmy_diary`);
  vault(["allow", "--name", "personal_note", "--device-id", "agent-a"], `${PASS}\n`);

  hub = startHub(`${PASS}\n`);
  const { url } = await hub.ready;
  const pa = await authenticate(url, agentA);
  check("allow-listed device retrieves the secret", (await vaultGet(pa, "deploy_token")).value === MARK2);
  const pb = await authenticate(url, agentB);
  const denied = await vaultGet(pb, "deploy_token");
  check("non-allow-listed device is denied (no value)", denied.ok === false && denied.code === "secret_denied");
  check("unknown secret errors", (await vaultGet(pa, "nope")).code === "secret_unknown");
  check("personal secret refused to a machine (biometric_required)", (await vaultGet(pa, "personal_note")).code === "biometric_required");
  pb.close();

  // CHECK 13 — --vault with --open refuses to start.
  const openVault = spawnSync("node", [HUB, "--listen", "127.0.0.1:0", "--open", "--vault", DB], { encoding: "utf8" });
  check("--vault + --open refused", openVault.status !== 0);

  // CHECK 14 — audit completeness + no secret leakage into the audit log.
  const auditText = spawnSync("node", [HUB, "vault", "audit", "--vault", DB], { input: `${PASS}\n`, encoding: "utf8" }).stdout;
  const events = auditText.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).event);
  check("audit records init, CRUD, and denials", events.includes("vault.init") && events.includes("secret.create") && events.includes("secret.get"));
  check("audit log contains no secret values", ![MARK1, MARK2, PASS, REC, "my_diary"].some((s) => auditText.includes(s)));

  // CHECK 15 — glass run injects into child env, not argv, not the diag log.
  writeFileSync(`${RUN}/child.mjs`, `import {writeFileSync} from "node:fs"; writeFileSync(process.env.OUT, JSON.stringify({argv: process.argv, env: process.env.DEPLOY_TOKEN||null}));`);
  const diag = `${RUN}/diag.log`;
  const outFile = `${RUN}/child-out.json`;
  const gr = spawnSync("node", [CLI, "run", "--hub", url, "--key", `${RUN}/agent-a.json`, "--secret", "deploy_token=DEPLOY_TOKEN", "--log", diag, "--", "node", `${RUN}/child.mjs`], { env: { ...process.env, OUT: outFile }, encoding: "utf8" });
  const childOut = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
  check("glass run injects secret into child env", gr.status === 0 && childOut.env === MARK2);
  check("secret not in child argv", !JSON.stringify(childOut.argv || []).includes(MARK2));
  const diagText = existsSync(diag) ? readFileSync(diag, "utf8") : "";
  check("diag log is live but redacted", diagText.includes("secret.injected") && !diagText.includes(MARK2));

  // CHECK 16 — denied glass run does not spawn the child; exit propagation.
  writeFileSync(`${RUN}/agent-b.json`, agentB.keyFileJson, { mode: 0o600 });
  const flag = `${RUN}/should-not-exist`;
  const grDenied = spawnSync("node", [CLI, "run", "--hub", url, "--key", `${RUN}/agent-b.json`, "--secret", "deploy_token", "--", "node", "-e", `require('fs').writeFileSync('${flag}','x')`], { encoding: "utf8" });
  check("denied glass run exits 77, child never runs", grDenied.status === 77 && !existsSync(flag));
  const grExit = spawnSync("node", [CLI, "run", "--hub", url, "--key", `${RUN}/agent-a.json`, "--secret", "deploy_token", "--", "node", "-e", "process.exit(42)"], { encoding: "utf8" });
  check("child exit code propagated (42)", grExit.status === 42);

  pa.close();
}

async function cleanup() {
  try { if (hub?.cp?.pid) hub.cp.kill("SIGTERM"); } catch {}
  await sleep(200);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 90s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 90000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
