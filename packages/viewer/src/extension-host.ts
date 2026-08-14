/**
 * Extension host — runs each enabled extension in its own dedicated Web
 * Worker and serves its capability-gated RPC.
 *
 * Why a Worker: the page holds the device identity (localStorage) and, in the
 * desktop shell, the Tauri IPC bridge. A worker has neither — no DOM, no
 * page storage, no shell bridge — so an imported extension's blast radius is
 * exactly the API below, gated on the capabilities the user accepted at
 * install. Everything a worker sends is validated structurally
 * (extensions.ts) before it's acted on; unknown or ungranted methods get an
 * explicit refusal, never a silent pass.
 *
 * The host knows nothing about HubClient or Workspace — main.ts injects a
 * small delegate, keeping this file wiring-free and the boundaries flat.
 */
import {
  MAX_BUTTONS_PER_EXTENSION,
  MAX_RPC_TEXT,
  RPC_CAPS,
  parseWorkerMsg,
  widgetId,
  type Extension,
} from "./extensions.js";

/** What the host may do to the app — injected by main.ts. */
export interface HostDelegate {
  sessionList(): Array<{ sessionId: string; agentId: string; title: string; focused: boolean; visible: boolean }>;
  /** Send text to the focused session, exactly like typing (skills model). */
  typeInFocused(text: string): void;
  /** Surface a short message in the status line. */
  notify(message: string): void;
  registerButton(id: string, title: string, icon: string, activate: () => void): void;
  unregisterButton(id: string): void;
}

/**
 * Worker-side bootstrap, prepended to the extension's code. A fixed string —
 * NOTHING from the extension record is ever interpolated into the source, so
 * there is no injection surface; the code rides after it verbatim.
 */
const BOOTSTRAP = `"use strict";
const __pending = new Map();
let __nextRpc = 1;
const __buttons = new Map();
const __outputHandlers = [];
function __rpc(method, params) {
  return new Promise((resolve, reject) => {
    const rpcId = __nextRpc++;
    __pending.set(rpcId, { resolve, reject });
    postMessage({ kind: "rpc", rpcId, method, params: params || {} });
  });
}
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.kind === "rpc.result" || m.kind === "rpc.error") {
    const p = __pending.get(m.rpcId);
    if (!p) return;
    __pending.delete(m.rpcId);
    if (m.kind === "rpc.result") p.resolve(m.value);
    else p.reject(new Error(String(m.error)));
  } else if (m.kind === "ribbon.activate") {
    const fn = __buttons.get(m.id);
    if (fn) fn();
  } else if (m.kind === "session.output") {
    for (const h of __outputHandlers) h(m.sessionId, m.data);
  }
};
const glass = {
  ribbon: {
    add(btn) {
      __buttons.set(String(btn.id), typeof btn.onClick === "function" ? btn.onClick : () => {});
      postMessage({ kind: "ribbon.add", id: String(btn.id), title: String(btn.title), icon: String(btn.icon) });
    },
  },
  sessions: {
    list: () => __rpc("sessions.list"),
    type: (text) => __rpc("sessions.type", { text: String(text) }),
    onOutput(handler) {
      __outputHandlers.push(handler);
      return __rpc("sessions.watch");
    },
  },
  storage: {
    get: (key) => __rpc("storage.get", { key: String(key) }),
    set: (key, value) => __rpc("storage.set", { key: String(key), value }),
  },
  notify: (message) => __rpc("notify", { message: String(message) }),
  log: (message) => postMessage({ kind: "log", message: String(message) }),
};
`;

const STORAGE_PREFIX = "glass.ext.storage.";
/** Bound on one extension's serialized storage blob. */
const MAX_STORAGE = 65536;

interface Running {
  ext: Extension;
  /** Identity of the record we started, to detect changes on sync. */
  fingerprint: string;
  worker: Worker;
  /** Extension-local button id → registered widget id. */
  buttons: Map<string, string>;
  watching: boolean;
}

function fingerprint(ext: Extension): string {
  return JSON.stringify([ext.id, ext.version, ext.capabilities, ext.code, ext.icon, ext.name]);
}

export class ExtensionHost {
  private readonly running = new Map<string, Running>();

  constructor(private readonly delegate: HostDelegate) {}

