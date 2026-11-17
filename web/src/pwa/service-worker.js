const scope = self.registration.scope;
const cachePrefix = "chat-demo:pwa:" + scope + ":";
const cacheName = cachePrefix + build.version;
const indexUrl = new URL("index.html", scope).href;
const assetUrls = new Set(build.assets.map((path) => new URL(path, scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      await cache.addAll([...assetUrls].map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  const appPage =
    request.mode === "navigate" &&
    (url.origin + url.pathname === scope || url.origin + url.pathname === indexUrl);
  if (!appPage && !assetUrls.has(url.href)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      if (appPage) {
        try {
          return await fetch(request, { cache: "no-cache" });
        } catch {
          return (await cache.match(indexUrl)) ?? Response.error();
        }
      }
      return (await cache.match(request)) ?? fetch(request);
    })(),
  );
});
