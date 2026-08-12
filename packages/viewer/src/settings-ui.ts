/**
 * Terminal Settings panel — a modal overlay that edits the terminal appearance
 * model in settings.ts. Every control writes into a DRAFT (a structuredClone of
 * the saved settings) and calls saveSettings() immediately, so open panes apply
 * the change LIVE (they subscribe via onSettingsChange). "Done" just closes;
 * "Reset to defaults" saves defaultSettings() and repopulates the controls.
 *
 * Opened from the sidebar "Aa" button and from the desktop shell's File menu
 * (native.onSettings → 'glass://settings'). Esc or a backdrop click closes.
 */
import {
  getSettings,
  saveSettings,
  defaultSettings,
  FONT_CHOICES,
  type TerminalSettings,
  type CursorStyle,
  type ImageFit,
} from "./settings.js";

let openOverlay: HTMLElement | null = null;

export function openTerminalSettings(): void {
  // Singleton: re-invoking (File menu, button) focuses the existing panel.
  if (openOverlay) {
    openOverlay.querySelector<HTMLElement>(".tset-panel")?.focus();
    return;
  }

  let draft: TerminalSettings = structuredClone(getSettings());
  /** Persist a snapshot so later draft mutations can't alias the live model. */
  const commit = (): void => saveSettings(structuredClone(draft));

  const overlay = document.createElement("div");
  overlay.className = "tset-overlay";
  const panel = document.createElement("div");
  panel.className = "tset-panel";
  panel.tabIndex = -1;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "terminal settings");

  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    openOverlay = null;
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) close();
  });

  // ---- small builders -----------------------------------------------------

  const section = (title: string): HTMLElement => {
    const s = document.createElement("section");
    s.className = "tset-section";
    const h = document.createElement("h3");
    h.textContent = title;
    s.append(h);
    return s;
  };

  const row = (label: string, ...controls: HTMLElement[]): HTMLElement => {
    const r = document.createElement("div");
    r.className = "tset-row";
    const l = document.createElement("label");
    l.className = "tset-label";
    l.textContent = label;
    const c = document.createElement("div");
    c.className = "tset-control";
    c.append(...controls);
    r.append(l, c);
    return r;
  };

  const valueTag = (): HTMLSpanElement => {
    const v = document.createElement("span");
    v.className = "tset-value";
    return v;
  };

  const slider = (min: number, max: number, step: number): HTMLInputElement => {
    const i = document.createElement("input");
    i.type = "range";
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    return i;
  };

  const colorInput = (): HTMLInputElement => {
    const i = document.createElement("input");
    i.type = "color";
    i.className = "tset-color";
    return i;
  };

  // ---- Font ---------------------------------------------------------------

  const fontSection = section("Font");

  const familySel = document.createElement("select");
  for (const f of FONT_CHOICES) {
    const o = document.createElement("option");
    o.value = f.value;
    o.textContent = f.label;
    familySel.append(o);
  }
  familySel.addEventListener("change", () => {
    draft.fontFamily = familySel.value;
    commit();
  });

  const sizeNum = document.createElement("input");
  sizeNum.type = "number";
  sizeNum.min = "8";
  sizeNum.max = "32";
  sizeNum.className = "tset-num";
  const sizeRange = slider(8, 32, 1);
  const setSize = (v: number): void => {
    const n = Math.min(32, Math.max(8, Math.round(v)));
    if (!Number.isFinite(n)) return;
    draft.fontSize = n;
    sizeNum.value = String(n);
    sizeRange.value = String(n);
    commit();
  };
  sizeNum.addEventListener("change", () => setSize(Number(sizeNum.value)));
  sizeRange.addEventListener("input", () => setSize(Number(sizeRange.value)));

  const lineRange = slider(0.8, 2.0, 0.05);
  const lineVal = valueTag();
  lineRange.addEventListener("input", () => {
    draft.lineHeight = Number(lineRange.value);
    lineVal.textContent = draft.lineHeight.toFixed(2);
    commit();
  });

  const spaceRange = slider(-2, 4, 0.5);
  const spaceVal = valueTag();
  spaceRange.addEventListener("input", () => {
    draft.letterSpacing = Number(spaceRange.value);
    spaceVal.textContent = `${draft.letterSpacing}px`;
    commit();
  });

  fontSection.append(
    row("family", familySel),
    row("size", sizeRange, sizeNum),
    row("line height", lineRange, lineVal),
    row("letter spacing", spaceRange, spaceVal),
  );

  // ---- Text ---------------------------------------------------------------

  const textSection = section("Text");

  const fgColor = colorInput();
  fgColor.addEventListener("input", () => {
    draft.foreground = fgColor.value;
    commit();
  });

  const selColor = colorInput();
  selColor.addEventListener("input", () => {
    draft.selectionBackground = selColor.value;
    commit();
  });

  textSection.append(row("text colour", fgColor), row("selection colour", selColor));

  // ---- Cursor -------------------------------------------------------------

  const cursorSection = section("Cursor");

  const seg = document.createElement("div");
  seg.className = "tset-seg";
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "cursor style");
  const segBtns = new Map<CursorStyle, HTMLButtonElement>();
  const syncSeg = (): void => {
    for (const [style, btn] of segBtns) {
      btn.classList.toggle("active", style === draft.cursorStyle);
      btn.setAttribute("aria-checked", String(style === draft.cursorStyle));
    }
  };
  for (const style of ["block", "bar", "underline"] as CursorStyle[]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = style;
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => {
      draft.cursorStyle = style;
      syncSeg();
      commit();
    });
    segBtns.set(style, b);
    seg.append(b);
  }

  const blinkWrap = document.createElement("label");
  blinkWrap.className = "tset-check";
  const blink = document.createElement("input");
  blink.type = "checkbox";
  blink.addEventListener("change", () => {
    draft.cursorBlink = blink.checked;
    commit();
  });
  blinkWrap.append(blink, document.createTextNode("blink"));

  const curColor = colorInput();
  curColor.addEventListener("input", () => {
    draft.cursorColor = curColor.value;
    commit();
  });

  cursorSection.append(row("style", seg), row("blink", blinkWrap), row("cursor colour", curColor));

  // ---- Background ---------------------------------------------------------

  const bgSection = section("Background");

  const bgColor = colorInput();
  bgColor.addEventListener("input", () => {
    draft.background.color = bgColor.value;
    commit();
  });

  const opRange = slider(0, 100, 1);
  const opVal = valueTag();
  opRange.addEventListener("input", () => {
    draft.background.opacity = Number(opRange.value) / 100;
    opVal.textContent = `${opRange.value}%`;
    commit();
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  const chooseBtn = document.createElement("button");
  chooseBtn.type = "button";
  chooseBtn.textContent = "Choose image…";
  chooseBtn.addEventListener("click", () => fileInput.click());
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear image";
  const imgName = valueTag();

  const fitSel = document.createElement("select");
  for (const fit of ["cover", "contain", "tile", "center"] as ImageFit[]) {
    const o = document.createElement("option");
    o.value = fit;
    o.textContent = fit;
    fitSel.append(o);
  }
  fitSel.addEventListener("change", () => {
    draft.background.imageFit = fitSel.value as ImageFit;
    commit();
  });

  const syncImage = (): void => {
    const has = draft.background.image !== null;
    clearBtn.disabled = !has;
    fitSel.disabled = !has;
    imgName.textContent = has ? "image set" : "none";
  };

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      draft.background.image = reader.result;
      syncImage();
      commit();
    };
    reader.readAsDataURL(file);
    fileInput.value = ""; // allow re-choosing the same file
  });
  clearBtn.addEventListener("click", () => {
    draft.background.image = null;
    syncImage();
    commit();
  });

  bgSection.append(
    row("colour", bgColor),
    row("opacity", opRange, opVal),
    row("image", chooseBtn, clearBtn, imgName, fileInput),
    row("image fit", fitSel),
  );

  // ---- footer -------------------------------------------------------------

  const footer = document.createElement("div");
  footer.className = "tset-footer";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "tset-reset";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => {
    draft = defaultSettings();
    saveSettings(structuredClone(draft));
    populate();
  });
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "tset-done";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", close);
  footer.append(resetBtn, doneBtn);

  // ---- populate all controls from the draft -------------------------------

  function populate(): void {
    // Add the saved font if it isn't one of the offered choices.
    if (![...familySel.options].some((o) => o.value === draft.fontFamily)) {
      const o = document.createElement("option");
      o.value = draft.fontFamily;
      o.textContent = draft.fontFamily.split(",")[0]?.replace(/["']/g, "").trim() || "Custom";
      familySel.append(o);
    }
    familySel.value = draft.fontFamily;
    sizeNum.value = String(draft.fontSize);
    sizeRange.value = String(draft.fontSize);
    lineRange.value = String(draft.lineHeight);
    lineVal.textContent = draft.lineHeight.toFixed(2);
    spaceRange.value = String(draft.letterSpacing);
    spaceVal.textContent = `${draft.letterSpacing}px`;
    fgColor.value = draft.foreground;
    selColor.value = draft.selectionBackground;
    syncSeg();
    blink.checked = draft.cursorBlink;
    curColor.value = draft.cursorColor;
    bgColor.value = draft.background.color;
    const op = Math.round(draft.background.opacity * 100);
    opRange.value = String(op);
    opVal.textContent = `${op}%`;
    fitSel.value = draft.background.imageFit;
    syncImage();
  }
  populate();

  const title = document.createElement("h2");
  title.className = "tset-title";
  title.textContent = "Terminal Settings";

  panel.append(title, fontSection, textSection, cursorSection, bgSection, footer);
  overlay.append(panel);
  document.body.append(overlay);
  openOverlay = overlay;
  panel.focus();
}
