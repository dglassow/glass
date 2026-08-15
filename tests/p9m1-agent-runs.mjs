/** Phase 9 M1: normalized multi-provider run/control plane acceptance. */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-p9m1-${process.pid}`;
const SD = `${RUN}/sd.sock`;
const STORE = `${RUN}/runs.json`;
const ETCH = `${RUN}/etch-stub`;
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
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await sleep(25); }
  throw new Error(`timed out waiting for ${label}`);
}

let hub, sessiond, agent, agent2, viewer;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass: P9 M1 agent runs\x1b[0m\n");

  writeFileSync(ETCH, `#!/usr/bin/env node
const readline=require("node:readline");
if(process.argv[2]==="--version"){console.log("etch-stub 1.2.0");process.exit(0);}
if(process.argv[2]==="surface"&&process.argv[3]==="--help"){console.log("etch surface --stdio");process.exit(0);}
let session="etch-session-1";
const send=(x)=>process.stdout.write(JSON.stringify(x)+"\\n");
send({jsonrpc:"2.0",method:"event",params:{type:"gateway.ready",payload:{protocol_version:"1.2.0",contract_hash:"sha256:"+"0".repeat(64),capabilities:{required:["event.message.stream","rpc.prompt.submit","rpc.session.lifecycle"],optional:["event.delegation","rpc.delegation.control","rpc.session.interrupt","rpc.session.observe"]},skin:{}}}});
readline.createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);const ok=(result)=>send({jsonrpc:"2.0",id:r.id,result});
 if(r.method==="session.create") return ok({session_id:session,stored_session_id:session,message_count:0,messages:[],info:{}});
 if(r.method==="prompt.submit"){ok({status:"streaming"});const base={jsonrpc:"2.0",method:"event"};const ev=(type,payload)=>send({...base,params:{type,session_id:session,payload}});ev("message.start",{});ev("subagent.start",{subagent_id:"child-1",goal:"review"});ev("subagent.tool",{subagent_id:"child-1",tool_name:"search",text:"checking"});ev("subagent.complete",{subagent_id:"child-1",status:"completed",summary:"done"});ev("message.delta",{text:"Etch handled: "+r.params.text+" glass="+process.env.GLASS_TERMINAL_SESSION_ID});ev("message.complete",{status:"completed"});return;}
 if(r.method==="session.interrupt") return ok({status:"interrupted"});
 if(r.method==="session.close") return ok({closed:true});
 if(r.method==="delegation.pause") return ok({paused:!!r.params.paused});
 if(r.method==="subagent.interrupt") return ok({found:true,subagent_id:r.params.subagent_id});
 ok({});
});
`, { mode: 0o755 });
  chmodSync(ETCH, 0o755);
  const env = { GLASS_ETCH_BIN: ETCH };

  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--open", "--run-store", STORE], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD], /listening on/, env);
  await sessiond.ready;
  agent = startProc("agent", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", "agent-one", "--name", "Agent One"], /registered with hub/, env);
  await agent.ready;

  let connected = 0;
  const events = [];
  const updates = [];
  viewer = new HubClient(url, "viewer-one", "Viewer", {
    onConnected: () => connected++,
    onRunEvent: (event) => events.push(event),
    onRunUpdated: (record) => updates.push(record),
  });
  viewer.connect();
  await waitUntil(() => connected > 0, "viewer connection");

  const devices = await viewer.listDevices();
  const provider = devices.find((device) => device.id === "agent-one")?.providers?.find((item) => item.id === "etch");
  check("agent advertises only a probed Etch structured adapter", provider?.present === true && provider.adapter === "structured" && provider.capabilities.includes("delegation"));

  const created = await viewer.createRun("agent-one", { provider: "etch", worktreeMode: "shared", title: "review Glass", cwd: ROOT, prompt: "review this" });
  await waitUntil(() => events.some((event) => event.runId === created.id && event.kind === "assistant.complete"), "Etch completion");
  check("Etch events normalize into one Glass run stream", events.some((event) => event.kind === "assistant.delta" && String(event.data.text).includes("Etch handled: review this")));
  check("Etch delegation is visible in the same stream", events.some((event) => event.kind === "subagent.start") && events.some((event) => event.kind === "subagent.complete"));
  check("Glass-native status aliases reach the provider", events.some((event) => event.kind === "assistant.delta" && String(event.data.text).includes(`glass=${created.id}`)));

  const listed = await viewer.listRuns();
  check("Hub persists provider-neutral run metadata", listed.some((run) => run.id === created.id && run.provider === "etch"));
  viewer.putWorkspace({ id: "agents", title: "Agent Board", runIds: [created.id], layout: { selected: created.id }, updatedAt: Date.now() });
  await sleep(100);
  const workspaces = await viewer.listWorkspaces();
  check("Hub persists Agent Board workspace state", workspaces.some((workspace) => workspace.id === "agents" && workspace.runIds.includes(created.id)));

  const previousCount = events.length;
  agent.cp.kill("SIGKILL");
  await sleep(250);
  agent2 = startProc("agent2", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", "agent-one", "--name", "Agent One"], /registered with hub/, env);
  await agent2.ready;
  await viewer.subscribeRun("agent-one", created.id, 0);
  check("run snapshot survives an Agent worker swap through sessiond", events.length > previousCount && events.some((event) => event.runId === created.id));
}

async function cleanup() {
  try { viewer?.close(); } catch {}
  for (const process of [agent, agent2, sessiond, hub]) { try { process?.cp?.kill("SIGTERM"); } catch {} }
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
  await cleanup();
  process.exit(1);
});
