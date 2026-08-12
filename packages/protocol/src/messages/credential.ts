import { z } from "zod";

/**
 * Hub credential (passkey / WebAuthn) ceremony — plan §8.4's "authorize
 * directly" path for the very first device, before any other device exists to
 * approve enrollments.
 *
 * The WebAuthn options and responses are opaque browser structures, so they
 * ride as `unknown` and are handed to the WebAuthn library on the hub; the hub
 * never trusts them beyond what that library verifies against a hub-issued,
 * connection-bound, single-use challenge. A connection that completes an
 * `auth` ceremony gains approver capability — it may approve enrollments like a
 * trusted device, but it is not itself a registered device.
 */
export const CredentialRegisterBegin = z.object({
  type: z.literal("credential.register.begin"),
  /** Bootstrap token (from the hub's --register-token) or omitted once a credential-authed session exists. */
  token: z.string().optional(),
  name: z.string(),
});
export type CredentialRegisterBegin = z.infer<typeof CredentialRegisterBegin>;

export const CredentialRegisterFinish = z.object({
  type: z.literal("credential.register.finish"),
  response: z.unknown(),
});
export type CredentialRegisterFinish = z.infer<typeof CredentialRegisterFinish>;

export const CredentialAuthBegin = z.object({ type: z.literal("credential.auth.begin") });
export type CredentialAuthBegin = z.infer<typeof CredentialAuthBegin>;

export const CredentialAuthFinish = z.object({
  type: z.literal("credential.auth.finish"),
  response: z.unknown(),
});
export type CredentialAuthFinish = z.infer<typeof CredentialAuthFinish>;

/** hub -> owner: the WebAuthn options blob to feed navigator.credentials. */
export const CredentialOptions = z.object({
  type: z.literal("credential.options"),
  scope: z.enum(["register", "auth"]),
  options: z.unknown(),
});
export type CredentialOptions = z.infer<typeof CredentialOptions>;

/** hub -> owner: outcome of a register or auth ceremony. */
export const CredentialResult = z.object({
  type: z.literal("credential.result"),
  scope: z.enum(["register", "auth"]),
  ok: z.boolean(),
  message: z.string().optional(),
});
export type CredentialResult = z.infer<typeof CredentialResult>;

export const CredentialMessage = z.discriminatedUnion("type", [
  CredentialRegisterBegin,
  CredentialRegisterFinish,
  CredentialAuthBegin,
  CredentialAuthFinish,
  CredentialOptions,
  CredentialResult,
]);
export type CredentialMessage = z.infer<typeof CredentialMessage>;
