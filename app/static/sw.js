// app/static/sw.js
// Service Worker for CourseDeck iPad Lite PWA offline caching.

const CACHE_NAME = 'coursedeck-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        './',
        'index.html',
        'favicon.png',
        'manifest.json',
        'fonts/fonts.css',
        'vendor/katex/katex.min.css'
      ]).catch((err) => {
        console.warn('[SW Install Cache Warning]', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls and health check: network only, do not cache via service worker
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ message: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Non-GET requests (e.g. form POST): network only
  if (event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell & static assets: cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (url.pathname.endsWith('.js') ||
              url.pathname.endsWith('.css') ||
              url.pathname.endsWith('.woff') ||
              url.pathname.endsWith('.woff2') ||
              url.pathname.endsWith('.ttf') ||
              url.pathname.endsWith('.png') ||
              url.pathname.endsWith('.svg') ||
              url.pathname.endsWith('.ico') ||
              url.pathname.endsWith('.html') ||
              url.pathname === '/' ||
              url.pathname.includes('/_app/'))
          ) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          // If offline and navigating to a page, serve cached index.html for SPA router
          if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
            return (
              (await caches.match('index.html')) ||
              (await caches.match('./')) ||
              (await caches.match('/index.html')) ||
              (await caches.match('/'))
            );
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
    })
  );
});
