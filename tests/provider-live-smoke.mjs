/**
 * Release-machine smoke for the real Etch, Codex, and Claude installations.
 *
 * The default probe is local and content-free. Pass --runs to start all three
 * providers together through the full Hub -> Agent -> sessiond path, replace
 * Agent while they are live, and require each provider to finish normally.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { detectProviders } from "../packages/agent/dist/providers.js";
import { HubClient } from "../packages/viewer/dist/hub-client.js";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-provider-live-${process.pid}`;
const SD = `${RUN}/sd.sock`;
const STORE = `${RUN}/runs.json`;
const DEVICE = "release-provider-smoke";
const required = ["etch", "codex", "claude"];

function startProc(name, args, readyRe) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let output = "";
  cp.stdout.on("data", (data) => { output += data.toString(); });
  cp.stderr.on("data", (data) => { output += data.toString(); });
  const ready = new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const match = output.match(readyRe);
      if (match) { clearInterval(interval); resolve(match); }
    }, 25);
    cp.once("exit", (code) => {
      clearInterval(interval);
      reject(new Error(`${name} exited (${code}): ${output}`));
    });
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`${name} not ready: ${output}`));
    }, 15_000);
  });
  return { cp, ready, output: () => output };
}

async function waitUntil(fn, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const providers = detectProviders();
console.log("Glass live-provider readiness:");
for (const provider of providers) {
  console.log(`  ${provider.id}: ${provider.adapter ?? "unknown"}${provider.version ? ` (${provider.version})` : ""}`);
}
const unavailable = providers.filter((provider) => required.includes(provider.id) && !provider.present);
if (unavailable.length) {
  throw new Error(`required provider surfaces unavailable: ${unavailable.map((provider) => `${provider.id}: ${provider.detail ?? "unavailable"}`).join("; ")}`);
}
if (!process.argv.includes("--runs")) {
  console.log("Provider surfaces are ready. Pass --runs for the authenticated live concurrency smoke.");
  process.exit(0);
}

let hub, sessiond, agent, replacement, viewer;
try {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--open", "--run-store", STORE], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  sessiond = startProc("sessiond", [SESSIOND, "--socket", SD], /listening on/);
  await sessiond.ready;
  agent = startProc("agent", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", DEVICE, "--name", "Release provider smoke"], /registered with hub/);
  await agent.ready;

  let connected = false;
  const events = [];
  viewer = new HubClient(url, "release-provider-viewer", "Release provider viewer", {
    onConnected: () => { connected = true; },
    onRunEvent: (event) => events.push(event),
  });
  viewer.connect();
  await waitUntil(() => connected, "Viewer connection", 15_000);

  const prompt = (provider) => `Do not use tools. Reply with exactly GLASS_${provider.toUpperCase()}_OK.`;
  const runs = await Promise.all(required.map((provider) => viewer.createRun(DEVICE, {
    provider,
    title: `Release smoke: ${provider}`,
    cwd: ROOT,
    worktreeMode: "shared",
    prompt: prompt(provider),
  })));

  agent.cp.kill("SIGKILL");
  await sleep(250);
  replacement = startProc("replacement Agent", [AGENT, "--sessiond", SD, "--hub", url, "--device-id", DEVICE, "--name", "Release provider smoke"], /registered with hub/);
  await replacement.ready;
  for (const run of runs) await viewer.subscribeRun(DEVICE, run.id, 0);

  const finished = await waitUntil(async () => {
    const records = await viewer.listRuns(DEVICE);
    const selected = records.filter((record) => runs.some((run) => run.id === record.id));
    if (selected.some((record) => record.state === "failed" || record.state === "needs-input" || record.state === "interrupted")) {
      throw new Error(`provider run did not finish unattended: ${selected.map((record) => `${record.provider}=${record.state}`).join(", ")}`);
    }
    return selected.length === required.length && selected.every((record) => record.state === "completed") ? selected : null;
  }, "all real provider runs");

  for (const run of finished) {
    const marker = `GLASS_${run.provider.toUpperCase()}_OK`;
    const output = events
      .filter((event) => event.runId === run.id && typeof event.data.text === "string")
      .map((event) => event.data.text)
      .join("");
    const sawMarker = output.includes(marker);
    if (!sawMarker) {
      const summary = events
        .filter((event) => event.runId === run.id)
        .map((event) => `${event.kind}${typeof event.data.text === "string" ? `[text:${event.data.text.length}]` : ""}`)
        .join(",");
      throw new Error(`${run.provider} completed without the expected response marker (events: ${summary || "none"})`);
    }
  }
  console.log("Live Etch, Codex, and Claude runs completed concurrently across an Agent replacement.");
} catch (error) {
  for (const process of [hub, sessiond, agent, replacement]) {
    if (process?.output) console.error(process.output());
  }
  throw error;
} finally {
  try { viewer?.close(); } catch {}
  for (const process of [agent, replacement, sessiond, hub]) {
    try { process?.cp?.kill("SIGTERM"); } catch {}
  }
  await sleep(250);
  rmSync(RUN, { recursive: true, force: true });
}
