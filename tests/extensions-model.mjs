/**
 * Extensions model — headless unit test (pure module, no DOM, no Workers).
 *
 * What must hold — this is the security-relevant half of the extension
 * system, so it leans adversarial:
 *   - parseImport is the CONSENT gate: it refuses (with a reason) rather than
 *     coerces — unknown capabilities, bad ids, oversized code, junk JSON all
 *     fail closed, so the install dialog can never under-report a grant;
 *   - parseExtensions (persisted state, untrusted localStorage) degrades junk
 *     to bounded well-formed entries, but drops any entry whose capability
 *     list it can't fully account for (fail closed on consent);
 *   - parseWorkerMsg treats worker messages as attacker input: only the three
 *     known shapes pass, with bounded strings and a safe button-id charset;
 *   - RPC_CAPS maps every method to a capability and unknown methods to
 *     nothing (the host refuses those);
 *   - widget ids are namespaced under ext:<id>: so extensions can't collide
 *     with or impersonate skills.
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/extensions-model.mjs
 */
const {
  CAPABILITIES,
  RPC_CAPS,
  parseImport,
  parseExtensions,
  parseWorkerMsg,
  upsertExtension,
  deleteExtension,
  setEnabled,
  widgetId,
  MAX_EXTENSIONS,
  MAX_CODE,
} = await import(new URL("../packages/viewer/dist/extensions.js", import.meta.url).href);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const doc = (over = {}) => ({ glassExtension: 1, id: "demo", name: "Demo", version: "1.0", code: "glass.log('hi')", ...over });
const imp = (over) => parseImport(JSON.stringify(doc(over)));

console.log("\x1b[1mGlass — extensions model\x1b[0m\n");

// --- parseImport: the consent gate fails closed -----------------------------
check("import: minimal valid file installs enabled, no caps", (() => {
  const r = imp();
  return r.ok && r.ext.enabled === true && eq(r.ext.capabilities, []) && r.ext.icon === "⧉";
})());
check("import: garbage JSON refused", !parseImport("{nope").ok);
check("import: array refused", !parseImport("[]").ok);
check("import: missing format version refused", !imp({ glassExtension: undefined }).ok);
check("import: future format version refused", !imp({ glassExtension: 2 }).ok);
check("import: UNKNOWN capability refused, not dropped", !imp({ capabilities: ["sessions.read", "vault.read"] }).ok);
check("import: non-array capabilities refused", !imp({ capabilities: "sessions.read" }).ok);
check("import: known caps accepted + deduped", (() => {
  const r = imp({ capabilities: ["storage", "storage", "notify"] });
  return r.ok && eq(r.ext.capabilities, ["storage", "notify"]);
})());
check("import: bad id refused (traversal-ish / uppercase / empty / long)",
  !imp({ id: "a/b" }).ok && !imp({ id: "A" }).ok && !imp({ id: "" }).ok && !imp({ id: "x".repeat(65) }).ok && !imp({ id: ".hidden" }).ok);
check("import: empty code refused", !imp({ code: "  " }).ok);
check("import: oversized code refused", !imp({ code: "x".repeat(MAX_CODE + 1) }).ok);
check("import: every refusal carries a reason", (() => {
  const r = imp({ capabilities: ["nope"] });
  return !r.ok && typeof r.error === "string" && r.error.length > 0;
})());

// --- parseExtensions: persisted state degrades, consent fails closed --------
const rec = (id, over = {}) => ({ id, name: id, version: "1", icon: "⧉", description: "", capabilities: [], code: "x", enabled: true, ...over });
check("persist: null/garbage/non-array -> []", eq(parseExtensions(null), []) && eq(parseExtensions("{nope"), []) && eq(parseExtensions('{"a":1}'), []));
check("persist: junk entries dropped (no id / bad id / no code / dup id)", eq(
  parseExtensions(JSON.stringify([rec("a"), rec("a"), rec("B!"), { name: "x" }, rec("c", { code: "" }), 7, null])).map((e) => e.id),
  ["a"],
));
check("persist: entry with an UNKNOWN capability is dropped whole", eq(
  parseExtensions(JSON.stringify([rec("a", { capabilities: ["notify", "future.cap"] }), rec("b", { capabilities: ["notify"] })])).map((e) => e.id),
  ["b"],
));
check("persist: enabled defaults on, false survives", (() => {
  const [a, b] = parseExtensions(JSON.stringify([rec("a", { enabled: undefined }), rec("b", { enabled: false })]));
  return a.enabled === true && b.enabled === false;
})());
check("persist: collection bounded", parseExtensions(JSON.stringify(Array.from({ length: 100 }, (_, i) => rec(`e${i}`)))).length === MAX_EXTENSIONS);

