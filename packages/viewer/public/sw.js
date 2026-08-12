/* Glass viewer service worker (PWA tier only — never registered in the Tauri
 * shell, see src/main.ts). Strategy:
 *   - navigations: network-first, falling back to the cached app shell ("/")
 *     so the installed app still opens with no connectivity;
 *   - same-origin static assets (hashed js/css, icons, manifest): cache-first,
 *     populated on first fetch.
 * Bump CACHE_VERSION to invalidate old caches on deploy.
 */
const CACHE_VERSION = "glass-viewer-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/192.png", "/icons/512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin (incl. ws upgrades are non-GET-cacheable anyway)

  // Navigations: network-first with offline fallback to the cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Same-origin static assets: cache-first, populate on miss.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && (res.type === "basic" || res.type === "default")) {
            const copy = res.clone();
            void caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
