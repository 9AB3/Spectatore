// Spectatore PWA service worker
// - Pre-caches the app shell
// - Serves index.html for navigation requests so routes work offline
// - Runtime-caches same-origin GET requests (JS/CSS/images)

const CACHE = 'spectatore-static-v2';
const CORE = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SPA navigation fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Cache-first for same-origin assets
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => cached),
    ),
  );
});


// ----- Web Push notifications -----
self.addEventListener('push', (event) => {
  try {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'Spectatore';
    const body = data.body || '';
    const url = data.url || '/';
    const tag = data.tag || undefined;
    const options = {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag,
      data: { url, ...(data.data || {}) },
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    // ignore
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of allClients) {
        try {
          const u = new URL((c as any).url);
          // Focus an existing Spectatore tab
          if (u.origin === self.location.origin) {
            (c as any).focus();
            (c as any).navigate(url);
            return;
          }
        } catch {}
      }
      await clients.openWindow(url);
    })(),
  );
});
