/**
 * Static file handler for the viewer PWA (plan §5: "PWA served by the Hub").
 *
 * Mounted on the hub's existing authenticated HTTPS listener, AFTER the /git/
 * smart-HTTP handler — same handled/not-handled contract as the git handler:
 * the returned function replies and returns true when the request is ours,
 * and returns false only when no webRoot is configured.
 *
 * Serves the viewer's build output (dist-web, built separately) for GET/HEAD:
 *   - "/" maps to index.html; other paths map to files under webRoot;
 *   - path traversal is impossible: the decoded path is resolved and must stay
 *     inside webRoot, or the request is rejected;
 *   - /assets/* (Vite's content-hashed output) is cached immutable for a year;
 *     index.html and sw.js are no-cache so updates are picked up promptly;
 *   - SPA fallback: an extensionless path that matches no file (and is not
 *     under /git/ or /assets/) gets index.html so client-side routing works;
 *   - a genuinely missing file under /assets/ (or any missing path with a file
 *     extension) is a 404, never a misleading index.html.
 * Files are streamed, never buffered whole.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_NONE = "no-cache";

export interface StaticHandler {
  /** Handle a request from webRoot; returns false only when no webRoot is set. */
  (req: IncomingMessage, res: ServerResponse): boolean;
}

/** Regular file at `path`, or null (missing, directory, unreadable, ...). */
function fileSize(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

export function createStaticHandler(webRoot: string): StaticHandler {
  if (!webRoot) return () => false;
  const root = resolve(webRoot);

  return (req, res): boolean => {
    const send = (code: number, body: string): void => {
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(body);
    };

    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain", allow: "GET, HEAD" });
      res.end("method not allowed");
      return true;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://glass.local").pathname);
    } catch {
      send(400, "bad request path");
      return true;
    }
    if (pathname.includes("\0")) {
      send(400, "bad request path");
      return true;
    }
    // /git/ belongs to the git handler (which runs first); a /git/ request
    // reaching us means git hosting is off — that's a 404, never the SPA shell.
    if (pathname === "/git" || pathname.startsWith("/git/")) {
      send(404, "not found");
      return true;
    }

    const serve = (filePath: string, urlPath: string): void => {
      const size = fileSize(filePath);
      if (size === null) {
        send(404, "not found");
        return;
      }
      const ext = extname(filePath).toLowerCase();
      // Content-hashed assets never change under the same name; everything
      // else (index.html, sw.js, manifest, icons at stable paths) revalidates.
      const cache = urlPath.startsWith("/assets/") ? CACHE_IMMUTABLE : CACHE_NONE;
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "content-length": String(size),
        "cache-control": cache,
      });
      if (method === "HEAD") {
        res.end();
        return;
      }
      const stream = createReadStream(filePath);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    };

    const target = pathname === "/" ? "/index.html" : pathname;
    // Traversal-safe mapping: resolve against the root, then require the result
    // to still live inside it. `..` segments and absolute tricks land outside
    // and are rejected before any filesystem access.
    const candidate = resolve(root, "." + target);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      send(404, "not found");
      return true;
    }

    if (fileSize(candidate) !== null) {
      serve(candidate, target);
      return true;
    }

    // Missing. Assets and anything that names a concrete file (has an
    // extension) are honest 404s; extensionless app routes fall back to
    // index.html for the SPA router.
    if (target.startsWith("/assets/") || extname(target) !== "") {
      send(404, "not found");
      return true;
    }
    serve(resolve(root, "index.html"), "/index.html");
    return true;
  };
}
