// Spectatore PWA service worker
// - Pre-caches app shell (best-effort, won't fail install if a file 404s)
// - Serves index.html for navigation requests so routes work offline
// - Runtime-caches same-origin GET requests (JS/CSS/images)
// - Handles Web Push notifications

const CACHE = 'spectatore-static-v3';

// Keep this list SMALL and RELIABLE. If any item 404s, install can fail.
// We cache best-effort below so even if something is missing the SW still installs.
const CORE = ['/', '/index.html'];

async function cacheBestEffort(cache, urls) {
  await Promise.all(
    urls.map(async (u) => {
      try {
        const res = await fetch(u, { cache: 'no-store' });
        if (res.ok) await cache.put(u, res);
      } catch {
        // ignore missing/offline during install
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      // Best-effort cache core + common PWA assets if they exist
      await cacheBestEffort(cache, [
        ...CORE,

        // Optional: only cached if they exist (won't break install)
        '/manifest.webmanifest',
        '/manifest.json',

        // Optional icons (cache if present)
        '/icon-192.png',
        '/icon-512.png',
        '/pwa-192x192.png',
        '/pwa-512x512.png',
        '/apple-touch-icon.png',
        '/favicon.ico',
      ]);

      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API responses. Caching /api in dev makes the UI appear stale
  // and in prod it can serve incorrect permissioned data.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // In local dev, avoid all caching so Vite HMR and live testing behave normally.
  if (
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1' ||
    self.location.hostname.endsWith('.localhost')
  ) {
    event.respondWith(fetch(req));
    return;
  }

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
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => cached);
    }),
  );
});

// ----- Web Push notifications -----
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        // Some push payloads are text, not JSON
        data = event.data ? (event.data.json ? event.data.json() : {}) : {};
      } catch {
        try {
          const txt = event.data ? event.data.text() : '';
          data = txt ? { body: txt } : {};
        } catch {
          data = {};
        }
      }

      const title = data.title || 'Spectatore';
      const body = data.body || '';
      const url = data.url || '/';
      const tag = data.tag;

      await self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag,
        data: { url, ...(data.data || {}) },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

      for (const c of allClients) {
        try {
          const cu = new URL(c.url);
          if (cu.origin === self.location.origin) {
            await c.focus();
            // navigate() can fail in some browsers; ignore if so
            try { await c.navigate(url); } catch {}
            return;
          }
        } catch {}
      }

      await clients.openWindow(url);
    })(),
  );
});
