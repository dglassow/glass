import { z } from "zod";
import { DeviceId, SessionId } from "../ids.js";

/**
 * Session providers. Everything long-lived on an Agent is one of these, and
 * they share a lifecycle: create, attach, stream, detach, kill.
 *
 * "browser" is deliberately absent — browsers run locally and are proxied,
 * never streamed, so they are not sessions.
 */
export const SessionKind = z.enum(["pty", "chat"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const SessionRecord = z.object({
  id: SessionId,
  kind: SessionKind,
  deviceId: DeviceId,
  title: z.string(),
  createdAt: z.number().int().nonnegative(),
  alive: z.boolean(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export const SessionCreate = z.object({
  type: z.literal("session.create"),
  kind: SessionKind,
  deviceId: DeviceId,
  cwd: z.string().optional(),
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
});
export type SessionCreate = z.infer<typeof SessionCreate>;

export const SessionCreated = z.object({
  type: z.literal("session.created"),
  session: SessionRecord,
});
export type SessionCreated = z.infer<typeof SessionCreated>;

export const SessionList = z.object({
  type: z.literal("session.list"),
  deviceId: DeviceId.optional(),
});
export type SessionList = z.infer<typeof SessionList>;

export const SessionListed = z.object({
  type: z.literal("session.listed"),
  sessions: z.array(SessionRecord),
});
export type SessionListed = z.infer<typeof SessionListed>;

export const SessionAttach = z.object({
  type: z.literal("session.attach"),
  sessionId: SessionId,
});
export type SessionAttach = z.infer<typeof SessionAttach>;

/** Scrollback replays on attach so a reattached session looks continuous. */
export const SessionAttached = z.object({
  type: z.literal("session.attached"),
  session: SessionRecord,
  scrollback: z.string(),
});
export type SessionAttached = z.infer<typeof SessionAttached>;

export const SessionDetach = z.object({
  type: z.literal("session.detach"),
  sessionId: SessionId,
});
export type SessionDetach = z.infer<typeof SessionDetach>;

export const SessionInput = z.object({
  type: z.literal("session.input"),
  sessionId: SessionId,
  data: z.string(),
});
export type SessionInput = z.infer<typeof SessionInput>;

export const SessionOutput = z.object({
  type: z.literal("session.output"),
  sessionId: SessionId,
  data: z.string(),
  seq: z.number().int().nonnegative(),
});
export type SessionOutput = z.infer<typeof SessionOutput>;

export const SessionResize = z.object({
  type: z.literal("session.resize"),
  sessionId: SessionId,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type SessionResize = z.infer<typeof SessionResize>;

export const SessionClose = z.object({
  type: z.literal("session.close"),
  sessionId: SessionId,
});
export type SessionClose = z.infer<typeof SessionClose>;

export const SessionExited = z.object({
  type: z.literal("session.exited"),
  sessionId: SessionId,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
});
export type SessionExited = z.infer<typeof SessionExited>;

/** Viewer → agent: give the session a human name. The title lives in the
 *  session record (sessiond), so it survives worker swaps and is what every
 *  viewer's list shows. */
export const SessionRename = z.object({
  type: z.literal("session.rename"),
  sessionId: SessionId,
  title: z.string().min(1).max(80),
});
export type SessionRename = z.infer<typeof SessionRename>;

/** Reply to the renamer AND broadcast fleet-wide (like session.created), so
 *  every open sidebar updates live. */
export const SessionRenamed = z.object({
  type: z.literal("session.renamed"),
  session: SessionRecord,
});
export type SessionRenamed = z.infer<typeof SessionRenamed>;

export const SessionMessage = z.discriminatedUnion("type", [
  SessionCreate,
  SessionCreated,
  SessionList,
  SessionListed,
  SessionAttach,
  SessionAttached,
  SessionDetach,
  SessionInput,
  SessionOutput,
  SessionResize,
  SessionClose,
  SessionExited,
  SessionRename,
  SessionRenamed,
]);
export type SessionMessage = z.infer<typeof SessionMessage>;
