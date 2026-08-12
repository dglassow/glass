/**
 * Desktop Viewer entry — session-list sidebar + tiling terminal panes over the
 * Hub (plan §6). This is the desktop capability tier; the PWA tier is chat-only
 * and lands in Phase 5.
 *
 * Instance config (which hub, what identity) is NOT baked into this public repo
 * — it comes from enrollment in Phase 2. For local development the hub URL is a
 * `?hub=` query param (or localStorage), and the device identity is generated
 * and remembered in localStorage.
 */
import { HubClient } from "./hub-client.js";
import { TerminalPane } from "./terminal-pane.js";
import type { DeviceRecord } from "@glass/protocol";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

function hubUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get("hub");
  if (fromQuery) localStorage.setItem("glass.hub", fromQuery);
  return localStorage.getItem("glass.hub") ?? "ws://127.0.0.1:8787";
}

function identity(): { id: string; name: string } {
  let id = localStorage.getItem("glass.deviceId");
  if (!id) {
    id = `viewer-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem("glass.deviceId", id);
  }
  return { id, name: localStorage.getItem("glass.deviceName") ?? "This device" };
}

function main(): void {
  const app = document.getElementById("app");
  if (!app) throw new Error("#app missing");

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  const status = document.createElement("div");
  status.className = "status";
  const deviceList = document.createElement("div");
  deviceList.className = "devices";
  sidebar.append(status, deviceList);

  const grid = document.createElement("main");
  grid.className = "grid";

  app.append(sidebar, grid);

  const panes = new Map<string, TerminalPane>();
  const me = identity();
  const client = new HubClient(hubUrl(), me.id, me.name, {
    onConnected: () => {
      status.textContent = `connected as ${me.id}`;
      status.dataset["state"] = "connected";
      void refreshDevices();
    },
    onDisconnected: () => {
      status.textContent = "reconnecting…";
      status.dataset["state"] = "waiting";
    },
    onDevices: renderDevices,
    onDeviceState: () => void refreshDevices(),
    onScrollback: (sid, sb) => panes.get(sid)?.reset(sb),
    onOutput: (sid, data) => panes.get(sid)?.write(data),
    onExited: (sid) => {
      panes.get(sid)?.markDead("session exited");
    },
    onError: (code, message) => {
      status.textContent = `error: ${code} — ${message}`;
    },
  });

  async function refreshDevices(): Promise<void> {
    try {
      renderDevices(await client.listDevices());
    } catch {
      /* not connected yet */
    }
  }

  function renderDevices(devices: DeviceRecord[]): void {
    deviceList.replaceChildren();
    const agents = devices.filter((d) => d.roles.includes("agent"));
    if (agents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "no agents online";
      deviceList.append(empty);
      return;
    }
    for (const agent of agents) {
      const row = document.createElement("div");
      row.className = "device";
      row.dataset["state"] = agent.state;

      const name = document.createElement("span");
      name.className = "device-name";
      name.textContent = agent.name;

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.title = agent.state;

      const newShell = document.createElement("button");
      newShell.textContent = "+ shell";
      newShell.disabled = agent.state !== "connected";
      newShell.addEventListener("click", () => void openShell(agent.id, agent.name));

      row.append(dot, name, newShell);
      deviceList.append(row);
    }
  }

  async function openShell(agentId: string, agentName: string): Promise<void> {
    try {
      const session = await client.createSession(agentId, { kind: "pty" });
      const pane = new TerminalPane(client, agentId, session.id, `${agentName} · ${session.title}`);
      panes.set(session.id, pane);
      grid.append(pane.el);
      pane.refit();
    } catch (err) {
      status.textContent = `could not open shell: ${String(err)}`;
    }
  }

  client.connect();
}

main();
