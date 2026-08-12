/**
 * Phase 2 · Milestone 2 — acceptance test for passkey (WebAuthn) bootstrap.
 *
 * Independent + adversarial. Drives the hub's credential ceremony over the raw
 * WebSocket with a software WebAuthn authenticator (P-256 / ES256, "none"
 * attestation, hand-rolled CBOR) and a real Ed25519 device — no @glass/protocol
 * import. Proves: registration is token-gated; a passkey-authed owner can
 * approve a device enrollment with NO prior device approver (the plan §8.4
 * first-device bootstrap); passkey authentication works; and replayed, forged,
 * and counter-regressed assertions are all refused.
 *
 * Run after `pnpm build`:  node tests/p2m2-passkey.mjs
 */
import { spawn } from "node:child_process";
import { randomUUID, generateKeyPairSync, createHash, sign as ecsign, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const RUN = `/tmp/glass-p2m2-${process.pid}`;
const TS = `${RUN}/trust.json`;
const CS = `${RUN}/creds.json`;
const TOKEN = "boot-token-xyz";
const RP_ID = "localhost";
const ORIGIN = "http://localhost";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

// ---- minimal CBOR + software WebAuthn authenticator -----------------------
const cu = (m, n) => n < 24 ? Buffer.from([(m << 5) | n]) : n < 256 ? Buffer.from([(m << 5) | 24, n]) : n < 65536 ? Buffer.from([(m << 5) | 25, n >> 8, n & 0xff]) : (() => { const b = Buffer.alloc(5); b[0] = (m << 5) | 26; b.writeUInt32BE(n >>> 0, 1); return b; })();
const ci = (n) => (n >= 0 ? cu(0, n) : cu(1, -1 - n));
const cbb = (b) => Buffer.concat([cu(2, b.length), b]);
const ct = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([cu(3, b.length), b]); };
const cmap = (e) => Buffer.concat([cu(5, e.length), ...e.flatMap(([k, v]) => [k, v])]);

function makeAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url"), y = Buffer.from(jwk.y, "base64url");
  const credId = randomBytes(32);
  const cose = cmap([[ci(1), ci(2)], [ci(3), ci(-7)], [ci(-1), ci(1)], [ci(-2), cbb(x)], [ci(-3), cbb(y)]]);
  const authData = (flags, count, withCred) => Buffer.concat([sha256(RP_ID), Buffer.from([flags]), Buffer.from([0, 0, 0, count]), ...(withCred ? [Buffer.alloc(16), Buffer.from([credId.length >> 8, credId.length & 0xff]), credId, cose] : [])]);
  let counter = 0;
  return {
    register(options) {
      const client = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
      const att = cmap([[ct("fmt"), ct("none")], [ct("attStmt"), cmap([])], [ct("authData"), cbb(authData(0x45, 0, true))]]);
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(client), attestationObject: b64u(att) } };
    },
    authenticate(options, { increment = true, tamper = false, forceCount } = {}) {
      if (forceCount === undefined && increment) counter++;
      const useCount = forceCount === undefined ? counter : forceCount;
      const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
      const ad = authData(0x05, useCount, false);
      const sig = ecsign("sha256", Buffer.concat([ad, sha256(client)]), privateKey);
      if (tamper) sig[10] ^= 0xff;
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(client), authenticatorData: b64u(ad), signature: b64u(sig) } };
    },
  };
}

// ---- Ed25519 device identity ----------------------------------------------
async function makeIdentity(deviceId) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return { deviceId, publicKey: pub, async sign(bytes) { return b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes))); } };
}
const hsPayload = (deviceId, nonce) => new TextEncoder().encode(`glass:handshake:v1\n${deviceId}\n${nonce}`);

// ---- process + peer -------------------------------------------------------
function startProc(name, args, readyRe) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => { const m = err.match(readyRe); if (m) { clearInterval(iv); resolve(m); } }, 25);
    cp.once("exit", (c) => { clearInterval(iv); reject(new Error(`${name} exited (${c}): ${err}`)); });
    setTimeout(() => { clearInterval(iv); reject(new Error(`${name} not ready: ${err}`)); }, 8000);
  });
  return { cp, ready };
}

