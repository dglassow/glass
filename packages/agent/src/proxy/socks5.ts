/**
 * Minimal SOCKS5 CONNECT server (plan §7, Phase 6). A device runs this as an
 * egress "exit": a browser (or a local forwarder tunnelling over the Glass
 * channel) speaks SOCKS5 to it, and the actual outbound connection is made from
 * THIS device — so rendering happens where you are, egress happens here.
 *
 * CONNECT only (no BIND/UDP-associate). No SOCKS-level auth: this listener is
 * meant to be reached over an already-authenticated Glass channel or on
 * loopback, never exposed raw. Keep it small and dependency-free.
 */
import net from "node:net";
import type { Duplex } from "node:stream";

const VER = 0x05;
// Reply codes (RFC 1928 §6).
const REP_OK = 0x00;
const REP_GENERAL_FAIL = 0x01;
const REP_HOST_UNREACH = 0x04;
const REP_CONN_REFUSED = 0x05;
const REP_CMD_UNSUPPORTED = 0x07;
const REP_ATYP_UNSUPPORTED = 0x08;

export interface Socks5Options {
  /** Dial a destination and return the connected upstream stream. Defaults to a
   *  direct net.connect (real egress from this host). Override to route
   *  elsewhere (e.g. a tunnelled channel over the Glass link) or to restrict
   *  destinations. Any Duplex works — it need not be a real socket. */
  dial?: (host: string, port: number) => Promise<Duplex>;
  /** Optional allow-check; reject the CONNECT before dialling. */
  allow?: (host: string, port: number) => boolean;
  /** Called for observability (audit) on each CONNECT. */
  onConnect?: (host: string, port: number) => void;
}

function directDial(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

/** Read exactly n bytes from a socket buffer helper. */
class Reader {
  private buf = Buffer.alloc(0);
  private waiters: Array<{ n: number; res: (b: Buffer) => void }> = [];
  constructor(private readonly sock: net.Socket) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.pump();
    });
  }
  private pump(): void {
    while (this.waiters.length && this.buf.length >= this.waiters[0]!.n) {
      const { n, res } = this.waiters.shift()!;
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      res(out);
    }
  }
  read(n: number): Promise<Buffer> {
    return new Promise((res) => {
      this.waiters.push({ n, res });
      this.pump();
    });
  }
  /** Bytes already buffered past the handshake, to replay into the pipe. */
  leftover(): Buffer {
    const b = this.buf;
    this.buf = Buffer.alloc(0);
    return b;
  }
}

function reply(sock: net.Socket, rep: number): void {
  // BND.ADDR/PORT are unused by clients for CONNECT; send 0.0.0.0:0.
  sock.write(Buffer.from([VER, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
}

async function handle(sock: net.Socket, opts: Socks5Options): Promise<void> {
  const r = new Reader(sock);
  // 1. greeting
  const hello = await r.read(2);
  if (hello[0] !== VER) return void sock.destroy();
  const nMethods = hello[1]!;
  await r.read(nMethods); // discard offered methods
  sock.write(Buffer.from([VER, 0x00])); // select no-auth

  // 2. request header: VER CMD RSV ATYP
  const head = await r.read(4);
  if (head[0] !== VER) return void sock.destroy();
  const cmd = head[1];
  const atyp = head[3];
  if (cmd !== 0x01) {
    reply(sock, REP_CMD_UNSUPPORTED);
    return void sock.destroy();
  }
  let host: string;
  if (atyp === 0x01) {
    const a = await r.read(4);
    host = `${a[0]}.${a[1]}.${a[2]}.${a[3]}`;
  } else if (atyp === 0x03) {
    const len = (await r.read(1))[0]!;
    host = (await r.read(len)).toString("utf8");
  } else if (atyp === 0x04) {
    const a = await r.read(16);
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(a.readUInt16BE(i).toString(16));
    host = parts.join(":");
  } else {
    reply(sock, REP_ATYP_UNSUPPORTED);
    return void sock.destroy();
  }
  const port = (await r.read(2)).readUInt16BE(0);

  if (opts.allow && !opts.allow(host, port)) {
    reply(sock, REP_GENERAL_FAIL);
    return void sock.destroy();
  }
  opts.onConnect?.(host, port);

  // 3. dial upstream (egress from this host, or a tunnelled channel) and pipe.
  let upstream: Duplex;
  try {
    upstream = await (opts.dial ?? directDial)(host, port);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    reply(sock, code === "ECONNREFUSED" ? REP_CONN_REFUSED : code === "ENOTFOUND" || code === "EHOSTUNREACH" ? REP_HOST_UNREACH : REP_GENERAL_FAIL);
    return void sock.destroy();
  }
  reply(sock, REP_OK);
  const pending = r.leftover();
  if (pending.length) upstream.write(pending);
  sock.pipe(upstream);
  upstream.pipe(sock);
  const drop = (): void => {
    sock.destroy();
    upstream.destroy();
  };
  sock.on("error", drop);
  upstream.on("error", drop);
  sock.on("close", drop);
  upstream.on("close", drop);
}

/** Create (unstarted) a SOCKS5 CONNECT server. Call .listen(port, host). */
export function createSocks5Server(opts: Socks5Options = {}): net.Server {
  return net.createServer((sock) => {
    handle(sock, opts).catch(() => sock.destroy());
  });
}
