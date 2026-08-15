import { z } from "zod";
import { DeviceId, RunId } from "../ids.js";

export const RunProvider = z.enum(["etch", "codex", "claude", "generic"]);
export type RunProvider = z.infer<typeof RunProvider>;
export const ProviderAdapterMode = z.enum(["structured", "reduced", "generic", "unavailable"]);
export type ProviderAdapterMode = z.infer<typeof ProviderAdapterMode>;
export const RunWorktreeMode = z.enum(["isolated", "shared", "read-only"]);
export type RunWorktreeMode = z.infer<typeof RunWorktreeMode>;
export const RunWorktreeRef = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
  branch: z.string().min(1).max(500),
});
export type RunWorktreeRef = z.infer<typeof RunWorktreeRef>;

export const RunState = z.enum([
  "starting",
  "idle",
  "running",
  "needs-input",
  "completed",
  "failed",
  "interrupted",
  "closed",
]);
export type RunState = z.infer<typeof RunState>;

export const ProviderRecord = z.object({
  id: RunProvider,
  /** Binary/config exists locally, even when no supported adapter was proven. */
  installed: z.boolean().optional(),
  present: z.boolean(),
  version: z.string().max(200).optional(),
  /** What Glass actually proved it can launch, not an optimistic feature list. */
  adapter: ProviderAdapterMode.optional(),
  /** Content-free readiness explanation suitable for diagnostics. */
  detail: z.string().max(500).optional(),
  capabilities: z.array(z.string().min(1).max(100)).max(200),
});
export type ProviderRecord = z.infer<typeof ProviderRecord>;

export const RunRecord = z.object({
  id: RunId,
  deviceId: DeviceId,
  provider: RunProvider,
  title: z.string().min(1).max(120),
  state: RunState,
  attention: z.enum(["clarification", "approval", "provider-input"]).optional(),
  cwd: z.string().max(4096).optional(),
  providerSessionId: z.string().max(512).optional(),
  providerStoredSessionId: z.string().max(512).optional(),
  profile: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  modelProvider: z.string().max(100).optional(),
  reasoningEffort: z.string().max(50).optional(),
  worktreeMode: RunWorktreeMode,
  worktreeRef: RunWorktreeRef.optional(),
  /** Provider-reported aggregate counters/cost only; never transcript content. */
  usage: z.record(z.unknown()).optional(),
  parentRunId: RunId.optional(),
  rootRunId: RunId.optional(),
  capabilities: z.array(z.string().min(1).max(100)).max(200),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
});
export type RunRecord = z.infer<typeof RunRecord>;

const SAFE_USAGE_KEYS = new Set([
  "input", "output", "cache_read", "cache_write", "total", "last",
  "context_used", "context_max", "context_percent", "compressions",
  "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
  "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens",
  "model_context_window", "cost_usd", "dev_credits_spent_micros",
  "model", "provider", "cost_status", "currency", "service_tier",
]);
const SAFE_USAGE_STRING_KEYS = new Set(["model", "provider", "cost_status", "currency", "service_tier"]);

/** Strip content-bearing or unbounded provider fields before usage reaches durable metadata. */
export function sanitizeRunUsage(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (!SAFE_USAGE_KEYS.has(key)) continue;
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) output[key] = item;
    else if (typeof item === "boolean") output[key] = item;
    else if (typeof item === "string" && SAFE_USAGE_STRING_KEYS.has(key)) output[key] = item.slice(0, 100);
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = sanitizeRunUsage(item, depth + 1);
      if (Object.keys(nested).length) output[key] = nested;
    }
  }
  return output;
}

export const RunEventKind = z.enum([
  "status",
  "assistant.start",
  "assistant.delta",
  "assistant.complete",
  "input.required",
  "approval.required",
  "subagent.start",
  "subagent.thinking",
  "subagent.tool",
  "subagent.complete",
  "tool",
  "usage",
  "error",
  "notice",
]);
export type RunEventKind = z.infer<typeof RunEventKind>;

export const RunEventRecord = z.object({
  runId: RunId,
  seq: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  kind: RunEventKind,
  data: z.record(z.unknown()),
});
export type RunEventRecord = z.infer<typeof RunEventRecord>;

