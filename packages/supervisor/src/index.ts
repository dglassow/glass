/**
 * Supervisor — the lifecycle tier (plan §3).
 *
 * Starts, monitors, and restarts the worker (agent/hub) and the session
 * daemon, and coordinates the blue/green worker swap. This is the tier that is
 * "almost never" updated.
 *
 * Boundary: the supervisor deliberately does NOT depend on @glass/protocol. It
 * manages processes, not conversations — it never parses or emits wire
 * messages. Staying off the protocol means a protocol version bump can never
 * force the supervisor to change, which is what keeps this tier frozen. If
 * something here seems to need a protocol type, it belongs in the worker.
 *
 * Skeleton only — no behavior yet (Phase 0).
 */

export const TIER = "supervisor" as const;

export function startSupervisor(): never {
  throw new Error("supervisor: not implemented (Phase 0 skeleton)");
}
