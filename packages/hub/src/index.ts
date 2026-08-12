/**
 * Hub — the worker tier when a Mac is acting as Hub (plan §2, §3).
 *
 * Registry, auth, vault, relay, and update distribution. Runs in the worker
 * tier (blue/green updated); it is a toggleable role, one active at a time
 * across the fleet. Like the agent, it owns no PTYs — those stay in sessiond.
 *
 * Phase 1 milestone 2 builds the registry + relay; auth/vault/updates are later
 * phases. The executable entrypoint is `main.ts`.
 *
 * Boundary: depends on @glass/protocol only. The hub must never import the
 * agent or the viewer. Shared meaning lives in the protocol or nowhere.
 */
import { PROTOCOL_VERSION } from "@glass/protocol";

export const TIER = "worker" as const;
export const ROLE = "hub" as const;
export const SPEAKS_PROTOCOL = PROTOCOL_VERSION;

export { startHubServer, type HubServer } from "./server.js";
