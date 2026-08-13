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
 *               ws loopback. If ~/.glass/hub.json (GLASS_HUB_CONFIG) supplies a
 *               real cert + relay + tunnel key, the hub ALSO runs a TLS wss://
 *               listener tunneled to the relay so remote spokes and the PWA can
 *               reach it at publicUrl; without it the hub stays loopback-only.
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
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as netConnect } from "node:net";

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
// The port of the first listener whose scheme matches exactly ("ws" | "wss").
function portFromScheme(buf, scheme) {
  const re = new RegExp(`listening on (${scheme}://\\S+)`);
  const m = buf.match(re);
  return m ? Number(new URL(m[1].replace(/^wss?/, "http")).port) : null;
}

// Optional local exposure config (never in the public repo — it holds the relay
// IP, tunnel key path, cert paths, and public hostname). Present + valid =>
// the hub also serves a TLS wss:// listener tunneled to the relay, so remote
// spokes and the PWA can reach it. Absent/incomplete => loopback-only hub.
function loadHubExposure() {
  const path = process.env.GLASS_HUB_CONFIG || join(homedir(), ".glass", "hub.json");
  if (!existsSync(path)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const need = ["tlsCert", "tlsKey", "relayHost", "tunnelKey"];
  for (const k of need) {
    if (!cfg[k]) { console.error(`hub: exposure config missing "${k}"; staying loopback-only`); return null; }
  }
  for (const f of [cfg.tlsCert, cfg.tlsKey, cfg.tunnelKey]) {
    if (!existsSync(f)) { console.error(`hub: exposure file not found (${f}); staying loopback-only`); return null; }
  }
  return cfg;
}

// TCP-reachability probe (used to confirm the relay forward actually bound).
function checkReachable(host, port, ms = 4000) {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    const done = (ok) => { try { s.destroy(); } catch { /* */ } resolve(ok); };
    s.setTimeout(ms);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

// Supervised reverse tunnel relay:PORT -> 127.0.0.1:tlsPort (respawns via the
// hub's TunnelKeeper). Uses a stable known_hosts with accept-new on first use.
function openRelayTunnel(cfg, tlsPort) {
  const kh = join(homedir(), ".glass", "relay_known_hosts");
  const relayPort = cfg.relayPort || 443;
  const ssh = [
    "ssh", "-NT",
    "-i", cfg.tunnelKey,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${kh}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "BatchMode=yes",
    "-R", `0.0.0.0:${relayPort}:127.0.0.1:${tlsPort}`,
    `${cfg.relayUser || "tunnel"}@${cfg.relayHost}`,
  ];
  return spawnProc("tunnel", [HUB, "tunnel", "--", ...ssh], /tunnel: up \(pid/, 20000);
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

  // Always a loopback ws:// listener so THIS Mac's window connects with no cert.
  // If a local exposure config is present, ALSO run a TLS wss:// listener (same
  // hub, shared trust) tunneled to the relay, so NEO/phone can reach it.
  const expose = loadHubExposure();
  const args = [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--hub-key", HUBKEY];
  if (expose) {
    args.push("--tls-listen", "127.0.0.1:0", "--tls-cert", expose.tlsCert, "--tls-key", expose.tlsKey);
    if (expose.webRoot && existsSync(expose.webRoot)) args.push("--web-root", expose.webRoot);
    if (expose.gitRoot && existsSync(expose.gitRoot)) args.push("--git-root", expose.gitRoot);
    // Desktop auto-update endpoint (/updates/) so spokes self-update from the hub.
    const updatesDir = expose.updatesRoot || join(homedir(), ".glass", "updates");
    if (existsSync(updatesDir)) args.push("--updates-root", updatesDir);
  }
  // With exposure there are two "listening on" lines; wait for the sentinel so
  // both are buffered before we scrape ports. Loopback-only prints one line.
  const readyRe = expose ? /hub: ready — \d+ listener/ : /listening on (wss?:\/\/\S+)/;
  const h = spawnProc("hub", args, readyRe);
  const buf = (await h.ready).buf;
  const port = expose ? portFromScheme(buf, "ws") : hubPortFrom(buf);
  const hubKey = buf.match(/identity key (\S+)/)[1];

  let publicUrl;
  if (expose) {
    const tlsPort = portFromScheme(buf, "wss");
    const host = expose.publicHost || expose.relayHost;
    publicUrl = `wss://${host}${(expose.relayPort || 443) === 443 ? "" : `:${expose.relayPort}`}`;
    const t = openRelayTunnel(expose, tlsPort);
    await t.ready.catch((e) => console.error(`hub: tunnel not confirmed (${e.message}); local app still works`));
    // The reverse forward binds a beat after ssh spawns; poll before reporting.
    let reachable = false;
    for (let i = 0; i < 8 && !reachable; i++) {
      reachable = await checkReachable(expose.relayHost, expose.relayPort || 443, 3000);
      if (!reachable) await sleep(1500);
    }
    console.error(`hub: relay ${expose.relayHost}:${expose.relayPort || 443} ${reachable ? "reachable — spokes can connect at " + publicUrl : "not confirmed reachable yet (tunnel still settling)"}`);
  }

  const SD = `${DIR}/hub.sock`;
  const sd = spawnProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sd.ready.catch(() => {});
  await sleep(300);
  const agent = spawnProc("agent", [AGENT, "--sessiond", SD, "--hub", `ws://127.0.0.1:${port}`, "--device-id", "hub-agent", "--name", "This Mac", "--key", AGENTKEY], /registered with hub/);
  await agent.ready;
  ready({ role: "hub", hubUrl: `ws://127.0.0.1:${port}`, hubKey, ...(publicUrl ? { publicUrl } : {}) });
}

async function spoke() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const hubUrl = process.env.HUB_URL;
  if (!hubUrl) throw new Error("spoke role needs HUB_URL");
  // A spoke connects with cert validation disabled, so the hub key pin (+ channel
  // binding) is the ONLY defense against a hostile relay MITM. Require it.
  if (!process.env.HUB_PIN) throw new Error("spoke role needs HUB_PIN (the hub key) — refusing to connect with an unpinned hub over TLS-without-validation");
  const AGENTKEY = `${DIR}/spoke-agent.json`;
  // Each Mac gets a stable, UNIQUE agent id so multiple spokes never collide on
  // the hub. Installs that persisted the old shared "spoke-agent" keep it (so
  // they need no re-trusting); only fresh installs mint a unique id.
  const agentId = existsSync(AGENTKEY)
    ? JSON.parse(readFileSync(AGENTKEY, "utf8")).deviceId || "spoke-agent"
    : `spoke-${crypto.randomUUID().slice(0, 8)}`;
  const agentPub = await genKeyIfMissing(agentId, AGENTKEY);
  const name = hostname();
  const SD = `${DIR}/spoke.sock`;
  const sd = spawnProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sd.ready.catch(() => {});
  await sleep(300);
  const args = [AGENT, "--sessiond", SD, "--hub", hubUrl, "--device-id", agentId, "--name", name, "--key", AGENTKEY, "--insecure-tls", "--hub-key", process.env.HUB_PIN];
  const agent = spawnProc("agent", args, /registered with hub|HUB IDENTITY VERIFICATION FAILED/, 15000);
  // Don't hard-fail if the agent isn't trusted yet: a brand-new spoke can't
  // register until the viewer enrolls it (its key rides along as a companion).
  // Wait briefly for a definitive outcome, then report ready so the viewer can
  // drive enrollment; the agent keeps retrying and registers once approved.
  await Promise.race([agent.ready.catch(() => {}), sleep(3000)]);
  ready({ role: "spoke", hubUrl, agentId, agentPub, agentName: name });
}

const roles = { standalone, hub, spoke };
(roles[roleArg] ?? standalone)()
  .then(() => new Promise(() => {})) // stay up until killed
  .catch((e) => {
    console.error(`GLASS_BACKEND_ERROR ${e.message}`);
    shutdown();
  });
