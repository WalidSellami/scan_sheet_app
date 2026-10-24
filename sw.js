const CACHE_NAME = 'scan-sheet-pwa-v8';
const ASSETS_TO_CACHE = [
  './',
  './manifest.json',
  './css/bootstrap.rtl.min.css',
  './css/style.css',
  './js/html5-qrcode.min.js',
  './js/xlsx.full.min.js',
  './js/app.js',
  './icons/icon.svg'
];

// Message listener for immediate activation
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Install: Cache all core assets and mirror root shell across all path variants
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[ServiceWorker] Caching app shell v8');
      await Promise.all(
        ASSETS_TO_CACHE.map(async (url) => {
          try {
            const response = await fetch(url);
            if (response && (response.ok || response.type === 'basic')) {
              await cache.put(url, response.clone());
              // Mirror the root document to all possible navigation paths
              if (url === './' || url === '/') {
                await cache.put('/', response.clone());
                await cache.put('/index.html', response.clone());
                await cache.put('./index.html', response.clone());
              }
            }
          } catch (err) {
            console.warn('[ServiceWorker] Could not pre-cache:', url, err);
          }
        })
      );
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

// Fetch: Bulletproof Navigation & Offline Strategy
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. Navigation requests (PWA home screen launch, address bar /index.html or /)
  const isNavigation = event.request.mode === 'navigate' ||
                       url.pathname === '/' ||
                       url.pathname === '/index.html' ||
                       url.pathname.endsWith('/index.html') ||
                       (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html'));

  if (isNavigation) {
    event.respondWith(
      (async () => {
        try {
          const cache = await caches.open(CACHE_NAME);

          // 1. Check cache first for instant offline startup
          let cached = await cache.match(event.request, { ignoreSearch: true });
          if (cached) return cached;

          // Check canonical HTML shell keys
          cached = (await cache.match('/')) ||
                   (await cache.match('/index.html')) ||
                   (await cache.match('./')) ||
                   (await cache.match('./index.html'));
          if (cached) return cached;

          // 2. Fetch from network (never pass options that conflict with navigate mode)
          try {
            const networkResponse = await fetch(event.request);
            if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'basic')) {
              cache.put(event.request, networkResponse.clone()).catch(() => {});
              cache.put('/', networkResponse.clone()).catch(() => {});
              cache.put('/index.html', networkResponse.clone()).catch(() => {});
              return networkResponse;
            }
            if (networkResponse) {
              return networkResponse;
            }
          } catch (netErr) {
            console.warn('[ServiceWorker] Network navigation failed, falling back to cache:', netErr);
          }

          // 3. Fallback to any cached HTML
          const fallback = (await caches.match('/', { ignoreSearch: true })) ||
                           (await caches.match('/index.html', { ignoreSearch: true })) ||
                           (await caches.match('./', { ignoreSearch: true })) ||
                           (await caches.match('./index.html', { ignoreSearch: true }));
          if (fallback) return fallback;

          // 4. Safe recovery response (guarantees event.respondWith never resolves to undefined or ERR_FAILED)
          return new Response(
            '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>ScanSheet</title><meta http-equiv="refresh" content="0; url=/"></head><body><script>location.replace("/");</script></body></html>',
            {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        } catch (err) {
          console.error('[ServiceWorker] Navigation handler exception:', err);
          return new Response(
            '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0; url=/"></head><body><script>location.replace("/");</script></body></html>',
            {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        }
      })()
    );
    return;
  }

  // 2. Static Assets (CSS, JS, SVG, Fonts, Manifest)
  event.respondWith(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request, { ignoreSearch: true });
        if (cached) return cached;

        const networkResponse = await fetch(event.request);
        if (networkResponse && networkResponse.status === 200) {
          cache.put(event.request, networkResponse.clone()).catch(() => {});
        }
        return networkResponse;
      } catch (err) {
        const fallback = await caches.match(event.request, { ignoreSearch: true });
        if (fallback) return fallback;
        throw err;
      }
    })()
  );
});
