/**
 * Agent device-key store (M1). Loads a Signer from a 0600 key file, generating
 * a fresh Ed25519 identity on first run. Only the private key material lives
 * here; callers get a sign-only Signer. The later concrete impl is macOS
 * Keychain / Secure Enclave behind the same Signer interface — deferred exactly
 * like the Tauri shell, no protocol impact.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { generateIdentity, signerFromPrivateKey, type Signer } from "@glass/protocol";

interface KeyFile {
  v: 1;
  deviceId?: string;
  publicKey: string;
  privateKeyPkcs8: string;
}

export async function loadOrCreateSigner(path: string, deviceId?: string): Promise<Signer> {
  let file: KeyFile;
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
  } else {
    const identity = await generateIdentity();
    file = { v: 1, ...(deviceId !== undefined ? { deviceId } : {}), publicKey: identity.publicKey, privateKeyPkcs8: identity.privateKeyPkcs8 };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    console.error(`agent: generated device key; public key ${file.publicKey}`);
  }
  return signerFromPrivateKey(file.publicKey, file.privateKeyPkcs8);
}
