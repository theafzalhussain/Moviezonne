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
//
// v125: provider-shemaroo.png and provider-discoveryplus.png were replaced —
// both were square app icons ("me" tile, bare D tile) and are now the full brand
// lockups with wordmarks. Those two URLs carry no ?v=, and an <img> lands in the
// final cache-first branch of the fetch handler with no revalidation, so without
// this bump a returning visitor would keep being served the old square tiles
// forever. The activate handler deletes every cache that is not CACHE_NAME, so
// renaming the shell is what forces the re-download.
// v133: the Cinematic Universe tiles were rebuilt — key art at 55% instead of
// 22% with a w300/w500 srcset, container-relative wordmarks, a title-count pill
// and a new lockup for every franchise. universes.css and universes-rail.js go
// to ?v=4 in index.html, so both are bumped in OPTIONAL_ASSETS below and the
// shell is renamed: the activate handler deletes every cache that is not
// CACHE_NAME, which is what forces the re-download.
// v142: two independent changes land together — PR #20's dynamic OTT provider
// feeds (v141 / js 14.0) and the TMDB cache-path work. The latter raised the
// localStorage cache cap above one homepage plan (the old 30-key cap deleted part
// of the first screen it had just cached), made eviction oldest-first, and bounded
// the Upcoming feed at MZ_UPCOMING_MAX_PAGES so it can no longer grow DOM without
// end. index.html also changed: the pre-parse TMDB warm-up now skips itself on a
// warm cache. The precached shell pins both URLs, so the bump is what delivers
// them — and it has to sit above BOTH sides' numbers, not just this branch's.
// v143: the watch-page UI work lands — server-switch hint, click-to-play trailer
// with a water-ripple play button that hides during playback, hidden language and
// quality dropdowns, and the removed language quick-buttons row. That moved
// moviezone.min.js to 14.2 and moviezone.min.css to 9.13; the precached shell pins
// both URLs, so this rename is what delivers them to returning visitors.
// v144: the /api/push/subscribe POST was removed from the client — the PUSH_SUBS KV
// namespace is out of daily write quota, so that request could only ever 503. That
// moved moviezone.min.js to 14.3; the precached shell pins the URL, so this rename
// is what delivers it to returning visitors.
// v145: the hero carousel now re-selects itself while the tab stays open — it used
// to be built once per page load, so an open tab (and a TV, which is never closed)
// kept the same ten slides for hours. That moved moviezone.min.js to 14.4; the
// precached shell pins the URL, so this rename is what delivers it to returning
// visitors.
// v146: the hero now ranks its pool by a TRENDING score instead of the catalogue
// score, so the re-selection added in v145 can actually change its answer — that
// re-ask was reaching a comparator in which a title that trended three weeks ago
// always beat this week's, so the deck kept rebuilding itself identically. Landing
// with it: the ALL feed gained dated premiere windows for South-Indian films and
// for web series on ANY OTT in Hindi/Tamil/Telugu/Korean/Chinese (paid for by
// dropping two unwindowed popularity pages, so the request count is unchanged),
// and two network ids that were not what they claimed — 2531 is DMAX [ES], 4238 is
// a 404 — were removed from the OTT list. That moved moviezone.min.js to 14.5; the
// precached shell pins the URL, so this rename is what delivers it.
// v147: the Web Series tab is rebuilt on the same latest -> trending -> popular
// order. It was five popularity pages, and TMDB popularity is lifetime-ish, so the
// tab opened on its biggest long-runners: C.I.D. (first aired 1998) at card 4 and
// Reacher (2022) at card 3, while two 2026 premieres wearing NEW ribbons sat at 5
// and 6. It now fetches three dated windows and /trending/tv/week, adds Chinese
// (which had no source at all), and drops news/reality/soap/talk rows. The reason
// those two old titles were on the FIRST screen is a separate bug fixed here:
// promoteFreshIndustryMix() gave every industry a catalogue slot IN ADDITION to the
// fresh slot it had already won, because it remembered claimed indexes but not
// claimed languages — so English and Hindi each took two of the top four cards.
// Shipping in the same version, because none of the above was deployed yet:
//   • The Web Series tab now LEADS WITH HINDI. Ranking could not do it: a Hindi
//     premiere carries a fraction of an English one's popularity and votes in week
//     one, so English always won the lower pool index and with it the opening
//     card. promoteFreshIndustryMix() takes an optional lead language and the tab
//     asks for 'hi'; it reorders the promoted front row only, so the same
//     industries hold the same slots. A Hindi-only premiere window was added
//     alongside, because a lead slot is worthless if the language has no
//     candidate — the five-language window is won by K-drama most weeks.
//   • SLIDE 0 IS NO LONGER FROZEN. pinPreloadedHero() pinned movie/popular[0],
//     which barely moves: measured the same day, popular[0] was Spider-Man (54
//     days old, holding for weeks) while trending/movie/week[0] was Resident Evil
//     (5 days old). Both the refresh path and scripts/inject-home-links.js now
//     resolve it from trending, which is also what the hero score would pick — so
//     the preload is still an LCP cache hit and slide 0 turns over on its own.
//     index.html's hero preload + meta + SSR slide move with it.
//   • PRE-2000 MOVIES ARE OUT OF EVERY BROWSE FEED. The era weight is a smooth
//     decay, so on a thin week the 1990s floated back onto page 1-2 of Bollywood
//     and Hollywood. isPreMillenniumMovie() is a hard floor at 2000. SEARCH IS
//     UNAFFECTED — it runs /search/multi and never passes through loadMovies() —
//     so an old film is still findable and watchable by name. Series are exempt
//     (first_air_date is season 1, not currency) and so are 'anime'/'kids', whose
//     canon is the point of those sections.
// That moved moviezone.min.js to 14.6; the precached shell pins the URL.
// Also in v147, and none of it was deployed yet either:
//   • optimizeHomeHead() in seo-ssr.js is now a TRUE NO-OP on the index.html it
//     generated. It was not: its removal patterns used `\n?` against a CRLF file,
//     so every nightly `npm run seo:refresh` added a blank line to <head>, and its
//     template still emitted the duplicate stylesheet preload and the un-guarded
//     TMDB warm-up that the 117->118 KB tuning had deliberately removed. The
//     workflow was quietly reverting that tuning on a schedule. The template is now
//     the source of truth, line endings are taken from the host file, and
//     watch-page-check.js asserts the no-op instead of asserting the duplicate.
//   • The homepage SSR link block is filtered like the grid — in BOTH places that
//     build it. It was /tv/popular and /movie/popular raw, so "Popular web series
//     and shows" linked to The Tonight Show Starring Johnny Carson (1962),
//     Tagesschau (1952) and four late-night talk shows, and "Popular movies"
//     carried Zero Woman 2 (1995) — crawl budget spent on pages this site does not
//     carry. The series list now asks the app's own question (streaming networks
//     in, linear channels and news/reality/soap/talk out, ids read out of
//     moviezone.js so there is no second copy to drift) and the movie lists take
//     the same 2000 floor as the feed. The rules live in seo-ssr.js because
//     registerHomeSsr() rebuilds this block at REQUEST time on the Node deployment
//     and overwrites whatever the build script baked in — fixing only the script
//     would have looked right locally and changed nothing in production.
// v148: big screens and TVs. A 55/65-inch panel was getting NONE of tv-mode.css —
// verified on the real page at 3840x2160, where data-mz-tv came back null, because
// that stylesheet is gated on a user-agent fingerprint and most smart-TV browsers
// are not in the list. Meanwhile moviezone.css's own block named "TV / LARGE SCREEN
// OPTIMIZATION" was switching ON `scroll-behavior: smooth` and a GPU layer per card
// — the two things tv-mode.css names as the top TV performance mistakes. That block
// is now a genuine budget (no full-width backdrop blur, no 90/180px shadow radii,
// no full-viewport SVG film grain, no filter interpolation on the hero image, no
// decorative infinite loops, instant scrolling), and tv-mode.js sets a new
// data-mz-bigscreen attribute from real hardware signals — a >=1920px screen with
// no fine pointer, or a >=2560px screen on <=4 GB / <=4 cores — which applies the
// VRAM-sensitive half (per-card de-promotion, contain-intrinsic-size auto) without
// the TV interaction model. A 4K workstation with a mouse matches neither and is
// deliberately untouched: removing its card layers was measured at scroll p95 23ms
// -> 200ms, because a desktop GPU is FASTER with them.
// Also in v148: the hero's Bollywood and Hindi web-series seats now carry genuinely
// new releases. carouselIndustryQuery asked for 20+ votes and the Hindi series query
// for 25 votes AND a 6.0 rating, which a title that dropped this week cannot have —
// Lust Stories 3 (3 days old, popularity 54) has FOUR votes, and Hindi premieres
// start at literally zero. Both seats were therefore stuck on months-old filler.
// clearsCarouselBar now has a new-release path that judges a title inside 45 days on
// popularity instead, with the floor taken from its own category.
// That moved moviezone.min.css to 9.14, tv-mode.min.css to 1.4, tv-mode.min.js to
// 1.6 and moviezone.min.js to 14.6; the precached shell pins all four URLs.
const CACHE_NAME = 'moviezone-v149';

