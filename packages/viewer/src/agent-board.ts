import type { DeviceRecord, RunEventRecord, RunProvider, RunRecord, RunWorktreeMode, WorkspaceRecord } from "@glass/protocol";
import type { HubClient } from "./hub-client.js";
import { applyBackendUpdate, backendStatus, isNative, type BackendStatus } from "./native.js";

const WORKSPACE_ID = "agents";

export class AgentBoard {
  readonly el = document.createElement("main");
  private readonly runs = new Map<string, RunRecord>();
  private readonly events = new Map<string, RunEventRecord[]>();
  private devices: DeviceRecord[] = [];
  private selected: RunRecord["id"] | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly client: HubClient) {
    this.el.className = "agent-board";
    this.el.hidden = true;
    this.render();
  }

  setDevices(devices: DeviceRecord[]): void {
    this.devices = devices;
    if (!this.el.hidden) this.render();
  }

  replaceRuns(runs: RunRecord[]): void {
    this.runs.clear();
    for (const run of runs) this.runs.set(run.id, run);
    if (this.selected && !this.runs.has(this.selected)) this.selected = null;
    if (!this.selected) this.selected = runs[0]?.id ?? null;
    this.render();
  }

  upsert(run: RunRecord): void {
    this.runs.set(run.id, run);
    this.selected ??= run.id;
    this.render();
    this.scheduleSave();
  }

  append(event: RunEventRecord): void {
    const list = this.events.get(event.runId) ?? [];
    if (!list.some((item) => item.seq === event.seq)) list.push(event);
    list.sort((a, b) => a.seq - b.seq);
    if (list.length > 5000) list.splice(0, list.length - 5000);
    this.events.set(event.runId, list);
    if (this.selected === event.runId) this.render();
  }

  show(value: boolean): void {
    this.el.hidden = !value;
    if (value) {
      this.render();
      const run = this.selected ? this.runs.get(this.selected) : undefined;
      if (run) void this.client.subscribeRun(run.deviceId, run.id, this.lastSeq(run.id)).catch(() => undefined);
    }
  }

  get visible(): boolean { return !this.el.hidden; }

  restore(workspaces: WorkspaceRecord[]): void {
    const saved = workspaces.find((workspace) => workspace.id === WORKSPACE_ID);
    const layout = saved?.layout as { selected?: unknown } | undefined;
    if (typeof layout?.selected === "string" && this.runs.has(layout.selected)) this.selected = layout.selected as RunRecord["id"];
    this.render();
  }

  private render(): void {
    this.el.replaceChildren();
    const header = document.createElement("header");
    header.className = "agent-board-head";
    const title = document.createElement("div");
    title.innerHTML = "<strong>Agent Board</strong><span>Etch primary · Codex and Claude available per device</span>";
    const create = document.createElement("button");
    create.textContent = "+ run";
    create.addEventListener("click", () => this.openCreate());
    const doctor = document.createElement("button");
    doctor.textContent = "doctor";
    doctor.addEventListener("click", () => void this.openDoctor());
    header.append(title, doctor, create);

    const content = document.createElement("div");
    content.className = "agent-board-content";
    const lanes = document.createElement("section");
    lanes.className = "agent-lanes";
    const groups: Array<{ label: string; states: RunRecord["state"][] }> = [
      { label: "Needs you", states: ["needs-input"] },
      { label: "Active", states: ["starting", "idle", "running"] },
      { label: "Finished", states: ["completed", "failed", "interrupted", "closed"] },
    ];
    for (const group of groups) lanes.append(this.renderLane(group.label, group.states));
    content.append(lanes, this.renderDetail());
    this.el.append(header, content);
  }

  private renderLane(label: string, states: RunRecord["state"][]): HTMLElement {
    const lane = document.createElement("div");
    lane.className = "agent-lane";
    const heading = document.createElement("h2");
    const rows = [...this.runs.values()].filter((run) => states.includes(run.state)).sort((a, b) => b.updatedAt - a.updatedAt);
    heading.textContent = `${label} ${rows.length}`;
    lane.append(heading);
    for (const run of rows) {
      const card = document.createElement("button");
      card.className = "agent-card";
      card.dataset["selected"] = String(run.id === this.selected);
      card.dataset["state"] = run.state;
      const name = document.createElement("strong");
      name.textContent = run.title;
      const meta = document.createElement("span");
      meta.textContent = `${run.provider} · ${run.state}${run.attention ? ` (${run.attention})` : ""} · ${this.deviceName(run.deviceId)}`;
      card.append(name, meta);
      card.addEventListener("click", () => {
        this.selected = run.id;
        void this.client.subscribeRun(run.deviceId, run.id, this.lastSeq(run.id)).catch(() => undefined);
        this.render();
        this.scheduleSave();
      });
      lane.append(card);
    }
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "none";
      lane.append(empty);
    }
    return lane;
  }

  private renderDetail(): HTMLElement {
    const detail = document.createElement("section");
    detail.className = "agent-detail";
    const run = this.selected ? this.runs.get(this.selected) : undefined;
    if (!run) {
      const empty = document.createElement("div");
      empty.className = "agent-detail-empty";
      empty.textContent = "Create an Etch run, or select a run to inspect its live event stream.";
      detail.append(empty);
      return detail;
    }

    const head = document.createElement("div");
    head.className = "agent-detail-head";
    const label = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = run.title;
    const meta = document.createElement("span");
    meta.textContent = `${run.provider} · ${run.state}${run.cwd ? ` · ${run.cwd}` : ""}`;
    const capabilities = document.createElement("small");
    capabilities.textContent = run.capabilities.length ? run.capabilities.join(" · ") : "capabilities pending";
    label.append(title, meta, capabilities);
    const controls = document.createElement("div");
    const resumeId = run.providerStoredSessionId || run.providerSessionId;
    if (run.state === "interrupted" && resumeId && run.provider !== "generic") {
      const resume = document.createElement("button");
      resume.textContent = "resume";
      resume.addEventListener("click", () => {
        resume.disabled = true;
        void this.client.createRun(run.deviceId, {
          provider: run.provider,
          title: `${run.title} (resumed)`,
          ...(run.cwd ? { cwd: run.cwd } : {}),
          ...(run.profile ? { profile: run.profile } : {}),
          ...(run.model ? { model: run.model } : {}),
          ...(run.modelProvider ? { modelProvider: run.modelProvider } : {}),
          ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
          ...(run.providerSessionId ? { providerSessionId: run.providerSessionId } : {}),
          ...(run.providerStoredSessionId ? { providerStoredSessionId: run.providerStoredSessionId } : {}),
          ...(run.worktreeRef ? { worktreeRef: run.worktreeRef } : {}),
          worktreeMode: run.worktreeMode,
        }).then((resumed) => {
          this.upsert(resumed);
          this.selected = resumed.id;
          this.render();
        }).catch((error) => {
          this.localEvent(run, "error", { message: error instanceof Error ? error.message : String(error) });
          resume.disabled = false;
        });
      });
      controls.append(resume);
    }
    for (const [text, action] of [
      ["interrupt", "interrupt"],
      ["close", "close"],
    ] as const) {
      const button = document.createElement("button");
      button.textContent = text;
      button.addEventListener("click", () => this.client.controlRun(run.deviceId, run.id, action));
      controls.append(button);
    }
    if (run.capabilities.includes("rpc.delegation.control")) {
      for (const [text, action] of [["pause agents", "pause-delegation"], ["resume agents", "resume-delegation"]] as const) {
        const button = document.createElement("button");
        button.textContent = text;
        button.addEventListener("click", () => this.client.controlRun(run.deviceId, run.id, action));
        controls.append(button);
      }
    }
    if (run.provider === "etch") {
      const inspect = document.createElement("button");
      inspect.textContent = "inspect";
      inspect.addEventListener("click", () => {
        void Promise.all([
          this.client.queryRun(run.deviceId, run.id, "session.info"),
          this.client.queryRun(run.deviceId, run.id, "delegation.status"),
          this.client.queryRun(run.deviceId, run.id, "orchestration.status"),
        ]).then(([session, delegation, orchestration]) => this.localEvent(run, "status", { session, delegation, orchestration }))
          .catch((error) => this.localEvent(run, "error", { message: error instanceof Error ? error.message : String(error) }));
      });
      const commands = document.createElement("button");
      commands.textContent = "commands";
      commands.addEventListener("click", () => {
        void this.client.queryRun(run.deviceId, run.id, "commands.catalog")
          .then((result) => this.localEvent(run, "notice", result))
          .catch((error) => this.localEvent(run, "error", { message: error instanceof Error ? error.message : String(error) }));
      });
      const attach = document.createElement("button");
      attach.textContent = "attach";
      attach.addEventListener("click", () => this.pickAttachment(run));
      controls.append(inspect);
      if (run.capabilities.includes("rpc.commands.catalog")) controls.append(commands);
      if (run.capabilities.includes("rpc.file.attach")) controls.append(attach);
    }
    head.append(label, controls);

    const stream = document.createElement("div");
    stream.className = "agent-stream";
    for (const event of this.events.get(run.id) ?? []) stream.append(this.renderEvent(event));
    if (!stream.childElementCount) stream.textContent = "Waiting for provider events…";

    const composer = document.createElement("form");
    composer.className = "agent-compose";
    const input = document.createElement("textarea");
    input.placeholder = run.state === "needs-input" ? "Answer the pending request…" : "Send the next instruction…";
    input.rows = 3;
    const send = document.createElement("button");
    send.type = "submit";
    send.textContent = run.state === "needs-input" ? "respond" : "send";
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const pending = [...(this.events.get(run.id) ?? [])].reverse().find((item) =>
        item.kind === "input.required" || item.kind === "approval.required",
      );
      const requestId = pending && typeof pending.data.requestId === "string" ? pending.data.requestId : undefined;
      if (run.state === "needs-input" && requestId) this.client.respondRun(run.deviceId, run.id, requestId, text);
      else this.client.submitRun(run.deviceId, run.id, text);
      input.value = "";
    });
    composer.append(input, send);
    const pendingApproval = [...(this.events.get(run.id) ?? [])].reverse().find((item) => item.kind === "approval.required");
    if (run.state === "needs-input" && pendingApproval && typeof pendingApproval.data.requestId === "string") {
      const approvals = document.createElement("div");
      approvals.className = "agent-approval-actions";
      for (const [label, response] of [["approve once", "once"], ["approve session", "session"], ["deny", "deny"]] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => this.client.respondRun(run.deviceId, run.id, pendingApproval.data.requestId as string, response));
        approvals.append(button);
      }
      detail.append(head, stream, approvals, composer);
    } else {
      detail.append(head, stream, composer);
    }
    queueMicrotask(() => { stream.scrollTop = stream.scrollHeight; });
    return detail;
  }

  private renderEvent(event: RunEventRecord): HTMLElement {
    const row = document.createElement("div");
    row.className = "agent-event";
    row.dataset["kind"] = event.kind;
    if (event.kind.startsWith("subagent.")) row.dataset["subagent"] = "true";
    const badge = document.createElement("span");
    badge.textContent = event.kind;
    const text = document.createElement("pre");
    const preferred = event.data.text ?? event.data.message ?? event.data.summary ?? event.data.question ?? event.data.state;
    text.textContent = typeof preferred === "string" ? preferred : JSON.stringify(event.data, null, 2);
    row.append(badge, text);
    return row;
  }

  private openCreate(): void {
    const overlay = document.createElement("div");
    overlay.className = "tset-overlay";
    const panel = document.createElement("form");
    panel.className = "tset-panel agent-create";
    const title = document.createElement("h2");
    title.textContent = "New agent run";
    const agent = document.createElement("select");
    const devices = this.devices.filter((device) => device.roles.includes("agent") && device.state === "connected");
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = device.name;
      agent.append(option);
    }
    const provider = document.createElement("select");
    const worktree = document.createElement("select");
    for (const [value, label] of [["isolated", "Isolated worktree"], ["shared", "Shared checkout"]] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      worktree.append(option);
    }
    const refreshProviders = (): void => {
      provider.replaceChildren();
      const device = devices.find((item) => item.id === agent.value);
      const records = device?.providers?.filter((item) => item.present) ?? [];
      const available = records.map((item) => item.id);
      const ordered = (["etch", "codex", "claude", "generic"] as RunProvider[]).filter((id) => available.includes(id));
      for (const id of ordered.length ? ordered : ["etch" as const]) {
        const option = document.createElement("option");
        option.value = id;
        const record = records.find((item) => item.id === id);
        const mode = record?.adapter === "reduced" ? " · reduced" : record?.adapter === "structured" ? " · structured" : "";
        option.textContent = `${id === "etch" ? "Etch (primary)" : id}${mode}`;
        option.title = record?.detail || "";
        provider.append(option);
      }
      worktree.value = provider.value === "etch" ? "isolated" : "shared";
    };
    agent.addEventListener("change", refreshProviders);
    provider.addEventListener("change", () => { worktree.value = provider.value === "etch" ? "isolated" : "shared"; });
    refreshProviders();
    const name = document.createElement("input");
    name.placeholder = "Run title";
    const cwd = document.createElement("input");
    cwd.placeholder = "Working directory (optional)";
    const prompt = document.createElement("textarea");
    prompt.placeholder = "What should this agent do?";
    prompt.rows = 6;
    const profile = document.createElement("input");
    profile.placeholder = "Etch profile (optional)";
    const model = document.createElement("input");
    model.placeholder = "Model (optional)";
    const modelProvider = document.createElement("input");
    modelProvider.placeholder = "Etch model provider (optional)";
    const reasoning = document.createElement("input");
    reasoning.placeholder = "Reasoning effort (optional)";
    const actions = document.createElement("div");
    const launch = document.createElement("button");
    launch.type = "submit";
    launch.textContent = "launch";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "cancel";
    cancel.addEventListener("click", () => overlay.remove());
    actions.append(cancel, launch);
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!agent.value || !prompt.value.trim()) return;
      launch.disabled = true;
      void this.client.createRun(agent.value, {
        provider: provider.value as RunProvider,
        ...(name.value.trim() ? { title: name.value.trim() } : {}),
        ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
        ...(profile.value.trim() ? { profile: profile.value.trim() } : {}),
        ...(model.value.trim() ? { model: model.value.trim() } : {}),
        ...(modelProvider.value.trim() ? { modelProvider: modelProvider.value.trim() } : {}),
        ...(reasoning.value.trim() ? { reasoningEffort: reasoning.value.trim() } : {}),
        worktreeMode: worktree.value as RunWorktreeMode,
        prompt: prompt.value.trim(),
      }).then((run) => {
        this.upsert(run);
        this.selected = run.id;
        overlay.remove();
      }).catch((error) => {
        launch.disabled = false;
        launch.textContent = error instanceof Error ? error.message : String(error);
      });
    });
    for (const [label, input] of [
      ["Device", agent], ["Provider", provider], ["Worktree", worktree], ["Title", name], ["Directory", cwd],
      ["Etch profile", profile], ["Model", model], ["Model provider", modelProvider], ["Reasoning", reasoning], ["Prompt", prompt],
    ] as const) {
      const row = document.createElement("label");
      row.textContent = label;
      row.append(input);
      panel.append(row);
    }
    panel.prepend(title);
    panel.append(actions);
    overlay.append(panel);
    document.body.append(overlay);
    prompt.focus();
  }

  private async openDoctor(): Promise<void> {
    const overlay = document.createElement("div");
    overlay.className = "tset-overlay";
    const panel = document.createElement("div");
    panel.className = "tset-panel agent-doctor";
    panel.setAttribute("role", "dialog");
    panel.tabIndex = -1;
    const title = document.createElement("h2");
    title.textContent = "Glass Doctor";
    const intro = document.createElement("p");
    intro.textContent = "Content-free lifecycle and provider readiness. No prompts, output, approvals, or transcripts are included.";
    let local: BackendStatus = { running: false };
    try { local = await backendStatus(); }
    catch (error) {
      intro.textContent += ` Local backend status failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const lifecycle = local.backendStatus ?? local;
    const report = {
      generatedAt: new Date().toISOString(),
      localBackend: local,
      devices: this.devices.map((device) => ({
        id: device.id,
        name: device.name,
        state: device.state,
        appVersion: device.appVersion,
        sessiondInstanceId: device.sessiondInstanceId,
        providers: (device.providers ?? []).map((provider) => ({
          id: provider.id,
          installed: provider.installed ?? provider.present,
          usable: provider.present,
          version: provider.version,
          adapter: provider.adapter,
          detail: provider.detail,
          capabilities: provider.capabilities,
        })),
      })),
    };
    const body = document.createElement("pre");
    body.className = "doctor-report";
    body.textContent = JSON.stringify(report, null, 2);
    const actions = document.createElement("div");
    const copy = document.createElement("button");
    copy.textContent = "copy diagnostics";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(body.textContent || "").then(() => { copy.textContent = "copied"; });
    });
    const needsRestart = isNative() && (local.serviceUpdate?.pending || lifecycle.sessiondUpdatePending);
    if (needsRestart) {
      const apply = document.createElement("button");
      apply.textContent = local.serviceUpdate?.pending ? "restart and update backend" : "restart backend to finish update";
      apply.addEventListener("click", () => {
        if (!window.confirm("Restarting the backend will end every local terminal and agent run on this Mac. Continue?")) return;
        apply.disabled = true;
        apply.textContent = "restarting…";
        void applyBackendUpdate().then(() => {
          overlay.remove();
          void this.openDoctor();
        }).catch((error) => {
          apply.disabled = false;
          apply.textContent = error instanceof Error ? error.message : String(error);
        });
      });
      actions.append(apply);
    }
    const close = document.createElement("button");
    close.textContent = "close";
    close.addEventListener("click", () => overlay.remove());
    actions.append(copy, close);
    panel.append(title, intro, body, actions);
    overlay.append(panel);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.append(overlay);
    panel.focus();
  }

  private deviceName(id: string): string { return this.devices.find((device) => device.id === id)?.name ?? id; }
  private lastSeq(runId: string): number {
    return Math.max(0, ...(this.events.get(runId) ?? []).filter((event) => event.seq < 1_000_000_000).map((event) => event.seq));
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.client.putWorkspace({
        id: WORKSPACE_ID,
        title: "Agent Board",
        runIds: [...this.runs.keys()] as WorkspaceRecord["runIds"],
        layout: { selected: this.selected },
        updatedAt: Date.now(),
      });
    }, 200);
  }

  private localEvent(run: RunRecord, kind: RunEventRecord["kind"], data: Record<string, unknown>): void {
    this.append({ runId: run.id, seq: 1_000_000_000 + (Date.now() % 1_000_000_000), at: Date.now(), kind, data });
  }

  private pickAttachment(run: RunRecord): void {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result !== "string") return;
        void this.client.attachRunFile(run.deviceId, run.id, { dataUrl: reader.result, name: file.name })
          .then((result) => this.localEvent(run, "notice", { attachment: result }))
          .catch((error) => this.localEvent(run, "error", { message: error instanceof Error ? error.message : String(error) }));
      });
      reader.readAsDataURL(file);
    });
    input.click();
  }
}
