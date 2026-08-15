/**
 * Persistent per-user Glass backend controller.
 *
 * Tauri is a viewer, not a process owner.  This controller stays outside the
 * replaceable .app, owns the Hub and the protocol-free supervisor, and exposes
 * a 0600 newline-JSON Unix control socket.  Agent runtime changes are activated
 * through the supervisor's blue/green swap; the already-running sessiond stays
 * pinned to the runtime that created it until explicit reconfiguration/reboot.
 *
 * Control requests (one JSON object per connection):
 *   {"op":"ensure","config":{...}}  start, attach, or activate a runtime
 *   {"op":"status"}                 report controller/supervisor state
 *   {"op":"stop"}                   explicit destructive role stop
 *   {"op":"shutdown"}               tests/service maintenance only
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { connect as netConnect, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const SERVICE_DIR = flag("--service-dir", join(homedir(), ".glass", "service"));
const CONFIG_PATH = flag("--config", join(SERVICE_DIR, "config.json"));
const CONTROL_PATH = flag("--control", join(SERVICE_DIR, "control.sock"));
const CONTROLLER_ID = flag("--controller-id", "development");
const READY_TIMEOUT_MS = 20_000;

mkdirSync(SERVICE_DIR, { recursive: true, mode: 0o700 });

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function requireFile(path, label) {
  if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} must be an absolute regular file: ${path}`);
  }
}

function validateConfig(raw) {
  if (!raw || raw.v !== 1 || !["standalone", "hub", "spoke"].includes(raw.role)) {
    throw new Error("invalid glassd config");
  }
  if (!raw.runtime || typeof raw.runtime.id !== "string" || !raw.runtime.id) {
    throw new Error("runtime id is required");
  }
  for (const key of ["node", "hub", "sessiond", "agent", "supervisor"]) {
    requireFile(raw.runtime[key], `runtime.${key}`);
  }
  if (!isAbsolute(raw.stateDir)) throw new Error("stateDir must be absolute");
  if (raw.role === "hub" && (!raw.viewerId || !raw.viewerPub)) {
    throw new Error("hub role needs viewerId and viewerPub");
  }
  if (raw.role === "spoke" && (!raw.hubUrl || !raw.hubPin)) {
    throw new Error("spoke role needs hubUrl and hubPin");
  }
  return structuredClone(raw);
}

function publicSettings(config) {
  if (!config) return null;
  return {
    role: config.role,
    stateDir: config.stateDir,
    viewerId: config.viewerId ?? null,
    viewerPub: config.viewerPub ?? null,
    hubUrl: config.hubUrl ?? null,
    hubPin: config.hubPin ?? null,
  };
}

function sameSettings(a, b) {
  return JSON.stringify(publicSettings(a)) === JSON.stringify(publicSettings(b));
}

function b64u(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function genKeyIfMissing(deviceId, path) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")).publicKey;
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const privateKeyPkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  writeFileSync(path, JSON.stringify({ v: 1, deviceId, publicKey, privateKeyPkcs8 }), { mode: 0o600 });
  return publicKey;
}

function trustAdd(config, store, id, pub, roles) {
  execFileSync(config.runtime.node, [
    config.runtime.hub,
    "trust",
    "add",
    "--trust-store",
    store,
    "--device-id",
    id,
    "--name",
    id,
    "--public-key",
    pub,
    "--roles",
    roles,
  ]);
}

function spawnReady(name, command, args, readyRe, timeoutMs = READY_TIMEOUT_MS) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const finish = (fn, value, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* gone */
        }
      }
      fn(value);
    };
    const onData = (data) => {
      const text = data.toString();
      output = (output + text).slice(-64 * 1024);
      process.stderr.write(`${name}: ${text}`);
      if (readyRe.test(output)) finish(resolve, output);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (err) => finish(reject, new Error(`${name} spawn failed: ${err.message}`), true));
    child.once("exit", (code, signal) =>
      finish(reject, new Error(`${name} exited before ready (${code ?? signal}): ${output.slice(-800)}`), true),
    );
    const timer = setTimeout(
      () => finish(reject, new Error(`${name} not ready in ${timeoutMs}ms: ${output.slice(-800)}`), true),
      timeoutMs,
    );
  });
  return { child, ready };
}

