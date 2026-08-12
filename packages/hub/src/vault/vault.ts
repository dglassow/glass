/**
 * The vault (plan §9). Envelope encryption over node:sqlite, with a per-device
 * allow-list, taxonomy tags, two secret classes, and a hash-chained audit log.
 *
 * Machine retrieval (getForDevice) is the load-bearing authorization path: it
 * checks existence, class, unlock state, and the allow-list — deny-by-default —
 * BEFORE any decrypt, and audits every outcome including denials. Personal
 * secrets never release to a machine (biometric_required — the deferred seam).
 *
 * All SQL is confined here behind the Vault API so the driver (node:sqlite,
 * experimental) can be swapped for better-sqlite3 in one file if ever needed.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  deriveSlotKek,
  gcmEncrypt,
  gcmDecrypt,
  slotAad,
  wrapAad,
  valueAad,
  newMasterKey,
  newDataKey,
  checkRecoveryStrength,
  SCRYPT_PARAMS,
  type Gcm,
} from "./crypto.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS key_slots (slot TEXT PRIMARY KEY, salt BLOB, kdf_params TEXT, wrapped_mk BLOB, iv BLOB, tag BLOB);
CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, name TEXT UNIQUE, class TEXT NOT NULL, version INTEGER NOT NULL,
  ct BLOB, iv BLOB, tag BLOB, wrapped_dek BLOB, dek_iv BLOB, dek_tag BLOB, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS secret_devices (secret_id TEXT, device_id TEXT, PRIMARY KEY (secret_id, device_id));
CREATE TABLE IF NOT EXISTS secret_tags (secret_id TEXT, tag TEXT, PRIMARY KEY (secret_id, tag));
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, event TEXT, secret_id TEXT,
  secret_name TEXT, device_id TEXT, ok INTEGER, detail TEXT, prev_hash TEXT, hash TEXT);
`;

export type SecretClass = "workflow" | "personal";
export type GetResult = { ok: true; value: Buffer } | { ok: false; code: "secret_unknown" | "secret_denied" | "vault_locked" | "biometric_required" };

interface SecretRow {
  id: string;
  name: string;
  class: string;
  version: number;
  ct: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  wrapped_dek: Uint8Array;
  dek_iv: Uint8Array;
  dek_tag: Uint8Array;
}

const buf = (u: Uint8Array): Buffer => Buffer.from(u);

export class Vault {
  private mk: Buffer | null = null;
  private constructor(
    private readonly db: DatabaseSync,
    readonly vaultId: string,
  ) {}

  static init(dbPath: string, passphrase: string, recoveryKey: string): Vault {
    const weak = checkRecoveryStrength(recoveryKey, passphrase);
    if (weak) throw new VaultError(weak, "weak_recovery_key");
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    if (db.prepare("SELECT v FROM vault_meta WHERE k = 'vaultId'").get()) {
      db.close();
      throw new VaultError("vault already initialized", "already_initialized");
    }
    const vaultId = randomUUID();
    db.prepare("INSERT INTO vault_meta (k, v) VALUES ('vaultId', ?)").run(vaultId);
    const vault = new Vault(db, vaultId);
    const mk = newMasterKey();
    vault.writeKeySlot("passphrase", passphrase, mk);
    vault.writeKeySlot("recovery", recoveryKey, mk);
    vault.mk = mk;
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* best effort */
    }
    vault.audit("vault.init", { ok: true });
    return vault;
  }

  static open(dbPath: string): Vault {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const meta = db.prepare("SELECT v FROM vault_meta WHERE k = 'vaultId'").get() as { v: string } | undefined;
    if (!meta) {
      db.close();
      throw new VaultError("vault not initialized", "not_initialized");
    }
    return new Vault(db, meta.v);
  }

  private writeKeySlot(slot: string, input: string, mk: Buffer): void {
    const salt = Buffer.from(randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), "hex");
    const kek = deriveSlotKek(input, salt, slot);
    const wrapped = gcmEncrypt(kek, mk, slotAad(this.vaultId, slot));
    this.db
      .prepare("INSERT OR REPLACE INTO key_slots (slot, salt, kdf_params, wrapped_mk, iv, tag) VALUES (?, ?, ?, ?, ?, ?)")
      .run(slot, salt, JSON.stringify(SCRYPT_PARAMS), wrapped.ct, wrapped.iv, wrapped.tag);
  }

  private tryUnwrap(slot: string, input: string): Buffer | null {
    const row = this.db.prepare("SELECT salt, wrapped_mk, iv, tag FROM key_slots WHERE slot = ?").get(slot) as
      | { salt: Uint8Array; wrapped_mk: Uint8Array; iv: Uint8Array; tag: Uint8Array }
      | undefined;
    if (!row) return null;
    try {
      const kek = deriveSlotKek(input, buf(row.salt), slot);
      return gcmDecrypt(kek, { iv: buf(row.iv), ct: buf(row.wrapped_mk), tag: buf(row.tag) }, slotAad(this.vaultId, slot));
    } catch {
      return null;
    }
  }

  unlock(input: string, slot: "passphrase" | "recovery" = "passphrase"): boolean {
    const mk = this.tryUnwrap(slot, input);
    this.audit("vault.unlock", { ok: !!mk, detail: slot });
    if (!mk) return false;
    this.mk = mk;
    return true;
  }

  /** Verify a recovery key unwraps the master key without changing unlock state. */
  checkRecovery(recoveryKey: string): boolean {
    return this.tryUnwrap("recovery", recoveryKey) !== null;
  }

  get isUnlocked(): boolean {
    return this.mk !== null;
  }
  private requireUnlocked(): Buffer {
    if (!this.mk) throw new VaultError("vault is locked", "vault_locked");
    return this.mk;
  }

  createSecret(name: string, value: Buffer, cls: SecretClass, tags: string[] = []): void {
    const mk = this.requireUnlocked();
    if (this.byName(name)) throw new VaultError(`secret ${name} already exists`, "exists");
    const id = randomUUID();
    const now = Date.now();
    this.encryptInto(id, name, cls, 1, value, mk, now, now);
    for (const t of tags) this.db.prepare("INSERT OR IGNORE INTO secret_tags (secret_id, tag) VALUES (?, ?)").run(id, t);
    this.audit("secret.create", { ok: true, secretId: id, name });
  }

  updateSecret(name: string, value: Buffer): void {
    const mk = this.requireUnlocked();
    const row = this.byName(name);
    if (!row) throw new VaultError(`secret ${name} not found`, "secret_unknown");
    this.encryptInto(row.id, name, row.class as SecretClass, row.version + 1, value, mk, 0, Date.now(), true);
    this.audit("secret.update", { ok: true, secretId: row.id, name });
  }

  private encryptInto(id: string, name: string, cls: SecretClass, version: number, value: Buffer, mk: Buffer, createdAt: number, updatedAt: number, update = false): void {
    const dek = newDataKey();
    const val = gcmEncrypt(dek, value, valueAad(this.vaultId, id, version, cls));
    const wrap = gcmEncrypt(mk, dek, wrapAad(this.vaultId, id, version));
    dek.fill(0);
    if (update) {
      this.db
        .prepare("UPDATE secrets SET version=?, ct=?, iv=?, tag=?, wrapped_dek=?, dek_iv=?, dek_tag=?, updated_at=? WHERE id=?")
        .run(version, val.ct, val.iv, val.tag, wrap.ct, wrap.iv, wrap.tag, updatedAt, id);
    } else {
      this.db
        .prepare("INSERT INTO secrets (id, name, class, version, ct, iv, tag, wrapped_dek, dek_iv, dek_tag, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, name, cls, version, val.ct, val.iv, val.tag, wrap.ct, wrap.iv, wrap.tag, createdAt, updatedAt);
    }
  }

  private decrypt(row: SecretRow, mk: Buffer): Buffer {
    const dek = gcmDecrypt(mk, { iv: buf(row.dek_iv), ct: buf(row.wrapped_dek), tag: buf(row.dek_tag) }, wrapAad(this.vaultId, row.id, row.version));
    try {
      return gcmDecrypt(dek, { iv: buf(row.iv), ct: buf(row.ct), tag: buf(row.tag) }, valueAad(this.vaultId, row.id, row.version, row.class));
    } finally {
      dek.fill(0);
    }
  }

  /** Owner CLI reveal (passphrase-gated by unlock). Throws VaultError("tamper") on integrity failure. */
  reveal(name: string): Buffer {
    const mk = this.requireUnlocked();
    const row = this.byName(name);
    if (!row) throw new VaultError(`secret ${name} not found`, "secret_unknown");
    let value: Buffer;
    try {
      value = this.decrypt(row, mk);
    } catch {
      this.audit("tamper.detected", { ok: false, secretId: row.id, name });
      throw new VaultError("integrity check failed (tamper)", "tamper");
    }
    this.audit("secret.reveal", { ok: true, secretId: row.id, name, detail: "seam:no-biometric" });
    return value;
  }

  /** Machine retrieval — the authorization choke point. */
  getForDevice(deviceId: string, name: string): GetResult {
    if (!this.mk) {
      this.audit("secret.get", { ok: false, name, deviceId, detail: "vault_locked" });
      return { ok: false, code: "vault_locked" };
    }
    const row = this.byName(name);
    if (!row) {
      this.audit("secret.get", { ok: false, name, deviceId, detail: "secret_unknown" });
      return { ok: false, code: "secret_unknown" };
    }
    if (row.class === "personal") {
      this.audit("secret.get", { ok: false, secretId: row.id, name, deviceId, detail: "biometric_required" });
      return { ok: false, code: "biometric_required" };
    }
    const allowed = this.db.prepare("SELECT 1 FROM secret_devices WHERE secret_id=? AND device_id=?").get(row.id, deviceId);
    if (!allowed) {
      this.audit("secret.get", { ok: false, secretId: row.id, name, deviceId, detail: "secret_denied" });
      return { ok: false, code: "secret_denied" };
    }
    let value: Buffer;
    try {
      value = this.decrypt(row, this.mk);
    } catch {
      this.audit("tamper.detected", { ok: false, secretId: row.id, name, deviceId });
      return { ok: false, code: "secret_unknown" };
    }
    this.audit("secret.get", { ok: true, secretId: row.id, name, deviceId });
    return { ok: true, value };
  }

  removeSecret(name: string): void {
    const row = this.byName(name);
    if (!row) throw new VaultError(`secret ${name} not found`, "secret_unknown");
    this.db.prepare("DELETE FROM secret_devices WHERE secret_id=?").run(row.id);
    this.db.prepare("DELETE FROM secret_tags WHERE secret_id=?").run(row.id);
    this.db.prepare("DELETE FROM secrets WHERE id=?").run(row.id);
    this.audit("secret.delete", { ok: true, secretId: row.id, name });
  }

  allow(name: string, deviceId: string): void {
    const row = this.mustGet(name);
    this.db.prepare("INSERT OR IGNORE INTO secret_devices (secret_id, device_id) VALUES (?, ?)").run(row.id, deviceId);
    this.audit("allowlist.add", { ok: true, secretId: row.id, name, deviceId });
  }
  deny(name: string, deviceId: string): void {
    const row = this.mustGet(name);
    this.db.prepare("DELETE FROM secret_devices WHERE secret_id=? AND device_id=?").run(row.id, deviceId);
    this.audit("allowlist.remove", { ok: true, secretId: row.id, name, deviceId });
  }
  tag(name: string, t: string): void {
    const row = this.mustGet(name);
    this.db.prepare("INSERT OR IGNORE INTO secret_tags (secret_id, tag) VALUES (?, ?)").run(row.id, t);
    this.audit("tag.add", { ok: true, secretId: row.id, name, detail: t });
  }
  untag(name: string, t: string): void {
    const row = this.mustGet(name);
    this.db.prepare("DELETE FROM secret_tags WHERE secret_id=? AND tag=?").run(row.id, t);
    this.audit("tag.remove", { ok: true, secretId: row.id, name, detail: t });
  }

  list(): Array<{ name: string; class: string; version: number; tags: string[]; devices: string[] }> {
    const rows = this.db.prepare("SELECT id, name, class, version FROM secrets ORDER BY name").all() as Array<{ id: string; name: string; class: string; version: number }>;
    return rows.map((r) => ({
      name: r.name,
      class: r.class,
      version: r.version,
      tags: (this.db.prepare("SELECT tag FROM secret_tags WHERE secret_id=? ORDER BY tag").all(r.id) as Array<{ tag: string }>).map((t) => t.tag),
      devices: (this.db.prepare("SELECT device_id FROM secret_devices WHERE secret_id=? ORDER BY device_id").all(r.id) as Array<{ device_id: string }>).map((d) => d.device_id),
    }));
  }

  auditRows(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM audit_log ORDER BY id").all() as Array<Record<string, unknown>>;
  }

  close(): void {
    if (this.mk) this.mk.fill(0);
    this.mk = null;
    this.db.close();
  }

  private byName(name: string): SecretRow | undefined {
    return this.db.prepare("SELECT * FROM secrets WHERE name=?").get(name) as SecretRow | undefined;
  }
  private mustGet(name: string): SecretRow {
    const row = this.byName(name);
    if (!row) throw new VaultError(`secret ${name} not found`, "secret_unknown");
    return row;
  }

  private audit(event: string, o: { ok: boolean; secretId?: string; name?: string; deviceId?: string; detail?: string }): void {
    const prev = this.db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined;
    const prevHash = prev?.hash ?? "";
    const ts = Date.now();
    const hash = createHash("sha256")
      .update([prevHash, ts, event, o.secretId ?? "", o.name ?? "", o.deviceId ?? "", o.ok ? 1 : 0, o.detail ?? ""].join("\x1f"))
      .digest("hex");
    this.db
      .prepare("INSERT INTO audit_log (ts, event, secret_id, secret_name, device_id, ok, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(ts, event, o.secretId ?? null, o.name ?? null, o.deviceId ?? null, o.ok ? 1 : 0, o.detail ?? null, prevHash, hash);
  }
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
