/**
 * Extensions — user-authored/imported add-ons for the viewer, VS Code-style
 * but adapted to Glass's trust posture.
 *
 * TRUST MODEL. Installing an extension is choosing to run its code, so the
 * install step is the consent step: the import dialog shows exactly the
 * capabilities the manifest declares, and unknown capability names REFUSE to
 * import (fail closed — a newer format must never under-report what it can
 * do). The code itself runs in a dedicated Web Worker, never in the page: no
 * DOM, no viewer localStorage (where the device key lives), no Tauri IPC.
 * Its only bridge to Glass is a postMessage RPC, and every RPC method is
 * gated on the granted capabilities — deny by default, unknown methods
 * refused. Ribbon buttons are the one capability-free surface: an inert
 * button whose click is delivered back to the worker.
 *
 * This module is the pure model (update-policy pattern): import parsing,
 * persisted-state parsing, the capability catalog, and validation of
 * messages ARRIVING FROM a worker — all untrusted input, all bounded.
 * Persistence, Workers, and DOM live in extension-host.ts / extensions-ui.ts.
 */

/** Capability catalog — the human strings are what the consent dialog shows. */
export const CAPABILITIES = {
  "sessions.read": "see the session list and read terminal output",
  "sessions.write": "type into the focused session (like the keyboard)",
  storage: "keep its own data on this device",
  notify: "show messages in the status line",
} as const;

export type Capability = keyof typeof CAPABILITIES;

export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CAPABILITIES, v);
}

/** RPC method → capability it requires. Methods not listed here don't exist. */
export const RPC_CAPS: Record<string, Capability> = {
  "sessions.list": "sessions.read",
  "sessions.watch": "sessions.read",
  "sessions.type": "sessions.write",
  "storage.get": "storage",
  "storage.set": "storage",
  notify: "notify",
};

export interface Extension {
  /** Author-chosen identity; also namespaces widget ids and storage keys. */
  id: string;
  name: string;
  version: string;
  /** Short glyph for the manager list (ribbon buttons carry their own). */
  icon: string;
  description: string;
  /** Granted at install; the host's RPC gate checks against this list. */
  capabilities: Capability[];
  /** The worker module body. Stored verbatim; never interpolated. */
  code: string;
  /** Local state (not part of the imported file): run it at app start? */
  enabled: boolean;
}

export const MAX_EXTENSIONS = 32;
export const MAX_CODE = 131072;
export const MAX_BUTTONS_PER_EXTENSION = 8;
/** Bound for a sessions.type payload and for storage values. */
export const MAX_RPC_TEXT = 65536;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ImportResult = { ok: true; ext: Extension } | { ok: false; error: string };

/** Parse a pasted/opened extension file. Every failure is a refusal with a
 *  reason — nothing is silently coerced, because what we accept here is what
 *  the user consents to. */
export function parseImport(text: string): ImportResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, error: "not an extension file" };
  const { glassExtension, id, name, version, icon, description, capabilities, code } = doc as Record<string, unknown>;
  if (glassExtension !== 1) return { ok: false, error: "missing or unsupported \"glassExtension\" format version (expected 1)" };
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return { ok: false, error: "\"id\" must be 1–64 chars of a-z 0-9 . _ - (starting alphanumeric)" };
  }
  if (typeof name !== "string" || !name.trim() || name.length > 64) return { ok: false, error: "\"name\" must be a non-empty string (≤64 chars)" };
  if (typeof version !== "string" || !version.trim() || version.length > 32) return { ok: false, error: "\"version\" must be a non-empty string (≤32 chars)" };
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "\"code\" must be a non-empty string of JavaScript" };
  if (code.length > MAX_CODE) return { ok: false, error: `"code" too large (max ${MAX_CODE} chars)` };
  const caps: Capability[] = [];
  if (capabilities !== undefined) {
    if (!Array.isArray(capabilities)) return { ok: false, error: "\"capabilities\" must be an array" };
    for (const c of capabilities) {
      // Fail closed: an unknown capability means a format we don't fully
      // understand, and the consent dialog would under-report it.
      if (!isCapability(c)) return { ok: false, error: `unknown capability ${JSON.stringify(c)} — this Glass version can't grant it` };
      if (!caps.includes(c)) caps.push(c);
    }
  }
  return {
    ok: true,
    ext: {
      id,
      name: name.trim(),
      version: version.trim(),
      icon: (typeof icon === "string" && icon.trim() ? icon.trim() : "⧉").slice(0, 8),
      description: (typeof description === "string" ? description : "").slice(0, 512),
      capabilities: caps,
      code,
      enabled: true,
    },
  };
}

