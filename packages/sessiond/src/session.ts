/**
 * The provider-agnostic session shape (plan §1). Everything long-lived on an
 * Agent — a PTY, a chat conversation — implements this, so the daemon's socket
 * server, scrollback replay, and fan-out don't care which provider backs it.
 * "New capability = new provider. Nothing around it changes."
 */
import type { SessionId, DeviceId, SessionKind } from "@glass/protocol";
import type { OutputChunk, ExitInfo } from "./pty.js";

export interface Session {
  readonly id: SessionId;
  readonly kind: SessionKind;
  readonly deviceId: DeviceId;
  /** Mutable: the owner can rename a session (session.rename). */
  title: string;
  readonly createdAt: number;
  readonly alive: boolean;
  readonly exit: ExitInfo | null;
  readonly lastSeq: number;
  scrollback(): string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  subscribe(onChunk: (chunk: OutputChunk) => void, onExit: (exit: ExitInfo) => void): () => void;
}
