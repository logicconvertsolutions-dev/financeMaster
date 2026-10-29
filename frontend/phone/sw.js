// Phone app service worker (filled in at build time by the phone plugin in vite.config.js).
// 1. Keeps every file of the app on the phone so it opens offline.
// 2. Blocks any request to another site, from the page or the engine: the app only ever talks to itself.
const BUILD = __BUILD__;
const PRECACHE = __PRECACHE__;
const CACHE = `finance-master-${BUILD}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("finance-master-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(Response.error());
    return;
  }
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    // Newest page when online (quickly), the saved one otherwise.
    const cached = () => caches.match("./index.html");
    const online = fetch(event.request).then((r) => (r.ok ? r : cached()));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000)).then(cached);
    event.respondWith(Promise.race([online, timeout]).then((r) => r || cached()).catch(cached));
    return;
  }
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then((r) => r || fetch(event.request)));
});
