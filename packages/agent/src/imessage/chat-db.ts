/**
 * Read-only view over the Messages database (~/Library/Messages/chat.db).
 * node:sqlite, zero native deps (the hub's vault precedent). The DB is Apple's
 * and is treated as foreign input: every string is bounded to the protocol
 * schema's limits, every row that doesn't make sense is skipped, and the
 * connection is strictly readOnly — Glass must never be able to corrupt the
 * owner's Messages store, even by accident.
 *
 * Tapbacks (associated_message_type ≠ 0) and group-event rows (item_type ≠ 0)
 * are filtered out; v1 shows the text timeline. Attachment-only messages stay,
 * rendered as "[attachment]".
 */
import { DatabaseSync } from "node:sqlite";
import type { IMessageConversation, IMessageItem } from "@glass/protocol";
import { decodeAttributedBody } from "./typedstream.js";

/** Apple epoch (2001-01-01) in Unix ms. chat.db dates are relative to it. */
const APPLE_EPOCH_MS = 978_307_200_000;

/** chat.db `date` values are ns since 2001 on modern macOS, seconds on old
 *  ones. 1e14 cleanly separates the ranges (seconds stay < ~1e10). The ns
 *  values exceed 2^53, which makes node:sqlite REFUSE the integer read — so
 *  every query below casts the date column to REAL (float ns is exact to the
 *  microsecond; we render milliseconds). */
function appleDateToMs(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  const ms = v > 1e14 ? APPLE_EPOCH_MS + v / 1e6 : APPLE_EPOCH_MS + v * 1000;
  return Math.max(0, Math.round(ms));
}

function asString(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function firstLine(s: string, max: number): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.slice(0, max);
}

/** Body text of a message row: text column, else attributedBody, else a
 *  placeholder for attachment-only rows. */
function rowText(text: unknown, attributedBody: unknown, hasAttachments: boolean): string {
  const t = typeof text === "string" && text.length > 0 ? text : decodeAttributedBody(attributedBody as Uint8Array | null);
  if (t) return t.slice(0, 65536);
  return hasAttachments ? "[attachment]" : "";
}

const NOT_NOISE = "COALESCE(m.associated_message_type, 0) = 0 AND COALESCE(m.item_type, 0) = 0";

export class ChatDb {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): ChatDb {
    return new ChatDb(new DatabaseSync(path, { readOnly: true }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /** Recent conversations, newest activity first. */
  conversations(limit: number): IMessageConversation[] {
    const chats = this.db
      .prepare(
        `SELECT c.ROWID AS rowid, c.guid AS guid, c.display_name AS display_name,
                c.chat_identifier AS chat_identifier, CAST(MAX(m.date) AS REAL) AS last_date
         FROM chat c
         JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         JOIN message m ON m.ROWID = cmj.message_id
         WHERE ${NOT_NOISE}
         GROUP BY c.ROWID
         ORDER BY last_date DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    const participantsStmt = this.db.prepare(
      `SELECT h.id AS id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ? LIMIT 64`,
    );
    const lastStmt = this.db.prepare(
      `SELECT m.text AS text, m.attributedBody AS attributedBody, m.cache_has_attachments AS att
       FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE cmj.chat_id = ? AND ${NOT_NOISE}
       ORDER BY m.date DESC LIMIT 1`,
    );

    const out: IMessageConversation[] = [];
    for (const c of chats) {
      const guid = asString(c["guid"], 256);
      if (!guid) continue;
      const chatRowid = c["rowid"];
      const participants = (participantsStmt.all(chatRowid as number) as Array<Record<string, unknown>>)
        .map((h) => asString(h["id"], 256))
        .filter((h) => h.length > 0);
      const last = (lastStmt.all(chatRowid as number) as Array<Record<string, unknown>>)[0];
      const preview = last ? rowText(last["text"], last["attributedBody"], last["att"] === 1) : "";
      out.push({
        guid,
        name: asString(c["display_name"], 512) || asString(c["chat_identifier"], 512) || participants.join(", ").slice(0, 512),
        participants,
        lastAt: appleDateToMs(c["last_date"]),
        lastPreview: firstLine(preview, 256),
      });
    }
    return out;
  }

  /** One conversation's messages, returned OLDEST-first for display.
   *  `beforeRowid` pages further back. */
  messages(chatGuid: string, limit: number, beforeRowid?: number): IMessageItem[] {
    const rows = this.db
      .prepare(
        `SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS attributedBody,
                m.is_from_me AS from_me, CAST(m.date AS REAL) AS date, m.cache_has_attachments AS att,
                h.id AS sender
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE c.guid = ? AND ${NOT_NOISE} ${beforeRowid !== undefined ? "AND m.ROWID < ?" : ""}
         ORDER BY m.date DESC, m.ROWID DESC
         LIMIT ?`,
      )
      .all(...(beforeRowid !== undefined ? [chatGuid, beforeRowid, limit] : [chatGuid, limit])) as Array<Record<string, unknown>>;
    return rows
      .map((r) => this.toItem(r, chatGuid))
      .filter((m): m is IMessageItem => m !== null)
      .reverse();
  }

  /** Highest message ROWID — the new-message poller's cursor. */
  maxRowid(): number {
    const r = this.db.prepare(`SELECT COALESCE(MAX(ROWID), 0) AS m FROM message`).all()[0] as Record<string, unknown> | undefined;
    return typeof r?.["m"] === "number" ? r["m"] : 0;
  }

  /** Every non-noise message with ROWID > cursor, across all chats, ascending. */
  messagesSince(rowid: number, limit = 50): IMessageItem[] {
    const rows = this.db
      .prepare(
        `SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS attributedBody,
                m.is_from_me AS from_me, CAST(m.date AS REAL) AS date, m.cache_has_attachments AS att,
                h.id AS sender, c.guid AS chat_guid
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE m.ROWID > ? AND ${NOT_NOISE}
         ORDER BY m.ROWID ASC
         LIMIT ?`,
      )
      .all(rowid, limit) as Array<Record<string, unknown>>;
    return rows
      .map((r) => this.toItem(r, asString(r["chat_guid"], 256)))
      .filter((m): m is IMessageItem => m !== null);
  }

  private toItem(r: Record<string, unknown>, chatGuid: string): IMessageItem | null {
    if (!chatGuid || typeof r["rowid"] !== "number" || r["rowid"] < 0) return null;
    const fromMe = r["from_me"] === 1;
    const hasAttachments = r["att"] === 1;
    const sender = asString(r["sender"], 256);
    return {
      rowid: r["rowid"],
      chatGuid,
      fromMe,
      ...(fromMe || !sender ? {} : { sender }),
      text: rowText(r["text"], r["attributedBody"], hasAttachments),
      at: appleDateToMs(r["date"]),
      hasAttachments,
    };
  }
}
