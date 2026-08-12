import { z } from "zod";
import { DeviceId } from "../ids.js";

/** First message on every connection. Establishes identity and version. */
export const Hello = z.object({
  type: z.literal("hello"),
  deviceId: DeviceId,
  protocolVersion: z.number().int().positive(),
  appVersion: z.string(),
  /** Present and at what version, or absent. Glass detects Etch, never manages it. */
  etch: z.object({ present: z.boolean(), version: z.string().optional() }),
});
export type Hello = z.infer<typeof Hello>;

export const HelloAck = z.object({
  type: z.literal("hello.ack"),
  protocolVersion: z.number().int().positive(),
  appVersion: z.string(),
  compatibility: z.enum(["ok", "peer_outdated", "peer_ahead"]),
  /** Set when the peer should update before it is refused entirely. */
  updateAvailable: z.string().optional(),
});
export type HelloAck = z.infer<typeof HelloAck>;

export const HandshakeMessage = z.discriminatedUnion("type", [Hello, HelloAck]);
export type HandshakeMessage = z.infer<typeof HandshakeMessage>;
