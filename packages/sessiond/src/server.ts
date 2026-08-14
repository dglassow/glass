/**
 * The session daemon's Unix-socket server.
 *
 * It speaks @glass/protocol envelopes with whichever worker (agent) is
 * currently connected. Sessions live in this process and are independent of any
 * connection: when a worker disconnects (or is killed) its subscriptions are
 * dropped, but the PTYs keep running and buffering. A new worker attaches and
 * gets the scrollback replayed. `seq` is owned here and never resets.
 */
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import {
  FrameReader,
  encodeFrame,
  makeEnvelope,
  type Body,
  type Envelope,
  type SessionRecord,
} from "@glass/protocol";
import { PtySession } from "./pty.js";
import { ChatSession } from "./chat.js";
import type { Session } from "./session.js";

const SELF = "sessiond";

interface Conn {
  readonly socket: net.Socket;
  readonly reader: FrameReader;
  readonly decoder: StringDecoder;
  /** sessionId -> unsubscribe, for every session this connection is attached to. */
  readonly subs: Map<string, () => void>;
  /** Address of the connected peer, used as `to` on replies. */
  peer: string;
}

export interface SessiondServer {
  readonly server: net.Server;
  readonly sessionCount: () => number;
  readonly close: () => Promise<void>;
}

export function createSessiondServer(opts?: { maxBytesPerSession?: number }): SessiondServer {
  const sessions = new Map<string, Session>();
  const conns = new Set<Conn>();
  const maxBytes = opts?.maxBytesPerSession;

  function send(conn: Conn, body: Body, replyTo?: string): void {
    const env = makeEnvelope(
      replyTo === undefined
        ? { id: randomUUID(), ts: Date.now(), from: SELF, to: conn.peer, body }
        : { id: randomUUID(), ts: Date.now(), from: SELF, to: conn.peer, body, replyTo },
    );
    conn.socket.write(encodeFrame(env));
  }

  function toRecord(s: Session): SessionRecord {
    return {
      id: s.id,
      kind: s.kind,
      deviceId: s.deviceId,
      title: s.title,
      createdAt: s.createdAt,
      alive: s.alive,
    };
  }

  function attach(conn: Conn, session: Session): void {
    const existing = conn.subs.get(session.id);
    if (existing) {
      existing();
      conn.subs.delete(session.id);
    }
    const unsub = session.subscribe(
      (chunk) =>
        send(conn, {
          type: "session.output",
          sessionId: session.id,
          data: chunk.data,
          seq: chunk.seq,
        }),
      (exit) =>
        send(conn, {
          type: "session.exited",
          sessionId: session.id,
          exitCode: exit.exitCode,
          signal: exit.signal,
        }),
    );
    conn.subs.set(session.id, unsub);
    // If the shell already exited (e.g. while no worker was attached), deliver
    // that fact now so a reattaching viewer isn't left hanging on a dead PTY.
    if (!session.alive && session.exit) {
      send(conn, {
        type: "session.exited",
        sessionId: session.id,
        exitCode: session.exit.exitCode,
        signal: session.exit.signal,
      });
    }
  }

  function handle(conn: Conn, env: Envelope): void {
    conn.peer = env.from;
    const body = env.body;
    switch (body.type) {
      case "session.create": {
        const session: Session =
          body.kind === "chat"
            ? new ChatSession({ deviceId: body.deviceId, ...(maxBytes !== undefined ? { maxBytes } : {}) })
            : new PtySession({
                deviceId: body.deviceId,
                cols: body.cols,
                rows: body.rows,
                ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
                ...(maxBytes !== undefined ? { maxBytes } : {}),
              });
        sessions.set(session.id, session);
        attach(conn, session); // creator is implicitly attached, like opening a terminal
        send(conn, { type: "session.created", session: toRecord(session) }, env.id);
        break;
      }
      case "session.attach": {
        const session = sessions.get(body.sessionId);
        if (!session) {
          send(conn, { type: "error", code: "session_not_found", message: `no session ${body.sessionId}` }, env.id);
          break;
        }
        attach(conn, session);
        send(
          conn,
          { type: "session.attached", session: toRecord(session), scrollback: session.scrollback() },
          env.id,
        );
        break;
      }
      case "session.detach": {
        const unsub = conn.subs.get(body.sessionId);
        if (unsub) {
          unsub();
          conn.subs.delete(body.sessionId);
        }
        break;
      }
      case "session.input": {
        sessions.get(body.sessionId)?.write(body.data);
        break;
      }
      case "session.resize": {
        sessions.get(body.sessionId)?.resize(body.cols, body.rows);
        break;
      }
      case "session.close": {
        sessions.get(body.sessionId)?.kill();
        break;
      }
      case "session.list": {
        send(conn, { type: "session.listed", sessions: [...sessions.values()].map(toRecord) }, env.id);
        break;
      }
      case "session.rename": {
        const session = sessions.get(body.sessionId);
        if (!session) {
          send(conn, { type: "error", code: "session_not_found", message: `no session ${body.sessionId}` }, env.id);
          break;
        }
        session.title = body.title;
        send(conn, { type: "session.renamed", session: toRecord(session) }, env.id);
        break;
      }
      case "heartbeat": {
        send(conn, { type: "heartbeat.ack", sentAt: body.sentAt, receivedAt: Date.now() }, env.id);
        break;
      }
      default:
        // Replies/acks and message families sessiond doesn't act on in M1.
        break;
    }
  }

  const server = net.createServer((socket) => {
    const conn: Conn = {
      socket,
      reader: new FrameReader(),
      decoder: new StringDecoder("utf8"),
      subs: new Map(),
      peer: "agent",
    };
    conns.add(conn);

    socket.on("data", (buf: Buffer) => {
      for (const result of conn.reader.push(conn.decoder.write(buf))) {
        if (result.ok) handle(conn, result.envelope);
      }
    });

    const cleanup = (): void => {
      for (const unsub of conn.subs.values()) unsub();
      conn.subs.clear();
      conns.delete(conn);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  return {
    server,
    sessionCount: () => sessions.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions.values()) s.kill();
        for (const c of conns) c.socket.destroy();
        server.close(() => resolve());
      }),
  };
}
