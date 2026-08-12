/**
 * A single terminal pane: an xterm.js terminal bound to one session via the
 * HubClient. Output/scrollback are pushed in by the app; keystrokes and resizes
 * are pushed back out to the session. This is the only file that touches xterm.
 *
 * Appearance is driven by settings.ts: the terminal renders transparent over a
 * `.pane-bg` layer that carries the user's colour/image/opacity, so all of the
 * customisation (opacity, background image, fonts, colours) applies live and
 * never bleeds onto the text.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { HubClient } from "./hub-client.js";
import { getSettings, onSettingsChange, xtermOptions, applyToTerminal, applyBackgroundLayer, type TerminalSettings } from "./settings.js";

export class TerminalPane {
  readonly el: HTMLElement;
  private readonly term: Terminal;
  private readonly fit: FitAddon;
  private readonly bg: HTMLElement;
  private readonly onWindowResize = (): void => this.refit();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly client: HubClient,
    private readonly agentId: string,
    readonly sessionId: string,
    title: string,
    private readonly opts: { onClose?: () => void; onFocus?: () => void } = {},
  ) {
    this.el = document.createElement("div");
    this.el.className = "pane";
    // Clicking anywhere in the pane focuses it (for split layouts).
    this.el.addEventListener("mousedown", () => this.opts.onFocus?.());

    const header = document.createElement("div");
    header.className = "pane-header";
    const label = document.createElement("span");
    label.textContent = title;
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "hide from workspace (session stays live — reopen from the sidebar)";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onClose?.();
    });
    header.append(label, closeBtn);

    const body = document.createElement("div");
    body.className = "pane-body";
    // Background layer (sibling behind the terminal) carries colour/image/opacity.
    this.bg = document.createElement("div");
    this.bg.className = "pane-bg";
    const mount = document.createElement("div");
    mount.className = "pane-term";
    body.append(this.bg, mount);

    this.el.append(header, body);

    const settings = getSettings();
    this.term = new Terminal({ convertEol: false, ...xtermOptions(settings) });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(mount);
    applyBackgroundLayer(this.bg, settings);
    this.refit();

    // xterm keeps its OWN selection (not the DOM selection), so the native Edit
    // menu's Copy can't see it — wire Cmd+C (copy selection) / Cmd+V (paste)
    // here. Cmd, not Ctrl, so Ctrl+C still sends SIGINT to the shell.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.metaKey || e.ctrlKey || e.altKey) return true;
      const k = e.key.toLowerCase();
      if (k === "c" && this.term.hasSelection()) {
        void navigator.clipboard.writeText(this.term.getSelection());
        return false;
      }
      if (k === "v") {
        void navigator.clipboard.readText().then((t) => {
          if (t) this.client.input(this.agentId, this.sessionId, t);
        });
        return false;
      }
      return true;
    });

    this.term.onData((data) => this.client.input(this.agentId, this.sessionId, data));
    this.term.onResize(({ cols, rows }) => this.client.resize(this.agentId, this.sessionId, cols, rows));
    window.addEventListener("resize", this.onWindowResize);
    this.unsubscribe = onSettingsChange((s) => this.applySettings(s));
  }

  private applySettings(s: TerminalSettings): void {
    applyToTerminal(this.term, s);
    applyBackgroundLayer(this.bg, s);
    // Font metrics may have changed the cell size — recompute rows/cols.
    this.refit();
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

  /** Mark this pane as the focused one in a split layout. */
  setFocused(on: boolean): void {
    this.el.classList.toggle("focused", on);
  }

  /** Re-fit + focus when (re)shown after being hidden. */
  show(): void {
    this.refit();
    try {
      this.term.focus();
    } catch {
      /* not attached */
    }
  }

  refit(): void {
    try {
      this.fit.fit();
    } catch {
      /* not in the DOM yet */
    }
  }

  dispose(): void {
    this.unsubscribe();
    window.removeEventListener("resize", this.onWindowResize);
    this.term.dispose();
    this.el.remove();
  }
}
