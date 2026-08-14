/**
 * Phase 4 · Milestone 1 — acceptance test for supervision + blue/green swap.
 *
 * The supervisor runs sessiond + a worker; a viewer runs a shell through the
 * hub; then a swap is triggered on the control socket. Proves: health-BEFORE
 * retire ordering (ready precedes retired), the shell is never interrupted
 * (same pid, still a child of sessiond), the session continues with contiguous
 * scrollback across the swap and a non-reset seq, the worker generation
 * advanced, and a swap to a broken worker rolls back to blue with the session
 * intact. It also proves unexpected worker/sessiond exits are recovered: a
 * worker crash preserves the live shell, while a sessiond crash replaces both
 * the daemon and its dependent worker and restores service.
 *
 * Run after `pnpm build`:  node tests/p4m1-swap.mjs
 */
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const SUPER = `${ROOT}packages/supervisor/dist/main.js`;
const RUN = `/tmp/glass-p4m1-${process.pid}`;
const TS = `${RUN}/trust.json`;

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const info = (m) => console.log(`  \x1b[90m····\x1b[0m  ${m}`);
const b64u = (b) => Buffer.from(b).toString("base64url");

async function makeIdentity(id) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const pkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  return { deviceId: id, publicKey: pub, keyFileJson: JSON.stringify({ v: 1, deviceId: id, publicKey: pub, privateKeyPkcs8: pkcs8 }), async sign(bytes) { return b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes))); } };
}
const hsPayload = (id, nonce) => new TextEncoder().encode(`glass:handshake:v1\n${id}\n${nonce}`);
const trustAdd = (id, pub, roles) => execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", id, "--public-key", pub, "--roles", roles]);

function startProc(name, args, readyRe) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => { const m = err.match(readyRe); if (m) { clearInterval(iv); resolve(m); } }, 25);
    cp.once("exit", (c) => { clearInterval(iv); reject(new Error(`${name} exited (${c}): ${err}`)); });
    setTimeout(() => { clearInterval(iv); reject(new Error(`${name} not ready: ${err}`)); }, 10000);
  });
  return { cp, ready };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ppidOf = (pid) => { try { return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()); } catch { return -1; } };
const childrenOf = (ppid) => { try { return execFileSync("pgrep", ["-P", String(ppid)], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
const ticks = (s) => { const set = new Set(); for (const m of s.matchAll(/TICK(\d+)/g)) set.add(Number(m[1])); return [...set].sort((a, b) => a - b); };
const contiguous = (n) => n.every((v, i) => i === 0 || v === n[i - 1] + 1);

function control(line, until, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const s = net.connect(`${RUN}/supervisor.sock`);
    let buf = "";
    let finished = false;
    let timer;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { s.end(); } catch {}
      resolve(buf);
    };
    s.on("connect", () => s.write(line + "\n"));
    s.on("data", (d) => { buf += d.toString(); if (until(buf)) done(); });
    s.on("error", done);
    timer = setTimeout(done, timeoutMs);
  });
}

async function waitStatus(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = (await control("status", (b) => b.includes("\n"), 2000)).trim();
    if (raw) {
      const status = JSON.parse(raw);
      if (predicate(status)) return status;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class Peer {
  constructor(url, id) { this.id = id; this.envs = []; this.waiters = []; this.ws = new WebSocket(url); this.opened = new Promise((r) => this.ws.addEventListener("open", r, { once: true })); this.ws.addEventListener("message", (ev) => { let e; try { e = JSON.parse(ev.data); } catch { return; } this.envs.push(e); this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true)); }); this.ws.addEventListener("close", () => { for (const w of this.waiters) w.reject(new Error("closed")); this.waiters = []; }); this.ws.addEventListener("error", () => {}); }
  send(body, to = "hub") { const id = randomUUID(); this.ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), from: this.id, to, body })); return id; }
  waitFor(pred, ms = 6000) { const h = this.envs.find(pred); if (h) return Promise.resolve(h); return new Promise((res, rej) => { const w = { pred, resolve: res, reject: rej }; this.waiters.push(w); setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("timeout")); }, ms); }); }
  outputs(sid) { return this.envs.filter((e) => e.body?.type === "session.output" && e.body.sessionId === sid); }
  text(sid) { return this.outputs(sid).map((e) => e.body.data).join(""); }
  maxSeq(sid) { return this.outputs(sid).reduce((m, e) => Math.max(m, e.body.seq), 0); }
  close() { try { this.ws.close(); } catch {} }
}
async function authViewer(url, id) {
  const p = new Peer(url, id.deviceId); await p.opened;
  const hid = p.send({ type: "hello", deviceId: id.deviceId, deviceName: id.deviceId, roles: ["viewer"], protocolVersion: 1, appVersion: "harness", etch: { present: false } });
  const ch = await p.waitFor((e) => e.body?.type === "hello.challenge" && e.replyTo === hid);
  p.send({ type: "hello.proof", deviceId: id.deviceId, signature: await id.sign(hsPayload(id.deviceId, ch.body.nonce)) });
  await p.waitFor((e) => e.body?.type === "hello.ack");
  return p;
}

