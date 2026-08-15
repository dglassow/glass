/**
 * Phase 4, Milestone 3: shipped-app blue/green integration.
 *
 * Drives the short-lived desktop launcher against a real persistent glassd,
 * Hub, supervisor, sessiond, Agent, and PTY. It proves app/client exit does not
 * own the backend; a new runtime blue/green-swaps Agent and restarts Hub while
 * retaining the exact sessiond + shell PIDs and contiguous scrollback; and a
 * broken green runtime rolls back without touching the session.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const CLIENT = join(ROOT, "deploy", "glass-backend.mjs");
const HUB = join(ROOT, "packages", "hub", "dist", "main.js");
const SESSIOND = join(ROOT, "packages", "sessiond", "dist", "main.js");
const AGENT = join(ROOT, "packages", "agent", "dist", "main.js");
const SUPERVISOR = join(ROOT, "packages", "supervisor", "dist", "main.js");
const RUN = join(tmpdir(), `glass-p4m3-${process.pid}`);
const SERVICE = join(RUN, "service");
const STATE = join(RUN, "state");

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? `: ${detail}` : ""}`);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const childrenOf = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const ticks = (text) => [...new Set([...text.matchAll(/TICK(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
const contiguous = (values) => values.every((value, index) => index === 0 || value === values[index - 1] + 1);

const baseEnv = {
  ...process.env,
  GLASS_SERVICE_MODE: "direct",
  GLASS_SERVICE_DIR: SERVICE,
  GLASS_STATE_DIR: STATE,
};

function client(args, extraEnv = {}, allowFailure = false) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLIENT, ...args],
      { cwd: ROOT, env: { ...baseEnv, ...extraEnv }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !allowFailure) reject(new Error(`${error.message}\n${stderr}`));
        else resolve({ ok: !error, stdout, stderr });
      },
    );
  });
}

function parsedLine(output, prefix) {
  const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`missing ${prefix}: ${output}`);
  const json = line.slice(prefix.length).trim();
  return json ? JSON.parse(json) : null;
}

async function status() {
  const result = await client(["--status"]);
  return parsedLine(result.stdout, "GLASS_BACKEND_STATUS");
}

class Peer {
  constructor(url, id) {
    this.id = id;
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.acked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("viewer handshake timed out")), 8000);
      this.ws.addEventListener("open", () => {
        this.send({ type: "hello", deviceId: id, deviceName: id, roles: ["viewer"], protocolVersion: 1, appVersion: "p4m3", etch: { present: false } }, "hub");
      });
      this.ws.addEventListener("message", (event) => {
        const envelope = JSON.parse(event.data);
        this.messages.push(envelope);
        if (envelope.body?.type === "hello.ack") {
          clearTimeout(timer);
          resolve(envelope);
        }
        this.waiters = this.waiters.filter((waiter) => {
          if (!waiter.predicate(envelope)) return true;
          clearTimeout(waiter.timer);
          waiter.resolve(envelope);
          return false;
        });
      });
    });
  }

  send(body, to = "local") {
    const id = randomUUID();
    this.ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), from: this.id, to, body }));
    return id;
  }

  waitFor(predicate, label, timeoutMs = 8000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitForAgent(peer, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = peer.send({ type: "device.list" }, "hub");
    try {
      const listed = await peer.waitFor(
        (message) => message.replyTo === id && message.body?.type === "device.listed",
        "device.listed",
        700,
      );
      if (listed.body.devices.some((device) => device.id === "local" && device.state === "connected")) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("local Agent did not reconnect to the restarted Hub");
}

function wrapper(path, target, broken = false) {
  mkdirSync(join(path, "packages", target, "dist"), { recursive: true });
  const entry = join(path, "packages", target, "dist", "main.js");
  writeFileSync(
    entry,
    broken ? "process.exit(42);\n" : `await import(${JSON.stringify(pathToFileURL(target === "hub" ? HUB : AGENT).href)});\n`,
  );
  return entry;
}

let firstViewer;
let secondViewer;
let lastStatus;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass: P4 M3 persistent service + shipped blue/green path\x1b[0m\n");

  const tauriMain = readFileSync(join(ROOT, "packages", "desktop", "src-tauri", "src", "main.rs"), "utf8");
  check(
    "Tauri window/app exit has no backend teardown hook",
    !tauriMain.includes("WindowEvent::CloseRequested") && !tauriMain.includes("RunEvent::Exit") && !tauriMain.includes("kill_backend("),
  );

  const started = await client(["--role", "standalone"], { GLASS_RUNTIME_ID: "runtime-a" });
  const ready = parsedLine(started.stdout, "GLASS_BACKEND_READY");
  lastStatus = await status();
  check("desktop launcher exits after handing ownership to glassd", lastStatus.running && alive(lastStatus.controllerPid));
  check("glassd owns a real supervisor + sessiond", alive(lastStatus.supervisorPid) && alive(lastStatus.supervisor.sessiond.pid));

  firstViewer = new Peer(ready.hubUrl, "viewer-before-update");
  await firstViewer.acked;
  const createId = firstViewer.send({ type: "session.create", kind: "pty", deviceId: "local", cols: 80, rows: 24 });
  const created = await firstViewer.waitFor((message) => message.replyTo === createId && message.body?.type === "session.created", "session.created");
  const sessionId = created.body.session.id;
  firstViewer.send({ type: "session.input", sessionId, data: "i=0; while true; do echo TICK$i; i=$((i+1)); sleep 0.15; done\r" });
  await firstViewer.waitFor((message) => message.body?.type === "session.output" && /TICK4/.test(message.body.data), "initial ticks");

  const sessiondPid = lastStatus.supervisor.sessiond.pid;
  const workerPid = lastStatus.supervisor.worker.pid;
  const shellPid = childrenOf(sessiondPid)[0];
  check("sessiond owns the live shell before update", shellPid && alive(shellPid), `sessiond=${sessiondPid} shell=${shellPid}`);

  // This is the app-exit boundary: the launcher's process is already gone and
  // the Viewer disconnects. No stop command is sent.
  firstViewer.close();
  firstViewer = null;
  await sleep(500);
  check("viewer/app exit leaves controller, sessiond, and shell alive", alive(lastStatus.controllerPid) && alive(sessiondPid) && alive(shellPid));

  const runtimeB = join(RUN, "runtime-b");
  const hubB = wrapper(runtimeB, "hub");
  const agentB = wrapper(runtimeB, "agent");
  const activated = await client(["--role", "standalone"], {
    GLASS_RUNTIME_ID: "runtime-b",
    GLASS_HUB_ENTRY: hubB,
    GLASS_AGENT_ENTRY: agentB,
    GLASS_SESSIOND_ENTRY: SESSIOND,
    GLASS_SUPERVISOR_ENTRY: SUPERVISOR,
  });
  const readyB = parsedLine(activated.stdout, "GLASS_BACKEND_READY");
  const after = await status();
  lastStatus = after;
  check("runtime activation blue/green-swaps Agent", after.runtime.startsWith("runtime-b-") && after.supervisor.worker.pid !== workerPid);
  check("runtime activation retains the exact sessiond + shell PIDs", after.supervisor.sessiond.pid === sessiondPid && alive(shellPid));
  check("Hub restarts on the same stable local URL", readyB.hubUrl === ready.hubUrl && after.hubPid !== null);

  secondViewer = new Peer(readyB.hubUrl, "viewer-after-update");
  await secondViewer.acked;
  await waitForAgent(secondViewer);
  const attachId = secondViewer.send({ type: "session.attach", sessionId });
  const attached = await secondViewer.waitFor((message) => message.replyTo === attachId && message.body?.type === "session.attached", "session.attached");
  const scrollbackTicks = ticks(attached.body.scrollback);
  check(
    "fresh Viewer reattaches with contiguous pre/post-update scrollback",
    scrollbackTicks.length >= 5 && scrollbackTicks[0] === 0 && contiguous(scrollbackTicks),
    `ticks ${scrollbackTicks[0]}..${scrollbackTicks.at(-1)}`,
  );
  const marker = `AFTER_UPDATE_${randomUUID().slice(0, 8)}`;
  secondViewer.send({ type: "session.input", sessionId, data: `echo ${marker}\r` });
  await secondViewer.waitFor(
    (message) => message.body?.type === "session.output" && message.body.sessionId === sessionId && message.body.data.includes(marker),
    "post-update live I/O",
  );
  check("live input/output continues after Viewer + Hub + Agent replacement", alive(shellPid));

  const runtimeC = join(RUN, "runtime-c-broken");
  const hubC = wrapper(runtimeC, "hub");
  const agentC = wrapper(runtimeC, "agent", true);
  const failed = await client(
    ["--role", "standalone"],
    {
      GLASS_RUNTIME_ID: "runtime-c",
      GLASS_HUB_ENTRY: hubC,
      GLASS_AGENT_ENTRY: agentC,
      GLASS_SESSIOND_ENTRY: SESSIOND,
      GLASS_SUPERVISOR_ENTRY: SUPERVISOR,
    },
    true,
  );
  check("broken green runtime is refused", !failed.ok && /agent swap failed/.test(failed.stderr));
  const rolledBack = await status();
  lastStatus = rolledBack;
  check("failed activation keeps prior runtime + sessiond", rolledBack.runtime === after.runtime && rolledBack.supervisor.sessiond.pid === sessiondPid && alive(shellPid));
  const rollbackMarker = `AFTER_ROLLBACK_${randomUUID().slice(0, 8)}`;
  secondViewer.send({ type: "session.attach", sessionId });
  await secondViewer.waitFor((message) => message.body?.type === "session.attached", "rollback attach");
  secondViewer.send({ type: "session.input", sessionId, data: `echo ${rollbackMarker}\r` });
  await secondViewer.waitFor(
    (message) => message.body?.type === "session.output" && message.body.sessionId === sessionId && message.body.data.includes(rollbackMarker),
    "rollback live I/O",
  );
  check("session remains interactive after green rollback", alive(shellPid));

  // Reconfigure is intentionally different from app exit: it is the explicit
  // destructive boundary. After stopping, a fresh spoke that is offline or not
  // enrolled yet must still keep its Agent attached to sessiond so the Viewer
  // can drive companion enrollment. This weaker initial state never applies to
  // swap candidates, which the checks above proved still require full READY.
  secondViewer.close();
  secondViewer = null;
  await client(["--stop"]);
  await sleep(200);
  check("explicit Reconfigure stop terminates the old local shell", !alive(shellPid));
  const pendingSpoke = await client(
    ["--role", "spoke"],
    { GLASS_RUNTIME_ID: "pending-spoke", HUB_URL: "ws://127.0.0.1:9", HUB_PIN: "offline-test-pin" },
  );
  const spokeInfo = parsedLine(pendingSpoke.stdout, "GLASS_BACKEND_READY");
  lastStatus = await status();
  check(
    "fresh offline/untrusted spoke stays service-ready for enrollment",
    spokeInfo.role === "spoke" && lastStatus.running && lastStatus.supervisor.worker.pid,
  );
}

async function cleanup() {
  firstViewer?.close();
  secondViewer?.close();
  try {
    await client(["--shutdown-service"], {}, true);
  } catch {}
  await sleep(300);
  for (const pid of [lastStatus?.controllerPid, lastStatus?.hubPid, lastStatus?.supervisorPid, lastStatus?.supervisor?.sessiond?.pid]) {
    if (pid && alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  rmSync(RUN, { recursive: true, force: true });
}

const hardTimeout = setTimeout(() => {
  console.error("\n\x1b[31mFATAL: exceeded 90s\x1b[0m");
  void cleanup().then(() => process.exit(1));
}, 90_000);

run()
  .then(async () => {
    clearTimeout(hardTimeout);
    await cleanup();
    const failed = checks.filter((item) => !item.ok);
    console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch(async (err) => {
    clearTimeout(hardTimeout);
    console.error(`\n\x1b[31mERROR:\x1b[0m ${err.stack || err.message}`);
    await cleanup();
    process.exit(1);
  });
