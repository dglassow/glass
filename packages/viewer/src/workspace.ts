/**
 * The terminal workspace: a tiling layout over live sessions (plan §6). Sessions
 * are created once and kept alive; the workspace decides which are *shown* and
 * how they're arranged. It starts as a single view; dragging a session from the
 * sidebar onto a pane edge splits it; a pane's ✕ removes it from the layout but
 * keeps the session live (reopen from the sidebar).
 *
 * Layout is a binary tree: a Leaf shows one session; a Split arranges two
 * children row/col with a draggable divider. Panes persist as DOM elements that
 * are moved in and out of leaf slots, so scrollback + the live stream survive
 * hide/show and re-splitting.
 */
import { TerminalPane } from "./terminal-pane.js";
import type { HubClient } from "./hub-client.js";

export const SESSION_MIME = "application/x-glass-session";

type Leaf = { kind: "leaf"; id: string };
type Split = { kind: "split"; dir: "row" | "col"; a: Node; b: Node; ratio: number };
type Node = Leaf | Split;
type Zone = "left" | "right" | "top" | "bottom" | "center";

interface SessionInfo {
  agentId: string;
  title: string;
  pane: TerminalPane;
}

function leaves(node: Node | null): string[] {
  if (!node) return [];
  if (node.kind === "leaf") return [node.id];
  return [...leaves(node.a), ...leaves(node.b)];
}
function removeLeaf(node: Node, id: string): Node | null {
  if (node.kind === "leaf") return node.id === id ? null : node;
  const a = removeLeaf(node.a, id);
  const b = removeLeaf(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}
function replaceLeaf(node: Node, id: string, repl: Node): Node {
  if (node.kind === "leaf") return node.id === id ? repl : node;
  return { ...node, a: replaceLeaf(node.a, id, repl), b: replaceLeaf(node.b, id, repl) };
}
function firstLeaf(node: Node | null): string | null {
  if (!node) return null;
  return node.kind === "leaf" ? node.id : firstLeaf(node.a) ?? firstLeaf(node.b);
}

export class Workspace {
  readonly el: HTMLElement;
  private readonly sessions = new Map<string, SessionInfo>();
  private root: Node | null = null;
  private focused: string | null = null;

  constructor(
    private readonly client: HubClient,
    private readonly onChange: () => void = () => {},
  ) {
    this.el = document.createElement("main");
    this.el.className = "workspace";
    this.render();
  }

  // ---- session lifecycle ------------------------------------------------
  add(sessionId: string, agentId: string, title: string): void {
    if (this.sessions.has(sessionId)) return;
    const pane = new TerminalPane(this.client, agentId, sessionId, title, {
      onClose: () => this.hide(sessionId),
      onFocus: () => this.setFocus(sessionId),
    });
    this.sessions.set(sessionId, { agentId, title, pane });
    this.onChange();
  }
  /** Session ended for real (killed / exited): drop it entirely. */
  kill(sessionId: string): void {
    if (this.root) this.root = removeLeaf(this.root, sessionId);
    this.sessions.get(sessionId)?.pane.dispose();
    this.sessions.delete(sessionId);
    if (this.focused === sessionId) this.focused = firstLeaf(this.root);
    this.render();
    this.onChange();
  }
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ---- output routing ---------------------------------------------------
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pane.write(data);
  }
  reset(sessionId: string, scrollback: string): void {
    this.sessions.get(sessionId)?.pane.reset(scrollback);
  }
  markDead(sessionId: string, note: string): void {
    this.sessions.get(sessionId)?.pane.markDead(note);
  }

  // ---- display ----------------------------------------------------------
  /** Sidebar click: focus if already shown, else replace the view with it. */
  show(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    if (this.isVisible(sessionId)) {
      this.setFocus(sessionId);
      return;
    }
    this.root = { kind: "leaf", id: sessionId };
    this.focused = sessionId;
    this.render();
    this.onChange();
  }
  /** Pane ✕: remove from the layout but keep the session alive. */
  hide(sessionId: string): void {
    if (!this.root) return;
    this.root = removeLeaf(this.root, sessionId);
    if (this.focused === sessionId) this.focused = firstLeaf(this.root);
    this.render();
    this.onChange();
  }
  /** Drop a dragged session onto a target pane's edge to split it. */
  private drop(targetId: string, dragId: string, zone: Zone): void {
    if (!this.sessions.has(dragId)) return;
    // If the dragged session is shown elsewhere, pull it out first.
    if (this.root && this.isVisible(dragId)) this.root = removeLeaf(this.root, dragId);
    if (!this.root) {
      this.root = { kind: "leaf", id: dragId };
    } else if (dragId === targetId || zone === "center" || !this.isVisible(targetId)) {
      this.root = this.isVisible(targetId)
        ? replaceLeaf(this.root, targetId, { kind: "leaf", id: dragId })
        : { kind: "leaf", id: dragId };
    } else {
      const dir: "row" | "col" = zone === "left" || zone === "right" ? "row" : "col";
      const before = zone === "left" || zone === "top";
      const dragLeaf: Node = { kind: "leaf", id: dragId };
      const targetLeaf: Node = { kind: "leaf", id: targetId };
      this.root = replaceLeaf(this.root, targetId, {
        kind: "split",
        dir,
        a: before ? dragLeaf : targetLeaf,
        b: before ? targetLeaf : dragLeaf,
        ratio: 0.5,
      });
    }
    this.focused = dragId;
    this.render();
    this.onChange();
  }

  private isVisible(id: string): boolean {
    return leaves(this.root).includes(id);
  }
  private setFocus(id: string): void {
    this.focused = id;
    for (const [sid, s] of this.sessions) s.pane.setFocused(sid === id && this.isVisible(id));
    this.onChange();
  }

  /** For the sidebar: which sessions are shown / focused, per agent. */
  sessionList(): Array<{ sessionId: string; agentId: string; title: string; visible: boolean; focused: boolean }> {
    const shown = new Set(leaves(this.root));
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      agentId: s.agentId,
      title: s.title,
      visible: shown.has(sessionId),
      focused: sessionId === this.focused,
    }));
  }

  // ---- rendering --------------------------------------------------------
  private render(): void {
    this.el.replaceChildren();
    if (!this.root) {
      const empty = document.createElement("div");
      empty.className = "ws-empty";
      empty.textContent = "no shell open — create one from the sidebar, or drag a session here";
      this.el.append(empty);
      return;
    }
    this.el.append(this.renderNode(this.root));
    // Sizes changed — refit every shown pane, and restore focus styling.
    for (const id of leaves(this.root)) {
      const s = this.sessions.get(id);
      s?.pane.setFocused(id === this.focused);
      s?.pane.show();
    }
  }

  private renderNode(node: Node): HTMLElement {
    if (node.kind === "leaf") return this.renderLeaf(node.id);
    const box = document.createElement("div");
    box.className = `ws-split ${node.dir}`;
    const aEl = this.renderNode(node.a);
    const bEl = this.renderNode(node.b);
    aEl.style.flex = `${node.ratio} 1 0`;
    bEl.style.flex = `${1 - node.ratio} 1 0`;
    const divider = document.createElement("div");
    divider.className = "ws-divider";
    this.wireDivider(divider, node, aEl, bEl, box);
    box.append(aEl, divider, bEl);
    return box;
  }

  private renderLeaf(id: string): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "ws-leaf";
    const s = this.sessions.get(id);
    if (s) slot.append(s.pane.el);

    const overlay = document.createElement("div");
    overlay.className = "ws-drop";
    slot.append(overlay);

    const zoneFor = (e: DragEvent): Zone => {
      const r = slot.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      const d = { left: px, right: 1 - px, top: py, bottom: 1 - py };
      const min = Math.min(d.left, d.right, d.top, d.bottom);
      if (min > 0.28) return "center";
      return (Object.keys(d) as Zone[]).find((k) => d[k as "left"] === min) ?? "center";
    };
    slot.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(SESSION_MIME)) return;
      e.preventDefault();
      overlay.dataset["zone"] = zoneFor(e);
      overlay.classList.add("active");
    });
    slot.addEventListener("dragleave", () => overlay.classList.remove("active"));
    slot.addEventListener("drop", (e) => {
      const dragId = e.dataTransfer?.getData(SESSION_MIME);
      overlay.classList.remove("active");
      if (!dragId) return;
      e.preventDefault();
      this.drop(id, dragId, zoneFor(e));
    });
    return slot;
  }

  private wireDivider(divider: HTMLElement, split: Split, aEl: HTMLElement, bEl: HTMLElement, box: HTMLElement): void {
    divider.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      divider.setPointerCapture(down.pointerId);
      const move = (e: PointerEvent): void => {
        const r = box.getBoundingClientRect();
        const frac = split.dir === "row" ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
        split.ratio = Math.min(0.85, Math.max(0.15, frac));
        aEl.style.flex = `${split.ratio} 1 0`;
        bEl.style.flex = `${1 - split.ratio} 1 0`;
      };
      const up = (): void => {
        divider.releasePointerCapture(down.pointerId);
        divider.removeEventListener("pointermove", move);
        divider.removeEventListener("pointerup", up);
        for (const id of leaves(this.root)) this.sessions.get(id)?.pane.refit();
      };
      divider.addEventListener("pointermove", move);
      divider.addEventListener("pointerup", up);
    });
  }
}
