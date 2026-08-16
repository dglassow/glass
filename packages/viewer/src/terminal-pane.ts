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
  private readonly titleEl: HTMLElement;
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
    this.titleEl = label;
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
    this.term = new Terminal({
      convertEol: false,
      // Selection policy (see wireDragSelection): forced selections are
      // replayed as alt-modified events. On macOS this option makes alt force
      // a normal linear selection; altClickMovesCursor must be off or a short
      // alt-click would type arrow keys into the app.
      macOptionClickForcesSelection: true,
      altClickMovesCursor: false,
      ...xtermOptions(settings),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(mount);
    this.wireDragSelection();
    applyBackgroundLayer(this.bg, settings);
    this.refit();

    // xterm keeps its OWN selection (not the DOM selection), so the native Edit
    // menu's Copy can't see it — wire Cmd+C (copy selection) here. Cmd, not
    // Ctrl, so Ctrl+C still sends SIGINT to the shell. Cmd+V is deliberately
    // NOT wired: the Edit menu's paste (desktop) or the browser default (web)
    // already delivers a real DOM paste event that xterm feeds to the session,
    // honouring bracketed-paste mode. Reading the clipboard here too injected
    // every paste twice and made WKWebView pop its paste-permission callout.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.metaKey || e.ctrlKey || e.altKey) return true;
      if (e.key.toLowerCase() === "c" && this.term.hasSelection()) {
        this.copySelection();
        return false;
      }
      return true;
    });

    this.term.onData((data) => this.client.input(this.agentId, this.sessionId, data));
    this.term.onResize(({ cols, rows }) => this.client.resize(this.agentId, this.sessionId, cols, rows));
    window.addEventListener("resize", this.onWindowResize);
    this.unsubscribe = onSettingsChange((s) => this.applySettings(s));
  }

  /**
   * TUI apps (Claude Code, Etch, vim, htop, …) enable xterm mouse tracking, and
   * xterm.js then hands every mouse event to the app instead of selecting — on
   * macOS there is NO built-in way to select at all. Glass policy: a plain
   * left-DRAG (or double/triple click) always makes a local selection so the
   * owner can copy output from any tool, while a plain left-CLICK and the
   * wheel still reach the app, so click- and scroll-driven TUIs keep working.
   *
   * Mechanism: swallow the trusted mousedown while the app owns the mouse,
   * watch for movement, then either replay it alt-modified (which
   * macOptionClickForcesSelection turns into a normal linear selection) or —
   * if the button is released without moving — replay the verbatim
   * press+release pair so the app receives the click it was owed.
   */
  private wireDragSelection(): void {
    const el = this.term.element;
    if (!el) return;
    const DRAG_PX = 4;
    const clone = (src: MouseEvent, type: string, alt: boolean): MouseEvent =>
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: src.button,
        buttons: src.buttons,
        detail: src.detail,
        clientX: src.clientX,
        clientY: src.clientY,
        screenX: src.screenX,
        screenY: src.screenY,
        altKey: alt, // shift/ctrl/meta stay false: shift means "extend selection" to xterm
      });
    el.addEventListener(
      "mousedown",
      (down: MouseEvent) => {
        if (!down.isTrusted) return; // our own replays must pass through untouched
        if (down.button !== 0 || down.metaKey || down.ctrlKey || down.altKey || down.shiftKey) return;
        if (this.term.modes.mouseTrackingMode === "none") return; // xterm selects natively
        down.preventDefault();
        down.stopImmediatePropagation();
        this.opts.onFocus?.(); // the swallowed event can no longer bubble to the pane's focus handler
        this.term.focus();
        const target = down.target instanceof Element ? down.target : el;
        const beginSelection = (at: MouseEvent): void => {
          target.dispatchEvent(clone(down, "mousedown", true));
          // xterm's selection service now owns the drag via its own document
          // listeners; feed it the current position so it catches up at once.
          if (at !== down) document.dispatchEvent(clone(at, "mousemove", true));
        };
        if (down.detail >= 2) {
          beginSelection(down); // double/triple click: local word/line selection
          return;
        }
        const cleanup = (): void => {
          window.removeEventListener("mousemove", onMove, true);
          window.removeEventListener("mouseup", onUp, true);
          window.removeEventListener("blur", cleanup);
        };
        const onMove = (move: MouseEvent): void => {
          if (Math.abs(move.clientX - down.clientX) + Math.abs(move.clientY - down.clientY) < DRAG_PX) return;
          cleanup();
          beginSelection(move);
        };
        const onUp = (up: MouseEvent): void => {
          cleanup();
          target.dispatchEvent(clone(down, "mousedown", false));
          target.dispatchEvent(clone(up, "mouseup", false));
        };
        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
        window.addEventListener("blur", cleanup);
      },
      true,
    );
  }

  /** Copy the xterm selection; fall back to execCommand where the async
   *  clipboard API is unavailable or refused (older WKWebView states). */
  private copySelection(): void {
    const text = this.term.getSelection();
    if (!text) return;
    const fallback = (): void => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      this.el.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      this.term.focus();
    };
    try {
      navigator.clipboard.writeText(text).catch(fallback);
    } catch {
      fallback();
    }
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

  /** Update the pane-header label (session was renamed). */
  setTitle(title: string): void {
    this.titleEl.textContent = title;
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
