/**
 * The hub's own identity key (mutual auth). Spokes PIN its public key; the hub
 * proves possession during the handshake. Distinct from the update-signing key.
 * 0600 file, generated on first run. Keychain/backup is the later store.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { generateIdentity, signerFromPrivateKey, type Signer } from "@glass/protocol";

export async function loadOrCreateHubSigner(path: string): Promise<Signer> {
  let file: { publicKey: string; privateKeyPkcs8: string };
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, "utf8"));
  } else {
    const identity = await generateIdentity();
    file = { publicKey: identity.publicKey, privateKeyPkcs8: identity.privateKeyPkcs8 };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ v: 1, ...file }, null, 2), { mode: 0o600 });
  }
  return signerFromPrivateKey(file.publicKey, file.privateKeyPkcs8);
}
