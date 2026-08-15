import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RunRecord, WorkspaceRecord, sanitizeRunUsage, type RunRecord as Run, type WorkspaceRecord as Workspace } from "@glass/protocol";

interface State {
  v: 1;
  runs: Run[];
  workspaces: Workspace[];
}

/** Durable Glass-owned routing/presentation metadata. Provider transcripts and
 * checkpoints remain in their provider-native stores. */
export class RunStore {
  private readonly runs = new Map<string, Run>();
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
      for (const value of raw.runs ?? []) {
        const parsed = RunRecord.safeParse(value);
        if (parsed.success) {
          const usage = sanitizeRunUsage(parsed.data.usage);
          const run = structuredClone(parsed.data);
          if (Object.keys(usage).length) run.usage = usage;
          else delete run.usage;
          this.runs.set(run.id, run);
        }
      }
      for (const value of raw.workspaces ?? []) {
        const parsed = WorkspaceRecord.safeParse(value);
        if (parsed.success) this.workspaces.set(parsed.data.id, parsed.data);
      }
    } catch {
      // Missing or invalid state starts empty; the next successful write repairs it.
    }
  }

  putRun(run: Run): boolean {
    const existing = this.runs.get(run.id);
    if (existing && existing.updatedAt > run.updatedAt) return false;
    const stored = this.sanitized(run);
    this.runs.set(run.id, stored);
    this.flush();
    return true;
  }

  listRuns(deviceId?: string): Run[] {
    return [...this.runs.values()]
      .filter((run) => deviceId === undefined || run.deviceId === deviceId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((run) => structuredClone(run));
  }

  /**
   * Reconcile durable presentation metadata with one owning sessiond's
   * authoritative in-memory inventory. A daemon restart cannot resurrect the
   * provider process, so any formerly-live record absent from the snapshot is
   * terminally interrupted instead of lingering in Active/Needs you forever.
   */
  reconcileDevice(deviceId: string, inventory: Run[], at = Date.now()): Run[] {
    const liveIds = new Set(inventory.map((run) => run.id));
    const changed: Run[] = [];
    let dirty = false;
    for (const run of inventory) {
      const existing = this.runs.get(run.id);
      if (existing && existing.updatedAt > run.updatedAt) continue;
      const stored = this.sanitized(run);
      this.runs.set(stored.id, stored);
      changed.push(structuredClone(stored));
      dirty = true;
    }
    for (const run of this.runs.values()) {
      if (run.deviceId !== deviceId || liveIds.has(run.id)) continue;
      if (!["starting", "idle", "running", "needs-input"].includes(run.state)) continue;
      run.state = "interrupted";
      delete run.attention;
      run.updatedAt = Math.max(at, run.updatedAt + 1);
      changed.push(structuredClone(run));
      dirty = true;
    }
    if (dirty) this.flush();
    return changed;
  }

  putWorkspace(workspace: Workspace): boolean {
    const existing = this.workspaces.get(workspace.id);
    if (existing && existing.updatedAt > workspace.updatedAt) return false;
    this.workspaces.set(workspace.id, structuredClone(workspace));
    this.flush();
    return true;
  }

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((workspace) => structuredClone(workspace));
  }

  private flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const state: State = { v: 1, runs: this.listRuns(), workspaces: this.listWorkspaces() };
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  private sanitized(run: Run): Run {
    const usage = sanitizeRunUsage(run.usage);
    const stored = structuredClone(run);
    if (Object.keys(usage).length) stored.usage = usage;
    else delete stored.usage;
    return stored;
  }
}
