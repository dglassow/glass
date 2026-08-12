/**
 * Native (Tauri) bridge for the shared Viewer frontend (plan §2, §7).
 *
 * The same viewer bundle runs inside the Glass desktop shell and as a PWA;
 * this module is the only place that difference surfaces. Inside the shell,
 * Tauri injects `window.__TAURI__` (withGlobalTauri) and these helpers call
 * the Rust commands in packages/desktop/src-tauri/src/main.rs. In a plain
 * browser the desktop-only calls reject with a clear "desktop only" error,
 * so the viewer still runs there for remote/spoke use.
 *
 * No DOM access here — pure feature detection + invoke/listen.
 */

/** Mirrors BrowserKind in packages/agent/src/proxy/browser-profile.ts. */
export type BrowserKind = "chrome" | "chromium" | "brave" | "edge";

/** Backend roles glass-backend.mjs knows how to bring up. */
export type BackendRole = "standalone" | "hub" | "spoke";

export interface StartBackendOptions {
  /** App device identity (hub role: auto-trusted as the viewer). */
  deviceId?: string;
  devicePub?: string;
  /** Remote hub to join (spoke role). */
  hubUrl?: string;
  /** Pinned hub identity key (spoke role, optional). */
  hubKeyPin?: string;
}

/** The parsed GLASS_BACKEND_READY payload from deploy/glass-backend.mjs. */
export interface BackendInfo {
  role: string;
  hubUrl: string;
  hubKey?: string;
}

export interface BackendStatus {
  running: boolean;
  role?: string;
  hubUrl?: string;
}

export interface LaunchProxiedBrowserOptions {
  /** Browser to launch; the shell defaults to Chrome at its macOS path. */
  browser?: BrowserKind;
  /** Local SOCKS5 endpoint the browser routes through (the proxied egress). */
  socksHost: string;
  socksPort: number;
  /** Dedicated profile dir — isolation from normal browsing (distinct cookie jar). */
  profileDir: string;
  /** Optional initial URL. */
  url?: string;
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriListen = (
  event: string,
  handler: (event: unknown) => void,
) => Promise<() => void>;

interface TauriGlobal {
  core?: { invoke?: TauriInvoke };
  event?: { listen?: TauriListen };
}

function tauriGlobal(): TauriGlobal | undefined {
  return (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
}

/** The Tauri v2 global-API invoke, if this bundle is running in the shell. */
function tauriInvoke(): TauriInvoke | undefined {
  const invoke = tauriGlobal()?.core?.invoke;
  return typeof invoke === "function" ? invoke : undefined;
}

/** True when running inside the Glass desktop shell (Tauri), not a browser/PWA. */
export function isNative(): boolean {
  return tauriInvoke() !== undefined;
}

function requireInvoke(what: string): TauriInvoke {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error(
      `${what} is desktop only: not running inside the Glass desktop shell (window.__TAURI__ is missing)`,
    );
  }
  return invoke;
}

/** Tauri command rejections are plain strings; normalize to Error. */
function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === "string" ? e : JSON.stringify(e));
}

/**
 * Start (or restart — the shell kills any previous backend first) the local
 * backend for a role. Spawns `node <GLASS_HOME>/deploy/glass-backend.mjs
 * --role <role>` in the Rust shell and resolves with the parsed
 * GLASS_BACKEND_READY json; rejects with an Error on GLASS_BACKEND_ERROR,
 * spawn failure, or the ~20s readiness timeout.
 *
 * camelCase args here map to snake_case Rust params (Tauri convention):
 * deviceId -> device_id (VIEWER_ID), devicePub -> device_pub (VIEWER_PUB),
 * hubUrl -> hub_url (HUB_URL), hubPin -> hub_pin (HUB_PIN).
 */
export async function startBackend(
  role: BackendRole,
  opts: StartBackendOptions = {},
): Promise<BackendInfo> {
  const invoke = requireInvoke("startBackend");
  try {
    return (await invoke("start_backend", {
      role,
      deviceId: opts.deviceId,
      devicePub: opts.devicePub,
      hubUrl: opts.hubUrl,
      hubPin: opts.hubKeyPin,
    })) as BackendInfo;
  } catch (e) {
    throw asError(e);
  }
}

/** Stop the running local backend (SIGTERM; it reaps its own children). */
export async function stopBackend(): Promise<void> {
  const invoke = requireInvoke("stopBackend");
  try {
    await invoke("stop_backend");
  } catch (e) {
    throw asError(e);
  }
}

/**
 * Whether a local backend is running, and as what. In a plain browser this
 * resolves { running: false } rather than rejecting, so status displays work
 * everywhere.
 */
export async function backendStatus(): Promise<BackendStatus> {
  const invoke = tauriInvoke();
  if (!invoke) return { running: false };
  try {
    return (await invoke("backend_status")) as BackendStatus;
  } catch (e) {
    throw asError(e);
  }
}

/**
 * Subscribe to the shell's File > "Reconfigure…" menu item (Tauri event
 * "glass://reconfigure"): the viewer should re-run role setup. No-op outside
 * the shell — a plain browser has no native menu to listen to.
 */
export function onReconfigure(cb: () => void): void {
  const listen = tauriGlobal()?.event?.listen;
  if (typeof listen !== "function") return;
  void listen("glass://reconfigure", () => cb());
}

/**
 * Launch the local browser through a SOCKS proxy with an isolated profile
 * (plan §7, Phase 6: render locally, egress from the chosen device).
 * Rejects with the shell's error string on validation or spawn failure.
 */
export async function launchProxiedBrowser(opts: LaunchProxiedBrowserOptions): Promise<void> {
  const invoke = requireInvoke("launchProxiedBrowser");
  await invoke("launch_proxied_browser", {
    browser: opts.browser,
    socksHost: opts.socksHost,
    socksPort: opts.socksPort,
    profileDir: opts.profileDir,
    url: opts.url,
  });
}

/** The desktop shell's own version (its Cargo package version). */
export async function appVersion(): Promise<string> {
  const invoke = requireInvoke("appVersion");
  return (await invoke("app_version")) as string;
}
