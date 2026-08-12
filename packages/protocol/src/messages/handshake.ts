import { z } from "zod";
import { DeviceId } from "../ids.js";
import { DeviceRole } from "./device.js";

/** First message on every connection. Establishes identity and version. */
export const Hello = z.object({
  type: z.literal("hello"),
  deviceId: DeviceId,
  /** Human-readable label for the registry (e.g. "Pro", "Studio"). */
  deviceName: z.string(),
  /**
   * Roles this peer is claiming. Self-asserted while auth is stubbed (Phase 1);
   * Phase 2 enrollment makes them authoritative. The Hub needs them to populate
   * the registry — a viewer must be able to tell which device is an agent.
   */
  roles: z.array(DeviceRole),
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
