/**
 * Ribbon pin/order model — headless unit test (pure module, no DOM).
 *
 * What must hold:
 *   - persistence parsing is defensive: localStorage is untrusted (survives app
 *     swaps), so garbage / non-arrays / non-strings / dups / oversized blobs
 *     all degrade to something sane instead of throwing;
 *   - pin is append + idempotent; unpin removes; move reorders and CLAMPS at
 *     the edges; ops on unknown ids are no-ops;
 *   - pinned ids without a currently-registered widget are NOT rendered but ARE
 *     preserved — a widget vanishing across an app update (or existing only on
 *     a newer version) must not silently destroy the user's arrangement.
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/ribbon-model.mjs
 */
const { parseRibbonState, emptyRibbonState, pin, unpin, move, visiblePinned } = await import(
  new URL("../packages/viewer/dist/ribbon-model.js", import.meta.url).href
);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\x1b[1mGlass — ribbon pin/order model\x1b[0m\n");

// --- defensive parsing ------------------------------------------------------
check("parse: null -> empty", eq(parseRibbonState(null), { pinned: [] }));
check("parse: garbage JSON -> empty", eq(parseRibbonState("{nope"), { pinned: [] }));
check("parse: non-array pinned -> empty", eq(parseRibbonState('{"pinned":"a"}'), { pinned: [] }));
check(
  "parse: non-strings / empties / dups are dropped, order kept",
  eq(parseRibbonState('{"pinned":["a",7,"","b",null,"a","c"]}'), { pinned: ["a", "b", "c"] }),
);
check(
  "parse: oversized ids are dropped",
  eq(parseRibbonState(JSON.stringify({ pinned: ["x".repeat(65), "ok"] })), { pinned: ["ok"] }),
);
check(
  "parse: a ballooned blob is bounded to 128 entries",
  parseRibbonState(JSON.stringify({ pinned: Array.from({ length: 500 }, (_, i) => `w${i}`) })).pinned.length === 128,
);

// --- pin / unpin ------------------------------------------------------------
let s = emptyRibbonState();
s = pin(s, "clock");
s = pin(s, "cpu");
s = pin(s, "clock"); // idempotent
check("pin: appends in order, idempotent", eq(s, { pinned: ["clock", "cpu"] }));
check("unpin: removes", eq(unpin(s, "clock"), { pinned: ["cpu"] }));
check("unpin: unknown id is a no-op", eq(unpin(s, "ghost"), s));

// --- move -------------------------------------------------------------------
s = { pinned: ["a", "b", "c"] };
check("move: down by one", eq(move(s, "a", 1), { pinned: ["b", "a", "c"] }));
check("move: up by one", eq(move(s, "c", -1), { pinned: ["a", "c", "b"] }));
check("move: clamps at the top", eq(move(s, "a", -5), s));
check("move: clamps at the bottom", eq(move(s, "a", 99), { pinned: ["b", "c", "a"] }));
check("move: unknown id is a no-op", eq(move(s, "ghost", 1), s));

// --- rendering vs persistence of unknown ids --------------------------------
const withGhost = { pinned: ["ghost-from-newer-version", "a", "b"] };
check(
  "visiblePinned: only currently-available widgets render, user order kept",
  eq(visiblePinned(withGhost, new Set(["b", "a"])), ["a", "b"]),
);
check(
  "unknown pinned ids survive unrelated edits (not silently pruned)",
  eq(unpin(withGhost, "b").pinned, ["ghost-from-newer-version", "a"]),
);

const passed = checks.filter((c) => c.ok).length;
console.log(`\n\x1b[1m${passed}/${checks.length} checks passed\x1b[0m\n`);
process.exit(passed === checks.length ? 0 : 1);
