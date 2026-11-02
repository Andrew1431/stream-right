// Makes the site installable and keeps the app shell available offline. Rooms need the
// network anyway, so API calls and other origins are never touched.
const SHELL = "shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Network first, so a deploy shows up on the next launch; the cache is only a fallback.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req.mode === "navigate" ? "/" : req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req.mode === "navigate" ? "/" : req)) ?? Response.error()),
  );
});
