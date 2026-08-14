import { z } from "zod";

/**
 * iMessage bridge (plan §6). The Mac signed into iMessage exposes its
 * Messages database read-only and an AppleScript send path through its agent;
 * viewers browse conversations and reply from anywhere in the fleet. This is
 * NOT a session kind — no PTY, no scrollback; it's a request/reply family plus
 * a subscription push, routed point-to-point (viewer ↔ that agent) so message
 * content only ever reaches viewers that asked for it. The hub relays
 * verbatim and needs no iMessage awareness.
 *
 * Everything textual out of chat.db (names, handles, bodies, previews) is
 * OTHER PEOPLE'S content — untrusted display text end to end.
 */

/** Apple's chat GUID, e.g. "iMessage;-;+15551234567". Opaque to Glass. */
export const IMessageChatGuid = z.string().min(1).max(256);
export type IMessageChatGuid = z.infer<typeof IMessageChatGuid>;

/** A phone number or Apple ID address. Opaque to Glass. */
export const IMessageHandle = z.string().min(1).max(256);
export type IMessageHandle = z.infer<typeof IMessageHandle>;

/** Bound on an outgoing message (matches Messages' practical limits). */
export const IMESSAGE_MAX_SEND = 4000;

export const IMessageConversation = z.object({
  guid: IMessageChatGuid,
  /** Group name or the counterpart handle — display text, untrusted. */
  name: z.string().max(512),
  participants: z.array(IMessageHandle).max(64),
  /** ms since Unix epoch of the newest message (0 when empty). */
  lastAt: z.number().int().nonnegative(),
  /** First line of the newest message — display text, untrusted. */
  lastPreview: z.string().max(256),
});
export type IMessageConversation = z.infer<typeof IMessageConversation>;

export const IMessageItem = z.object({
  /** chat.db message ROWID — stable, monotonic; the pagination cursor. */
  rowid: z.number().int().nonnegative(),
  chatGuid: IMessageChatGuid,
  fromMe: z.boolean(),
  /** Sender handle for inbound messages; absent when fromMe. */
  sender: IMessageHandle.optional(),
  /** Message body (decoded from text or attributedBody) — untrusted. */
  text: z.string().max(65536),
  /** ms since Unix epoch. */
  at: z.number().int().nonnegative(),
  hasAttachments: z.boolean(),
});
export type IMessageItem = z.infer<typeof IMessageItem>;

/** Viewer → agent: list recent conversations, newest first. */
export const IMessageConversations = z.object({
  type: z.literal("imessage.conversations"),
  limit: z.number().int().min(1).max(100).optional(),
});
export type IMessageConversations = z.infer<typeof IMessageConversations>;

export const IMessageConversationsListed = z.object({
  type: z.literal("imessage.conversations.listed"),
  conversations: z.array(IMessageConversation),
});
export type IMessageConversationsListed = z.infer<typeof IMessageConversationsListed>;

/** Viewer → agent: page a conversation's messages (newest first; `beforeRowid`
 *  pages further back). The reply returns them oldest-first for display. */
export const IMessageMessages = z.object({
  type: z.literal("imessage.messages"),
  chatGuid: IMessageChatGuid,
  limit: z.number().int().min(1).max(200).optional(),
  beforeRowid: z.number().int().nonnegative().optional(),
});
export type IMessageMessages = z.infer<typeof IMessageMessages>;

export const IMessageMessagesListed = z.object({
  type: z.literal("imessage.messages.listed"),
  chatGuid: IMessageChatGuid,
  messages: z.array(IMessageItem),
});
export type IMessageMessagesListed = z.infer<typeof IMessageMessagesListed>;

/**
 * Viewer → agent: send a message. Exactly one target: `chatGuid` replies into
 * an existing conversation (reliable); `handle` starts/continues a thread to
 * an address (best-effort — modern macOS is flaky about brand-new threads).
 * zod discriminated unions can't express exactly-one, so the agent enforces it.
 */
export const IMessageSend = z.object({
  type: z.literal("imessage.send"),
  chatGuid: IMessageChatGuid.optional(),
  handle: IMessageHandle.optional(),
  text: z.string().min(1).max(IMESSAGE_MAX_SEND),
});
export type IMessageSend = z.infer<typeof IMessageSend>;

export const IMessageSent = z.object({
  type: z.literal("imessage.sent"),
  ok: z.literal(true),
});
export type IMessageSent = z.infer<typeof IMessageSent>;

/** Viewer → agent: start receiving imessage.new pushes on this connection.
 *  Watcher state is per-viewer soft state in the agent worker (pruned when the
 *  viewer disconnects; a worker swap drops it and the panel re-watches). */
export const IMessageWatch = z.object({ type: z.literal("imessage.watch") });
export type IMessageWatch = z.infer<typeof IMessageWatch>;

export const IMessageWatching = z.object({ type: z.literal("imessage.watching") });
export type IMessageWatching = z.infer<typeof IMessageWatching>;

export const IMessageUnwatch = z.object({ type: z.literal("imessage.unwatch") });
export type IMessageUnwatch = z.infer<typeof IMessageUnwatch>;

/** Agent → each watching viewer: a message appeared in chat.db (either
 *  direction — sends from other devices show up too). */
export const IMessageNew = z.object({
  type: z.literal("imessage.new"),
  message: IMessageItem,
});
export type IMessageNew = z.infer<typeof IMessageNew>;

export const IMessageMessage = z.discriminatedUnion("type", [
  IMessageConversations,
  IMessageConversationsListed,
  IMessageMessages,
  IMessageMessagesListed,
  IMessageSend,
  IMessageSent,
  IMessageWatch,
  IMessageWatching,
  IMessageUnwatch,
  IMessageNew,
]);
export type IMessageMessage = z.infer<typeof IMessageMessage>;