export const RunCreate = z.object({
  type: z.literal("run.create"),
  deviceId: DeviceId,
  provider: RunProvider.default("etch"),
  title: z.string().min(1).max(120).optional(),
  cwd: z.string().max(4096).optional(),
  prompt: z.string().max(1_000_000).optional(),
  model: z.string().max(200).optional(),
  providerSessionId: z.string().max(512).optional(),
  providerStoredSessionId: z.string().max(512).optional(),
  /** Existing provider-owned worktree metadata carried only when resuming. */
  worktreeRef: RunWorktreeRef.optional(),
  profile: z.string().max(100).optional(),
  modelProvider: z.string().max(100).optional(),
  reasoningEffort: z.string().max(50).optional(),
  fast: z.boolean().optional(),
  worktreeMode: RunWorktreeMode.default("shared"),
});
export type RunCreate = z.infer<typeof RunCreate>;

export const RunCreated = z.object({ type: z.literal("run.created"), run: RunRecord });
export const RunList = z.object({ type: z.literal("run.list"), deviceId: DeviceId.optional() });
export const RunListed = z.object({ type: z.literal("run.listed"), runs: z.array(RunRecord) });
/** Agent -> sessiond inventory request, issued after every Hub registration. */
export const RunInventory = z.object({ type: z.literal("run.inventory") });
/** Authoritative content-free inventory for one sessiond process lifetime. */
export const RunInventorySnapshot = z.object({
  type: z.literal("run.inventory.snapshot"),
  deviceId: DeviceId,
  instanceId: z.string().uuid(),
  capabilities: z.array(z.string().min(1).max(100)).max(100),
  runs: z.array(RunRecord),
});
export const RunSubscribe = z.object({
  type: z.literal("run.subscribe"),
  runId: RunId,
  since: z.number().int().nonnegative().default(0),
});
export const RunSnapshot = z.object({
  type: z.literal("run.snapshot"),
  run: RunRecord,
  events: z.array(RunEventRecord),
});
export const RunSubmit = z.object({
  type: z.literal("run.submit"),
  runId: RunId,
  text: z.string().min(1).max(1_000_000),
});
export const RunRespond = z.object({
  type: z.literal("run.respond"),
  runId: RunId,
  requestId: z.string().min(1).max(200),
  response: z.string().max(1_000_000),
});
export type RunRespond = z.infer<typeof RunRespond>;
export const RunControl = z.object({
  type: z.literal("run.control"),
  runId: RunId,
  action: z.enum(["interrupt", "close", "pause-delegation", "resume-delegation", "interrupt-subagent"]),
  targetId: z.string().max(512).optional(),
});
export type RunControl = z.infer<typeof RunControl>;
export const RunUpdated = z.object({ type: z.literal("run.updated"), run: RunRecord });
export const RunEvent = z.object({ type: z.literal("run.event"), event: RunEventRecord });
export const RunQueryName = z.enum(["session.info", "sessions.active", "commands.catalog", "delegation.status", "orchestration.status"]);
export type RunQueryName = z.infer<typeof RunQueryName>;
export const RunQuery = z.object({
  type: z.literal("run.query"),
  runId: RunId,
  requestId: z.string().min(1).max(200),
  query: RunQueryName,
});
export const RunQueried = z.object({
  type: z.literal("run.queried"),
  runId: RunId,
  requestId: z.string().min(1).max(200),
  query: RunQueryName,
  result: z.record(z.unknown()),
});
export const RunAttachFile = z.object({
  type: z.literal("run.attach"),
  runId: RunId,
  requestId: z.string().min(1).max(200),
  path: z.string().max(4096).optional(),
  dataUrl: z.string().max(16 * 1024 * 1024).optional(),
  name: z.string().max(255).optional(),
});
export const RunFileAttached = z.object({
  type: z.literal("run.file-attached"),
  runId: RunId,
  requestId: z.string().min(1).max(200),
  result: z.record(z.unknown()),
});

export const WorkspaceRecord = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  runIds: z.array(RunId).max(1000),
  layout: z.object({ selected: RunId.nullable().optional() }).strict(),
  updatedAt: z.number().int().nonnegative(),
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;
export const WorkspacePut = z.object({ type: z.literal("workspace.put"), workspace: WorkspaceRecord });
export const WorkspaceList = z.object({ type: z.literal("workspace.list") });
export const WorkspaceListed = z.object({ type: z.literal("workspace.listed"), workspaces: z.array(WorkspaceRecord) });

export const RunMessage = z.discriminatedUnion("type", [
  RunCreate,
  RunCreated,
  RunList,
  RunListed,
  RunInventory,
  RunInventorySnapshot,
  RunSubscribe,
  RunSnapshot,
  RunSubmit,
  RunRespond,
  RunControl,
  RunUpdated,
  RunEvent,
  RunQuery,
  RunQueried,
  RunAttachFile,
  RunFileAttached,
  WorkspacePut,
  WorkspaceList,
  WorkspaceListed,
]);
export type RunMessage = z.infer<typeof RunMessage>;
