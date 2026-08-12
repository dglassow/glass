/**
 * Unified local backend launcher for the desktop app. The Tauri shell spawns
 * this with a --role, and it brings up (and supervises) the right processes for
 * that role, printing exactly one line:
 *
 *     GLASS_BACKEND_READY <json>        e.g. {"role":"standalone","hubUrl":"ws://127.0.0.1:53411"}
 *
 * then stays running until killed (it tears its children down on SIGTERM/exit).
 *
 * Roles:
 *   standalone  local OPEN ws hub + sessiond + agent — everything on this Mac,
 *               no auth, no TLS. The app UI connects to hubUrl over loopback.
 *   hub         local TRUST ws hub (auto-trusts the app's viewer device from
 *               VIEWER_ID/VIEWER_PUB) + sessiond + agent; the app connects over
 *               ws loopback. Remote spokes are a later step (need a real cert on
 *               the relay for browser/PWA clients).
 *   spoke       sessiond + agent joining a REMOTE hub (HUB_URL[/HUB_PIN]); the
 *               app UI connects to HUB_URL (which must be reachable + trust this
 *               device). Reported hubUrl = HUB_URL.
 *
 * Env: GLASS_HOME (repo root; defaults to two levels up from this file),
 *      VIEWER_ID, VIEWER_PUB (the app's device identity, for hub mode),
 *      HUB_URL, HUB_PIN (spoke mode).
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.GLASS_HOME || join(SELF_DIR, "..");

// Resolve a service main for either the dev repo (packages/<pkg>/dist) or a
// bundled deploy (node_modules/@glass/<pkg>/dist, next to this launcher).
function resolveMain(pkg) {
  const cands = [join(HOME, "packages", pkg, "dist", "main.js"), join(SELF_DIR, "node_modules", "@glass", pkg, "dist", "main.js")];
  return cands.find((c) => existsSync(c)) ?? cands[0];
}
const HUB = resolveMain("hub");
const SESSIOND = resolveMain("sessiond");
const AGENT = resolveMain("agent");
// State (device keys, trust store) must live somewhere writable — never inside a
// read-only .app bundle.
const DIR = process.env.GLASS_STATE_DIR || join(homedir(), ".glass", "desktop");

const roleArg = (() => {
  const i = process.argv.indexOf("--role");
  return i >= 0 ? process.argv[i + 1] : "standalone";
})();

const b64u = (b) => Buffer.from(b).toString("base64url");
// The exact node binary running this launcher — robust against a minimal PATH
// (a GUI-launched desktop app), unlike a bare "node".
const NODE = process.execPath;
const procs = [];
function spawnProc(name, args, readyRe, timeoutMs = 12000) {
  const cp = spawn(NODE, args, { stdio: ["ignore", "pipe", "pipe"] });
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
    cp.once("exit", (c) => reject(new Error(`${name} exited (${c}): ${buf.slice(-400)}`)));
    setTimeout(() => reject(new Error(`${name} not ready in ${timeoutMs}ms: ${buf.slice(-400)}`)), timeoutMs);
  });
  return { cp, ready, out: () => buf };
}
async function genKeyIfMissing(deviceId, path) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")).publicKey; // was execFileSync("cat")
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const privateKeyPkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  writeFileSync(path, JSON.stringify({ v: 1, deviceId, publicKey, privateKeyPkcs8 }), { mode: 0o600 });
  return publicKey;
}
const trustAdd = (ts, id, pub, roles) => execFileSync(NODE, [HUB, "trust", "add", "--trust-store", ts, "--device-id", id, "--name", id, "--public-key", pub, "--roles", roles]);
const ready = (obj) => console.log(`GLASS_BACKEND_READY ${JSON.stringify(obj)}`);
const shutdown = () => {
  for (const { cp } of procs.reverse()) try { cp.kill("SIGTERM"); } catch { /* gone */ }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function hubPortFrom(buf) {
  return Number(new URL(buf.match(/listening on (wss?:\/\/\S+)/)[1].replace(/^ws/, "http")).port);
}

async function standalone() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const hub = spawnProc("hub", [HUB, "--listen", "127.0.0.1:0", "--open"], /listening on (wss?:\/\/\S+)/);
  const port = hubPortFrom((await hub.ready).buf);
  const SD = `${DIR}/standalone.sock`;
  const sd = spawnProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sd.ready.catch(() => {});
  await sleep(300);
  const agent = spawnProc("agent", [AGENT, "--sessiond", SD, "--hub", `ws://127.0.0.1:${port}`, "--device-id", "local", "--name", "This Mac"], /registered with hub/);
  await agent.ready;
  ready({ role: "standalone", hubUrl: `ws://127.0.0.1:${port}` });
}

async function hub() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const TS = `${DIR}/hub-trust.json`;
  const HUBKEY = `${DIR}/hub-identity.json`;
  const AGENTKEY = `${DIR}/hub-agent.json`;
  const viewerId = process.env.VIEWER_ID;
  const viewerPub = process.env.VIEWER_PUB;
  if (!viewerId || !viewerPub) throw new Error("hub role needs VIEWER_ID/VIEWER_PUB (the app's device identity)");
  trustAdd(TS, viewerId, viewerPub, "viewer");
  const agentPub = await genKeyIfMissing("hub-agent", AGENTKEY);
  trustAdd(TS, "hub-agent", agentPub, "agent,viewer");
  // ws (loopback) so the local app UI can connect without a TLS cert. Remote
  // spokes over the relay are a later step (they need a real cert for the PWA).
  const h = spawnProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--hub-key", HUBKEY], /listening on (wss?:\/\/\S+)/);
  const buf = (await h.ready).buf;
  const port = hubPortFrom(buf);
  const hubKey = buf.match(/identity key (\S+)/)[1];
  const SD = `${DIR}/hub.sock`;
  const sd = spawnProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sd.ready.catch(() => {});
  await sleep(300);
  const agent = spawnProc("agent", [AGENT, "--sessiond", SD, "--hub", `ws://127.0.0.1:${port}`, "--device-id", "hub-agent", "--name", "This Mac", "--key", AGENTKEY], /registered with hub/);
  await agent.ready;
  ready({ role: "hub", hubUrl: `ws://127.0.0.1:${port}`, hubKey });
}

async function spoke() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const hubUrl = process.env.HUB_URL;
  if (!hubUrl) throw new Error("spoke role needs HUB_URL");
  const AGENTKEY = `${DIR}/spoke-agent.json`;
  await genKeyIfMissing("spoke-agent", AGENTKEY);
  const SD = `${DIR}/spoke.sock`;
  const sd = spawnProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sd.ready.catch(() => {});
  await sleep(300);
  const args = [AGENT, "--sessiond", SD, "--hub", hubUrl, "--device-id", "spoke-agent", "--name", "This Mac", "--key", AGENTKEY, "--insecure-tls"];
  if (process.env.HUB_PIN) args.push("--hub-key", process.env.HUB_PIN);
  const agent = spawnProc("agent", args, /registered with hub|HUB IDENTITY VERIFICATION FAILED/, 15000);
  await agent.ready;
  ready({ role: "spoke", hubUrl });
}

const roles = { standalone, hub, spoke };
(roles[roleArg] ?? standalone)()
  .then(() => new Promise(() => {})) // stay up until killed
  .catch((e) => {
    console.error(`GLASS_BACKEND_ERROR ${e.message}`);
    shutdown();
  });
