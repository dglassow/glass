/**
 * Anti-rollback / anti-brick policy for the desktop auto-updater.
 *
 * Tauri's static-JSON updater installs whenever the manifest's `version` field is
 * greater than the running version, and minisign-verifies only the *artifact
 * bytes* — never the manifest. So a compromised update origin can lie in the
 * manifest: claim a huge version while serving an OLD (still validly-signed)
 * build to force a downgrade, or serve the CURRENT build to loop install→relaunch
 * forever (a brick). This module is the device-side guard, kept pure + framework
 * free so it's unit-tested:
 *   - `reconcile` runs on launch against the version we ACTUALLY booted: it
 *     raises a monotonic floor and, if a prior attempt didn't advance the running
 *     version (a lie/brick/rollback), poisons that target so we never retry it;
 *   - `shouldInstall` refuses anything already poisoned, not strictly newer, or
 *     at/below the floor;
 *   - `markAttempt` records the target so the next boot can tell if it took.
 * The floor + poison set are persisted by the caller (localStorage), surviving
 * app replacement.
 */
export interface UpdateState {
  /** Highest version this device has ever actually run. Never decreases. */
  floor: string;
  /** The version of the last update we triggered (to detect a no-advance lie). */
  lastTarget?: string;
  /** Target versions that failed to advance the running version — never retried. */
  blocked: string[];
  /** Consecutive installs that didn't advance the version (a lying origin). */
  noAdvance: number;
}

/** After this many consecutive lying updates, stop auto-updating entirely — a
 *  compromised origin cannot silently cycle a device through old builds; the
 *  fleet owner recovers with a manual install (a loud, visible failure state). */
export const MAX_NO_ADVANCE = 3;

export function emptyUpdateState(): UpdateState {
  return { floor: "0.0.0", blocked: [], noAdvance: 0 };
}

/** Compare dotted numeric versions (major.minor.patch...). Missing parts = 0.
 *  Non-numeric/garbage sorts as 0 so a malicious version string can't rank high. */
export function cmpVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    String(v).split(".").map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** On launch, reconcile persisted state with the version we actually booted. */
export function reconcile(state: UpdateState, current: string): UpdateState {
  const next: UpdateState = { floor: state.floor, blocked: [...state.blocked], noAdvance: state.noAdvance ?? 0 };
  if (state.lastTarget) {
    if (cmpVersions(current, state.lastTarget) < 0) {
      // We attempted `lastTarget` but did NOT reach it — the manifest lied
      // (served an older/other artifact) or the install looped. Poison the target
      // (never retried) AND count the lie toward the give-up threshold.
      if (!next.blocked.includes(state.lastTarget)) next.blocked.push(state.lastTarget);
      next.noAdvance = (state.noAdvance ?? 0) + 1;
    } else {
      // Reached (or exceeded) the target — a healthy origin. Reset the streak.
      next.noAdvance = 0;
    }
    // lastTarget is consumed (left undefined on `next`).
  }
  // Monotonic floor: the highest version ever booted. A rollback (current < floor)
  // is thereby remembered, and shouldInstall refuses to re-descend to it.
  if (cmpVersions(current, next.floor) > 0) next.floor = current;
  return next;
}

/** Decide whether to install `target` for a device currently running `current`. */
export function shouldInstall(state: UpdateState, current: string, target: string): boolean {
  if (!target || state.blocked.includes(target)) return false; // poisoned / no version
  if ((state.noAdvance ?? 0) >= MAX_NO_ADVANCE) return false; // origin lied repeatedly — halt
  if (cmpVersions(target, current) <= 0) return false; // not strictly newer
  if (cmpVersions(target, state.floor) <= 0) return false; // at/below the anti-rollback floor
  return true;
}

/** Record that we're about to install `target` (checked on the next boot). */
export function markAttempt(state: UpdateState, target: string): UpdateState {
  return { ...state, blocked: [...state.blocked], lastTarget: target };
}
