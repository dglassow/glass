/**
 * Right-side vertical ribbon — a dock of small, user-chosen widget buttons.
 *
 * The app REGISTERS what widgets exist; the user decides which of them appear
 * and in what order via the customize dialog (pin checkboxes + ↑/↓), persisted
 * per device in localStorage. No widgets are registered yet — this is the seam
 * future ones plug into: `ribbon.register({ id, title, icon, activate })` and
 * pinning, ordering, and persistence are already handled. Icons and titles are
 * rendered via textContent only.
 */
import {
  emptyRibbonState,
  move,
  parseRibbonState,
  pin,
  unpin,
  visiblePinned,
  type RibbonState,
} from "./ribbon-model.js";

export interface RibbonWidget {
  /** Stable identity — this is what persists in the user's pin list. */
  id: string;
  /** Human name, shown in the customize dialog and as the button tooltip. */
  title: string;
  /** Short glyph (emoji / 1–2 chars) shown on the ribbon button. */
  icon: string;
  /** Invoked when the user clicks the widget's ribbon button. */
  activate: () => void;
}

export interface Ribbon {
  el: HTMLElement;
  /** Declare a widget as available. Idempotent per id (last wins). */
  register: (widget: RibbonWidget) => void;
}

const KEY = "glass.ribbon";

function loadState(): RibbonState {
  try {
    return parseRibbonState(localStorage.getItem(KEY));
  } catch {
    return emptyRibbonState();
  }
}

function saveState(state: RibbonState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the arrangement just won't persist */
  }
}

export function createRibbon(): Ribbon {
  const widgets = new Map<string, RibbonWidget>();
  let state = loadState();

  const el = document.createElement("aside");
  el.className = "ribbon";
  const items = document.createElement("div");
  items.className = "ribbon-items";
  const customizeBtn = document.createElement("button");
  customizeBtn.className = "ribbon-customize";
  customizeBtn.textContent = "⋯";
  customizeBtn.title = "Customize ribbon";
  customizeBtn.setAttribute("aria-label", "customize ribbon");
  customizeBtn.addEventListener("click", () => openCustomize());
  el.append(items, customizeBtn);

  function apply(next: RibbonState): void {
    if (next === state) return;
    state = next;
    saveState(state);
    renderItems();
  }

  function renderItems(): void {
    items.replaceChildren();
    for (const id of visiblePinned(state, new Set(widgets.keys()))) {
      const w = widgets.get(id)!;
      const btn = document.createElement("button");
      btn.className = "ribbon-item";
      btn.textContent = w.icon;
      btn.title = w.title;
      btn.setAttribute("aria-label", w.title);
      btn.addEventListener("click", () => w.activate());
      items.append(btn);
    }
  }

  // Customize dialog (same chrome as Terminal Settings): pinned widgets first
  // in their order with ↑/↓, then the rest of the available list to pin.
  let overlay: HTMLElement | undefined;
  function openCustomize(): void {
    overlay?.remove();
    const o = document.createElement("div");
    o.className = "tset-overlay";
    const panel = document.createElement("div");
    panel.className = "tset-panel";
    panel.setAttribute("role", "dialog");
    panel.tabIndex = -1;
    const close = (): void => {
      o.remove();
      overlay = undefined;
    };
    o.addEventListener("mousedown", (ev) => {
      if (ev.target === o) close();
    });
    panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    });

    const title = document.createElement("h2");
    title.className = "tset-title";
    title.textContent = "ribbon";
    const list = document.createElement("div");
    list.className = "ribbon-config";

    const renderList = (): void => {
      list.replaceChildren();
      if (widgets.size === 0) {
        const empty = document.createElement("div");
        empty.className = "ribbon-config-empty";
        empty.textContent = "No widgets available yet — future releases will add some. Anything you pin here shows on the right-side ribbon.";
        list.append(empty);
        return;
      }
      const pinnedIds = visiblePinned(state, new Set(widgets.keys()));
      const rest = [...widgets.values()]
        .filter((w) => !pinnedIds.includes(w.id))
        .sort((a, b) => a.title.localeCompare(b.title));
      const row = (w: RibbonWidget, pinnedAt: number): HTMLElement => {
        const r = document.createElement("div");
        r.className = "ribbon-config-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = pinnedAt >= 0;
        cb.setAttribute("aria-label", `pin ${w.title}`);
        cb.addEventListener("change", () => {
          apply(cb.checked ? pin(state, w.id) : unpin(state, w.id));
          renderList();
        });
        const icon = document.createElement("span");
        icon.className = "ribbon-config-icon";
        icon.textContent = w.icon;
        const name = document.createElement("span");
        name.className = "ribbon-config-name";
        name.textContent = w.title;
        r.append(cb, icon, name);
        if (pinnedAt >= 0) {
          const up = document.createElement("button");
          up.textContent = "↑";
          up.setAttribute("aria-label", `move ${w.title} up`);
          up.disabled = pinnedAt === 0;
          up.addEventListener("click", () => {
            apply(move(state, w.id, -1));
            renderList();
          });
          const down = document.createElement("button");
          down.textContent = "↓";
          down.setAttribute("aria-label", `move ${w.title} down`);
          down.disabled = pinnedAt === pinnedIds.length - 1;
          down.addEventListener("click", () => {
            apply(move(state, w.id, 1));
            renderList();
          });
          r.append(up, down);
        }
        return r;
      };
      pinnedIds.forEach((id, i) => list.append(row(widgets.get(id)!, i)));
      rest.forEach((w) => list.append(row(w, -1)));
    };
    renderList();

    const closeBtn = document.createElement("button");
    closeBtn.className = "update-banner-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    panel.append(title, list, closeBtn);
    o.append(panel);
    document.body.append(o);
    overlay = o;
    panel.focus();
  }

  return {
    el,
    register(widget) {
      widgets.set(widget.id, widget);
      renderItems();
    },
  };
}
