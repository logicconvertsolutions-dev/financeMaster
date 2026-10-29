// Phone app service worker (filled in at build time by the phone plugin in vite.config.ts).
// 1. Keeps every file of the app on the phone so it opens offline.
// 2. Blocks any request to another site, from the page or the engine: the app only ever talks to itself.
const BUILD = "02909e8092c2";
const PRECACHE = ["./","./assets/index-D5NQZfBV.css","./assets/index-BFl6V9sJ.js","./assets/engine.worker-CkDu_gOc.js","./icon-180.png","./icon-192.png","./icon-512.png","./manifest.webmanifest","./pyodide/314.0.7/annotated_doc-0.0.4-py3-none-any.whl","./pyodide/314.0.7/annotated_types-0.7.0-py3-none-any.whl","./pyodide/314.0.7/anyio-4.13.0-py3-none-any.whl","./pyodide/314.0.7/fastapi-0.136.1-py3-none-any.whl","./pyodide/314.0.7/httpx-0.28.1-py3-none-any.whl","./pyodide/314.0.7/jinja2-3.1.6-py3-none-any.whl","./pyodide/314.0.7/markupsafe-3.0.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl","./pyodide/314.0.7/pydantic-2.12.5-py3-none-any.whl","./pyodide/314.0.7/pydantic_core-2.41.5-cp314-cp314-pyemscripten_2026_0_wasm32.whl","./pyodide/314.0.7/pyodide-lock.json","./pyodide/314.0.7/pyodide.asm.mjs","./pyodide/314.0.7/pyodide.asm.wasm","./pyodide/314.0.7/pyodide.mjs","./pyodide/314.0.7/python_stdlib.zip","./pyodide/314.0.7/sniffio-1.3.1-py3-none-any.whl","./pyodide/314.0.7/starlette-1.0.0-py3-none-any.whl","./pyodide/314.0.7/typing_extensions-4.15.0-py3-none-any.whl","./pyodide/314.0.7/typing_inspection-0.4.2-py3-none-any.whl"];
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
