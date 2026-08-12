/**
 * Terminal appearance settings — the model + persistence + the helpers that map
 * settings onto xterm and onto the pane's background layer. DOM-free except for
 * the tiny apply-to-element helper; usable from the settings UI and the panes.
 *
 * Background opacity / image work by making xterm ITSELF transparent
 * (allowTransparency + a transparent theme background) and painting the chosen
 * colour/image on a SIBLING layer behind the terminal. Opacity lives on that
 * sibling, so it never bleeds onto the text (CSS opacity on an ancestor would).
 * With the Tauri window set transparent, lowering opacity reveals the desktop.
 */
import type { ITerminalOptions, ITheme } from "@xterm/xterm";

export type CursorStyle = "block" | "bar" | "underline";
export type ImageFit = "cover" | "contain" | "tile" | "center";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number; // px
  lineHeight: number; // multiplier
  letterSpacing: number; // px
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  foreground: string; // hex
  cursorColor: string; // hex
  selectionBackground: string; // hex
  background: {
    color: string; // hex
    opacity: number; // 0..1
    image: string | null; // data URL, or null
    imageFit: ImageFit;
  };
}

/** Common monospace stacks offered in the UI. First token is the display name. */
export const FONT_CHOICES: Array<{ label: string; value: string }> = [
  { label: "System Mono", value: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  { label: "Menlo", value: "Menlo, monospace" },
  { label: "SF Mono", value: '"SF Mono", ui-monospace, monospace' },
  { label: "Monaco", value: "Monaco, monospace" },
  { label: "JetBrains Mono", value: '"JetBrains Mono", ui-monospace, monospace' },
  { label: "Fira Code", value: '"Fira Code", ui-monospace, monospace' },
  { label: "Courier New", value: '"Courier New", Courier, monospace' },
];

const KEY = "glass.terminal.settings";

export function defaultSettings(): TerminalSettings {
  return {
    fontFamily: FONT_CHOICES[0]!.value,
    fontSize: 13,
    lineHeight: 1.0,
    letterSpacing: 0,
    cursorStyle: "block",
    cursorBlink: true,
    foreground: "#c6c8cc",
    cursorColor: "#4d9fff",
    selectionBackground: "#25406a",
    background: { color: "#0b0e14", opacity: 1, image: null, imageFit: "cover" },
  };
}

export function loadSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings();
    const p = JSON.parse(raw) as Partial<TerminalSettings>;
    const d = defaultSettings();
    return { ...d, ...p, background: { ...d.background, ...(p.background ?? {}) } };
  } catch {
    return defaultSettings();
  }
}

type Listener = (s: TerminalSettings) => void;
const listeners = new Set<Listener>();
let current: TerminalSettings = typeof localStorage !== "undefined" ? loadSettings() : defaultSettings();

export function getSettings(): TerminalSettings {
  return current;
}

/** Persist and notify every open pane so changes apply live. */
export function saveSettings(s: TerminalSettings): void {
  current = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* non-persistent context */
  }
  for (const l of [...listeners]) l(s);
}

export function onSettingsChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function xtermTheme(s: TerminalSettings): ITheme {
  return {
    background: "rgba(0,0,0,0)", // transparent — the pane background layer shows through
    foreground: s.foreground,
    cursor: s.cursorColor,
    cursorAccent: s.background.color,
    selectionBackground: s.selectionBackground,
  };
}

export function xtermOptions(s: TerminalSettings): Partial<ITerminalOptions> {
  return {
    allowTransparency: true,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    theme: xtermTheme(s),
  };
}

/** Mutate a live Terminal's options in place (for a settings change). */
export function applyToTerminal(term: { options: Partial<ITerminalOptions> }, s: TerminalSettings): void {
  const o = xtermOptions(s);
  for (const k of Object.keys(o) as Array<keyof ITerminalOptions>) {
    (term.options as Record<string, unknown>)[k] = o[k];
  }
}

/** Paint the background LAYER element (a sibling behind the terminal). */
export function applyBackgroundLayer(el: HTMLElement, s: TerminalSettings): void {
  const b = s.background;
  el.style.opacity = String(b.opacity);
  el.style.backgroundColor = b.color;
  if (b.image) {
    el.style.backgroundImage = `url("${b.image}")`;
    if (b.imageFit === "tile") {
      el.style.backgroundSize = "auto";
      el.style.backgroundRepeat = "repeat";
      el.style.backgroundPosition = "top left";
    } else {
      el.style.backgroundSize = b.imageFit === "center" ? "auto" : b.imageFit;
      el.style.backgroundRepeat = "no-repeat";
      el.style.backgroundPosition = "center";
    }
  } else {
    el.style.backgroundImage = "none";
  }
}
