// Caches the app itself so it opens without a connection.
// Photos and videos added on the phone live in IndexedDB, not here.
const CACHE = 'our-journey-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Leave video range requests, media/ files and other sites to the network.
  if (req.method !== 'GET' || req.headers.has('range') || url.origin !== location.origin) return;

  if (url.pathname.endsWith('memories.json')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  // Network first so updates show up; fall back to cache when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && !url.pathname.includes('/media/')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
