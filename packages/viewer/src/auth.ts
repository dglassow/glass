/**
 * Viewer device identity + hub connection settings (browser persistence layer).
 *
 * The identity is a real Ed25519 keypair generated with WebCrypto on first run
 * and persisted in localStorage under the 'glass.identity' namespace (PKCS#8 —
 * the only format WebCrypto exports Ed25519 private keys in). It is exposed as
 * a Signer so the DOM-free HubClient never sees where the key lives; a later
 * platform tier can swap this for a Keychain/Secure-Enclave signer without
 * touching the client.
 *
 * This module is the ONLY place the viewer touches localStorage for identity
 * and hub config; main.ts consumes it, hub-client.ts never imports it.
 */
import { generateIdentity, signerFromPrivateKey, type Signer } from "@glass/protocol";

const IDENTITY_KEY = "glass.identity";
const HUB_CONFIG_KEY = "glass.hub.config";

/** A device identity: a Signer that also knows which deviceId it speaks for. */
export interface DeviceIdentity extends Signer {
  readonly deviceId: string;
}

interface StoredIdentity {
  v: 1;
  deviceId: string;
  publicKey: string;
  privateKeyPkcs8: string;
}

/**
 * Load the persisted device identity, generating (and persisting) a fresh one
 * on first run. The public key is what the hub operator trusts:
 *   hub trust add --device-id <id> --public-key <publicKey> --roles viewer
 */
export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  let stored = readJson<StoredIdentity>(IDENTITY_KEY);
  if (!stored || stored.v !== 1 || !stored.deviceId || !stored.publicKey || !stored.privateKeyPkcs8) {
    const fresh = await generateIdentity();
    stored = {
      v: 1,
      deviceId: `viewer-${crypto.randomUUID().slice(0, 8)}`,
      publicKey: fresh.publicKey,
      privateKeyPkcs8: fresh.privateKeyPkcs8,
    };
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(stored));
  }
  const signer = await signerFromPrivateKey(stored.publicKey, stored.privateKeyPkcs8);
  const deviceId = stored.deviceId;
  return {
    deviceId,
    publicKey: signer.publicKey,
    sign: (payload: Uint8Array) => signer.sign(payload),
  };
}

/** Where to connect and (for a trust-mode hub) which hub key to require. */
export interface HubConfig {
  hubUrl: string;
  /** Pinned hub public key. Absent = open-mode hub (dev only). */
  hubKeyPin?: string;
}

export function loadHubConfig(): HubConfig | null {
  const cfg = readJson<HubConfig>(HUB_CONFIG_KEY);
  return cfg && typeof cfg.hubUrl === "string" && cfg.hubUrl.length > 0 ? cfg : null;
}

export function saveHubConfig(hubUrl: string, hubKeyPin?: string): void {
  const cfg: HubConfig = hubKeyPin ? { hubUrl, hubKeyPin } : { hubUrl };
  localStorage.setItem(HUB_CONFIG_KEY, JSON.stringify(cfg));
}

function readJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
