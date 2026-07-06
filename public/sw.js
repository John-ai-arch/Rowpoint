// RowPoint service worker — makes the site installable as an app and keeps
// the shell available offline. Strategy: network-first with cache fallback
// for same-origin static assets (so deploys are picked up immediately, but
// the app still opens with no signal); API and WebSocket traffic is NEVER
// cached — workout data correctness relies on the app's own offline queue.
const CACHE = 'rowpoint-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(['/', '/styles.css', '/manifest.webmanifest']).catch(() => { /* best effort */ }),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return; // never cache data

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // SPA routes fall back to the cached shell.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