/*  v149: the four remaining main-thread costs on the big-screen path.
 *
 *    • PREFETCH DISTANCE IS DERIVED FROM THE VIEWPORT. Every observer used a hard
 *      -coded rootMargin (300/200/400px), and the lead time a loader actually gets
 *      is `viewport height + margin`. On a 2160px panel a 400px margin armed the
 *      infinite-scroll and section loaders 2560px early against a grid ~2500px
 *      tall — "fetch everything now" on the weakest hardware. mzPrefetchRootMargin
 *      fixes the LEAD instead, so the margin shrinks as the viewport grows: an
 *      800px phone keeps exactly today's 400px, a 4K panel drops to 120px.
 *    • tv-mode.js's DOM SWEEP IS FILTERED AND SCOPED. It observed document.body
 *      with no filter, so any insertion anywhere — a toast, a search suggestion, a
 *      carousel slide swap — cost two document-wide querySelectorAll passes and
 *      discarded the focus cache, which made the next D-pad press rebuild ~150
 *      getBoundingClientRect reads. It now only reacts to batches that added
 *      something focusable, visits just those subtrees, and only invalidates the
 *      cache when a tabindex genuinely appeared. Also fixed a real drift there: the
 *      poster-parking branch stripped `src` from images that were STILL IN FLIGHT,
 *      on the assumption that posters are marked loading="eager" on TV — they are
 *      not, and have not been for some time, so it was cancelling fetches and
 *      causing the same bytes to be downloaded twice.
 *    • THE RAIL HANDLERS NO LONGER THRASH LAYOUT. updateArrowState,
 *      _mzUpdateTop10Arrows and updateControls each read scrollWidth / clientWidth
 *      / scrollLeft either side of a `.disabled` or `.hidden` write, forcing a
 *      synchronous layout flush — on every scroll EVENT, not every frame. Reads are
 *      now batched ahead of writes and the listeners are rAF-throttled.
 *    • THE PERIODIC localStorage WORK IS CUT. The 60s sweep enumerated and sorted
 *      the whole keyspace unconditionally; it now skips hidden tabs, skips when
 *      nothing has been written since the last pass, and does the sort in idle
 *      time. The watch-session write went 5s -> 15s (every exit path still flushes
 *      immediately, so only a hard kill loses anything, and it loses 15s not 5s).
 *      The performance.memory poll now stops after it fires once instead of
 *      re-adding a class it had already added, every 10s, forever.
 *
 *  Verified on the real page at 3840x2160: rootMargin resolves to 120px, and 20s of
 *  idling produced ZERO localStorage keyspace enumerations. That moved
 *  moviezone.min.js to 14.7 and tv-mode.min.js to 1.7; the precached shell pins
 *  both URLs, so this rename is what delivers them to returning visitors. */

