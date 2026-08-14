/**
 * Extensions manager — install/enable/disable/remove extensions
 * (extensions.ts model). Reached from the ribbon's customize dialog
 * ("Extensions…"). Three views in one panel: the list, the import form
 * (paste or open a .json file), and the consent step that shows EXACTLY the
 * capabilities being granted before anything is stored or run. Every change
 * persists immediately and is reported via onChange so main.ts can re-sync
 * the extension host.
 *
 * All extension-supplied strings (names, descriptions, icons) render via
 * textContent only — they are untrusted display text.
 */
import {
  CAPABILITIES,
  deleteExtension,
  parseExtensions,
  parseImport,
  setEnabled,
  upsertExtension,
  type Extension,
} from "./extensions.js";
import { clearExtensionStorage } from "./extension-host.js";

const KEY = "glass.extensions";

export function loadExtensions(): Extension[] {
  try {
    return parseExtensions(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function saveExtensions(exts: Extension[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(exts));
  } catch {
    /* private mode / quota — edits just won't persist */
  }
}

let openOverlay: HTMLElement | undefined;

/** Open the manager. `onChange` fires with the full collection after each change. */
export function openExtensionsManager(onChange: (exts: Extension[]) => void): void {
  openOverlay?.remove();
  let exts = loadExtensions();

  const o = document.createElement("div");
  o.className = "tset-overlay";
  const panel = document.createElement("div");
  panel.className = "tset-panel";
  panel.setAttribute("role", "dialog");
  panel.tabIndex = -1;
  const close = (): void => {
    o.remove();
    openOverlay = undefined;
  };
  o.addEventListener("mousedown", (ev) => {
    if (ev.target === o) close();
  });
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });

  const title = document.createElement("h2");
  title.className = "tset-title";
  const body = document.createElement("div");
  body.className = "ribbon-config";
  const foot = document.createElement("div");
  foot.className = "ribbon-config-foot";
  panel.append(title, body, foot);

  const commit = (next: Extension[]): void => {
    exts = next;
    saveExtensions(exts);
    onChange(exts);
  };

  // Survives the round-trip through the consent view's Cancel.
  let importText = "";

  function showList(): void {
    title.textContent = "extensions";
    body.replaceChildren();
    foot.replaceChildren();
    if (exts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ribbon-config-empty";
      empty.textContent =
        "An extension is a small script (a .json file anyone can author) that runs sandboxed inside Glass and can add ribbon buttons. It only gets the capabilities you approve when installing it.";
      body.append(empty);
    }
    for (const ext of exts) {
      const row = document.createElement("div");
      row.className = "ribbon-config-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = ext.enabled;
      cb.title = "enabled";
      cb.setAttribute("aria-label", `enable ${ext.name}`);
      cb.addEventListener("change", () => commit(setEnabled(exts, ext.id, cb.checked)));
      const icon = document.createElement("span");
      icon.className = "ribbon-config-icon";
      icon.textContent = ext.icon;
      const name = document.createElement("span");
      name.className = "ribbon-config-name";
      name.textContent = `${ext.name} ${ext.version}`;
      name.title = ext.capabilities.length
        ? `can: ${ext.capabilities.map((c) => CAPABILITIES[c]).join("; ")}`
        : "no capabilities — UI only";
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        clearExtensionStorage(ext.id);
        commit(deleteExtension(exts, ext.id));
        showList();
      });
      row.append(cb, icon, name, del);
      body.append(row);
    }
    const importBtn = document.createElement("button");
    importBtn.className = "update-banner-btn";
    importBtn.textContent = "Import…";
    importBtn.addEventListener("click", showImport);
    const closeBtn = document.createElement("button");
    closeBtn.className = "update-banner-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    foot.append(importBtn, closeBtn);
  }

  function showImport(): void {
    title.textContent = "import extension";
    body.replaceChildren();
    foot.replaceChildren();

    const hint = document.createElement("p");
    hint.className = "connect-hint";
    hint.textContent = "Paste an extension file (JSON), or open one from disk. Nothing is installed until you review its capabilities.";
    const text = document.createElement("textarea");
    text.rows = 10;
    text.spellcheck = false;
    text.placeholder = '{ "glassExtension": 1, "id": "…", "name": "…", "version": "…", "capabilities": [], "code": "…" }';
    text.value = importText;
    text.addEventListener("input", () => {
      importText = text.value;
    });
    const error = document.createElement("p");
    error.className = "connect-error";
    body.append(hint, text, error);

    const fileBtn = document.createElement("button");
    fileBtn.className = "update-banner-btn";
    fileBtn.textContent = "Open file…";
    fileBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", () => {
        const f = input.files?.[0];
        if (!f) return;
        void f.text().then((t) => {
          text.value = t;
          importText = t;
          error.textContent = "";
        });
      });
      input.click();
    });
    const review = document.createElement("button");
    review.className = "update-banner-btn";
    review.textContent = "Review";
    review.addEventListener("click", () => {
      const res = parseImport(text.value);
      if (!res.ok) {
        error.textContent = res.error;
        return;
      }
      showConsent(res.ext);
    });
    const back = document.createElement("button");
    back.className = "update-banner-btn";
    back.textContent = "Cancel";
    back.addEventListener("click", showList);
    foot.append(fileBtn, review, back);
    text.focus();
  }

  /** The consent step — what the trust model hangs on. Shows the full grant. */
  function showConsent(ext: Extension): void {
    const replacing = exts.some((e) => e.id === ext.id);
    title.textContent = replacing ? "replace extension" : "install extension";
    body.replaceChildren();
    foot.replaceChildren();

    const head = document.createElement("div");
    head.className = "ribbon-config-row";
    const icon = document.createElement("span");
    icon.className = "ribbon-config-icon";
    icon.textContent = ext.icon;
    const name = document.createElement("span");
    name.className = "ribbon-config-name";
    name.textContent = `${ext.name} ${ext.version}`;
    head.append(icon, name);
    body.append(head);
    if (ext.description) {
      const desc = document.createElement("p");
      desc.className = "connect-hint";
      desc.textContent = ext.description;
      body.append(desc);
    }

    const grants = document.createElement("p");
    grants.className = "connect-hint";
    grants.textContent = ext.capabilities.length ? "This extension will be able to:" : "This extension requests no capabilities — it can only add ribbon buttons.";
    body.append(grants);
    for (const c of ext.capabilities) {
      const li = document.createElement("div");
      li.className = "ribbon-config-row";
      const dot = document.createElement("span");
      dot.className = "ribbon-config-icon";
      dot.textContent = "•";
      const cap = document.createElement("span");
      cap.className = "ribbon-config-name";
      cap.textContent = CAPABILITIES[c];
      li.append(dot, cap);
      body.append(li);
    }
    const warn = document.createElement("p");
    warn.className = "connect-hint";
    warn.textContent = replacing
      ? "This replaces the installed version. Only install extensions from sources you trust."
      : "Installing runs this code inside Glass (sandboxed, limited to the capabilities above). Only install extensions from sources you trust.";
    body.append(warn);

    const install = document.createElement("button");
    install.className = "update-banner-btn";
    install.textContent = replacing ? "Replace" : "Install";
    install.addEventListener("click", () => {
      commit(upsertExtension(exts, ext));
      importText = ""; // next Import starts fresh
      showList();
    });
    const back = document.createElement("button");
    back.className = "update-banner-btn";
    back.textContent = "Cancel";
    back.addEventListener("click", showImport);
    foot.append(install, back);
  }

  showList();
  o.append(panel);
  document.body.append(o);
  openOverlay = o;
  panel.focus();
}
