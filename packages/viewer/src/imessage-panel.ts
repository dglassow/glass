/**
 * Messages panel — the ribbon's first real widget (plan §6): a dock on the
 * right edge that browses and answers the iMessages of whichever fleet Mac
 * serves the bridge (device record: imessagePresent). Three views: the
 * conversation list, one thread (with paging + live pushes), and a new-thread
 * compose. Replying into an existing conversation is the reliable path; new
 * threads are best-effort and say so.
 *
 * Every string that originates in chat.db (names, handles, bodies, previews)
 * is other people's content: rendered via textContent ONLY, never markup.
 * Watch subscriptions are agent-worker soft state, so ensureWatch() is
 * idempotent and re-sent on every device refresh while the panel is open —
 * that covers viewer reconnects and blue/green agent swaps without any
 * special-casing.
 */
import type { HubClient } from "./hub-client.js";
import type { IMessageConversation, IMessageItem } from "@glass/protocol";
import { agentLabel, pickAgent, type BridgeAgent } from "./imessage-model.js";

export type IMessageAgent = BridgeAgent;

const CONV_LIMIT = 30;
const PAGE_LIMIT = 50;

export class IMessagePanel {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly agentSelect: HTMLSelectElement;
  private readonly body: HTMLElement;
  private readonly errorEl: HTMLElement;

  private agents: IMessageAgent[] = [];
  private agentId: string | null = null;
  /** Account of the selected agent, captured at selection time — still known
   *  after that agent drops out of the list (the failover decision needs it). */
  private currentAccount: string | undefined;
  private convs: IMessageConversation[] = [];
  private chat: { guid: string; name: string } | null = null;
  private items: IMessageItem[] = [];
  private view: "convs" | "thread" | "compose" = "convs";
  /** Ignore async responses that arrive after the user navigated away. */
  private seq = 0;
  /** Synthetic ids for optimistic just-sent bubbles (removed on the real push). */
  private optimistic = 0;

  constructor(private readonly client: HubClient) {
    this.el = document.createElement("aside");
    this.el.className = "msg-dock";
    this.el.hidden = true;

    this.head = document.createElement("div");
    this.head.className = "msg-head";
    const title = document.createElement("span");
    title.className = "msg-title";
    title.textContent = "messages";
    this.agentSelect = document.createElement("select");
    this.agentSelect.className = "msg-agent";
    this.agentSelect.setAttribute("aria-label", "device whose messages to show");
    this.agentSelect.addEventListener("change", () => {
      const prev = this.agentId;
      const next = this.agentSelect.value || null;
      if (prev && prev !== next) this.client.unwatchIMessages(prev);
      this.agentId = next;
      this.currentAccount = this.agents.find((a) => a.id === next)?.account;
      this.chat = null;
      this.view = "convs";
      this.note("");
      void this.refresh();
    });
    const closeBtn = document.createElement("button");
    closeBtn.className = "msg-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "close messages";
    closeBtn.setAttribute("aria-label", "close messages");
    closeBtn.addEventListener("click", () => this.close());
    this.head.append(title, this.agentSelect, closeBtn);

    this.body = document.createElement("div");
    this.body.className = "msg-body";
    this.errorEl = document.createElement("div");
    this.errorEl.className = "msg-error";

    this.el.append(this.head, this.body, this.errorEl);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.el.hidden = false;
    void this.refresh();
  }

  close(): void {
    this.el.hidden = true;
    if (this.agentId) this.client.unwatchIMessages(this.agentId);
  }

  /**
   * Fleet update: which connected agents can serve the bridge, and which
   * account each serves. Selection is stability-first; on loss of the
   * current Mac, a SAME-account mirror takes over seamlessly (the open
   * thread reloads from it — mirrored store, same conversations), while a
   * different/unknown account NEVER takes over silently: the panel resets to
   * the conversation list and says whose mailbox it now shows.
   */
  setAgents(agents: IMessageAgent[]): void {
    this.agents = agents;
    const prevId = this.agentId;
    const pick = pickAgent(this.agentId, this.currentAccount, agents);

    this.agentSelect.replaceChildren();
    for (const a of agents) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = agentLabel(a); // "Name — account": the mailbox is legible at a glance
      this.agentSelect.append(opt);
    }
    this.agentSelect.hidden = agents.length === 0;

