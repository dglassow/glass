/**
 * Phase 1 · Milestone 1 — acceptance test for the local loop.
 *
 * Proves the one load-bearing claim of the whole design: the PTY lives in
 * sessiond, not the worker, so killing and restarting the worker (agent) leaves
 * the shell running with its scrollback intact.
 *
 * This harness is deliberately adversarial and independent — it speaks raw
 * NDJSON to the agent socket (it does NOT import @glass/protocol), so it can't
 * pass just because our own framing code agrees with itself. It reattaches from
 * a FRESH client (empty local buffer) and generates output continuously WHILE
 * the worker is dead, the two checks a naive implementation fails.
 *
 * Run after `pnpm build`:  node tests/m1-acceptance.mjs
 */
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;

const RUN = `/tmp/glass-accept-${process.pid}`;
const SD_SOCK = `${RUN}/sd.sock`;
const AGENT_SOCK = `${RUN}/agent.sock`;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function info(msg) {
  console.log(`  \x1b[90m····\x1b[0m  ${msg}`);
}

// ---- process + os helpers -------------------------------------------------
function startProc(name, args, readyRe) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  cp.stdout.on("data", () => {});
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (readyRe.test(err)) {
        clearInterval(iv);
        resolve();
      }
    }, 25);
    cp.once("exit", (code) => {
      clearInterval(iv);
      reject(new Error(`${name} exited early (code ${code}). stderr:\n${err}`));
    });
    setTimeout(() => {
      clearInterval(iv);
      reject(new Error(`${name} not ready in 8s. stderr:\n${err}`));
    }, 8000);
  });
  return { cp, ready };
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const psField = (pid, field) => {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const childrenOf = (ppid) => {
  try {
    return execFileSync("pgrep", ["-P", String(ppid)], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
};
const lsof = (pid) => {
  try {
    return execFileSync("lsof", ["-p", String(pid)], { encoding: "utf8" });
  } catch {
    return "";
  }
};
const ticks = (s) => {
  const set = new Set();
  for (const m of s.matchAll(/TICK(\d+)/g)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
};
const contiguous = (nums) => nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);

// ---- a raw NDJSON client of the agent socket ------------------------------
class Client {
  constructor(path) {
    this.sock = net.connect(path);
    this.sock.setEncoding("utf8");
    this.buf = "";
    this.envs = [];
    this.waiters = [];
    this.sock.on("data", (chunk) => this._onData(chunk));
    this.connected = new Promise((res, rej) => {
      this.sock.once("connect", res);
      this.sock.once("error", rej);
    });
  }
  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let env;
      try {
        env = JSON.parse(line);
      } catch {
        continue;
      }
      this.envs.push(env);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(env)) {
          w.resolve(env);
          return false;
        }
        return true;
      });
    }
  }
  send(body) {
    const env = { v: 1, id: randomUUID(), ts: Date.now(), from: "cli", to: "agent", body };
    this.sock.write(JSON.stringify(env) + "\n");
  }
  waitFor(pred, label, timeoutMs = 6000) {
    const existing = this.envs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
    });
  }
  outputs(sid) {
    return this.envs.filter((e) => e.body?.type === "session.output" && e.body.sessionId === sid);
  }
  text(sid) {
    return this.outputs(sid)
      .map((e) => e.body.data)
      .join("");
  }
  maxSeq(sid) {
    return this.outputs(sid).reduce((m, e) => Math.max(m, e.body.seq), 0);
  }
  close() {
    this.sock.destroy();
  }
}

