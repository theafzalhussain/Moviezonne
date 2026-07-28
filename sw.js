const CACHE_NAME = 'moviezone-v7';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/moviezone.css',
  '/search-engine.js',
  '/moviezone.js',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
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
          const cached = await caches.match(event.request);
          if (cached) return cached;
          if (event.request.mode === 'navigate') return caches.match('/index.html');
          throw new Error('Offline asset unavailable');
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
      }
      return response;
    }))
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
    icon: data.icon || '/icon-192.svg',
    badge: data.badge || '/icon-192.svg',
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
