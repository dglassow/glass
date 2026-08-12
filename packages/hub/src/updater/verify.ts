/**
 * The security gate of the entire update system (plan §4).
 *
 * A release tag is trusted iff `git verify-tag` returns 0 against an
 * allowed-signers file that is **pinned outside the repo being verified**. If
 * the updater read the trusted key from the repo it is checking, an attacker
 * who controls the repo would swap both the code and the key and verification
 * would pass — so we refuse an allowed-signers path that lives inside repoDir.
 *
 * HARDENING (found by red-team): `git verify-tag` delegates SSH verification to
 * the program named by `gpg.ssh.program`, which git reads from the *repo's own*
 * .git/config. An attacker who controls the repo can point that at a script
 * that prints a fake "Good signature" and exits 0 — bypassing the pinned key
 * entirely. So we PIN gpg.ssh.program to the real ssh-keygen via a command-line
 * `-c` (which outranks every config file) and neutralize global/system git
 * config. The caller must also pass an immutable OID (not a ref name) so the ref
 * can't be flipped between verify and export (TOCTOU).
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface VerifyResult {
  trusted: boolean;
  /** signer principal (email/identity) from the allowed-signers file, if trusted */
  signer: string | null;
  /** key fingerprint git reported, for the audit log */
  fingerprint: string | null;
  /** raw git output, for logging on failure */
  detail: string;
}

export class UpdateVerifyError extends Error {}

/** Candidate absolute paths for the *real* ssh-keygen, in priority order. */
const SSH_KEYGEN_CANDIDATES = [
  process.env.GLASS_SSH_KEYGEN,
  "/usr/bin/ssh-keygen",
  "/bin/ssh-keygen",
  "/usr/local/bin/ssh-keygen",
  "/opt/homebrew/bin/ssh-keygen",
].filter((p): p is string => typeof p === "string" && p.length > 0);

let cachedSshKeygen: string | null = null;
function realSshKeygen(): string {
  if (cachedSshKeygen) return cachedSshKeygen;
  for (const p of SSH_KEYGEN_CANDIDATES) {
    try {
      if (existsSync(p) && statSync(p).isFile()) {
        cachedSshKeygen = p;
        return p;
      }
    } catch {
      /* try next */
    }
  }
  // Fail closed: without a trusted verifier program we cannot verify anything.
  throw new UpdateVerifyError(
    "could not locate a real ssh-keygen to pin as gpg.ssh.program (set GLASS_SSH_KEYGEN)",
  );
}

/** git env that ignores global/system config so only our -c overrides + repo apply. */
export function hardenedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

/**
 * -c pins applied to EVERY git call against an untrusted repo. The repo's own
 * .git/config is always read (env can't disable it), and command-line -c
 * outranks it — so this neutralizes the config keys that turn a plain
 * fetch/ls-tree/rev-parse into code execution: ssh transport (core.sshCommand),
 * credential/fsmonitor/proxy helper commands, hooks, and the ext:: transport.
 * Without this, an attacker who can write .git/config gets RCE during fetch(),
 * before any signature verification runs.
 */
export const HARDENED_GIT_CONFIG: string[] = [
  "-c", "core.sshCommand=false",
  "-c", "credential.helper=",
  "-c", "core.fsmonitor=",
  "-c", "core.gitproxy=",
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.ext.allow=never",
  "-c", "core.pager=cat",
  "-c", "uploadpack.packObjectsHook=",
];

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Verify the SSH signature on a tag *object* (pass an immutable OID, not a ref
 * name, so it can't be flipped). Never throws on an *untrusted* tag — that
 * returns {trusted:false}. Throws only on misconfiguration (missing
 * repo/allowed-signers, in-repo allowed-signers, or no real ssh-keygen).
 */
export function verifyTagSignature(repoDir: string, ref: string, allowedSignersPath: string): VerifyResult {
  if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
    throw new UpdateVerifyError(`repo dir does not exist: ${repoDir}`);
  }
  if (!existsSync(allowedSignersPath) || !statSync(allowedSignersPath).isFile()) {
    throw new UpdateVerifyError(`pinned allowed-signers file not found: ${allowedSignersPath}`);
  }
  if (statSync(allowedSignersPath).size === 0) {
    throw new UpdateVerifyError(`pinned allowed-signers file is empty: ${allowedSignersPath}`);
  }
  if (isInside(allowedSignersPath, repoDir)) {
    throw new UpdateVerifyError(
      `allowed-signers file must live OUTSIDE the repo it verifies (got ${allowedSignersPath} inside ${repoDir})`,
    );
  }

  const res = spawnSync(
    "git",
    [
      "-C",
      repoDir,
      ...HARDENED_GIT_CONFIG,
      // Command-line -c outranks every config file, so a repo-local
      // gpg.ssh.program / gpg.format / allowedSignersFile cannot override these.
      "-c",
      "gpg.format=ssh",
      "-c",
      `gpg.ssh.program=${realSshKeygen()}`,
      "-c",
      `gpg.ssh.allowedSignersFile=${resolve(allowedSignersPath)}`,
      "verify-tag",
      "--raw",
      "--",
      ref,
    ],
    { encoding: "utf8", env: hardenedGitEnv() },
  );

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const trustedExit = res.status === 0;
  const goodSig = /\bGOODSIG\b/.test(out) || /Good "git" signature for /.test(out);
  const noPrincipal = /No principal matched/i.test(out);
  const trusted = trustedExit && goodSig && !noPrincipal;

  const signerMatch = /Good "git" signature for (\S+)/.exec(out);
  const fpMatch = /key\s+(SHA256:[A-Za-z0-9+/]+)/.exec(out) ?? /(SHA256:[A-Za-z0-9+/]+)/.exec(out);

  return {
    trusted,
    signer: trusted ? signerMatch?.[1] ?? null : null,
    fingerprint: fpMatch?.[1] ?? null,
    detail: out.trim(),
  };
}
