import { z } from "zod";
import { DeviceId } from "../ids.js";

export const DeviceRole = z.enum(["hub", "agent", "viewer"]);
export type DeviceRole = z.infer<typeof DeviceRole>;

export const DeviceState = z.enum(["connected", "waiting", "deregistered"]);
export type DeviceState = z.infer<typeof DeviceState>;

export const DeviceRecord = z.object({
  id: DeviceId,
  name: z.string(),
  roles: z.array(DeviceRole),
  state: DeviceState,
  lastSeen: z.number().int().nonnegative(),
  appVersion: z.string().optional(),
  etchPresent: z.boolean().optional(),
});
export type DeviceRecord = z.infer<typeof DeviceRecord>;

/** A device key trusted together with the requester in a single approval. */
export const EnrollCompanion = z.object({
  deviceId: DeviceId,
  publicKey: z.string(),
  roles: z.array(DeviceRole),
});
export type EnrollCompanion = z.infer<typeof EnrollCompanion>;

/** Cap the extra keys one approval can grant (e.g. a Mac's viewer + its agent). */
export const MAX_ENROLL_COMPANIONS = 2;

/**
 * Enrollment (self-serve join). The requester does NOT choose the code — the hub
 * mints it and shows it only to the joining device, so an approver must read it
 * off that screen (real out-of-band number matching). `roles`/companion roles
 * are advisory; the hub clamps them (a joiner may only become a viewer, its
 * companion an agent). `clientNonce` lets the hub prove its identity on this lane.
 */
export const DeviceEnrollRequest = z.object({
  type: z.literal("device.enroll.request"),
  deviceId: DeviceId,
  deviceName: z.string().max(64),
  roles: z.array(DeviceRole),
  /** base64url of the raw 32-byte Ed25519 public key. */
  publicKey: z.string(),
  /** Fresh nonce the hub signs so the joiner can verify the hub's pinned identity. */
  clientNonce: z.string().optional(),
  /** Extra device keys to trust under this ONE approval (capped). */
  companions: z.array(EnrollCompanion).max(MAX_ENROLL_COMPANIONS).optional(),
});
export type DeviceEnrollRequest = z.infer<typeof DeviceEnrollRequest>;

/**
 * Two audiences, one type. To the JOINING device: `verificationCode` (shown on
 * its screen) + `hubProof` (so it can verify the hub before trusting the flow).
 * Broadcast to APPROVERS: `roles` + `companions` (what will be granted) but NEVER
 * the code — so a compromised device can't silently self-approve; a human must
 * type the code they read off the joining device.
 */
export const DeviceEnrollPending = z.object({
  type: z.literal("device.enroll.pending"),
  requestId: z.string(),
  deviceName: z.string(),
  expiresAt: z.number().int().nonnegative(),
  verificationCode: z.string().length(6).optional(),
  hubProof: z.object({ key: z.string(), signature: z.string() }).optional(),
  roles: z.array(DeviceRole).optional(),
  companions: z.array(EnrollCompanion).optional(),
});
export type DeviceEnrollPending = z.infer<typeof DeviceEnrollPending>;

export const DeviceEnrollDecision = z.object({
  type: z.literal("device.enroll.decision"),
  requestId: z.string(),
  approved: z.boolean(),
  /**
   * The approver's echo of the code shown on the requesting device. The hub
   * REQUIRES it when approved is true — this is what makes number matching
   * enforceable on the wire rather than only in the approver's UI.
   */
  verificationCode: z.string().length(6).optional(),
  /** Which device approved. Set by the hub from the socket identity, never trusted from the wire. */
  approvedBy: DeviceId.optional(),
});
export type DeviceEnrollDecision = z.infer<typeof DeviceEnrollDecision>;

export const DeviceRevoke = z.object({
  type: z.literal("device.revoke"),
  deviceId: DeviceId,
});
export type DeviceRevoke = z.infer<typeof DeviceRevoke>;

export const DeviceList = z.object({ type: z.literal("device.list") });
export type DeviceList = z.infer<typeof DeviceList>;

export const DeviceListed = z.object({
  type: z.literal("device.listed"),
  devices: z.array(DeviceRecord),
});
export type DeviceListed = z.infer<typeof DeviceListed>;

export const DeviceStateChanged = z.object({
  type: z.literal("device.state"),
  device: DeviceRecord,
});
export type DeviceStateChanged = z.infer<typeof DeviceStateChanged>;

/** Any trusted device → hub: give a fleet device a human name. In trust mode
 *  the name persists in the trust store (which registration already prefers
 *  over the hello's self-reported deviceName), so it survives reconnects and
 *  hub restarts. Broadcast back out as device.state. */
export const DeviceRename = z.object({
  type: z.literal("device.rename"),
  deviceId: DeviceId,
  name: z.string().min(1).max(80),
});
export type DeviceRename = z.infer<typeof DeviceRename>;

export const DeviceRenamed = z.object({
  type: z.literal("device.renamed"),
  device: DeviceRecord,
});
export type DeviceRenamed = z.infer<typeof DeviceRenamed>;

export const DeviceMessage = z.discriminatedUnion("type", [
  DeviceEnrollRequest,
  DeviceEnrollPending,
  DeviceEnrollDecision,
  DeviceRevoke,
  DeviceList,
  DeviceListed,
  DeviceStateChanged,
  DeviceRename,
  DeviceRenamed,
]);
export type DeviceMessage = z.infer<typeof DeviceMessage>;
