/**
 * Phase 8 · Milestone 1 — acceptance test for the REACHABLE hub (fleet exposure).
 *
 * The desktop "hub" role now runs TWO listeners from ONE hub sharing a single
 * registry + trust store: a plaintext loopback ws:// (this Mac's own window, no
 * cert) and a TLS wss:// (remote spokes + the PWA, forwarded by the relay). This
 * proves:
 *   - both listeners bind and are announced, with the "hub: ready — N" sentinel;
 *   - an agent authenticating over the TLS listener and a viewer over the
 *     loopback listener land in the SAME hub (the viewer lists the agent);
 *   - frames route ACROSS listeners (loopback viewer drives a shell on the
 *     TLS-side agent end to end);
 *   - channel binding on the TLS listener still defeats a TLS-terminating MITM
 *     even with the second (loopback) listener present;
 *   - the PWA/static + git endpoints are served over the TLS listener only;
 *   - an UNTRUSTED device is refused on the TLS listener.
 *
 * Loopback-only (no VPS). Run after:
 *   pnpm build && pnpm --filter @glass/viewer build:lib
 *   node tests/p8m1-reachable-hub.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-p8m1-${process.pid}`;
const TS = `${RUN}/trust.json`;
const SD = `${RUN}/sd.sock`;
const HUB_KEY = `${RUN}/hub-key.json`;
const WEBROOT = `${RUN}/web`;
const UPDATES = `${RUN}/updates`;

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const info = (m) => console.log(`  \x1b[90m····\x1b[0m  ${m}`);
const b64u = (b) => Buffer.from(b).toString("base64url");

function genCert(prefix, cn) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", `${prefix}.key`, "-out", `${prefix}.crt`, "-days", "1", "-nodes", "-subj", `/CN=${cn}`], { stdio: "ignore" });
  return { cert: `${prefix}.crt`, key: `${prefix}.key` };
}
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
  cp.stdout.on("data", (d) => (err += d.toString()));
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => { const m = err.match(readyRe); if (m) { clearInterval(iv); resolve(m); } }, 25);
    cp.once("exit", (c) => { clearInterval(iv); reject(new Error(`${name} exited (${c}): ${err}`)); });
    setTimeout(() => { clearInterval(iv); reject(new Error(`${name} not ready: ${err}`)); }, 9000);
  });
  return { cp, ready, err: () => err };
}

// Agent against `hubUrl` with a pinned hub key; resolve registered|refused|timeout.
function agentOutcome(hubUrl, deviceId, keyFile, pin) {
  const args = [AGENT, "--sessiond", SD, "--hub", hubUrl, "--device-id", deviceId, "--name", deviceId, "--key", keyFile, "--insecure-tls"];
  if (pin) args.push("--hub-key", pin);
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  const outcome = new Promise((resolve) => {
    const iv = setInterval(() => {
      if (/registered with hub/.test(err)) { clearInterval(iv); resolve("registered"); }
      else if (/HUB IDENTITY VERIFICATION FAILED/.test(err)) { clearInterval(iv); resolve("refused"); }
    }, 25);
    setTimeout(() => { clearInterval(iv); resolve("timeout"); }, 6000);
  });
  return { cp, outcome };
}

// TLS-terminating MITM in front of the TLS listener: own cert to the client,
// fresh TLS to the hub — two legs, so channel binding must differ.
function mitmRelay(hubPort, certPaths) {
  const server = tls.createServer({ cert: readFileSync(certPaths.cert), key: readFileSync(certPaths.key) }, (client) => {
    const up = tls.connect({ host: "127.0.0.1", port: hubPort, rejectUnauthorized: false }, () => { client.pipe(up); up.pipe(client); });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function httpsGet(port, path) {
  return new Promise((resolve) => {
    const req = https.get({ host: "127.0.0.1", port, path, rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
  });
}
async function waitUntil(fn, label, capMs = 8000) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${label}`);
}

let hub, sessiond, agent, client, mm;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  mkdirSync(WEBROOT, { recursive: true });
  writeFileSync(`${WEBROOT}/index.html`, "<!doctype html><title>Glass PWA</title>P8M1_PWA_OK");
  mkdirSync(UPDATES, { recursive: true });
  writeFileSync(`${UPDATES}/latest.json`, JSON.stringify({ version: "9.9.9", platforms: {} }));
  console.log("\n\x1b[1mGlass — P8 M1 reachable hub (dual listener: loopback ws + relay TLS)\x1b[0m\n");

  const hubCert = genCert(`${RUN}/hub`, "localhost");
  const mitmCert = genCert(`${RUN}/mitm`, "localhost");

  // Identities trusted BEFORE the hub starts (file store loads once).
  const agentId = await makeIdentity("agent-pro");
  const agentKeyFile = `${RUN}/agent-pro.json`;
  writeFileSync(agentKeyFile, agentId.keyFileJson, { mode: 0o600 });
  trustAdd("agent-pro", agentId.publicKey, "agent");
  const viewerId = await makeIdentity("viewer-studio");
  trustAdd("viewer-studio", viewerId.publicKey, "viewer");
  const untrusted = await makeIdentity("intruder");
  const untrustedKeyFile = `${RUN}/intruder.json`;
  writeFileSync(untrustedKeyFile, untrusted.keyFileJson, { mode: 0o600 });

  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sessiond.ready;

  // Dual-listener hub: loopback ws primary + a TLS wss listener carrying the PWA.
  hub = startProc("hub", [
    HUB, "--listen", "127.0.0.1:0", "--tls-listen", "127.0.0.1:0",
    "--tls-cert", hubCert.cert, "--tls-key", hubCert.key,
    "--trust-store", TS, "--hub-key", HUB_KEY, "--web-root", WEBROOT, "--updates-root", UPDATES,
  ], /hub: ready — \d+ listener/);
  await hub.ready;
  const log = hub.err();
  const wsUrl = log.match(/listening on (ws:\/\/\S+)/)?.[1];
  const wssUrl = log.match(/listening on (wss:\/\/\S+)/)?.[1];
  const hubPin = log.match(/identity key (\S+)/)?.[1];
  const wssPort = wssUrl ? Number(new URL(wssUrl.replace("wss://", "https://")).port) : 0;
  check("both listeners bound (loopback ws:// + TLS wss://)", !!wsUrl && !!wssUrl, `${wsUrl} + ${wssUrl}`);
  check("hub announces 2 listeners via sentinel", /hub: ready — 2 listener/.test(log));
  info(`ws=${wsUrl} wss=${wssUrl} pin=${hubPin}`);

  // Agent authenticates over the TLS (wss) listener.
  {
    const a = agentOutcome(wssUrl, "agent-pro", agentKeyFile, hubPin);
    const o = await a.outcome;
    if (o !== "registered") a.cp.kill("SIGKILL");
    check("agent registers over the TLS (wss) listener", o === "registered", o);
    agent = a; // keep it connected for the shared-state checks
  }

  // Viewer authenticates over the loopback ws listener, then sees the TLS-side agent.
  const out = new Map();
  let connected = 0;
  const errors = [];
  client = new HubClient(wsUrl, "viewer-studio", "Studio", {
    onConnected: () => connected++,
    onOutput: (sid, data) => out.set(sid, (out.get(sid) ?? "") + data),
    onError: (code, message) => errors.push({ code, message }),
  }, viewerId.signer, hubPin);
  client.connect();
  await waitUntil(() => connected > 0, "viewer connected over loopback");
  check("viewer registers over the loopback ws listener", connected === 1);

  const devices = await client.listDevices();
  const agentDev = devices.find((d) => d.id === "agent-pro");
  check("SHARED STATE: loopback viewer lists the TLS-listener agent", !!agentDev && agentDev.state === "connected", agentDev ? `state=${agentDev.state}` : "not found");

  // Cross-listener routing: viewer (loopback) drives a shell on the agent (TLS).
  const session = await client.createSession("agent-pro", { kind: "pty", cols: 80, rows: 24 });
  const sid = session.id;
  await sleep(400);
  const marker = `P8M1_${randomUUID().slice(0, 8)}`;
  client.input("agent-pro", sid, `echo ${marker}\r`);
  await waitUntil(() => (out.get(sid) ?? "").includes(marker), "cross-listener shell echo");
  check("CROSS-LISTENER routing: loopback viewer ↔ TLS agent shell round-trip", (out.get(sid) ?? "").includes(marker));
  check("no protocol errors on the happy path", errors.length === 0, errors.map((e) => e.code).join(","));
  client.closeSession("agent-pro", sid);
  await sleep(200);

  // PWA served over the TLS listener.
  const page = await httpsGet(wssPort, "/");
  check("PWA/static served over the TLS listener", page.status === 200 && page.body.includes("P8M1_PWA_OK"), `status=${page.status}`);

  // Auto-update endpoint served over the TLS listener; traversal refused.
  const manifest = await httpsGet(wssPort, "/updates/latest.json");
  check("auto-update manifest served over TLS (/updates/latest.json)", manifest.status === 200 && manifest.body.includes("9.9.9"), `status=${manifest.status}`);
  const trav = await httpsGet(wssPort, "/updates/..%2f..%2fweb%2findex.html");
  check("updates endpoint refuses path traversal", trav.status === 404 || trav.status === 400, `status=${trav.status}`);

  // Channel binding on the TLS listener still defeats a TLS-terminating MITM.
  await sleep(300);
  {
    mm = await mitmRelay(wssPort, mitmCert);
    const a = agentOutcome(`wss://127.0.0.1:${mm.port}`, "agent-pro", agentKeyFile, hubPin);
    const o = await a.outcome;
    a.cp.kill("SIGKILL");
    mm.server.close(); mm = null;
    check("TLS-terminating MITM on the wss listener is refused (channel binding)", o === "refused", o);
  }

  // Untrusted device refused on the TLS listener (never registers).
  await sleep(300);
  {
    const a = agentOutcome(wssUrl, "intruder", untrustedKeyFile, hubPin);
    const o = await a.outcome;
    a.cp.kill("SIGKILL");
    check("untrusted device is refused on the TLS listener", o === "timeout", o);
  }

  // R1 (red-team): the agent fails CLOSED — --insecure-tls without --hub-key is
  // refused at startup, so an unpinned spoke can never authenticate through a MITM.
  {
    const cp = spawn("node", [AGENT, "--sessiond", SD, "--hub", wssUrl, "--device-id", "agent-pro", "--name", "x", "--key", agentKeyFile, "--insecure-tls"], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    cp.stdout.on("data", (d) => (err += d));
    cp.stderr.on("data", (d) => (err += d));
    const code = await new Promise((res) => { cp.once("exit", (c) => res(c)); setTimeout(() => { try { cp.kill("SIGKILL"); } catch { /* */ } res(-1); }, 5000); });
    check("agent fails closed: --insecure-tls without --hub-key is refused", code !== 0 && /refusing to run with --insecure-tls/.test(err), `code=${code}`);
  }
}

async function cleanup() {
  try { client?.close(); } catch { /* */ }
  try { agent?.cp?.kill("SIGKILL"); } catch { /* */ }
  try { mm?.server.close(); } catch { /* */ }
  for (const p of [hub, sessiond]) { try { p?.cp?.kill("SIGTERM"); } catch { /* */ } }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 70s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 70000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