// ---- the test -------------------------------------------------------------
let sessiond, agent1, agent2;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });

  console.log("\n\x1b[1mGlass — M1 local-loop acceptance test\x1b[0m\n");

  // 1. sessiond (owns the PTY) and agent (worker) come up.
  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD_SOCK], /listening on/);
  await sessiond.ready;
  agent1 = startProc("agent", [AGENT, "--sessiond", SD_SOCK, "--listen", AGENT_SOCK], /listening on/);
  await agent1.ready;
  info(`sessiond pid=${sessiond.cp.pid}, agent pid=${agent1.cp.pid}`);

  // 2. Client creates a pty session and starts a continuous counter.
  const c1 = new Client(AGENT_SOCK);
  await c1.connected;
  c1.send({ type: "session.create", kind: "pty", deviceId: "local", cols: 80, rows: 24 });
  const created = await c1.waitFor((e) => e.body?.type === "session.created", "session.created");
  const sid = created.body.session.id;
  info(`session ${sid}`);

  await sleep(500); // let the shell finish starting before we type
  c1.send({
    type: "session.input",
    sessionId: sid,
    data: "i=0; while true; do echo TICK$i; i=$((i+1)); sleep 0.2; done\r",
  });

  // 3. Observe live ticks before the kill.
  await sleep(2000);
  const before = ticks(c1.text(sid));
  const lastSeqBefore = c1.maxSeq(sid);
  check("worker relays live PTY output", before.length >= 3, `saw ticks up to ${before.at(-1)} (seq ${lastSeqBefore})`);

  // 4. The shell must be a child of sessiond, not the agent.
  const kids = childrenOf(sessiond.cp.pid);
  const shellPid = kids[0];
  const shellPpid = shellPid ? Number(psField(shellPid, "ppid")) : -1;
  check("PTY child is owned by sessiond", shellPid !== undefined && shellPpid === sessiond.cp.pid,
    `shell pid=${shellPid}, ppid=${shellPpid} (sessiond=${sessiond.cp.pid})`);

  // Supplementary fd-ownership evidence (informational — ppid proof is decisive).
  const sdHasPty = /ptmx|ttys\d/.test(lsof(sessiond.cp.pid));
  const agHasPty = /ptmx|ttys\d/.test(lsof(agent1.cp.pid));
  info(`lsof: sessiond holds a pty=${sdHasPty}, agent holds a pty=${agHasPty}`);

  // 5. HARD-KILL the worker (SIGKILL — no graceful detach).
  process.kill(agent1.cp.pid, "SIGKILL");
  await sleep(200);

  // 6. The shell must be untouched: alive, same ppid, not a zombie.
  const stat = psField(shellPid, "stat");
  check("shell survives the worker kill", alive(shellPid), `shell pid=${shellPid} still alive`);
  check("shell not reparented / not a zombie",
    Number(psField(shellPid, "ppid")) === sessiond.cp.pid && !stat.includes("Z"),
    `ppid=${psField(shellPid, "ppid")}, stat=${stat || "?"}`);

  // 7. Keep the counter running for the whole down-window so we can prove
  //    sessiond buffered output while NO worker was attached.
  await sleep(2000);

  // 8. Restart the worker and reattach from a FRESH client (empty buffer).
  agent2 = startProc("agent2", [AGENT, "--sessiond", SD_SOCK, "--listen", AGENT_SOCK], /listening on/);
  await agent2.ready;
  info(`restarted agent pid=${agent2.cp.pid}`);

  const c2 = new Client(AGENT_SOCK);
  await c2.connected;
  c2.send({ type: "session.attach", sessionId: sid });
  const attached = await c2.waitFor((e) => e.body?.type === "session.attached", "session.attached");
  const exitedEarly = c2.envs.find((e) => e.body?.type === "session.exited");
  check("no false session.exited on worker kill", !exitedEarly, "fresh client got session.attached, shell still live");

  // 9. Scrollback (from a fresh client) must span before AND during the outage.
  const sb = ticks(attached.body.scrollback);
  const maxDuringDown = sb.at(-1);
  check("scrollback survives and comes from sessiond",
    sb.length > 0 && maxDuringDown > before.at(-1),
    `fresh-client scrollback has ticks 0..${maxDuringDown}; last-before-kill was ${before.at(-1)}`);
  check("no gap across the outage (continuous buffering while detached)",
    contiguous(sb) && sb[0] === 0,
    `ticks ${sb[0]}..${sb.at(-1)} contiguous=${contiguous(sb)}`);

  // 10. Live bidirectional I/O is restored; seq never reset.
  const marker = `REATTACH_${randomUUID().slice(0, 8)}`;
  c2.send({ type: "session.input", sessionId: sid, data: `echo ${marker}\r` });
  const markerOut = await c2.waitFor(
    (e) => e.body?.type === "session.output" && e.body.data.includes(marker),
    "marker echo",
  );
  check("live input/output works after reattach", !!markerOut, `saw ${marker}`);
  const firstSeqAfter = c2.outputs(sid)[0]?.body.seq ?? 0;
  check("seq is owned by sessiond and never resets",
    firstSeqAfter > lastSeqBefore,
    `first post-reattach seq ${firstSeqAfter} > last-before-kill seq ${lastSeqBefore}`);

  // 11. Clean up the session.
  c2.send({ type: "session.close", sessionId: sid });
  await sleep(300);
  c1.close();
  c2.close();
}

async function cleanup() {
  for (const p of [agent1, agent2, sessiond]) {
    try {
      if (p?.cp?.pid && alive(p.cp.pid)) process.kill(p.cp.pid, "SIGTERM");
    } catch {}
  }
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}

const hardTimeout = setTimeout(() => {
  console.error("\n\x1b[31mFATAL: test exceeded 45s — aborting\x1b[0m");
  cleanup().finally(() => process.exit(1));
}, 45000);

run()
  .then(async () => {
    clearTimeout(hardTimeout);
    await cleanup();
    const failed = checks.filter((c) => !c.ok);
    console.log(
      `\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`,
    );
    process.exit(failed.length ? 1 : 0);
  })
  .catch(async (err) => {
    clearTimeout(hardTimeout);
    console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`);
    await cleanup();
    process.exit(1);
  });
