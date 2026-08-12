/**
 * Agent (worker) relay for the local loop.
 *
 * The agent holds NO PTY and NO session state — it is a stateless conduit
 * between clients and the session daemon. That is the whole point: it can be
 * killed and restarted freely, and because the PTYs live in sessiond, the
 * shells never notice. On restart it simply reconnects to sessiond; the client
 * re-attaches by session id and sessiond replays the scrollback.
 *
 * Every frame in each direction is parsed as a real @glass/protocol envelope
 * and re-encoded, so the sessiond<->agent link genuinely carries the protocol,
 * not opaque bytes.
 */
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { FrameReader, encodeFrame } from "@glass/protocol";

export interface AgentOptions {
  readonly sessiondPath: string;
  readonly listenPath: string;
  readonly onSessiondClosed?: () => void;
}

export interface RunningAgent {
  readonly close: () => Promise<void>;
}

async function connectSessiond(path: string, attempts = 30, delayMs = 100): Promise<net.Socket> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(path);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`could not connect to sessiond at ${path}`);
}

export async function startAgent(opts: AgentOptions): Promise<RunningAgent> {
  const sd = await connectSessiond(opts.sessiondPath);
  const clients = new Set<net.Socket>();

  // sessiond -> clients: validate each frame, then fan out.
  const sdReader = new FrameReader();
  const sdDecoder = new StringDecoder("utf8");
  sd.on("data", (buf: Buffer) => {
    for (const res of sdReader.push(sdDecoder.write(buf))) {
      if (res.ok) {
        const line = encodeFrame(res.envelope);
        for (const c of clients) c.write(line);
      }
    }
  });
  if (opts.onSessiondClosed) sd.on("close", opts.onSessiondClosed);

  mkdirSync(dirname(opts.listenPath), { recursive: true, mode: 0o700 });
  rmSync(opts.listenPath, { force: true });

  const server = net.createServer((client) => {
    clients.add(client);
    const reader = new FrameReader();
    const decoder = new StringDecoder("utf8");
    client.on("data", (buf: Buffer) => {
      // client -> sessiond
      for (const res of reader.push(decoder.write(buf))) {
        if (res.ok) sd.write(encodeFrame(res.envelope));
      }
    });
    const drop = (): void => {
      clients.delete(client);
    };
    client.on("close", drop);
    client.on("error", drop);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.listenPath, () => resolve());
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.destroy();
        sd.destroy();
        server.close(() => resolve());
      }),
  };
}
