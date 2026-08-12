/**
 * Etch integration (plan §0, §5). Etch is a separate CLI the owner installs and
 * updates by hand — Glass DETECTS it, never manages it. The chat provider runs
 * it non-interactively per message: `etch -z "<prompt>"` prints only the final
 * assistant text to stdout (confirmed against Etch's oneshot mode). Richer
 * structured modes (tui_gateway JSON-RPC, ACP) are a later enhancement.
 *
 * The binary is overridable via GLASS_ETCH_BIN so tests can point at a stub and
 * the owner can pin a path.
 */
import { spawn, spawnSync } from "node:child_process";

export function etchBinary(): string {
  return process.env["GLASS_ETCH_BIN"] || "etch";
}

/** Detected presence + version, surfaced in the device record (never managed). */
export function detectEtch(): { present: boolean; version?: string } {
  try {
    const result = spawnSync(etchBinary(), ["--version"], { encoding: "utf8", timeout: 5000 });
    if (result.error) return { present: false };
    const line = (result.stdout || result.stderr || "").trim().split("\n")[0]?.trim();
    return line ? { present: true, version: line } : { present: true };
  } catch {
    return { present: false };
  }
}

/** One-shot invocation: returns the final assistant text, or rejects on failure. */
export function runEtch(prompt: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = spawn(etchBinary(), ["-z", prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    cp.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    cp.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    const timer = setTimeout(() => {
      cp.kill("SIGKILL");
      reject(new Error("etch timed out"));
    }, timeoutMs);
    cp.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    cp.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.replace(/\n+$/, ""));
      else reject(new Error(err.trim() || `etch exited with code ${code}`));
    });
  });
}
