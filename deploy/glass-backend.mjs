/**
 * Glass desktop backend client/bootstrap.
 *
 * This process is intentionally short-lived.  It installs/starts the durable
 * per-user glassd service, asks it to ensure the selected role, prints exactly
 * one readiness line for Tauri, and exits.  Closing or replacing Glass.app can
 * therefore never signal the PTY-owning sessiond.
 *
 *   node glass-backend.mjs --role standalone|hub|spoke
 *   node glass-backend.mjs --status
 *   node glass-backend.mjs --stop
 *   node glass-backend.mjs --apply-service-update
 *
 * Production bundles are copied to ~/.glass/runtimes/<version-or-digest>/
 * before activation, so launchd and live processes never execute from the
 * replaceable application bundle.  Dev checkouts run their built entries in
 * place. GLASS_SERVICE_MODE=direct is the launchd-free acceptance-test path.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as netConnect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.GLASS_HOME || resolve(SELF_DIR, "..");
const SERVICE_DIR = process.env.GLASS_SERVICE_DIR || join(homedir(), ".glass", "service");
const STATE_DIR = process.env.GLASS_STATE_DIR || join(homedir(), ".glass", "desktop");
const CONTROL_PATH = join(SERVICE_DIR, "control.sock");
const CONFIG_PATH = join(SERVICE_DIR, "config.json");
const PLIST_PATH = process.env.GLASS_LAUNCH_AGENT_PATH || join(homedir(), "Library", "LaunchAgents", "com.glassow.glass.backend.plist");
const LABEL = "com.glassow.glass.backend";
const DIRECT = process.env.GLASS_SERVICE_MODE === "direct";
const SERVICE_UPDATE_PATH = join(SERVICE_DIR, "update.json");
const LAUNCHCTL = process.env.GLASS_LAUNCHCTL_BIN || "launchctl";
const SERVICE_UPDATE_TIMEOUT_MS = Number(process.env.GLASS_SERVICE_UPDATE_TIMEOUT_MS || 30_000);
const SERVICE_NODE_SOURCE = process.env.GLASS_SERVICE_NODE_SOURCE || process.execPath;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

function marker(name, payload) {
  process.stdout.write(`${name}${payload === undefined ? "" : ` ${JSON.stringify(payload)}`}\n`);
}

function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`GLASS_BACKEND_ERROR ${message}\n`);
  process.exitCode = 1;
}

function regular(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function servicePaths() {
  return {
    node: DIRECT ? process.execPath : join(SERVICE_DIR, "node"),
    controller: DIRECT ? join(SELF_DIR, "glassd.mjs") : join(SERVICE_DIR, "glassd.mjs"),
    pendingNode: join(SERVICE_DIR, "node.pending"),
    pendingController: join(SERVICE_DIR, "glassd.pending.mjs"),
    previousNode: join(SERVICE_DIR, "node.previous"),
    previousController: join(SERVICE_DIR, "glassd.previous.mjs"),
  };
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveMain(root, pkg) {
  const explicit = process.env[`GLASS_${pkg.toUpperCase()}_ENTRY`];
  if (explicit) return resolve(explicit);
  const candidates = [
    join(root, "packages", pkg, "dist", "main.js"),
    join(root, "node_modules", "@glass", pkg, "dist", "main.js"),
  ];
  const found = candidates.find(regular);
  if (!found) throw new Error(`could not resolve @glass/${pkg} entry from ${root}`);
  return found;
}

function runtimeDigest(entries) {
  const hash = createHash("sha256");
  const visit = (path, relative) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(relative, name));
      return;
    }
    if (!stat.isFile()) return;
    hash.update(relative);
    hash.update(readFileSync(path));
  };
  for (const entry of entries) {
    const dist = dirname(entry);
    visit(dist, basename(dirname(dist)) + "/dist");
  }
  return hash.digest("hex");
}

function safeRuntimeId(value) {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  if (!safe || safe.length > 100) throw new Error(`invalid runtime id ${JSON.stringify(value)}`);
  return safe;
}

function runtimeFromRoot(root, nodePath, requestedId, digestOverride) {
  const runtime = {
    id: "",
    node: resolve(nodePath),
    hub: resolveMain(root, "hub"),
    sessiond: resolveMain(root, "sessiond"),
    agent: resolveMain(root, "agent"),
    supervisor: resolveMain(root, "supervisor"),
  };
  const digest = digestOverride || runtimeDigest([runtime.hub, runtime.sessiond, runtime.agent, runtime.supervisor]);
  runtime.id = safeRuntimeId(requestedId ? `${requestedId}-${digest.slice(0, 12)}` : `dev-${digest.slice(0, 12)}`);
  return runtime;
}

function atomicCopy(source, target, mode) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  copyFileSync(source, temp);
  if (mode) chmodSync(temp, mode);
  renameSync(temp, target);
}

function prepareServiceFiles() {
  const paths = servicePaths();
  mkdirSync(SERVICE_DIR, { recursive: true, mode: 0o700 });
  if (DIRECT) return paths;
  const controllerSource = join(SELF_DIR, "glassd.mjs");
  if (!regular(controllerSource)) throw new Error(`glassd controller is missing next to the launcher: ${controllerSource}`);
  if (!regular(paths.controller) || !regular(paths.node)) {
    atomicCopy(controllerSource, paths.controller, 0o600);
    atomicCopy(SERVICE_NODE_SOURCE, paths.node, 0o755);
    rmSync(SERVICE_UPDATE_PATH, { force: true });
    rmSync(paths.pendingController, { force: true });
    rmSync(paths.pendingNode, { force: true });
    return paths;
  }

  const currentControllerId = fileDigest(paths.controller);
  const targetControllerId = fileDigest(controllerSource);
  const currentNodeId = fileDigest(paths.node);
  const targetNodeId = fileDigest(SERVICE_NODE_SOURCE);
  if (currentControllerId === targetControllerId && currentNodeId === targetNodeId) {
    rmSync(SERVICE_UPDATE_PATH, { force: true });
    rmSync(paths.pendingController, { force: true });
    rmSync(paths.pendingNode, { force: true });
    return paths;
  }

  // Stage only. Replacing the stable controller or its Node binary while it is
  // running would make rollback impossible. Glass Doctor applies this at an
  // explicit destructive maintenance boundary.
  atomicCopy(controllerSource, paths.pendingController, 0o600);
  atomicCopy(SERVICE_NODE_SOURCE, paths.pendingNode, 0o755);
  writeFileSync(SERVICE_UPDATE_PATH, JSON.stringify({
    v: 1,
    version: process.env.GLASS_RUNTIME_VERSION || "unknown",
    currentControllerId,
    targetControllerId,
    currentNodeId,
    targetNodeId,
    stagedAt: Date.now(),
  }, null, 2) + "\n", { mode: 0o600 });
  return paths;
}

function serviceUpdateState(paths = servicePaths()) {
  const currentControllerId = regular(paths.controller) ? fileDigest(paths.controller) : null;
  if (DIRECT) return { pending: false, currentControllerId, mode: "direct" };
  const update = (() => {
    try { return JSON.parse(readFileSync(SERVICE_UPDATE_PATH, "utf8")); }
    catch { return null; }
  })();
  const valid = update?.v === 1
    && regular(paths.pendingController)
    && regular(paths.pendingNode)
    && fileDigest(paths.pendingController) === update.targetControllerId
    && fileDigest(paths.pendingNode) === update.targetNodeId;
  return {
    pending: !!valid,
    currentControllerId,
    ...(valid ? {
      targetControllerId: update.targetControllerId,
      version: update.version,
      stagedAt: update.stagedAt,
    } : {}),
  };
}

function bundledRuntime(serviceNode) {
  const sourceModules = join(SELF_DIR, "node_modules");
  if (!statSync(sourceModules, { throwIfNoEntry: false })?.isDirectory()) return null;

  const provenance = (() => {
    try { return JSON.parse(readFileSync(join(SELF_DIR, "provenance.json"), "utf8")); }
    catch { return null; }
  })();
  const bundledDigest = typeof provenance?.runtimeDigest === "string" && /^[0-9a-f]{64}$/.test(provenance.runtimeDigest)
    ? provenance.runtimeDigest
    : undefined;
  const requestedId = process.env.GLASS_RUNTIME_ID || process.env.GLASS_RUNTIME_VERSION || "bundle";
  const source = runtimeFromRoot(SELF_DIR, serviceNode, requestedId, bundledDigest);
  const runtimeRoot = process.env.GLASS_RUNTIME_ROOT || join(homedir(), ".glass", "runtimes");
  const destination = join(runtimeRoot, source.id);
  const manifestPath = join(destination, "runtime.json");
  if (!regular(manifestPath)) {
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    // A prior crash may have left an uncommitted directory. No process may use
    // a runtime until runtime.json exists, so removing this exact validated
    // destination is safe before the atomic reinstall.
    rmSync(destination, { recursive: true, force: true });
    const staging = `${destination}.${process.pid}.staging`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    cpSync(sourceModules, join(staging, "node_modules"), { recursive: true, dereference: true });
    if (regular(join(SELF_DIR, "package.json"))) copyFileSync(join(SELF_DIR, "package.json"), join(staging, "package.json"));
    if (regular(join(SELF_DIR, "provenance.json"))) copyFileSync(join(SELF_DIR, "provenance.json"), join(staging, "provenance.json"));
    writeFileSync(join(staging, "runtime.json"), JSON.stringify({ v: 1, id: source.id }, null, 2) + "\n", { mode: 0o600 });
    try {
      renameSync(staging, destination);
    } catch (err) {
      // A concurrent app launch may have won the identical atomic install.
      rmSync(staging, { recursive: true, force: true });
      if (!regular(manifestPath)) throw err;
    }
  }
  return runtimeFromRoot(destination, serviceNode, requestedId, bundledDigest);
}

function resolveRuntime(serviceNode) {
  const explicitRoot = process.env.GLASS_RUNTIME_SOURCE;
  if (explicitRoot) return runtimeFromRoot(resolve(explicitRoot), serviceNode, process.env.GLASS_RUNTIME_ID);

  // A repo checkout is the development path.  A distributed app has no
  // packages/*/dist next to deploy/, so its flat bundled node_modules path wins.
  try {
    const dev = runtimeFromRoot(REPO_ROOT, process.execPath, process.env.GLASS_RUNTIME_ID);
    return dev;
  } catch {
    const bundled = bundledRuntime(serviceNode);
    if (bundled) return bundled;
    throw new Error("no complete Glass runtime found (hub/sessiond/agent/supervisor)");
  }
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function installLaunchAgent(paths) {
  mkdirSync(dirname(PLIST_PATH), { recursive: true, mode: 0o700 });
  const log = join(SERVICE_DIR, "glassd.log");
  const controllerId = fileDigest(paths.controller);
  const args = [paths.node, paths.controller, "--service-dir", SERVICE_DIR, "--config", CONFIG_PATH, "--control", CONTROL_PATH, "--controller-id", controllerId];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((item) => `<string>${xml(item)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(`${dirname(paths.node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
  writeFileSync(PLIST_PATH, plist, { mode: 0o600 });

  const domain = `gui/${process.getuid()}`;
  const loaded = spawnSync(LAUNCHCTL, ["print", `${domain}/${LABEL}`], { stdio: "ignore" }).status === 0;
  if (!loaded) {
    const result = spawnSync(LAUNCHCTL, ["bootstrap", domain, PLIST_PATH], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`could not bootstrap ${LABEL}: ${(result.stderr || result.stdout || "").trim()}`);
  }
  spawnSync(LAUNCHCTL, ["kickstart", `${domain}/${LABEL}`], { stdio: "ignore" });
}

function startDirect(paths) {
  const logPath = join(SERVICE_DIR, "glassd.log");
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(
    paths.node,
    [paths.controller, "--service-dir", SERVICE_DIR, "--config", CONFIG_PATH, "--control", CONTROL_PATH, "--controller-id", fileDigest(paths.controller)],
    { detached: true, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  child.unref();
}

function request(payload, timeoutMs = 120_000) {
  return new Promise((resolveRequest, reject) => {
    const socket = netConnect(CONTROL_PATH);
    let buffer = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolveRequest(value);
    };
    const timer = setTimeout(() => finish(new Error("glassd control request timed out")), timeoutMs);
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch (err) {
        finish(err);
      }
    });
    socket.once("error", (err) => finish(err));
    socket.once("close", () => {
      if (!settled) finish(new Error("glassd closed the control connection without a response"));
    });
  });
}

async function reachable() {
  return await new Promise((resolveReachable) => {
    const socket = netConnect(CONTROL_PATH);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveReachable(value);
    };
    const timer = setTimeout(() => finish(false), 750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function ensureService(paths) {
  if (await reachable()) return;
  rmSync(CONTROL_PATH, { force: true });
  if (DIRECT) startDirect(paths);
  else installLaunchAgent(paths);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await reachable()) return;
    await sleep(100);
  }
  throw new Error(`glassd did not become reachable; see ${join(SERVICE_DIR, "glassd.log")}`);
}

async function waitForReachability(expected, timeoutMs = SERVICE_UPDATE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await reachable()) === expected) return;
    await sleep(100);
  }
  throw new Error(`glassd did not become ${expected ? "reachable" : "stopped"} within ${timeoutMs}ms`);
}

