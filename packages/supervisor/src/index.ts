/**
 * Supervisor — the lifecycle tier (plan §3).
 *
 * Starts, monitors, and restarts the worker (agent/hub) and the session daemon,
 * and coordinates the blue/green worker swap. This is the tier that is "almost
 * never" updated.
 *
 * Boundary: the supervisor deliberately does NOT depend on @glass/protocol. It
 * manages processes, not conversations — it never parses or emits wire
 * messages. Staying off the protocol means a protocol version bump can never
 * force the supervisor to change, which is what keeps this tier frozen.
 *
 * The executable entrypoint is `main.ts`.
 */
export const TIER = "supervisor" as const;

export { Supervisor, type SupervisorOptions } from "./supervisor.js";
export { Worker } from "./proc.js";
export { startControlSocket } from "./control.js";
