/**
 * Phase 1 · Milestone 3 — acceptance test for the Viewer's data layer.
 *
 * Unlike m1/m2 (which speak raw protocol), this drives the ACTUAL viewer code —
 * it imports the built HubClient and exercises it against a real
 * sessiond+hub+agent stack. It proves the browser/PWA end of the protocol works
 * AND that the viewer recovers on its own: after the agent is killed and
 * restarted, the client auto-re-attaches (triggered by the hub's device.state
 * broadcast, no manual attach call) and receives the scrollback that
 * accumulated during the outage. That auto-recovery is the piece the GUI relies
 * on and the piece a headless test can actually verify.
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/m3-viewer.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const ROOT = new URL("../", import.meta.url).pathname;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const RUN = `/tmp/glass-m3-${process.pid}`;
const SD_SOCK = `${RUN}/sd.sock`;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const info = (m) => console.log(`  \x1b[90m····\x1b[0m  ${m}`);

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
  return { cp, ready };
}
const aliveP = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ppidOf = (pid) => {
  try {
    return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return -1;
  }
};
const childrenOf = (ppid) => {
  try {
    return execFileSync("pgrep", ["-P", String(ppid)], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const ticks = (s) => {
  const set = new Set();
  for (const m of s.matchAll(/TICK(\d+)/g)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
};
const contiguous = (n) => n.every((v, i) => i === 0 || v === n[i - 1] + 1);
async function waitUntil(fn, label, capMs = 8000) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let sessiond, hub, agent1, agent2, client;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — M3 Viewer data-layer acceptance test\x1b[0m\n");

  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD_SOCK], /listening on/);
  await sessiond.ready;
  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--open"], /listening on (ws:\/\/\S+)/);
  const hubUrl = (await hub.ready)[1];
  agent1 = startProc("agent", [AGENT, "--sessiond", SD_SOCK, "--hub", hubUrl, "--device-id", "agent-pro", "--name", "Pro"], /registered with hub/);
  await agent1.ready;
  info(`sessiond=${sessiond.cp.pid} hub=${hub.cp.pid} agent=${agent1.cp.pid} @ ${hubUrl}`);

  // --- drive the REAL viewer client ---
  const out = new Map(); // sessionId -> concatenated output text
  const seqs = new Map(); // sessionId -> [seq...]
  const scrollbacks = []; // {sid, sb}
  const exits = [];
  let connectedCount = 0;

  client = new HubClient(hubUrl, "studio-viewer", "Studio", {
    onConnected: () => connectedCount++,
    onOutput: (sid, data, seq) => {
      out.set(sid, (out.get(sid) ?? "") + data);
      (seqs.get(sid) ?? seqs.set(sid, []).get(sid)).push(seq);
    },
    onScrollback: (sid, sb) => scrollbacks.push({ sid, sb }),
    onExited: (sid, code, signal) => exits.push({ sid, code, signal }),
    onError: () => {},
  });
  client.connect();
  await waitUntil(() => connectedCount > 0, "client connected");
  check("viewer connects + handshakes", connectedCount === 1);

  const devices = await client.listDevices();
  const agentDev = devices.find((d) => d.id === "agent-pro");
  check("viewer lists the agent via the hub", !!agentDev && agentDev.roles.includes("agent"), agentDev ? `state=${agentDev.state}` : "not found");

  const session = await client.createSession("agent-pro", { kind: "pty", cols: 80, rows: 24 });
  const sid = session.id;
  check("viewer creates a pty session", session.kind === "pty" && session.deviceId === "agent-pro" && session.alive === true, `sid=${sid}`);

  await sleep(400);
  client.input("agent-pro", sid, "i=0; while true; do echo TICK$i; i=$((i+1)); sleep 0.2; done\r");
  await waitUntil(() => ticks(out.get(sid) ?? "").length >= 3, "live ticks");
  const before = ticks(out.get(sid) ?? "");
  const lastSeqBefore = Math.max(...(seqs.get(sid) ?? [0]));
  check("viewer receives streamed output", before.length >= 3, `ticks up to ${before.at(-1)} (seq ${lastSeqBefore})`);

  const shellPid = childrenOf(sessiond.cp.pid)[0];
  check("PTY child owned by sessiond", shellPid !== undefined && ppidOf(shellPid) === sessiond.cp.pid, `shell=${shellPid}`);

  // Kill the worker; the viewer's WS to the hub stays open.
  process.kill(agent1.cp.pid, "SIGKILL");
  await sleep(250);
  check("shell survives worker kill", aliveP(shellPid) && ppidOf(shellPid) === sessiond.cp.pid);

  const sbCountBefore = scrollbacks.length;
  await sleep(2000); // counter keeps running into sessiond's ring, no worker attached

  // Restart the worker. The client must AUTO re-attach on the device.state
  // broadcast — the test does NOT call attach() itself.
  agent2 = startProc("agent2", [AGENT, "--sessiond", SD_SOCK, "--hub", hubUrl, "--device-id", "agent-pro", "--name", "Pro"], /registered with hub/);
  await agent2.ready;
  const replay = await waitUntil(() => scrollbacks.find((s, i) => i >= sbCountBefore && s.sid === sid), "auto re-attach scrollback");
  const sb = ticks(replay.sb);
  check("viewer auto-re-attaches after agent restart (no manual attach)", scrollbacks.length > sbCountBefore);
  check("replayed scrollback spans the outage (from sessiond)",
    sb.length > 0 && sb[0] === 0 && contiguous(sb) && sb.at(-1) > before.at(-1),
    `scrollback ticks 0..${sb.at(-1)}, last-before=${before.at(-1)}, contiguous=${contiguous(sb)}`);
  check("no false session.exited during the outage", exits.length === 0);

  // Live I/O resumes; seq never resets.
  const marker = `M3_${randomUUID().slice(0, 8)}`;
  const seqAtMarker = Math.max(...(seqs.get(sid) ?? [0]));
  client.input("agent-pro", sid, `echo ${marker}\r`);
  await waitUntil(() => (out.get(sid) ?? "").includes(marker), "marker echo");
  const firstAfter = (seqs.get(sid) ?? []).find((s) => s > lastSeqBefore) ?? 0;
  check("live I/O restored + seq never resets", firstAfter > lastSeqBefore, `resumed at seq > ${lastSeqBefore}`);

  // Real exit is delivered.
  client.closeSession("agent-pro", sid);
  await waitUntil(() => exits.find((e) => e.sid === sid), "real exit");
  check("real exit is delivered to the viewer", exits.some((e) => e.sid === sid));

  client.close();
}

async function cleanup() {
  try {
    client?.close();
  } catch {}
  for (const p of [agent1, agent2, hub, sessiond]) {
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
