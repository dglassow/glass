/**
 * A git-backed update source (plan §4: "GitHub is the source of truth ... The
 * Hub tracks it"). Wraps the git plumbing the updater needs: refresh tags from
 * the remote, enumerate release tags, resolve a tag to an immutable OID, verify
 * that OID's signature, and export the *exact tree that OID names* to a staging
 * dir.
 *
 * HARDENING (red-team):
 *  - Everything is pinned to an OID, never a ref name, so the ref can't be
 *    flipped between verify and export (TOCTOU).
 *  - Export is a direct `ls-tree` + `cat-file blob` extraction, NOT `git
 *    archive`. That (a) writes bytes byte-identical to the signed blob objects,
 *    defeating `.gitattributes` export-subst/export-ignore rewrites; and (b)
 *    refuses symlinks and submodules outright, so nothing in the staged tree can
 *    resolve outside the staging dir.
 *  - All git invocations run with global/system config neutralized.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname, sep, isAbsolute } from "node:path";
import { parseSemVer, compareSemVer, type SemVer } from "./semver.js";
import { verifyTagSignature, hardenedGitEnv, type VerifyResult, UpdateVerifyError } from "./verify.js";

export interface ReleaseManifest {
  version: string;
  protocolVersion: number;
  minPeerProtocol?: number;
  entry: string;
}

export interface ReleaseTag {
  tag: string;
  version: SemVer;
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
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

  private git(args: string[], opts: { encoding?: "utf8" | "buffer" } = {}): { status: number; stdout: string; stderr: string } {
    const res = spawnSync("git", ["-C", this.repoDir, ...args], {
      encoding: "utf8",
      env: hardenedGitEnv(),
      maxBuffer: 512 * 1024 * 1024,
      ...(opts.encoding === "buffer" ? { encoding: "buffer" as BufferEncoding } : {}),
    });
    return { status: res.status ?? -1, stdout: (res.stdout as string) ?? "", stderr: (res.stderr as string) ?? "" };
  }

  private gitBuffer(args: string[]): { status: number; stdout: Buffer; stderr: string } {
    const res = spawnSync("git", ["-C", this.repoDir, ...args], { env: hardenedGitEnv(), maxBuffer: 512 * 1024 * 1024 });
    return { status: res.status ?? -1, stdout: (res.stdout as Buffer) ?? Buffer.alloc(0), stderr: res.stderr?.toString() ?? "" };
  }

  /** Pull latest tags/objects from the tracked remote. Best-effort offline. */
  fetch(remote = "origin"): boolean {
    return this.git(["fetch", "--tags", "--prune", "--force", remote]).status === 0;
  }

  /** Release tags (v*), newest first. Non-version tags are ignored. */
  listReleaseTags(): ReleaseTag[] {
    const r = this.git(["tag", "--list", "v*"]);
    if (r.status !== 0) return [];
    const tags: ReleaseTag[] = [];
    for (const line of r.stdout.split("\n")) {
      const name = line.trim();
      if (!name) continue;
      const version = parseSemVer(name);
      if (version) tags.push({ tag: name, version });
    }
    tags.sort((a, b) => compareSemVer(b.version, a.version));
    return tags;
  }

  /**
   * Resolve a release tag to the immutable OID of its annotated tag object.
   * Rejects lightweight tags (which are unsigned commit refs). Everything
   * downstream keys off this OID so a concurrent `git tag -f` can't swap the
   * content out from under verify/export.
   */
  resolveTagObject(tag: string): string {
    const rp = this.git(["rev-parse", "--verify", "--end-of-options", `refs/tags/${tag}`]);
    if (rp.status !== 0) throw new UpdateVerifyError(`cannot resolve tag ${tag}: ${rp.stderr.trim()}`);
    const oid = rp.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new UpdateVerifyError(`bad OID for ${tag}: ${oid}`);
    const typ = this.git(["cat-file", "-t", oid]);
    if (typ.stdout.trim() !== "tag") {
      throw new UpdateVerifyError(`${tag} is not an annotated tag object (lightweight/unsigned tags are refused)`);
    }
    return oid;
  }

  /** Verify the signature of a tag OID against the pinned allowed-signers. */
  verifyObject(oid: string): VerifyResult {
    return verifyTagSignature(this.repoDir, oid, this.allowedSignersPath);
  }

  /**
   * Convenience for the scan: resolve a tag name to its OID and verify it. A
   * tag that won't resolve to an annotated object (lightweight, re-pointed to a
   * commit, missing) is simply *untrusted* — returned as trusted:false so one
   * tampered tag can't abort the whole scan. Genuine misconfiguration (missing
   * pinned key, no ssh-keygen) still throws, from verifyObject.
   */
  verifyTag(tag: string): VerifyResult {
    let oid: string;
    try {
      oid = this.resolveTagObject(tag);
    } catch (e) {
      return { trusted: false, signer: null, fingerprint: null, detail: e instanceof Error ? e.message : String(e) };
    }
    return this.verifyObject(oid);
  }

  /**
   * Export the tree of a (already-verified) tag OID into destDir by walking the
   * tree and writing each blob byte-for-byte from the object store. Refuses
   * symlinks and submodules so nothing in the staged tree escapes destDir.
   */
  exportObject(oid: string, destDir: string): void {
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const dest = resolve(destDir);
    const ls = this.gitBuffer(["ls-tree", "-r", "-z", "--full-tree", oid]);
    if (ls.status !== 0) throw new UpdateVerifyError(`ls-tree ${oid} failed: ${ls.stderr}`);
    const entries = ls.stdout.toString("utf8").split("\0").filter((s) => s.length > 0);
    for (const line of entries) {
      // "<mode> SP <type> SP <objectname> TAB <path>"
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, sha] = line.slice(0, tab).trim().split(/\s+/);
      const path = line.slice(tab + 1);
      if (!mode || !type || !sha) throw new UpdateVerifyError(`malformed ls-tree entry: ${line}`);
      if (type === "commit" || mode === "160000") throw new UpdateVerifyError(`refusing release with a submodule at ${path}`);
      if (mode === "120000") throw new UpdateVerifyError(`refusing release with a symlink at ${path}`);
      if (type !== "blob") throw new UpdateVerifyError(`unexpected tree entry type ${type} at ${path}`);
      if (isAbsolute(path) || path.startsWith("/") || path.split("/").includes("..")) {
        throw new UpdateVerifyError(`unsafe path in release: ${path}`);
      }
      const target = resolve(dest, path);
      if (!isInside(target, dest)) throw new UpdateVerifyError(`path escapes staging: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      const blob = this.gitBuffer(["cat-file", "blob", sha]);
      if (blob.status !== 0) throw new UpdateVerifyError(`cat-file blob ${sha} failed: ${blob.stderr}`);
      writeFileSync(target, blob.stdout, { mode: mode === "100755" ? 0o755 : 0o644 });
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
