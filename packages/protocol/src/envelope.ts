import { z } from "zod";
import { Address, MessageId } from "./ids.js";
import { HandshakeMessage } from "./messages/handshake.js";
import { DeviceMessage } from "./messages/device.js";
import { SessionMessage } from "./messages/session.js";
import { SystemMessage } from "./messages/system.js";
import { CredentialMessage } from "./messages/credential.js";
import { VaultMessage } from "./messages/vault.js";
import { ProxyMessage } from "./messages/proxy.js";
import { IMessageMessage } from "./messages/imessage.js";
import { RunMessage } from "./messages/run.js";

/** Every message on the wire is one of these. */
export const Body = z.union([
  HandshakeMessage,
  DeviceMessage,
  SessionMessage,
  SystemMessage,
  CredentialMessage,
  VaultMessage,
  ProxyMessage,
  IMessageMessage,
  RunMessage,
]);
export type Body = z.infer<typeof Body>;

/**
 * The envelope carries routing and versioning; the body carries meaning.
 *
 * `v` is what makes the N-1 compatibility rule enforceable per message rather
 * than only at connection time — a Hub mid-rollout may hold connections from
 * peers on two different versions simultaneously.
 */
export const Envelope = z.object({
  v: z.number().int().positive(),
  id: MessageId,
  ts: z.number().int().nonnegative(),
  from: Address,
  to: Address,
  /** Set on replies, carrying the id of the message being answered. */
  replyTo: MessageId.optional(),
  body: Body,
});
export type Envelope = z.infer<typeof Envelope>;

export type ParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string };

/** Never trust the wire. Every inbound frame goes through this. */
export function parseEnvelope(raw: unknown): ParseResult {
  const result = Envelope.safeParse(raw);
  if (result.success) return { ok: true, envelope: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
