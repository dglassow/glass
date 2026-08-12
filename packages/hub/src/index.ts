/**
 * Hub — the worker tier when a Mac is acting as Hub (plan §2, §3).
 *
 * Registry, auth, vault, relay, and update distribution. Runs in the worker
 * tier (blue/green updated); it is a toggleable role, one active at a time
 * across the fleet. Like the agent, it owns no PTYs — those stay in sessiond.
 *
 * Boundary: depends on @glass/protocol only. The hub must never import the
 * agent or the viewer. Shared meaning lives in the protocol or nowhere.
 *
 * Skeleton only — no behavior yet (Phase 0).
 */
import { PROTOCOL_VERSION } from "@glass/protocol";

export const ROLE = "hub" as const;
export const SPEAKS_PROTOCOL = PROTOCOL_VERSION;

export function startHub(): never {
  throw new Error("hub: not implemented (Phase 0 skeleton)");
}
