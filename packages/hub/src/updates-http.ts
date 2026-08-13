/**
 * Desktop auto-update endpoint (served on the hub's TLS listener under /updates/).
 *
 * The Tauri updater on each device fetches /updates/latest.json (the manifest it
 * compares against its own version) and, if newer, the artifact it names (a
 * signed .app.tar.gz). We only serve bare filenames directly inside `dir` — no
 * traversal, no nested paths, GET/HEAD only. Integrity is NOT this handler's job:
 * the updater verifies the artifact against the app's embedded minisign public
 * key (and the .app inside is Developer-ID notarized), so a tampered/hostile file
 * here is rejected on the device. Files are streamed, never buffered whole.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { resolve, sep, basename } from "node:path";

export interface UpdatesHandler {
  /** Handle a /updates/ request; returns false only when this isn't ours. */
  (req: IncomingMessage, res: ServerResponse): boolean;
}

/** Concurrent artifact streams; the tarball is large, so a flood here could
 *  starve the shared listener (the relay). Bound it — normal fleet updates are
 *  a handful of devices, never hundreds at once. */
const MAX_INFLIGHT = 8;

export function createUpdatesHandler(dir: string): UpdatesHandler {
  if (!dir) return () => false;
  const root = resolve(dir);
  let inFlight = 0;

  return (req, res): boolean => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://glass.local").pathname);
    } catch {
      return false;
    }
    if (pathname !== "/updates" && !pathname.startsWith("/updates/")) return false;

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
    if (pathname.includes("\0")) {
      send(400, "bad request");
      return true;
    }

    // Only a bare filename directly under /updates/ — no subdirs, no traversal.
    const name = pathname.slice("/updates/".length);
    if (!name || name !== basename(name) || name === "." || name === "..") {
      send(404, "not found");
      return true;
    }
    const candidate = resolve(root, name);
    if (!candidate.startsWith(root + sep)) {
      send(404, "not found");
      return true;
    }
    let size: number;
    try {
      const st = statSync(candidate);
      if (!st.isFile()) {
        send(404, "not found");
        return true;
      }
      size = st.size;
    } catch {
      send(404, "not found");
      return true;
    }

    // Cap concurrent downloads so an artifact flood/slow-read can't starve the
    // relay sharing this listener. HEAD (no body) isn't counted.
    if (method === "GET" && inFlight >= MAX_INFLIGHT) {
      res.writeHead(503, { "content-type": "text/plain", "retry-after": "5" });
      res.end("busy; try again shortly");
      return true;
    }
    res.writeHead(200, {
      "content-type": name.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
      "content-length": String(size),
      "cache-control": "no-cache",
    });
    if (method === "HEAD") {
      res.end();
      return true;
    }
    inFlight++;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
    res.on("close", release);
    const stream = createReadStream(candidate);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return true;
  };
}
