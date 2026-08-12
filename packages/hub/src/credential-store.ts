/**
 * The hub's passkey (WebAuthn) credential store — the owner's authenticators,
 * used to authorize the very first device (plan §8.4). M1-style file store
 * (0600 JSON, atomic write); SQLite alongside the trust store in Phase 3.
 *
 * Holds only public credential material (credential id, COSE public key, signature
 * counter) — safe for the backup bundle, never a secret.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredCredential {
  /** base64url WebAuthn credential id. */
  id: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  name: string;
  createdAt: number;
}

interface FileShape {
  version: 1;
  credentials: StoredCredential[];
}

export class CredentialStore {
  private credentials: StoredCredential[] = [];

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as FileShape;
      this.credentials = raw.credentials ?? [];
    }
  }

  isEmpty(): boolean {
    return this.credentials.length === 0;
  }
  list(): StoredCredential[] {
    return [...this.credentials];
  }
  get(id: string): StoredCredential | undefined {
    return this.credentials.find((c) => c.id === id);
  }
  add(credential: StoredCredential): void {
    if (this.get(credential.id)) return;
    this.credentials.push(credential);
    this.persist();
  }
  updateCounter(id: string, counter: number): void {
    const cred = this.get(id);
    if (cred) {
      cred.counter = counter;
      this.persist();
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const shape: FileShape = { version: 1, credentials: this.credentials };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best effort */
    }
  }
}
