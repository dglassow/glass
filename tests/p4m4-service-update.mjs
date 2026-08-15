/** Phase 4 M4 - staged stable-controller replacement, health gate, rollback. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("../", import.meta.url).pathname;
const CLIENT = join(ROOT, "deploy", "glass-backend.mjs");
const CONTROLLER = join(ROOT, "deploy", "glassd.mjs");
const RUN = join(tmpdir(), `glass-p4m4-${process.pid}`);
const SERVICE = join(RUN, "service");
const STATE = join(RUN, "state");
const LAUNCHCTL = join(RUN, "launchctl-stub.cjs");
const NODE_SOURCE = join(RUN, "portable-node");
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` - ${detail}` : ""}`);
};
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const env = {
  ...process.env,
  GLASS_SERVICE_DIR: SERVICE,
  GLASS_STATE_DIR: STATE,
  GLASS_LAUNCH_AGENT_PATH: join(RUN, "com.glassow.glass.backend.plist"),
  GLASS_LAUNCHCTL_BIN: LAUNCHCTL,
  GLASS_RUNTIME_SOURCE: ROOT,
  GLASS_RUNTIME_ID: "p4m4",
  GLASS_RUNTIME_VERSION: "0.1.7-test",
  GLASS_SERVICE_UPDATE_TIMEOUT_MS: "2500",
  GLASS_SERVICE_NODE_SOURCE: NODE_SOURCE,
  TEST_SERVICE_DIR: SERVICE,
};

function client(path, args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path, ...args], { cwd: ROOT, env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFailure) reject(new Error(`${error.message}\n${stderr}`));
      else resolve({ ok: !error, stdout, stderr });
    });
  });
}

function marker(output, prefix) {
  const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`missing ${prefix}: ${output}`);
  return JSON.parse(line.slice(prefix.length).trim());
}

async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(SERVICE, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass - P4 M4 stable service update + rollback\x1b[0m\n");

  writeFileSync(NODE_SOURCE, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  copyFileSync(NODE_SOURCE, join(SERVICE, "node"));
  chmodSync(join(SERVICE, "node"), 0o755);
  writeFileSync(join(SERVICE, "glassd.mjs"), `// deliberately old controller\nawait import(${JSON.stringify(pathToFileURL(CONTROLLER).href)});\n`, { mode: 0o600 });
  const oldControllerId = digest(join(SERVICE, "glassd.mjs"));

  writeFileSync(LAUNCHCTL, `#!/usr/bin/env node
const {spawn}=require("node:child_process");
const {createHash}=require("node:crypto");
const {closeSync,existsSync,openSync,readFileSync,rmSync,writeFileSync}=require("node:fs");
const {join}=require("node:path");
void (async()=>{
const service=process.env.TEST_SERVICE_DIR,pidFile=join(service,"launchctl.pid"),cmd=process.argv[2];
const alive=()=>{try{process.kill(Number(readFileSync(pidFile,"utf8")),0);return true}catch{return false}};
if(cmd==="print")process.exit(alive()?0:3);
if(cmd==="bootout"){
 if(alive()){try{process.kill(Number(readFileSync(pidFile,"utf8")),"SIGTERM")}catch{};const end=Date.now()+8000;while(alive()&&Date.now()<end)await new Promise(r=>setTimeout(r,50));}
 rmSync(pidFile,{force:true});process.exit(0);
}
if(cmd==="bootstrap"){
 const controller=join(service,"glassd.mjs"),node=join(service,"node"),id=createHash("sha256").update(readFileSync(controller)).digest("hex");
 const log=openSync(join(service,"glassd.log"),"a",0o600);
 const child=spawn(node,[controller,"--service-dir",service,"--config",join(service,"config.json"),"--control",join(service,"control.sock"),"--controller-id",id],{detached:true,stdio:["ignore",log,log],env:process.env});
 closeSync(log);writeFileSync(pidFile,String(child.pid),{mode:0o600});child.unref();process.exit(0);
}
if(cmd==="kickstart")process.exit(0);
process.exit(2);
})();
`, { mode: 0o755 });
  chmodSync(LAUNCHCTL, 0o755);

  const started = await client(CLIENT, ["--role", "standalone"]);
  const ready = marker(started.stdout, "GLASS_BACKEND_READY");
  check("new app stages glassd without replacing the running controller", ready.serviceUpdate?.pending === true && digest(join(SERVICE, "glassd.mjs")) === oldControllerId);

  const applied = await client(CLIENT, ["--apply-service-update"]);
  const result = marker(applied.stdout, "GLASS_BACKEND_UPDATED");
  check("explicit maintenance restarts the stack on the staged controller", result.updated === true && result.restarted === true && result.status?.running === true);
  check("replacement controller identity is health-checked", result.status?.controllerId === digest(CONTROLLER));
  check("successful activation clears staged files", result.serviceUpdate?.pending === false);

  const badBundle = join(RUN, "bad-bundle");
  mkdirSync(badBundle, { recursive: true });
  cpSync(CLIENT, join(badBundle, "glass-backend.mjs"));
  writeFileSync(join(badBundle, "glassd.mjs"), "process.exit(91);\n", { mode: 0o600 });
  const stagedBad = await client(join(badBundle, "glass-backend.mjs"), ["--status"]);
  check("a later controller is staged for the same safe boundary", marker(stagedBad.stdout, "GLASS_BACKEND_STATUS").serviceUpdate?.pending === true);
  const failed = await client(join(badBundle, "glass-backend.mjs"), ["--apply-service-update"], true);
  check("an unhealthy controller update fails visibly", failed.ok === false && failed.stderr.includes("previous controller restored"));
  const afterRollback = await client(CLIENT, ["--status"]);
  const restored = marker(afterRollback.stdout, "GLASS_BACKEND_STATUS");
  check("failed activation restores the previous controller and configured stack", restored.running === true && restored.controllerId === digest(CONTROLLER));
}

async function cleanup() {
  try { await client(CLIENT, ["--shutdown-service"], true); } catch {}
  try { await client(LAUNCHCTL, ["bootout"], true); } catch {}
  await sleep(150);
  rmSync(RUN, { recursive: true, force: true });
}

const timeout = setTimeout(() => cleanup().finally(() => process.exit(1)), 120_000);
run().then(async () => {
  clearTimeout(timeout);
  await cleanup();
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`);
  process.exit(failed.length ? 1 : 0);
}).catch(async (error) => {
  clearTimeout(timeout);
  console.error(`\n\x1b[31mERROR:\x1b[0m ${error.message}`);
  try { console.error(readFileSync(join(SERVICE, "glassd.log"), "utf8")); } catch {}
  await cleanup();
  process.exit(1);
});
