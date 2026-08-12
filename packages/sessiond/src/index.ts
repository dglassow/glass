/**
 * Session daemon — owns live PTY file descriptors (plan §3).
 *
 * PTYs live here, not in the worker, because this process survives worker
 * updates. Most updates swap the worker blue/green while shells keep running
 * untouched; when sessiond itself must change, the live fds pass to the new
 * instance over a Unix socket (SCM_RIGHTS) and scrollback rehydrates from disk.
 *
 * Boundary: depends on @glass/protocol only. It exchanges Envelope frames with
 * the worker over a Unix domain socket; it never imports the worker (agent) or
 * the hub. The socket is the seam, the protocol is the contract.
 *
 * Skeleton only — no behavior yet (Phase 0).
 */
import { PROTOCOL_VERSION } from "@glass/protocol";

export const TIER = "sessiond" as const;
export const SPEAKS_PROTOCOL = PROTOCOL_VERSION;

export function startSessiond(): never {
  throw new Error("sessiond: not implemented (Phase 0 skeleton)");
}
