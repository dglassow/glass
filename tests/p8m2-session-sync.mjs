/**
 * Phase 8 · Milestone 2 — acceptance test for FLEET SESSION SYNC.
 *
 * Before this, a viewer only saw sessions it created; shells opened on another
 * device were invisible. This proves the fix end to end with TWO viewers on one
 * hub + agent:
 *   - enumeration: a viewer that connects LATER lists a session opened earlier;
 *   - attach: it attaches to that remote session and replays its scrollback;
 *   - live create: a session opened while both are connected is pushed to the
 *     other viewer (agent -> hub broadcast -> onSessionAppeared);
 *   - live exit: closing a session notifies the non-attached viewer too;
 *   - exited sessions stay listed with alive=false (UIs must filter them);
 *   - zombie panes: when sessiond dies and comes back empty, a viewer's
 *     auto-reattach of a now-vanished session must surface onExited (dead
 *     pane), not retry silently forever.
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/p8m2-session-sync.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-p8m2-${process.pid}`;
const TS = `${RUN}/trust.json`;
const SD = `${RUN}/sd.sock`;
const HUB_KEY = `${RUN}/hub-key.json`;

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const info = (m) => console.log(`  \x1b[90m····\x1b[0m  ${m}`);
const b64u = (b) => Buffer.from(b).toString("base64url");

async function makeIdentity(deviceId) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const privateKeyPkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  return {
    deviceId, publicKey,
    keyFileJson: JSON.stringify({ v: 1, deviceId, publicKey, privateKeyPkcs8 }, null, 2),
    signer: { publicKey, async sign(p) { return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, p)); } },
  };
}
const trustAdd = (id, pub, roles) => execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", id, "--public-key", pub, "--roles", roles]);

function startProc(name, args, readyRe) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => { const m = err.match(readyRe); if (m) { clearInterval(iv); resolve(m); } }, 25);
    cp.once("exit", (c) => { clearInterval(iv); reject(new Error(`${name} exited (${c}): ${err}`)); });
    setTimeout(() => { clearInterval(iv); reject(new Error(`${name} not ready: ${err}`)); }, 9000);
  });
  return { cp, ready, err: () => err };
}
async function waitUntil(fn, label, capMs = 8000) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${label}`);
}

let sessiond, hub, agent, A, B;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P8 M2 fleet session sync (two viewers, one agent)\x1b[0m\n");

  const agentId = await makeIdentity("agent-pro");
  const agentKeyFile = `${RUN}/agent-pro.json`;
  writeFileSync(agentKeyFile, agentId.keyFileJson, { mode: 0o600 });
  trustAdd("agent-pro", agentId.publicKey, "agent");
  const va = await makeIdentity("viewer-a");
  trustAdd("viewer-a", va.publicKey, "viewer");
  const vb = await makeIdentity("viewer-b");
  trustAdd("viewer-b", vb.publicKey, "viewer");

  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sessiond.ready;
  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--hub-key", HUB_KEY], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  const pin = hub.err().match(/identity key (\S+)/)?.[1];
  agent = startProc("agent", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", "agent-pro", "--name", "Pro", "--key", agentKeyFile], /registered with hub/);
  await agent.ready;
  info(`hub=${url} agent=agent-pro`);

  // ---- Viewer A: connect + open a shell + write a marker into it ----
  const aOut = new Map();
  const aExited = [];
  let aConn = 0;
  A = new HubClient(url, "viewer-a", "A", { onConnected: () => aConn++, onExited: (sid) => aExited.push(sid), onOutput: (sid, d) => aOut.set(sid, (aOut.get(sid) ?? "") + d) }, va.signer, pin);
  A.connect();
  await waitUntil(() => aConn > 0, "A connected");
  const s1 = await A.createSession("agent-pro", { kind: "pty" });
  await sleep(300);
  const marker = `P8M2_${randomUUID().slice(0, 8)}`;
  A.input("agent-pro", s1.id, `echo ${marker}\r`);
  await waitUntil(() => (aOut.get(s1.id) ?? "").includes(marker), "A sees its own marker");
  info(`A opened session ${s1.id.slice(0, 8)} with marker ${marker}`);

  // ---- Viewer B: connects LATER — must discover A's existing session ----
  const bAppeared = [];
  const bExited = [];
  const bScroll = new Map();
  let bConn = 0;
  B = new HubClient(url, "viewer-b", "B", {
    onConnected: () => bConn++,
    onSessionAppeared: (s) => bAppeared.push(s.id),
    onExited: (sid) => bExited.push(sid),
    onScrollback: (sid, sb) => bScroll.set(sid, sb),
    onOutput: (sid, d) => bScroll.set(sid, (bScroll.get(sid) ?? "") + d),
  }, vb.signer, pin);
  B.connect();
  await waitUntil(() => bConn > 0, "B connected");

  const listed = await B.listSessions("agent-pro");
  check("enumeration: late viewer lists the session opened before it joined", listed.some((s) => s.id === s1.id), `${listed.length} session(s)`);

  // ---- B attaches to A's remote session and replays its scrollback ----
  await B.attach("agent-pro", s1.id);
  await waitUntil(() => (bScroll.get(s1.id) ?? "").includes(marker), "B replays A's scrollback");
  check("attach: viewer attaches a REMOTE session and sees its scrollback", (bScroll.get(s1.id) ?? "").includes(marker));

  // ---- live create: A opens a 2nd shell while B is connected ----
  bAppeared.length = 0;
  const s2 = await A.createSession("agent-pro", { kind: "pty" });
  await waitUntil(() => bAppeared.includes(s2.id), "B notified of the new session");
  check("live create: session opened by A is pushed to B (broadcast)", bAppeared.includes(s2.id), s2.id.slice(0, 8));

  // ---- live exit: A closes the first shell; B (attached) is told ----
  bExited.length = 0;
  A.closeSession("agent-pro", s1.id);
  await waitUntil(() => bExited.includes(s1.id), "B notified of the exit");
  check("live exit: closing a session notifies the other viewer", bExited.includes(s1.id));

  // ---- exited sessions stay in the list, flagged dead (UIs filter on alive) ----
  const afterExit = await B.listSessions("agent-pro");
  check("records: an exited session stays listed with alive=false", afterExit.some((s) => s.id === s1.id && s.alive === false));

  // ---- zombie panes: sessiond dies (taking every PTY); the agent comes back
  // ---- over an EMPTY sessiond. A still holds s2; its auto-reattach must get
  // ---- session_not_found and surface onExited — not leave a live-looking pane.
  aExited.length = 0;
  agent.cp.kill("SIGKILL");
  sessiond.cp.kill("SIGKILL");
  await sleep(200);
  rmSync(SD, { force: true });
  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sessiond.ready;
  agent = startProc("agent", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", "agent-pro", "--name", "Pro", "--key", agentKeyFile], /registered with hub/);
  await agent.ready;
  await waitUntil(() => aExited.includes(s2.id), "A told its held session is gone");
  check("zombie pane: re-attach to a vanished session surfaces onExited", aExited.includes(s2.id), s2.id.slice(0, 8));

  check("no crash: both viewers still connected", aConn === 1 && bConn === 1, `A=${aConn} B=${bConn}`);
}

async function cleanup() {
  try { A?.close(); } catch { /* */ }
  try { B?.close(); } catch { /* */ }
  for (const p of [agent, hub, sessiond]) { try { p?.cp?.kill("SIGTERM"); } catch { /* */ } }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 60s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 60000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
