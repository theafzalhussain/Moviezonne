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
// v155: the performance pass. moviezone.min.js 15.4 and moviezone.min.css 9.17:
// the first-screen batches no longer wait on <head> fetches (the <head> TMDB
// warm-up is gone) and always send the same plan (one edge-cached answer for
// everybody), a returning visitor on a slow link paints from their own cache
// after 1 s instead of waiting, the unconditional +800 ms next-page batch is
// gone, hero print badges resolve in one request instead of one per slide,
// hover/touch prefetch needs a 150 ms dwell, the localStorage flush yields to
// input, and the diagnostic idle tasks no longer run in production. The
// image-cache trim below now runs at most every 20 s instead of after every
// poster. The precached shell pins both URLs.
// v156: the navigation fallback never serves a REDIRECTED response any more.
// '/index.html' answers 307 on Workers static assets, so the precached copy was a
// redirect, and Chromium turns a redirected response for a navigation into a
// network error: every slow-network race and offline fallback showed an error
// page. The shell is now '/', only the home navigation is raced or stored (deep
// links wait for the network instead of being shown the homepage), and every
// branch falls back to the network when Cache Storage itself fails.
// moviezone.min.js 15.5 lands with it (crash guards, RUM noise, search INP).
// v157: moviezone.min.js 15.6 - a TMDB retry is held to what is left of its 20 s
// budget instead of starting a fresh 15 s window, so a URL that never answers
// gives up at 20 s, not 31 s.
// v158: moviezone.min.js 15.7 + universes-rail.js v5 - main-thread fixes found in
// a 6x-throttled TV trace: the navbar pill no longer re-measures itself on every
// animation frame, TV card heights no longer restyle the whole page, the unused
// --page-loaded root variable is gone, and the universe rail no longer forces a
// layout straight after inserting its tiles.
// v159: moviezone.min.js 15.8, moviezone.min.css 9.18, tv-mode.min.js 1.9,
// tv-mode.min.css 1.6, providers.css 10, universes.css 5 - the TV D-pad no longer
// measures (or gets stuck on) focusables inside idle sections and hidden overlays,
// rail rects follow the rails' own scrolling, resting cards no longer carry a
// composited layer per badge, the Top 10 / provider / related rails measure in
// the next frame instead of mid-task, and the navbar's "scrolled" state comes from
// an IntersectionObserver instead of a scroll listener.
const CACHE_NAME = 'moviezone-v160';

/*  v151: the server picker is one section instead of two. "HD Streams •
 *  Multi-Audio" is gone and its four servers — VidSrc HD, Turbo Stream, Pro Stream
 *  and Premium Mirror — sit in the Premium box with the other seven, eleven in all.
 *
 *  Their BADGES are unchanged on purpose. Setting is4K on the four that moved would
 *  have made the heading literally true in one line and put a 4K claim on cards for
 *  servers none of which was measured at 2160p, so they keep DUB only and the
 *  tooltip still reads "Hindi Dubbed + Multi-Audio" rather than claiming 4K.
 *
 *  The premium/hd arrays are kept for ORDERING rather than grouping: concatenating
 *  them preserves the exact on-screen order the split produced, so the 4K and anime
 *  servers still lead and the four that moved follow, instead of interleaving by
 *  declared index and pushing MultiAudio 4K down behind Turbo Stream.
 *
 *  Six now-unreachable .srv-section--hd rule blocks were deleted from moviezone.css
 *  (1,057 bytes) — nothing can carry that class any more. Each was verified to be a
 *  standalone selector first; none shared a selector list with --premium, which is
 *  what would have made a blind delete a visual regression.
 *
 *  Verified on the real page: one section, "11 servers", 11 cards, badges
 *  4K+ANIME+DUB / 4K+DUB / DUB exactly as declared. That moved moviezone.min.js to
 *  14.9 and moviezone.min.css to 9.15; the precached shell pins both URLs. */

