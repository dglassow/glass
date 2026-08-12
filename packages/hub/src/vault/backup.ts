/**
 * Encrypted backup bundle (plan §10). A single self-contained file the hub can
 * write on a schedule and restore on clean hardware — the §16 recovery drill.
 *
 * The vault DB is captured with `VACUUM INTO` (a consistent snapshot of the live
 * WAL database — never a raw file copy, which the plan forbids). The bundle also
 * carries the trust store and credential store, and is encrypted end to end
 * under a key derived from the vault passphrase (separate salt, own AAD), so it
 * is safe in an iCloud Drive folder without trusting Apple with the contents.
 *
 * Not in the bundle (by design): enclave-backed device keys (non-extractable —
 * a restored hub re-enrolls its agents) and Etch (a separately installed CLI).
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveSlotKek, gcmEncrypt, gcmDecrypt, SCRYPT_PARAMS } from "./crypto.js";

const AAD = Buffer.from("glass:backup:v1");
const APP_VERSION = "0.0.0";
const SCHEMA_VERSION = 1;

export interface BundleTargets {
  vaultDb: string;
  trustStore?: string;
  credStore?: string;
}

export function createBundle(t: BundleTargets & { out: string; passphrase: string }): void {
  const snapshot = `${t.out}.snapshot.tmp`;
  rmSync(snapshot, { force: true });
  const db = new DatabaseSync(t.vaultDb);
  db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  db.close();

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    createdAt: Date.now(),
    vaultDb: readFileSync(snapshot).toString("base64"),
    trustStore: t.trustStore && existsSync(t.trustStore) ? readFileSync(t.trustStore, "utf8") : null,
    credStore: t.credStore && existsSync(t.credStore) ? readFileSync(t.credStore, "utf8") : null,
  };
  rmSync(snapshot, { force: true });

  const salt = randomBytes(32);
  const key = deriveSlotKek(t.passphrase, salt, "backup");
  const enc = gcmEncrypt(key, Buffer.from(JSON.stringify(manifest), "utf8"), AAD);
  const bundle = {
    magic: "glass-backup",
    v: 1,
    kdf: SCRYPT_PARAMS,
    salt: salt.toString("base64"),
    iv: enc.iv.toString("base64"),
    tag: enc.tag.toString("base64"),
    ct: enc.ct.toString("base64"),
  };
  mkdirSync(dirname(t.out), { recursive: true, mode: 0o700 });
  writeFileSync(t.out, JSON.stringify(bundle), { mode: 0o600 });
}

export function restoreBundle(t: BundleTargets & { in: string; passphrase: string }): void {
  const bundle = JSON.parse(readFileSync(t.in, "utf8")) as {
    magic: string;
    salt: string;
    iv: string;
    tag: string;
    ct: string;
  };
  if (bundle.magic !== "glass-backup") throw new Error("not a glass backup bundle");

  const key = deriveSlotKek(t.passphrase, Buffer.from(bundle.salt, "base64"), "backup");
  let manifestJson: Buffer;
  try {
    manifestJson = gcmDecrypt(
      key,
      { iv: Buffer.from(bundle.iv, "base64"), ct: Buffer.from(bundle.ct, "base64"), tag: Buffer.from(bundle.tag, "base64") },
      AAD,
    );
  } catch {
    throw new Error("backup decrypt failed (wrong passphrase or corrupted bundle)");
  }
  const manifest = JSON.parse(manifestJson.toString("utf8")) as {
    vaultDb: string;
    trustStore: string | null;
    credStore: string | null;
  };

  mkdirSync(dirname(t.vaultDb), { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(t.vaultDb + suffix, { force: true });
  writeFileSync(t.vaultDb, Buffer.from(manifest.vaultDb, "base64"), { mode: 0o600 });
  if (t.trustStore && manifest.trustStore != null) writeFileSync(t.trustStore, manifest.trustStore, { mode: 0o600 });
  if (t.credStore && manifest.credStore != null) writeFileSync(t.credStore, manifest.credStore, { mode: 0o600 });
}
