const CACHE_NAME = 'scan-sheet-pwa-v7';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/bootstrap.rtl.min.css',
  './css/style.css',
  './js/html5-qrcode.min.js',
  './js/xlsx.full.min.js',
  './js/app.js',
  './icons/icon.svg'
];

// Install: Cache all core assets with redirect-following support
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[ServiceWorker] Caching app shell');
      await Promise.all(
        ASSETS_TO_CACHE.map(async (url) => {
          try {
            const response = await fetch(url, { redirect: 'follow' });
            if (response && response.ok) {
              await cache.put(url, response);
            }
          } catch (err) {
            console.warn('[ServiceWorker] Could not pre-cache:', url, err);
          }
        })
      );

      // Ensure root '/' and './index.html' are always cached and mirrored
      const indexResp = (await cache.match('./index.html')) || (await cache.match('./'));
      if (indexResp) {
        await cache.put('./', indexResp.clone());
        await cache.put('./index.html', indexResp.clone());
      }
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up older cache versions and take control immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[ServiceWorker] Removing obsolete cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Offline-First Navigation Strategy
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. Navigation requests (PWA home screen launch, address bar navigation)
  if (event.request.mode === 'navigate' || url.pathname.endsWith('index.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true })
        .then((cached) => {
          if (cached) return cached;
          return caches.match('./index.html', { ignoreSearch: true });
        })
        .then((cached) => {
          if (cached) return cached;
          return caches.match('./', { ignoreSearch: true });
        })
        .then((cached) => {
          if (cached) return cached;
          return fetch(event.request, { redirect: 'follow' });
        })
        .catch(() => {
          return caches.match('./index.html', { ignoreSearch: true }) || caches.match('./', { ignoreSearch: true });
        })
    );
    return;
  }

  // 2. Static Assets (CSS, JS, SVG, Fonts)
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch((err) => {
        if (event.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
          return caches.match('./index.html', { ignoreSearch: true });
        }
        throw err;
      });
    })
  );
});
