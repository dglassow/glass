/**
 * glass — the secret-injection CLI (plan §5). `glass run` fetches workflow
 * secrets from the hub and injects them into a child process's environment,
 * op-run style: values reach ONLY the child's env — never argv, never disk,
 * never the parent shell's history. A structural redactor scrubs every fetched
 * value from the diagnostic log at the sink.
 *
 *   glass run --hub ws://host:port --key <device-key.json> \
 *     --secret NAME[=ENV_NAME] [--secret ...] [--log <path>] -- <cmd> [args...]
 *
 * Own-failure exit codes use sysexits so they don't collide with the child's:
 *   64 usage · 65 bad secret data · 66 unknown secret · 69 hub/vault unavailable
 *   77 permission denied.  Anything else is the child's code, propagated.
 */
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  makeEnvelope,
  parseEnvelope,
  buildHandshakePayload,
  base64urlEncode,
  signerFromPrivateKey,
  RedactingLogger,
  HUB,
  DeviceId,
  PROTOCOL_VERSION,
  type Envelope,
  type Body,
} from "@glass/protocol";

const die = (code: number, msg: string): never => {
  process.stderr.write(`glass: ${msg}\n`);
  process.exit(code);
};

interface SecretSpec {
  name: string;
  env: string;
}

function parseArgs(argv: string[]): { hub: string; key: string; secrets: SecretSpec[]; log?: string; deviceId?: string; cmd: string[] } {
  const dashdash = argv.indexOf("--");
  const before = dashdash < 0 ? argv : argv.slice(0, dashdash);
  const cmd = dashdash < 0 ? [] : argv.slice(dashdash + 1);
  let hub = "", key = "", log: string | undefined, deviceId: string | undefined;
  const secrets: SecretSpec[] = [];
  for (let i = 0; i < before.length; i++) {
    switch (before[i]) {
      case "--hub": hub = before[++i] ?? ""; break;
      case "--key": key = before[++i] ?? ""; break;
      case "--log": log = before[++i]; break;
      case "--device-id": deviceId = before[++i]; break;
      case "--secret": {
        const spec = before[++i] ?? "";
        const eq = spec.indexOf("=");
        secrets.push(eq < 0 ? { name: spec, env: spec } : { name: spec.slice(0, eq), env: spec.slice(eq + 1) });
        break;
      }
    }
  }
  if (!hub || !key || secrets.length === 0 || cmd.length === 0) {
    die(64, "usage: glass run --hub <url> --key <file> --secret NAME[=ENV] [...] -- <cmd> [args]");
  }
  return { hub, key, secrets, ...(log !== undefined ? { log } : {}), ...(deviceId !== undefined ? { deviceId } : {}), cmd };
}

class HubClient {
  private ws: WebSocket;
  private waiters: Array<{ pred: (e: Envelope) => boolean; resolve: (e: Envelope) => void; reject: (err: Error) => void }> = [];
  private authed = false;

  constructor(private readonly url: string, private readonly deviceId: string, private readonly signer: Awaited<ReturnType<typeof signerFromPrivateKey>>) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw: RawData) => {
      const res = parseEnvelope(safeJson(raw.toString()));
      if (res.ok) this.deliver(res.envelope);
    });
    this.ws.on("close", () => this.fail(new Error("hub connection closed")));
    this.ws.on("error", () => this.fail(new Error("hub connection error")));
  }

  private deliver(env: Envelope): void {
    if (!this.authed && env.body.type === "hello.challenge") {
      const nonce = env.body.nonce;
      void this.signer.sign(buildHandshakePayload(this.deviceId, nonce)).then((sig) => {
        this.sendBody({ type: "hello.proof", deviceId: DeviceId.parse(this.deviceId), signature: base64urlEncode(sig) });
      });
      return;
    }
    if (!this.authed && env.body.type === "hello.ack") this.authed = true;
    this.waiters = this.waiters.filter((w) => (w.pred(env) ? (w.resolve(env), false) : true));
  }
  private fail(err: Error): void {
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
  }
  private waitFor(pred: (e: Envelope) => boolean, ms = 8000): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error("timeout")); }, ms);
    });
  }
  private sendBody(body: Body): string {
    const env = makeEnvelope({ id: randomUUID(), ts: Date.now(), from: this.deviceId, to: HUB, body });
    this.ws.send(JSON.stringify(env));
    return env.id;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", () => reject(new Error("could not reach hub")));
    });
    this.sendBody({ type: "hello", deviceId: DeviceId.parse(this.deviceId), deviceName: this.deviceId, roles: ["agent"], protocolVersion: PROTOCOL_VERSION, appVersion: "glass-cli", etch: { present: false } });
    await this.waitFor((e) => e.body.type === "hello.ack");
  }

  async getSecret(name: string): Promise<string> {
    const id = this.sendBody({ type: "vault.get", name });
    const reply = await this.waitFor((e) => e.replyTo === id && (e.body.type === "vault.secret" || e.body.type === "error"));
    if (reply.body.type === "vault.secret") return reply.body.value;
    const code = reply.body.type === "error" ? reply.body.code : "internal";
    if (code === "secret_denied" || code === "biometric_required") die(77, `denied: ${name}`);
    if (code === "secret_unknown") die(66, `unknown secret: ${name}`);
    die(69, `vault unavailable for ${name}: ${code}`);
    throw new Error("unreachable");
  }

  close(): void {
    this.ws.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "run") die(64, 'usage: glass run ...');
  const args = parseArgs(argv.slice(1));

  const logger = new RedactingLogger(args.log ? (line) => appendFileSync(args.log as string, line + "\n") : () => {});
  const keyFile = JSON.parse(readFileSync(args.key, "utf8")) as { deviceId?: string; publicKey: string; privateKeyPkcs8: string };
  const deviceId = keyFile.deviceId ?? args.deviceId;
  if (!deviceId) return die(64, "no device id (key file lacks one; pass --device-id)");
  const signer = await signerFromPrivateKey(keyFile.publicKey, keyFile.privateKeyPkcs8);

  const client = new HubClient(args.hub, deviceId, signer);
  const injected: Record<string, string> = {};
  try {
    await client.connect();
    for (const spec of args.secrets) {
      const value = await client.getSecret(spec.name);
      logger.register(value); // scrub from all future output before it can be logged
      logger.log("secret.injected", { name: spec.name, env: spec.env }, Date.now());
      if (value.includes("\u0000")) die(65, `secret ${spec.name} contains a NUL byte; refusing env injection`);
      injected[spec.env] = value;
    }
  } catch (err) {
    die(69, `hub: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.close();
  }

  const child = spawn(args.cmd[0] as string, args.cmd.slice(1), { stdio: "inherit", env: { ...process.env, ...injected } });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", (err) => die(69, `could not spawn: ${err.message}`));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

void main();
