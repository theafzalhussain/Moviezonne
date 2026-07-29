const CACHE_NAME = 'moviezone-v32';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/moviezone.css?v=4.0',
  '/search-engine.js?v=1.1',
  '/moviezone.js?v=4.6',
  '/pwa-install.js?v=1.6',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon-32.png',
  '/apple-touch-icon.png'
];

// Large/feature-specific data should never block a new service worker from
// installing. It is cached opportunistically and fetched from the network if absent.
const OPTIONAL_ASSETS = [
  '/collections-catalog.json?v=2'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        // Core shell failures should remain visible; optional feature data must not
        // reject the whole service-worker install (the catalog can load online).
        await cache.addAll(STATIC_ASSETS);
        const optionalResults = await Promise.allSettled(
          OPTIONAL_ASSETS.map(asset => cache.add(asset))
        );
        optionalResults.forEach((result, index) => {
          if (result.status === 'rejected') {
            console.warn('[MovieZone SW] Optional precache skipped:', OPTIONAL_ASSETS[index]);
          }
        });
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;

  const networkFirst = event.request.mode === 'navigate' ||
    event.request.destination === 'script' ||
    event.request.destination === 'style';

  if (networkFirst) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
          }
          return response;
        })
        .catch(async () => {
          // Try exact match first, then try stripping query string for pre-cached assets
          let cached = await caches.match(event.request);
          if (!cached && url.search) {
            cached = await caches.match(url.pathname + url.search, { ignoreSearch: false });
            if (!cached) cached = await caches.match(url.pathname);
          }
          if (cached) return cached;
          if (event.request.mode === 'navigate') return caches.match('/index.html');
          throw new Error('Offline asset unavailable');
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      // Fallback: try ignoring search params for pre-cached assets
      const reqUrl = new URL(event.request.url);
      return (reqUrl.search ? caches.match(reqUrl.pathname) : Promise.resolve(null))
        .then(altCached => {
          if (altCached) return altCached;
          return fetch(event.request).then(response => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
            }
            return response;
          });
        });
    })
  );
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { body: event.data ? event.data.text() : 'A new movie update is available.' };
  }

  const title = data.title || 'MovieZone';
  const options = {
    body: data.body || 'A new movie update is available.',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || `moviezone-${Date.now()}`,
    renotify: Boolean(data.tag),
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/',
      type: data.type || 'movie-update'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if ('navigate' in client) await client.navigate(targetUrl);
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
