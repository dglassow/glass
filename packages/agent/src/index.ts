/**
 * Agent — the worker tier: session routing (plan §3).
 *
 * The frequently-updated, blue/green-swapped process. It routes sessions
 * between Viewers and providers, connecting to the session daemon over a Unix
 * socket to relay PTY I/O. Sessions never live here — that is the load-bearing
 * decision of the whole design.
 *
 * Boundary: depends on @glass/protocol only. The agent must never import the
 * hub or the viewer; if they need to share something it goes in the protocol.
 * It reaches the session daemon over a socket, not by import.
 *
 * The executable entrypoint is `main.ts`; `client.ts` is the throwaway CLI.
 */
import { PROTOCOL_VERSION } from "@glass/protocol";

export const TIER = "worker" as const;
export const ROLE = "agent" as const;
export const SPEAKS_PROTOCOL = PROTOCOL_VERSION;

export { startAgent, type AgentOptions, type RunningAgent } from "./relay.js";
export { startHubLink, type HubLinkOptions, type RunningHubLink } from "./hub-link.js";
export { createSocks5Server, buildBrowserLaunch, type Socks5Options, type BrowserLaunchSpec } from "./proxy/index.js";
