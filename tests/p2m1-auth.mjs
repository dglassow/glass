/**
 * Phase 2 · Milestone 1 — acceptance test for device-key auth + enrollment.
 *
 * Independent and adversarial like the earlier harnesses: Node's global
 * WebSocket, hand-built JSON envelopes, and REAL Ed25519 via Node WebCrypto —
 * and it reimplements the signed-payload construction itself, so the test can't
 * pass because our code agrees with itself. It proves a trusted device is
 * admitted, unknown/bad-signature/replayed peers are refused (and can't evict a
 * live connection), the full number-matching enrollment loop, that a wrong code
 * or an unauthenticated approver never enrolls, and that trust survives a hub
 * restart. CHECK 13 boots the real agent under enforcement end-to-end.
 *
 * Run after `pnpm build`:  node tests/p2m1-auth.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-p2m1-${process.pid}`;
const TS = `${RUN}/trust.json`;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const info = (m) => console.log(`  \x1b[90m····\x1b[0m  ${m}`);

// ---- independent crypto + encoding ----------------------------------------
function b64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function payload(deviceId, nonce) {
  return new TextEncoder().encode(`glass:handshake:v1\n${deviceId}\n${nonce}`);
}
async function makeIdentity(deviceId) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const pkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  return {
    deviceId,
    publicKey: pub,
    keyFileJson: JSON.stringify({ v: 1, deviceId, publicKey: pub, privateKeyPkcs8: pkcs8 }, null, 2),
    async sign(bytes) {
      return b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes)));
    },
  };
}

// ---- process helpers ------------------------------------------------------
function startProc(name, args, readyRe) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      const m = err.match(readyRe);
      if (m) {
        clearInterval(iv);
        resolve(m);
      }
    }, 25);
    cp.once("exit", (code) => {
      clearInterval(iv);
      reject(new Error(`${name} exited early (${code}). stderr:\n${err}`));
    });
    setTimeout(() => {
      clearInterval(iv);
      reject(new Error(`${name} not ready in 8s. stderr:\n${err}`));
    }, 8000);
  });
  return { cp, ready };
}
const aliveP = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function trustAdd(id, name, publicKey, roles = "agent") {
  execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", name, "--public-key", publicKey, "--roles", roles], { encoding: "utf8" });
}

// ---- a raw WebSocket peer -------------------------------------------------
class Peer {
  constructor(url, id) {
    this.id = id;
    this.envs = [];
    this.waiters = [];
    this.closeCode = null;
    this.acked = false;
    this.ws = new WebSocket(url);
    this.opened = new Promise((res) => this.ws.addEventListener("open", res, { once: true }));
    this.ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let env;
      try {
        env = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.envs.push(env);
      if (env?.body?.type === "hello.ack") this.acked = true;
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(env)) {
          w.resolve(env);
          return false;
        }
        return true;
      });
    });
    this.ws.addEventListener("close", (ev) => {
      this.closeCode = ev.code;
      for (const w of this.waiters) w.reject(new Error(`closed ${ev.code}`));
      this.waiters = [];
    });
    this.ws.addEventListener("error", () => {});
  }
  send(body, to = "hub", extra = {}) {
    const id = randomUUID();
    this.ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), from: this.id, to, body, ...extra }));
    return id;
  }
  waitFor(pred, label, ms = 5000) {
    const hit = this.envs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timeout waiting for ${label}`));
      }, ms);
    });
  }
  hello(roles = ["viewer"]) {
    return this.send({ type: "hello", deviceId: this.id, deviceName: this.id, roles, protocolVersion: 1, appVersion: "harness", etch: { present: false } });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// Full successful handshake; returns { ack, nonce }.
async function authenticate(url, identity, roles = ["viewer"]) {
  const p = new Peer(url, identity.deviceId);
  await p.opened;
  const helloId = p.hello(roles);
  const ch = await p.waitFor((e) => e.body?.type === "hello.challenge" && e.replyTo === helloId, "challenge");
  const sig = await identity.sign(payload(identity.deviceId, ch.body.nonce));
  p.send({ type: "hello.proof", deviceId: identity.deviceId, signature: sig });
  const ack = await p.waitFor((e) => e.body?.type === "hello.ack", "ack");
  return { peer: p, ack, nonce: ch.body.nonce };
}

// ---- the test -------------------------------------------------------------
let hub, sessiond, agent;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P2 M1 device-key auth + enrollment\x1b[0m\n");

  const approver = await makeIdentity("approver");
  trustAdd("approver", "Approver", approver.publicKey, "viewer");

  // Bootstrap the agent's key up front (trust add must happen before the hub
  // starts — the file store loads once at startup; enrollment is the runtime path).
  const agentId = await makeIdentity("agent-pro");
  const keyFile = `${RUN}/agent-pro.key.json`;
  writeFileSync(keyFile, agentId.keyFileJson, { mode: 0o600 });
  trustAdd("agent-pro", "Pro", agentId.publicKey, "agent");

  let liveApprover;
  let liveUrl;

  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--enroll-ttl-ms", "3000"], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  info(`hub ${url} (trust mode)`);

  // CHECK 1 — trusted device is admitted after proving key possession.
  const A = await authenticate(url, approver);
  check("trusted device admitted via challenge/response", A.ack.body.compatibility === "ok" && A.ack.from === "hub");
  const devs = await (async () => {
    const id = A.peer.send({ type: "device.list" });
    return (await A.peer.waitFor((e) => e.body?.type === "device.listed" && e.replyTo === id, "device.listed")).body.devices;
  })();
  check("registry reflects the authenticated device", devs.some((d) => d.id === "approver" && d.state === "connected"));

  // CHECK 2 — an unknown device is refused (no challenge, no ack).
  {
    const mallory = await makeIdentity("mallory");
    const p = new Peer(url, "mallory");
    await p.opened;
    p.hello();
    let challenged = false;
    try {
      await p.waitFor((e) => e.body?.type === "hello.challenge", "ch", 1500);
      challenged = true;
    } catch {}
    await sleep(200);
    check("unknown device refused (4007, no challenge)", p.closeCode === 4007 && !challenged && !p.acked, `close=${p.closeCode}`);
    void mallory;
  }

  // CHECK 3 — a trusted id with a BAD signature is refused, and does NOT evict the live connection.
  {
    const wrong = await makeIdentity("approver"); // same id, different key
    const p = new Peer(url, "approver");
    await p.opened;
    const helloId = p.hello();
    const ch = await p.waitFor((e) => e.body?.type === "hello.challenge" && e.replyTo === helloId, "ch");
    p.send({ type: "hello.proof", deviceId: "approver", signature: await wrong.sign(payload("approver", ch.body.nonce)) });
    await sleep(400);
    check("bad signature refused (4008)", p.closeCode === 4008 && !p.acked, `close=${p.closeCode}`);
    const id = A.peer.send({ type: "device.list" });
    const ok = await A.peer.waitFor((e) => e.body?.type === "device.listed" && e.replyTo === id, "list-after-badproof").then(() => true).catch(() => false);
    check("impostor cannot evict the live trusted connection", ok);
  }

  // CHECK 4 — a replayed proof (valid signature, wrong nonce) is refused.
  {
    const p = new Peer(url, "approver");
    await p.opened;
    const helloId = p.hello();
    const ch = await p.waitFor((e) => e.body?.type === "hello.challenge" && e.replyTo === helloId, "ch");
    check("each connection gets a fresh nonce", ch.body.nonce !== A.nonce);
    // sign the OLD nonce with the real key, present it against the new challenge
    p.send({ type: "hello.proof", deviceId: "approver", signature: await approver.sign(payload("approver", A.nonce)) });
    await sleep(400);
    check("replayed proof refused (4008)", p.closeCode === 4008 && !p.acked, `close=${p.closeCode}`);
  }

  // CHECK 5/6 — full number-matching enrollment, then the enrolled device authenticates.
  const newbie = await makeIdentity("newbie");
  {
    const code = "246813";
    const p = new Peer(url, "newbie");
    await p.opened;
    const reqId = p.send({ type: "device.enroll.request", deviceId: "newbie", deviceName: "Newbie", roles: ["agent"], publicKey: newbie.publicKey, verificationCode: code });
    const ack = await p.waitFor((e) => e.body?.type === "device.enroll.pending" && e.replyTo === reqId, "enroll ack");
    const requestId = ack.body.requestId;
    const bcast = await A.peer.waitFor((e) => e.body?.type === "device.enroll.pending" && e.body.requestId === requestId, "enroll broadcast");
    check("enrollment broadcasts to authenticated devices with the code", bcast.body.verificationCode === code && bcast.body.deviceName === "Newbie");

    const decId = A.peer.send({ type: "device.enroll.decision", requestId, approved: true, verificationCode: code });
    const dec = await A.peer.waitFor((e) => e.body?.type === "device.enroll.decision" && e.replyTo === decId, "decision");
    check("approver enrolls with the matching code (hub-stamped approvedBy)", dec.body.approved === true && dec.body.approvedBy === "approver");
    await sleep(200);
    check("requester is notified and its enroll socket is closed", p.envs.some((e) => e.body?.type === "device.enroll.decision" && e.body.approved) && p.closeCode !== null);

    // CHECK 6
    const auth = await authenticate(url, newbie, ["agent"]);
    check("enrolled device authenticates on a fresh connection", auth.ack.body.compatibility === "ok");
    auth.peer.close();

    // CHECK — idempotent re-approval, still one entry
    const dec2 = A.peer.send({ type: "device.enroll.decision", requestId, approved: true, verificationCode: code });
    const r2 = await A.peer.waitFor((e) => e.body?.type === "device.enroll.decision" && e.replyTo === dec2, "reapprove").then(() => true).catch(() => false);
    const listOut = execFileSync("node", [HUB, "trust", "list", "--trust-store", TS], { encoding: "utf8" });
    check("re-approval is idempotent (one trust entry)", r2 && listOut.split("\n").filter((l) => l.startsWith("newbie ")).length === 1);
  }

  // CHECK 7/8 — wrong code voids the request; a voided request can't be resurrected.
  {
    const xdev = await makeIdentity("xdev");
    const code = "111222";
    const p = new Peer(url, "xdev");
    await p.opened;
    const reqId = p.send({ type: "device.enroll.request", deviceId: "xdev", deviceName: "XDev", roles: ["agent"], publicKey: xdev.publicKey, verificationCode: code });
    const ack = await p.waitFor((e) => e.body?.type === "device.enroll.pending" && e.replyTo === reqId, "xdev ack");
    const requestId = ack.body.requestId;
    await A.peer.waitFor((e) => e.body?.type === "device.enroll.pending" && e.body.requestId === requestId, "xdev broadcast");

    const badId = A.peer.send({ type: "device.enroll.decision", requestId, approved: true, verificationCode: "999999" });
    const err = await A.peer.waitFor((e) => e.body?.type === "error" && e.replyTo === badId, "code mismatch");
    check("wrong-code approval is rejected (enroll_code_mismatch)", err.body.code === "enroll_code_mismatch");

    const goodId = A.peer.send({ type: "device.enroll.decision", requestId, approved: true, verificationCode: code });
    const err2 = await A.peer.waitFor((e) => e.body?.type === "error" && e.replyTo === goodId, "voided");
    check("a voided request cannot be resurrected (enroll_unknown_request)", err2.body.code === "enroll_unknown_request");
    p.close();
    void xdev;
  }

  // CHECK 9 — an already-trusted id cannot be re-enrolled (no key overwrite).
  {
    const attacker = await makeIdentity("approver");
    const p = new Peer(url, "approver");
    await p.opened;
    const before = A.peer.envs.length;
    p.send({ type: "device.enroll.request", deviceId: "approver", deviceName: "Evil", roles: ["agent"], publicKey: attacker.publicKey, verificationCode: "000000" });
    await sleep(400);
    const gotBroadcast = A.peer.envs.slice(before).some((e) => e.body?.type === "device.enroll.pending" && e.body.deviceName === "Evil");
    check("already-trusted id cannot be re-enrolled", p.closeCode !== null && !gotBroadcast, `close=${p.closeCode}`);
    // original key still works
    const again = await authenticate(url, approver).then((r) => { r.peer.close(); return true; }).catch(() => false);
    check("original trusted key still authenticates (not overwritten)", again);
  }

  // CHECK 10 — self-approval is structurally impossible (second frame on an enroll socket is refused).
  {
    const ydev = await makeIdentity("ydev");
    const p = new Peer(url, "ydev");
    await p.opened;
    p.send({ type: "device.enroll.request", deviceId: "ydev", deviceName: "YDev", roles: ["agent"], publicKey: ydev.publicKey, verificationCode: "555555" });
    await p.waitFor((e) => e.body?.type === "device.enroll.pending", "ydev ack");
    p.send({ type: "device.enroll.decision", requestId: "anything", approved: true, verificationCode: "555555" }); // self-approve attempt
    await sleep(400);
    check("second frame on an enroll socket is refused (4009)", p.closeCode === 4009, `close=${p.closeCode}`);
  }

  // CHECK 11 — a decision from an unauthenticated socket is not processed.
  {
    const p = new Peer(url, "ghost");
    await p.opened;
    p.send({ type: "device.enroll.decision", requestId: "x", approved: true, verificationCode: "000000" }); // first frame is a decision
    await sleep(300);
    check("unauthenticated decision refused (first frame not hello/enroll)", p.closeCode === 4003, `close=${p.closeCode}`);
  }

  // CHECK 12 — trust persists across a hub restart.
  {
    hub.cp.kill("SIGTERM");
    await sleep(300);
    hub = startProc("hub2", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS], /listening on (ws:\/\/\S+)/);
    const url2 = (await hub.ready)[1];
    const ok = await authenticate(url2, newbie, ["agent"]).then((r) => { r.peer.close(); return true; }).catch(() => false);
    const mallory = await makeIdentity("mallory");
    const pm = new Peer(url2, "mallory");
    await pm.opened;
    pm.hello();
    await sleep(300);
    check("trust survives hub restart (persisted, not in-memory)", ok && pm.closeCode === 4007);
    // rebind an approver connection on the restarted hub for the integration check
    A.peer.close();
    liveUrl = url2;
    liveApprover = await authenticate(url2, approver, ["viewer"]);
  }

  // CHECK 13 — the REAL agent authenticates under enforcement and routing still works.
  {
    const url2 = liveUrl;
    const A2 = liveApprover;
    sessiond = startProc("sessiond", [SESSIOND, "--socket", `${RUN}/sd.sock`], /listening on/);
    await sessiond.ready;
    agent = startProc("agent", [AGENT, "--sessiond", `${RUN}/sd.sock`, "--hub", url2, "--device-id", "agent-pro", "--name", "Pro", "--key", keyFile], /registered with hub/);
    await agent.ready;

    const createId = A2.peer.send({ type: "session.create", kind: "pty", deviceId: "agent-pro", cols: 80, rows: 24 }, "agent-pro");
    const created = await A2.peer.waitFor((e) => e.body?.type === "session.created" && e.replyTo === createId, "session.created");
    const sid = created.body.session.id;
    A2.peer.send({ type: "session.input", sessionId: sid, data: "echo P2M1_OK\r" }, "agent-pro");
    const out = await A2.peer.waitFor((e) => e.body?.type === "session.output" && e.body.sessionId === sid && e.body.data.includes("P2M1_OK"), "output");
    check("real agent authenticates + routing works end-to-end", created.from === "agent-pro" && !!out);
    A2.peer.close();
  }

  A.peer.close();
}

async function cleanup() {
  for (const p of [agent, sessiond, hub]) {
    try {
      if (p?.cp?.pid && aliveP(p.cp.pid)) p.cp.kill("SIGTERM");
    } catch {}
  }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}

const hardTimeout = setTimeout(() => {
  console.error("\n\x1b[31mFATAL: exceeded 90s\x1b[0m");
  cleanup().finally(() => process.exit(1));
}, 90000);

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