// --- collection ops ---------------------------------------------------------
let xs = [];
xs = upsertExtension(xs, rec("one"));
xs = upsertExtension(xs, rec("two"));
xs = upsertExtension(xs, rec("one", { version: "2" }));
check("upsert: replaces in place by id, appends new", xs.length === 2 && xs[0].version === "2" && xs[1].id === "two");
check("upsert: refuses growth past the bound", upsertExtension(Array.from({ length: MAX_EXTENSIONS }, (_, i) => rec(`e${i}`)), rec("overflow")).length === MAX_EXTENSIONS);
check("delete: removes by id", eq(deleteExtension(xs, "one").map((e) => e.id), ["two"]));
check("setEnabled: flips only the target", (() => {
  const r = setEnabled(xs, "one", false);
  return r[0].enabled === false && r[1].enabled === true;
})());

// --- capability gate wiring -------------------------------------------------
check("rpc map: every method maps to a REAL capability", Object.values(RPC_CAPS).every((c) => c in CAPABILITIES));
check("rpc map: unknown method maps to nothing (host refuses)", RPC_CAPS["vault.get"] === undefined && RPC_CAPS["eval"] === undefined);
check("widget ids: namespaced, can't impersonate a skill id", widgetId("demo", "btn") === "ext:demo:btn");

// --- parseWorkerMsg: worker output is attacker input ------------------------
check("worker msg: null/junk/unknown kind -> null", parseWorkerMsg(null) === null && parseWorkerMsg("x") === null && parseWorkerMsg({ kind: "eval" }) === null);
check("worker msg: valid rpc passes, params default to {}", (() => {
  const m = parseWorkerMsg({ kind: "rpc", rpcId: 1, method: "sessions.list" });
  return m && m.kind === "rpc" && m.rpcId === 1 && eq(m.params, {});
})());
check("worker msg: rpc with junk ids refused", parseWorkerMsg({ kind: "rpc", rpcId: "1", method: "x" }) === null
  && parseWorkerMsg({ kind: "rpc", rpcId: 1.5, method: "x" }) === null
  && parseWorkerMsg({ kind: "rpc", rpcId: 1, method: "" }) === null
  && parseWorkerMsg({ kind: "rpc", rpcId: 1, method: "m".repeat(65) }) === null);
check("worker msg: array params refused (coerced to {})", (() => {
  const m = parseWorkerMsg({ kind: "rpc", rpcId: 1, method: "x", params: [1, 2] });
  return m && eq(m.params, {});
})());
check("worker msg: ribbon.add passes with safe id, bounded strings", (() => {
  const m = parseWorkerMsg({ kind: "ribbon.add", id: "btn-1", title: "T", icon: "★" });
  return m && m.kind === "ribbon.add" && m.id === "btn-1";
})());
check("worker msg: ribbon.add with unsafe id / oversized fields refused",
  parseWorkerMsg({ kind: "ribbon.add", id: "a:b", title: "T", icon: "★" }) === null
  && parseWorkerMsg({ kind: "ribbon.add", id: "A", title: "T", icon: "★" }) === null
  && parseWorkerMsg({ kind: "ribbon.add", id: "a", title: "T".repeat(65), icon: "★" }) === null
  && parseWorkerMsg({ kind: "ribbon.add", id: "a", title: "T", icon: "★".repeat(9) }) === null);
check("worker msg: log bounded", parseWorkerMsg({ kind: "log", message: "x".repeat(4097) }) === null
  && parseWorkerMsg({ kind: "log", message: "hi" })?.message === "hi");

const passed = checks.filter((c) => c.ok).length;
console.log(`\n\x1b[1m${passed}/${checks.length} checks passed\x1b[0m\n`);
process.exit(passed === checks.length ? 0 : 1);
