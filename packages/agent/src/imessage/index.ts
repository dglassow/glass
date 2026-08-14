/**
 * iMessage bridge (plan §6): the Mac signed into iMessage serves its Messages
 * store to the fleet through its agent. Detected, never assumed — present only
 * on macOS with a readable chat.db (which requires the owner to grant the app
 * Full Disk Access; absent permission simply means "no bridge on this
 * device"). Sending additionally prompts macOS's one-time Automation consent.
 *
 * Like the proxy forwarders, everything here is worker soft state: a
 * blue/green swap drops the poller and watcher set; viewers re-watch on
 * reconnect. Nothing is ever written to chat.db (readOnly connection).
 *
 * GLASS_IMESSAGE_DB overrides the database path (the test seam; it also skips
 * the darwin check so the harness runs in CI).
 */
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import type { IMessageConversation, IMessageItem } from "@glass/protocol";
import { ChatDb } from "./chat-db.js";
import { sendIMessage } from "./send.js";

export interface IMessageDetection {
  present: boolean;
  dbPath?: string;
}

export function detectIMessage(): IMessageDetection {
  const override = process.env["GLASS_IMESSAGE_DB"];
  if (!override && process.platform !== "darwin") return { present: false };
  const dbPath = override || `${homedir()}/Library/Messages/chat.db`;
  try {
    accessSync(dbPath, constants.R_OK);
    // Readable is necessary but not sufficient (TCC can still refuse the open,
    // and the file may not be a database) — prove we can actually query it.
    const db = ChatDb.open(dbPath);
    try {
      db.maxRowid();
    } finally {
      db.close();
    }
    return { present: true, dbPath };
  } catch {
    return { present: false };
  }
}

export class IMessageBridge {
  private readonly db: ChatDb;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  /** Signed-in account label (from chat.db), or undefined when undetectable.
   *  Computed once — it can't change without a re-login, which also restarts
   *  Messages' database activity and, in practice, the owner's session. */
  readonly account: string | undefined;

  constructor(dbPath: string) {
    this.db = ChatDb.open(dbPath);
    this.account = this.db.account();
  }

  conversations(limit: number): IMessageConversation[] {
    return this.db.conversations(limit);
  }

  messages(chatGuid: string, limit: number, beforeRowid?: number): IMessageItem[] {
    return this.db.messages(chatGuid, limit, beforeRowid);
  }

  send(target: { chatGuid?: string; handle?: string }, text: string): Promise<void> {
    return sendIMessage(target, text);
  }

  /** Poll for new rows and emit each (both directions — a send from another
   *  of the owner's devices appears too). Boring on purpose: fs-event watching
   *  of a WAL database is unreliable; a 2s ROWID poll is not. */
  startPolling(onNew: (item: IMessageItem) => void, intervalMs = 2000): void {
    if (this.timer) return;
    try {
      this.cursor = this.db.maxRowid();
    } catch {
      this.cursor = 0;
    }
    this.timer = setInterval(() => {
      try {
        const fresh = this.db.messagesSince(this.cursor);
        for (const m of fresh) {
          if (m.rowid > this.cursor) this.cursor = m.rowid;
          onNew(m);
        }
      } catch {
        /* transient (db busy) — next tick retries */
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    this.stopPolling();
    this.db.close();
  }
}
