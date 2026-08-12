/**
 * The security gate of the entire update system (plan §4).
 *
 * A release tag is trusted iff `git verify-tag` returns 0 against an
 * allowed-signers file that is **pinned outside the repo being verified**. If
 * the updater read the trusted key from the repo it is checking, an attacker
 * who controls the repo would swap both the code and the key and verification
 * would pass — so we refuse an allowed-signers path that lives inside repoDir.
 *
 * git returns 0 only for a good signature from a principal listed in that file;
 * unsigned tags, lightweight tags, wrong-key signatures, and "no principal
 * matched" all return non-zero. We gate on the exit code (the documented
 * contract) and additionally require a GOODSIG-shaped line as defense in depth.
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

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Verify the SSH signature on an annotated tag against a pinned allowed-signers
 * file. Never throws on an *untrusted* tag — that returns {trusted:false}, which
 * the caller treats as "do not apply". Throws only on misconfiguration
 * (missing repo/allowed-signers, or an allowed-signers file inside the repo).
 */
export function verifyTagSignature(repoDir: string, tag: string, allowedSignersPath: string): VerifyResult {
  if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
    throw new UpdateVerifyError(`repo dir does not exist: ${repoDir}`);
  }
  if (!existsSync(allowedSignersPath) || !statSync(allowedSignersPath).isFile()) {
    // Fail closed: no pinned key ⇒ nothing is trusted, and this is a
    // misconfiguration worth surfacing loudly rather than silently trusting.
    throw new UpdateVerifyError(`pinned allowed-signers file not found: ${allowedSignersPath}`);
  }
  if (statSync(allowedSignersPath).size === 0) {
    throw new UpdateVerifyError(`pinned allowed-signers file is empty: ${allowedSignersPath}`);
  }
  if (isInside(allowedSignersPath, repoDir)) {
    // The whole point of pinning is that the repo can't vouch for itself.
    throw new UpdateVerifyError(
      `allowed-signers file must live OUTSIDE the repo it verifies (got ${allowedSignersPath} inside ${repoDir})`,
    );
  }

  const res = spawnSync(
    "git",
    [
      "-C",
      repoDir,
      "-c",
      "gpg.format=ssh",
      "-c",
      `gpg.ssh.allowedSignersFile=${resolve(allowedSignersPath)}`,
      "verify-tag",
      "--raw",
      "--",
      tag,
    ],
    { encoding: "utf8" },
  );

  // git writes the human/`--raw` status to stderr.
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const trustedExit = res.status === 0;

  // Defense in depth: even on exit 0, require the trusted-signature marker and
  // a matched principal. "No principal matched" must never count as trusted.
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
