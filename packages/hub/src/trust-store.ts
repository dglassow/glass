/**
 * The hub's trust store: which deviceIds are authorized and their public keys.
 *
 * M1 implementation is a 0600 JSON file, written atomically (tmp + rename) so a
 * crash mid-enrollment can't corrupt it. It holds only PUBLIC keys, so it is
 * safe alongside the public repo and belongs in the backup bundle (plan §10).
 * SQLite (plan §5) replaces this behind the same interface no later than Phase 3.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceRole } from "@glass/protocol";

export interface TrustedDevice {
  /** base64url of the raw 32-byte Ed25519 public key. */
  publicKey: string;
  name: string;
  roles: DeviceRole[];
  enrolledAt: number;
  /** deviceId of the approver, or a bootstrap marker like "cli-bootstrap". */
  approvedBy: string;
}

export interface TrustStore {
  get(deviceId: string): TrustedDevice | undefined;
  has(deviceId: string): boolean;
  add(deviceId: string, device: TrustedDevice): void;
  remove(deviceId: string): boolean;
  list(): Array<{ deviceId: string } & TrustedDevice>;
}

interface FileShape {
  version: 1;
  devices: Record<string, TrustedDevice>;
}

export class FileTrustStore implements TrustStore {
  private readonly devices = new Map<string, TrustedDevice>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as FileShape;
      for (const [id, device] of Object.entries(raw.devices ?? {})) this.devices.set(id, device);
    }
  }

  get(deviceId: string): TrustedDevice | undefined {
    return this.devices.get(deviceId);
  }
  has(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }
  add(deviceId: string, device: TrustedDevice): void {
    this.devices.set(deviceId, device);
    this.persist();
  }
  remove(deviceId: string): boolean {
    const had = this.devices.delete(deviceId);
    if (had) this.persist();
    return had;
  }
  list(): Array<{ deviceId: string } & TrustedDevice> {
    return [...this.devices.entries()].map(([deviceId, device]) => ({ deviceId, ...device }));
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const shape: FileShape = { version: 1, devices: Object.fromEntries(this.devices) };
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
