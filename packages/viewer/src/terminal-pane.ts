/**
 * A single terminal pane: an xterm.js terminal bound to one session via the
 * HubClient. Output/scrollback are pushed in by the app; keystrokes and resizes
 * are pushed back out to the session. This is the only file that touches xterm.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { HubClient } from "./hub-client.js";

const THEME = {
  background: "#0b0e14",
  foreground: "#bfbdb6",
  cursor: "#e6b450",
  selectionBackground: "#273747",
};

export class TerminalPane {
  readonly el: HTMLElement;
  private readonly term: Terminal;
  private readonly fit: FitAddon;
  private readonly onWindowResize = (): void => this.refit();

  constructor(
    private readonly client: HubClient,
    private readonly agentId: string,
    readonly sessionId: string,
    title: string,
  ) {
    this.el = document.createElement("div");
    this.el.className = "pane";

    const header = document.createElement("div");
    header.className = "pane-header";
    const label = document.createElement("span");
    label.textContent = title;
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "close session";
    closeBtn.addEventListener("click", () => this.client.closeSession(this.agentId, this.sessionId));
    header.append(label, closeBtn);

    const body = document.createElement("div");
    body.className = "pane-body";

    this.el.append(header, body);

    this.term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: THEME,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(body);
    this.refit();

    this.term.onData((data) => this.client.input(this.agentId, this.sessionId, data));
    this.term.onResize(({ cols, rows }) => this.client.resize(this.agentId, this.sessionId, cols, rows));
    window.addEventListener("resize", this.onWindowResize);
  }

  write(data: string): void {
    this.term.write(data);
  }

  /** Replace the screen with a replayed buffer (on attach / reconnect). */
  reset(scrollback: string): void {
    this.term.reset();
    this.term.write(scrollback);
  }

  markDead(note: string): void {
    this.term.write(`\r\n\x1b[2m[${note}]\x1b[0m\r\n`);
  }

  refit(): void {
    try {
      this.fit.fit();
    } catch {
      /* not in the DOM yet */
    }
  }

  dispose(): void {
    window.removeEventListener("resize", this.onWindowResize);
    this.term.dispose();
    this.el.remove();
  }
}
