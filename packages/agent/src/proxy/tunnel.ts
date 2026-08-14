/**
 * Cross-device browser-proxy tunnel (plan §7, Phase 6 M2). Two halves connected
 * by the reserved proxy.* messages (routed device→hub→device in production):
 *
 *   ProxyForwarder (browsing device): runs a local SOCKS5 listener; each browser
 *     connection becomes one channel, multiplexed to the exit as proxy.* frames.
 *   ProxyExit (egress device): on proxy.open it dials the real destination — so
 *     egress happens HERE — and bridges bytes back as proxy.data.
 *
 * The transport (`send`) is injected, so this module is oblivious to how frames
 * reach the peer (hub routing, a direct tunnel, or an in-process pipe in tests).
 */
import net from "node:net";
import { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ProxyChannelMessage } from "@glass/protocol";
import { createSocks5Server, type Socks5Options } from "./socks5.js";

export type ProxySend = (msg: ProxyChannelMessage) => void;

function directDial(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

export interface ProxyExitOptions {
  /** Reject a destination before dialling (egress policy). */
  allow?: (host: string, port: number) => boolean;
  dial?: (host: string, port: number) => Promise<net.Socket>;
  onOpen?: (host: string, port: number) => void;
}

/** The egress side: dials destinations named by proxy.open and pipes bytes. */
export class ProxyExit {
  private channels = new Map<string, net.Socket>();
  constructor(
    private readonly send: ProxySend,
    private readonly opts: ProxyExitOptions = {},
  ) {}

  handle(msg: ProxyChannelMessage): void {
    if (msg.type === "proxy.open") this.open(msg.channelId, msg.host, msg.port);
    else if (msg.type === "proxy.data") this.channels.get(msg.channelId)?.write(Buffer.from(msg.data, "base64"));
    else if (msg.type === "proxy.close") {
      const s = this.channels.get(msg.channelId);
      if (s) {
        this.channels.delete(msg.channelId);
        s.destroy();
      }
    }
  }

  private open(channelId: string, host: string, port: number): void {
    if (this.opts.allow && !this.opts.allow(host, port)) {
      this.send({ type: "proxy.opened", channelId, ok: false, error: "destination not allowed" });
      this.send({ type: "proxy.close", channelId, reason: "denied" });
      return;
    }
    this.opts.onOpen?.(host, port);
    (this.opts.dial ?? directDial)(host, port).then(
      (sock) => {
        this.channels.set(channelId, sock);
        this.send({ type: "proxy.opened", channelId, ok: true });
        sock.on("data", (d: Buffer) => this.send({ type: "proxy.data", channelId, data: d.toString("base64") }));
        const end = (reason: string) => {
          if (this.channels.delete(channelId)) this.send({ type: "proxy.close", channelId, reason });
        };
        sock.on("close", () => end("eof"));
        sock.on("error", () => end("error"));
      },
      (e: unknown) => {
        this.send({ type: "proxy.opened", channelId, ok: false, error: e instanceof Error ? e.message : String(e) });
        this.send({ type: "proxy.close", channelId, reason: "dial-failed" });
      },
    );
  }

  closeAll(): void {
    for (const s of this.channels.values()) s.destroy();
    this.channels.clear();
  }
}

/** A virtual upstream for one SOCKS connection: bytes ↔ proxy.data frames. */
class ChannelStream extends Duplex {
  constructor(
    private readonly channelId: string,
    private readonly send: ProxySend,
  ) {
    super();
  }
  override _read(): void {
    /* pushed on incoming proxy.data */
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.send({ type: "proxy.data", channelId: this.channelId, data: buf.toString("base64") });
    cb();
  }
  override _final(cb: (e?: Error | null) => void): void {
    this.send({ type: "proxy.close", channelId: this.channelId, reason: "eof" });
    cb();
  }
  deliver(base64: string): void {
    this.push(Buffer.from(base64, "base64"));
  }
  remoteClose(): void {
    this.push(null); // EOF to the reader
  }
}

interface PendingChannel {
  stream: ChannelStream;
  resolve: (s: Duplex) => void;
  reject: (e: Error) => void;
  opened: boolean;
}

/** The browsing side: a local SOCKS5 listener that tunnels to the exit. */
export class ProxyForwarder {
  private readonly channels = new Map<string, PendingChannel>();
  private readonly server: net.Server;

  constructor(
    private readonly send: ProxySend,
    socksOpts: Socks5Options = {},
    private readonly openTimeoutMs = 15_000,
  ) {
    this.server = createSocks5Server({ ...socksOpts, dial: (host, port) => this.openChannel(host, port) });
  }

  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((r) => this.server.listen(port, host, () => r((this.server.address() as net.AddressInfo).port)));
  }
  close(): void {
    this.server.close();
    for (const c of this.channels.values()) c.stream.destroy();
    this.channels.clear();
  }

  handle(msg: ProxyChannelMessage): void {
    const c = this.channels.get(msg.channelId);
    if (!c) return;
    if (msg.type === "proxy.opened") {
      if (msg.ok) {
        c.opened = true;
        c.resolve(c.stream);
      } else {
        this.channels.delete(msg.channelId);
        c.reject(new Error(msg.error ?? "open refused"));
      }
    } else if (msg.type === "proxy.data") {
      c.stream.deliver(msg.data);
    } else if (msg.type === "proxy.close") {
      this.channels.delete(msg.channelId);
      c.stream.remoteClose();
    }
  }

  private openChannel(host: string, port: number): Promise<Duplex> {
    const channelId = randomUUID();
    const stream = new ChannelStream(channelId, this.send);
    return new Promise<Duplex>((resolve, reject) => {
      this.channels.set(channelId, { stream, resolve, reject, opened: false });
      this.send({ type: "proxy.open", channelId, host, port });
      const timer = setTimeout(() => {
        const c = this.channels.get(channelId);
        if (c && !c.opened) {
          this.channels.delete(channelId);
          reject(new Error("proxy open timed out"));
        }
      }, this.openTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}
