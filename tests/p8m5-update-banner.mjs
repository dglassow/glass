/**
 * Phase 8 · Milestone 5 — acceptance test for the HUB → SPOKE update nag.
 *
 * When a new signed build is published to the hub, connected spokes should learn
 * about it live (a banner) without reconnecting, and the nag must be trustworthy:
 *   - connect-time push: a device that authenticates gets update.available with
 *     the version currently at the hub's update origin (latest.json);
 *   - live push: publishing a new version while connected broadcasts it (fs.watch);
 *   - validation: a malformed / oversized version is NOT broadcast (a compromised
 *     or half-written manifest can't inject an arbitrary string into the banner);
 *   - de-dupe: re-writing the SAME version does not re-nag;
 *   - recovery: a valid version after a bad one still broadcasts.
 * Plus the banner's decision gate (cmpVersions), which is what stops a malicious
 * hub from nagging a spoke to DOWNGRADE or side-grade:
 *   - offered > running  -> nag;   offered == running -> silent;   offered < running -> silent.
 *
 * The install itself stays minisign-gated on the device (covered by p8m4); this
 * harness is only about the advisory signal and its abuse resistance.
 *
 * Run after `pnpm build && pnpm --filter @glass/viewer build:lib`:
 *   node tests/p8m5-update-banner.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const { startHubServer } = await import(new URL("../packages/hub/dist/server.js", import.meta.url).href);
const { FileTrustStore } = await import(new URL("../packages/hub/dist/trust-store.js", import.meta.url).href);
const { HubClient } = await import(new URL("../packages/viewer/dist/hub-client.js", import.meta.url).href);
const { cmpVersions } = await import(new URL("../packages/viewer/dist/update-policy.js", import.meta.url).href);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const b64u = (b) => Buffer.from(b).toString("base64url");

async function makeIdentity(deviceId) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return {
    deviceId,
    publicKey,
    signer: { publicKey, async sign(p) { return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, p)); } },
  };
}
async function waitUntil(fn, label, capMs = 6000) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${label}`);
}
const writeManifest = (dir, version, extra = {}) =>
  writeFileSync(join(dir, "latest.json"), JSON.stringify({ version, ...extra, platforms: {} }));

const UPD = mkdtempSync(join(tmpdir(), "glass-p8m5-upd-"));
const TSDIR = mkdtempSync(join(tmpdir(), "glass-p8m5-ts-"));
let hub, client;
try {
  writeManifest(UPD, "0.1.5", { notes: "- fixed the flux capacitor\n- added a second one" });
  const store = new FileTrustStore(join(TSDIR, "trust.json"));
  const dev = await makeIdentity("viewer-x");
  store.add("viewer-x", { publicKey: dev.publicKey, name: "x", roles: ["viewer"], enrolledAt: Date.now(), approvedBy: "test" });

  hub = await startHubServer({ host: "127.0.0.1", port: 0, mode: "trust", trustStore: store, updatesRoot: UPD });

  const offered = [];
  const notesFor = {};
  let conn = 0;
  client = new HubClient(hub.url, "viewer-x", "x", { onConnected: () => conn++, onUpdateAvailable: (v, n) => { offered.push(v); notesFor[v] = n; } }, dev.signer);
  client.connect();
  await waitUntil(() => conn > 0, "device authenticated");

  // 1) connect-time push carries the current manifest version
  await waitUntil(() => offered.length > 0, "connect-time push");
  check("connect-time: authed device receives update.available with the manifest version", offered[0] === "0.1.5", `got ${offered[0]}`);
  check("connect-time: change notes ride the push", notesFor["0.1.5"] === "- fixed the flux capacitor\n- added a second one", `got ${JSON.stringify(notesFor["0.1.5"])}`);

  // 2) publishing a newer version broadcasts it live (no reconnect)
  writeManifest(UPD, "0.1.6", { notes: "- live notes" });
  await waitUntil(() => offered.includes("0.1.6"), "live broadcast of 0.1.6");
  check("live: publishing a new version broadcasts it to the connected device", offered.includes("0.1.6"));
  check("live: change notes ride the broadcast", notesFor["0.1.6"] === "- live notes", `got ${JSON.stringify(notesFor["0.1.6"])}`);

  // 3) a malformed / oversized version is refused (not injected into the banner)
  const beforeBad = offered.length;
  writeManifest(UPD, "z".repeat(200));
  await sleep(700);
  check("validation: an oversized version string is NOT broadcast", offered.length === beforeBad, `offered grew by ${offered.length - beforeBad}`);

  // 4) a valid version after a bad one still gets through
  writeManifest(UPD, "0.1.7");
  await waitUntil(() => offered.includes("0.1.7"), "recovery broadcast of 0.1.7");
  check("recovery: a valid version after a bad manifest still broadcasts", offered.includes("0.1.7"));

  // 5) re-publishing the SAME version does not re-nag
  const beforeDup = offered.length;
  writeManifest(UPD, "0.1.7");
  await sleep(700);
  check("de-dupe: re-writing the same version does not re-broadcast", offered.length === beforeDup, `offered grew by ${offered.length - beforeDup}`);

  // 5b) notes abuse: oversized notes are clamped to the protocol bound (the
  // update signal must still arrive — notes are advisory, never a DoS lever);
  // non-string notes are ignored rather than breaking the push.
  writeManifest(UPD, "0.1.8", { notes: "n".repeat(20000) });
  await waitUntil(() => offered.includes("0.1.8"), "broadcast with oversized notes");
  check("notes: oversized notes are clamped, not dropped and not fatal", notesFor["0.1.8"]?.length === 16384, `got length ${notesFor["0.1.8"]?.length}`);
  writeManifest(UPD, "0.1.9", { notes: 42 });
  await waitUntil(() => offered.includes("0.1.9"), "broadcast with non-string notes");
  check("notes: non-string notes are ignored, version still arrives", notesFor["0.1.9"] === undefined, `got ${JSON.stringify(notesFor["0.1.9"])}`);

  // 6) banner decision gate — a hub cannot nag you to downgrade or side-grade
  check("gate: a strictly newer offered version nags", cmpVersions("0.1.8", "0.1.7") > 0);
  check("gate: an equal offered version stays silent", !(cmpVersions("0.1.7", "0.1.7") > 0));
  check("gate: an OLDER offered version stays silent (no hub-forced downgrade)", !(cmpVersions("0.1.6", "0.1.7") > 0));
} finally {
  try { client?.close(); } catch { /* ignore */ }
  try { await hub?.close(); } catch { /* ignore */ }
  rmSync(UPD, { recursive: true, force: true });
  rmSync(TSDIR, { recursive: true, force: true });
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n\x1b[1m${passed}/${checks.length} checks passed\x1b[0m\n`);
process.exit(passed === checks.length ? 0 : 1);