let hub, sup;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P4 M1 blue/green worker swap\x1b[0m\n");

  const viewer = await makeIdentity("studio");
  const agentId = await makeIdentity("agent-pro");
  const keyFile = `${RUN}/agent-pro.json`;
  writeFileSync(keyFile, agentId.keyFileJson, { mode: 0o600 });
  trustAdd("studio", viewer.publicKey, "viewer");
  trustAdd("agent-pro", agentId.publicKey, "agent");

  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  sup = startProc("supervisor", [SUPER, "--run-dir", RUN, "--sessiond-entry", SESSIOND, "--worker-entry", AGENT, "--", "--hub", url, "--device-id", "agent-pro", "--name", "Pro", "--key", keyFile], /supervisor: up/);
  await sup.ready;
  info(`hub ${url}, supervisor up`);

  // Viewer runs a shell + counter.
  const v = await authViewer(url, viewer);
  const createId = v.send({ type: "session.create", kind: "pty", deviceId: "agent-pro", cols: 80, rows: 24 }, "agent-pro");
  const created = await v.waitFor((e) => e.body?.type === "session.created" && e.replyTo === createId);
  const sid = created.body.session.id;
  await sleep(400);
  v.send({ type: "session.input", sessionId: sid, data: "i=0; while true; do echo TICK$i; i=$((i+1)); sleep 0.2; done\r" }, "agent-pro");
  await sleep(1800);
  const before = ticks(v.text(sid));
  const lastSeqBefore = v.maxSeq(sid);
  check("worker serves the session", before.length >= 3, `ticks up to ${before.at(-1)}`);

  // Identify sessiond pid (from the supervisor) and the shell.
  const status0 = JSON.parse((await control("status", (b) => b.includes("\n"))).trim());
  const sessiondPid = status0.sessiond.pid;
  const shellPid = childrenOf(sessiondPid)[0];
  check("shell is a child of the supervised sessiond", shellPid !== undefined && ppidOf(shellPid) === sessiondPid, `shell=${shellPid} sessiond=${sessiondPid}`);

  // Unexpected worker death: the supervisor must replace only the worker. The
  // PTY-owning sessiond and its shell stay untouched, and the replacement must
  // complete its real hub-registration health check before recovery is "done".
  const crashedWorkerPid = status0.worker.pid;
  process.kill(crashedWorkerPid, "SIGKILL");
  const recoveredWorker = await waitStatus(
    (s) => s.worker.pid && s.worker.pid !== crashedWorkerPid && !s.recovery.active && s.recovery.workerRestarts >= 1,
    "worker recovery",
  );
  check(
    "unexpected worker exit is restarted without replacing sessiond",
    recoveredWorker.sessiond.pid === sessiondPid && recoveredWorker.worker.pid !== crashedWorkerPid,
    `worker ${crashedWorkerPid} -> ${recoveredWorker.worker.pid}`,
  );
  check("worker recovery preserves the live shell", alive(shellPid) && ppidOf(shellPid) === sessiondPid);

  const crashAttachId = v.send({ type: "session.attach", sessionId: sid }, "agent-pro");
  const crashAttach = await v.waitFor((e) => e.body?.type === "session.attached" && e.replyTo === crashAttachId, 8000);
  const crashScrollback = ticks(crashAttach.body.scrollback);
  const crashMarker = `AFTERCRASH_${randomUUID().slice(0, 6)}`;
  v.send({ type: "session.input", sessionId: sid, data: `echo ${crashMarker}\r` }, "agent-pro");
  const crashIo = await v.waitFor((e) => e.body?.type === "session.output" && e.body.sessionId === sid && e.body.data.includes(crashMarker), 8000).then(() => true).catch(() => false);
  check("restarted worker reattaches with scrollback and live I/O", crashScrollback.length >= before.length && crashIo);

  const genBefore = recoveredWorker.worker.generation;

  // Trigger the blue/green swap (same entry — simulating an update).
  const progress = (await control(`swap ${AGENT}`, (b) => b.split("\n").some((l) => l === "ok" || l.startsWith("failed")))).trim().split("\n");
  info(`swap progress: ${progress.join(" → ")}`);
  const idx = (name) => progress.findIndex((l) => l === name || l.startsWith(name));
  check("health-check precedes retire (ready before retired)", idx("ready") >= 0 && idx("retired") > idx("ready") && progress.includes("ok"));

  // The shell must be untouched by the swap.
  check("shell never interrupted (same pid, still sessiond's child)", alive(shellPid) && ppidOf(shellPid) === sessiondPid);

  // Viewer re-attaches through the new (green) worker.
  await sleep(1500);
  const attachId = v.send({ type: "session.attach", sessionId: sid }, "agent-pro");
  const attached = await v.waitFor((e) => e.body?.type === "session.attached" && e.replyTo === attachId, 8000);
  const sb = ticks(attached.body.scrollback);
  check("scrollback spans the swap (contiguous, from sessiond)", sb.length > 0 && sb[0] === 0 && contiguous(sb) && sb.at(-1) > before.at(-1), `ticks 0..${sb.at(-1)}, before ${before.at(-1)}`);

  const marker = `AFTERSWAP_${randomUUID().slice(0, 6)}`;
  v.send({ type: "session.input", sessionId: sid, data: `echo ${marker}\r` }, "agent-pro");
  await v.waitFor((e) => e.body?.type === "session.output" && e.body.sessionId === sid && e.body.data.includes(marker), 8000);
  const firstAfter = v.outputs(sid).map((e) => e.body.seq).find((s) => s > lastSeqBefore) ?? 0;
  check("live I/O works after swap + seq never resets", firstAfter > lastSeqBefore);

  const status1 = JSON.parse((await control("status", (b) => b.includes("\n"))).trim());
  check("worker generation advanced", status1.worker.generation > genBefore, `gen ${genBefore} -> ${status1.worker.generation}`);

  // Failure path: swap to a broken worker entry rolls back to blue.
  const broken = `${RUN}/nonexistent-worker.js`;
  const failProgress = (await control(`swap ${broken}`, (b) => b.split("\n").some((l) => l === "ok" || l.startsWith("failed")))).trim().split("\n");
  check("bad swap rolls back (failed, not ok)", failProgress.some((l) => l.startsWith("failed")) && !failProgress.includes("ok"));
  await sleep(1500);
  const marker2 = `ROLLBACK_${randomUUID().slice(0, 6)}`;
  v.send({ type: "session.attach", sessionId: sid }, "agent-pro");
  await v.waitFor((e) => e.body?.type === "session.attached", 8000).catch(() => null);
  v.send({ type: "session.input", sessionId: sid, data: `echo ${marker2}\r` }, "agent-pro");
  const back = await v.waitFor((e) => e.body?.type === "session.output" && e.body.sessionId === sid && e.body.data.includes(marker2), 8000).then(() => true).catch(() => false);
  check("session still works after rollback", back && alive(shellPid));

  // Unexpected sessiond death cannot preserve its PTYs, but the supervisor must
  // replace the daemon and the worker whose downstream connection died, then
  // return the device to service without an external restart.
  const beforeSessiondCrash = JSON.parse((await control("status", (b) => b.includes("\n"))).trim());
  process.kill(beforeSessiondCrash.sessiond.pid, "SIGKILL");
  const recoveredStack = await waitStatus(
    (s) =>
      s.sessiond.pid &&
      s.sessiond.pid !== beforeSessiondCrash.sessiond.pid &&
      s.worker.pid &&
      s.worker.pid !== beforeSessiondCrash.worker.pid &&
      !s.recovery.active &&
      s.recovery.sessiondRestarts >= 1,
    "sessiond + worker recovery",
  );
  check(
    "unexpected sessiond exit restarts the daemon and dependent worker",
    recoveredStack.sessiond.pid !== beforeSessiondCrash.sessiond.pid && recoveredStack.worker.pid !== beforeSessiondCrash.worker.pid,
    `sessiond ${beforeSessiondCrash.sessiond.pid} -> ${recoveredStack.sessiond.pid}, worker ${beforeSessiondCrash.worker.pid} -> ${recoveredStack.worker.pid}`,
  );

  const createAfterRecovery = v.send({ type: "session.create", kind: "pty", deviceId: "agent-pro", cols: 80, rows: 24 }, "agent-pro");
  const createdAfterRecovery = await v.waitFor((e) => e.body?.type === "session.created" && e.replyTo === createAfterRecovery, 8000);
  const recoveredSid = createdAfterRecovery.body.session.id;
  const stackMarker = `AFTERSD_${randomUUID().slice(0, 6)}`;
  v.send({ type: "session.input", sessionId: recoveredSid, data: `echo ${stackMarker}\r` }, "agent-pro");
  const stackIo = await v.waitFor((e) => e.body?.type === "session.output" && e.body.sessionId === recoveredSid && e.body.data.includes(stackMarker), 8000).then(() => true).catch(() => false);
  check("recovered sessiond stack serves new sessions", stackIo);

  v.close();
}

async function cleanup() {
  for (const p of [sup, hub]) { try { if (p?.cp?.pid) p.cp.kill("SIGTERM"); } catch {} }
  await sleep(400);
  try { execFileSync("pkill", ["-f", `glass-p4m1-${process.pid}`]); } catch {}
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 90s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 90000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
