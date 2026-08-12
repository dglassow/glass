/**
 * Protocol versioning.
 *
 * The Hub must always speak N-1 so that a spoke which was offline during a
 * rollout can reconnect on its old version long enough to pull the update.
 * A spoke two or more versions behind is refused.
 */

export const PROTOCOL_VERSION = 1;

/** Oldest peer version the current build will still talk to. */
export const MIN_SUPPORTED_VERSION = Math.max(1, PROTOCOL_VERSION - 1);

export type CompatibilityVerdict =
  | { status: "ok" }
  | { status: "peer_outdated"; peerVersion: number; minSupported: number }
  | { status: "peer_ahead"; peerVersion: number; ourVersion: number };

/**
 * Evaluated by whichever side receives a `hello`. The Hub calls this against a
 * connecting spoke; a spoke calls it against the Hub's `hello.ack`.
 */
export function checkCompatibility(peerVersion: number): CompatibilityVerdict {
  if (peerVersion > PROTOCOL_VERSION) {
    return { status: "peer_ahead", peerVersion, ourVersion: PROTOCOL_VERSION };
  }
  if (peerVersion < MIN_SUPPORTED_VERSION) {
    return { status: "peer_outdated", peerVersion, minSupported: MIN_SUPPORTED_VERSION };
  }
  return { status: "ok" };
}
