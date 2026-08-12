/**
 * Phase 1 · Milestone 2 — acceptance test for the Hub loop.
 *
 * Proves a Viewer runs a shell on a named Agent THROUGH the Hub, and that the
 * M1 survival property still holds with the Hub in the path: kill and restart
 * the agent (worker) and the shell keeps running in sessiond, scrollback intact,
 * including output produced while no agent existed.
 *
 * Independent and adversarial, like the M1 harness: the viewer is Node's global
 * WebSocket (undici) — NOT the hub's `ws` library and NOT @glass/protocol — so
 * the test can't pass just because our code agrees with itself. Envelopes are
 * hand-built JSON. It also pins the routing hygiene the design depends on:
 * unknown-device errors, from-spoofing rejection, cross-viewer isolation (the
 * sessiond conn.peer trap), and that only sessiond ever emits session.exited.
 *
 * Run after `pnpm build`:  node tests/m2-acceptance.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const HUB = `${ROOT}packages/hub/dist/main.js`;

const RUN = `/tmp/glass-m2-${process.pid}`;
const SD_SOCK = `${RUN}/sd.sock`;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const info = (m) => console.log(`  \x1b[90m····\x1b[0m  ${m}`);

// ---- process + os helpers (shared with m1) --------------------------------
function startProc(name, args, readyRe) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  cp.stdout.on("data", () => {});
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
      reject(new Error(`${name} exited early (code ${code}). stderr:\n${err}`));
    });
    setTimeout(() => {
      clearInterval(iv);
      reject(new Error(`${name} not ready in 8s. stderr:\n${err}`));
    }, 8000);
  });
  return { cp, ready, err: () => err };
}
const aliveP = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const psField = (pid, f) => {
  try {
    return execFileSync("ps", ["-o", `${f}=`, "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const childrenOf = (ppid) => {
  try {
    return execFileSync("pgrep", ["-P", String(ppid)], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const ticks = (s) => {
  const set = new Set();
  for (const m of s.matchAll(/TICK(\d+)/g)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
};
const contiguous = (n) => n.every((v, i) => i === 0 || v === n[i - 1] + 1);

// ---- a raw WebSocket viewer (undici global WebSocket) ----------------------
class Peer {
  constructor(url, id, { roles = ["viewer"], hello = true } = {}) {
    this.id = id;
    this.envs = [];
    this.waiters = [];
    this.violations = 0;
    this.helloId = null;
    this.ws = new WebSocket(url);
    this.opened = new Promise((res) => this.ws.addEventListener("open", res, { once: true }));
    this.acked = new Promise((res) => (this._ack = res));
    this.ws.addEventListener("open", () => {
      if (hello) {
        this.helloId = this.send(
          { type: "hello", deviceId: id, deviceName: id, roles, protocolVersion: 1, appVersion: "harness", etch: { present: false } },
          "hub",
        );
      }
    });
    this.ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") {
        this.violations++;
        return;
      }
      let env;
      try {
        env = JSON.parse(ev.data);
      } catch {
        this.violations++;
        return;
      }
      if (!env || typeof env !== "object" || env.v === undefined || env.body === undefined) this.violations++;
      this.envs.push(env);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(env)) {
          w.resolve(env);
          return false;
        }
        return true;
      });
      if (env?.body?.type === "hello.ack") this._ack(env);
    });
    this.ws.addEventListener("close", () => (this.closedFlag = true));
  }
  send(body, to, extra = {}) {
    const id = randomUUID();
    this.ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), from: this.id, to, body, ...extra }));
    return id;
  }
  sendRaw(env) {
    this.ws.send(JSON.stringify(env));
  }
  waitFor(pred, label, timeoutMs = 6000) {
    const found = this.envs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
    });
  }
  outputs(sid) {
    return this.envs.filter((e) => e.body?.type === "session.output" && e.body.sessionId === sid);
  }
  text(sid) {
    return this.outputs(sid).map((e) => e.body.data).join("");
  }
  maxSeq(sid) {
    return this.outputs(sid).reduce((m, e) => Math.max(m, e.body.seq), 0);
  }
  exitedFor(sid) {
    return this.envs.find((e) => e.body?.type === "session.exited" && e.body.sessionId === sid);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function pollDeviceList(peer, predicate, capMs) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const id = peer.send({ type: "device.list" }, "hub");
    try {
      const listed = await peer.waitFor((e) => e.body?.type === "device.listed" && e.replyTo === id, "device.listed", 600);
      const hit = listed.body.devices.find(predicate);
      if (hit) return hit;
    } catch {}
    await sleep(150);
  }
  return null;
}

// ---- the test -------------------------------------------------------------
let sessiond, hub, agent1, agent2;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — M2 Hub-loop acceptance test\x1b[0m\n");

  // 1. sessiond + hub up. Parse the hub's ephemeral ws:// URL from stderr.
  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD_SOCK], /listening on/);
  await sessiond.ready;
  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0"], /listening on (ws:\/\/\S+)/);
  const hubUrl = (await hub.ready)[1];
  info(`sessiond pid=${sessiond.cp.pid}, hub ${hubUrl} pid=${hub.cp.pid}`);

  // 2. Viewer handshake.
  const a = new Peer(hubUrl, "studio");
  const ack = await a.acked;
  check("hub handshake (hello.ack)", ack.replyTo === a.helloId && ack.body.compatibility === "ok" && ack.from === "hub" && ack.to === "studio",
    `compat=${ack.body.compatibility}`);

  // 3. Unknown device errors explicitly (no silent drop) — agent not up yet.
  {
    const id = a.send({ type: "session.create", kind: "pty", deviceId: "ghost", cols: 80, rows: 24 }, "ghost");
    let errEnv = null;
    try {
      errEnv = await a.waitFor((e) => e.body?.type === "error" && e.replyTo === id, "unknown-device error", 2500);
    } catch {}
    check("unknown device -> explicit error", !!errEnv && /device_unknown|device_unreachable/.test(errEnv.body.code), errEnv ? errEnv.body.code : "no error");
  }

  // 4. Start the agent; it registers with the hub.
  agent1 = startProc("agent", [AGENT, "--sessiond", SD_SOCK, "--hub", hubUrl, "--device-id", "agent-pro", "--name", "Pro"], /registered with hub/);
  await agent1.ready;
  const listed = await pollDeviceList(a, (d) => d.id === "agent-pro" && d.state === "connected", 8000);
  check("registry lists the agent with role", !!listed && listed.roles.includes("agent"), listed ? `state=${listed.state} roles=${listed.roles}` : "not listed");

  // 5. No routing before handshake.
  {
    const c = new Peer(hubUrl, "viewer-c", { hello: false });
    await c.opened;
    c.sendRaw({ v: 1, id: randomUUID(), ts: Date.now(), from: "viewer-c", to: "studio", body: { type: "session.output", sessionId: "x", data: "PREHANDSHAKE", seq: 1 } });
    await sleep(1200);
    const leaked = a.envs.some((e) => JSON.stringify(e).includes("PREHANDSHAKE"));
    check("no routing before handshake", !leaked && c.closedFlag === true, leaked ? "leaked!" : c.closedFlag ? "peer closed" : "peer still open");
    c.close();
  }

  // 6. Create a pty session on the named agent, through the hub.
  const createId = a.send({ type: "session.create", kind: "pty", deviceId: "agent-pro", cols: 80, rows: 24 }, "agent-pro");
  const created = await a.waitFor((e) => e.body?.type === "session.created" && e.replyTo === createId, "session.created");
  const sid = created.body.session.id;
  check("create + addressing through hub", created.from === "agent-pro" && created.to === "studio" && created.body.session.deviceId === "agent-pro",
    `sid=${sid}`);

  // 7. Live streaming + seq ordering.
  await sleep(500);
  a.send({ type: "session.input", sessionId: sid, data: "i=0; while true; do echo TICK$i; i=$((i+1)); sleep 0.2; done\r" }, "agent-pro");
  await sleep(2000);
  const before = ticks(a.text(sid));
  const outsOk = a.outputs(sid).every((e) => e.from === "agent-pro" && e.to === "studio");
  const lastSeqBefore = a.maxSeq(sid);
  check("routed live streaming", before.length >= 3 && outsOk, `ticks up to ${before.at(-1)}, all from agent-pro=${outsOk}`);

  // 8. Shell owned by sessiond.
  const shellPid = childrenOf(sessiond.cp.pid)[0];
  check("PTY child owned by sessiond", shellPid !== undefined && Number(psField(shellPid, "ppid")) === sessiond.cp.pid,
    `shell=${shellPid} ppid=${psField(shellPid, "ppid")}`);

  // 9. SIGKILL the worker.
  process.kill(agent1.cp.pid, "SIGKILL");
  await sleep(250);
  check("shell survives worker kill through hub", aliveP(shellPid) && Number(psField(shellPid, "ppid")) === sessiond.cp.pid && !psField(shellPid, "stat").includes("Z"),
    `alive=${aliveP(shellPid)} stat=${psField(shellPid, "stat")}`);

  // 10. Hub marks the agent waiting.
  const waiting = await pollDeviceList(a, (d) => d.id === "agent-pro" && d.state !== "connected", 4000);
  check("hub marks the agent waiting (record kept)", !!waiting && waiting.state === "waiting", waiting ? waiting.state : "gone");

  // 11. Input while down -> device_unreachable, and NO false exit at the viewer.
  {
    const id = a.send({ type: "session.input", sessionId: sid, data: "echo nope\r" }, "agent-pro");
    let e = null;
    try {
      e = await a.waitFor((x) => x.body?.type === "error" && x.replyTo === id, "device_unreachable", 2500);
    } catch {}
    check("input during outage -> device_unreachable", !!e && e.body.code === "device_unreachable", e ? e.body.code : "no error");
  }

  // 12. Let the counter run with NO worker attached anywhere.
  await sleep(2000);

  // 13. Restart the agent under the SAME device id (exercises stale-socket replace).
  agent2 = startProc("agent2", [AGENT, "--sessiond", SD_SOCK, "--hub", hubUrl, "--device-id", "agent-pro", "--name", "Pro"], /registered with hub/);
  await agent2.ready;
  const back = await pollDeviceList(a, (d) => d.id === "agent-pro" && d.state === "connected", 8000);
  check("same-id re-registration after kill", !!back, back ? "connected" : "not back");

  // 14. FRESH viewer B re-attaches — scrollback can only come from sessiond.
  const b = new Peer(hubUrl, "studio2");
  await b.acked;
  const attachId = b.send({ type: "session.attach", sessionId: sid }, "agent-pro");
  const attached = await b.waitFor((e) => e.body?.type === "session.attached" && e.replyTo === attachId, "session.attached");
  const sb = ticks(attached.body.scrollback);
  check("re-attach + scrollback spans the outage (from sessiond)",
    sb.length > 0 && sb[0] === 0 && contiguous(sb) && sb.at(-1) > before.at(-1),
    `fresh-client scrollback ticks 0..${sb.at(-1)}, last-before=${before.at(-1)}, contiguous=${contiguous(sb)}`);

  // 15. Live I/O + seq continuity through the hub.
  const marker = `REATTACH_${randomUUID().slice(0, 8)}`;
  b.send({ type: "session.input", sessionId: sid, data: `echo ${marker}\r` }, "agent-pro");
  await b.waitFor((e) => e.body?.type === "session.output" && e.body.sessionId === sid && e.body.data.includes(marker), "marker echo");
  const firstSeqAfter = b.outputs(sid)[0]?.body.seq ?? 0;
  check("live I/O restored + seq never resets", firstSeqAfter > lastSeqBefore, `first post-reattach seq ${firstSeqAfter} > ${lastSeqBefore}`);

  // 16. Cross-viewer / cross-session isolation (the sessiond conn.peer trap).
  const createId2 = a.send({ type: "session.create", kind: "pty", deviceId: "agent-pro", cols: 80, rows: 24 }, "agent-pro");
  const created2 = await a.waitFor((e) => e.body?.type === "session.created" && e.replyTo === createId2, "session.created 2");
  const sid2 = created2.body.session.id;
  await sleep(300);
  const alpha = `ALPHA_${randomUUID().slice(0, 6)}`;
  const bravo = `BRAVO_${randomUUID().slice(0, 6)}`;
  a.send({ type: "session.input", sessionId: sid2, data: `echo ${alpha}\r` }, "agent-pro");
  b.send({ type: "session.input", sessionId: sid, data: `echo ${bravo}\r` }, "agent-pro");
  await sleep(1500);
  const aSid2 = a.text(sid2).includes(alpha);
  const bSid = b.text(sid).includes(bravo);
  const noLeakA = !a.text(sid2).includes(bravo) && !a.outputs(sid).some((e) => e.body.data.includes(bravo));
  const noLeakB = !b.text(sid).includes(alpha);
  check("no cross-viewer / cross-session leakage", aSid2 && bSid && noLeakA && noLeakB,
    `A@sid2=${aSid2} B@sid=${bSid} noLeak=${noLeakA && noLeakB}`);

  // 17. from-spoofing is rejected (routing hygiene, auth stubbed).
  {
    const s = new Peer(hubUrl, "viewer-s");
    await s.acked;
    const spoofId = randomUUID();
    s.sendRaw({ v: 1, id: spoofId, ts: Date.now(), from: "agent-pro", to: "studio", body: { type: "session.output", sessionId: sid, data: "FORGED", seq: 999999 } });
    await sleep(1200);
    const leaked = a.envs.some((e) => JSON.stringify(e).includes("FORGED"));
    const rejected = s.envs.some((e) => e.body?.type === "error" && e.body.code === "unauthorized") || s.closedFlag === true;
    check("hub binds from to socket identity (spoof rejected)", !leaked && rejected, leaked ? "leaked!" : "rejected");
    s.close();
  }

  // 18. No false session.exited anywhere across the whole run so far.
  check("no false session.exited (whole run)", !a.exitedFor(sid) && !a.exitedFor(sid2) && !b.exitedFor(sid), "");

  // 19. A real exit IS delivered (anti-cheat for #18).
  b.send({ type: "session.close", sessionId: sid }, "agent-pro");
  a.send({ type: "session.close", sessionId: sid2 }, "agent-pro");
  let realExit = false;
  try {
    await b.waitFor((e) => e.body?.type === "session.exited" && e.body.sessionId === sid, "exit sid", 3000);
    await a.waitFor((e) => e.body?.type === "session.exited" && e.body.sessionId === sid2, "exit sid2", 3000);
    realExit = true;
  } catch {}
  check("real exit is delivered on session.close", realExit, "");

  // 20. Framing discipline: one valid JSON envelope per WS text message.
  check("framing discipline on the hub link", a.violations === 0 && b.violations === 0, `violations a=${a.violations} b=${b.violations}`);

  a.close();
  b.close();
}

async function cleanup() {
  for (const p of [agent1, agent2, hub, sessiond]) {
    try {
      if (p?.cp?.pid && aliveP(p.cp.pid)) process.kill(p.cp.pid, "SIGTERM");
    } catch {}
  }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}

const hardTimeout = setTimeout(() => {
  console.error("\n\x1b[31mFATAL: test exceeded 60s — aborting\x1b[0m");
  cleanup().finally(() => process.exit(1));
}, 60000);

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
