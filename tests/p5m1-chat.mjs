/**
 * Phase 5 · Milestone 1 — acceptance test for the chat provider.
 *
 * The chat session kind runs `etch -z "<message>"` per message and renders the
 * reply into the same session output/scrollback a PTY uses. Real Etch isn't
 * installed here, so the harness points GLASS_ETCH_BIN at a stub that echoes the
 * prompt — proving detection, the subprocess round-trip, message serialization,
 * and that a chat conversation survives a worker restart like any session.
 *
 * Run after `pnpm build`:  node tests/p5m1-chat.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-p5m1-${process.pid}`;
const TS = `${RUN}/trust.json`;
const SD_SOCK = `${RUN}/sd.sock`;
const AGENT_SOCK = `${RUN}/agent.sock`;
const ETCH = `${RUN}/mock-etch`;

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const b64u = (b) => Buffer.from(b).toString("base64url");

async function makeIdentity(id) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const pkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  return { deviceId: id, publicKey: pub, keyFileJson: JSON.stringify({ v: 1, deviceId: id, publicKey: pub, privateKeyPkcs8: pkcs8 }), async sign(bytes) { return b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes))); } };
}
const hsPayload = (id, nonce) => new TextEncoder().encode(`glass:handshake:v1\n${id}\n${nonce}`);
const trustAdd = (id, pub, roles) => execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", id, "--public-key", pub, "--roles", roles]);

function startProc(name, args, readyRe, env) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => { const m = err.match(readyRe); if (m) { clearInterval(iv); resolve(m); } }, 25);
    cp.once("exit", (c) => { clearInterval(iv); reject(new Error(`${name} exited (${c}): ${err}`)); });
    setTimeout(() => { clearInterval(iv); reject(new Error(`${name} not ready: ${err}`)); }, 9000);
  });
  return { cp, ready };
}

class Peer {
  constructor(url, id) { this.id = id; this.envs = []; this.waiters = []; this.ws = new WebSocket(url); this.opened = new Promise((r) => this.ws.addEventListener("open", r, { once: true })); this.ws.addEventListener("message", (ev) => { let e; try { e = JSON.parse(ev.data); } catch { return; } this.envs.push(e); this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true)); }); this.ws.addEventListener("close", () => { for (const w of this.waiters) w.reject(new Error("closed")); this.waiters = []; }); this.ws.addEventListener("error", () => {}); }
  send(body, to = "hub") { const id = randomUUID(); this.ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), from: this.id, to, body })); return id; }
  waitFor(pred, ms = 8000) { const h = this.envs.find(pred); if (h) return Promise.resolve(h); return new Promise((res, rej) => { const w = { pred, resolve: res, reject: rej }; this.waiters.push(w); setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("timeout")); }, ms); }); }
  text(sid) { return this.envs.filter((e) => e.body?.type === "session.output" && e.body.sessionId === sid).map((e) => e.body.data).join(""); }
  close() { try { this.ws.close(); } catch {} }
}
async function auth(url, id, roles) {
  const p = new Peer(url, id.deviceId); await p.opened;
  const hid = p.send({ type: "hello", deviceId: id.deviceId, deviceName: id.deviceId, roles, protocolVersion: 1, appVersion: "harness", etch: { present: false } });
  const ch = await p.waitFor((e) => e.body?.type === "hello.challenge" && e.replyTo === hid);
  p.send({ type: "hello.proof", deviceId: id.deviceId, signature: await id.sign(hsPayload(id.deviceId, ch.body.nonce)) });
  await p.waitFor((e) => e.body?.type === "hello.ack");
  return p;
}

let hub, sessiond, agent, agent2;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P5 M1 chat provider\x1b[0m\n");

  // A stub `etch`: --version reports a version; -z "<prompt>" echoes it.
  writeFileSync(ETCH, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]==="--version"){console.log("etch-mock 9.9.9");process.exit(0);}\nif(a[0]==="-z"){process.stdout.write("You said: "+(a[1]||""));process.exit(0);}\nprocess.exit(1);\n`, { mode: 0o755 });
  chmodSync(ETCH, 0o755);
  const env = { GLASS_ETCH_BIN: ETCH };

  const viewer = await makeIdentity("studio");
  const agentId = await makeIdentity("agent-pro");
  const keyFile = `${RUN}/agent-pro.json`;
  writeFileSync(keyFile, agentId.keyFileJson, { mode: 0o600 });
  trustAdd("studio", viewer.publicKey, "viewer");
  trustAdd("agent-pro", agentId.publicKey, "agent");

  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD_SOCK], /listening on/, env);
  await sessiond.ready;

  agent = startProc("agent", [AGENT, "--sessiond", SD_SOCK, "--hub", url, "--device-id", "agent-pro", "--name", "Pro", "--key", keyFile], /registered with hub/, env);
  await agent.ready;

  const v = await auth(url, viewer, ["viewer"]);

  // CHECK 1 — the agent reports Etch present + version.
  const listId = v.send({ type: "device.list" }, "hub");
  const listed = await v.waitFor((e) => e.body?.type === "device.listed" && e.replyTo === listId);
  const dev = listed.body.devices.find((d) => d.id === "agent-pro");
  check("agent reports Etch detected + version", dev?.etchPresent === true && dev?.appVersion !== undefined, `etchPresent=${dev?.etchPresent}`);

  // CHECK 2 — create a chat session.
  const createId = v.send({ type: "session.create", kind: "chat", deviceId: "agent-pro", cols: 80, rows: 24 }, "agent-pro");
  const created = await v.waitFor((e) => e.body?.type === "session.created" && e.replyTo === createId);
  const sid = created.body.session.id;
  check("chat session created", created.body.session.kind === "chat");

  // CHECK 3 — a message runs etch and returns its reply.
  v.send({ type: "session.input", sessionId: sid, data: "hello there" }, "agent-pro");
  await v.waitFor((e) => e.body?.type === "session.output" && e.body.sessionId === sid && e.body.data.includes("You said: hello there"), 8000);
  check("message round-trips through etch", v.text(sid).includes("You said: hello there"));

  // CHECK 4 — a second message is serialized after the first.
  v.send({ type: "session.input", sessionId: sid, data: "second question" }, "agent-pro");
  await v.waitFor((e) => e.body?.type === "session.output" && e.body.sessionId === sid && e.body.data.includes("You said: second question"), 8000);
  check("messages serialize (both replies present)", v.text(sid).includes("You said: hello there") && v.text(sid).includes("You said: second question"));

  // CHECK 5 — the conversation survives a worker kill+restart (scrollback from sessiond).
  agent.cp.kill("SIGKILL");
  await sleep(500);
  agent2 = startProc("agent2", [AGENT, "--sessiond", SD_SOCK, "--hub", url, "--device-id", "agent-pro", "--name", "Pro", "--key", keyFile], /registered with hub/, env);
  await agent2.ready;
  await sleep(500);
  const attachId = v.send({ type: "session.attach", sessionId: sid }, "agent-pro");
  const attached = await v.waitFor((e) => e.body?.type === "session.attached" && e.replyTo === attachId, 8000);
  check("chat scrollback survives worker restart", attached.body.scrollback.includes("You said: hello there") && attached.body.scrollback.includes("second question"));

  v.close();
}

async function cleanup() {
  for (const p of [agent, agent2, sessiond, hub]) { try { if (p?.cp?.pid) p.cp.kill("SIGTERM"); } catch {} }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 60s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 60000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
