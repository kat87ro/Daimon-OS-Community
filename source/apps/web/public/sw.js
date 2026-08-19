// Daimon-OS service worker — minimal app-shell cache for installability.
// The app is a live terminal dashboard, so we deliberately do NOT cache API
// or WebSocket traffic; only the shell is precached, network-first elsewhere.
const CACHE = "daimon-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // never intercept the gateway API or non-GET — let them hit the network raw.
  // match the gateway by loopback host (port-agnostic: the desktop gateway binds
  // an OS-assigned port, so a fixed port literal would never match it) or by the
  // /api path prefix.
  if (
    e.request.method !== "GET" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.pathname.startsWith("/api")
  ) {
    return;
  }
  // network-first, fall back to cache when offline (so the shell still opens)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("/"))),
  );
});
