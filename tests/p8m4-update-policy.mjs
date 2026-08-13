/**
 * Phase 8 · Milestone 4 — the desktop auto-updater's anti-rollback / anti-brick
 * policy (the ship-gate from the updater red-team).
 *
 * Tauri verifies only the artifact bytes, not the manifest's version field, so a
 * compromised update origin could lie: claim a huge version and serve an OLD
 * signed build (forced downgrade) or the CURRENT build (infinite reinstall/brick).
 * This proves the device-side guard refuses both while still allowing genuine
 * upgrades. Pure logic — no Tauri.
 *
 * Run after `pnpm --filter @glass/viewer build:lib`:
 *   node tests/p8m4-update-policy.mjs
 */
import { emptyUpdateState, cmpVersions, reconcile, shouldInstall, markAttempt } from "../packages/viewer/dist/update-policy.js";

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };

console.log("\n\x1b[1mGlass — P8 M4 auto-update anti-rollback / anti-brick policy\x1b[0m\n");

// --- version comparison ---
check("cmpVersions orders normally", cmpVersions("0.1.0", "0.2.0") < 0 && cmpVersions("0.10.0", "0.9.0") > 0 && cmpVersions("1.2.3", "1.2.3") === 0);
check("cmpVersions treats garbage/negative as 0 (can't rank a malicious string high)", cmpVersions("abc", "0.0.0") === 0 && cmpVersions("9.9.9", "abc.def") > 0);

// --- genuine upgrade is allowed ---
{
  const s = reconcile(emptyUpdateState(), "0.1.0"); // booted 0.1.0
  check("genuine newer version installs", shouldInstall(s, "0.1.0", "0.2.0") === true && s.floor === "0.1.0");
}

// --- direct downgrade refused ---
{
  const s = reconcile(emptyUpdateState(), "0.2.0");
  check("direct downgrade (target <= current) refused", shouldInstall(s, "0.2.0", "0.1.0") === false);
}

// --- anti-rollback floor: never descend below the highest version ever run ---
{
  // Device previously ran 0.3.0 (floor), is somehow now on 0.2.0; a manifest
  // offering 0.2.5 (still below the floor) must be refused.
  const s = reconcile({ floor: "0.3.0", blocked: [] }, "0.2.0");
  check("anti-rollback: target below the floor is refused", s.floor === "0.3.0" && shouldInstall(s, "0.2.0", "0.2.5") === false);
}

// --- BRICK LOOP: a target that didn't advance is poisoned, never retried ---
{
  // We attempted 9.9.9 but relaunched still on 0.1.0 (the manifest lied / looped).
  const attempted = markAttempt(reconcile(emptyUpdateState(), "0.1.0"), "9.9.9");
  const afterBoot = reconcile(attempted, "0.1.0"); // still 0.1.0 → poison 9.9.9
  check("brick loop: a non-advancing target is poisoned", afterBoot.blocked.includes("9.9.9"));
  check("brick loop: the poisoned target is never reinstalled", shouldInstall(afterBoot, "0.1.0", "9.9.9") === false);
  // but a real newer release still installs afterward
  check("a genuine upgrade still works after a poisoned target", shouldInstall(afterBoot, "0.1.0", "0.2.0") === true);
}

// --- forced-rollback-via-high-version is detected + blocked on the next boot ---
{
  // Attack: manifest says 9.9.9 but serves an OLD build → we boot 0.0.9 (< 0.1.0
  // we ran before). reconcile poisons 9.9.9 AND the floor (0.1.0) refuses re-descent.
  const attempted = markAttempt({ floor: "0.1.0", blocked: [] }, "9.9.9");
  const afterBoot = reconcile(attempted, "0.0.9");
  check("forced rollback: the lying target is poisoned + floor preserved", afterBoot.blocked.includes("9.9.9") && afterBoot.floor === "0.1.0");
  check("forced rollback: cannot re-apply the same lie", shouldInstall(afterBoot, "0.0.9", "9.9.9") === false);
}

// --- give-up: repeated lies halt auto-update; a genuine advance resets ---
{
  let s = reconcile(emptyUpdateState(), "0.1.0");
  s = reconcile(markAttempt(s, "9.0.1"), "0.1.0"); // lie 1 (attempted 9.0.1, still 0.1.0)
  s = reconcile(markAttempt(s, "9.0.2"), "0.1.0"); // lie 2
  s = reconcile(markAttempt(s, "9.0.3"), "0.1.0"); // lie 3 → give up
  check("give-up: repeated non-advancing updates halt auto-update", s.noAdvance >= 3 && shouldInstall(s, "0.1.0", "0.5.0") === false);
}
{
  const oneLie = reconcile(markAttempt(reconcile(emptyUpdateState(), "0.1.0"), "9.0.1"), "0.1.0");
  const healthy = reconcile(markAttempt(oneLie, "0.2.0"), "0.2.0"); // genuinely advanced
  check("give-up streak resets after a genuine advance", oneLie.noAdvance === 1 && healthy.noAdvance === 0);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`);
process.exit(failed.length ? 1 : 0);
