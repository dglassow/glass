/**
 * Git hosting for spokes (plan §13 piece 2, Phase 7). The hub keeps bare repos
 * and a per-device access list, served over smart-HTTP on the hub's own
 * authenticated TLS listener (see git-http.ts) — no separate SSH service.
 *
 * Access is per repo: `write` implies `read`. Devices authenticate to git with
 * an opaque bearer token (HTTP Basic: user=deviceId, pass=token); only a scrypt
 * hash of each token is stored, so the ACL file leaking does not yield tokens.
 * The store (repos + acl.json) is part of the backup bundle.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const REPO_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export class GitStoreError extends Error {}

interface RepoAcl {
  read: string[];
  write: string[];
}
interface TokenRec {
  salt: string; // base64
  hash: string; // base64 scrypt(token, salt)
}
interface AclFile {
  repos: Record<string, RepoAcl>;
  tokens: Record<string, TokenRec>;
}

function assertRepoName(name: string): void {
  if (!REPO_NAME_RE.test(name) || name.includes("..") || name.includes("/")) {
    throw new GitStoreError(`invalid repo name: ${JSON.stringify(name)} (allowed: [A-Za-z0-9._-], 1-64, no '..')`);
  }
}

export class GitStore {
  private acl: AclFile;
  private readonly aclPath: string;

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.aclPath = resolve(root, "acl.json");
    this.acl = existsSync(this.aclPath)
      ? (JSON.parse(readFileSync(this.aclPath, "utf8")) as AclFile)
      : { repos: {}, tokens: {} };
    if (!this.acl.repos) this.acl.repos = {};
    if (!this.acl.tokens) this.acl.tokens = {};
  }

  private save(): void {
    writeFileSync(this.aclPath, JSON.stringify(this.acl, null, 2), { mode: 0o600 });
  }

  /** Absolute path of a bare repo. Never derived from untrusted input un-validated. */
  repoPath(name: string): string {
    assertRepoName(name);
    return resolve(this.root, `${name}.git`);
  }

  repoExists(name: string): boolean {
    try {
      return existsSync(this.repoPath(name)) && statSync(this.repoPath(name)).isDirectory();
    } catch {
      return false;
    }
  }

  /** The dir git-http-backend serves from (GIT_PROJECT_ROOT). */
  projectRoot(): string {
    return resolve(this.root);
  }

  initRepo(name: string): void {
    assertRepoName(name);
    const path = this.repoPath(name);
    if (this.repoExists(name)) throw new GitStoreError(`repo already exists: ${name}`);
    const r = spawnSync("git", ["init", "--bare", "--initial-branch=main", path], { encoding: "utf8" });
    if (r.status !== 0) throw new GitStoreError(`git init --bare failed: ${r.stderr}`);
    // Let http-backend serve push for this repo (ACL is enforced before we ever
    // reach the backend, but this must be on or receive-pack is refused).
    spawnSync("git", ["-C", path, "config", "http.receivepack", "true"], { encoding: "utf8" });
    if (!this.acl.repos[name]) this.acl.repos[name] = { read: [], write: [] };
    this.save();
  }

  listRepos(): Array<{ name: string; read: string[]; write: string[] }> {
    const names = new Set<string>(Object.keys(this.acl.repos));
    try {
      for (const d of readdirSync(this.root)) if (d.endsWith(".git")) names.add(d.slice(0, -4));
    } catch {
      /* empty */
    }
    return [...names].sort().map((name) => ({
      name,
      read: this.acl.repos[name]?.read ?? [],
      write: this.acl.repos[name]?.write ?? [],
    }));
  }

  allow(name: string, deviceId: string, write: boolean): void {
    assertRepoName(name);
    if (!this.repoExists(name)) throw new GitStoreError(`no such repo: ${name}`);
    const acl = (this.acl.repos[name] ??= { read: [], write: [] });
    if (!acl.read.includes(deviceId)) acl.read.push(deviceId);
    if (write && !acl.write.includes(deviceId)) acl.write.push(deviceId);
    if (!write) acl.write = acl.write.filter((d) => d !== deviceId);
    this.save();
  }

  revoke(name: string, deviceId: string): void {
    assertRepoName(name);
    const acl = this.acl.repos[name];
    if (!acl) return;
    acl.read = acl.read.filter((d) => d !== deviceId);
    acl.write = acl.write.filter((d) => d !== deviceId);
    this.save();
  }

  canRead(name: string, deviceId: string): boolean {
    const acl = this.acl.repos[name];
    return !!acl && (acl.read.includes(deviceId) || acl.write.includes(deviceId));
  }
  canWrite(name: string, deviceId: string): boolean {
    const acl = this.acl.repos[name];
    return !!acl && acl.write.includes(deviceId);
  }

  /** Mint a fresh token for a device; returns the plaintext ONCE. */
  mintToken(deviceId: string): string {
    const token = randomBytes(32).toString("base64url");
    const salt = randomBytes(16);
    const hash = scryptSync(token, salt, 32);
    this.acl.tokens[deviceId] = { salt: salt.toString("base64"), hash: hash.toString("base64") };
    this.save();
    return token;
  }

  verifyToken(deviceId: string, token: string): boolean {
    const rec = this.acl.tokens[deviceId];
    if (!rec) return false;
    try {
      const salt = Buffer.from(rec.salt, "base64");
      const expected = Buffer.from(rec.hash, "base64");
      const actual = scryptSync(token, salt, expected.length);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