async function stopChild(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await Promise.race([exited, sleep(timeoutMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
}

function requestText(socketPath, line, terminal, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let output = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error(`control request timed out: ${line}`)), timeoutMs);
    socket.once("connect", () => socket.write(line + "\n"));
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (terminal(output)) finish();
    });
    socket.once("error", finish);
    socket.once("close", () => finish());
  });
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function loadHubExposure() {
  const path = process.env.GLASS_HUB_CONFIG || join(homedir(), ".glass", "hub.json");
  const config = readJson(path);
  if (!config) return null;
  const required = ["tlsCert", "tlsKey", "relayHost", "tunnelKey"];
  if (required.some((key) => !config[key])) return null;
  if ([config.tlsCert, config.tlsKey, config.tunnelKey].some((path) => !existsSync(path))) return null;
  return config;
}

function portFromOutput(output, scheme) {
  const match = output.match(new RegExp(`listening on (${scheme}://\\S+)`));
  if (!match) return null;
  return Number(new URL(match[1].replace(/^wss?/, "http")).port);
}

class Controller {
  config = null;
  info = null;
  hub = null;
  tunnel = null;
  supervisor = null;
  operation = Promise.resolve();

  enqueue(fn) {
    const next = this.operation.then(fn, fn);
    this.operation = next.catch(() => {});
    return next;
  }

  async normalizeConfig(input, previous = null) {
    const config = validateConfig(input);
    if (config.role !== "spoke") {
      config.localHubPort =
        previous?.role === config.role && Number.isInteger(previous.localHubPort)
          ? previous.localHubPort
          : Number.isInteger(config.localHubPort)
            ? config.localHubPort
            : await freePort();
      const exposure = loadHubExposure();
      if (config.role === "hub" && exposure) {
        config.tlsHubPort =
          previous?.role === "hub" && Number.isInteger(previous.tlsHubPort)
            ? previous.tlsHubPort
            : Number.isInteger(config.tlsHubPort)
              ? config.tlsHubPort
              : await freePort();
      }
    }
    return config;
  }

  async startFromDisk() {
    const stored = readJson(CONFIG_PATH);
    if (!stored) return;
    try {
      const config = await this.normalizeConfig(stored, stored);
      await this.startStack(config);
      this.config = config;
      atomicJson(CONFIG_PATH, config);
    } catch (err) {
      console.error(`glassd: saved configuration did not start: ${err instanceof Error ? err.message : err}`);
    }
  }

  async ensure(input) {
    const next = await this.normalizeConfig(input, this.config ?? readJson(CONFIG_PATH));
    if (!this.config) {
      await this.startStack(next);
      this.config = next;
      atomicJson(CONFIG_PATH, next);
      return this.info;
    }
    if (!sameSettings(this.config, next)) {
      // Role or connection changes are explicit reconfiguration.  They are the
      // one path allowed to stop sessiond and therefore terminate live shells.
      await this.stopStack();
      await this.startStack(next);
      this.config = next;
      atomicJson(CONFIG_PATH, next);
      return this.info;
    }
    if (this.config.runtime.id !== next.runtime.id || this.config.runtime.agent !== next.runtime.agent) {
      await this.activateRuntime(next);
    }
    return this.info;
  }

