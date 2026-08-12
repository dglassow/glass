/**
 * Bring up a LIVE hub behind the relay for a real client (e.g. Glass.app) to
 * connect to. Unlike relay-smoke.mjs (a self-contained proof), this uses a
 * PERSISTENT hub identity + trust store so the pin is stable across restarts,
 * trusts a viewer device you pass in, and stays running.
 *
 *   VIEWER_ID=<id> VIEWER_PUB=<b64url> node deploy/hub-live.mjs
 *
 * Then in the app's connect screen enter:
 *   hub url:  wss://18.216.57.165:443
 *   hub key:  (the identity key this script prints)
 * and click connect → a "Pro" agent appears → "+ shell".
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const RELAY_IP = "18.216.57.165";
const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const TUNNEL_KEY = `${ROOT}config/local/tunnel_ed25519`;
const DIR = `${ROOT}config/local/live`;
const TS = `${DIR}/trust.json`;
const HUBKEY = `${DIR}/hub-identity.json`;
const AGENTKEY = `${DIR}/agent-pro.json`;
const SD = `${DIR}/sd.sock`;

const VIEWER_ID = process.env.VIEWER_ID;
const VIEWER_PUB = process.env.VIEWER_PUB;
if (!VIEWER_ID || !VIEWER_PUB) {
  console.error("set VIEWER_ID and VIEWER_PUB (from the app's connect screen)");
  process.exit(1);
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const procs = [];

function spawnProc(name, args, readyRe, timeoutMs = 12000) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  procs.push({ name, cp });
  let buf = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(readyRe);
      if (m) resolve({ m, buf });
    };
    cp.stdout.on("data", onData);
    cp.stderr.on("data", onData);
    cp.once("exit", (c) => reject(new Error(`${name} exited (${c}):\n${buf}`)));
    setTimeout(() => reject(new Error(`${name} not ready in ${timeoutMs}ms:\n${buf}`)), timeoutMs);
  });
  return { cp, ready, out: () => buf };
}
const trustAdd = (id, pub, roles) => execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", id, "--public-key", pub, "--roles", roles]);
async function genKeyIfMissing(deviceId, path) {
  if (existsSync(path)) return JSON.parse(execFileSync("cat", [path]).toString()).publicKey;
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const privateKeyPkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  writeFileSync(path, JSON.stringify({ v: 1, deviceId, publicKey, privateKeyPkcs8 }), { mode: 0o600 });
  return publicKey;
}
const shutdown = () => {
  for (const { cp } of procs.reverse()) try { cp.kill("SIGTERM"); } catch { /* gone */ }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  console.log("\n\x1b[1mGlass — live hub for the app\x1b[0m\n");
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(`${DIR}/tls.crt`)) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", `${DIR}/tls.key`, "-out", `${DIR}/tls.crt`, "-days", "30", "-nodes", "-subj", "/CN=glass-hub"], { stdio: "ignore" });
  }

  // Trust the viewer (your app) + the agent BEFORE the hub reads its store.
  trustAdd(VIEWER_ID, VIEWER_PUB, "viewer");
  const agentPub = await genKeyIfMissing("agent-pro", AGENTKEY);
  trustAdd("agent-pro", agentPub, "agent,viewer");
  ok(`trusted your app (${VIEWER_ID}) + agent 'agent-pro'`);

  const hub = spawnProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--tls-cert", `${DIR}/tls.crt`, "--tls-key", `${DIR}/tls.key`, "--hub-key", HUBKEY], /listening on (wss?:\/\/\S+)/);
  const { buf } = await hub.ready;
  const hubPort = Number(new URL(buf.match(/listening on (wss?:\/\/\S+)/)[1].replace(/^ws/, "http")).port);
  const hubPub = buf.match(/identity key (\S+)/)[1];
  ok(`hub up (persistent identity ${hubPub.slice(0, 12)}…)`);

  const kh = `${DIR}/known_hosts`;
  const tunnel = spawn("ssh", ["-NT", "-i", TUNNEL_KEY, "-o", "ExitOnForwardFailure=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${kh}`, "-o", "ServerAliveInterval=15", "-o", "BatchMode=yes", "-R", `0.0.0.0:443:127.0.0.1:${hubPort}`, `tunnel@${RELAY_IP}`], { stdio: ["ignore", "pipe", "pipe"] });
  procs.push({ name: "tunnel", cp: tunnel });
  let bound = false;
  for (let i = 0; i < 20 && !bound; i++) {
    try { execFileSync("nc", ["-z", "-G", "4", RELAY_IP, "443"], { stdio: "ignore" }); bound = true; } catch { await sleep(1000); }
  }
  if (!bound) throw new Error("reverse tunnel did not bind relay:443");
  ok("reverse tunnel bound relay:443");

  const sessiond = spawnProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sessiond.ready.catch(() => {});
  await sleep(400);
  spawnProc("agent", [AGENT, "--sessiond", SD, "--hub", `wss://${RELAY_IP}:443`, "--device-id", "agent-pro", "--name", "Pro", "--key", AGENTKEY, "--hub-key", hubPub, "--insecure-tls"], /registered with hub as agent-pro/, 15000);
  await procs[procs.length - 1] && (await new Promise((r) => setTimeout(r, 2500)));
  ok("agent 'Pro' registered through the relay");

  console.log(`\n\x1b[1m\x1b[32m READY.\x1b[0m In the Glass app connect screen, enter:`);
  console.log(`   hub url:  \x1b[36mwss://${RELAY_IP}:443\x1b[0m`);
  console.log(`   hub key:  \x1b[36m${hubPub}\x1b[0m`);
  console.log(`   then Connect → the "Pro" agent appears → "+ shell".\n`);
  console.log(`  (leaving hub + tunnel + agent running; kill this process to stop)`);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`\n\x1b[31mFAILED:\x1b[0m ${e.message}`);
  shutdown();
});