// Separate cache for TMDB posters/backdrops. Kept apart from the shell so the
// activate handler can wipe an old shell without throwing away hundreds of
// images the next visit would otherwise re-download.
const IMAGE_CACHE = 'moviezone-tmdb-images-v1';

// Hard ceiling on the image cache. Roughly 50 MB at TMDB w342/w780 sizes.
const IMAGE_CACHE_MAX_ENTRIES = 400;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/tv-mode.min.css?v=1.4',
  '/moviezone.min.css?v=9.14',
  '/tv-mode.min.js?v=1.7',
  '/search-engine.min.js?v=2.1',
  '/moviezone.min.js?v=14.7',
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
  '/providers.css?v=9',
  '/provider-netflix.svg',
  '/provider-prime.svg',
  '/provider-jiohotstar.png',
  '/provider-apple.svg',
  '/provider-zee5.svg',
  '/provider-sonyliv.png',
  '/provider-mxplayer.png',
  '/provider-aha.svg',
  '/provider-crunchyroll.svg',
  '/provider-sunnxt.png',
  '/provider-lionsgate.png',
  '/provider-discoveryplus.png',
  '/provider-shemaroo.png',
  '/provider-vi.png',
  '/collections-catalog.json?v=4',
  // The Cinematic Universe rail on the homepage. Both are optional for the same
  // reason the catalogue above is: the row is below the fold and built lazily, so
  // a 404 on either must not be able to fail the whole service-worker install.
  '/universes.css?v=4',
  '/universes-rail.js?v=4',
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

  /*  ── EVERYTHING ELSE CROSS-ORIGIN: straight to the network ──────────────
   *  Deliberately placed AFTER the TMDB image branch above, which is the one
   *  cross-origin thing worth caching — putting this first silently disabled the
   *  poster cache and the LCP backdrop, so ad-gate-check.js asserts the order.
   *
   *  This began as a named allowlist of ad hosts, which was the wrong shape: an
   *  ad script immediately pulls from further domains of its own
   *  (spendsdetachment.com and friends), so a list could never be complete. The
   *  general rule is also just the correct one — every caching branch below stores
   *  `response.type === 'basic'`, i.e. same-origin only, so for anything
   *  cross-origin this service worker can add nothing but latency and a failure
   *  path: when such a request is blocked or answered 403, the network-first catch
   *  runs three cache lookups that can never match and then throws, on every
   *  navigation.
   *  ──────────────────────────────────────────────────────────────────────── */
  if (url.origin !== self.location.origin) return;

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
