/**
 * Device-key authentication primitives (Phase 2).
 *
 * These live in `protocol` because the hub must verify byte-for-byte exactly
 * what the agent and viewer sign — the signed payload is part of the wire
 * contract. Everything here is isomorphic: it uses only WebCrypto (`crypto`)
 * and `TextEncoder`, both present in Node 20+ and in browsers/WebKit, so the
 * same code runs on the hub, both clients, and (independently reimplemented) in
 * the acceptance test. No Node APIs, so the browser Viewer can import it too.
 *
 * Scheme: Ed25519. Public keys travel as base64url of the raw 32-byte key;
 * signatures as base64url of the raw 64-byte signature; the per-connection
 * nonce as base64url of 32 CSPRNG bytes. The signed payload is domain-separated
 * so a handshake signature can never be replayed into another context:
 *
 *   "glass:handshake:v1\n" + deviceId + "\n" + nonce(base64url)
 */

export const AUTH_CONTEXT = "glass:handshake:v1";
const ALG = { name: "Ed25519" } as const;

// WebCrypto's BufferSource typing is narrower than Uint8Array's (now generic
// over its backing buffer); the runtime accepts any Uint8Array, so cast at the
// boundary rather than threading ArrayBuffer generics through every helper.
function src(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/** A sign-only capability. A Keychain/Secure-Enclave impl never exposes the key. */
export interface Signer {
  /** base64url of the raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array {
  let b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The exact bytes signed and verified during the handshake. */
export function buildHandshakePayload(deviceId: string, nonceB64: string): Uint8Array {
  return new TextEncoder().encode(`${AUTH_CONTEXT}\n${deviceId}\n${nonceB64}`);
}

/** A fresh, single-use challenge nonce (base64url of 32 random bytes). */
export function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/** Generate a new device identity. Private key is PKCS#8 (the only format WebCrypto exports Ed25519 private keys in). */
export async function generateIdentity(): Promise<{ publicKey: string; privateKeyPkcs8: string }> {
  const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKey: base64urlEncode(raw), privateKeyPkcs8: base64urlEncode(pkcs8) };
}

/** Build a Signer from a stored PKCS#8 private key. */
export async function signerFromPrivateKey(publicKey: string, privateKeyPkcs8: string): Promise<Signer> {
  const key = await crypto.subtle.importKey("pkcs8", src(base64urlDecode(privateKeyPkcs8)), ALG, false, ["sign"]);
  return {
    publicKey,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(await crypto.subtle.sign(ALG, key, src(payload)));
    },
  };
}

/** Verify a handshake proof against a stored public key. Never throws. */
export async function verifyHandshakeProof(
  publicKey: string,
  deviceId: string,
  nonceB64: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", src(base64urlDecode(publicKey)), ALG, false, ["verify"]);
    return await crypto.subtle.verify(ALG, key, src(base64urlDecode(signatureB64)), src(buildHandshakePayload(deviceId, nonceB64)));
  } catch {
    return false;
  }
}

/** Validate that a base64url string decodes to a raw 32-byte Ed25519 public key. */
export async function isValidPublicKey(publicKey: string): Promise<boolean> {
  try {
    if (base64urlDecode(publicKey).length !== 32) return false;
    await crypto.subtle.importKey("raw", src(base64urlDecode(publicKey)), ALG, false, ["verify"]);
    return true;
  } catch {
    return false;
  }
}

/** A CSPRNG 6-digit numeric verification code for number matching. */
export function verificationCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(n % 1_000_000).padStart(6, "0");
}
