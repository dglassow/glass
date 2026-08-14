/**
 * Phase 8 · Milestone 3 — acceptance test for SELF-SERVE DEVICE ENROLLMENT.
 *
 * An untrusted device joins by number matching instead of manual key-copying:
 * it sends device.enroll.request (showing a 6-digit code), an already-trusted
 * device approves the matching code, and the hub trusts it LIVE (no restart).
 * A spoke's shell-agent rides along as a "companion", trusted in the same
 * approval. Proves:
 *   - an untrusted viewer with enroll config enters enrollment + surfaces a code;
 *   - a trusted approver is notified of the SAME code + device name;
 *   - a WRONG code is rejected (number matching is enforced on the wire);
 *   - the correct approval trusts the viewer AND its companion agent, live;
 *   - the joining viewer then connects as a trusted device with no hub restart.
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/p8m3-enrollment.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const RUN = `/tmp/glass-p8m3-${process.pid}`;
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
  return {
    deviceId, publicKey,
    signer: { publicKey, async sign(p) { return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, p)); } },
  };
}
const trustAdd = (id, pub, roles) => execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", id, "--public-key", pub, "--roles", roles]);
const trusted = () => { try { return JSON.parse(readFileSync(TS, "utf8")).devices ?? {}; } catch { return {}; } };

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

let sessiond, hub, approver, join1, join2, join3;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P8 M3 self-serve enrollment (number match + companion)\x1b[0m\n");

  // The approver is pre-trusted; joiners + the companion agent are NOT.
  const appr = await makeIdentity("viewer-studio");
  trustAdd("viewer-studio", appr.publicKey, "viewer");
  const j1 = await makeIdentity("viewer-join1");
  const j2 = await makeIdentity("viewer-join2");
  const j3 = await makeIdentity("viewer-join3"); // the PWA (e.g. iPhone) — no pin
  const companion = await makeIdentity("spoke-abc12345"); // the joining Mac's shell agent

  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sessiond.ready;
  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--hub-key", HUB_KEY], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  const pin = hub.err().match(/identity key (\S+)/)?.[1];
  const hubStartPid = hub.cp.pid;

  // Approver online.
  const requests = [];
  let apprConn = 0;
  approver = new HubClient(url, "viewer-studio", "Studio", {
    onConnected: () => apprConn++,
    onEnrollRequest: (req) => requests.push(req),
  }, appr.signer, pin);
  approver.connect();
  await waitUntil(() => apprConn > 0, "approver connected");
  info("approver online");

  // Deliberately CLAIM the privileged "hub" role on the wire to prove the hub
  // STRIPS it (keeping the legit viewer/agent roles).
  const enrollCfg = { deviceName: "MacBook Test", roles: ["hub", "viewer"], companions: [{ deviceId: "spoke-abc12345", publicKey: companion.publicKey, roles: ["hub", "agent"] }] };
  const eq = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());

  // --- Joiner 1: WRONG code must be rejected ---
  let j1Waiting = null, j1Denied = false, j1Conn = 0;
  join1 = new HubClient(url, "viewer-join1", "join1", {
    onConnected: () => j1Conn++,
    onEnrollWaiting: (code) => (j1Waiting = code),
    onEnrollDenied: () => (j1Denied = true),
  }, j1.signer, pin, enrollCfg);
  join1.connect();
  await waitUntil(() => j1Waiting !== null, "joiner1 enters enrollment");
  check("untrusted device enters enrollment + shows a HUB-minted 6-digit code", /^\d{6}$/.test(j1Waiting), j1Waiting);
  const req1 = await waitUntil(() => requests.find((r) => r.deviceName === "MacBook Test"), "approver notified");
  check("approver sees scope (roles + companions) but NOT the code", req1.code === undefined && eq(req1.roles, ["viewer"]) && req1.companions.length === 1 && eq(req1.companions[0].roles, ["agent"]));

  const wrong = String((Number(j1Waiting) + 1) % 1_000_000).padStart(6, "0");
  approver.sendEnrollDecision(req1.requestId, true, wrong); // WRONG code
  await waitUntil(() => j1Denied, "joiner1 declined on wrong code");
  check("wrong code is rejected (number matching enforced)", j1Denied && j1Conn === 0 && !trusted()["viewer-join1"]);
  join1.close();

  // --- Joiner 2: approver TYPES the code read off the joiner → viewer + companion, live ---
  requests.length = 0;
  let j2Waiting = null, j2Conn = 0;
  join2 = new HubClient(url, "viewer-join2", "join2", {
    onConnected: () => j2Conn++,
    onEnrollWaiting: (code) => (j2Waiting = code),
  }, j2.signer, pin, enrollCfg);
  join2.connect();
  await waitUntil(() => j2Waiting !== null, "joiner2 enters enrollment");
  const req2 = await waitUntil(() => requests.find((r) => r.deviceName === "MacBook Test"), "approver notified #2");
  approver.sendEnrollDecision(req2.requestId, true, j2Waiting); // human reads the code off the joiner
  await waitUntil(() => j2Conn > 0, "joiner2 connects as trusted after approval");
  check("correct approval → joiner connects as trusted (live, no hub restart)", j2Conn === 1 && hub.cp.pid === hubStartPid);
  check("hub CLAMPED the viewer's self-assigned roles to [viewer]", eq(trusted()["viewer-join2"]?.roles, ["viewer"]));
  check("companion trusted with role [agent] only (no self-granted hub)", eq(trusted()["spoke-abc12345"]?.roles, ["agent"]));
  check("approver stayed connected throughout", apprConn === 1);

  // --- Joiner 3: the PWA case (e.g. a fresh iPhone) — NO hub-key pin. It relies on
  //     wss TLS for hub identity (TOFU), so it must still ENTER enrollment (code
  //     shown without a client-side hub-proof check) and remain gated by the owner
  //     typing that code. This is exactly the served-origin path in main.ts. ---
  requests.length = 0;
  let j3Waiting = null, j3Conn = 0;
  const enrollPwa = { deviceName: "iPhone", roles: ["viewer"], companions: [] };
  join3 = new HubClient(url, "viewer-join3", "iPhone", {
    onConnected: () => j3Conn++,
    onEnrollWaiting: (code) => (j3Waiting = code),
  }, j3.signer, undefined, enrollPwa); // <-- undefined pin: the PWA has no pinned hub key
  join3.connect();
  await waitUntil(() => j3Waiting !== null, "PWA joiner (no pin) enters enrollment");
  check("no-pin (PWA) device still enrolls: HUB-minted code shown over TOFU/wss", /^\d{6}$/.test(j3Waiting), j3Waiting);
  const req3 = await waitUntil(() => requests.find((r) => r.deviceName === "iPhone"), "approver notified (PWA)");
  approver.sendEnrollDecision(req3.requestId, true, j3Waiting); // owner reads the code off the phone
  await waitUntil(() => j3Conn > 0, "PWA joiner connects as trusted after approval");
  check("no-pin (PWA) join gated by the owner typing the code → trusted viewer", j3Conn === 1 && eq(trusted()["viewer-join3"]?.roles, ["viewer"]));
}

async function cleanup() {
  for (const c of [approver, join1, join2]) { try { c?.close(); } catch { /* */ } }
  for (const p of [hub, sessiond]) { try { p?.cp?.kill("SIGTERM"); } catch { /* */ } }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 60s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 60000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