function bootoutLaunchAgent() {
  const domain = `gui/${process.getuid()}`;
  const result = spawnSync(LAUNCHCTL, ["bootout", `${domain}/${LABEL}`], { encoding: "utf8" });
  if (result.status !== 0 && (awaitableText(result).trim())) {
    throw new Error(`could not stop ${LABEL}: ${awaitableText(result).trim()}`);
  }
}

function awaitableText(result) {
  return String(result.stderr || result.stdout || "");
}

async function applyServiceUpdate(paths) {
  if (DIRECT) throw new Error("service updates require the LaunchAgent mode");
  const update = serviceUpdateState(paths);
  const expectedControllerId = update.pending ? update.targetControllerId : update.currentControllerId;
  atomicCopy(paths.controller, paths.previousController, 0o600);
  atomicCopy(paths.node, paths.previousNode, 0o755);
  bootoutLaunchAgent();
  await waitForReachability(false);
  await sleep(500);
  try {
    if (update.pending) {
      atomicCopy(paths.pendingController, paths.controller, 0o600);
      atomicCopy(paths.pendingNode, paths.node, 0o755);
    }
    installLaunchAgent(paths);
    await waitForReachability(true);
    const response = await request({ op: "status" }, 120_000);
    if (!response.ok || response.status?.controllerId !== expectedControllerId || !response.status?.running) {
      throw new Error(response.error || "replacement controller did not restore the configured backend");
    }
    if (update.pending) {
      rmSync(SERVICE_UPDATE_PATH, { force: true });
      rmSync(paths.pendingController, { force: true });
      rmSync(paths.pendingNode, { force: true });
    }
    rmSync(paths.previousController, { force: true });
    rmSync(paths.previousNode, { force: true });
    return { updated: update.pending, restarted: true, status: response.status };
  } catch (error) {
    try { bootoutLaunchAgent(); } catch { /* best effort before rollback */ }
    await waitForReachability(false).catch(() => undefined);
    atomicCopy(paths.previousController, paths.controller, 0o600);
    atomicCopy(paths.previousNode, paths.node, 0o755);
    installLaunchAgent(paths);
    await waitForReachability(true);
    const rollback = await request({ op: "status" }, 120_000);
    if (!rollback.ok || !rollback.status?.running) {
      throw new Error(`service update failed and rollback did not restore the backend: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error(`service update failed; previous controller restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function run() {
  const paths = prepareServiceFiles();
  if (has("--status")) {
    if (!(await reachable())) return marker("GLASS_BACKEND_STATUS", { running: false, serviceUpdate: serviceUpdateState(paths) });
    const response = await request({ op: "status" }, 3000);
    if (!response.ok) throw new Error(response.error || "status failed");
    return marker("GLASS_BACKEND_STATUS", { ...response.status, serviceUpdate: serviceUpdateState(paths) });
  }
  if (has("--apply-service-update")) {
    const result = await applyServiceUpdate(paths);
    return marker("GLASS_BACKEND_UPDATED", { ...result, serviceUpdate: serviceUpdateState(paths) });
  }
  if (has("--stop") || has("--shutdown-service")) {
    if (!(await reachable())) return marker("GLASS_BACKEND_STOPPED");
    const response = await request({ op: has("--shutdown-service") ? "shutdown" : "stop" });
    if (!response.ok) throw new Error(response.error || "stop failed");
    return marker("GLASS_BACKEND_STOPPED");
  }

  const role = arg("--role", "standalone");
  if (!["standalone", "hub", "spoke"].includes(role)) throw new Error(`unknown backend role ${JSON.stringify(role)}`);
  if (role === "hub" && (!process.env.VIEWER_ID || !process.env.VIEWER_PUB)) {
    throw new Error("hub role needs VIEWER_ID and VIEWER_PUB");
  }
  if (role === "spoke" && (!process.env.HUB_URL || !process.env.HUB_PIN)) {
    throw new Error("spoke role needs HUB_URL and HUB_PIN");
  }

  await ensureService(paths);
  const runtime = resolveRuntime(paths.node);
  const config = {
    v: 1,
    role,
    runtime,
    stateDir: resolve(STATE_DIR),
    ...(process.env.VIEWER_ID ? { viewerId: process.env.VIEWER_ID } : {}),
    ...(process.env.VIEWER_PUB ? { viewerPub: process.env.VIEWER_PUB } : {}),
    ...(process.env.HUB_URL ? { hubUrl: process.env.HUB_URL } : {}),
    ...(process.env.HUB_PIN ? { hubPin: process.env.HUB_PIN } : {}),
  };
  const response = await request({ op: "ensure", config });
  if (!response.ok) throw new Error(response.error || "glassd ensure failed");
  const status = await request({ op: "status" }, 3000);
  marker("GLASS_BACKEND_READY", {
    ...response.info,
    backendStatus: status.ok ? status.status : undefined,
    serviceUpdate: serviceUpdateState(paths),
  });
}

run().catch(fail);
