/**
 * iMessage bridge — acceptance + adversarial test (plan §6).
 *
 * Real hub/sessiond/agent stack; the Messages side is synthesized: a
 * hand-built chat.db (same tables/columns the bridge queries, including a
 * typedstream attributedBody blob and tapback/attachment rows) pointed at via
 * GLASS_IMESSAGE_DB, and a stub send binary via GLASS_IMESSAGE_SEND_BIN that
 * records its argv (the etch-stub pattern).
 *
 * What must hold:
 *   - detection is honest: the bridge agent reports imessagePresent, a
 *     bridge-less agent reports absent AND fails imessage.* closed;
 *   - reads are right: conversation ordering/names/previews/participants,
 *     message order, typedstream decode, tapback filtering, attachment
 *     placeholder, pagination without overlap;
 *   - the send path is injection-proof: hostile text (quotes, newlines,
 *     shell metacharacters, AppleScript quotes) arrives at the send binary as
 *     ONE argv element, byte-exact, never inside the script source;
 *   - exactly-one-target is enforced (both/neither -> bad_request);
 *   - watch pushes reach the watcher (and ONLY the watcher), stop on
 *     unwatch, and an oversized send is dropped without wedging the agent.
 *
 * Run after `pnpm build`:  node tests/imessage.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const ROOT = new URL("../", import.meta.url).pathname;
const HUB = `${ROOT}packages/hub/dist/main.js`;
const SESSIOND = `${ROOT}packages/sessiond/dist/main.js`;
const AGENT = `${ROOT}packages/agent/dist/main.js`;
const RUN = `/tmp/glass-imsg-${process.pid}`;
const TS = `${RUN}/trust.json`;
const DB = `${RUN}/chat.db`;
const SEND_BIN = `${RUN}/mock-send`;
const SEND_LOG = `${RUN}/sends.ndjson`;

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const b64u = (b) => Buffer.from(b).toString("base64url");

// --- synthetic Messages store ----------------------------------------------

const APPLE_EPOCH_MS = 978_307_200_000;
const ns = (unixMs) => (unixMs - APPLE_EPOCH_MS) * 1e6;

/** Minimal typedstream blob: prefix + NSString class marker + '+' + length-prefixed UTF-8. */
function tsBlob(s) {
  const utf = Buffer.from(s, "utf8");
  const head = Buffer.from("040b73747265616d747970656481e8038401", "hex");
  const len = utf.length < 0x81 ? Buffer.from([utf.length]) : (() => { const b = Buffer.alloc(3); b[0] = 0x81; b.writeUInt16LE(utf.length, 1); return b; })();
  return Buffer.concat([head, Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), len, utf, Buffer.from([0x86, 0x84])]);
}

