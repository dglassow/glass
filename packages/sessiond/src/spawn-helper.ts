/**
 * node-pty's macOS prebuild ships its `spawn-helper` binary without the execute
 * bit, so the first `pty.fork` fails with `posix_spawnp failed` (EACCES). Make
 * it executable before we ever spawn. Idempotent and best-effort: on a source
 * build or a non-darwin layout there is simply nothing to fix.
 */
import { createRequire } from "node:module";
import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensureSpawnHelper(): void {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("node-pty/package.json");
    const helper = join(
      dirname(pkgJson),
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    const st = statSync(helper);
    if ((st.mode & 0o111) === 0) {
      chmodSync(helper, st.mode | 0o755);
    }
  } catch {
    // No prebuild helper at that path (source build / other platform): no-op.
  }
}
