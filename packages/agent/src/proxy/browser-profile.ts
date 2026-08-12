/**
 * Managed proxied-browser profiles (plan §7, Phase 6). Build the launch command
 * for a Chromium-based browser pinned to a SOCKS endpoint and an isolated
 * profile dir, so proxied browsing stays fully separate from normal browsing:
 * distinct profile, distinct cookie jar, distinct window (plan §7). No pixel
 * streaming — this launches the device's real local browser.
 *
 * Pure arg construction (no launch here) so it is trivially testable and the
 * desktop shell / CLI can own the actual spawn.
 */
export type BrowserKind = "chrome" | "chromium" | "brave" | "edge";

const DEFAULT_BIN: Record<BrowserKind, string> = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};

export interface BrowserLaunchSpec {
  /** Browser to launch (or an explicit binary via `binary`). */
  browser?: BrowserKind;
  binary?: string;
  /** Local SOCKS5 endpoint the browser routes through (the proxied egress). */
  socksHost: string;
  socksPort: number;
  /** Dedicated profile dir — isolation from normal browsing (distinct cookie jar). */
  profileDir: string;
  /** Optional initial URL. */
  url?: string;
}

export interface BrowserLaunch {
  command: string;
  args: string[];
}

/**
 * Build a launch spec. SOCKS5 (not socks5h) is deliberate: Chromium sends
 * hostnames to the SOCKS proxy for resolution, so DNS also resolves at the exit
 * device — no local DNS leak. A per-profile --user-data-dir gives the isolation
 * the plan requires; loopback bypasses the proxy by default, so the browser's
 * local traffic never recurses through the exit.
 */
export function buildBrowserLaunch(spec: BrowserLaunchSpec): BrowserLaunch {
  if (spec.socksPort <= 0 || spec.socksPort > 65535) throw new Error(`invalid socksPort ${spec.socksPort}`);
  if (!spec.profileDir) throw new Error("profileDir is required for profile isolation");
  const command = spec.binary ?? DEFAULT_BIN[spec.browser ?? "chrome"];
  const args = [
    `--user-data-dir=${spec.profileDir}`,
    `--proxy-server=socks5://${spec.socksHost}:${spec.socksPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
  ];
  if (spec.url) args.push(spec.url);
  return { command, args };
}