  async startStack(config) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    let hubResult = null;
    try {
      if (config.role !== "spoke") {
        hubResult = await this.launchHub(config);
        // Adopt immediately so a later supervisor startup failure tears the Hub
        // and tunnel back down in the shared catch path.
        this.hub = hubResult.hub;
        this.tunnel = hubResult.tunnel;
        this.info = hubResult.info;
      }
      const workerArgs = await this.workerArgs(config);
      const runDir = join(config.stateDir, "supervisor");
      const args = [
        config.runtime.supervisor,
        "--run-dir",
        runDir,
        "--sessiond-entry",
        config.runtime.sessiond,
        "--worker-entry",
        config.runtime.agent,
        ...(config.role === "spoke" ? ["--allow-unregistered-start"] : []),
        "--",
        ...workerArgs,
      ];
      const supervisor = spawnReady("supervisor", config.runtime.node, args, /supervisor: up/);
      await supervisor.ready;
      this.supervisor = supervisor.child;
      if (!hubResult) {
        const agent = await this.spokeIdentity(config);
        this.info = {
          role: "spoke",
          hubUrl: config.hubUrl,
          agentId: agent.id,
          agentPub: agent.pub,
          agentName: hostname(),
        };
      }
      console.error(`glassd: ${config.role} ready on runtime ${config.runtime.id}`);
    } catch (err) {
      await this.stopStack();
      throw err;
    }
  }

  async launchHub(config) {
    const dir = config.stateDir;
    if (config.role === "standalone") {
      const args = [
        config.runtime.hub,
        "--listen",
        `127.0.0.1:${config.localHubPort}`,
        "--open",
        "--run-store",
        join(dir, "runs.json"),
      ];
      const proc = spawnReady("hub", config.runtime.node, args, /hub: ready/);
      const output = await proc.ready;
      const port = portFromOutput(output, "ws") ?? config.localHubPort;
      return {
        hub: proc.child,
        tunnel: null,
        info: { role: "standalone", hubUrl: `ws://127.0.0.1:${port}`, agentId: "local" },
      };
    }

    const trustStore = join(dir, "hub-trust.json");
    const hubKey = join(dir, "hub-identity.json");
    const agentKey = join(dir, "hub-agent.json");
    trustAdd(config, trustStore, config.viewerId, config.viewerPub, "viewer");
    const agentPub = await genKeyIfMissing("hub-agent", agentKey);
    trustAdd(config, trustStore, "hub-agent", agentPub, "agent,viewer");

    const exposure = loadHubExposure();
    const args = [
      config.runtime.hub,
      "--listen",
      `127.0.0.1:${config.localHubPort}`,
      "--trust-store",
      trustStore,
      "--hub-key",
      hubKey,
      "--run-store",
      join(dir, "runs.json"),
    ];
    if (exposure) {
      args.push(
        "--tls-listen",
        `127.0.0.1:${config.tlsHubPort}`,
        "--tls-cert",
        exposure.tlsCert,
        "--tls-key",
        exposure.tlsKey,
      );
      if (exposure.webRoot && existsSync(exposure.webRoot)) args.push("--web-root", exposure.webRoot);
      if (exposure.gitRoot && existsSync(exposure.gitRoot)) args.push("--git-root", exposure.gitRoot);
      const updates = exposure.updatesRoot || join(homedir(), ".glass", "updates");
      if (existsSync(updates)) args.push("--updates-root", updates);
    }
    const proc = spawnReady("hub", config.runtime.node, args, /hub: ready/);
    const output = await proc.ready;
    const port = portFromOutput(output, "ws") ?? config.localHubPort;
    const keyMatch = output.match(/identity key (\S+)/);
    if (!keyMatch) {
      await stopChild(proc.child);
      throw new Error("hub did not report its identity key");
    }
    let tunnel = null;
    let publicUrl;
    if (exposure) {
      const tlsPort = portFromOutput(output, "wss") ?? config.tlsHubPort;
      const relayPort = exposure.relayPort || 443;
      const knownHosts = join(homedir(), ".glass", "relay_known_hosts");
      const ssh = [
        "ssh",
        "-NT",
        "-i",
        exposure.tunnelKey,
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile=${knownHosts}`,
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "BatchMode=yes",
        "-R",
        `0.0.0.0:${relayPort}:127.0.0.1:${tlsPort}`,
        `${exposure.relayUser || "tunnel"}@${exposure.relayHost}`,
      ];
      const tunnelProc = spawnReady("tunnel", config.runtime.node, [config.runtime.hub, "tunnel", "--", ...ssh], /tunnel: up \(pid/, 20_000);
      try {
        await tunnelProc.ready;
        tunnel = tunnelProc.child;
      } catch (err) {
        console.error(`glassd: relay tunnel is not ready yet: ${err instanceof Error ? err.message : err}`);
      }
      const host = exposure.publicHost || exposure.relayHost;
      publicUrl = `wss://${host}${relayPort === 443 ? "" : `:${relayPort}`}`;
    }
    return {
      hub: proc.child,
      tunnel,
      info: {
        role: "hub",
        hubUrl: `ws://127.0.0.1:${port}`,
        hubKey: keyMatch[1],
        agentId: "hub-agent",
        ...(publicUrl ? { publicUrl } : {}),
      },
    };
  }

  async spokeIdentity(config) {
    const keyPath = join(config.stateDir, "spoke-agent.json");
    const existing = readJson(keyPath);
    const id = existing?.deviceId || `spoke-${crypto.randomUUID().slice(0, 8)}`;
    const pub = await genKeyIfMissing(id, keyPath);
    return { id, pub, keyPath };
  }

  async workerArgs(config) {
    if (config.role === "standalone") {
      return ["--hub", `ws://127.0.0.1:${config.localHubPort}`, "--device-id", "local", "--name", "This Mac"];
    }
    if (config.role === "hub") {
      return [
        "--hub",
        `ws://127.0.0.1:${config.localHubPort}`,
        "--device-id",
        "hub-agent",
        "--name",
        "This Mac",
        "--key",
        join(config.stateDir, "hub-agent.json"),
      ];
    }
    const agent = await this.spokeIdentity(config);
    return [
      "--hub",
      config.hubUrl,
      "--device-id",
      agent.id,
      "--name",
      hostname(),
      "--key",
      agent.keyPath,
      "--insecure-tls",
      "--hub-key",
      config.hubPin,
    ];
  }

  async supervisorRequest(line, terminal, timeoutMs) {
    if (!this.config && !existsSync(CONFIG_PATH)) throw new Error("supervisor is not configured");
    const config = this.config ?? readJson(CONFIG_PATH);
    return await requestText(join(config.stateDir, "supervisor", "supervisor.sock"), line, terminal, timeoutMs);
  }

  async swapAgent(entry) {
    const output = await this.supervisorRequest(
      `swap ${entry}`,
      (text) => text.split("\n").some((line) => line === "ok" || line.startsWith("failed ")),
      35_000,
    );
    const lines = output.trim().split("\n").filter(Boolean);
    if (lines.at(-1) !== "ok") throw new Error(`agent swap failed: ${lines.at(-1) || "no response"}`);
    return lines;
  }

  async activateRuntime(next) {
    const previous = this.config;
    if (!previous) throw new Error("no active runtime");
    console.error(`glassd: activating runtime ${previous.runtime.id} -> ${next.runtime.id}`);
    await this.swapAgent(next.runtime.agent);
    let newHub = null;
    try {
      if (next.role !== "spoke") {
        await stopChild(this.tunnel);
        await stopChild(this.hub);
        this.tunnel = null;
        this.hub = null;
        newHub = await this.launchHub(next);
        this.hub = newHub.hub;
        this.tunnel = newHub.tunnel;
        this.info = newHub.info;
      }
      this.config = next;
      atomicJson(CONFIG_PATH, next);
    } catch (err) {
      console.error(`glassd: runtime activation failed; rolling back: ${err instanceof Error ? err.message : err}`);
      if (newHub) {
        await stopChild(newHub.tunnel);
        await stopChild(newHub.hub);
      }
      if (previous.role !== "spoke") {
        const oldHub = await this.launchHub(previous);
        this.hub = oldHub.hub;
        this.tunnel = oldHub.tunnel;
        this.info = oldHub.info;
      }
      try {
        await this.swapAgent(previous.runtime.agent);
      } catch (rollbackErr) {
        console.error(`glassd: agent rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`);
      }
      throw err;
    }
  }

  async status() {
    let supervisor = null;
    if (this.config) {
      try {
        const raw = await this.supervisorRequest("status", (text) => text.includes("\n"), 2000);
        supervisor = JSON.parse(raw.trim());
      } catch {
        supervisor = null;
      }
    }
    return {
      running: !!this.config && !!supervisor,
      role: this.config?.role,
      hubUrl: this.info?.hubUrl,
      runtime: this.config?.runtime.id,
      controllerId: CONTROLLER_ID,
      sessiondUpdatePending: !!this.config && !!supervisor
        && supervisor.sessiond?.entry !== this.config.runtime.sessiond,
      controllerPid: process.pid,
      hubPid: this.hub?.pid ?? null,
      supervisorPid: this.supervisor?.pid ?? null,
      supervisor,
      info: this.info,
    };
  }

  async stopStack() {
    const supervisor = this.supervisor;
    const tunnel = this.tunnel;
    const hub = this.hub;
    this.supervisor = null;
    this.tunnel = null;
    this.hub = null;
    this.info = null;
    await stopChild(supervisor);
    await stopChild(tunnel);
    await stopChild(hub);
  }

  async stop() {
    await this.stopStack();
    this.config = null;
    rmSync(CONFIG_PATH, { force: true });
  }
}