/*  v150: the two reported-broken servers, and a ranking bug that was hiding both.
 *
 *    • THE FRAME LOADING IS NOT THE SERVER PLAYING. recordPlayerLoad() is called
 *      from iframe.onload, and `load` fires for a provider's ERROR page too. So a
 *      502 or a Cloudflare block booked a SUCCESS, cancelled the give-up timer, and
 *      ranked that server first — while every viewer sat looking at "blocked" and
 *      the auto-retry chain that exists to rescue them never ran. That is the
 *      reported OmniPlay symptom exactly. playerCost() now also weighs whether a
 *      server has EVER produced real playback (15s of visible watching, or a
 *      playhead event from the player itself) and treats "answers but never plays"
 *      as heavily as an outright failure. One real play clears it, so an outage is
 *      never permanent. No server definition is touched by this.
 *    • MultiLang HD REPLACES VidCore HD. vidcore.io answers 403 "Sorry, you have
 *      been blocked" to a real browser while still returning 200 to a server-side
 *      fetch, which is why every reachability check was passing. The replacement was
 *      picked by loading candidates in a real iframe and reading their network
 *      traffic over the DevTools Protocol — the pass mark is an HLS manifest AND
 *      media segments actually fetched. Sixteen providers resolved no stream at all.
 *      Two worked, at opposite things: peachify.top played 5 of 5 films in 2.2-5.0s
 *      and exposes real switchable audio tracks from the HLS manifest (verified on
 *      3 Idiots, Dangal, Animal), but its /embed/tv route resolves nothing on any
 *      series; moviesapi.vip played 3 of 4 series. So films go to peachify and
 *      episodes to moviesapi, the same type-routing OmniPlay and AnimePahe already
 *      use. Server count and chip count are unchanged.
 *    • playerHostOrigins() now probes the movie AND tv branches. It only ever asked
 *      for a movie URL, so a server that splits hosts by type left its episode host
 *      with no dns-prefetch and no preconnect — a cold DNS + TLS handshake at the
 *      moment the user pressed play.
 *    • THE TWO PRECONNECTED HOSTS ARE THE TWO THE RANKING WOULD PICK, not the first
 *      two in declared order. Declared order puts OmniPlay first, whose host is
 *      currently 502 on every path, so one of the two handshakes was being spent on
 *      a host that cannot serve a frame. A first visit is unaffected: with no
 *      history every cost is equal and the order falls back to declared.
 *
 *  NOT FIXED, and it cannot be from here: OmniPlay's own origin is down.
 *  player.videasy.to answers 502 after ~14.5s on every path and every mirror
 *  (.net 301s to it), confirmed by plain fetch, top-level Chrome and a framed
 *  Chrome. Its URL builder is left byte-for-byte as it was, as asked.
 *
 *  That moved moviezone.min.js to 14.8; the precached shell pins the URL. */

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

/*  How long a navigation waits for the network before the cached shell is
 *  painted instead. Tuned rather than guessed at either extreme:
 *
 *  Too low and a normal mobile connection loses the race, so users are routinely
 *  shown a cached shell when fresh HTML was moments away — which also costs a
 *  second render when the real document is not what got painted.
 *  Too high and the stall it exists to absorb is still a stall.
 *
 *  2.5 s sits above a realistic 4G document response and well below the point
 *  where a user decides the page is broken and reloads (which makes the problem
 *  worse, not better, by starting the whole race again).
 *
 *  Only navigations are raced. Scripts and styles fall through to the original
 *  offline ladder, because painting a stale one is not equivalent to painting a
 *  stale document. */
const NAV_NETWORK_BUDGET_MS = 2500;

/*  A sentinel for "the network lost the race". A Symbol cannot be confused with
 *  a Response, so the branch below never has to guess whether it is holding a
 *  real answer or a timeout marker. */
const NETWORK_TOO_SLOW = Symbol('network-too-slow');

