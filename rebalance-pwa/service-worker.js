const CACHE_NAME = 'rebalance-assistant-v5';
// Note: no './index.html' here. Cloudflare Pages redirects /index.html -> /,
// and a cached redirect served to a page navigation fails with ERR_FAILED.
const ASSETS = [
  './',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Rebuild a redirected response as a plain one so it's always safe to serve.
async function clean(response) {
  if (!response || !response.redirected) return response;
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map(async (url) => {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, await clean(res));
      }))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Page loads: network first (follows redirects normally), fall back to the cached app shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          if (res.ok) {
            const copy = await clean(res.clone());
            caches.open(CACHE_NAME).then((cache) => cache.put('./', copy));
          }
          return res;
        })
        .catch(async () => (await caches.match('./')) || Response.error())
    );
    return;
  }

  // Everything else: cache first, refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then(async (res) => {
          if (res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = await clean(res.clone());
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
