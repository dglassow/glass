/** Phase 9 M4: mixed-provider concurrency, privacy, and failure isolation. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-p9m2-${process.pid}`;
const SD = `${RUN}/sd.sock`;
const STORE = `${RUN}/runs.json`;
const CODEX = `${RUN}/codex-stub`;
const CLAUDE = `${RUN}/claude-stub`;
const FAILING = `${RUN}/failing-stub`;
const OLD_ETCH = `${RUN}/old-etch-stub`;
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? `: ${detail}` : ""}`); };

function startProc(name, args, readyRe, env = {}) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let output = "";
  cp.stdout.on("data", (data) => { output += data.toString(); });
  cp.stderr.on("data", (data) => { output += data.toString(); });
  const ready = new Promise((resolve, reject) => {
    const interval = setInterval(() => { const match = output.match(readyRe); if (match) { clearInterval(interval); resolve(match); } }, 20);
    cp.once("exit", (code) => { clearInterval(interval); reject(new Error(`${name} exited (${code}): ${output}`)); });
    setTimeout(() => { clearInterval(interval); reject(new Error(`${name} not ready: ${output}`)); }, 10000);
  });
  return { cp, ready, output: () => output };
}

async function waitUntil(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(25); }
  throw new Error(`timed out waiting for ${label}`);
}

let hub, sessiond, sessiond2, agent, agent2, agent3, viewer, observer;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass: P9 M2 mixed providers\x1b[0m\n");

  writeFileSync(CODEX, `#!/usr/bin/env node
const readline=require("node:readline");
if(process.argv[2]==="--version"){console.log("codex-stub 1.0");process.exit(0);}
if((process.argv[2]==="app-server"||process.argv[2]==="exec")&&process.argv[3]==="--help"){console.log(process.argv[2]);process.exit(0);}
const send=(x)=>process.stdout.write(JSON.stringify(x)+"\\n");
readline.createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);
 if(r.method==="initialize") return send({jsonrpc:"2.0",id:r.id,result:{}});
 if(r.method==="initialized") return;
 if(r.method==="thread/start"||r.method==="thread/resume") return send({jsonrpc:"2.0",id:r.id,result:{thread:{id:"codex-thread-1"},model:"stub",modelProvider:"stub",cwd:process.cwd(),approvalPolicy:"on-request",approvalsReviewer:"user",sandbox:{type:"dangerFullAccess"}}});
 if(r.method==="turn/start"){send({jsonrpc:"2.0",id:r.id,result:{turn:{id:"turn-1",status:"inProgress",items:[]}}});send({jsonrpc:"2.0",method:"turn/started",params:{threadId:"codex-thread-1",turn:{id:"turn-1",status:"inProgress",items:[]}}});send({jsonrpc:"2.0",method:"item/agentMessage/delta",params:{threadId:"codex-thread-1",turnId:"turn-1",itemId:"msg-1",delta:"Codex waiting safely"}});send({jsonrpc:"2.0",id:"approval-1",method:"item/commandExecution/requestApproval",params:{threadId:"codex-thread-1",turnId:"turn-1",itemId:"cmd-1",startedAtMs:Date.now(),command:"echo isolated"}});return;}
 if(r.id==="approval-1"){send({jsonrpc:"2.0",method:"item/agentMessage/delta",params:{threadId:"codex-thread-1",turnId:"turn-1",itemId:"msg-1",delta:" and approved"}});send({jsonrpc:"2.0",method:"thread/tokenUsage/updated",params:{threadId:"codex-thread-1",turnId:"turn-1",tokenUsage:{total:{totalTokens:12},transcript:"SECRET_USAGE_CONTENT"}}});send({jsonrpc:"2.0",method:"turn/completed",params:{threadId:"codex-thread-1",turn:{id:"turn-1",status:"completed",items:[]}}});return;}
 if(r.method==="turn/interrupt") return send({jsonrpc:"2.0",id:r.id,result:{}});
});
`, { mode: 0o755 });
  writeFileSync(CLAUDE, `#!/usr/bin/env node
if(process.argv[2]==="--version"){console.log("claude-stub 1.0");process.exit(0);}
if(process.argv[2]==="--help"){console.log("--output-format stream-json");process.exit(0);}
let prompt="";process.stdin.on("data",x=>prompt+=x);process.stdin.on("end",()=>{console.log(JSON.stringify({type:"system",session_id:"claude-session-1"}));console.log(JSON.stringify({type:"stream_event",event:{delta:{text:"Claude handled: "+prompt}}}));console.log(JSON.stringify({type:"result",result:"done",usage:{input_tokens:3,output_tokens:4}}));});
`, { mode: 0o755 });
  writeFileSync(FAILING, `#!/usr/bin/env node\nprocess.stderr.write("injected provider failure\\n");process.exit(9);\n`, { mode: 0o755 });
  writeFileSync(OLD_ETCH, `#!/usr/bin/env node
if(process.argv[2]==="--version"){console.log("etch-stub 0.9");process.exit(0);}
if(process.argv[2]==="-z"){console.log("legacy Etch handled: "+process.argv[3]);process.exit(0);}
process.stderr.write("unknown command surface\\n");process.exit(2);
`, { mode: 0o755 });
  for (const file of [CODEX, CLAUDE, FAILING, OLD_ETCH]) chmodSync(file, 0o755);

  process.env.GLASS_ETCH_BIN = OLD_ETCH;
  const { ManagedRun } = await import("../packages/sessiond/dist/run.js");
  const legacyEvents = [];
  const legacy = new ManagedRun({
    type: "run.create", deviceId: "agent-one", provider: "etch", title: "legacy",
    prompt: "compatibility", worktreeMode: "shared",
  }, `${RUN}/legacy-status`);
  legacy.subscribe((value) => { if ("kind" in value) legacyEvents.push(value); });
  await waitUntil(() => legacyEvents.some((event) => event.kind === "assistant.complete"), "legacy Etch completion");
  check("older Etch falls back visibly to reduced etch -z", legacy.record.capabilities.includes("reduced") && legacyEvents.some((event) => event.kind === "notice") && legacyEvents.some((event) => String(event.data.text || "").includes("legacy Etch handled")));
  legacy.close();

  const env = {
    GLASS_ETCH_BIN: OLD_ETCH,
    GLASS_CODEX_BIN: CODEX,
    GLASS_CLAUDE_BIN: CLAUDE,
    GLASS_GENERIC_AGENT_ARGV: JSON.stringify([FAILING]),
  };

  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--open", "--run-store", STORE], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD], /listening on/, env);
  await sessiond.ready;
  agent = startProc("agent", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", "agent-one", "--name", "Agent One"], /registered with hub/, env);
  await agent.ready;

  const events = [];
  const observedEvents = [];
  const observerErrors = [];
  let connected = 0;
  let observerConnected = 0;
  viewer = new HubClient(url, "viewer-one", "Viewer", { onConnected: () => connected++, onRunEvent: (event) => events.push(event) });
  observer = new HubClient(url, "viewer-two", "Observer", {
    onConnected: () => observerConnected++,
    onRunEvent: (event) => observedEvents.push(event),
    onError: (code, message) => observerErrors.push({ code, message }),
  });
  viewer.connect(); observer.connect();
  await waitUntil(() => connected && observerConnected, "viewer connections");

  const forgedId = randomUUID();
  observer.rawSend("viewer-two", "hub", {
    type: "run.created",
    run: {
      id: forgedId, deviceId: "viewer-two", provider: "generic", title: "forged",
      state: "running", worktreeMode: "shared", capabilities: [], createdAt: Date.now(),
      updatedAt: Date.now(), lastEventSeq: 0,
    },
  });
  await waitUntil(() => observerErrors.some((error) => error.code === "unauthorized"), "forged run rejection");
  check("only an owning Agent may publish durable run metadata", !(await viewer.listRuns()).some((run) => run.id === forgedId));

  const codex = await viewer.createRun("agent-one", { provider: "codex", worktreeMode: "shared", title: "Codex", cwd: ROOT, prompt: "private codex prompt" });
  const claude = await viewer.createRun("agent-one", { provider: "claude", worktreeMode: "shared", title: "Claude", cwd: ROOT, prompt: "private claude prompt" });
  const failing = await viewer.createRun("agent-one", { provider: "generic", worktreeMode: "shared", title: "Failure", cwd: ROOT, prompt: "private failing prompt" });
  const approval = await waitUntil(() => events.find((event) => event.runId === codex.id && event.kind === "approval.required"), "Codex approval");
  await waitUntil(() => events.some((event) => event.runId === claude.id && event.kind === "assistant.complete"), "Claude completion");
  await waitUntil(() => events.some((event) => event.runId === failing.id && event.kind === "error"), "injected failure");
  check("Codex app-server and Claude structured CLI run concurrently", events.some((event) => event.runId === codex.id && String(event.data.text || "").includes("Codex waiting")) && events.some((event) => event.runId === claude.id && String(event.data.text || "").includes("Claude handled")));
  check("one provider failure does not interrupt waiting peers", events.some((event) => event.runId === failing.id && event.kind === "error") && approval.data.requestId);
  check("attention inbox identifies the waiting run without copying its request", (await viewer.listRuns()).some((run) => run.id === codex.id && run.state === "needs-input" && run.attention === "approval"));
  check("non-subscribers receive no run transcript events", observedEvents.length === 0, `${observedEvents.length} leaked events`);

  agent.cp.kill("SIGKILL");
  await sleep(250);
  agent2 = startProc("agent2", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", "agent-one", "--name", "Agent One"], /registered with hub/, env);
  await agent2.ready;
  await viewer.subscribeRun("agent-one", codex.id, 0);
  viewer.respondRun("agent-one", codex.id, String(approval.data.requestId), "once");
  await waitUntil(() => events.some((event) => event.runId === codex.id && event.kind === "assistant.complete"), "Codex completion after Agent swap");
  check("in-flight Codex app-server survives Agent replacement", events.some((event) => event.runId === codex.id && event.kind === "assistant.complete"));
  check("Codex aggregate usage is retained as metadata", (await viewer.listRuns()).some((run) => run.id === codex.id && run.usage?.total));

  const restartCandidate = await viewer.createRun("agent-one", {
    provider: "codex", worktreeMode: "shared", title: "Resume after daemon restart", cwd: ROOT, prompt: "wait for approval",
  });
  await waitUntil(() => events.some((event) => event.runId === restartCandidate.id && event.kind === "approval.required"), "restart candidate approval");
  const beforeRestart = (await viewer.listRuns()).find((run) => run.id === restartCandidate.id);
  sessiond.cp.kill("SIGTERM");
  await sleep(300);
  sessiond2 = startProc("sessiond2", [SESSIOND, "--socket", SD], /listening on/, env);
  await sessiond2.ready;
  agent3 = startProc("agent3", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", "agent-one", "--name", "Agent One"], /registered with hub/, env);
  await agent3.ready;
  await waitUntil(async () => (await viewer.listRuns()).some((run) => run.id === restartCandidate.id && run.state === "interrupted"), "stale run reconciliation");
  check("sessiond restart marks missing nonterminal runs interrupted", (await viewer.listRuns()).some((run) => run.id === restartCandidate.id && run.state === "interrupted"));
  const resumed = await viewer.createRun("agent-one", {
    provider: "codex", worktreeMode: "shared", title: "Resumed Codex", cwd: ROOT,
    ...(beforeRestart?.providerSessionId ? { providerSessionId: beforeRestart.providerSessionId } : {}),
  });
  await waitUntil(async () => (await viewer.listRuns()).some((run) => run.id === resumed.id && run.state === "idle"), "provider resume after daemon restart");
  check("interrupted provider state can resume into a new Glass run", !!beforeRestart?.providerSessionId && (await viewer.listRuns()).some((run) => run.id === resumed.id && run.providerSessionId === beforeRestart.providerSessionId));

  await sleep(100);
  const store = readFileSync(STORE, "utf8");
  check("Hub metadata store contains no prompts or provider output", !store.includes("private codex prompt") && !store.includes("private claude prompt") && !store.includes("Codex waiting safely") && !store.includes("SECRET_USAGE_CONTENT"));
}

async function cleanup() {
  try { viewer?.close(); observer?.close(); } catch {}
  for (const process of [agent, agent2, agent3, sessiond, sessiond2, hub]) { try { process?.cp?.kill("SIGTERM"); } catch {} }
  await sleep(200);
  rmSync(RUN, { recursive: true, force: true });
}

const timeout = setTimeout(() => cleanup().finally(() => process.exit(1)), 60000);
run().then(async () => {
  clearTimeout(timeout);
  await cleanup();
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`);
  process.exit(failed.length ? 1 : 0);
}).catch(async (error) => {
  clearTimeout(timeout);
  console.error(`\n\x1b[31mERROR:\x1b[0m ${error.message}`);
  for (const process of [hub, sessiond, sessiond2, agent, agent2, agent3]) {
    if (process?.output) console.error(process.output());
  }
  await cleanup();
  process.exit(1);
});