class Peer {
  constructor(url, id) {
    this.id = id;
    this.envs = [];
    this.waiters = [];
    this.closeCode = null;
    this.ws = new WebSocket(url);
    this.opened = new Promise((res) => this.ws.addEventListener("open", res, { once: true }));
    this.ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let env; try { env = JSON.parse(ev.data); } catch { return; }
      this.envs.push(env);
      this.waiters = this.waiters.filter((w) => (w.pred(env) ? (w.resolve(env), false) : true));
    });
    this.ws.addEventListener("close", (ev) => { this.closeCode = ev.code; for (const w of this.waiters) w.reject(new Error(`closed ${ev.code}`)); this.waiters = []; });
    this.ws.addEventListener("error", () => {});
  }
  send(body, to = "hub", extra = {}) { const id = randomUUID(); this.ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), from: this.id, to, body, ...extra })); return id; }
  waitFor(pred, label, ms = 6000) {
    const hit = this.envs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => { const w = { pred, resolve, reject }; this.waiters.push(w); setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`timeout ${label}`)); }, ms); });
  }
  close() { try { this.ws.close(); } catch {} }
}

// Owner: run a credential ceremony to become an approver.
async function ownerRegister(url, authr, token) {
  const p = new Peer(url, "owner");
  await p.opened;
  const id = p.send({ type: "credential.register.begin", token, name: "owner" });
  const opts = await p.waitFor((e) => e.body?.type === "credential.options" && e.replyTo === id, "reg options");
  p.send({ type: "credential.register.finish", response: authr.register(opts.body.options) });
  const res = await p.waitFor((e) => e.body?.type === "credential.result" && e.body.scope === "register", "reg result");
  return { peer: p, ok: res.body.ok };
}
async function ownerAuth(url, authr, authOpts = {}) {
  const p = new Peer(url, "owner");
  await p.opened;
  const id = p.send({ type: "credential.auth.begin" });
  const opts = await p.waitFor((e) => e.body?.type === "credential.options" && e.replyTo === id, "auth options");
  const assertion = authr.authenticate(opts.body.options, authOpts);
  p.send({ type: "credential.auth.finish", response: assertion });
  const res = await p.waitFor((e) => e.body?.type === "credential.result" && e.body.scope === "auth", "auth result", 4000).catch(() => null);
  return { peer: p, ok: !!res?.body.ok, options: opts.body.options, assertion };
}
async function deviceAuthenticates(url, identity) {
  const p = new Peer(url, identity.deviceId);
  await p.opened;
  const helloId = p.send({ type: "hello", deviceId: identity.deviceId, deviceName: identity.deviceId, roles: ["agent"], protocolVersion: 1, appVersion: "harness", etch: { present: false } });
  const ch = await p.waitFor((e) => e.body?.type === "hello.challenge" && e.replyTo === helloId, "challenge");
  p.send({ type: "hello.proof", deviceId: identity.deviceId, signature: await identity.sign(hsPayload(identity.deviceId, ch.body.nonce)) });
  const ack = await p.waitFor((e) => e.body?.type === "hello.ack", "ack").then(() => true).catch(() => false);
  p.close();
  return ack;
}