/*  ── THE BLOCKING SHELL: ONLY WHAT THE PAGE ACTUALLY REQUESTS ──
 *
 *  cache.addAll() is atomic - one 404 fails the whole install - and it runs on the
 *  visitor's connection. So every byte listed here is a byte a first-time visitor
 *  downloads on top of the page itself, and this list had grown to 1.5 MB on disk.
 *  Three entries were most of it and none of them belonged:
 *
 *    • /moviezone-logo.png?v=2  (513 KB)  REMOVED ENTIRELY. Nothing requests it.
 *      grep across index.html, manifest.json and moviezone.js finds zero
 *      references - the page uses /moviezone-logo.webp (7 KB), which is preloaded
 *      in <head> and used by both the loader and the nav logo. Half a megabyte was
 *      being fetched and stored so that a file nobody asks for would be available
 *      offline.
 *    • /icon-512.png?v=2  (237 KB)  and  /apple-touch-icon.png?v=2  (38 KB)
 *      moved to OPTIONAL_ASSETS. These are install/home-screen artwork read by the
 *      OS from manifest.json, not resources the offline shell renders. Being
 *      opportunistic costs nothing real: they are still cached, just not in front
 *      of the first paint, and they can no longer fail an install.
 *
 *  What is left is the shell in the strict sense - the document, the two
 *  stylesheets, the three bundles, the manifest, the two favicon sizes the
 *  document itself links, and the two preloaded fonts (kept blocking on purpose:
 *  they are on the hero title's critical path and a fallback face would reflow).
 */
const STATIC_ASSETS = [
  /*  '/' ONLY - not '/index.html' as well. On Workers static assets
   *  /index.html answers 307 -> '/', so cache.addAll() stored a REDIRECTED
   *  response under that key, and the navigation fallbacks below served it.
   *  Chromium refuses a redirected response for a navigation ("a redirected
   *  response was used for a request whose redirect mode is not follow"), so
   *  every slow-network or offline fallback turned into a browser error page
   *  instead of the shell. '/' is the same document, answered 200 directly. */
  '/',
  '/tv-mode.min.css?v=1.6',
  '/moviezone.min.css?v=9.18',
  '/tv-mode.min.js?v=1.9',
  '/search-engine.min.js?v=2.1',
  '/moviezone.min.js?v=15.9',
  '/manifest.json',
  '/icon-192.png?v=2',
  '/favicon-32.png?v=2',
  // Self-hosted fonts (were Google Fonts). These are on the critical render
  // path for the hero title, so an offline or flaky-network visit must not fall
  // back to a system face and reflow the page.
  '/fonts/outfit-latin-var.woff2',
  '/fonts/bebas-neue-latin-400.woff2'
];

// Large/feature-specific data should never block a new service worker from
// installing. It is cached opportunistically and fetched from the network if absent.
const OPTIONAL_ASSETS = [
  // Install / home-screen artwork. The OS reads these from manifest.json when the
  // user installs; they are never part of a rendered page, so they have no reason
  // to sit in front of a first paint. 275 KB between them.
  '/icon-512.png?v=2',
  '/apple-touch-icon.png?v=2',
  '/providers.css?v=10',
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
  '/universes.css?v=5',
  '/universes-rail.js?v=5',
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
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          // IMAGE_CACHE must survive a shell bump: those bytes are version-independent
          // and re-downloading them is exactly the cost this cache exists to avoid.
          .filter(key => key !== CACHE_NAME && key !== IMAGE_CACHE)
          .map(key => caches.delete(key))
      );

      /*  ── NAVIGATION PRELOAD ──────────────────────────────────────────────
       *  Without this, every single navigation paid service-worker start-up
       *  BEFORE the HTML request was even issued. The worker has to boot, parse
       *  and reach its fetch handler first, and only then does the network see
       *  the document request — ~50-300 ms of pure added latency on mid-range
       *  mobile, on the most critical request of the page, on every navigation.
       *  It is latency the site would not have had with no service worker at all.
       *
       *  Enabling preload makes the browser start the document request in
       *  parallel with booting the worker; the fetch handler then awaits
       *  event.preloadResponse instead of issuing a second identical request.
       *  This is the largest TTFB win available on the client side and it lands
       *  squarely on p50 and p75, where 90% of traffic sits.
       *
       *  Feature-detected: Safari has no navigationPreload, and an unguarded
       *  property access here would reject the activate handler and leave the
       *  worker stuck in "activating" forever. */
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (e) {
          console.warn('[MovieZone SW] navigationPreload unavailable:', e && e.message);
        }
      }

      await self.clients.claim();
    })()
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