  /** Bring the running set in line with `exts`: stop what's gone, disabled,
   *  or changed; start what's newly enabled. Untouched extensions keep their
   *  worker (and its state). */
  sync(exts: Extension[]): void {
    const want = new Map(exts.filter((e) => e.enabled).map((e) => [e.id, e]));
    for (const [id, run] of [...this.running]) {
      const next = want.get(id);
      if (!next || fingerprint(next) !== run.fingerprint) this.stop(id);
    }
    for (const ext of want.values()) {
      if (!this.running.has(ext.id)) this.start(ext);
    }
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  /** Fan session output out to workers that asked for it (and may read it). */
  emitOutput(sessionId: string, data: string): void {
    for (const run of this.running.values()) {
      if (run.watching) run.worker.postMessage({ kind: "session.output", sessionId, data });
    }
  }

  private start(ext: Extension): void {
    let worker: Worker;
    const url = URL.createObjectURL(
      // The extension code runs in its own function scope so its top-level
      // declarations can't collide with the bootstrap's.
      new Blob([BOOTSTRAP, "\n;(function () {\n", ext.code, "\n})();\n"], { type: "text/javascript" }),
    );
    try {
      worker = new Worker(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      this.delegate.notify(`extension "${ext.name}" failed to start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    URL.revokeObjectURL(url); // the worker holds its own reference to the source
    const run: Running = { ext, fingerprint: fingerprint(ext), worker, buttons: new Map(), watching: false };
    this.running.set(ext.id, run);
    worker.onerror = (e) => {
      this.delegate.notify(`extension "${ext.name}": ${e.message || "error"}`);
    };
    worker.onmessage = (e) => this.onWorkerMessage(run, e.data);
  }

  private stop(id: string): void {
    const run = this.running.get(id);
    if (!run) return;
    run.worker.terminate();
    for (const wid of run.buttons.values()) this.delegate.unregisterButton(wid);
    this.running.delete(id);
  }

  private onWorkerMessage(run: Running, raw: unknown): void {
    const msg = parseWorkerMsg(raw);
    if (!msg) return; // malformed — drop, never act
    switch (msg.kind) {
      case "log":
        console.log(`[ext:${run.ext.id}]`, msg.message);
        return;
      case "ribbon.add": {
        const wid = widgetId(run.ext.id, msg.id);
        if (!run.buttons.has(msg.id) && run.buttons.size >= MAX_BUTTONS_PER_EXTENSION) return;
        run.buttons.set(msg.id, wid);
        this.delegate.registerButton(wid, `${msg.title} (${run.ext.name})`, msg.icon, () => {
          run.worker.postMessage({ kind: "ribbon.activate", id: msg.id });
        });
        return;
      }
      case "rpc": {
        const reply = (value: unknown): void => run.worker.postMessage({ kind: "rpc.result", rpcId: msg.rpcId, value });
        const refuse = (error: string): void => run.worker.postMessage({ kind: "rpc.error", rpcId: msg.rpcId, error });
        const cap = RPC_CAPS[msg.method];
        if (!cap) return refuse(`unknown method "${msg.method}"`);
        if (!run.ext.capabilities.includes(cap)) return refuse(`capability "${cap}" not granted`);
        try {
          this.dispatch(run, msg.method, msg.params, reply, refuse);
        } catch (err) {
          refuse(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }
  }

  private dispatch(
    run: Running,
    method: string,
    params: Record<string, unknown>,
    reply: (value: unknown) => void,
    refuse: (error: string) => void,
  ): void {
    switch (method) {
      case "sessions.list":
        return reply(this.delegate.sessionList());
      case "sessions.watch":
        run.watching = true;
        return reply(true);
      case "sessions.type": {
        const text = params["text"];
        if (typeof text !== "string" || text.length === 0 || text.length > MAX_RPC_TEXT) return refuse("text must be a non-empty string");
        this.delegate.typeInFocused(text);
        return reply(true);
      }
      case "notify": {
        const message = params["message"];
        if (typeof message !== "string" || message.length === 0) return refuse("message must be a non-empty string");
        this.delegate.notify(`${run.ext.name}: ${message.slice(0, 256)}`);
        return reply(true);
      }
      case "storage.get": {
        const key = this.storageKey(params);
        if (!key) return refuse("key must be a string (≤128 chars)");
        return reply(this.loadStore(run.ext.id)[key]);
      }
      case "storage.set": {
        const key = this.storageKey(params);
        if (!key) return refuse("key must be a string (≤128 chars)");
        const store = this.loadStore(run.ext.id);
        if (params["value"] === undefined) delete store[key];
        else store[key] = params["value"];
        let blob: string;
        try {
          blob = JSON.stringify(store);
        } catch {
          return refuse("value must be JSON-serializable");
        }
        if (blob.length > MAX_STORAGE) return refuse("storage full");
        try {
          localStorage.setItem(STORAGE_PREFIX + run.ext.id, blob);
        } catch {
          return refuse("storage unavailable");
        }
        return reply(true);
      }
      default:
        return refuse(`unknown method "${method}"`);
    }
  }

  private storageKey(params: Record<string, unknown>): string | null {
    const key = params["key"];
    return typeof key === "string" && key.length > 0 && key.length <= 128 ? key : null;
  }

  private loadStore(extId: string): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + extId);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

/** Drop a deleted extension's persisted storage (called by the manager UI). */
export function clearExtensionStorage(extId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + extId);
  } catch {
    /* private mode — nothing to clear */
  }
}
