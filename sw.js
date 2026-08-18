// v59: the shell precaches the MINIFIED bundles, matching index.html.
//
// Keep these query strings in step with index.html on every asset bump — an
// offline client is served exactly these URLs, so a stale entry here means a
// phone keeps running old code with no way to tell. asset-perf-check.js fails
// the build if the two lists drift apart.
//
// v59 changes (Core Web Vitals):
//   * moviezone.min.js was pinned at ?v=7.2 while index.html asked for 7.5.
//     The precached copy was therefore never served and never used — it was
//     dead weight in the cache and offline clients had no bundle at all.
//     Now 7.6 on both sides.
//   * Versioned same-origin assets became CACHE-FIRST (see below).
//   * TMDB images get their own stale-while-revalidate cache.
const CACHE_NAME = 'moviezone-v84';

// Separate cache for TMDB posters/backdrops. Kept apart from the shell so the
// activate handler can wipe an old shell without throwing away hundreds of
// images the next visit would otherwise re-download.
const IMAGE_CACHE = 'moviezone-tmdb-images-v1';

// Hard ceiling on the image cache. Roughly 50 MB at TMDB w342/w780 sizes.
const IMAGE_CACHE_MAX_ENTRIES = 400;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/tv-mode.min.css?v=1.3',
  '/moviezone.min.css?v=6.4',
  '/tv-mode.min.js?v=1.4',
  '/search-engine.min.js?v=2.1',
  '/moviezone.min.js?v=9.7',
  '/manifest.json',
  '/moviezone-logo.png?v=2',
  '/icon-192.png?v=2',
  '/icon-512.png?v=2',
  '/favicon-32.png?v=2',
  '/apple-touch-icon.png?v=2',
  // Self-hosted fonts (were Google Fonts). These are on the critical render
  // path for the hero title, so an offline or flaky-network visit must not fall
  // back to a system face and reflow the page.
  '/fonts/outfit-latin-var.woff2',
  '/fonts/bebas-neue-latin-400.woff2'
];

// Large/feature-specific data should never block a new service worker from
// installing. It is cached opportunistically and fetched from the network if absent.
const OPTIONAL_ASSETS = [
  '/collections-catalog.json?v=2',
  // pwa-install.min.js moved off the critical path: index.html no longer ships a
  // <script> tag for it, it is injected on idle / on demand. Still worth having
  // offline so the install popup works, but it must not be able to fail a
  // service-worker install the way a core-shell entry can.
  '/pwa-install.min.js?v=1.9',
  '/fonts/outfit-latin-ext-var.woff2',
  '/fonts/bebas-neue-latin-ext-400.woff2',
  '/fonts/playfair-display-latin-700.woff2',
  '/fonts/playfair-display-latin-ext-700.woff2',
  '/fonts/playfair-display-latin-italic-400.woff2',
  '/fonts/playfair-display-latin-ext-italic-400.woff2'
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
      .then(keys => Promise.all(
        keys
          // IMAGE_CACHE must survive a shell bump: those bytes are version-independent
          // and re-downloading them is exactly the cost this cache exists to avoid.
          .filter(key => key !== CACHE_NAME && key !== IMAGE_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/*  Trim the image cache back under its ceiling. Cache Storage keys are returned
 *  in insertion order, so slicing from the front is a usable FIFO eviction —
 *  good enough here, because what we want to keep is "recently added", and a
 *  re-request re-inserts the entry at the back via the revalidation path.
 */
async function trimImageCache() {
  const cache = await caches.open(IMAGE_CACHE);
  const keys = await cache.keys();
  const excess = keys.length - IMAGE_CACHE_MAX_ENTRIES;
  if (excess > 0) await Promise.all(keys.slice(0, excess).map(k => cache.delete(k)));
}

const isTmdbImage = url =>
  url.hostname === 'image.tmdb.org' || url.pathname.startsWith('/tmdb-image/');

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  // TMDB data proxy — never cached here. Freshness is owned by the in-page SWR
  // layer in moviezone.js, which has the domain knowledge to decide TTLs.
  if (url.pathname.startsWith('/api/')) return;

  /*  ── TMDB IMAGES: stale-while-revalidate ────────────────────────────────
   *  These were previously not cached at all. The generic branch below only
   *  stored `response.type === 'basic'` (same-origin) responses, and a TMDB
   *  image is a cross-origin `cors`/`opaque` response, so every repeat visit
   *  re-downloaded every poster and — critically — the hero backdrop, which is
   *  the LCP element.
   *
   *  Serving from cache immediately makes a returning visitor's LCP a cache read
   *  instead of a cross-origin round trip. The background revalidation keeps
   *  entries from going stale forever; posters are immutable per URL anyway
   *  (TMDB paths are content-addressed), so this is really just a refresh path.
   *  ──────────────────────────────────────────────────────────────────────── */
  if (isTmdbImage(url)) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async cache => {
        const cached = await cache.match(request);

        const revalidate = fetch(request).then(response => {
          // Opaque (no-cors) responses have status 0; they are still storable and
          // still render, so accept them rather than skipping the cache entirely.
          if (response && (response.ok || response.type === 'opaque')) {
            cache.put(request, response.clone()).then(trimImageCache).catch(() => {});
          }
          return response;
        });

        if (cached) {
          event.waitUntil(revalidate.catch(() => {}));
          return cached;
        }
        return revalidate;
      })
    );
    return;
  }

  /*  ── VERSIONED SAME-ORIGIN ASSETS: cache-first ──────────────────────────
   *  Scripts and styles used to be network-first. That meant every repeat visit
   *  paid a full round trip for moviezone.min.js + moviezone.min.css before the
   *  page could render, even though both are render-blocking and both had a
   *  perfectly good copy sitting in the cache.
   *
   *  Cache-first is safe here precisely because these URLs carry ?v= and the
   *  version is bumped whenever the file changes: a given URL is immutable. The
   *  HTML document itself stays network-first (below), so a new deployment is
   *  picked up on the very next navigation — the fresh HTML simply asks for a
   *  new ?v=, which misses the cache and is fetched.
   *  ──────────────────────────────────────────────────────────────────────── */
  const sameOrigin = url.origin === self.location.origin;
  const isVersionedAsset = sameOrigin &&
    url.searchParams.has('v') &&
    (request.destination === 'script' || request.destination === 'style');
  const isFont = sameOrigin && url.pathname.startsWith('/fonts/');

  if (isVersionedAsset || isFont) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
          }
          return response;
        });
      })
    );
    return;
  }

  // Navigations and unversioned scripts/styles stay network-first so a deploy is
  // visible immediately.
  const networkFirst = request.mode === 'navigate' ||
    request.destination === 'script' ||
    request.destination === 'style';

  if (networkFirst) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
          }
          return response;
        })
        .catch(async () => {
          // Try exact match first, then try stripping query string for pre-cached assets
          let cached = await caches.match(request);
          if (!cached && url.search) {
            cached = await caches.match(url.pathname + url.search, { ignoreSearch: false });
            if (!cached) cached = await caches.match(url.pathname);
          }
          if (cached) return cached;
          if (request.mode === 'navigate') return caches.match('/index.html');
          throw new Error('Offline asset unavailable');
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      // Fallback: try ignoring search params for pre-cached assets
      return (url.search ? caches.match(url.pathname) : Promise.resolve(null))
        .then(altCached => {
          if (altCached) return altCached;
          return fetch(request).then(response => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
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
    icon: data.icon || '/icon-192.png?v=2',
    badge: data.badge || '/icon-192.png?v=2',
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