/*  Trimming enumerates the WHOLE image cache (cache.keys() over up to
 *  IMAGE_CACHE_MAX_ENTRIES records) and it used to run after EVERY image put -
 *  ~30 full enumerations while the first page of posters streamed in, competing
 *  for the same device I/O the page was decoding those posters from. Once per
 *  TRIM_EVERY_MS is plenty: the ceiling is a soft bound, and overshooting it by a
 *  few dozen entries for a few seconds costs nothing. */
const TRIM_EVERY_MS = 20000;
let lastImageTrimAt = 0;
function trimImageCacheSoon() {
  const now = Date.now();
  if (now - lastImageTrimAt < TRIM_EVERY_MS) return Promise.resolve();
  lastImageTrimAt = now;
  return trimImageCache();
}

const isTmdbImage = url =>
  url.hostname === 'image.tmdb.org' || url.pathname.startsWith('/tmdb-image/');

/*  A cached response that may be handed to a NAVIGATION. A response whose
 *  `redirected` flag is set is a network error for a navigation in Chromium, so
 *  the flag is shed by copying the response (same status, headers and body). */
function navigable(response) {
  if (!response || !response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/** The offline / slow-network shell: the home document, never a redirect. */
async function cachedShell() {
  const shell = (await caches.match('/')) || (await caches.match('/index.html'));
  return navigable(shell || null);
}

/** Stores a copy without ever letting a quota or storage fault reject anything. */
function putQuietly(event, key, response) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.put(key, response))
      .catch(() => {})
  );
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  // TMDB data proxy — never cached here. Freshness is owned by the in-page SWR
  // layer in moviezone.js, which has the domain knowledge to decide TTLs.
  if (url.pathname.startsWith('/api/')) return;

  /*  ── TMDB IMAGES: cache-first, immutable ────────────────────────────────
   *  These were previously not cached at all. The generic branch below only
   *  stored `response.type === 'basic'` (same-origin) responses, and a TMDB
   *  image is a cross-origin `cors`/`opaque` response, so every repeat visit
   *  re-downloaded every poster and — critically — the hero backdrop, which is
   *  the LCP element.
   *
   *  WHY THIS IS NO LONGER STALE-WHILE-REVALIDATE
   *  It used to fire the revalidation fetch unconditionally, before even looking
   *  at the cached entry, and only the *response* was discarded on a hit. So a
   *  returning visitor with a warm cache re-downloaded every poster on screen in
   *  the background anyway — up to IMAGE_CACHE_MAX_ENTRIES of them — while the
   *  first screen was still loading. On a mobile link that is bandwidth taken
   *  directly from the LCP backdrop and the two render-blocking bundles, to
   *  refresh bytes that cannot have changed.
   *
   *  A TMDB image path is content-addressed: /t/p/w342/<hash>.jpg names the
   *  bytes, so a different image is always a different URL. There is nothing for
   *  a revalidation to discover. Cache-first is not a staleness trade here — it
   *  is the correct strategy for the URL shape, and it is what makes a returning
   *  visitor's LCP a local cache read instead of a cross-origin round trip.
   *  ──────────────────────────────────────────────────────────────────────── */
  if (isTmdbImage(url)) {
    event.respondWith((async () => {
      // A storage fault (quota, a corrupted profile on a TV) must degrade to the
      // network, never to a broken image: respondWith() rejecting IS a failure.
      let cache = null;
      try {
        cache = await caches.open(IMAGE_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
      } catch (e) {
        cache = null;
      }

      const response = await fetch(request);
      // Opaque (no-cors) responses have status 0; they are still storable and
      // still render, so accept them rather than skipping the cache entirely.
      if (cache && response && (response.ok || response.type === 'opaque')) {
        const copy = response.clone();
        event.waitUntil(
          cache.put(request, copy).then(trimImageCacheSoon).catch(() => {})
        );
      }
      return response;
    })());
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
    event.respondWith((async () => {
      // If Cache Storage itself fails, the bundle must still load from the
      // network - a rejected respondWith() here would take the whole app down.
      try {
        const cached = await caches.match(request);
        if (cached) return cached;
      } catch (e) { /* storage unavailable: fall through to the network */ }
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') putQuietly(event, request, response.clone());
      return response;
    })());
    return;
  }

  // Navigations and unversioned scripts/styles stay network-first so a deploy is
  // visible immediately.
  const networkFirst = request.mode === 'navigate' ||
    request.destination === 'script' ||
    request.destination === 'style';

  if (networkFirst) {
    const isNavigation = request.mode === 'navigate';
    /*  Only the HOME document is raced against, and stored as, the shell. The
     *  shell IS the homepage; painting it for /movie/<id> or a watch URL showed
     *  the wrong page under the right URL. Every other navigation simply waits
     *  for the network (with navigation preload), like a browser with no service
     *  worker would, and falls back to the shell only when the network FAILS.
     *  Storing every navigation also grew this cache without bound (one entry per
     *  detail page, per ?utm variant). */
    const isHomeNavigation = isNavigation && url.pathname === '/';

    event.respondWith(
      (async () => {
        /*  One promise, consumed at most once. event.preloadResponse is the
         *  request the browser started while this worker was still booting (see
         *  navigationPreload in activate); awaiting it is strictly cheaper than
         *  issuing a second identical one. It resolves to undefined when preload
         *  did not apply — every non-navigation, and every browser without the
         *  feature — so the plain fetch stays the fallback, not the exception. */
        const fromNetwork = (async () => {
          let response = null;
          if (event.preloadResponse) {
            try { response = await event.preloadResponse; } catch (e) { response = null; }
          }
          if (!response) response = await fetch(request);
          if (response.ok && response.type === 'basic' && !response.redirected
              && (!isNavigation || isHomeNavigation)) {
            // One key for the home document, whatever ?utm_* it arrived with.
            putQuietly(event, isHomeNavigation ? '/' : request, response.clone());
          }
          return response;
        })();

        /*  ── BOUNDED, NOT UNBOUNDED ──────────────────────────────────────────
         *  Pure network-first meant a stalled mobile connection left the user
         *  looking at a blank document until the browser's own timeout fired,
         *  tens of seconds later. That is the "hang" users report, and it scores
         *  as a p95 latency outlier rather than as an error, which is why it is
         *  invisible in error rates but very visible in the percentiles.
         *
         *  So: race the network against the cached shell. If the network wins,
         *  nothing changes. If it does not answer within the budget, paint the
         *  shell and let the network keep running under waitUntil to refresh the
         *  cache for the next navigation — the request is deferred, never
         *  abandoned.
         *
         *  There is no stale-version hazard: activate() deletes every cache but
         *  CACHE_NAME and install() refills it, so the cached shell references the
         *  ?v= bundles this worker precached. */
        const shell = isHomeNavigation ? await cachedShell().catch(() => null) : null;

        if (shell) {
          let timer = null;
          const timeout = new Promise(resolve => {
            timer = setTimeout(() => resolve(NETWORK_TOO_SLOW), NAV_NETWORK_BUDGET_MS);
          });
          try {
            const winner = await Promise.race([
              fromNetwork.catch(() => NETWORK_TOO_SLOW),
              timeout
            ]);
            if (winner !== NETWORK_TOO_SLOW) return winner;
            event.waitUntil(fromNetwork.catch(() => {}));
            return shell;
          } finally {
            if (timer !== null) clearTimeout(timer);
          }
        }

        try {
          return await fromNetwork;
        } catch (e) {
          // Try exact match first, then try stripping query string for pre-cached assets
          let cached = null;
          try {
            cached = await caches.match(request);
            if (!cached && url.search) {
              cached = await caches.match(url.pathname + url.search, { ignoreSearch: false });
              if (!cached) cached = await caches.match(url.pathname);
            }
          } catch (err) {
            cached = null;
          }
          if (cached) return isNavigation ? navigable(cached) : cached;
          if (isNavigation) {
            const offlineShell = await cachedShell().catch(() => null);
            if (offlineShell) return offlineShell;
          }
          // A clean network error rather than a rejected promise.
          return Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith((async () => {
    try {
      const cached = (await caches.match(request))
        // Fallback: try ignoring search params for pre-cached assets
        || (url.search ? await caches.match(url.pathname) : null);
      if (cached) return cached;
    } catch (e) { /* storage unavailable: fall through to the network */ }
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') putQuietly(event, request, response.clone());
    return response;
  })());
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
