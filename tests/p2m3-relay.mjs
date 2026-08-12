/**
 * Phase 2 · Milestone 3 — acceptance test for the relay: hub TLS + hub-key
 * mutual auth + TLS channel binding.
 *
 * Loopback-only (no VPS). Proves: the hub serves wss; a spoke that PINS the
 * correct hub key registers; a WRONG pin is refused; the intended dumb TCP
 * passthrough relay (one end-to-end TLS session) works; a TLS-terminating MITM
 * relay — even carrying the correct pin — is REFUSED because its two TLS legs
 * export different channel-binding values; and the reverse-tunnel keeper
 * respawns. The Lightsail provisioning itself is infra/lightsail/ (owner applies).
 *
 * Run after `pnpm build`:  node tests/p2m3-relay.mjs
 */
import { spawn, execFileSync, execSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-p2m3-${process.pid}`;
const TS = `${RUN}/trust.json`;
const SD = `${RUN}/sd.sock`;

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const b64u = (b) => Buffer.from(b).toString("base64url");

function genCert(prefix, cn) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", `${prefix}.key`, "-out", `${prefix}.crt`, "-days", "1", "-nodes", "-subj", `/CN=${cn}`], { stdio: "ignore" });
  return { cert: `${prefix}.crt`, key: `${prefix}.key` };
}
async function ed25519() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))), privateKeyPkcs8: b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))) };
}
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

// Run an agent against `hubUrl` with a pinned hub key; resolve its outcome.
function agentOutcome(hubUrl, pin, keyFile) {
  const cp = spawn("node", [AGENT, "--sessiond", SD, "--hub", hubUrl, "--device-id", "agent-pro", "--name", "Pro", "--key", keyFile, "--hub-key", pin, "--insecure-tls"], { stdio: ["ignore", "pipe", "pipe"] });
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

// Dumb TCP passthrough: one end-to-end TLS session (the intended sshd analog).
function dumbPipe(hubPort) {
  const server = net.createServer((client) => {
    const up = net.connect(hubPort, "127.0.0.1", () => { client.pipe(up); up.pipe(client); });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

// TLS-terminating MITM: own cert to the spoke, re-originates a fresh TLS to the hub.
function mitmRelay(hubPort, certPaths) {
  const server = tls.createServer({ cert: readFileSync(certPaths.cert), key: readFileSync(certPaths.key) }, (client) => {
    const up = tls.connect({ host: "127.0.0.1", port: hubPort, rejectUnauthorized: false }, () => { client.pipe(up); up.pipe(client); });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

let hub, sessiond, dp, mm;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P2 M3 relay (TLS + hub-key mutual auth + channel binding)\x1b[0m\n");

  const hubCert = genCert(`${RUN}/hub`, "localhost");
  const mitmCert = genCert(`${RUN}/mitm`, "localhost");

  const hubKey = await ed25519();
  const hubKeyFile = `${RUN}/hub-key.json`;
  writeFileSync(hubKeyFile, JSON.stringify({ v: 1, ...hubKey }));
  const correctPin = hubKey.publicKey;
  const wrongPin = (await ed25519()).publicKey;

  const agentKey = await ed25519();
  const agentKeyFile = `${RUN}/agent-pro.json`;
  writeFileSync(agentKeyFile, JSON.stringify({ v: 1, deviceId: "agent-pro", ...agentKey }), { mode: 0o600 });
  trustAdd("agent-pro", agentKey.publicKey, "agent");

  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sessiond.ready;
  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--tls-cert", hubCert.cert, "--tls-key", hubCert.key, "--hub-key", hubKeyFile], /listening on (ws:\/\/\S+|wss:\/\/\S+)/);
  const url = (await hub.ready)[1];
  const hubPort = Number(new URL(url.replace("wss://", "https://")).port);
  check("hub serves TLS (wss)", url.startsWith("wss://"), url);

  // CHECK — correct pin, direct wss: registers.
  {
    const a = agentOutcome(url, correctPin, agentKeyFile);
    const o = await a.outcome;
    a.cp.kill("SIGKILL");
    check("correct hub-key pin registers", o === "registered", o);
  }

  // CHECK — wrong pin: refused.
  await sleep(300);
  {
    const a = agentOutcome(url, wrongPin, agentKeyFile);
    const o = await a.outcome;
    a.cp.kill("SIGKILL");
    check("wrong hub-key pin is refused", o === "refused", o);
  }

  // CHECK — dumb TCP passthrough relay: one TLS session -> registers.
  await sleep(300);
  {
    dp = await dumbPipe(hubPort);
    const a = agentOutcome(`wss://127.0.0.1:${dp.port}`, correctPin, agentKeyFile);
    const o = await a.outcome;
    a.cp.kill("SIGKILL");
    dp.server.close();
    check("dumb passthrough relay works (channel binding matches)", o === "registered", o);
  }

  // CHECK — TLS-terminating MITM relay with the correct pin: REFUSED (cb mismatch).
  await sleep(300);
  {
    mm = await mitmRelay(hubPort, mitmCert);
    const a = agentOutcome(`wss://127.0.0.1:${mm.port}`, correctPin, agentKeyFile);
    const o = await a.outcome;
    a.cp.kill("SIGKILL");
    mm.server.close();
    check("TLS-terminating MITM refused (channel binding defeats it)", o === "refused", o);
  }

  // CHECK — the reverse-tunnel keeper respawns its command.
  {
    const counter = `${RUN}/tunnel-spawns`;
    writeFileSync(counter, "");
    const bump = `${RUN}/bump.mjs`;
    writeFileSync(bump, `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(counter)}, "x"); setTimeout(()=>process.exit(0), 150);`);
    const keeper = spawn("node", [HUB, "tunnel", "--", "node", bump], { stdio: ["ignore", "pipe", "pipe"] });
    await sleep(1500);
    keeper.kill("SIGTERM");
    const spawns = existsSync(counter) ? readFileSync(counter, "utf8").length : 0;
    check("tunnel keeper respawns on exit", spawns >= 2, `${spawns} spawns`);
  }
}

async function cleanup() {
  for (const p of [hub, sessiond]) { try { if (p?.cp?.pid) p.cp.kill("SIGTERM"); } catch {} }
  try { dp?.server.close(); } catch {}
  try { mm?.server.close(); } catch {}
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 70s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 70000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
