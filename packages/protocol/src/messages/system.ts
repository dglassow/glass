import { z } from "zod";

export const Heartbeat = z.object({
  type: z.literal("heartbeat"),
  sentAt: z.number().int().nonnegative(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export const HeartbeatAck = z.object({
  type: z.literal("heartbeat.ack"),
  sentAt: z.number().int().nonnegative(),
  receivedAt: z.number().int().nonnegative(),
});
export type HeartbeatAck = z.infer<typeof HeartbeatAck>;

export const ErrorCode = z.enum([
  "unauthorized",
  "device_unknown",
  "device_revoked",
  "session_not_found",
  "device_unreachable",
  "version_incompatible",
  "rate_limited",
  "enroll_code_mismatch",
  "enroll_unknown_request",
  "secret_denied",
  "secret_unknown",
  "vault_locked",
  "biometric_required",
  "invalid_name",
  "bad_request",
  "imessage_unavailable",
  "imessage_send_failed",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ProtocolError = z.object({
  type: z.literal("error"),
  code: ErrorCode,
  message: z.string(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;

/**
 * Hub → viewer: a newer signed build is available at the hub's update origin.
 * Purely advisory (a live nag banner); the actual install is still minisign-gated
 * on the device, so a lying `version` can at worst prompt a no-op update check.
 * The viewer compares it against its OWN running version to decide whether to nag.
 */
export const UpdateAvailable = z.object({
  type: z.literal("update.available"),
  version: z.string().min(1).max(64),
  /** Human-readable change notes for `version` (from the release manifest).
   *  Advisory display text only — rendered as plain text, never markup. */
  notes: z.string().max(16384).optional(),
});
export type UpdateAvailable = z.infer<typeof UpdateAvailable>;

export const SystemMessage = z.discriminatedUnion("type", [
  Heartbeat,
  HeartbeatAck,
  ProtocolError,
  UpdateAvailable,
]);
export type SystemMessage = z.infer<typeof SystemMessage>;
