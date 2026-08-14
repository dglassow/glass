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

import { emptyUpdateState, reconcile, shouldInstall, markAttempt, type UpdateState } from "./update-policy.js";

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
  /** The local shell-agent's identity (all roles). Spokes also use it to
   *  enroll the agent as a companion under one approval; every role uses it to
   *  address "browse via device" forwarder requests at this Mac's agent. */
  agentId?: string;
  agentPub?: string;
  agentName?: string;
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
  profileDir?: string;
  /**
   * Alternative to profileDir when the caller can't build absolute paths (the
   * webview has no $HOME): the shell derives
   * ~/.glass/desktop/browser-profiles/<sanitized name>. Exactly one of
   * profileDir / profileName must be set.
   */
  profileName?: string;
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

/**
 * Auto-update (native only). On launch, ask the hub for a newer signed build; if
 * there is one, download + install it and relaunch into the new version — the
 * device never needs a manual reinstall. The artifact is verified against the
 * app's embedded updater public key (minisign) AND is Developer-ID notarized, so
 * a compromised update server cannot push an unsigned/altered build. Fails open
 * (stays on the current version) if the hub is unreachable or there's no update.
 */
const UPDATE_STATE_KEY = "glass.update.state";
function loadUpdateState(): UpdateState {
  try {
    const raw = localStorage.getItem(UPDATE_STATE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as UpdateState;
      if (s && typeof s.floor === "string" && Array.isArray(s.blocked)) return s;
    }
  } catch {
    /* corrupt/missing — start clean */
  }
  return emptyUpdateState();
}
function saveUpdateState(s: UpdateState): void {
  try {
    localStorage.setItem(UPDATE_STATE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — anti-rollback degrades to Tauri's > current gate */
  }
}

export async function checkForUpdates(
  onStatus?: (msg: string) => void,
  opts?: { attempts?: number; delayMs?: number; onError?: (msg: string) => void },
): Promise<boolean> {
  if (!isNative()) return false;
  const attempts = Math.max(1, opts?.attempts ?? 1);
  const delayMs = opts?.delayMs ?? 2000;

  // Read the running version up front — it's the anti-rollback anchor. Guard it:
  // if the IPC ever failed here (outside the retry loop's try), the whole check
  // would reject uncaught. Fail open instead (stay on the current version).
  let current: string;
  try {
    current = await appVersion();
  } catch (err) {
    console.error("glass: could not read app version; skipping update check:", err);
    opts?.onError?.(`Update check unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  // Reconcile persisted state against the version we ACTUALLY booted: raise the
  // anti-rollback floor and poison any prior target that didn't advance (a lying
  // manifest / brick loop). This is what makes a compromised update origin unable
  // to force a downgrade or an infinite reinstall. Done ONCE, before any retry.
  const state = reconcile(loadUpdateState(), current);
  saveUpdateState(state);

  // The hub updates itself through its OWN relay tunnel, which only finishes
  // dialing the relay a beat after the backend starts — so the first check() can
  // hit a not-yet-open tunnel and throw. Retry a few times (opts.attempts) so we
  // catch the tunnel as it comes up. A reachable "no newer version" is a definite
  // answer and returns immediately; only a thrown (unreachable) check retries.
  for (let i = 0; i < attempts; i++) {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return false;
      if (!shouldInstall(state, current, update.version)) {
        console.error(`glass: refusing update ${update.version} (anti-rollback/poisoned/halted; running ${current}, floor ${state.floor})`);
        opts?.onError?.(`Update ${update.version} was blocked by the anti-rollback safeguard.`);
        return false;
      }
      onStatus?.(`Updating Glass to ${update.version}…`);
      // Download+verify (artifact minisign) FIRST. Only record the attempt once the
      // install actually took — a transient download failure must not poison a legit
      // version. If the next boot isn't this version, reconcile() poisons it.
      await update.downloadAndInstall();
      saveUpdateState(markAttempt(state, update.version));
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch(); // does not return
      return true;
    } catch (err) {
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      console.error("glass: update check failed (staying on current version):", err);
      opts?.onError?.(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  return false;
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
 * Subscribe to the shell's "Terminal Settings…" menu item (Cmd+, — Tauri
 * event "glass://settings"): the viewer should open its Terminal Settings
 * panel. No-op outside the shell — a plain browser has no native menu.
 */
export function onSettings(cb: () => void): void {
  const listen = tauriGlobal()?.event?.listen;
  if (typeof listen !== "function") return;
  void listen("glass://settings", () => cb());
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
    profileName: opts.profileName,
    url: opts.url,
  });
}

/** The desktop shell's own version (its Cargo package version). */
export async function appVersion(): Promise<string> {
  const invoke = requireInvoke("appVersion");
  return (await invoke("app_version")) as string;
}
