/**
 * Vault cryptography (Phase 3). Pure node:crypto — no dependencies, so the
 * self-updating public repo stays free of native addons.
 *
 * Design (red-teamed):
 *  - Master key MK = 32 random bytes, NEVER derived from a passphrase. It is
 *    wrapped in independent LUKS-style keyslots (passphrase, recovery, later
 *    enclave), so recovery-key-only unlock works and rotations are independent.
 *  - Each slot KEK = HKDF(scrypt(input, salt), info="glass/v1/slot-kek/<slot>").
 *    The wrapped-MK GCM tag IS the wrong-input verifier — one scrypt + one AES
 *    per guess, no cheaper oracle stored.
 *  - Every secret gets a fresh random DEK (so a 96-bit random nonce never
 *    repeats under a key), AES-256-GCM, with AAD binding vaultId+id+version+class
 *    so ciphertext can't be transplanted between rows or have its class flipped.
 */
import { scryptSync, hkdfSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, keyLen: 32, maxmem: 256 * 1024 * 1024 } as const;
const SEP = "\x1f"; // unit separator; fields below never contain it (uuid/int/enum)

export interface Gcm {
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
}

const norm = (s: string): Buffer => Buffer.from(s.normalize("NFKC"), "utf8");

/** Derive a slot key-encryption-key from a secret input and its salt. */
export function deriveSlotKek(input: string, salt: Buffer, slot: string): Buffer {
  const stretched = scryptSync(norm(input), salt, SCRYPT_PARAMS.keyLen, SCRYPT_PARAMS);
  return Buffer.from(hkdfSync("sha256", stretched, salt, `glass/v1/slot-kek/${slot}`, 32));
}

export function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Gcm {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

/** Throws on any authentication failure (wrong key, tampered ct, wrong AAD). */
export function gcmDecrypt(key: Buffer, blob: Gcm, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, blob.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(blob.tag);
  return Buffer.concat([decipher.update(blob.ct), decipher.final()]);
}

// --- associated data (context binding) ---
export const slotAad = (vaultId: string, slot: string): Buffer =>
  Buffer.from(["glass-vault/v1", "slot", vaultId, slot].join(SEP), "utf8");
export const wrapAad = (vaultId: string, secretId: string, version: number): Buffer =>
  Buffer.from(["glass-vault/v1", "wrap", vaultId, secretId, String(version)].join(SEP), "utf8");
export const valueAad = (vaultId: string, secretId: string, version: number, cls: string): Buffer =>
  Buffer.from(["glass-vault/v1", "value", vaultId, secretId, String(version), cls].join(SEP), "utf8");

export const newMasterKey = (): Buffer => randomBytes(32);
export const newDataKey = (): Buffer => randomBytes(32);

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Conservative recovery-key entropy estimate (bits). Word-phrases are rated by
 * unique-word count (diceware ceiling); otherwise by collapsed length × the
 * present character-class pool. The system never generates this key, so the
 * gate only has to refuse the classic weak inputs.
 */
export function estimateRecoveryBits(input: string): number {
  const s = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  const words = s.split(" ").filter(Boolean);
  if (words.length >= 2) return new Set(words).size * 12.9;
  const collapsed = s.replace(/(.)\1{2,}/g, "$1$1"); // 3+ repeats -> 2
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(s)) pool += 33;
  return collapsed.length * Math.log2(Math.max(pool, 2));
}

export const RECOVERY_MIN_BITS = 90;

/** Returns an error message if the recovery key is too weak, else null. */
export function checkRecoveryStrength(recoveryKey: string, passphrase: string): string | null {
  const s = recoveryKey.normalize("NFKC").trim();
  if (s.length < 16) return "recovery key too weak: must be at least 16 characters";
  if (new Set(s).size < 4) return "recovery key too weak: too few distinct characters";
  if (s === passphrase.normalize("NFKC").trim()) return "recovery key too weak: must differ from the passphrase";
  const bits = estimateRecoveryBits(recoveryKey);
  if (bits < RECOVERY_MIN_BITS) {
    return `recovery key too weak: ~${Math.round(bits)} bits, need ${RECOVERY_MIN_BITS}+ (use ~10 random words or 26+ random characters)`;
  }
  return null;
}
