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
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ProtocolError = z.object({
  type: z.literal("error"),
  code: ErrorCode,
  message: z.string(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;

export const SystemMessage = z.discriminatedUnion("type", [
  Heartbeat,
  HeartbeatAck,
  ProtocolError,
]);
export type SystemMessage = z.infer<typeof SystemMessage>;
