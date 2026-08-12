/**
 * Smart-HTTP git handler (plan §13/Phase 7). Mounted on the hub's own TLS
 * listener under /git/, so spokes clone/push over the same authenticated tunnel
 * as everything else — no separate SSH service.
 *
 * Security order (never reach the backend without passing all three):
 *   1. auth      — HTTP Basic user=deviceId, pass=bearer token (scrypt-checked);
 *   2. repo      — must exist in the store (name is store-validated, no traversal);
 *   3. ACL       — read ops need canRead, push ops need canWrite.
 * Only the four smart endpoints are exposed (no dumb-protocol object serving),
 * and the CGI environment is constructed explicitly, never inherited from the
 * request beyond the few fields git needs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { GitStore } from "./git-store.js";

let cachedBackend: string | null = null;
function backendPath(): string {
  if (cachedBackend) return cachedBackend;
  try {
    cachedBackend = `${execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim()}/git-http-backend`;
  } catch {
    cachedBackend = "git-http-backend";
  }
  return cachedBackend;
}

interface Parsed {
  repo: string;
  rest: string; // e.g. "info/refs" | "git-upload-pack" | "git-receive-pack"
  write: boolean;
}

/** Classify a /git/<repo>.git/<rest> request, or null if it isn't a smart endpoint. */
function classify(method: string, pathname: string, service: string | null): Parsed | null {
  const m = /^\/git\/([^/]+?)\.git\/(.+)$/.exec(pathname);
  if (!m) return null;
  const repo = m[1] as string;
  const rest = m[2] as string;
  if (method === "GET" && rest === "info/refs") {
    if (service === "git-upload-pack") return { repo, rest, write: false };
    if (service === "git-receive-pack") return { repo, rest, write: true };
    return null; // dumb protocol not offered
  }
  if (method === "POST" && rest === "git-upload-pack") return { repo, rest, write: false };
  if (method === "POST" && rest === "git-receive-pack") return { repo, rest, write: true };
  return null;
}

function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !/^Basic /i.test(header)) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

export interface GitHttpHandler {
  /** Handle a request if it targets /git/; returns false if it isn't ours. */
  (req: IncomingMessage, res: ServerResponse): boolean;
}

export function createGitHttpHandler(store: GitStore): GitHttpHandler {
  return (req, res): boolean => {
    const url = new URL(req.url ?? "/", "http://glass.local");
    if (!url.pathname.startsWith("/git/")) return false;

    const send = (code: number, body: string, extra: Record<string, string> = {}): void => {
      res.writeHead(code, { "content-type": "text/plain", ...extra });
      res.end(body);
    };

    const parsed = classify(req.method ?? "GET", url.pathname, url.searchParams.get("service"));
    if (!parsed) {
      send(404, "not a supported git endpoint");
      return true;
    }

    // 1. auth
    const creds = parseBasic(req.headers.authorization);
    if (!creds || !store.verifyToken(creds.user, creds.pass)) {
      send(401, "authentication required", { "www-authenticate": 'Basic realm="glass-git"' });
      return true;
    }
    const deviceId = creds.user;

    // 2. repo exists
    if (!store.repoExists(parsed.repo)) {
      send(404, "no such repo");
      return true;
    }

    // 3. ACL
    const permitted = parsed.write ? store.canWrite(parsed.repo, deviceId) : store.canRead(parsed.repo, deviceId);
    if (!permitted) {
      send(403, parsed.write ? "no write access" : "no read access");
      return true;
    }

    // Delegate to git-http-backend as a CGI. Environment is explicit.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: store.projectRoot(),
      GIT_HTTP_EXPORT_ALL: "1", // ACL already enforced above
      REQUEST_METHOD: req.method,
      PATH_INFO: `/${parsed.repo}.git/${parsed.rest}`,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: deviceId,
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
      GIT_PROTOCOL: (req.headers["git-protocol"] as string) ?? "",
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
    };

    const cp = spawn(backendPath(), { env });
    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    const HEADER_CAP = 64 * 1024;

    cp.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sep = headerBuf.indexOf("\r\n\r\n");
      const sepLen = sep >= 0 ? 4 : headerBuf.indexOf("\n\n") >= 0 ? 2 : -1;
      const at = sep >= 0 ? sep : headerBuf.indexOf("\n\n");
      if (at < 0) {
        if (headerBuf.length > HEADER_CAP) {
          cp.kill("SIGKILL");
          if (!res.headersSent) send(500, "git backend header overflow");
        }
        return;
      }
      const head = headerBuf.slice(0, at).toString("utf8");
      const body = headerBuf.slice(at + sepLen);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split(/\r?\n/)) {
        const sm = /^Status:\s*(\d{3})/.exec(line);
        if (sm) {
          status = Number(sm[1]);
          continue;
        }
        const hm = /^([^:]+):\s*(.*)$/.exec(line);
        if (hm && hm[1]) headers[hm[1].toLowerCase()] = hm[2] ?? "";
      }
      res.writeHead(status, headers);
      if (body.length) res.write(body);
      headersDone = true;
    });

    cp.stdout.on("end", () => {
      if (!headersDone && !res.headersSent) send(500, "git backend produced no output");
      else res.end();
    });
    cp.on("error", () => {
      if (!res.headersSent) send(500, "git backend failed to start");
      else res.end();
    });
    cp.stderr.on("data", () => {}); // keep the pipe drained

    req.pipe(cp.stdin);
    req.on("error", () => cp.kill("SIGKILL"));
    return true;
  };
}
