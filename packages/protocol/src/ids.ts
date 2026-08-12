import { z } from "zod";

/**
 * Branded ids. Prevents passing a SessionId where a DeviceId is expected —
 * a mistake that is otherwise invisible when both are strings.
 */

export const DeviceId = z.string().min(1).brand<"DeviceId">();
export type DeviceId = z.infer<typeof DeviceId>;

export const SessionId = z.string().min(1).brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

export const MessageId = z.string().min(1).brand<"MessageId">();
export type MessageId = z.infer<typeof MessageId>;

/** The Hub is addressable as a target without being a registered device. */
export const HUB = "hub" as const;

export const Address = z.union([DeviceId, z.literal(HUB)]);
export type Address = z.infer<typeof Address>;
