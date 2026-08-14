/**
 * User-skills model — headless unit test (pure module, no DOM).
 *
 * What must hold:
 *   - parsing is defensive: localStorage is untrusted (survives app swaps), so
 *     garbage, non-arrays, junk entries, dup ids, and oversized fields degrade
 *     to bounded, well-formed skills instead of throwing;
 *   - skillInput is EXACTLY the stored script (a skill types, nothing more),
 *     with one newline appended iff pressEnter and not already terminated —
 *     never a doubled newline, never an appended one when pressEnter is off;
 *   - upsert replaces in place by id, appends when new, and refuses growth past
 *     the bound; delete removes by id.
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/skills-model.mjs
 */
const { parseSkills, skillInput, upsertSkill, deleteSkill, MAX_SKILLS, MAX_SCRIPT } = await import(
  new URL("../packages/viewer/dist/skills.js", import.meta.url).href
);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mk = (id, over = {}) => ({ id, name: id, icon: "»", script: "echo hi", pressEnter: true, ...over });

console.log("\x1b[1mGlass — user-skills model\x1b[0m\n");

// --- defensive parsing ------------------------------------------------------
check("parse: null -> []", eq(parseSkills(null), []));
check("parse: garbage JSON -> []", eq(parseSkills("{nope"), []));
check("parse: non-array -> []", eq(parseSkills('{"a":1}'), []));
check(
  "parse: junk entries dropped (no id / no script / dup id / non-object)",
  eq(
    parseSkills(JSON.stringify([{ id: "a", script: "x" }, { id: "a", script: "y" }, { script: "z" }, { id: "b" }, 7, null])).map((s) => s.id),
    ["a"],
  ),
);
const parsed = parseSkills(JSON.stringify([{ id: "a", name: "", icon: "", script: "x".repeat(MAX_SCRIPT + 10), pressEnter: "yes" }]))[0];
check("parse: empty name/icon get defaults, script clamped, pressEnter defaults on", parsed.name === "unnamed" && parsed.icon === "»" && parsed.script.length === MAX_SCRIPT && parsed.pressEnter === true);
check("parse: pressEnter false survives", parseSkills(JSON.stringify([mk("a", { pressEnter: false })]))[0].pressEnter === false);
check("parse: collection bounded", parseSkills(JSON.stringify(Array.from({ length: 300 }, (_, i) => mk(`s${i}`)))).length === MAX_SKILLS);

// --- skillInput: a skill types exactly its script ---------------------------
check("input: pressEnter appends one newline", skillInput(mk("a", { script: "ls" })) === "ls\n");
check("input: no doubled newline when already terminated", skillInput(mk("a", { script: "ls\n" })) === "ls\n");
check("input: pressEnter off sends verbatim", skillInput(mk("a", { script: "ls", pressEnter: false })) === "ls");
check("input: multiline script is untouched in the middle", skillInput(mk("a", { script: "a\nb" })) === "a\nb\n");

// --- upsert / delete --------------------------------------------------------
let s = [];
s = upsertSkill(s, mk("one"));
s = upsertSkill(s, mk("two"));
s = upsertSkill(s, mk("one", { script: "changed" }));
check("upsert: replaces in place by id, appends new", s.length === 2 && s[0].script === "changed" && s[1].id === "two");
check("delete: removes by id", eq(deleteSkill(s, "one").map((x) => x.id), ["two"]));
const full = Array.from({ length: MAX_SKILLS }, (_, i) => mk(`s${i}`));
check("upsert: refuses growth past the bound", upsertSkill(full, mk("overflow")).length === MAX_SKILLS);
check("upsert: editing still works at the bound", upsertSkill(full, mk("s0", { script: "edited" }))[0].script === "edited");

const passed = checks.filter((c) => c.ok).length;
console.log(`\n\x1b[1m${passed}/${checks.length} checks passed\x1b[0m\n`);
process.exit(passed === checks.length ? 0 : 1);