    if (!pick) {
      this.agentId = null;
      this.currentAccount = undefined;
      this.chat = null;
      this.view = "convs";
      if (this.isOpen) this.renderView();
      return;
    }
    this.agentId = pick.agent.id;
    this.currentAccount = pick.agent.account;
    this.agentSelect.value = pick.agent.id;

    if (pick.failedOver && !pick.changedAccount) {
      // Same-account mirror: keep the thread, reload it from the new Mac.
      this.note(`${pick.agent.name} took over (same account)`);
      if (this.isOpen) {
        this.ensureWatch();
        if (this.view === "thread" && this.chat) void this.reloadThread();
        void this.loadConversations(this.view === "convs");
      }
    } else if (pick.changedAccount) {
      this.chat = null;
      this.view = "convs";
      this.note(`device went offline — now showing ${agentLabel(pick.agent)}`);
      if (this.isOpen) void this.refresh();
    } else if (prevId === null) {
      if (this.isOpen) void this.refresh(); // first capable agent appeared
    } else {
      if (this.isOpen) this.ensureWatch(); // unchanged selection — re-arm (worker swaps)
    }
  }

  /** Live push from a watched agent. */
  onNew(agentId: string, msg: IMessageItem): void {
    if (!this.isOpen || agentId !== this.agentId) return;
    // Conversation list: bump preview + ordering (or refetch if it's new).
    const conv = this.convs.find((c) => c.guid === msg.chatGuid);
    if (conv) {
      conv.lastAt = msg.at || Date.now();
      conv.lastPreview = (msg.text.split("\n", 1)[0] ?? "").slice(0, 256);
      this.convs.sort((a, b) => b.lastAt - a.lastAt);
      if (this.view === "convs") this.renderView();
    } else {
      void this.loadConversations(false);
    }
    // Open thread: append (replacing a matching optimistic just-sent bubble).
    if (this.view === "thread" && this.chat && msg.chatGuid === this.chat.guid) {
      if (this.items.some((m) => m.rowid === msg.rowid)) return;
      if (msg.fromMe) {
        const i = this.items.findIndex((m) => m.rowid < 0 && m.text === msg.text);
        if (i >= 0) this.items.splice(i, 1);
      }
      this.items.push(msg);
      this.renderView();
    }
  }

  // --- data loading -------------------------------------------------------

  private async refresh(): Promise<void> {
    this.ensureWatch();
    await this.loadConversations(true);
  }

  private ensureWatch(): void {
    if (!this.agentId) return;
    void this.client.watchIMessages(this.agentId).catch(() => {
      /* agent mid-restart — the next device refresh re-arms */
    });
  }

  private async loadConversations(render: boolean): Promise<void> {
    const agentId = this.agentId;
    if (!agentId) {
      this.renderView();
      return;
    }
    const seq = ++this.seq;
    if (render) this.renderView(); // paints "loading…" until data lands
    try {
      const convs = await this.client.listIMessageConversations(agentId, CONV_LIMIT);
      if (seq !== this.seq && !render) return;
      this.convs = convs;
      this.clearError();
      if (this.view === "convs") this.renderView();
    } catch (err) {
      this.fail(err);
    }
  }

  private async openChat(conv: IMessageConversation): Promise<void> {
    this.chat = { guid: conv.guid, name: conv.name };
    this.items = [];
    this.view = "thread";
    this.renderView();
    await this.reloadThread();
  }

  /** (Re)load the open thread from the CURRENT agent — also the same-account
   *  failover path: a mirrored store serves the same chat guids. */
  private async reloadThread(): Promise<void> {
    const agentId = this.agentId;
    const chat = this.chat;
    if (!agentId || !chat) return;
    const seq = ++this.seq;
    try {
      const items = await this.client.listIMessageMessages(agentId, chat.guid, { limit: PAGE_LIMIT });
      if (seq !== this.seq || this.view !== "thread") return;
      this.items = items;
      this.clearError();
      this.renderView();
    } catch (err) {
      this.fail(err);
    }
  }

  private async loadEarlier(): Promise<void> {
    const agentId = this.agentId;
    const chat = this.chat;
    const oldest = this.items.find((m) => m.rowid >= 0);
    if (!agentId || !chat || !oldest) return;
    const seq = this.seq;
    try {
      const older = await this.client.listIMessageMessages(agentId, chat.guid, { limit: PAGE_LIMIT, beforeRowid: oldest.rowid });
      if (seq !== this.seq || this.view !== "thread") return;
      const known = new Set(this.items.map((m) => m.rowid));
      this.items = [...older.filter((m) => !known.has(m.rowid)), ...this.items];
      this.renderView();
    } catch (err) {
      this.fail(err);
    }
  }

  private async send(target: { chatGuid?: string; handle?: string }, text: string, after: () => void): Promise<void> {
    const agentId = this.agentId;
    if (!agentId || !text.trim()) return;
    try {
      await this.client.sendIMessage(agentId, target, text);
      this.clearError();
      // Optimistic bubble until the poller's push replaces it (~2s).
      if (this.view === "thread" && this.chat && target.chatGuid === this.chat.guid) {
        this.items.push({
          rowid: -++this.optimistic,
          chatGuid: this.chat.guid,
          fromMe: true,
          text,
          at: Date.now(),
          hasAttachments: false,
        });
        this.renderView();
      }
      after();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.errorEl.dataset["kind"] = "error";
    this.errorEl.textContent = err instanceof Error ? err.message : String(err);
  }

  /** Informational status (e.g. failover notes) — same line, muted styling. */
  private note(text: string): void {
    this.errorEl.dataset["kind"] = "note";
    this.errorEl.textContent = text;
  }

  /** Success path: clear a stale ERROR, but leave informational notes up —
   *  "Mac B took over" must survive the very reload it announces. */
  private clearError(): void {
    if (this.errorEl.dataset["kind"] !== "note") this.errorEl.textContent = "";
  }

  // --- rendering ----------------------------------------------------------

  private renderView(): void {
    this.body.replaceChildren();
    if (!this.agentId) {
      const empty = document.createElement("div");
      empty.className = "msg-empty";
      empty.textContent = "no device with iMessage is online";
      this.body.append(empty);
      return;
    }
    if (this.view === "thread" && this.chat) this.renderThread();
    else if (this.view === "compose") this.renderCompose();
    else this.renderConvs();
  }

  private renderConvs(): void {
    const newBtn = document.createElement("button");
    newBtn.className = "msg-new update-banner-btn";
    newBtn.textContent = "New message";
    newBtn.addEventListener("click", () => {
      this.view = "compose";
      this.renderView();
    });
    this.body.append(newBtn);
    if (this.convs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "msg-empty";
      empty.textContent = "loading conversations…";
      this.body.append(empty);
      return;
    }
    for (const c of this.convs) {
      const row = document.createElement("div");
      row.className = "msg-conv";
      row.title = c.participants.join(", ");
      const top = document.createElement("div");
      top.className = "msg-conv-top";
      const name = document.createElement("span");
      name.className = "msg-conv-name";
      name.textContent = c.name || "(unnamed)";
      const time = document.createElement("span");
      time.className = "msg-conv-time";
      time.textContent = c.lastAt ? shortTime(c.lastAt) : "";
      top.append(name, time);
      const preview = document.createElement("div");
      preview.className = "msg-conv-preview";
      preview.textContent = c.lastPreview;
      row.append(top, preview);
      row.addEventListener("click", () => void this.openChat(c));
      this.body.append(row);
    }
  }

  private renderThread(): void {
    const chat = this.chat!;
    const head = document.createElement("div");
    head.className = "msg-thread-head";
    const back = document.createElement("button");
    back.className = "msg-back";
    back.textContent = "‹";
    back.setAttribute("aria-label", "back to conversations");
    back.addEventListener("click", () => {
      this.view = "convs";
      this.chat = null;
      this.seq++;
      this.renderView();
      void this.loadConversations(false);
    });
    const name = document.createElement("span");
    name.className = "msg-thread-name";
    name.textContent = chat.name;
    head.append(back, name);

    const thread = document.createElement("div");
    thread.className = "msg-thread";
    if (this.items.length >= PAGE_LIMIT) {
      const earlier = document.createElement("button");
      earlier.className = "msg-earlier";
      earlier.textContent = "earlier…";
      earlier.addEventListener("click", () => void this.loadEarlier());
      thread.append(earlier);
    }
    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "msg-empty";
      empty.textContent = "loading…";
      thread.append(empty);
    }
    for (const m of this.items) {
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      bubble.dataset["me"] = String(m.fromMe);
      if (m.rowid < 0) bubble.dataset["pending"] = "true";
      const text = document.createElement("div");
      text.className = "msg-bubble-text";
      text.textContent = m.text;
      const meta = document.createElement("div");
      meta.className = "msg-bubble-meta";
      meta.textContent = m.fromMe ? shortTime(m.at) : `${m.sender ?? ""} · ${shortTime(m.at)}`.replace(/^ · /, "");
      bubble.append(text, meta);
      thread.append(bubble);
    }

    const compose = document.createElement("div");
    compose.className = "msg-compose";
    const input = document.createElement("textarea");
    input.rows = 2;
    input.placeholder = "reply…";
    input.spellcheck = true;
    const sendBtn = document.createElement("button");
    sendBtn.className = "update-banner-btn";
    sendBtn.textContent = "Send";
    const doSend = (): void => {
      const text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      void this.send({ chatGuid: chat.guid }, text, () => {
        input.value = "";
      }).finally(() => {
        sendBtn.disabled = false;
        input.focus();
      });
    };
    sendBtn.addEventListener("click", doSend);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    compose.append(input, sendBtn);

    this.body.append(head, thread, compose);
    thread.scrollTop = thread.scrollHeight;
  }

  private renderCompose(): void {
    const head = document.createElement("div");
    head.className = "msg-thread-head";
    const back = document.createElement("button");
    back.className = "msg-back";
    back.textContent = "‹";
    back.setAttribute("aria-label", "back to conversations");
    back.addEventListener("click", () => {
      this.view = "convs";
      this.renderView();
    });
    const name = document.createElement("span");
    name.className = "msg-thread-name";
    name.textContent = "new message";
    head.append(back, name);

    const form = document.createElement("div");
    form.className = "msg-compose-new";
    const to = document.createElement("input");
    to.type = "text";
    to.placeholder = "to: phone number or Apple ID";
    to.spellcheck = false;
    const input = document.createElement("textarea");
    input.rows = 3;
    input.placeholder = "message…";
    const hint = document.createElement("div");
    hint.className = "msg-hint";
    hint.textContent = "New threads are best-effort on modern macOS — replying inside an existing conversation is the reliable path.";
    const sendBtn = document.createElement("button");
    sendBtn.className = "update-banner-btn";
    sendBtn.textContent = "Send";
    sendBtn.addEventListener("click", () => {
      const handle = to.value.trim();
      const text = input.value.trim();
      if (!handle || !text) return;
      sendBtn.disabled = true;
      void this.send({ handle }, text, () => {
        this.view = "convs";
        this.renderView();
        void this.loadConversations(false);
      }).finally(() => {
        sendBtn.disabled = false;
      });
    });
    form.append(to, input, hint, sendBtn);
    this.body.append(head, form);
    to.focus();
  }
}

/** Compact timestamp: time for today, date otherwise. Locale-formatted. */
function shortTime(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString();
}
