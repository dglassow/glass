import { spawnSync } from "node:child_process";
import type { ProviderRecord } from "@glass/protocol";

interface Probe {
  ok: boolean;
  output: string;
  detail?: string;
}

const firstLine = (value: string): string | undefined => value.trim().split("\n")[0]?.trim() || undefined;

function probe(binary: string, args: string[], timeout = 5000): Probe {
  try {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    if (result.error) return { ok: false, output, detail: result.error.message };
    if (result.status !== 0) return { ok: false, output, detail: firstLine(output) || `exited ${result.status}` };
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: "", detail: error instanceof Error ? error.message : String(error) };
  }
}

function unavailable(id: ProviderRecord["id"], detail: string): ProviderRecord {
  return { id, installed: false, present: false, adapter: "unavailable", detail, capabilities: [] };
}

export function detectProviders(): ProviderRecord[] {
  const etchBin = process.env["GLASS_ETCH_BIN"] || "etch";
  const codexBin = process.env["GLASS_CODEX_BIN"] || "codex";
  const claudeBin = process.env["GLASS_CLAUDE_BIN"] || "claude";

  const etchVersion = probe(etchBin, ["--version"]);
  const etchVersionText = firstLine(etchVersion.output);
  const etch: ProviderRecord = !etchVersion.ok
    ? unavailable("etch", etchVersion.detail || "Etch is not installed")
    : probe(etchBin, ["surface", "--help"]).ok
      ? {
          id: "etch", installed: true, present: true, ...(etchVersionText ? { version: etchVersionText } : {}), adapter: "structured",
          detail: "etch surface --stdio is available",
          capabilities: ["surface", "stream", "sessions", "approval", "clarify", "delegation", "orchestration", "usage", "worktrees", "interrupt"],
        }
      : {
          id: "etch", installed: true, present: true, ...(etchVersionText ? { version: etchVersionText } : {}), adapter: "reduced",
          detail: "Structured surface unavailable; Glass will use etch -z",
          capabilities: ["oneshot", "reduced"],
        };

  const codexVersion = probe(codexBin, ["--version"]);
  const codexVersionText = firstLine(codexVersion.output);
  const codexAppServer = codexVersion.ok ? probe(codexBin, ["app-server", "--help"]) : { ok: false, output: "" };
  const codexExec = codexVersion.ok ? probe(codexBin, ["exec", "--help"]) : { ok: false, output: "" };
  const codex: ProviderRecord = !codexVersion.ok
    ? unavailable("codex", codexVersion.detail || "Codex is not installed")
    : codexAppServer.ok
      ? {
          id: "codex", installed: true, present: true, ...(codexVersionText ? { version: codexVersionText } : {}), adapter: "structured",
          detail: "codex app-server --stdio is available",
          capabilities: ["app-server", "stream", "sessions", "approval", "clarify", "usage", "interrupt"],
        }
      : codexExec.ok
        ? {
            id: "codex", installed: true, present: true, ...(codexVersionText ? { version: codexVersionText } : {}), adapter: "reduced",
            detail: "App-server unavailable; Glass will use codex exec --json",
            capabilities: ["jsonl", "sessions", "interrupt", "reduced"],
          }
        : {
            id: "codex", installed: true, present: false, ...(codexVersionText ? { version: codexVersionText } : {}), adapter: "unavailable",
            detail: "Installed Codex exposes neither app-server nor exec",
            capabilities: [],
          };

  const claudeVersion = probe(claudeBin, ["--version"]);
  const claudeVersionText = firstLine(claudeVersion.output);
  const claudeHelp = claudeVersion.ok ? probe(claudeBin, ["--help"]) : { ok: false, output: "" };
  const claudeStructured = claudeHelp.ok && /stream-json/.test(claudeHelp.output);
  const claude: ProviderRecord = !claudeVersion.ok
    ? unavailable("claude", claudeVersion.detail || "Claude is not installed")
    : claudeStructured
      ? {
          id: "claude", installed: true, present: true, ...(claudeVersionText ? { version: claudeVersionText } : {}), adapter: "structured",
          detail: "Claude streaming JSON output is available",
          capabilities: ["stream-json", "sessions", "usage", "interrupt"],
        }
      : {
          id: "claude", installed: true, present: false, ...(claudeVersionText ? { version: claudeVersionText } : {}), adapter: "unavailable",
          detail: "Installed Claude does not advertise stream-json output",
          capabilities: [],
        };

  let generic = false;
  try {
    const configured: unknown = JSON.parse(process.env["GLASS_GENERIC_AGENT_ARGV"] || "null");
    generic = Array.isArray(configured) && configured.length > 0
      && configured.every((item) => typeof item === "string" && item.length > 0);
  } catch {
    generic = false;
  }
  const genericRecord: ProviderRecord = generic
    ? { id: "generic", installed: true, present: true, adapter: "generic", detail: "Owner-configured argv", capabilities: ["stdio", "interrupt"] }
    : { id: "generic", installed: false, present: false, adapter: "unavailable", detail: "GLASS_GENERIC_AGENT_ARGV is not configured", capabilities: [] };

  return [etch, codex, claude, genericRecord];
}

export function detectEtch(): { present: boolean; version?: string } {
  const etch = detectProviders().find((provider) => provider.id === "etch");
  return { present: etch?.installed === true, ...(etch?.version ? { version: etch.version } : {}) };
}