// ---- the test -------------------------------------------------------------
let hub;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P2 M2 passkey bootstrap\x1b[0m\n");

  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--cred-store", CS, "--register-token", TOKEN, "--rp-id", RP_ID, "--origin", ORIGIN, "--enroll-ttl-ms", "5000"], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];

  const authr = makeAuthenticator();

  // CHECK 1 — registration requires the bootstrap token.
  {
    const p = new Peer(url, "owner");
    await p.opened;
    p.send({ type: "credential.register.begin", name: "owner" }); // no token
    await sleep(300);
    check("passkey registration is token-gated", p.closeCode === 4007, `close=${p.closeCode}`);
  }

  // CHECK 2 — registration with the token succeeds; the session becomes an approver.
  const owner = await ownerRegister(url, authr, TOKEN);
  check("owner registers a passkey with the token", owner.ok);

  // CHECK 3 — the passkey-authed owner approves a device enrollment with NO device approver.
  {
    const pro = await makeIdentity("pro");
    const dev = new Peer(url, "pro");
    await dev.opened;
    const code = "314159";
    const reqId = dev.send({ type: "device.enroll.request", deviceId: "pro", deviceName: "Pro", roles: ["agent"], publicKey: pro.publicKey, verificationCode: code });
    await dev.waitFor((e) => e.body?.type === "device.enroll.pending" && e.replyTo === reqId, "dev ack");
    const bcast = await owner.peer.waitFor((e) => e.body?.type === "device.enroll.pending", "owner sees pending");
    check("passkey session receives the enrollment broadcast", bcast.body.verificationCode === code);
    const decId = owner.peer.send({ type: "device.enroll.decision", requestId: bcast.body.requestId, approved: true, verificationCode: code });
    const dec = await owner.peer.waitFor((e) => e.body?.type === "device.enroll.decision" && e.replyTo === decId, "decision");
    check("passkey owner approves enrollment (approvedBy hub-credential)", dec.body.approved === true && dec.body.approvedBy === "hub-credential");
    await sleep(200);
    dev.close();
    check("device enrolled via passkey then authenticates by key", await deviceAuthenticates(url, pro));
  }

  // CHECK 4 — passkey authentication on a fresh connection.
  const auth1 = await ownerAuth(url, authr);
  check("owner authenticates with the passkey", auth1.ok);

  // CHECK 5 — a replayed assertion (old challenge) is refused.
  {
    const p = new Peer(url, "owner");
    await p.opened;
    const id = p.send({ type: "credential.auth.begin" });
    await p.waitFor((e) => e.body?.type === "credential.options" && e.replyTo === id, "auth options");
    p.send({ type: "credential.auth.finish", response: auth1.assertion }); // old challenge
    await sleep(400);
    const ok = p.envs.some((e) => e.body?.type === "credential.result" && e.body.ok);
    check("replayed assertion refused", !ok && p.closeCode !== null, `close=${p.closeCode}`);
  }

  // CHECK 6 — a forged (tampered-signature) assertion is refused.
  {
    const res = await ownerAuth(url, authr, { tamper: true });
    check("forged assertion refused", !res.ok);
    res.peer.close();
  }

  // CHECK 7 — a counter-regressed assertion is refused (clone / replay defense).
  {
    await ownerAuth(url, authr, { forceCount: 50 }).then((r) => r.peer.close()); // stored counter -> 50
    const res = await ownerAuth(url, authr, { forceCount: 50 }); // 50 is not > 50 -> regression
    check("counter regression refused", !res.ok);
    res.peer.close();
  }

  // CHECK 8 — credentials persist across a hub restart.
  {
    hub.cp.kill("SIGTERM");
    await sleep(300);
    hub = startProc("hub2", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--cred-store", CS, "--register-token", TOKEN, "--rp-id", RP_ID, "--origin", ORIGIN], /listening on (ws:\/\/\S+)/);
    const url2 = (await hub.ready)[1];
    const res = await ownerAuth(url2, authr, { forceCount: 100 }); // above the stored counter
    check("passkey credential survives hub restart", res.ok);
    res.peer.close();
  }

  owner.peer.close();
}

async function cleanup() {
  try { if (hub?.cp?.pid) hub.cp.kill("SIGTERM"); } catch {}
  await sleep(200);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 60s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 60000);
run()
  .then(async () => {
    clearTimeout(hardTimeout);
    await cleanup();
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch(async (err) => {
    clearTimeout(hardTimeout);
    console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`);
    await cleanup();
    process.exit(1);
  });
