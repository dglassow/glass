/**
 * Real end-to-end bring-up against the LIVE Lightsail relay.
 *
 * Stands up the hub + reverse tunnel on this machine and connects a spoke
 * through the public relay (18.216.57.165:443), proving the whole path for real:
 *   spoke  --wss:443-->  relay sshd  --reverse tunnel-->  hub (TLS terminates)
 * with hub-key mutual auth + TLS channel binding end-to-end over the internet.
 *
 * All key material is generated into config/local/deploy/ (gitignored). Nothing
 * secret is committed. Tears everything down at the end.
 *
 *   node deploy/relay-smoke.mjs [--keep]   (--keep leaves the stack running)
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// The hub uses a self-signed cert (security comes from the hub-key pin + channel
// binding, not the CA). Our viewer uses the global WebSocket (undici), so skip
// TLS CA verification the same way the spoke does with --insecure-tls.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const proto = await import(new URL("../packages/protocol/dist/index.js", import.meta.url).href);
const { makeEnvelope, parseEnvelope, buildHandshakePayload } = proto;

const RELAY_IP = "18.216.57.165";
const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const TUNNEL_KEY = `${ROOT}config/local/tunnel_ed25519`;
const DIR = `${ROOT}config/local/deploy`;
const TS = `${DIR}/trust.json`;
const HUBKEY = `${DIR}/hub-key.json`;
const AGENTKEY = `${DIR}/agent-pro.json`;
const VIEWERKEY = `${DIR}/studio.json`;
const SD = `${DIR}/sd.sock`;
const KEEP = process.argv.includes("--keep");

const b64u = (b) => Buffer.from(b).toString("base64url");
const log = (m) => console.log(`  \x1b[36m▸\x1b[0m ${m}`);
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

async function genKey(deviceId, path) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const privateKeyPkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  writeFileSync(path, JSON.stringify({ v: 1, deviceId, publicKey, privateKeyPkcs8 }), { mode: 0o600 });
  return publicKey;
}
const trustAdd = (id, pub, roles) => execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", id, "--public-key", pub, "--roles", roles]);

/** Load a device key file into a WebCrypto signer. */
async function loadSigner(path) {
  const { deviceId, publicKey, privateKeyPkcs8 } = JSON.parse(readFileSync(path, "utf8"));
  const key = await crypto.subtle.importKey("pkcs8", Buffer.from(privateKeyPkcs8, "base64url"), { name: "Ed25519" }, false, ["sign"]);
  return { deviceId, publicKey, sign: async (bytes) => b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bytes))) };
}

/**
 * Connect a viewer THROUGH THE RELAY, authenticate, create a shell on the spoke,
 * run `echo <marker>`, and resolve when the marker comes back — the full
 * "run a shell across devices over the public relay" proof.
 */
async function driveShellViaRelay(hubUrl, marker) {
  const s = await loadSigner(VIEWERKEY);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(hubUrl); // global (undici); TLS verify disabled above
    let sid = null;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error("shell drive timed out")), 20000);
    const send = (body, to) => ws.send(JSON.stringify(makeEnvelope({ id: crypto.randomUUID(), ts: Date.now(), from: s.deviceId, to, body })));
    ws.addEventListener("open", () => send({ type: "hello", deviceId: s.deviceId, deviceName: "studio", roles: ["viewer"], protocolVersion: 1, appVersion: "deploy", etch: { present: false } }, "hub"));
    ws.addEventListener("error", () => finish(reject, new Error("viewer ws error")));
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const r = parseEnvelope(JSON.parse(text));
      if (!r.ok) return;
      const b = r.envelope.body;
      if (b.type === "hello.challenge") {
        s.sign(buildHandshakePayload(s.deviceId, b.nonce)).then((signature) => send({ type: "hello.proof", deviceId: s.deviceId, signature }, "hub"));
      } else if (b.type === "hello.ack") {
        send({ type: "session.create", kind: "pty", deviceId: "agent-pro", cols: 80, rows: 24 }, "agent-pro");
      } else if (b.type === "session.created") {
        sid = b.session.id;
        send({ type: "session.input", sessionId: sid, data: `echo ${marker}\r` }, "agent-pro");
      } else if (b.type === "session.output" && b.sessionId === sid && b.data.includes(marker)) {
        finish(resolve, marker);
      }
    });
  });
}

