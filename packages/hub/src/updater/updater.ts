/**
 * Update orchestrator (plan §4). Decides whether to move, proves the target is
 * trustworthy, and stages exactly the verified tree — but never performs the
 * swap itself. The mechanical blue/green swap belongs to the supervisor; the
 * updater's job is to hand it an entry path it can trust.
 *
 * Ordering guarantees:
 *  - No downgrade: the target release version must be strictly newer.
 *  - No unsigned/foreign-signed apply: only a tag that verifies against the
 *    pinned key is a candidate; a newer-but-unverified tag is skipped, not
 *    applied and not allowed to mask an older verified one below it.
 *  - Bounded protocol advance: the hub may raise the wire protocol by at most 1
 *    per update, so it always still speaks N-1 for spokes that were offline.
 */
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { PROTOCOL_VERSION } from "@glass/protocol";
import { parseSemVer, isNewer, compareSemVer, type SemVer } from "./semver.js";
import { GitUpdateSource, type ReleaseManifest } from "./update-source.js";
import { UpdateVerifyError, type VerifyResult } from "./verify.js";

export interface RejectedTag {
  tag: string;
  reason: string;
}

export type UpdateDecision =
  | { action: "none"; reason: string; rejected: RejectedTag[] }
  | { action: "apply"; tag: string; version: SemVer; verify: VerifyResult; rejected: RejectedTag[] };

export interface StageResult {
  tag: string;
  version: string;
  protocolVersion: number;
  /** absolute path to the new worker entry, to hand to `supervisor swap` */
  entryPath: string;
  stagingDir: string;
  manifest: ReleaseManifest;
}

export interface UpdaterOptions {
  /** local git clone that tracks the release remote */
  repoDir: string;
  /** pinned allowed-signers file, OUTSIDE repoDir (plan §4) */
  allowedSignersPath: string;
  /** where verified trees are exported for staging */
  stagingRoot: string;
  /** the version this build currently runs as */
  currentVersion: string;
  /** local wire protocol (defaults to the compiled-in PROTOCOL_VERSION) */
  localProtocol?: number;
  /** remote name to fetch from */
  remote?: string;
}

export class Updater {
  private readonly source: GitUpdateSource;
  private readonly current: SemVer;
  private readonly localProtocol: number;

  constructor(private readonly opts: UpdaterOptions) {
    const cur = parseSemVer(opts.currentVersion);
    if (!cur) throw new UpdateVerifyError(`currentVersion is not a version: ${opts.currentVersion}`);
    this.current = cur;
    this.localProtocol = opts.localProtocol ?? PROTOCOL_VERSION;
    this.source = new GitUpdateSource(opts.repoDir, opts.allowedSignersPath);
  }

  /** Refresh from the remote and pick the newest *verified* release newer than us. */
  checkForUpdate(): UpdateDecision {
    this.source.fetch(this.opts.remote ?? "origin");
    const rejected: RejectedTag[] = [];
    const candidates = this.source
      .listReleaseTags()
      .filter((t) => isNewer(t.version, this.current)); // strictly newer only

    for (const { tag, version } of candidates) {
      let v: VerifyResult;
      try {
        v = this.source.verifyTag(tag);
      } catch (e) {
        // Misconfiguration (e.g. missing pinned key) is fatal, not skippable.
        throw e instanceof UpdateVerifyError ? e : new UpdateVerifyError(String(e));
      }
      if (!v.trusted) {
        rejected.push({ tag, reason: `signature not trusted: ${v.detail.split("\n")[0] ?? "unverified"}` });
        continue; // a newer unsigned/foreign tag never masks an older verified one
      }
      return { action: "apply", tag, version, verify: v, rejected };
    }
    return {
      action: "none",
      reason: candidates.length ? "no newer release passed signature verification" : "already at latest",
      rejected,
    };
  }

  /**
   * Export + validate the verified tag into a fresh staging dir. Throws
   * UpdateVerifyError on any inconsistency — the caller must NOT swap on throw.
   */
  stage(tag: string): StageResult {
    // Re-verify at stage time: never trust a tag name a caller hands us.
    const v = this.source.verifyTag(tag);
    if (!v.trusted) throw new UpdateVerifyError(`refusing to stage ${tag}: signature not trusted`);

    const tagVer = parseSemVer(tag);
    if (!tagVer) throw new UpdateVerifyError(`refusing to stage non-version tag: ${tag}`);
    if (!isNewer(tagVer, this.current)) {
      throw new UpdateVerifyError(`refusing downgrade: ${tag} is not newer than ${this.current.raw}`);
    }

    const stagingDir = resolve(this.opts.stagingRoot, `stage-${tag}`);
    rmSync(stagingDir, { recursive: true, force: true });
    this.source.exportTag(tag, stagingDir);

    const manifest = GitUpdateSource.readManifest(stagingDir);

    // Defense in depth: the signed manifest must agree with the signed tag name.
    const manVer = parseSemVer(manifest.version)!;
    if (compareSemVer(manVer, tagVer) !== 0) {
      throw new UpdateVerifyError(`manifest version ${manifest.version} disagrees with tag ${tag}`);
    }

    // Bounded protocol advance: local ≤ target ≤ local+1 (always keep N-1).
    if (manifest.protocolVersion < this.localProtocol) {
      throw new UpdateVerifyError(`refusing protocol downgrade ${this.localProtocol} → ${manifest.protocolVersion}`);
    }
    if (manifest.protocolVersion > this.localProtocol + 1) {
      throw new UpdateVerifyError(
        `refusing protocol jump ${this.localProtocol} → ${manifest.protocolVersion} (>1); update stepwise`,
      );
    }

    const entryPath = resolve(stagingDir, manifest.entry);
    if (!entryPath.startsWith(resolve(stagingDir))) {
      throw new UpdateVerifyError(`entry escapes staging dir: ${manifest.entry}`);
    }
    if (!existsSync(entryPath)) {
      throw new UpdateVerifyError(`entry not present in release: ${manifest.entry}`);
    }

    return {
      tag,
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      entryPath,
      stagingDir,
      manifest,
    };
  }
}
