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

/** Enrollment: requester shows the code, an approver confirms it matches. */
export const DeviceEnrollRequest = z.object({
  type: z.literal("device.enroll.request"),
  deviceId: DeviceId,
  deviceName: z.string(),
  roles: z.array(DeviceRole),
  /** base64url of the raw 32-byte Ed25519 public key. */
  publicKey: z.string(),
  verificationCode: z.string().length(6),
});
export type DeviceEnrollRequest = z.infer<typeof DeviceEnrollRequest>;

/** Broadcast to every authorized device; any one of them may approve. */
export const DeviceEnrollPending = z.object({
  type: z.literal("device.enroll.pending"),
  requestId: z.string(),
  deviceName: z.string(),
  verificationCode: z.string().length(6),
  expiresAt: z.number().int().nonnegative(),
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

export const DeviceMessage = z.discriminatedUnion("type", [
  DeviceEnrollRequest,
  DeviceEnrollPending,
  DeviceEnrollDecision,
  DeviceRevoke,
  DeviceList,
  DeviceListed,
  DeviceStateChanged,
]);
export type DeviceMessage = z.infer<typeof DeviceMessage>;