const T0 = Date.now() - 60 * 60 * 1000; // an hour ago, stable ordering
function buildChatDb() {
  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      handle_id INTEGER, date INTEGER, is_from_me INTEGER, cache_has_attachments INTEGER,
      associated_message_type INTEGER, item_type INTEGER);
  `);
  db.exec(`INSERT INTO chat VALUES (1, 'iMessage;-;+15550001111', '+15550001111', NULL);
           INSERT INTO chat VALUES (2, 'iMessage;+;chat-family', 'chat-family', 'Family');
           INSERT INTO handle VALUES (1, '+15550001111');
           INSERT INTO handle VALUES (2, '+15550002222');
           INSERT INTO handle VALUES (3, 'alice@example.com');
           INSERT INTO chat_handle_join VALUES (1, 1);
           INSERT INTO chat_handle_join VALUES (2, 2);
           INSERT INTO chat_handle_join VALUES (2, 3);`);
  const msg = db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const join = db.prepare(`INSERT INTO chat_message_join VALUES (?, ?)`);
  // chat 1: inbound text, outbound text, inbound typedstream-only, a tapback (filtered), attachment-only.
  msg.run(1, "g1", "hey there", null, 1, ns(T0 + 1000), 0, 0, 0, 0); join.run(1, 1);
  msg.run(2, "g2", "hi!", null, 0, ns(T0 + 2000), 1, 0, 0, 0); join.run(1, 2);
  msg.run(3, "g3", null, tsBlob("typed-stream body 🎉"), 1, ns(T0 + 3000), 0, 0, 0, 0); join.run(1, 3);
  msg.run(4, "g4", "Loved “hi!”", null, 1, ns(T0 + 4000), 0, 0, 2000, 0); join.run(1, 4);
  msg.run(5, "g5", null, null, 1, ns(T0 + 5000), 0, 1, 0, 0); join.run(1, 5);
  // chat 2 (Family): newest message overall -> sorts first.
  msg.run(6, "g6", "dinner at 7", null, 2, ns(T0 + 9000), 0, 0, 0, 0); join.run(2, 6);
  return db; // kept open read-write: the harness inserts live rows later
}

// --- stack helpers (p5m1 pattern) ------------------------------------------

async function makeIdentity(id) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const pkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
  return { deviceId: id, publicKey: pub, keyFileJson: JSON.stringify({ v: 1, deviceId: id, publicKey: pub, privateKeyPkcs8: pkcs8 }), async sign(bytes) { return b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes))); } };
}
const hsPayload = (id, nonce) => new TextEncoder().encode(`glass:handshake:v1\n${id}\n${nonce}`);
const trustAdd = (id, pub, roles) => execFileSync("node", [HUB, "trust", "add", "--trust-store", TS, "--device-id", id, "--name", id, "--public-key", pub, "--roles", roles]);

function startProc(name, args, readyRe, env) {
  const cp = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let err = "";
  cp.stderr.on("data", (d) => (err += d.toString()));
  const ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => { const m = err.match(readyRe); if (m) { clearInterval(iv); resolve(m); } }, 25);
    cp.once("exit", (c) => { clearInterval(iv); reject(new Error(`${name} exited (${c}): ${err}`)); });
    setTimeout(() => { clearInterval(iv); reject(new Error(`${name} not ready: ${err}`)); }, 9000);
  });
  return { cp, ready, stderr: () => err };
}

class Peer {
  constructor(url, id) { this.id = id; this.envs = []; this.waiters = []; this.ws = new WebSocket(url); this.opened = new Promise((r) => this.ws.addEventListener("open", r, { once: true })); this.ws.addEventListener("message", (ev) => { let e; try { e = JSON.parse(ev.data); } catch { return; } this.envs.push(e); this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true)); }); this.ws.addEventListener("close", () => { for (const w of this.waiters) w.reject(new Error("closed")); this.waiters = []; }); this.ws.addEventListener("error", () => {}); }
  send(body, to = "hub") { const id = randomUUID(); this.ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), from: this.id, to, body })); return id; }
  waitFor(pred, ms = 8000) { const h = this.envs.find(pred); if (h) return Promise.resolve(h); return new Promise((res, rej) => { const w = { pred, resolve: res, reject: rej }; this.waiters.push(w); setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("timeout")); }, ms); }); }
  close() { try { this.ws.close(); } catch {} }
}
async function auth(url, id, roles) {
  const p = new Peer(url, id.deviceId); await p.opened;
  const hid = p.send({ type: "hello", deviceId: id.deviceId, deviceName: id.deviceId, roles, protocolVersion: 1, appVersion: "harness", etch: { present: false } });
  const ch = await p.waitFor((e) => e.body?.type === "hello.challenge" && e.replyTo === hid);
  p.send({ type: "hello.proof", deviceId: id.deviceId, signature: await id.sign(hsPayload(id.deviceId, ch.body.nonce)) });
  await p.waitFor((e) => e.body?.type === "hello.ack");
  return p;
}

/** Request/reply against an agent: resolves with the correlated reply body. */
async function req(peer, to, body, ms = 8000) {
  const id = peer.send(body, to);
  const env = await peer.waitFor((e) => e.replyTo === id, ms);
  return env.body;
}

let hub, sdA, sdB, agentA, agentB, liveDb;
async function run() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  console.log("\n\x1b[1mGlass — iMessage bridge\x1b[0m\n");

  // --- unit: typedstream decode heuristic (pure, from the built agent) ---
  const { decodeAttributedBody } = await import(new URL("../packages/agent/dist/imessage/typedstream.js", import.meta.url).href);
  check("typedstream: short string decodes", decodeAttributedBody(tsBlob("hello 🎉")) === "hello 🎉");
  const long = "x".repeat(300);
  check("typedstream: 0x81 two-byte length decodes", decodeAttributedBody(tsBlob(long)) === long);
  check("typedstream: garbage/absent -> null (never garbage text)",
    decodeAttributedBody(Buffer.from("no markers here at all")) === null
    && decodeAttributedBody(Buffer.from([])) === null
    && decodeAttributedBody(null) === null
    && decodeAttributedBody(Buffer.concat([Buffer.from("NSString"), Buffer.from([0x2b, 0xff, 0x01])])) === null);

  // --- synthetic store + stub send binary ---
  liveDb = buildChatDb();
  writeFileSync(SEND_BIN, `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(SEND_LOG)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o755 });
  chmodSync(SEND_BIN, 0o755);

  // --- stack: hub + two agents (mac-a serves the bridge; mac-b must not) ---
  const viewerA = await makeIdentity("viewer-a");
  const viewerB = await makeIdentity("viewer-b");
  const macA = await makeIdentity("mac-a");
  const macB = await makeIdentity("mac-b");
  for (const [ident, roles] of [[viewerA, "viewer"], [viewerB, "viewer"], [macA, "agent"], [macB, "agent"]]) {
    trustAdd(ident.deviceId, ident.publicKey, roles);
    writeFileSync(`${RUN}/${ident.deviceId}.json`, ident.keyFileJson, { mode: 0o600 });
  }

  hub = startProc("hub", [HUB, "--listen", "127.0.0.1:0", "--trust-store", TS], /listening on (ws:\/\/\S+)/);
  const url = (await hub.ready)[1];
  sdA = startProc("sessiond-a", [SESSIOND, "--socket", `${RUN}/sd-a.sock`], /listening on/);
  sdB = startProc("sessiond-b", [SESSIOND, "--socket", `${RUN}/sd-b.sock`], /listening on/);
  await Promise.all([sdA.ready, sdB.ready]);
  agentA = startProc("agent-a", [AGENT, "--sessiond", `${RUN}/sd-a.sock`, "--hub", url, "--device-id", "mac-a", "--name", "Mac A", "--key", `${RUN}/mac-a.json`],
    /registered with hub/, { GLASS_IMESSAGE_DB: DB, GLASS_IMESSAGE_SEND_BIN: SEND_BIN });
  agentB = startProc("agent-b", [AGENT, "--sessiond", `${RUN}/sd-b.sock`, "--hub", url, "--device-id", "mac-b", "--name", "Mac B", "--key", `${RUN}/mac-b.json`],
    /registered with hub/, { GLASS_IMESSAGE_DB: `${RUN}/nonexistent.db` });
  await Promise.all([agentA.ready, agentB.ready]);
  check("bridge agent logs availability", /imessage bridge available/.test(agentA.stderr()));

  const vA = await auth(url, viewerA, ["viewer"]);
  const vB = await auth(url, viewerB, ["viewer"]);

  // --- detection is honest, both ways ---
  const listed = await req(vA, "hub", { type: "device.list" });
  const devA = listed.devices.find((d) => d.id === "mac-a");
  const devB = listed.devices.find((d) => d.id === "mac-b");
  check("device record: mac-a imessagePresent, mac-b absent", devA?.imessagePresent === true && devB?.imessagePresent === false);
  const noBridge = await req(vA, "mac-b", { type: "imessage.conversations" });
  check("bridge-less agent fails closed (imessage_unavailable)", noBridge.type === "error" && noBridge.code === "imessage_unavailable");

  // --- conversations ---
  const convs = (await req(vA, "mac-a", { type: "imessage.conversations" })).conversations;
  check("conversations: newest activity first", convs.length === 2 && convs[0].guid === "iMessage;+;chat-family" && convs[1].guid === "iMessage;-;+15550001111");
  check("conversations: group name / identifier fallback", convs[0].name === "Family" && convs[1].name === "+15550001111");
  check("conversations: participants + previews (tapback NOT the preview)",
    convs[0].participants.length === 2 && convs[0].lastPreview === "dinner at 7" && convs[1].lastPreview === "[attachment]");

  // --- messages ---
  const msgs = (await req(vA, "mac-a", { type: "imessage.messages", chatGuid: "iMessage;-;+15550001111" })).messages;
  check("messages: ascending, tapback filtered", msgs.length === 4 && msgs.map((m) => m.rowid).join(",") === "1,2,3,5");
  check("messages: typedstream body decoded", msgs[2].text === "typed-stream body 🎉");
  check("messages: attachment-only placeholder", msgs[3].text === "[attachment]" && msgs[3].hasAttachments === true);
  check("messages: direction + sender (absent when fromMe)", msgs[0].fromMe === false && msgs[0].sender === "+15550001111" && msgs[1].fromMe === true && msgs[1].sender === undefined);
  const page1 = (await req(vA, "mac-a", { type: "imessage.messages", chatGuid: "iMessage;-;+15550001111", limit: 2 })).messages;
  const page2 = (await req(vA, "mac-a", { type: "imessage.messages", chatGuid: "iMessage;-;+15550001111", limit: 2, beforeRowid: page1[0].rowid })).messages;
  check("messages: pagination pages back without overlap",
    page1.map((m) => m.rowid).join(",") === "3,5" && page2.map((m) => m.rowid).join(",") === "1,2");

  // --- send: injection-proof argv, exactly-one target ---
  const nasty = `hello "world"\n$(rm -rf /tmp/x); 'quote' \`tick\` \\ end "with" more`;
  const sent = await req(vA, "mac-a", { type: "imessage.send", chatGuid: "iMessage;-;+15550001111", text: nasty });
  check("send: reply to existing chat acks", sent.type === "imessage.sent");
  const sends = readFileSync(SEND_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const argv1 = sends[0];
  check("send: hostile text is ONE argv element, byte-exact", argv1.length === 4 && argv1[0] === "-e" && argv1[2] === "iMessage;-;+15550001111" && argv1[3] === nasty);
  check("send: text never lands in the AppleScript source", !argv1[1].includes("rm -rf") && argv1[1].includes("chat id targetGuid"));
  const sent2 = await req(vA, "mac-a", { type: "imessage.send", handle: "bob@example.com", text: "new thread hi" });
  const argv2 = readFileSync(SEND_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l))[1];
  check("send: new-thread variant targets the participant script", sent2.type === "imessage.sent" && argv2[1].includes("participant targetHandle") && argv2[2] === "bob@example.com" && argv2[3] === "new thread hi");
  const both = await req(vA, "mac-a", { type: "imessage.send", chatGuid: "g", handle: "h", text: "x" });
  const neither = await req(vA, "mac-a", { type: "imessage.send", text: "x" });
  check("send: exactly-one target enforced", both.type === "error" && both.code === "bad_request" && neither.type === "error" && neither.code === "bad_request");

  // --- oversized send: dropped at the schema, agent not wedged ---
  const bigId = vA.send({ type: "imessage.send", chatGuid: "iMessage;-;+15550001111", text: "x".repeat(5000) }, "mac-a");
  const bigReply = await vA.waitFor((e) => e.replyTo === bigId, 2000).catch(() => null);
  const alive = await req(vA, "mac-a", { type: "imessage.conversations" });
  check("oversized send dropped; agent still serves", bigReply === null && alive.type === "imessage.conversations.listed");

  // --- watch: push reaches the watcher, and only the watcher ---
  const watching = await req(vA, "mac-a", { type: "imessage.watch" });
  check("watch acks", watching.type === "imessage.watching");
  await sleep(300); // let the poller take its initial cursor
  liveDb.prepare(`INSERT INTO message VALUES (10, 'g10', 'ping from live insert', NULL, 1, ?, 0, 0, 0, 0)`).run(ns(Date.now()));
  liveDb.prepare(`INSERT INTO chat_message_join VALUES (1, 10)`).run();
  const push = await vA.waitFor((e) => e.body?.type === "imessage.new" && e.body.message.rowid === 10, 8000);
  check("watcher receives the live push", push.body.message.text === "ping from live insert" && push.body.message.chatGuid === "iMessage;-;+15550001111");
  check("non-watcher receives nothing", !vB.envs.some((e) => e.body?.type === "imessage.new"));

  // --- unwatch: pushes stop ---
  vA.send({ type: "imessage.unwatch" }, "mac-a");
  await sleep(300);
  liveDb.prepare(`INSERT INTO message VALUES (11, 'g11', 'after unwatch', NULL, 1, ?, 0, 0, 0, 0)`).run(ns(Date.now()));
  liveDb.prepare(`INSERT INTO chat_message_join VALUES (1, 11)`).run();
  await sleep(3500); // > poll interval
  check("unwatched viewer gets no further pushes", !vA.envs.some((e) => e.body?.type === "imessage.new" && e.body.message.rowid === 11));

  vA.close();
  vB.close();
}

async function cleanup() {
  for (const p of [agentA, agentB, sdA, sdB, hub]) { try { if (p?.cp?.pid) p.cp.kill("SIGTERM"); } catch {} }
  try { liveDb?.close(); } catch {}
  await sleep(300);
  rmSync(RUN, { recursive: true, force: true });
}
const hardTimeout = setTimeout(() => { console.error("\n\x1b[31mFATAL: exceeded 90s\x1b[0m"); cleanup().finally(() => process.exit(1)); }, 90000);
run()
  .then(async () => { clearTimeout(hardTimeout); await cleanup(); const failed = checks.filter((c) => !c.ok); console.log(`\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${checks.length - failed.length}/${checks.length} checks passed\x1b[0m\n`); process.exit(failed.length ? 1 : 0); })
  .catch(async (err) => { clearTimeout(hardTimeout); console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`); await cleanup(); process.exit(1); });