const controller = new Controller();
rmSync(CONTROL_PATH, { force: true });
const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = "";
    void controller.enqueue(async () => {
      try {
        const request = JSON.parse(line);
        if (request.op === "ensure") {
          const info = await controller.ensure(request.config);
          socket.end(JSON.stringify({ ok: true, info }) + "\n");
        } else if (request.op === "status") {
          socket.end(JSON.stringify({ ok: true, status: await controller.status() }) + "\n");
        } else if (request.op === "stop") {
          await controller.stop();
          socket.end(JSON.stringify({ ok: true }) + "\n");
        } else if (request.op === "shutdown") {
          await controller.stop();
          socket.end(JSON.stringify({ ok: true }) + "\n", () => {
            server.close(() => process.exit(0));
          });
        } else {
          socket.end(JSON.stringify({ ok: false, error: "unknown operation" }) + "\n");
        }
      } catch (err) {
        socket.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
      }
    });
  });
  socket.on("error", () => {});
});

server.listen(CONTROL_PATH, () => {
  chmodSync(CONTROL_PATH, 0o600);
  console.error(`glassd: up (pid ${process.pid}); control at ${CONTROL_PATH}`);
  void controller.enqueue(() => controller.startFromDisk());
});

const shutdown = () => {
  server.close();
  void controller.enqueue(() => controller.stopStack()).then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
