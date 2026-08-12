/**
 * Native (Tauri) bridge for the shared Viewer frontend (plan §2, §7).
 *
 * The same viewer bundle runs inside the Glass desktop shell and as a PWA;
 * this module is the only place that difference surfaces. Inside the shell,
 * Tauri injects `window.__TAURI__` (withGlobalTauri) and these helpers call
 * the Rust commands in packages/desktop/src-tauri/src/main.rs. In a plain
 * browser they throw a clear "desktop only" error instead.
 *
 * No DOM access here — pure feature detection + invoke.
 */

/** Mirrors BrowserKind in packages/agent/src/proxy/browser-profile.ts. */
export type BrowserKind = "chrome" | "chromium" | "brave" | "edge";

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

interface TauriGlobal {
  core?: { invoke?: TauriInvoke };
}

/** The Tauri v2 global-API invoke, if this bundle is running in the shell. */
function tauriInvoke(): TauriInvoke | undefined {
  const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoke = tauri?.core?.invoke;
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
