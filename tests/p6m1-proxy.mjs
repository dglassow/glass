/**
 * Phase 6 · Milestone 1 — acceptance test for the browser proxy.
 *
 * Proves the SOCKS5 exit endpoint actually proxies: a client (curl, standing in
 * for a browser) speaks SOCKS5 to the exit, and the outbound connection is made
 * FROM the exit process — egress happens there (plan §7). Also covers the
 * allow-gate, the managed-profile launch args (isolation + proxy pinning), and
 * the reserved proxy protocol messages.
 *
 * Run after `pnpm build`:  node tests/p6m1-proxy.mjs
 */
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);

const agent = await import(new URL("../packages/agent/dist/proxy/index.js", import.meta.url).href);
const proto = await import(new URL("../packages/protocol/dist/index.js", import.meta.url).href);
const { createSocks5Server, buildBrowserLaunch, ProxyExit, ProxyForwarder } = agent;
const { parseEnvelope, makeEnvelope } = proto;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const listen = (server, host = "127.0.0.1") => new Promise((r) => server.listen(0, host, () => r(server.address().port)));

console.log("Phase 6 · M1 — browser proxy (SOCKS5 exit)\n");

// A target the exit will reach on our behalf.
const MARK = "EGRESS-OK-7f3a";
const target = http.createServer((_req, res) => res.end(MARK));
const targetPort = await listen(target);

// ── SOCKS5 exit proxies a request; egress happens at the exit ──
{
  const seen = [];
  const exit = createSocks5Server({ onConnect: (h, p) => seen.push(`${h}:${p}`) });
  const exitPort = await listen(exit);
  const { stdout } = await pexec(
    "curl",
    ["-s", "--max-time", "8", "--socks5-hostname", `127.0.0.1:${exitPort}`, `http://localhost:${targetPort}/`],
    { timeout: 10000 },
  );
  check("socks5: request is proxied to the target through the exit", stdout.includes(MARK), stdout.slice(0, 40));
  check("socks5: exit observed the CONNECT (domain ATYP, remote DNS)", seen.includes(`localhost:${targetPort}`), seen.join(","));
  exit.close();
}

// ── allow-gate refuses a destination before dialling ──
{
  let dialed = false;
  const exit = createSocks5Server({ allow: () => false, onConnect: () => (dialed = true) });
  const exitPort = await listen(exit);
  const r = await pexec("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "6", "--socks5-hostname", `127.0.0.1:${exitPort}`, `http://localhost:${targetPort}/`], { timeout: 8000 }).then(
    () => ({ ok: true }),
    (e) => ({ ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }),
  );
  check("socks5: allow-gate refuses the connection", !r.ok);
  check("socks5: refused destination is never dialled", dialed === false);
  exit.close();
}

// ── cross-device tunnel: SOCKS listener ⇄ proxy.* frames ⇄ exit ⇄ target ──
// The two halves are wired in-process here, standing in for hub routing.
{
  const seen = [];
  let exit, forwarder;
  exit = new ProxyExit((m) => forwarder.handle(m), { onOpen: (h, p) => seen.push(`${h}:${p}`) });
  forwarder = new ProxyForwarder((m) => exit.handle(m));
  const fport = await forwarder.listen();
  const { stdout } = await pexec(
    "curl",
    ["-s", "--max-time", "8", "--socks5-hostname", `127.0.0.1:${fport}`, `http://localhost:${targetPort}/`],
    { timeout: 10000 },
  );
  check("tunnel: request traverses forwarder→proxy.*→exit→target", stdout.includes(MARK), stdout.slice(0, 40));
  check("tunnel: egress dial happened at the EXIT, not the forwarder", seen.includes(`localhost:${targetPort}`), seen.join(","));
  forwarder.close();
  exit.closeAll();
}
target.close();

// ── managed-profile launch args (isolation + proxy pinning) ──
{
  const l = buildBrowserLaunch({ socksHost: "127.0.0.1", socksPort: 4321, profileDir: "/tmp/glass-prof-A", url: "https://example.com" });
  check("browser: proxy pinned to the SOCKS endpoint", l.args.includes("--proxy-server=socks5://127.0.0.1:4321"));
  check("browser: profile isolated via --user-data-dir", l.args.includes("--user-data-dir=/tmp/glass-prof-A"));
  check("browser: initial URL is passed last", l.args[l.args.length - 1] === "https://example.com");
  const b = buildBrowserLaunch({ socksHost: "127.0.0.1", socksPort: 4321, profileDir: "/tmp/glass-prof-B" });
  check("browser: distinct profiles → distinct data dirs (isolation)", !b.args.includes("--user-data-dir=/tmp/glass-prof-A"));
  check("browser: invalid port is rejected", throws(() => buildBrowserLaunch({ socksHost: "127.0.0.1", socksPort: 0, profileDir: "/tmp/x" })));
  check("browser: missing profile dir is rejected", throws(() => buildBrowserLaunch({ socksHost: "127.0.0.1", socksPort: 8080, profileDir: "" })));
}

// ── reserved proxy protocol messages parse (and validate) ──
{
  const mk = (body) => parseEnvelope(makeEnvelope({ id: crypto.randomUUID(), ts: Date.now(), from: "pro", to: "studio", body }));
  check("protocol: proxy.open validates", mk({ type: "proxy.open", channelId: "c1", host: "example.com", port: 443 }).ok);
  check("protocol: proxy.data validates", mk({ type: "proxy.data", channelId: "c1", data: Buffer.from("hi").toString("base64") }).ok);
  check("protocol: proxy.close validates", mk({ type: "proxy.close", channelId: "c1" }).ok);
  // Build the invalid one as a raw frame — makeEnvelope validates on construction.
  const rawBad = { v: 1, id: crypto.randomUUID(), ts: Date.now(), from: "pro", to: "studio", body: { type: "proxy.open", channelId: "c1", host: "x", port: 70000 } };
  check("protocol: proxy.open with bad port is refused", !parseEnvelope(rawBad).ok);
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
