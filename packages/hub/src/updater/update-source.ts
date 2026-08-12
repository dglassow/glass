/**
 * A git-backed update source (plan §4: "GitHub is the source of truth ... The
 * Hub tracks it"). Wraps the git plumbing the updater needs: refresh tags from
 * the remote, enumerate release tags, verify a tag's signature, and export the
 * *exact tree that tag names* to a staging dir.
 *
 * Export (not a live checkout) matters: `git archive <tag>` writes the tree the
 * verified tag object points at and nothing else — no working-tree state, no
 * .git the box could be tricked into re-fetching from. Because a good tag
 * signature Merkle-fixes the whole tree, every file in the export — including
 * release.json — is authenticated by that one signature.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseSemVer, compareSemVer, type SemVer } from "./semver.js";
import { verifyTagSignature, type VerifyResult, UpdateVerifyError } from "./verify.js";

export interface ReleaseManifest {
  version: string;
  /** wire protocol this build speaks (compared to @glass/protocol locally) */
  protocolVersion: number;
  /** oldest peer protocol this build still talks to; defaults to protocolVersion-1 */
  minPeerProtocol?: number;
  /** worker entry, relative to the staging dir (e.g. "packages/hub/dist/main.js") */
  entry: string;
}

export interface ReleaseTag {
  tag: string;
  version: SemVer;
}

function git(repoDir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export class GitUpdateSource {
  constructor(
    private readonly repoDir: string,
    private readonly allowedSignersPath: string,
  ) {
    if (!existsSync(resolve(repoDir, ".git")) && !existsSync(resolve(repoDir, "HEAD"))) {
      throw new UpdateVerifyError(`not a git repo: ${repoDir}`);
    }
  }

  /** Pull latest tags/objects from the tracked remote. Best-effort offline. */
  fetch(remote = "origin"): boolean {
    const r = git(this.repoDir, ["fetch", "--tags", "--prune", "--force", remote]);
    return r.status === 0;
  }

  /** Release tags (v*), newest first. Non-version tags are ignored. */
  listReleaseTags(): ReleaseTag[] {
    const r = git(this.repoDir, ["tag", "--list", "v*"]);
    if (r.status !== 0) return [];
    const tags: ReleaseTag[] = [];
    for (const line of r.stdout.split("\n")) {
      const name = line.trim();
      if (!name) continue;
      const version = parseSemVer(name);
      if (version) tags.push({ tag: name, version });
    }
    tags.sort((a, b) => compareSemVer(b.version, a.version)); // newest first
    return tags;
  }

  verifyTag(tag: string): VerifyResult {
    return verifyTagSignature(this.repoDir, tag, this.allowedSignersPath);
  }

  /** Export the tree the (already-verified) tag points at into destDir. */
  exportTag(tag: string, destDir: string): void {
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    // `git archive <tag> | tar -x` — export the authenticated tree, nothing else.
    const archive = spawnSync("git", ["-C", this.repoDir, "archive", "--format=tar", tag], {
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024,
    });
    if (archive.status !== 0) {
      throw new UpdateVerifyError(`git archive ${tag} failed: ${archive.stderr?.toString() ?? ""}`);
    }
    const untar = spawnSync("tar", ["-x", "-C", destDir], { input: archive.stdout });
    if (untar.status !== 0) {
      throw new UpdateVerifyError(`untar of ${tag} failed: ${untar.stderr?.toString() ?? ""}`);
    }
  }

  /** Read + shape-check the signed release manifest from a staging dir. */
  static readManifest(stagingDir: string): ReleaseManifest {
    const path = resolve(stagingDir, "release.json");
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new UpdateVerifyError(`release.json missing in ${stagingDir}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new UpdateVerifyError(`release.json is not valid JSON: ${(e as Error).message}`);
    }
    const m = raw as Record<string, unknown>;
    if (typeof m.version !== "string" || !parseSemVer(m.version)) {
      throw new UpdateVerifyError(`release.json: bad version ${JSON.stringify(m.version)}`);
    }
    if (typeof m.protocolVersion !== "number" || !Number.isInteger(m.protocolVersion) || m.protocolVersion < 1) {
      throw new UpdateVerifyError(`release.json: bad protocolVersion ${JSON.stringify(m.protocolVersion)}`);
    }
    if (typeof m.entry !== "string" || m.entry.length === 0 || m.entry.startsWith("/") || m.entry.includes("..")) {
      throw new UpdateVerifyError(`release.json: entry must be a repo-relative path, got ${JSON.stringify(m.entry)}`);
    }
    const out: ReleaseManifest = {
      version: m.version,
      protocolVersion: m.protocolVersion,
      entry: m.entry,
    };
    if (typeof m.minPeerProtocol === "number" && Number.isInteger(m.minPeerProtocol)) {
      out.minPeerProtocol = m.minPeerProtocol;
    }
    return out;
  }
}
