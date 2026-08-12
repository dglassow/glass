/**
 * Throwaway CLI client for the M1 local loop — a stand-in for the real Viewer.
 *
 *   node dist/client.js --agent <path> create [--kind pty]
 *   node dist/client.js --agent <path> attach <sessionId>
 *
 * It connects to the agent, drives one session, and relays the terminal: stdin
 * to session.input, session.output to stdout. Ctrl-] detaches without killing
 * the session (so you can prove it survives). This is intentionally minimal and
 * not part of the shipped product.
 */
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import {
  FrameReader,
  encodeFrame,
  makeEnvelope,
  SessionId,
  DeviceId,
  type Body,
  type Envelope,
} from "@glass/protocol";

const SELF = "cli";
const PEER = "agent";
const DETACH = "\x1d"; // Ctrl-]

interface Args {
  agent: string;
  command: "create" | "attach";
  kind: "pty" | "chat";
  sessionId: string | null;
}

function parseArgs(argv: string[]): Args {
  let agent = "";
  let kind: "pty" | "chat" = "pty";
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") agent = argv[++i] ?? "";
    else if (a === "--kind") kind = (argv[++i] ?? "pty") === "chat" ? "chat" : "pty";
    else if (a !== undefined) positional.push(a);
  }
  const command = positional[0];
  if (!agent || (command !== "create" && command !== "attach")) {
    throw new Error("usage: client --agent <path> (create [--kind pty] | attach <sessionId>)");
  }
  return { agent, command, kind, sessionId: command === "attach" ? positional[1] ?? null : null };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "attach" && !args.sessionId) {
    throw new Error("attach requires a <sessionId>");
  }

  const sock = net.connect(args.agent);
  const reader = new FrameReader();
  const decoder = new StringDecoder("utf8");
  const stdinDecoder = new StringDecoder("utf8");

  let sessionId: SessionId | null = args.sessionId !== null ? SessionId.parse(args.sessionId) : null;
  const deviceId = DeviceId.parse("local");
  const pendingInput: string[] = [];

  const send = (body: Body): void => {
    sock.write(encodeFrame(makeEnvelope({ id: randomUUID(), ts: Date.now(), from: SELF, to: PEER, body })));
  };

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const flushPending = (): void => {
    if (!sessionId) return;
    for (const data of pendingInput) send({ type: "session.input", sessionId, data });
    pendingInput.length = 0;
  };

  const restoreAndExit = (code: number): void => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    sock.destroy();
    process.exit(code);
  };

  sock.on("connect", () => {
    if (args.command === "create") {
      send({ type: "session.create", kind: args.kind, deviceId, cols, rows });
    } else if (sessionId) {
      send({ type: "session.attach", sessionId });
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
  });

  sock.on("data", (buf: Buffer) => {
    for (const res of reader.push(decoder.write(buf))) {
      if (res.ok) handle(res.envelope);
    }
  });
  sock.on("close", () => {
    process.stderr.write("\r\n[glass] disconnected from agent\r\n");
    restoreAndExit(0);
  });
  sock.on("error", (err) => {
    process.stderr.write(`\r\n[glass] agent error: ${String(err)}\r\n`);
    restoreAndExit(1);
  });

  function handle(env: Envelope): void {
    const body = env.body;
    switch (body.type) {
      case "session.created":
        sessionId = body.session.id;
        process.stderr.write(`[glass] created session ${sessionId}\r\n`);
        flushPending();
        break;
      case "session.attached":
        sessionId = body.session.id;
        process.stdout.write(body.scrollback);
        process.stderr.write(`\r\n[glass] attached ${sessionId}\r\n`);
        flushPending();
        break;
      case "session.output":
        process.stdout.write(body.data);
        break;
      case "session.exited":
        process.stderr.write(
          `\r\n[glass] session exited (code=${body.exitCode ?? "null"} signal=${body.signal ?? "null"})\r\n`,
        );
        restoreAndExit(0);
        break;
      case "error":
        process.stderr.write(`\r\n[glass] error: ${body.code} — ${body.message}\r\n`);
        restoreAndExit(1);
        break;
      default:
        break;
    }
  }

  process.stdin.on("data", (buf: Buffer) => {
    const data = stdinDecoder.write(buf);
    if (data.includes(DETACH)) {
      if (sessionId) send({ type: "session.detach", sessionId });
      process.stderr.write("\r\n[glass] detached\r\n");
      restoreAndExit(0);
      return;
    }
    if (sessionId) send({ type: "session.input", sessionId, data });
    else pendingInput.push(data);
  });

  process.stdout.on("resize", () => {
    if (sessionId) {
      send({ type: "session.resize", sessionId, cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
    }
  });
}

main();