/** Parse the persisted collection (untrusted: localStorage survives app
 *  swaps). Defensive like parseSkills: junk degrades to bounded, well-formed
 *  entries — except capabilities, where an unknown name drops the WHOLE entry
 *  (fail closed: we can't tell what was consented to). */
export function parseExtensions(raw: string | null): Extension[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: Extension[] = [];
    for (const e of arr) {
      if (typeof e !== "object" || e === null) continue;
      const { id, name, version, icon, description, capabilities, code, enabled } = e as Record<string, unknown>;
      if (typeof id !== "string" || !ID_RE.test(id) || seen.has(id)) continue;
      if (typeof code !== "string" || code.length === 0) continue;
      if (!Array.isArray(capabilities) || !capabilities.every(isCapability)) continue;
      seen.add(id);
      out.push({
        id,
        name: (typeof name === "string" && name.trim() ? name : "unnamed").slice(0, 64),
        version: (typeof version === "string" && version.trim() ? version : "0").slice(0, 32),
        icon: (typeof icon === "string" && icon.trim() ? icon : "⧉").slice(0, 8),
        description: (typeof description === "string" ? description : "").slice(0, 512),
        capabilities: [...new Set(capabilities)],
        code: code.slice(0, MAX_CODE),
        enabled: enabled !== false,
      });
      if (out.length >= MAX_EXTENSIONS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Upsert by id (append when new), enforcing the collection bound. */
export function upsertExtension(exts: Extension[], ext: Extension): Extension[] {
  const i = exts.findIndex((e) => e.id === ext.id);
  if (i >= 0) return [...exts.slice(0, i), ext, ...exts.slice(i + 1)];
  if (exts.length >= MAX_EXTENSIONS) return exts;
  return [...exts, ext];
}

export function deleteExtension(exts: Extension[], id: string): Extension[] {
  return exts.filter((e) => e.id !== id);
}

export function setEnabled(exts: Extension[], id: string, enabled: boolean): Extension[] {
  return exts.map((e) => (e.id === id ? { ...e, enabled } : e));
}

/** Ribbon widget id for an extension button — namespaced so extensions can't
 *  collide with (or impersonate) skills or each other, and stable so the
 *  user's pins survive restarts. */
export function widgetId(extId: string, buttonId: string): string {
  return `ext:${extId}:${buttonId}`;
}

// ---------------------------------------------------------------------------
// Messages arriving FROM a worker — attacker-shaped input by definition
// (the worker runs the imported code). Structural validation with bounds;
// anything else is null and the host ignores it.

export type WorkerMsg =
  | { kind: "ribbon.add"; id: string; title: string; icon: string }
  | { kind: "rpc"; rpcId: number; method: string; params: Record<string, unknown> }
  | { kind: "log"; message: string };

function boundedString(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

export function parseWorkerMsg(raw: unknown): WorkerMsg | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m["kind"]) {
    case "ribbon.add": {
      const id = boundedString(m["id"], 32);
      const title = boundedString(m["title"], 64);
      const icon = boundedString(m["icon"], 8);
      // The button id feeds widgetId(); hold it to the same safe charset as
      // extension ids so pinned-widget ids stay parseable and log-safe.
      if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || !title || !icon) return null;
      return { kind: "ribbon.add", id, title, icon };
    }
    case "rpc": {
      const rpcId = m["rpcId"];
      const method = boundedString(m["method"], 64);
      if (typeof rpcId !== "number" || !Number.isSafeInteger(rpcId) || !method) return null;
      const params = typeof m["params"] === "object" && m["params"] !== null && !Array.isArray(m["params"]) ? (m["params"] as Record<string, unknown>) : {};
      return { kind: "rpc", rpcId, method, params };
    }
    case "log": {
      const message = boundedString(m["message"], 4096);
      if (!message) return null;
      return { kind: "log", message };
    }
    default:
      return null;
  }
}
