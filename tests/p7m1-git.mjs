/**
 * Phase 7 · Milestone 1 — acceptance test for spoke git hosting.
 *
 * The hub serves bare repos over smart-HTTP on its authenticated listener. This
 * harness mounts the real handler on a plain HTTP server and drives it with real
 * `git`, proving: a token is required (401), the per-repo read/write ACL is
 * enforced (a read-only device can clone but not push; a device with no grant is
 * refused; write implies read), tokens are checked by scrypt hash (a wrong token
 * fails), unknown repos 404, non-smart paths 404, and a pushed commit is
 * actually served back to another authorized device (end-to-end integrity).
 *
 * Run after `pnpm build`:  node tests/p7m1-git.mjs
 */
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pexec = promisify(execFile);

const { GitStore, createGitHttpHandler } = await import(new URL("../packages/hub/dist/git/index.js", import.meta.url).href);
const { startHubServer } = await import(new URL("../packages/hub/dist/server.js", import.meta.url).href);
const { FileTrustStore } = await import(new URL("../packages/hub/dist/trust-store.js", import.meta.url).href);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const ROOT = mkdtempSync(join(tmpdir(), "glass-p7m1-"));
const store = new GitStore(join(ROOT, "hosted"));

// One hosted repo, three devices: studio (write), pro (read-only), phone (token but no grant).
store.initRepo("proj");
const tok = {
  studio: store.mintToken("studio"),
  pro: store.mintToken("pro"),
  phone: store.mintToken("phone"),
};
store.allow("proj", "studio", true);
store.allow("proj", "pro", false);

const handler = createGitHttpHandler(store);
const server = http.createServer((req, res) => {
  if (!handler(req, res)) {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const base = (user, pass) =>
  `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${port}/git`;
// git, run ASYNCHRONOUSLY — the HTTP server serving these requests lives in this
// same process, so a synchronous git would block the event loop and deadlock
// (the server could never answer git's request). Credential helpers disabled,
// no interactive prompt, low-speed timeout so a genuine stall fails fast.
async function git(args, opts = {}) {
  try {
    const { stdout, stderr } = await pexec(
      "git",
      ["-c", "credential.helper=", "-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=10", ...args],
      {
        encoding: "utf8",
        timeout: 20000,
        killSignal: "SIGKILL",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        ...opts,
      },
    );
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
async function makeLocalCommit(dir, content) {
  mkdirSync(dir, { recursive: true });
  await git(["init", "-q", "-b", "main", dir]);
  await git(["-C", dir, "config", "user.email", "t@t"]);
  await git(["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "file.txt"), content);
  await git(["-C", dir, "add", "-A"]);
  await git(["-C", dir, "commit", "-qm", "c"]);
}

console.log("Phase 7 · M1 — spoke git hosting\n");

// unit: token hashing
check("tokens: correct token verifies", store.verifyToken("studio", tok.studio) === true);
check("tokens: wrong token rejected", store.verifyToken("studio", "not-the-token") === false);
check("tokens: unknown device rejected", store.verifyToken("ghost", tok.studio) === false);

// no credentials → 401 (git can't get a username, refuses)
{
  const r = await git(["ls-remote", `http://127.0.0.1:${port}/git/proj.git`]);
  check("auth: no credentials is refused", !r.ok && /could not read Username|terminal prompts disabled|401|Authentication/i.test(r.out));
}
// wrong token → 401 (git sends creds, gets 401, reports auth failure)
{
  const r = await git(["ls-remote", `${base("studio", "wrong")}/proj.git`]);
  check("auth: wrong token is refused", !r.ok && /Authentication failed|401|Unauthorized/i.test(r.out));
}
// write device clones (write implies read)
{
  const r = await git(["clone", "-q", `${base("studio", tok.studio)}/proj.git`, join(ROOT, "studio-clone")]);
  check("acl: write device can clone", r.ok, r.ok ? "" : r.out.split("\n").slice(-2).join(" "));
}
// write device pushes a commit
{
  const wd = join(ROOT, "studio-work");
  await makeLocalCommit(wd, "from studio\n");
  const r = await git(["-C", wd, "push", "-q", `${base("studio", tok.studio)}/proj.git`, "main:main"]);
  check("acl: write device can push", r.ok, r.ok ? "" : r.out.split("\n").slice(-2).join(" "));
}
// read-only device can clone and SEE the pushed commit (end-to-end integrity)
{
  const dest = join(ROOT, "pro-clone");
  const r = await git(["clone", "-q", `${base("pro", tok.pro)}/proj.git`, dest]);
  const served = existsSync(join(dest, "file.txt")) ? readFileSync(join(dest, "file.txt"), "utf8") : "";
  check("acl: read device can clone", r.ok);
  check("integrity: read device sees the pushed commit", served.includes("from studio"), JSON.stringify(served));
}
// read-only device CANNOT push
{
  const wd = join(ROOT, "pro-work");
  await makeLocalCommit(wd, "sneaky from pro\n");
  const r = await git(["-C", wd, "push", "-q", `${base("pro", tok.pro)}/proj.git`, "main:main"]);
  check("acl: read-only device is refused push (403)", !r.ok && /403|forbidden|no write/i.test(r.out));
}
// device with a token but NO grant is refused (auth ok, ACL denies)
{
  const r = await git(["clone", "-q", `${base("phone", tok.phone)}/proj.git`, join(ROOT, "phone-clone")]);
  check("acl: granted-nothing device is refused (403)", !r.ok && /403|forbidden|no read/i.test(r.out));
}
// unknown repo → 404 (after auth)
{
  const r = await git(["ls-remote", `${base("studio", tok.studio)}/nope.git`]);
  check("repo: unknown repo is 404", !r.ok && /404|not found|not such|repository/i.test(r.out));
}
// non-smart / dumb path → 404
{
  const r = await git([
    "-c",
    "http.receivepack=false",
    "ls-remote",
    `${base("studio", tok.studio)}/../etc.git`,
  ]);
  check("path: traversal / non-repo path refused", !r.ok);
}

// End-to-end through the REAL hub server: git hosting attached to the hub's TLS
// listener (the production path), served alongside the WS endpoint.
{
  const prefix = join(ROOT, "hubcert");
  await pexec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", `${prefix}.key`, "-out", `${prefix}.crt`, "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const hub = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    mode: "trust",
    trustStore: new FileTrustStore(join(ROOT, "trust.json")),
    tls: { cert: readFileSync(`${prefix}.crt`, "utf8"), key: readFileSync(`${prefix}.key`, "utf8") },
    gitStore: store,
  });
  const hport = Number(new URL(hub.url.replace(/^wss?:/, "https:")).port);
  const r = await git([
    "-c",
    "http.sslVerify=false",
    "clone",
    "-q",
    `https://studio:${encodeURIComponent(tok.studio)}@127.0.0.1:${hport}/git/proj.git`,
    join(ROOT, "hub-clone"),
  ]);
  const served = existsSync(join(ROOT, "hub-clone", "file.txt")) ? readFileSync(join(ROOT, "hub-clone", "file.txt"), "utf8") : "";
  check("hub server: git clone over the hub's TLS listener works", r.ok && served.includes("from studio"), r.ok ? served.trim() : r.out.split("\n").slice(-2).join(" "));
  // The same listener still speaks WebSocket (git didn't clobber the WS endpoint).
  check("hub server: WS endpoint still advertised", /^wss:\/\//.test(hub.url));
  await hub.close();
}

server.close();
rmSync(ROOT, { recursive: true, force: true });

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
