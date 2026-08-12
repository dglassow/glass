import { z } from "zod";

/**
 * Browser-proxy transport (plan §7, Phase 6). Reserved in the protocol now so
 * the endpoint has a stable slot; the local SOCKS listener multiplexes each
 * browser TCP connection into one channel, routed (by envelope.to) to the exit
 * device, which dials the real destination — egress happens there.
 *
 * Payloads are base64 because envelopes are JSON. A channelId scopes one TCP
 * connection for its lifetime.
 */
export const ProxyChannelId = z.string().min(1).max(128);
export type ProxyChannelId = z.infer<typeof ProxyChannelId>;

/** Browsing device → exit device: open a connection to host:port. */
export const ProxyOpen = z.object({
  type: z.literal("proxy.open"),
  channelId: ProxyChannelId,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
});
export type ProxyOpen = z.infer<typeof ProxyOpen>;

/** Exit device → browsing device: the dial succeeded, or why it didn't. */
export const ProxyOpened = z.object({
  type: z.literal("proxy.opened"),
  channelId: ProxyChannelId,
  ok: z.boolean(),
  error: z.string().optional(),
});
export type ProxyOpened = z.infer<typeof ProxyOpened>;

/** Either direction: a chunk of the tunnelled TCP stream (base64). */
export const ProxyData = z.object({
  type: z.literal("proxy.data"),
  channelId: ProxyChannelId,
  data: z.string(),
});
export type ProxyData = z.infer<typeof ProxyData>;

/** Either direction: the channel is finished (EOF, error, or teardown). */
export const ProxyClose = z.object({
  type: z.literal("proxy.close"),
  channelId: ProxyChannelId,
  reason: z.string().optional(),
});
export type ProxyClose = z.infer<typeof ProxyClose>;

export const ProxyMessage = z.discriminatedUnion("type", [ProxyOpen, ProxyOpened, ProxyData, ProxyClose]);
export type ProxyMessage = z.infer<typeof ProxyMessage>;
