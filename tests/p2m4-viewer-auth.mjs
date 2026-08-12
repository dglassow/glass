/**
 * Phase 2 · Milestone 4 — acceptance test for the AUTHENTICATED viewer.
 *
 * Like m3 this drives the ACTUAL built HubClient, but against a TRUST-MODE hub
 * with a hub identity key: the viewer proves possession of its trusted device
 * key (challenge/response) AND pins the hub's public key (mutual auth). The
 * viewer does NO channel binding — browsers cannot export TLS keying material —
 * so the hub signs its proof with cb="" and the client verifies with cb="";
 * plain ws:// is therefore sufficient here. It proves the authenticated client
 * registers, lists the agent, runs a real shell round-trip through the stack,
 * and that a WRONG hub-key pin is refused (no registration, explicit error).
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/p2m4-viewer-auth.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const ROOT = new URL("../", import.meta.url).pathname;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const RUN = `/tmp/glass-p2m4-${process.pid}`;
const SD_SOCK = `${RUN}/sd.sock`;
const TS = `${RUN}/trust.json`;
const HUB_KEY = `${RUN}/hub-key.json`;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const info = (m) => console.log(`  \x1b[90m····\x1b[0m  ${m}`);

// ---- independent crypto (same as p2m1: not @glass/protocol) ---------------
function b64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function makeIdentity(deviceId) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const pkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  return {
    deviceId,
    publicKey: pub,
    keyFileJson: JSON.stringify({ v: 1, deviceId, publicKey: pub, privateKeyPkcs8: pkcs8 }, null, 2),
    /** protocol-shaped Signer for the HubClient: sign(Uint8Array) -> Uint8Array */
    signer: {
      publicKey: pub,
      async sign(payload) {
        return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, payload));
      },
    },
  };
}

// ---- process helpers ------------------------------------------------------
function startProc(name, args, readyRe) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
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
      reject(new Error(`${name} exited early (${code}). stderr:\n${err}`));
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
function trustAdd(id, name, publicKey, roles) {
  execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", name, "--public-key", publicKey, "--roles", roles], { encoding: "utf8" });
}
async function waitUntil(fn, label, capMs = 8000) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---- the test -------------------------------------------------------------
let sessiond, hub, agent, client, badClient;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — P2 M4 authenticated-viewer acceptance test\x1b[0m\n");

  // Identities: an agent and the viewer (as the app's auth.ts would generate).
  // Both must be trusted BEFORE the hub starts (file store loads once).
  const agentId = await makeIdentity("agent-pro");
  const keyFile = `${RUN}/agent-pro.key.json`;
  writeFileSync(keyFile, agentId.keyFileJson, { mode: 0o600 });
  trustAdd("agent-pro", "Pro", agentId.publicKey, "agent");

  const viewerId = await makeIdentity("viewer-studio");
  trustAdd("viewer-studio", "Studio", viewerId.publicKey, "viewer");

  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD_SOCK], /listening on/);
  await sessiond.ready;
  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--hub-key", HUB_KEY], /listening on (ws:\/\/\S+)/);
  const hubUrl = (await hub.ready)[1];
  const hubPin = hub.err().match(/identity key (\S+)/)?.[1];
  check("hub prints its identity key to pin", typeof hubPin === "string" && hubPin.length > 0, hubPin ?? "not found");

  agent = startProc("agent", [AGENT, "--sessiond", SD_SOCK, "--hub", hubUrl, "--device-id", "agent-pro", "--name", "Pro", "--key", keyFile], /registered with hub/);
  await agent.ready;
  info(`sessiond=${sessiond.cp.pid} hub=${hub.cp.pid} agent=${agent.cp.pid} @ ${hubUrl} (trust mode)`);

  // --- drive the REAL viewer client, authenticated + hub-key pinned ---
  const out = new Map(); // sessionId -> concatenated output text
  const errors = [];
  let connectedCount = 0;

  client = new HubClient(
    hubUrl,
    "viewer-studio",
    "Studio",
    {
      onConnected: () => connectedCount++,
      onOutput: (sid, data) => out.set(sid, (out.get(sid) ?? "") + data),
      onError: (code, message) => errors.push({ code, message }),
    },
    viewerId.signer,
    hubPin,
  );
  client.connect();
  await waitUntil(() => connectedCount > 0, "authenticated client connected");
  check("viewer authenticates (device proof + verified hub identity)", connectedCount === 1);

  const devices = await client.listDevices();
  const agentDev = devices.find((d) => d.id === "agent-pro");
  check("authenticated viewer lists the agent", !!agentDev && agentDev.roles.includes("agent") && agentDev.state === "connected", agentDev ? `state=${agentDev.state}` : "not found");

  const session = await client.createSession("agent-pro", { kind: "pty", cols: 80, rows: 24 });
  const sid = session.id;
  check("viewer creates a pty session under enforcement", session.kind === "pty" && session.deviceId === "agent-pro" && session.alive === true, `sid=${sid}`);

  await sleep(400);
  const marker = `P2M4_${randomUUID().slice(0, 8)}`;
  client.input("agent-pro", sid, `echo ${marker}\r`);
  await waitUntil(() => (out.get(sid) ?? "").includes(marker), "marker echo");
  check("shell round-trip through the authenticated stack", (out.get(sid) ?? "").includes(marker), marker);
  check("no protocol errors on the happy path", errors.length === 0, errors.map((e) => e.code).join(","));

  client.closeSession("agent-pro", sid);
  await sleep(300);
  client.close();

  // --- a WRONG hub-key pin must be refused: no ack, explicit error, no retry loop ---
  const wrongPin = (await makeIdentity("impostor-hub")).publicKey; // valid-shaped Ed25519 key, but not the hub's
  const badErrors = [];
  let badConnected = 0;
  badClient = new HubClient(
    hubUrl,
    "viewer-studio",
    "Studio",
    {
      onConnected: () => badConnected++,
      onError: (code, message) => badErrors.push({ code, message }),
    },
    viewerId.signer,
    wrongPin,
  );
  badClient.connect();
  await waitUntil(() => badErrors.length > 0, "wrong-pin refusal");
  await sleep(700); // give a broken client time to (wrongly) retry and register
  check("wrong hub-key pin is refused (hub_identity error)", badErrors.some((e) => e.code === "hub_identity"), badErrors.map((e) => e.code).join(",") || "no error");
  check("wrong-pin client never registers", badConnected === 0, `connected=${badConnected}`);
  badClient.close();
}

async function cleanup() {
  try {
    client?.close();
  } catch {}
  try {
    badClient?.close();
  } catch {}
  for (const p of [agent, hub, sessiond]) {
    try {
      if (p?.cp?.pid && aliveP(p.cp.pid)) process.kill(p.cp.pid, "SIGTERM");
    } catch {}
  }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}

const hardTimeout = setTimeout(() => {
  console.error("\n\x1b[31mFATAL: test exceeded 50s\x1b[0m");
  cleanup().finally(() => process.exit(1));
}, 50000);

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