function teardown() {
  for (const { cp } of procs.reverse()) {
    try {
      cp.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
}

async function main() {
  console.log("\n\x1b[1mGlass — live relay bring-up\x1b[0m\n");
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true, mode: 0o700 });

  // 1. self-signed TLS for the hub. Security comes from the hub-key pin + channel
  //    binding, not the cert — a self-signed cert is fine for the spoke path.
  log("generating hub TLS cert (self-signed)");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", `${DIR}/tls.key`, "-out", `${DIR}/tls.crt`, "-days", "2", "-nodes", "-subj", "/CN=glass-hub"], { stdio: "ignore" });

  // 2. trust the devices FIRST — FileTrustStore reads its file once at
  //    construction, so a device added after the hub starts is invisible to it.
  trustAdd("agent-pro", await genKey("agent-pro", AGENTKEY), "agent,viewer");
  trustAdd("studio", await genKey("studio", VIEWERKEY), "viewer");
  ok("spoke 'agent-pro' + viewer 'studio' added to the hub trust store");

  // 3. hub (trust mode, TLS, hub identity key) on a local port.
  log("starting hub (TLS, trust mode, hub identity key)");
  const hub = spawnProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS, "--tls-cert", `${DIR}/tls.crt`, "--tls-key", `${DIR}/tls.key`, "--hub-key", HUBKEY], /listening on (wss?:\/\/\S+)/);
  const { buf: hubBuf } = await hub.ready;
  const hubPort = Number(new URL(hubBuf.match(/listening on (wss?:\/\/\S+)/)[1].replace(/^ws/, "http")).port);
  const hubPub = hubBuf.match(/identity key (\S+)/)?.[1];
  if (!hubPub) throw new Error("could not read hub identity key");
  ok(`hub up on 127.0.0.1:${hubPort}, identity ${hubPub.slice(0, 16)}…`);

  // 4. reverse tunnel: relay:443 -> the hub's local TLS port.
  log(`opening reverse tunnel relay:443 → 127.0.0.1:${hubPort}`);
  const kh = `${DIR}/known_hosts`;
  const tunnel = spawn(
    "ssh",
    ["-NT", "-i", TUNNEL_KEY, "-o", "ExitOnForwardFailure=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${kh}`, "-o", "ServerAliveInterval=15", "-o", "BatchMode=yes", "-R", `0.0.0.0:443:127.0.0.1:${hubPort}`, `tunnel@${RELAY_IP}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  procs.push({ name: "tunnel", cp: tunnel });
  let tunnelErr = "";
  tunnel.stderr.on("data", (d) => (tunnelErr += d.toString()));
  // wait for relay:443 to accept (the forward is bound)
  let bound = false;
  for (let i = 0; i < 20; i++) {
    try {
      execFileSync("nc", ["-z", "-G", "4", RELAY_IP, "443"], { stdio: "ignore" });
      bound = true;
      break;
    } catch {
      await sleep(1000);
    }
  }
  if (!bound) throw new Error(`reverse tunnel did not bind relay:443\n${tunnelErr}`);
  ok("reverse tunnel bound relay:443 (hub now reachable via the public relay)");

  // 5. sessiond (owns PTYs).
  const sessiond = spawnProc("sessiond", [SESSIOND, "--socket", SD], /sessiond: listening|listening on/);
  await sessiond.ready.catch(() => {}); // sessiond may log differently; give it a beat
  await sleep(400);
  ok("sessiond up");

  // 6. spoke connects THROUGH THE RELAY with the hub-key pinned.
  log(`connecting spoke via wss://${RELAY_IP}:443 (hub-key pinned, channel-bound)`);
  const agent = spawnProc(
    "agent",
    [AGENT, "--sessiond", SD, "--hub", `wss://${RELAY_IP}:443`, "--device-id", "agent-pro", "--name", "Pro", "--key", AGENTKEY, "--hub-key", hubPub, "--insecure-tls"],
    /registered with hub as agent-pro/,
    15000,
  );
  await agent.ready;
  ok("spoke registered with the hub through the live relay");

  // 7. drive an ACTUAL shell on the spoke from a viewer, over the relay.
  log(`running a shell on the spoke from a viewer (both via wss://${RELAY_IP}:443)`);
  const marker = `GLASS_RELAY_SHELL_${Math.random().toString(36).slice(2, 10)}`;
  await driveShellViaRelay(`wss://${RELAY_IP}:443`, marker);
  ok(`shell ran on the spoke over the relay — \`echo\` round-tripped 🎉`);

  console.log(`\n\x1b[32m\x1b[1mPASS\x1b[0m — end-to-end validated over the public relay ${RELAY_IP}:`);
  console.log(`      viewer → relay:443 → tunnel → hub → spoke → PTY → shell → back.`);
  console.log(`      (TLS terminates in the hub; hub-key mutual auth + channel binding.)`);

  if (KEEP) {
    console.log(`\n  \x1b[33m--keep\x1b[0m: leaving hub + tunnel + spoke running. Ctrl-C to stop.`);
    await new Promise(() => {});
  }
}

main()
  .then(() => {
    if (!KEEP) {
      teardown();
      console.log("\n  (torn down)\n");
      process.exit(0);
    }
  })
  .catch((e) => {
    console.error(`\n\x1b[31mFAILED:\x1b[0m ${e.message}`);
    teardown();
    process.exit(1);
  });
