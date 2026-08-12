/**
 * Minimal release-version handling for the updater. Release tags are
 * `v<MAJOR>.<MINOR>.<PATCH>` (an optional `-<pre>` suffix sorts *before* the
 * same release, per semver). This is the *code* version — distinct from the
 * wire PROTOCOL_VERSION in @glass/protocol.
 *
 * The only ordering the security model relies on is a total, monotonic compare
 * so the updater can refuse a downgrade. Keep it small and dependency-free.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** dot-separated pre-release identifiers, empty for a normal release */
  pre: string[];
  raw: string;
}

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse `v1.2.3` / `1.2.3` / `1.2.3-rc.1`. Returns null if not a version. */
export function parseSemVer(input: string): SemVer | null {
  const m = RE.exec(input.trim());
  if (!m) return null;
  const [, maj, min, pat, pre] = m;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    pre: pre ? pre.split(".") : [],
    raw: input.trim(),
  };
}

function comparePre(a: string[], b: string[]): number {
  // No pre-release outranks a pre-release (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1; // shorter set of identifiers is lower
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** -1 if a<b, 0 if equal, 1 if a>b. Total order over parsed versions. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.pre, b.pre);
}

/** Strict "b is newer than a" — the updater's no-downgrade predicate. */
export function isNewer(candidate: SemVer, current: SemVer): boolean {
  return compareSemVer(candidate, current) > 0;
}
