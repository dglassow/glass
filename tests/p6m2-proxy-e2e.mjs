/**
 * Phase 6 · Milestone 2 — acceptance test for the HUB-ROUTED browser proxy
 * (plan §7 end to end, the wiring on top of p6m1's in-process halves):
 *
 *   viewer ──proxy.forward.open──▶ agent A (its "local" agent)
 *   curl ──SOCKS5──▶ A's loopback forwarder ──proxy.* via hub──▶ agent B ──▶ target
 *
 *   - the viewer asks A for a forwarder aimed at B and gets a loopback port;
 *   - a real curl through that port reaches the target, and the EGRESS (the
 *     dial + its audit log line) happens on B, not A;
 *   - opening the same forwarder twice is idempotent (same port);
 *   - a bogus proxy.data frame from a third device can't disturb channels;
 *   - a forwarder aimed at a nonexistent device fails closed (curl errors).
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/p6m2-proxy-e2e.mjs
 */
import http from "node:http";
import { execFile, spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const pexec = promisify(execFile);
const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-p6m2-${process.pid}`;
const TS = `${RUN}/trust.json`;
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
const listen = (server, host = "127.0.0.1") => new Promise((r) => server.listen(0, host, () => r(server.address().port)));

let hub, sdA, sdB, agentA, agentB, V, target;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P6 M2 hub-routed browser proxy (forward on A, egress on B)\x1b[0m\n");

  const idA = await makeIdentity("agent-a");
  const idB = await makeIdentity("agent-b");
  const keyA = `${RUN}/agent-a.json`;
  const keyB = `${RUN}/agent-b.json`;
  writeFileSync(keyA, idA.keyFileJson, { mode: 0o600 });
  writeFileSync(keyB, idB.keyFileJson, { mode: 0o600 });
  trustAdd("agent-a", idA.publicKey, "agent");
  trustAdd("agent-b", idB.publicKey, "agent");
  const vw = await makeIdentity("viewer-x");
  trustAdd("viewer-x", vw.publicKey, "viewer");

  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--hub-key", HUB_KEY], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  const pin = hub.err().match(/identity key (\S+)/)?.[1];
  sdA = startProc("sessiond-a", [SESSIOND, "--socket", `${RUN}/a.sock`], /listening on/);
  sdB = startProc("sessiond-b", [SESSIOND, "--socket", `${RUN}/b.sock`], /listening on/);
  await sdA.ready; await sdB.ready;
  agentA = startProc("agent-a", [AGENT, "--sessiond", `${RUN}/a.sock`, "--hub", url, "--device-id", "agent-a", "--name", "A", "--key", keyA], /registered with hub/);
  agentB = startProc("agent-b", [AGENT, "--sessiond", `${RUN}/b.sock`, "--hub", url, "--device-id", "agent-b", "--name", "B", "--key", keyB], /registered with hub/);
  await agentA.ready; await agentB.ready;
  info(`hub=${url}`);

  // A target the EXIT (agent B) must reach on our behalf.
  const MARK = `P6M2-EGRESS-${randomUUID().slice(0, 8)}`;
  target = http.createServer((_req, res) => res.end(MARK));
  const targetPort = await listen(target);

  let conn = 0;
  V = new HubClient(url, "viewer-x", "V", { onConnected: () => conn++ }, vw.signer, pin);
  V.connect();
  await waitUntil(() => conn > 0, "viewer connected");

  // ---- open a forwarder on A aimed at B ----
  const port = await V.openProxyForward("agent-a", "agent-b");
  check("forward.open: viewer gets a loopback SOCKS port from its local agent", Number.isInteger(port) && port > 0, `port ${port}`);

  // ---- browse through it: curl -> A's SOCKS -> hub -> B -> target ----
  const { stdout } = await pexec(
    "curl",
    ["-s", "--max-time", "10", "--socks5-hostname", `127.0.0.1:${port}`, `http://127.0.0.1:${targetPort}/`],
    { timeout: 12000 },
  );
  check("tunnel: request through A's forwarder reaches the target", stdout.includes(MARK), stdout.slice(0, 40));
  check("egress: B dialled the destination (audit log on B)", agentB.err().includes(`-> 127.0.0.1:${targetPort}`));
  check("egress: A did NOT dial it (no exit activity on A)", !agentA.err().includes("proxy egress"));

  // ---- idempotent: same exit -> same forwarder/port ----
  const port2 = await V.openProxyForward("agent-a", "agent-b");
  check("forward.open is idempotent for the same exit device", port2 === port, `${port2} == ${port}`);

  // ---- a bogus data frame from a third device must not disturb channels ----
  // Raw frame: the HubClient has no public sender for proxy.data — reach into
  // the compiled class (private in TS, plain method in JS).
  V["rawSend"]("viewer-x", "agent-b", { type: "proxy.data", channelId: randomUUID(), data: Buffer.from("junk").toString("base64") });
  const again = await pexec(
    "curl",
    ["-s", "--max-time", "10", "--socks5-hostname", `127.0.0.1:${port}`, `http://127.0.0.1:${targetPort}/`],
    { timeout: 12000 },
  );
  check("hostile/no-op frames: tunnel still works after a bogus proxy.data", again.stdout.includes(MARK));

  // ---- a forwarder aimed at a nonexistent device fails closed ----
  const deadPort = await V.openProxyForward("agent-a", "no-such-device");
  const dead = await pexec(
    "curl",
    ["-s", "--max-time", "4", "--socks5-hostname", `127.0.0.1:${deadPort}`, `http://127.0.0.1:${targetPort}/`],
    { timeout: 6000 },
  ).then(
    (r) => r.stdout.includes(MARK) ? "reached" : "failed",
    () => "failed",
  );
  check("unknown exit device: connection fails, nothing reaches the target", dead === "failed");
}

async function cleanup() {
  try { V?.close(); } catch { /* */ }
  try { target?.close(); } catch { /* */ }
  for (const p of [agentA, agentB, sdA, sdB, hub]) { try { p?.cp?.kill("SIGTERM"); } catch { /* */ } }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 60s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 60000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
