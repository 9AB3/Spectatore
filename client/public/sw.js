// Simple service worker for offline caching
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open('spectatore-static-v1')
      .then((cache) => cache.addAll(['/', '/index.html', '/manifest.webmanifest'])),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
