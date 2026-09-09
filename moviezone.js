// Improved Localhost Detection: Includes local IPs (192.168.x.x) often used in testing
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.');
// TV detection is handled by tv-mode.js which sets html[data-mz-tv="true"].
// This getter reads the data attribute set by the isolated TV module.
const isMzTV = () => document.documentElement.getAttribute('data-mz-tv') === 'true';

// Balanced Performance: phones/tablets use low-end mode; confirmed TVs use data-mz-tv.
const isMobile = !isMzTV() && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const isLowEnd = (navigator.deviceMemory && navigator.deviceMemory < 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4);
const isTouchOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(pointer: fine)').matches;

// Device tier for the rendering budget (loadMovies/renderMovies): low tier gets
// a smaller first paint in smaller chunks so a weak CPU or slow link does not
// lose a frame to the initial render.
const mzLowTier =
  (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) ||
  (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
  /SmartTV|Smart-TV|Tizen|webOS|BRAVIA|NetCast/i.test(navigator.userAgent) ||
  (/2g/i.test(((navigator.connection || {}).effectiveType) || ''));

// -- ULTRA PERFORMANCE BOOST (Instant Load) --
// 1. Mark document as loading for instant visual feedback
document.documentElement.style.setProperty('--page-loaded', '0');

// 2. Lazy Image Observer (loads images only when near viewport - saves bandwidth + speed)
const lazyImageObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const img = entry.target;
      if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
      lazyImageObserver.unobserve(img);
    }
  });
}, { rootMargin: '300px' }) : null;

// 3. Passive event listeners globally (smoother scroll)
if (typeof EventTarget !== 'undefined') {
  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    if (type === 'touchstart' || type === 'touchmove' || type === 'wheel' || type === 'scroll') {
      if (typeof opts === 'boolean') opts = { capture: opts, passive: true };
      else if (typeof opts === 'object' || opts === undefined) opts = Object.assign({}, opts, { passive: true });
    }
    return origAdd.call(this, type, fn, opts);
  };
}

// 4. Instant page visibility (reduce white flash)
document.documentElement.style.backgroundColor = '#03030a';
document.documentElement.style.colorScheme = 'dark';

// Vercel par frontend + backend ek sath deploy ke liye relative path use karein:
const LIVE_BACKEND_URL = '/api/tmdb';
const BASE = isLocalhost ? 'http://localhost:3001/api/tmdb' : LIVE_BACKEND_URL;
const IMG = 'https://image.tmdb.org/t/p/w342'; // Optimized: w500 is too heavy for thumbnails

// NETWORK-AWARE IMAGE LOADING
// Serves high-quality images on fast networks and lighter ones on slow links.
//
// The desktop branch used to request `original`, which is TMDB's untouched
// upload — measured across four trending titles it averages 885 KB per
// backdrop and peaked at 1.7 MB. This is the hero carousel image, i.e. the LCP
// element, so that single request was setting the page's Largest Contentful
// Paint. w1280 averages 116 KB for the same images: an 87% cut.
//
// Nothing visible is lost. The backdrop sits behind .slide-gradient with the
// title and buttons over it, and it is never displayed above 1280 logical px
// of detail — w1280 is also the largest size TMDB offers below `original`, so
// there is no middle option being skipped here.
/*  The breakpoint the hero preload in <head> is scoped to. Must stay identical
 *  to WIDE_MQ in seo-ssr.js — if the two drift, <head> preloads one size, the
 *  carousel requests another, and the LCP image is downloaded twice.
 */
const HERO_WIDE_MQ = '(min-width: 1025px)';

/*  The other half of the same split, kept as its own constant so the <picture>
 *  the carousel renders can carry the SAME two queries the <head> preload does.
 *  Must stay identical to MOBILE_MQ in seo-ssr.js and to the media= on the two
 *  hero preload links in index.html. */
const HERO_MOBILE_MQ = '(max-width: 1024px)';

/*  Size for slide 0 only.
 *
 *  getResponsiveBackdrop() branches on a UA test (isMobile), which a
 *  <link media> query cannot express — a narrow desktop window would be
 *  preloaded w780 and then request w1280, the exact double-download this is
 *  meant to remove. Deciding on viewport width instead puts both sides on the
 *  same axis, and a 1024px-wide window genuinely does not need the 1280 asset.
 *
 *  save-data / 2-3G keeps its w500 ceiling: honouring an explicit request to
 *  spend less data matters more than the preload landing, and the preload
 *  scanner has already started that fetch either way.
 */
function getHeroBackdrop(path) {
  if (!path) return '';
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && (conn.saveData || /^[23]g/.test(conn.effectiveType))) {
    return 'https://image.tmdb.org/t/p/w500' + path;
  }
  const wide = window.matchMedia && window.matchMedia(HERO_WIDE_MQ).matches;
  return 'https://image.tmdb.org/t/p/' + (wide ? 'w1280' : 'w780') + path;
}

/*  Moves the title the server preloaded to slide 0. The preload is a build-time
 *  guess at what the ranking will surface; when the guess is in the deck this
 *  turns it into a cache hit for the LCP element, and when it is not, the deck
 *  is returned untouched rather than forced.
 */
function pinPreloadedHero(list, pool) {
  try {
    const meta = document.querySelector('meta[name="mz-hero-backdrop"]');
    const want = meta && meta.getAttribute('content');
    if (!want || !Array.isArray(list) || !list.length) return list;
    const idx = list.findIndex(m => m && m.backdrop_path === want);
    if (idx === 0) return list;
    if (idx > 0) {
      const hit = list.splice(idx, 1)[0];
      list.unshift(hit);
      return list;
    }
    const fromPool = (pool || []).find(m => m && m.backdrop_path === want);
    if (!fromPool) return list;

    /*  The preloaded title is not in the line-up, so pinning it to slide 0 means
     *  taking a slot from somebody. This used to be
     *
     *      return [fromPool].concat(list).slice(0, 10);
     *
     *  which quietly spent the LAST slot. Measured against the category quotas:
     *  Hollywood came out at five instead of four and Tollywood lost its second
     *  pick - the tail of the list is exactly where the smaller categories sit,
     *  so the slice always billed them.
     *
     *  Swap for the weakest member of the pinned title's OWN category instead,
     *  scanning from the end because placement order runs strongest-first within
     *  a category. The tally is then unchanged by construction.
     *
     *  Two refusals, and neither is a silent nicety:
     *    - an over-age title is never pinned. The age ceiling has to stay
     *      authoritative or this becomes the one path a 1995 release can still
     *      reach slide 0 through.
     *    - if its category holds no slot at all there is nothing to trade, so the
     *      pin is declined.
     *  Declining costs a preload that goes unconsumed and a one-frame swap
     *  between the SSR hero and slide 0 (see heroPreloadTag in seo-ssr.js). That
     *  is a real cost, which is why it is last resort rather than the default -
     *  but the SSR hero is movie/popular[0], i.e. Hollywood, and Hollywood always
     *  holds four slots, so in practice the swap above is what runs.
     */
    if (!isCarouselRecent(fromPool)) return list;
    const pinCategory = carouselCategoryOf(fromPool);
    let victim = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      if (!item) continue;
      const itemCategory = item._carouselCategory || carouselCategoryOf(item);
      if (itemCategory === pinCategory) { victim = i; break; }
    }
    if (victim === -1) return list;
    fromPool._carouselCategory = pinCategory;
    list.splice(victim, 1);
    list.unshift(fromPool);
    return list;
  } catch (e) { /* preload stays a miss — never break the carousel over it */ }
  return list;
}

function getResponsiveBackdrop(path) {
  if (!path) return '';
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const isSlow = conn && (conn.saveData || /^[23]g/.test(conn.effectiveType));

  if (isSlow) return `https://image.tmdb.org/t/p/w500${path}`;  // ~40 KB, keeps 3G usable
  if (isMzTV() || isMobile) return `https://image.tmdb.org/t/p/w780${path}`; // ~45 KB
  return `https://image.tmdb.org/t/p/w1280${path}`;             // ~116 KB, desktop + TV panels
}

// TV mode detection and class tagging is handled by tv-mode.js (sets data-mz-tv attribute).
// isMzTV() reads that attribute for conditional behavior.

/*  low-end-mode is the stylesheet's fast path: it switches off the effects that
 *  cost the most per frame — all 76 backdrop-filters, the blur filters, the
 *  heavy box-shadows, the Ken-Burns hero zoom, the card entrance animations and
 *  the shine sweeps.
 *
 *  It used to be applied on `isMobile` alone, which left a real gap: a weak
 *  laptop (isLowEnd = under 4 GB RAM or fewer than 4 cores) is not "mobile", so
 *  it rendered the full effect set on hardware that cannot afford it. Those
 *  machines are common and they are exactly the ones that felt sluggish.
 *
 *  Users who have asked their OS for less motion get it too. The CSS already
 *  honours prefers-reduced-motion for transitions, but the expensive paint work
 *  is a separate axis — someone on that setting is usually on a machine or in a
 *  context where the GPU effects are unwelcome as well.
 */
(function applyPerfMode() {
  let reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}
  if (isMobile || isLowEnd || reduceMotion) {
    document.documentElement.classList.add('low-end-mode');
  }
})();

// TV: Set initial history state so back button always returns to home (handled by tv-mode.js)


// -- LARGE-SCREEN PERFORMANCE ONLY --
// Resolution/pointer emulation is not device identity. Large displays may receive
// lighter GPU styling, but TV navigation is enabled only by confirmed UA hints or ?tv=1.
//
// The width test is a media query, not window.innerWidth. Reading innerWidth here
// is the document's FIRST geometry read, so it forces a full style+layout flush of
// a page with a 179KB stylesheet — before first paint, on every device. Profiled
// on a 4x-throttled phone it cost 109ms for one comparison that is always false
// there. matchMedia answers the same question from the viewport without flushing
// layout at all.
(function largeScreenPerf() {
  let wide = false;
  try {
    wide = window.matchMedia('(min-width: 1920px)').matches;
  } catch (e) {
    wide = window.innerWidth >= 1920;   // ancient TV browsers with no matchMedia
  }
  if (wide) document.documentElement.classList.add('large-screen-mode');
})();
 
/*  -- PERFORMANCE BOOST STYLES --
 *  Moved to the end of moviezone.css. It was ~5 KB of static CSS held in a
 *  template literal and appended to <head> during top-level execution, which
 *  invalidated computed style for the whole document and forced a full recalc
 *  inside the load window. terser also could not minify it, so it shipped
 *  formatted, comments and all, inside the JS bundle.
 *
 *  It is last in the stylesheet, so every override it used to win by being
 *  injected late still wins. See the MOVED OUT OF JAVASCRIPT banner there.
 */

// Weak device detect karke class lagana
/*  -- CLICK SPARKS --
 *
 *  The premium custom cursor that used to live here is gone. It was a 700x700
 *  radial glow, a trailing ring and a dot, all repositioned from a
 *  requestAnimationFrame loop that a mousemove listener kept alive, with
 *  `cursor: none !important` on every interactive element so the real pointer was
 *  hidden. Deleted rather than tuned, because tuning cannot win here: a
 *  JS-drawn pointer is redrawn at frame rate by the main thread, so it lags
 *  behind the hand whenever anything else is running, while the native pointer is
 *  drawn by the compositor at pointer rate and cannot lag at all. Removing it
 *  also frees the per-frame task, the mousemove handler and the delegated
 *  mouseover/mouseout pair that toggled `body.cursor-hover` on every card,
 *  button and link the pointer crossed.
 *
 *  Click sparks stay: they are one-shot, only on an actual click, and are cleaned
 *  up after 600ms.
 */
// Disable on TV, Touch, and Mobile to save CPU/battery and ensure smooth performance
if (!isMzTV() && !isTouchOnly && !isMobile) {
  // -- CLICK SPARKS (3D Particles) --
  window.addEventListener('click', (e) => {
    const numSparks = 12; // Ek baar me kitne sparks nikalne hain
    for (let i = 0; i < numSparks; i++) {
      const spark = document.createElement('div');
      spark.className = 'click-spark';
      spark.style.left = e.clientX + 'px';
      spark.style.top = e.clientY + 'px';
      
      // Random direction aur distance calculate karna (20px se 80px tak door jayenge)
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * 60 + 20;
      spark.style.setProperty('--tx', (Math.cos(angle) * distance) + 'px');
      spark.style.setProperty('--ty', (Math.sin(angle) * distance) + 'px');
      
      // Aadhe sparks ko gold aur aadhe ko purple (accent) color dena
      if (Math.random() > 0.5) {
        spark.style.background = 'var(--accent)';
        spark.style.boxShadow = '0 0 12px var(--accent), 0 0 20px var(--gold)';
      }

      document.body.appendChild(spark);
      setTimeout(() => { if (spark.parentNode) spark.remove(); }, 600); // Animation ke baad hata do
    }
  });
}

(function preconnectServers() {
  const addHint = (rel, url, crossOrigin) => {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = url;
    if (crossOrigin) link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  };

  // Cheap: DNS only, no socket. Safe to do as soon as the script has parsed.
  setTimeout(() => {
    try { playerHostOrigins().forEach(url => addHint('dns-prefetch', url)); } catch (e) {}
  }, 0);

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && (conn.saveData || ['slow-2g', '2g'].indexOf(conn.effectiveType) !== -1)) return;

  // Expensive: full TLS handshake — only for the two most-used providers, and
  // only once the browser is idle (i.e. after the first paint is done).
  const warm = () => {
    try { playerHostOrigins().slice(0, 2).forEach(url => addHint('preconnect', url, true)); } catch (e) {}
  };
  const schedule = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
    else setTimeout(warm, 2500);
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
})();

// -- SCROLL REVEAL ANIMATIONS (Intersection Observer) --
const scrollObserver = new IntersectionObserver((entries, observer) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in-view');
      observer.unobserve(entry.target);
    }
  });
}, { root: null, rootMargin: '0px 0px -40px 0px', threshold: 0.05 });
 
// -- SECURITY HELPER (XSS Protection) --
const escapeHTML = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
 
// -- GENRE MAP (defined first so carousel HTML can use it)
const GENRE_MAP = {
  28:'Action',18:'Drama',35:'Comedy',27:'Horror',878:'Sci-Fi',10749:'Romance',
  53:'Thriller',12:'Adventure',16:'Animation',80:'Crime',14:'Fantasy',
  36:'History',10402:'Music',9648:'Mystery',10752:'War',37:'Western',
  99:'Documentary',10770:'TV Movie'
};
 
let allMovies = [];

/*  ══════════════════════════════════════════════════════════════════════
 *  ONE POOL PER CATEGORY, KEPT FOR THE SESSION
 *  ══════════════════════════════════════════════════════════════════════
 *  loadMovies() cleared allMovies and wiped the grid to skeletons on every
 *  category change, so Trending → Horror → Trending rebuilt Trending's ~200-title
 *  pool from nothing: 16 responses re-read out of localStorage and JSON.parsed,
 *  deduped, rankByFreshness'd, diversified, interleaved and re-rendered. Not one
 *  byte crossed the network — every response was already cached — and the user
 *  still watched a skeleton flash and got dropped back onto page 1 of a feed they
 *  had scrolled four pages into.
 *
 *  The finished pool is now kept, so returning to a category is a slice and a
 *  render: no fetch, no parse, no re-rank, no skeleton, and the page position is
 *  where the user left it.
 *
 *  ── WHY THIS DOES NOT GO STALE ──
 *  The pool is a *ranked view* of responses that are themselves cached for 3h
 *  (discovery lists) to 12h (per-title records), so re-ranking sooner than the
 *  data underneath can change would produce an identical list at full CPU cost.
 *  15 minutes is short enough that a release landing mid-session still surfaces
 *  on the next visit to the tab, and long enough to cover the tab-hopping this
 *  exists for.
 *
 *  ── MEMORY ──
 *  Entries hold REFERENCES to the same objects tmdbCache already holds, so a
 *  pool costs ~200 array slots, not ~200 movie records. The cap is there to
 *  bound the map itself, not the payload; oldest-first because the most recently
 *  used categories are the ones worth keeping.
 */
const _mzFeedPools = new Map();
const MZ_POOL_FRESH_MS = 15 * 60 * 1000;
const MZ_POOL_MAX = 14;

/*  Sub-filters are separate pools, not variants of one.
 *
 *  Anime's mode, Cartoons' mode and a platform's All/Movies/Web-Series chip each
 *  produce a genuinely different list from the same category name. Keying on the
 *  name alone would hand the user the previous mode's grid. */
function _mzPoolKey(cat) {
  if (cat === 'anime') return 'anime|' + currentAnimeMode;
  if (cat === 'kids') return 'kids|' + currentCartoonMode;
  if (OTT[cat]) return cat + '|' + currentOttMode;
  return cat;
}

/** The usable pool for this category, or null if there is none worth reusing. */
function _mzReadPool(cat) {
  const pool = _mzFeedPools.get(_mzPoolKey(cat));
  if (!pool || !pool.movies.length) return null;
  if (Date.now() - pool.at >= MZ_POOL_FRESH_MS) return null;
  return pool;
}

function _mzSavePool(cat) {
  const key = _mzPoolKey(cat);
  // Re-inserted rather than mutated so the Map's own iteration order stays
  // least-recently-used first, which is what the eviction below relies on.
  _mzFeedPools.delete(key);
  _mzFeedPools.set(key, {
    movies: allMovies,
    page: mzFeedPage,
    tmdbPage: currentMoviePage,
    exhausted: mzFeedPoolExhausted,
    at: Date.now()
  });
  while (_mzFeedPools.size > MZ_POOL_MAX) {
    _mzFeedPools.delete(_mzFeedPools.keys().next().value);
  }
}

let currentSlide = 0;
let carouselMovies = [];
let autoSlideTimer = null;
let isLoadingMore = false;
let isSearchResultsMode = false;
let renderMoviesRunId = 0;
let renderMoviesTimer = null;

// Universal main-thread yield. MessageChannel resolves before the browser has a
// chance to repaint, so it is the cheapest available way to cede the thread to
// input handlers and DOM writes between render chunks; setTimeout trails it by
// a timer tick and is only the fallback for older engines.
function yieldToMain() {
  return new Promise(resolve => {
    if (typeof MessageChannel !== 'undefined') {
      const mc = new MessageChannel();
      mc.port1.onmessage = resolve;
      mc.port2.postMessage(undefined);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

// Run a queue of non-critical startup tasks only when the main thread is idle.
// Each task gets at least the 5ms slice the spec guarantees; time-critical work
// scheduled first is never starved. Engines without requestIdleCallback (old
// Smart TV WebKits) fall back to spreading the tasks across sequential timers.
function scheduleIdleWork(tasks, timeout = 3000) {
  if ('requestIdleCallback' in window) {
    let i = 0;
    const runNext = (deadline) => {
      while (i < tasks.length && deadline.timeRemaining() > 5) {
        try { tasks[i](); } catch (e) {}
        i++;
      }
      if (i < tasks.length) requestIdleCallback(runNext, { timeout });
    };
    requestIdleCallback(runNext, { timeout });
  } else {
    tasks.forEach((task, idx) => setTimeout(() => { try { task(); } catch (e) {} }, idx * 50));
  }
}
/*  The watchlist is a finite, local list, so infinite scroll must not run while
 *  it is on screen. This used to be inferred by checking whether the active
 *  .cat-tab's onclick contained "showWatchlist" — that broke the moment the
 *  Watchlist pill was removed from the strip, because with no matching tab the
 *  guard silently stopped firing and paged "all" movies into the watchlist grid.
 *  An explicit flag cannot be defeated by markup changes. */
let isWatchlistMode = false;
let currentModalMovie = null;
let watchlist = JSON.parse(localStorage.getItem('mz_watchlist') || '[]');
let isFullViewMovies = false;
let isFullViewUpcoming = false;
let currentMoviePage = 1;
let currentUpcomingPage = 1;
let activeTrailerStopper = null; // Function to stop the currently playing trailer
let allUpcoming = [];
let lastFocusedElement = null; // TV remote focus memory

// -- EXPLICIT DETAIL ACTIVATION GUARD --
// Opening a movie is a navigation action. Viewport changes, responsive-mode switches,
// BFCache/session restoration, and carried-over TV launch keys must never trigger it.
const DETAIL_ACTIVATION_MAX_AGE_MS = 1500;
const DETAIL_VIEWPORT_SETTLE_MS = 750;
const TV_POST_KEYUP_DEBOUNCE_MS = 400;
const detailActivationGuard = {
  lastTrustedActivationAt: -Infinity,
  viewportBlockedUntil: -Infinity,
  tvActivationArmed: !isMzTVStrictActivation(),
  tvActivationAllowedAt: (!isMzTVStrictActivation()) ? -Infinity : Infinity,
  tvInteractionEpoch: 0
};

function detailNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isMzTVMode() {
  // Same signal as isMzTV(); kept as a separate function because it gates the
  // rendering/perf budget (card caps, instant scrolling) rather than layout.
  return isMzTV();
}

// The strict TV launch guard below is a SEPARATE decision from "are we on a TV".
// It disarms activation until a fresh key release proves intent, which protects
// against a TV launcher's carried-over OK key auto-opening a title — but it also
// made the first OK press on a card a no-op, because resetTVLaunchActivation()
// runs on every DOMContentLoaded/pageshow. TVs behave like keyboard devices, so
// activation follows the laptop path and this stays off until it can be tested
// on real hardware. Flip this to isMzTV() to re-enable the strict guard.
function isMzTVStrictActivation() {
  return false;
}


function resetTVLaunchActivation() {
  if (!isMzTVStrictActivation()) return;
  detailActivationGuard.tvActivationArmed = false;
  detailActivationGuard.tvActivationAllowedAt = Infinity;
  detailActivationGuard.lastTrustedActivationAt = -Infinity;
  detailActivationGuard.tvInteractionEpoch += 1;
}

function armTVDetailActivation(fromActivationKeyRelease) {
  if (!isMzTVStrictActivation()) return;
  const now = detailNow();
  detailActivationGuard.tvActivationArmed = true;
  detailActivationGuard.tvActivationAllowedAt = fromActivationKeyRelease
    ? now + TV_POST_KEYUP_DEBOUNCE_MS
    : now;
  detailActivationGuard.lastTrustedActivationAt = -Infinity;
}

function blockDetailActivationForViewportChange() {
  const now = detailNow();
  detailActivationGuard.viewportBlockedUntil = now + DETAIL_VIEWPORT_SETTLE_MS;
  detailActivationGuard.lastTrustedActivationAt = -Infinity;
}

// A trusted pointer-down or clean activation-key down must precede detail navigation.
// Synthetic clicks and key events therefore have no authority to open the overlay.
const recordPointerActivation = (event) => {
  if (!event.isTrusted || (event.button != null && event.button !== 0)) return;
  const now = detailNow();
  if (now < detailActivationGuard.viewportBlockedUntil) return;
  if (isMzTVStrictActivation()) armTVDetailActivation(false);
  detailActivationGuard.lastTrustedActivationAt = now;
};

if ('PointerEvent' in window) {
  document.addEventListener('pointerdown', recordPointerActivation, true);
} else {
  document.addEventListener('mousedown', recordPointerActivation, true);
  document.addEventListener('touchstart', recordPointerActivation, true);
}

document.addEventListener('keydown', (event) => {
  if (!event.isTrusted) return;
  const key = event.key;
  if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
    armTVDetailActivation(false);
    return;
  }
  const code = event.keyCode || event.which;
  if (key !== 'Enter' && key !== ' ' && code !== 13 && code !== 32) return;

  const now = detailNow();
  if (event.repeat) return;
  // Always record the trusted activation time (needed for TV search fallback)
  // But only fully arm if TV activation is ready
  if (isMzTVStrictActivation() && (!detailActivationGuard.tvActivationArmed || now < detailActivationGuard.tvActivationAllowedAt)) {
    // Still record the time so tvSearchFallback can use it
    detailActivationGuard.lastTrustedActivationAt = now;
    return;
  }
  if (now < detailActivationGuard.viewportBlockedUntil) return;
  detailActivationGuard.lastTrustedActivationAt = now;
}, true);

// The launch/OK key release only makes a later, separate press eligible. A short
// post-keyup debounce rejects OS key bounce; elapsed page time never arms playback.
document.addEventListener('keyup', (event) => {
  if (!event.isTrusted) return;
  const code = event.keyCode || event.which;
  if (event.key === 'Enter' || event.key === ' ' || code === 13 || code === 32) {
    armTVDetailActivation(true);
  }
}, true);

/*  Is there actually a restored watch surface to clean up?
 *
 *  resetRestoredWatchSurface() runs on DOMContentLoaded AND on every pageshow, so
 *  it runs on every single visit — and its writes are expensive ones:
 *  overlay.scrollTop, embed.innerHTML, body.style.overflow and
 *  history.replaceState each dirty style or force layout on a document whose
 *  stylesheet is 179KB. Profiled on a 4x-throttled phone that was 237ms of main
 *  thread before first paint, and on a normal load it cleaned up nothing at all,
 *  because no modal had ever been opened.
 *
 *  Every check here is a property read that cannot flush layout: class lists, a
 *  first child, the fullscreen element, the hash and our own JS state. If none of
 *  them says otherwise, there is nothing to reset and the writes are skipped.
 */
function watchSurfaceNeedsReset() {
  for (const id of ['modal-overlay', 'upcoming-detail-overlay']) {
    const overlay = document.getElementById(id);
    if (overlay && overlay.classList.contains('open')) return true;
  }
  for (const id of ['videoEmbed', 'udTrailerEmbed']) {
    const embed = document.getElementById(id);
    if (embed && (embed.firstChild || embed.classList.contains('fullscreen-mode'))) return true;
  }
  if (document.fullscreenElement || document.webkitFullscreenElement) return true;
  if (currentModalMovie || currentUpcomingMovie || activeTrailerStopper) return true;
  if (isPlayerFullscreen || window._mzRetryTimer || _mzPrewarm) return true;
  if (document.body && document.body.style.overflow) return true;
  return window.location.hash.startsWith('#watch-');
}

function resetRestoredWatchSurface() {
  /*  The activation guard is JS state and must always be reset — a relaunch has
   *  to start disarmed whether or not a modal was open. */
  if (!watchSurfaceNeedsReset()) { resetTVLaunchActivation(); return; }

  for (const id of ['modal-overlay', 'upcoming-detail-overlay']) {
    const overlay = document.getElementById(id);
    if (overlay) {
      overlay.classList.remove('open');
      overlay.scrollTop = 0;
    }
  }

  for (const id of ['videoEmbed', 'udTrailerEmbed']) {
    const embed = document.getElementById(id);
    if (embed) {
      if (id === 'videoEmbed') { try { destroyPrewarm(); } catch (e) {} }
      embed.innerHTML = '';
      embed.classList.remove('fullscreen-mode');
    }
  }

  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (fullscreenElement) {
    try {
      const exitResult = document.exitFullscreen
        ? document.exitFullscreen()
        : (document.webkitExitFullscreen ? document.webkitExitFullscreen() : null);
      if (exitResult && typeof exitResult.catch === 'function') exitResult.catch(() => {});
    } catch (error) {}
  }

  isPlayerFullscreen = false;
  currentModalMovie = null;
  currentUpcomingMovie = null;
  // A restore/bfcache path also tears the player down — end and persist the
  // watch session here too, so progress is not lost when the surface is reset.
  if (typeof _mzStopWatchSession === 'function') { try { _mzStopWatchSession(); } catch (e) {} }
  if (activeTrailerStopper) {
    try { activeTrailerStopper(); } catch (error) {}
  }
  activeTrailerStopper = null;
  if (window._mzRetryTimer) {
    clearTimeout(window._mzRetryTimer);
    window._mzRetryTimer = null;
  }
  document.removeEventListener('keydown', exitFSOnEsc);
  document.body.style.overflow = '';

  if (window.location.hash.startsWith('#watch-')) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  resetTVLaunchActivation();
}

window.addEventListener('resize', blockDetailActivationForViewportChange, { passive: true });
window.addEventListener('orientationchange', blockDetailActivationForViewportChange, { passive: true });
document.addEventListener('DOMContentLoaded', resetRestoredWatchSurface, { once: true });
window.addEventListener('pageshow', (event) => {
  // Handles normal PWA relaunch, session-restored DOM, and BFCache restoration.
  resetRestoredWatchSurface();
  if (event.persisted) blockDetailActivationForViewportChange();
});

function claimExplicitDetailActivation(event) {
  const now = detailNow();
  if (now < detailActivationGuard.viewportBlockedUntil) return false;

  const tvActivationReady = !isMzTVStrictActivation() || (
    detailActivationGuard.tvActivationArmed &&
    now >= detailActivationGuard.tvActivationAllowedAt
  );
  // Trusted accessibility/keyboard clicks may not have pointer coordinates. On TV,
  // even these clicks remain blocked until key release/D-pad proves fresh intent.
  const trustedAccessibleClick = event && event.isTrusted && event.type === 'click' &&
    event.detail === 0 && navigator.userActivation && navigator.userActivation.isActive && tvActivationReady;
  const trustedDirectKey = event && event.isTrusted && event.type === 'keydown' && !event.repeat &&
    (event.key === 'Enter' || event.key === ' ' || (event.keyCode || event.which) === 13 || (event.keyCode || event.which) === 32) &&
    tvActivationReady;
  const hasRecentTrustedInput = tvActivationReady &&
    now - detailActivationGuard.lastTrustedActivationAt <= DETAIL_ACTIVATION_MAX_AGE_MS;
  
  // On TV: Allow activation if user has active navigator.userActivation (proves recent real interaction)
  // This handles the case where search dropdown item.click() is called from searchInput's Enter handler
  const tvSearchFallback = isMzTVStrictActivation() && !trustedAccessibleClick && !trustedDirectKey && !hasRecentTrustedInput &&
    navigator.userActivation && navigator.userActivation.isActive &&
    now - detailActivationGuard.lastTrustedActivationAt <= 3000;

  if (!trustedAccessibleClick && !trustedDirectKey && !hasRecentTrustedInput && !tvSearchFallback) return false;
  detailActivationGuard.lastTrustedActivationAt = -Infinity; // one activation opens at most one detail page
  return true;
}
 
// -- FETCH helper -- Optimized with aggressive parallel execution
const tmdbCache = new Map();
const inFlightRequests = new Map(); 
let abortControllers = new Map(); // Track controllers to cancel stale requests

/*  ══════════════════════════════════════════════════════════════════════
 *  DEFERRED CACHE WRITES
 *  ══════════════════════════════════════════════════════════════��═══════
 *  localStorage is synchronous: setItem blocks the main thread until the
 *  write lands. The SWR cache below used to call it inline in every response
 *  handler, and a cold homepage fires 15-20 TMDB requests at once — so the
 *  browser was doing 15-20 JSON.stringify calls over 20-50 KB payloads plus
 *  15-20 blocking disk writes at exactly the moment it should have been
 *  rendering the grid. That is jank you can feel on a mid-range phone.
 *
 *  Writes are now batched and flushed when the main thread is idle. The cache
 *  is a speed optimisation for the NEXT visit, so nothing needs it to be
 *  durable this instant — but pagehide flushes synchronously so closing the
 *  tab does not throw the session's cache away.
 */
const _mzCacheWriteQueue = new Map();
let _mzCacheFlushScheduled = false;

const _mzOnIdle = (typeof requestIdleCallback === 'function')
  ? (fn) => requestIdleCallback(fn, { timeout: 2000 })
  : (fn) => setTimeout(fn, 300);

/*  Quota is ~5 MB and this cache has no natural bound, so a long-lived
 *  session will eventually fill it. On overflow we drop a batch of entries and
 *  move on. Which entries go is not important — every one of them is a
 *  re-fetchable copy of a TMDB response, and picking "the oldest" would mean
 *  parsing every record's timestamp, which is the very cost being avoided.
 */
function _mzEvictCacheEntries(count) {
  const doomed = [];
  for (let i = 0; i < localStorage.length && doomed.length < count; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('mz_cache_')) doomed.push(k);
  }
  doomed.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  return doomed.length;
}

function _mzFlushCacheWrites() {
  _mzCacheFlushScheduled = false;
  if (!_mzCacheWriteQueue.size) return;
  const entries = Array.from(_mzCacheWriteQueue);
  _mzCacheWriteQueue.clear();
  for (const [cacheKey, data] of entries) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
    } catch (err) {
      // Out of quota — free some room and abandon the rest of this batch
      // rather than throwing repeatedly for every remaining entry.
      if (!_mzEvictCacheEntries(30)) return;
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
      } catch (e2) { return; }
    }
  }
}

function _mzQueueCacheWrite(cacheKey, data) {
  _mzCacheWriteQueue.set(cacheKey, data);
  if (_mzCacheFlushScheduled) return;
  _mzCacheFlushScheduled = true;
  _mzOnIdle(_mzFlushCacheWrites);
}

// Leaving the page is the last chance to persist what this session fetched.
window.addEventListener('pagehide', _mzFlushCacheWrites);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') _mzFlushCacheWrites();
});

/*  ══════════════════════════════════════════════════════════════════════
 *  NETWORK RESILIENCE
 *  ══════════════════════════════════════════════════════════════════════
 *  Datadog RUM was reporting ~91 "TypeError: Failed to fetch" per day, all
 *  from tmdb() <- loadMovies(). Hardly any of them were a broken API. Three
 *  real causes, biggest first:
 *
 *  1. RETRY STORM. loadMovies() re-ran itself every 3 s, FOREVER, whenever it
 *     finished with an empty list. Each run fans out to 15 parallel tmdb()
 *     calls, so one user on a dead connection generated ~300 failed requests
 *     a minute, every one of them logging console.error — which is exactly
 *     what RUM collects. A handful of such sessions explains the whole daily
 *     count. That loop is now bounded (see loadMovies).
 *  2. NO REQUEST-LEVEL RETRY. A single dropped packet on a mobile network
 *     handover turned straight into an empty section, because the catch below
 *     returned { results: [] } on the first failure. Transient failures now
 *     get up to two retries with exponential backoff and jitter.
 *  3. UNLOAD NOISE. Requests still in flight when the user navigates away
 *     reject with precisely this TypeError. That is browser housekeeping, not
 *     a fault, and it is no longer reported as an error.
 *
 *  Also new: a hard per-attempt timeout. Before this, a connection that
 *  opened and then stalled (captive portals and carrier-grade NAT do this)
 *  left the request pending indefinitely, so the section it fed never
 *  resolved and never errored either — it just stayed on the skeleton.
 *
 *  None of this changes the API contract. Same BASE, same endpoints, same
 *  params, same response handling. Only how long the client waits, how often
 *  it retries, and what it calls an error.
 */
/*  Per-attempt timeout.
 *
 *  This was 9000ms, and that number was the direct cause of "TMDB responded 499"
 *  appearing 511 times in five minutes.
 *
 *  499 is not something TMDB sends. It is what the hosting platform records and
 *  returns when the CLIENT closes the connection before the function replies. We
 *  were the client closing it: server.js gives its TMDB axios client a 15s
 *  timeout AND axiosRetry(retries: 6, shouldResetTimeout: true), so one
 *  /api/tmdb request can legitimately stay open for far longer than 9s while the
 *  origin is still working through host failover. Aborting at 9s guaranteed we
 *  cut it off mid-flight, and then reported the resulting 499 as an error.
 *
 *  So the client budget must not be shorter than the origin's own first-attempt
 *  budget. 15s matches it. Waiting longer than that is pointless for a user, and
 *  it does not cost them a blank screen: the SWR layer has already returned stale
 *  data for anything seen before, and the origin serves its own stale copy on
 *  failure.
 */
const MZ_FETCH_TIMEOUT_MS = 15000;  // per attempt; keep >= server.js tmdbClient timeout
const MZ_FETCH_MAX_RETRIES = 2;     // 3 attempts total, worst case
const MZ_FETCH_BACKOFF_MS = 500;    // doubled per attempt, plus jitter

// Set once the page is going away, so rejections caused by teardown can be
// told apart from real failures. pagehide covers bfcache and normal unload.
let _mzPageHiding = false;
window.addEventListener('pagehide', () => { _mzPageHiding = true; });
window.addEventListener('beforeunload', () => { _mzPageHiding = true; });

// Monotonic count of requests that failed for network reasons. loadMovies reads
// it before and after gathering, which is how it distinguishes "the network
// broke" from "TMDB genuinely has nothing for this category" — the two used to
// be indistinguishable, and treating the second as the first is what armed the
// infinite retry.
let _mzFetchFailureCount = 0;

const _mzSleep = (ms) => new Promise(r => setTimeout(r, ms));

/*  ══════════════════════════════════════════════════════════════════════
 *  REQUEST CONCURRENCY GATE
 *  ══════════════════════════════════════════════════════════════════════
 *  Datadog flagged 30 slow /api/tmdb/discover/movie and 14 slow
 *  /api/tmdb/discover/tv requests — "slow" meaning over a second. They were not
 *  slow because TMDB is slow. They were slow because they were queueing.
 *
 *  A cold homepage fires ~25 API calls in two ticks: loadCarousel() sends 10 and
 *  loadMovies('all') sends 15, all inside Promise.allSettled. Meanwhile the
 *  origin holds ONE https.Agent to TMDB with maxSockets: 12 — and that pool is
 *  global, shared across every concurrent visitor. So a single visitor already
 *  overflows it by half, and three visitors loading at once put 75 requests
 *  behind 12 sockets.
 *
 *  Firing all 25 at once buys nothing, because the server cannot forward more
 *  than 12 anyway. All it does is convert server-side queue time into
 *  client-visible request duration: the request is "in flight" from the browser's
 *  point of view — and from Datadog's — while it actually sits in a socket queue.
 *
 *  Six is chosen so one client never occupies more than half the origin's
 *  upstream pool, leaving room for other visitors. It is also what the browser
 *  itself would have enforced over HTTP/1.1.
 *
 *  This does not change WHICH requests are made, only how many are in flight at
 *  once. Order is preserved, so the carousel — which feeds the LCP element and
 *  calls first — still gets the first slots.
 *
 *  NOTE for the server side (deliberately not changed here): raising maxSockets,
 *  or giving discover responses a short s-maxage so the CDN absorbs the burst,
 *  would remove the queue at its source. That is a server decision.
 *
 *  ── UPDATE: THE ORIGIN THAT JUSTIFIED "4" NO LONGER EXISTS ──────────────────
 *  Everything above describes Render: one Express process holding a single
 *  https.Agent to TMDB with maxSockets: 12, shared across every visitor. That is
 *  what made a fifth in-flight request actively harmful.
 *
 *  The site now runs on Cloudflare Workers. There is no shared socket pool to
 *  overflow — each request is an isolate with its own fetch, and the KV cache in
 *  front of TMDB absorbs the repeats. So "4" had stopped protecting anything and
 *  was purely converting parallel work into ~7 sequential rounds on the cold
 *  homepage. It was a migration leftover, the same class of bug as the push
 *  endpoints that were never carried over.
 *
 *  8, not unlimited: the client rate budget below is still 30 per 10s, the hover
 *  prefetcher and OTT verification can burst, and some lane discipline keeps the
 *  first-screen requests ahead of background work. The cold homepage no longer
 *  depends on this number anyway — see tmdbBatch(), which collapses its 26
 *  requests into one.
 */
const MZ_MAX_CONCURRENT_FETCHES = 8;

/*  ── RATE LIMIT ──────────────────────────────────────────────────────────────
 *  TMDB allows roughly 40 requests per 10 seconds per key. The concurrency gate
 *  above caps how many are in flight, but not how many are sent over time — and
 *  those are different things. Four lanes at 200ms each is 200 requests in 10
 *  seconds, five times over the limit. Infinite scroll plus the hover prefetcher
 *  plus the OTT provider verification can genuinely reach that.
 *
 *  30 per 10s, not 40: the key is shared with server-side work (SSR pages,
 *  sitemap generation, the provider checks in the verification suites), so a
 *  client that spends the entire budget would starve those and trip the limit for
 *  everyone. This leaves headroom.
 *
 *  A cold homepage sends ~25 requests, which is under the cap, so the normal load
 *  path is not slowed at all. The limiter only engages during sustained activity,
 *  which is exactly when the 429s and cut connections were appearing.
 */
const MZ_RATE_LIMIT = 30;
const MZ_RATE_WINDOW_MS = 10000;
const _mzRateStamps = [];

// How long to wait before another request may start, 0 if there is budget now.
function _mzRateDelayMs() {
  const now = Date.now();
  while (_mzRateStamps.length && now - _mzRateStamps[0] > MZ_RATE_WINDOW_MS) _mzRateStamps.shift();
  if (_mzRateStamps.length < MZ_RATE_LIMIT) return 0;
  return Math.max(0, MZ_RATE_WINDOW_MS - (now - _mzRateStamps[0])) + 10;
}

let _mzActiveFetches = 0;
const _mzFetchQueue = [];

async function _mzAcquireSlot() {
  /*  Rate budget is waited for BEFORE taking a concurrency lane. Doing it the
   *  other way round would park a lane for seconds while it slept, which would
   *  throttle the other three for no reason.
   */
  for (let guard = 0; guard < 20; guard++) {
    const wait = _mzRateDelayMs();
    if (!wait) break;
    if (_mzPageHiding) break;
    await _mzSleep(wait);
  }
  _mzRateStamps.push(Date.now());

  // A runaway queue must never be able to wedge the app. If it ever grows past
  // anything plausible, stop gating rather than blocking.
  if (_mzActiveFetches < MZ_MAX_CONCURRENT_FETCHES || _mzFetchQueue.length > 80) {
    _mzActiveFetches++;
    return;
  }
  return new Promise(resolve => _mzFetchQueue.push(resolve));
}

function _mzReleaseSlot() {
  const next = _mzFetchQueue.shift();
  // Hand the slot straight to the next waiter instead of decrementing and
  // re-incrementing, which would let a late arrival jump the queue.
  if (next) next();
  else _mzActiveFetches = Math.max(0, _mzActiveFetches - 1);
}

// Queued promises would otherwise never settle once the page stops running.
window.addEventListener('pagehide', () => {
  while (_mzFetchQueue.length) _mzFetchQueue.shift()();
});

/*  Shared by every loader that retries (loadMovies, loadCarousel). Declared here
 *  rather than next to loadMovies because loadCarousel sits ~1600 lines earlier
 *  and reads them too — keeping them at the point of first use avoids relying on
 *  const hoisting order.
 *
 *  1.5s, 3s, 6s. Deliberately not the old flat 3s: a flat interval retried a
 *  broken connection at a constant rate forever, which is how a single bad
 *  session produced hundreds of requests. Doubling means a genuinely dead link
 *  is abandoned in under 11 seconds.
 */
const MZ_FEED_MAX_RETRIES = 3;
const MZ_FEED_RETRY_BASE_MS = 1500;

// Waits for the connection to come back instead of polling a dead link. Fires at
// most once, and only while this page is still the one the user is looking at.
function _mzWhenOnline(fn) {
  if (navigator.onLine !== false) { fn(); return; }
  const run = () => { window.removeEventListener('online', run); if (!_mzPageHiding) fn(); };
  window.addEventListener('online', run, { once: true });
}

/*  0 means "no response at all" (network-level). Retrying a 4xx is pointless: a
 *  bad request stays bad. 408/425/429 and 5xx are the ones that heal.
 *
 *  499 is the odd one and it belongs here. It is not a TMDB status — it is what the
 *  hosting platform returns when the client closed the connection before the
 *  function answered, i.e. a cut connection, which is exactly the retryable class.
 *  It was previously treated as a plain 4xx, so it failed instantly with no retry
 *  and was reported as an error 511 times in five minutes.
 */
function _mzIsTransientStatus(status) {
  return status === 0 || status === 408 || status === 425 ||
         status === 429 || status === 499 || status >= 500;
}

/*  Statuses that mean "this request was cut short", as opposed to "the server is
 *  broken". We cause most of these ourselves — the per-attempt timeout aborting,
 *  the stale-request abort, or the user navigating away mid-flight — so they are
 *  retried but never reported. Reporting a failure you deliberately caused just
 *  buries the ones you did not.
 */
function _mzIsSelfInflictedStatus(status) {
  return status === 499 || status === 408;
}

/*  ── MISSING RESOURCES ARE NOT FAULTS ────────────────────────────────────────
 *  Probed against the live proxy: every one of these returns a clean 404 with
 *  {"error":"TMDB API error","detail":"Not Found"} —
 *    /movie/999999999   a title TMDB does not have (or has since removed)
 *    /tv/{id}/watch/providers  for a title with no provider record
 *    /tv/1399/season/99 a season that does not exist
 *    /movie/undefined, /movie/NaN, /movie/, /movie/0, /movie/-5
 *
 *  None of those are broken code or a broken network. They happen normally:
 *  a Continue Watching or Watchlist entry persisted in localStorage months ago
 *  can outlive the TMDB record it points at, and plenty of titles simply have no
 *  watch-provider data.
 *
 *  Before this, a 404 went down the same path as a dropped connection: counted in
 *  _mzFetchFailureCount (which can arm the feed retry budget) and reported to
 *  Datadog via addError. So a user with one stale watchlist entry generated a
 *  steady trickle of "errors" that no one could act on.
 *
 *  Now they are silent: empty result, nothing reported, nothing counted.
 *
 *  401 stays loud on purpose — it means the TMDB read token is missing, wrong or
 *  expired, which is a real outage and must be visible immediately. 403 used to
 *  be lumped in with it; see the FORBIDDEN section below for why it is not.
 */
function _mzIsMissingStatus(status) {
  return status === 404 || status === 410;
}

/*  ── 403 IS NOT AUTOMATICALLY AN OUTAGE ──────────────────────────────────────
 *  The assumption behind treating 403 like 401 was that both mean "your token is
 *  no good". Only 401 means that. A 403 arrives with a perfectly valid, active
 *  key for reasons that are specific to one request, not to the account:
 *
 *    • the endpoint needs a permission the key does not carry — some
 *      watch/providers and certification data behaves this way per region
 *    • TMDB's edge (Cloudflare) rejects a burst as abuse rather than answering
 *      429, which is why the homepage's ~25-call fan-out can produce one
 *    • a region/language combination the account is not entitled to
 *
 *  Symptom of getting this wrong: intermittent 403s on a handful of endpoints
 *  were counted as network failures (arming the feed retry budget) and reported
 *  to Datadog on every occurrence, so a working app produced a steady drip of
 *  unactionable errors.
 *
 *  Handling now mirrors 404: serve stale cache or an empty result, do not count
 *  it, do not report it, and do not ask the same URL again for a while.
 *
 *  What is NOT given up: a token that really has been revoked or downgraded
 *  produces 403 on EVERYTHING, not on one endpoint. That case is still reported —
 *  once — by _mzNoteForbidden below, which watches for 403s spreading across
 *  unrelated endpoint families. So a genuine outage is still visible, without
 *  paying one error per request for the benign case.
 */
function _mzIsForbiddenStatus(status) {
  return status === 403;
}

/*  Shorter TTL than the 404 cache. A 404 is TMDB stating a fact about its
 *  catalogue; a 403 is frequently a passing condition (a rejected burst clears in
 *  seconds), so holding the negative result for ten minutes would keep a rail
 *  empty long after it would have worked.
 */
const _mzForbiddenUrls = new Map();
const MZ_FORBIDDEN_TTL_MS = 90 * 1000;

function _mzRememberForbidden(urlStr) {
  _mzForbiddenUrls.set(urlStr, Date.now());
  if (_mzForbiddenUrls.size > 300) {
    const cutoff = Date.now() - MZ_FORBIDDEN_TTL_MS;
    for (const [k, t] of _mzForbiddenUrls) if (t < cutoff) _mzForbiddenUrls.delete(k);
  }
}

function _mzIsKnownForbidden(urlStr) {
  const at = _mzForbiddenUrls.get(urlStr);
  if (at === undefined) return false;
  if (Date.now() - at < MZ_FORBIDDEN_TTL_MS) return true;
  _mzForbiddenUrls.delete(urlStr);
  return false;
}

/*  ── TELLING A BAD ENDPOINT FROM A BAD TOKEN ─────────────────────────────────
 *  Counting raw 403s would not work: a single dead endpoint called by six rails
 *  produces six 403s and looks identical to an outage. So what is counted is
 *  distinct endpoint FAMILIES — /movie/550 and /movie/680 are one family,
 *  /discover/tv and /trending/all are two more. Ids are collapsed because the
 *  interesting question is "how many different kinds of request are refused".
 *
 *  Four unrelated families inside a minute is not something a per-endpoint
 *  permission gap or a throttled burst produces; that is the credential. Reported
 *  once per page load, because the second report adds no information and the
 *  point of this whole path is to stop the drip.
 */
const MZ_FORBIDDEN_OUTAGE_FAMILIES = 4;
const MZ_FORBIDDEN_OUTAGE_WINDOW_MS = 60 * 1000;
const _mzForbiddenFamilies = new Map();
let _mzForbiddenOutageReported = false;

function _mzEndpointFamily(endpoint) {
  const parts = String(endpoint).split('?')[0].split('/').filter(Boolean);
  // Drop id-like and locale-like segments so /movie/550/videos and
  // /movie/680/videos collapse to the same family.
  const shape = parts.map(p => (/^\d+$/.test(p) ? ':id' : p));
  return shape.slice(0, 3).join('/') || '(root)';
}

function _mzNoteForbidden(endpoint) {
  const now = Date.now();
  const family = _mzEndpointFamily(endpoint);
  _mzForbiddenFamilies.set(family, now);

  const cutoff = now - MZ_FORBIDDEN_OUTAGE_WINDOW_MS;
  for (const [k, t] of _mzForbiddenFamilies) if (t < cutoff) _mzForbiddenFamilies.delete(k);

  if (_mzForbiddenOutageReported) return false;
  if (_mzForbiddenFamilies.size < MZ_FORBIDDEN_OUTAGE_FAMILIES) return false;
  _mzForbiddenOutageReported = true;
  return true;
}

/*  Negative cache for confirmed-missing URLs, so hovering the same dead card ten
 *  times does not send ten requests. Short TTL on purpose: it is keyed on a 404,
 *  and while TMDB is reliable about 404 meaning "not here", a title genuinely can
 *  be added later, and a 10-minute window is not worth arguing about.
 */
const _mzMissingUrls = new Map();
const MZ_MISSING_TTL_MS = 10 * 60 * 1000;

function _mzRememberMissing(urlStr) {
  _mzMissingUrls.set(urlStr, Date.now());
  // Bound the map; these keys are long and a browsing session can touch many.
  if (_mzMissingUrls.size > 300) {
    const cutoff = Date.now() - MZ_MISSING_TTL_MS;
    for (const [k, t] of _mzMissingUrls) if (t < cutoff) _mzMissingUrls.delete(k);
  }
}

function _mzIsKnownMissing(urlStr) {
  const at = _mzMissingUrls.get(urlStr);
  if (at === undefined) return false;
  if (Date.now() - at < MZ_MISSING_TTL_MS) return true;
  _mzMissingUrls.delete(urlStr);
  return false;
}

/*  A title confirmed gone from TMDB should stop haunting the user.
 *
 *  Continue Watching and the Watchlist are localStorage lists of ids, so they
 *  outlive the TMDB records they point at. Without pruning, a title that TMDB
 *  removed sits in the rail forever: it renders (the poster path is cached in the
 *  list entry), the user taps it, it 404s, nothing opens — every single session.
 *  Dropping the entry the first time a 404 is confirmed makes the problem
 *  self-healing instead of permanent.
 */
function _mzForgetDeadTitle(id, type) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return;
  try {
    const cw = JSON.parse(localStorage.getItem('mz_continue_watching') || '[]');
    const keptCw = cw.filter(e => Number(e && e.id) !== numId);
    if (keptCw.length !== cw.length) {
      localStorage.setItem('mz_continue_watching', JSON.stringify(keptCw));
      if (typeof renderContinueWatching === 'function') renderContinueWatching();
    }
  } catch (e) { /* corrupt list - leave it to the normal parse guards */ }

  try {
    if (Array.isArray(watchlist)) {
      const kept = watchlist.filter(e => Number(e && e.id) !== numId);
      if (kept.length !== watchlist.length) {
        watchlist = kept;
        localStorage.setItem('mz_watchlist', JSON.stringify(watchlist));
      }
    }
  } catch (e) { /* same */ }
  console.debug('[MovieZone] pruned dead title', type + '/' + id, 'from saved lists');
}

/*  ── REJECT IMPOSSIBLE IDs BEFORE THEY BECOME REQUESTS ───────────────────────
 *  /movie/undefined and /movie/NaN are what you get when an id arrives as
 *  undefined or fails parseInt — a card rendered from a TMDB item with no id, or
 *  a corrupt localStorage entry. They cannot succeed, so sending them only burns
 *  a request and produces a 404 to explain away.
 *
 *  The test is deliberately narrow: reject the literal broken forms and any
 *  non-positive number, and let everything else through. A whitelist of valid
 *  named endpoints (/movie/popular, /tv/airing_today, /movie/latest …) would have
 *  to be kept in step with TMDB forever and would eventually reject something
 *  legitimate. TMDB is the authority on whether an id exists; this only catches
 *  the cases that are wrong on their face.
 *
 *  Note /tv/{id}/season/0 is valid — season 0 is the specials season — so the
 *  check only applies to the id segment straight after a resource name.
 */
const MZ_ID_RESOURCES = { movie: 1, tv: 1, collection: 1, person: 1, company: 1, network: 1, keyword: 1 };

function _mzInvalidIdSegment(endpoint) {
  const parts = String(endpoint).split('?')[0].split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (!MZ_ID_RESOURCES[parts[i]]) continue;
    const seg = parts[i + 1];
    if (seg === '' || seg === 'undefined' || seg === 'null' || seg === 'NaN') {
      return parts[i] + '/' + (seg === '' ? '(empty)' : seg);
    }
    // Numeric-looking but impossible. Non-numeric strings are named endpoints
    // and are left for TMDB to judge.
    if (/^-?\d+$/.test(seg) && Number(seg) <= 0) return parts[i] + '/' + seg;
  }
  return null;
}

/*  Retry policy, which is not the same question as "is this status transient".
 *  403 gets exactly one more attempt: when it comes from a rejected burst it
 *  clears immediately, and recovering the real data beats falling back to stale.
 *  It does not get the full budget, because when 403 means "this endpoint is not
 *  permitted" no number of attempts will change it.
 */
function _mzShouldRetryStatus(status, attempt) {
  if (_mzIsTransientStatus(status)) return true;
  return _mzIsForbiddenStatus(status) && attempt === 0;
}

/*  A failure is "benign" when it was caused by something other than the network
 *  being broken, and reporting it would be noise:
 *    • the page is unloading  — the browser cancels in-flight requests
 *    • the device is offline  — already surfaced to the user by the OS
 *    • the request was aborted — either by our own stale-request logic or by
 *      the timeout, both of which are deliberate
 */
function _mzIsBenignFailure(err) {
  if (_mzPageHiding) return true;
  if (navigator.onLine === false) return true;
  // A cut connection we caused ourselves. Retried above, never reported.
  if (err && err.name === 'HttpError' && _mzIsSelfInflictedStatus(err.status)) return true;
  return !!err && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/*  The value returned for anything that does not exist: an invalid id, a
 *  confirmed 404, a title with no provider record. Shaped like an empty TMDB
 *  response so every existing caller keeps working — `r.results || []` yields [],
 *  and the watch/providers consumer's `Object.keys(results).length` yields 0,
 *  which it already treats as "no data".
 *
 *  The markers are non-enumerable so they never reach JSON.stringify, the
 *  localStorage cache, or a `for...in` over the response.
 */
function _mzMissingResult() {
  const out = { results: [] };
  Object.defineProperty(out, '_mzMissing', { value: true, enumerable: false });
  Object.defineProperty(out, '_mzFailed', { value: true, enumerable: false });
  return out;
}

function _mzReportFetchError(err, meta) {
  // Structured, queryable context beats a stringified console line. RUM's error
  // tracking also picks up console.error, so this uses console.warn to avoid
  // reporting the same failure twice.
  try {
    if (window.DD_RUM && typeof window.DD_RUM.addError === 'function') {
      window.DD_RUM.addError(err, Object.assign({ source: 'tmdb' }, meta));
    }
  } catch (e) { /* never let telemetry break a fetch */ }
  console.warn('[MovieZone] TMDB request failed', meta, err && err.message);
}

/*  One attempt, with a hard timeout, cancellable from the caller's controller.
 *  A fresh controller per attempt is required because an AbortController is
 *  single-use — reusing the outer one would make attempt 2 abort instantly.
 */
async function _mzFetchAttempt(urlStr, outerSignal) {
  // Gate is acquired per attempt, so a retry queues behind current traffic
  // instead of jumping it.
  await _mzAcquireSlot();

  const attemptController = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => { timedOut = true; attemptController.abort(); }, MZ_FETCH_TIMEOUT_MS);
  const relayAbort = () => attemptController.abort();
  if (outerSignal.aborted) relayAbort();
  else outerSignal.addEventListener('abort', relayAbort, { once: true });

  try {
    const r = await fetch(urlStr, { signal: attemptController.signal });
    return r;
  } catch (err) {
    if (timedOut) {
      const e = new Error('TMDB request timed out after ' + MZ_FETCH_TIMEOUT_MS + 'ms');
      e.name = 'TimeoutError';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', relayAbort);
    _mzReleaseSlot();
  }
}

/*  Retries transient failures only, and gives up immediately if the caller
 *  cancelled or the page is going away. Returns the parsed JSON, or throws the
 *  last error for tmdb()'s catch to turn into a cache/empty fallback.
 */
async function _mzFetchWithRetry(urlStr, outerSignal, meta) {
  let lastError = null;

  for (let attempt = 0; attempt <= MZ_FETCH_MAX_RETRIES; attempt++) {
    if (outerSignal.aborted || _mzPageHiding) break;

    // Retrying while the OS says there is no link just burns battery. Wait for
    // the connection to come back, but not longer than one backoff window —
    // the caller has its own retry, so blocking here indefinitely would hang it.
    if (navigator.onLine === false && attempt > 0) break;

    try {
      const r = await _mzFetchAttempt(urlStr, outerSignal);
      if (r.ok) return await r.json();

      if (!_mzShouldRetryStatus(r.status, attempt) || attempt === MZ_FETCH_MAX_RETRIES) {
        const e = new Error('TMDB responded ' + r.status);
        e.name = 'HttpError';
        e.status = r.status;
        throw e;
      }

      // 429 tells us how long to wait; honour it rather than guessing.
      const retryAfter = Number(r.headers.get('Retry-After'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000)
        : MZ_FETCH_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 250;
      lastError = new Error('TMDB responded ' + r.status);
      lastError.status = r.status;
      await _mzSleep(wait);
      continue;
    } catch (err) {
      lastError = err;
      // Deliberate cancellation and teardown are final — never retry them.
      if (err.name === 'AbortError' || _mzPageHiding) throw err;
      if (err.name === 'HttpError' && !_mzShouldRetryStatus(err.status, attempt)) throw err;
      if (attempt === MZ_FETCH_MAX_RETRIES) throw err;

      // Jitter matters here: a cold homepage fires 15 of these at once, and
      // without it all 15 would retry in the same millisecond and collide again.
      await _mzSleep(MZ_FETCH_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 250);
    }
  }

  throw lastError || new Error('TMDB request abandoned');
}

/*  The exact URL tmdb() will request for an endpoint + params pair.
 *
 *  Extracted from tmdb() rather than copied, because tmdbBatch() has to decide
 *  which URLs are already cached and it keys that decision on this string. If the
 *  two ever built the URL differently, batching would silently stop matching the
 *  cache and quietly re-download the whole first screen.
 */
function _mzTmdbUrl(endpoint, params) {
  params = params || {};
  let qs = '';
  if (Object.keys(params).length) {
    qs = '?' + Object.entries(params).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  }
  return BASE + endpoint + qs;
}

/** How long a localStorage copy counts as fresh enough to skip the network. */
const MZ_TMDB_SWR_FRESH_MS = 12 * 60 * 60 * 1000;

/*  ══════════════════════════════════════════════════════════════════════
 *  AUTO-UPDATE: FRESHNESS IS PER ENDPOINT, NOT ONE NUMBER
 *  ═══════════════════════════════════════════════════════════════���══════
 *  A single 12h window is right for a title's own record - Interstellar's runtime
 *  and cast do not change - and wrong for the lists the home page is built from.
 *  /trending/movie/week, /movie/now_playing and every /discover query are the
 *  answer to "what is out right now", and holding that answer for twelve hours is
 *  precisely how a release that landed this morning fails to appear until
 *  tonight. A returning visitor would keep being served the same hero all day.
 *
 *  So the discovery endpoints get a 3h window and everything else keeps 12h. The
 *  effect is that the carousel and the feeds re-ask TMDB up to eight times a day
 *  and a new release surfaces on the first visit after it enters TMDB's own
 *  rankings, while the per-title requests - by far the larger number of calls -
 *  are not made any more often than before.
 *
 *  Note this is only ONE of the three caches in the path. The other two are in
 *  worker.js (KV, per-path TTL and the batch entry) and both were narrowed for
 *  the same reason; a short window here would achieve nothing on its own if the
 *  edge still answered with a week-old body.
 *
 *  The date-windowed queries have a second, independent freshness mechanism worth
 *  knowing about: carouselIndustryQuery() and friends build
 *  primary_release_date.gte/lte from istDateStr(), so their URL - and therefore
 *  every cache key derived from it - changes at IST midnight on its own. The
 *  window slides forward daily whether or not anything else is tuned.
 */
const MZ_TMDB_VOLATILE_FRESH_MS = 3 * 60 * 60 * 1000;

/*  Endpoint families whose answer changes as titles release. Matched on the URL
 *  because that is what both cache readers already hold. /movie/top_rated is
 *  deliberately absent - it is an all-time list and barely moves. */
const MZ_TMDB_VOLATILE_RE = /\/(?:trending|discover)\/|\/movie\/(?:popular|now_playing|upcoming)|\/tv\/(?:popular|airing_today|on_the_air)/;

/** How long a cached copy of this URL may be served without revalidating. */
function _mzTmdbFreshMs(urlStr) {
  return MZ_TMDB_VOLATILE_RE.test(urlStr) ? MZ_TMDB_VOLATILE_FRESH_MS : MZ_TMDB_SWR_FRESH_MS;
}

/*  ══════════════════════════════════════════════════════════════════════
 *  EDGE BATCHING
 *  ══════════════════════════════════════════════════════════════════════
 *  A cold homepage needs 26 TMDB responses before the first card can paint:
 *  loadCarousel() asks for 10, loadMovies('all') for 16. Sent as 26 separate
 *  requests through the concurrency gate they became ~7 sequential rounds, and
 *  on mobile each round costs a full radio round-trip on top of the ~136ms the
 *  API itself takes. That is the mobile P50/P95 problem — not the posters, which
 *  are already lazy with a real srcset.
 *
 *  This sends the whole plan to /api/tmdb/batch in ONE request. The Worker does
 *  the fan-out at the edge, next to TMDB and its KV cache, and returns the
 *  responses in order.
 *
 *  Three properties make this safe to drop in:
 *
 *    1. IT RETURNS Promise.allSettled's SHAPE, because it ends by actually
 *       calling it. The batch response is only used to PRIME tmdbCache; the
 *       per-URL calls that follow then hit memory and never touch the network.
 *       So every caller's downstream code — including the index-sensitive
 *       TV_SOURCE_FROM offset in loadMovies — is untouched.
 *
 *    2. IT FALLS BACK BY DOING NOTHING. If the batch request fails, or the
 *       Worker predates this endpoint and answers 404, the priming step is
 *       skipped and the final allSettled performs the 26 individual requests
 *       exactly as before. Nothing to detect, nothing to configure — the site
 *       works deployed or not.
 *
 *    3. IT SKIPS WHAT IS ALREADY CACHED. A returning visitor whose localStorage
 *       is still fresh sends no batch at all, so this never trades a repeat
 *       visitor's instant load for a first-time visitor's win.
 */

/** Below this, a batch costs more than it saves — just let tmdb() run. */
const MZ_BATCH_MIN_REQUESTS = 3;

/*  True when tmdb() can answer this URL without the network. Read-only: it
 *  promotes a fresh localStorage copy into the memory cache, which is what
 *  tmdb() would do a moment later anyway, so the parse is not wasted.
 */
function _mzTmdbAnsweredFromCache(urlStr) {
  if (tmdbCache.has(urlStr)) return true;
  try {
    const raw = localStorage.getItem('mz_cache_' + urlStr);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.timestamp
        && (Date.now() - parsed.timestamp < _mzTmdbFreshMs(urlStr))) {
      tmdbCache.set(urlStr, parsed.data);
      return true;
    }
  } catch (e) { /* unreadable cache entry — treat as a miss */ }
  return false;
}

/**
 * Fetches many TMDB endpoints in one round-trip.
 *
 * @param {Array<[string, object]>} plan endpoint + params pairs, in the order the
 *        caller will read the results back in
 * @returns {Promise<Array<{status:string, value?:object, reason?:any}>>}
 *        exactly what Promise.allSettled(plan.map(tmdb)) returns
 */
async function tmdbBatch(plan) {
  const run = () => Promise.allSettled(plan.map(([endpoint, params]) => tmdb(endpoint, params)));

  try {
    if (isLocalhost) return run(); // dev server has no batch endpoint

    // Only ask for what no cache can answer. On a warm repeat visit this is
    // usually empty and the batch is skipped entirely.
    const cold = [];
    for (const [endpoint, params] of plan) {
      const urlStr = _mzTmdbUrl(endpoint, params);
      if (!_mzTmdbAnsweredFromCache(urlStr)) cold.push(urlStr);
    }
    if (cold.length < MZ_BATCH_MIN_REQUESTS) return run();

    // The Worker wants paths relative to /api/tmdb, which is what BASE is.
    const paths = cold.map((urlStr) => urlStr.slice(BASE.length));

    /*  POST, not a GET with the plan in the query string.
     *
     *  The 16-path ALL feed is ~1.9k of raw path text. Measured: as a JSON array
     *  through encodeURIComponent that is a 2332-character URL, and base64url of
     *  the same plan is 2520 — base64 inflates by a third. Both clear the
     *  2048-character limit plenty of intermediaries still enforce, and a 414
     *  would be caught below and silently leave this page on 26 requests
     *  forever. A body has no length limit, so that failure mode is gone.
     *
     *  No HTTP caching is lost: the Worker is invoked for every /api/* request
     *  anyway, the shared cache is a KV entry keyed on the plan, and the
     *  per-endpoint responses are already held in memory and in localStorage
     *  for 12h by tmdb() itself.
     */
    const response = await fetch(BASE + '/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
      credentials: 'same-origin'
    });
    if (!response.ok) throw new Error('batch responded ' + response.status);
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
      // An /api path the Worker does not implement is answered with the SPA
      // shell, so a 200 is not proof the endpoint exists.
      throw new Error('batch did not return JSON');
    }

    const payload = await response.json();
    const results = payload && payload.results;
    if (!Array.isArray(results) || results.length !== paths.length) {
      throw new Error('batch returned an unexpected shape');
    }

    /*  Prime the caches tmdb() reads. The memory cache is what makes the calls
     *  below instant; the localStorage write is what makes the NEXT visit
     *  instant, and it goes through the same deferred queue as tmdb() so it
     *  cannot block the main thread during the first paint.
     */
    let primed = 0;
    results.forEach((result, i) => {
      if (!result || result.status !== 'fulfilled' || !result.value) return;
      const urlStr = cold[i];
      tmdbCache.set(urlStr, result.value);
      _mzQueueCacheWrite('mz_cache_' + urlStr, result.value);
      primed++;
    });

    console.debug('[MovieZone] edge batch primed ' + primed + '/' + paths.length
      + ' endpoints in one request (' + (response.headers.get('x-cache') || '?') + ')');
  } catch (err) {
    /*  Never fatal. A failed batch just means the loop below does the work the
     *  old way, which is the behaviour this replaced.
     */
    console.debug('[MovieZone] edge batch unavailable, falling back to individual requests:',
      err && err.message);
  }

  return run();
}

async function tmdb(endpoint, params) {
  params = params || {};

  /*  Fail fast on ids that cannot exist. Returns the same empty shape a 404
   *  would, so the ~40 call sites that read `r.results || []` are unaffected, but
   *  no request leaves the browser and nothing is reported.
   */
  const badId = _mzInvalidIdSegment(endpoint);
  if (badId) {
    console.debug('[MovieZone] skipped TMDB request with an impossible id:', badId);
    return _mzMissingResult();
  }

  const urlStr = _mzTmdbUrl(endpoint, params);

  
  if (tmdbCache.has(urlStr)) return tmdbCache.get(urlStr); // Memory cache (instant)

  // Already confirmed missing this session — do not ask again. Hovering the same
  // dead card repeatedly used to fire a request every time.
  if (_mzIsKnownMissing(urlStr)) return _mzMissingResult();
  
  // ZERO-LATENCY SWR (Stale-While-Revalidate) CACHING
  const cacheKey = 'mz_cache_' + urlStr;
  const localDataStr = localStorage.getItem(cacheKey);
  let cachedData = null;
  let isFresh = false;

  if (localDataStr) {
    try {
      const parsed = JSON.parse(localDataStr);
      cachedData = parsed.data;
      // Fresh enough to skip the network: 3h for the discovery endpoints, 12h
      // for everything else. See _mzTmdbFreshMs.
      if (parsed.timestamp && (Date.now() - parsed.timestamp < _mzTmdbFreshMs(urlStr))) {
        // Promote into the in-memory cache before returning. Without this every
        // repeat call for the same URL paid another synchronous getItem plus a
        // JSON.parse of a 20-50 KB payload — and repeats are the normal case,
        // because the background prefetcher warms the exact URLs the loaders
        // then ask for. The memory map makes the second call a lookup.
        tmdbCache.set(urlStr, cachedData);
        return cachedData; // Immediate return if cache is fresh
      }
    } catch(e) {}
  }
 
  /*  A URL TMDB refused moments ago. Checked here rather than beside the 404
   *  guard above so the stale copy read by the block above can still be served —
   *  yesterday's posters beat an empty rail, and unlike a 404 this data was real.
   *  Short window, so a passing 403 does not keep the rail empty for long, but
   *  long enough that the rails sharing a refused URL do not each pay a request.
   */
  if (_mzIsKnownForbidden(urlStr)) return cachedData || _mzMissingResult();

  if (inFlightRequests.has(urlStr)) {
    return cachedData ? cachedData : inFlightRequests.get(urlStr);
  }

  // Unique Abort Strategy
  if (abortControllers.has(urlStr)) {
    abortControllers.get(urlStr).abort();
  }
  const controller = new AbortController();
  abortControllers.set(urlStr, controller);
 
  const fetchPromise = (async () => {
    try {
      const data = await _mzFetchWithRetry(urlStr, controller.signal, { endpoint: endpoint, url: urlStr });
      tmdbCache.set(urlStr, data);

      // Queued, not written inline — see DEFERRED CACHE WRITES above.
      _mzQueueCacheWrite(cacheKey, data);

      return data;
    } catch (e) {
      /*  Every exit below returns data rather than rethrowing, exactly as before —
       *  callers spread `r.results || []` across ~40 sites and none of them expect
       *  a rejection. What changed is the bookkeeping:
       *
       *    • stale cache is preferred over an empty list, so a failed refresh
       *      shows yesterday's posters instead of an empty rail;
       *    • the failure is COUNTED, so loadMovies can tell a network fault from
       *      a genuinely empty category and stop retrying the latter forever;
       *    • the returned object is MARKED, so a direct caller can check;
       *    • only non-benign failures are reported, and via DD_RUM.addError with
       *      the endpoint attached instead of a bare console.error.
       */
      const benign = _mzIsBenignFailure(e);
      const missing = e && e.name === 'HttpError' && _mzIsMissingStatus(e.status);
      const forbidden = e && e.name === 'HttpError' && _mzIsForbiddenStatus(e.status);

      if (forbidden) {
        /*  Silent, like a 404, and for the same reason: the app is working, this
         *  one request was refused. Already retried once by _mzFetchWithRetry, so
         *  by here it is not a passing burst rejection.
         *
         *  Deliberately NOT counted in _mzFetchFailureCount — counting it would
         *  let one refused endpoint arm loadMovies' feed retry budget, which is
         *  how this turned into repeated request storms.
         *
         *  Reported only if 403s have spread across unrelated endpoint families,
         *  which is the signature of a revoked or downgraded token as opposed to
         *  one endpoint the key cannot reach.
         */
        _mzRememberForbidden(urlStr);
        if (_mzNoteForbidden(endpoint)) {
          _mzReportFetchError(e, {
            endpoint: endpoint,
            status: 403,
            reason: 'tmdb_token_forbidden_across_endpoints',
            families: Array.from(_mzForbiddenFamilies.keys()).join(','),
            hadStaleCache: !!cachedData
          });
        } else {
          console.debug('[MovieZone] TMDB refused', endpoint, '(403) - serving cache and skipping silently');
        }
        return cachedData || _mzMissingResult();
      }

      if (missing) {
        /*  Silent by design. This is "TMDB does not have this", not a fault:
         *  a stale watchlist id, a removed title, a season that never existed, or
         *  simply no watch-provider record. Not counted as a network failure (so
         *  it cannot arm the feed retry budget) and not reported to Datadog (so it
         *  cannot drown the errors that do matter). Remembered for 10 minutes so
         *  the same dead URL is not asked for again.
         */
        _mzRememberMissing(urlStr);
        console.debug('[MovieZone] TMDB has no record for', endpoint, '- skipping silently');
        return cachedData || _mzMissingResult();
      }

      if (!benign) {
        _mzFetchFailureCount++;
        _mzReportFetchError(e, {
          endpoint: endpoint,
          status: e.status || 0,
          offline: navigator.onLine === false,
          hadStaleCache: !!cachedData
        });
      }

      if (cachedData) return cachedData;
      // Non-enumerable so it never leaks into JSON.stringify or the cache write,
      // and so `for (const k in res)` loops elsewhere stay unaffected.
      const fallback = { results: [] };
      Object.defineProperty(fallback, '_mzFailed', { value: true, enumerable: false });
      return fallback;
    } finally {
        if (abortControllers.get(urlStr) === controller) abortControllers.delete(urlStr);
    }
  })(); 
  
  inFlightRequests.set(urlStr, fetchPromise);
  fetchPromise.finally(() => inFlightRequests.delete(urlStr));
  
  // Makhan Speed: Return instantly if we have stale/fresh cache, otherwise wait for network
  if (cachedData && !isFresh) tmdbCache.set(urlStr, cachedData);
  return cachedData ? cachedData : fetchPromise;
}
 
// -- INIT -- Priority-based staggered loading for ultra-fast startup
async function init() {
  /*  The multi-language button styles used to be injected here, as a <style>
   *  element appended on DOMContentLoaded. That is the worst possible moment for
   *  it: appending a stylesheet invalidates computed style document-wide and
   *  forces a full recalculation, and this one landed exactly when the browser
   *  was trying to produce the first paint. The rules are static and now live at
   *  the end of moviezone.css.
   */
  /*  Below-the-fold sections load only when they scroll near the viewport,
   *  so they never compete with the hero or the movie feed for the first
   *  round-trips. #upcoming is the only lazy section today; more can be added
   *  by listing their loader here. Engines without IntersectionObserver keep
   *  the old idle-time deferral so the section still fills eventually.
   */
  function setupLazySections() {
    const section = document.getElementById('upcoming');
    if (!section) return;
    if (!('IntersectionObserver' in window)) {
      const fallback = () => loadUpcoming();
      if ('requestIdleCallback' in window) requestIdleCallback(fallback, { timeout: 5000 });
      else setTimeout(fallback, 1500);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          loadUpcoming();
          observer.disconnect();
          break;
        }
      }
    }, { rootMargin: '200px' });
    observer.observe(section);
  }

  try {
    // Load carousel and movies in parallel (Promise.allSettled ensures one failure doesn't block other)
    await Promise.allSettled([
      loadCarousel(),
      loadMovies('all')
    ]);

    // TOP 10 TRENDING sits just below the hero; kick it off right after the
    // carousel/grid fan-out so it fills in without blocking first paint.
    initTop10();

    // 4. Upcoming is below the fold, so do not ask for it until the section is
    //    near the viewport (see setupLazySections above). On engines without an
    //    IntersectionObserver that falls back to an idle-time load.
    setupLazySections();

    // 5. Safety net only. index.html already drops the loader on DOMContentLoaded,
    //    which happens before this await settles, so on a normal load this is a
    //    no-op. It stays for the case where the shell script was skipped (older
    //    TV browsers) - but the 400 ms setTimeout that used to wrap it is gone:
    //    it delayed the reveal by 400 ms plus the 0.8 s fade for no benefit.
    const loader = document.getElementById('mz-loader');
    if (loader) loader.classList.add('loader-hidden');

  } catch (err) {
    console.error("Init Error:", err);
    const loader = document.getElementById('mz-loader');
    if (loader) loader.classList.add('loader-hidden');
  }

  /*  Luxury Ambient Particles (Jugnu) — REMOVED.
   *
   *  This built a fixed full-screen layer with 18 glowing divs (8 on low-end) and
   *  left them floating up the viewport on an infinite 12–30s loop. Decorative,
   *  but not free: the keyframes animated box-shadow alongside transform, and
   *  box-shadow cannot be composited, so all 18 forced a repaint every frame for
   *  as long as the tab stayed open — competing with scrolling and with poster
   *  decode. The .ambient-particles / .particle CSS and @keyframes floatParticle3D
   *  are gone from moviezone.css too. */

  setupInfiniteScroll();
  setupUpcomingInfiniteScroll();
  ensureTabPrefetch();
}

function setupInfiniteScroll() {
    const trigger = document.getElementById('infiniteScrollTrigger');
    if (!trigger) return;

    /*  Paged feed: the observer is simply never installed, so scrolling can no
     *  longer append a page. MZ_FEED_PAGED is read here rather than deleting this
     *  function, so handing the feed back to infinite scroll is one constant.
     */
    if (MZ_FEED_PAGED) {
      ensurePagerDelegation();
      renderFeedPager();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && !isLoadingMore) {
            if (isSearchResultsMode) return; // Search results are a fixed, related set — no infinite scroll
            if (isWatchlistMode) return;     // Watchlist is a finite local list
            loadMoreMoviesAction();
        }
    }, {
        rootMargin: '400px' // Start loading 400px before the element is visible
    });
    observer.observe(trigger);
}
 
function setupUpcomingInfiniteScroll() {
    const trigger = document.getElementById('infiniteScrollTriggerUpcoming');
    if (!trigger) return;

    const observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && !isLoadingMore) {
            loadUpcoming(true);
        }
    }, {
        rootMargin: '400px'
    });
    observer.observe(trigger);
}
 
/*  ══════════════════════════════════════════════════════════════════════
 *  RELEASE → PRINT QUALITY TIMELINE  (single source of truth)
 *  ══════════════════════════════════════════════════════════════════════
 *  There is no external print-quality feed anywhere in this app, so quality is
 *  derived from how long ago a title released: a movie is a CAM print in its
 *  first weeks and works its way up to HD, FHD and finally 4K months later.
 *
 *  This table used to be duplicated — once inline in renderMovies() for the
 *  badge, once as hard-coded day windows inside calculateMovieScore() for the
 *  ranking. Both now read these tables, so a card can never show "HD" while
 *  the ranking still believes the title is a CAM.
 *
 *  Each entry means "from this many days after release the print looks like
 *  this". A stage can be conditional: a 4K/Blu-ray master is only assumed for
 *  titles with real rating and traction, otherwise the print stays FHD.
 *
 *  `isRealPrint` marks the stages that are an actual quality release rather
 *  than a better cam rip. Only those crossings count as a "quality upgrade":
 *  a film going from CAM to TS three weeks in is not news and must not be
 *  re-surfaced, whereas the HD/FHD/4K print landing months later is exactly
 *  the event this feature exists for.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const MOVIE_QUALITY_TIMELINE = [
  { fromDay: 0,   qual: 'CAM',  cls: 'qual-cam'  },  // in theatres, cam rips only
  { fromDay: 21,  qual: 'TS',   cls: 'qual-ts'   },
  { fromDay: 45,  qual: 'HDTS', cls: 'qual-hdts' },
  { fromDay: 75,  qual: 'HD',   cls: 'qual-hd',  isRealPrint: true },  // digital / OTT release
  { fromDay: 120, qual: 'FHD',  cls: 'qual-fhd', isRealPrint: true },
  { fromDay: 200, qual: '4K',   cls: 'qual-4k',  isRealPrint: true,    // 4K / Blu-ray window
    minRating: 7.0, minPopularity: 50,
    orElse: { qual: 'FHD', cls: 'qual-fhd' } }
];

/*  Web series and anime never go through a cam stage — they come straight off a
 *  streaming platform — but they DO get better copies over time, which is the
 *  same event a viewer waits for:
 *    week 1     it has just dropped
 *    to ~1 month  the early web rip
 *    ~1 month     the clean full-season / better encode  ← worth re-surfacing
 *    ~4 months    the 4K or Blu-ray master (anime BD batches land here)
 *  Only those last two are real prints, so a series is not dragged back to the
 *  top merely for leaving its first week. */
const TV_QUALITY_TIMELINE = [
  { fromDay: 0,   qual: 'NEW', cls: 'qual-new'  },
  { fromDay: 7,   qual: 'HD',  cls: 'qual-hd'   },
  { fromDay: 30,  qual: 'FHD', cls: 'qual-fhd', isRealPrint: true },
  { fromDay: 120, qual: '4K',  cls: 'qual-4k',  isRealPrint: true,
    minRating: 7.5, minPopularity: 60,
    orElse: { qual: 'FHD', cls: 'qual-fhd' } }
];

function mediaTypeOf(title) {
  return title.media_type || (title.name && !title.title ? 'tv' : 'movie');
}

function qualityTimelineFor(type) {
  return type === 'movie' ? MOVIE_QUALITY_TIMELINE : TV_QUALITY_TIMELINE;
}

/** Resolves one timeline stage for a specific title, applying the conditional
 *  stage rules. Returns { qual, cls }. */
function qualityAtStage(timeline, stageIndex, title) {
  const stage = timeline[stageIndex];
  if (!stage) return null;
  if (stage.minRating != null) {
    const goodEnough = (title.vote_average || 0) >= stage.minRating
      && (title.popularity || 0) >= stage.minPopularity;
    if (!goodEnough) return stage.orElse;
  }
  return { qual: stage.qual, cls: stage.cls };
}

/*  Everything the UI and the ranking need to know about a title's print
 *  quality, and — the point of this feature — HOW RECENTLY that print changed.
 *  Works for movies, web series and anime; only the timeline differs.
 *
 *  Returns:
 *    qual / cls          the badge to draw
 *    daysOld             age since release (null when the date is unusable)
 *    upgradedDaysAgo     days since the print improved, null if it never has
 *    upgradedFrom        the label it replaced, for the "NEW HD" ribbon
 *
 *  `upgradedDaysAgo` is deliberately based on the label rather than the stage
 *  index: crossing day 200 without meeting the 4K bar leaves the print at FHD,
 *  which is not an upgrade and must not re-surface the title.
 */
function titleQualityState(title, nowMs) {
  const now = nowMs || Date.now();
  const type = mediaTypeOf(title);
  const timeline = qualityTimelineFor(type);
  const dateStr = title.release_date || title.first_air_date;
  const state = {
    type: type,
    qual: 'HD',
    cls: '',
    daysOld: null,
    stage: -1,
    upgradedDaysAgo: null,
    upgradedFrom: null
  };
  if (!dateStr) return state;

  const releaseMs = new Date(dateStr).getTime();
  if (!isFinite(releaseMs)) return state;
  state.daysOld = (now - releaseMs) / DAY_MS;

  // Which stage is the print at now? (Future-dated titles are filtered out of
  // every feed, but if one slips through it keeps the neutral default.)
  let stage = -1;
  for (let i = 0; i < timeline.length; i++) {
    if (state.daysOld >= timeline[i].fromDay) stage = i;
  }
  if (stage < 0) return state;

  const resolved = qualityAtStage(timeline, stage, title);
  state.stage = stage;
  state.qual = resolved.qual;
  state.cls = resolved.cls;

  // Walk back to the first stage that produced THIS label: that crossing is the
  // moment the print actually improved.
  let firstStageOfLabel = stage;
  while (firstStageOfLabel > 0) {
    const previous = qualityAtStage(timeline, firstStageOfLabel - 1, title);
    if (!previous || previous.qual !== resolved.qual) break;
    firstStageOfLabel--;
  }
  // Only a real print counts as an upgrade. Three cases are filtered here: a
  // better cam rip (CAM → TS → HDTS), a series merely leaving its first week
  // (NEW → HD), and crossing the last stage without meeting the 4K bar, which
  // walks back to the FHD stage and so is no upgrade at all.
  if (firstStageOfLabel > 0 && timeline[firstStageOfLabel].isRealPrint) {
    state.upgradedDaysAgo = state.daysOld - timeline[firstStageOfLabel].fromDay;
    const previousLabel = qualityAtStage(timeline, firstStageOfLabel - 1, title);
    state.upgradedFrom = previousLabel ? previousLabel.qual : null;
  }
  return state;
}

/*  How long ago the most recent thing worth surfacing happened.
 *
 *  For most titles that is simply the release. But a film that came out in a
 *  cam print four months ago and just got its HD print — or a series whose
 *  clean full-season encode just landed — is, as far as the catalogue is
 *  concerned, new again today, so its upgrade date wins. This is what pulls it
 *  back to the top of the ALL feed.
 */
function catalogueEventAgeDays(title, nowMs, qualityState) {
  const state = qualityState || titleQualityState(title, nowMs);
  if (state.daysOld == null) return Infinity;
  if (state.upgradedDaysAgo != null && state.upgradedDaysAgo < state.daysOld) {
    return Math.max(0, state.upgradedDaysAgo);
  }
  return Math.max(0, state.daysOld);
}

/*  ══════════════════════════════════════════════════════════════════════
 *  REAL PRINT QUALITY — DERIVED FROM TMDB RELEASE TYPES
 *  ══════════════════════════════════════════════════════════════════════
 *  The timeline above is a guess: it counts days from `release_date` and assumes
 *  the print ladder moved on schedule. That is wrong in both directions and
 *  visibly so — a Netflix original is a real HD stream on day one but the
 *  timeline calls it a CAM, while a festival darling with a nine-month
 *  theatrical tail gets promoted to FHD while it is still theatre-only.
 *
 *  NOTE ON "FETCH IT FROM IMDb": IMDb does not publish print quality. Neither
 *  does any other public catalogue — CAM/TS/FHD/4K are release-scene labels, not
 *  metadata anyone licenses. What IS real, published data is WHEN each kind of
 *  release happened, and that determines which print can physically exist:
 *
 *    /movie/{id}/release_dates -> type 3 Theatrical  cinema only, so cam rips
 *                                 type 4 Digital     a real web print exists
 *                                 type 5 Physical    Blu-ray / UHD master exists
 *
 *  So the badge is now driven by dates TMDB actually publishes rather than by
 *  arithmetic on a single date. When a title has no release rows at all (common
 *  for TV, and for thinly-catalogued regional films) the timeline still answers,
 *  so nothing regresses — see fetchRealQualityState().
 */
/*  Release type -> the window it opens.
 *
 *  TMDB's numbering: 1 Premiere, 2 Theatrical (limited), 3 Theatrical,
 *  4 Digital, 5 Physical, 6 TV. Type 1 is deliberately absent — a festival
 *  screening months ahead of release is not a print anyone can watch.
 *
 *  A lookup table rather than a switch on named constants: property names
 *  survive minification, and this file is measured against a parse-weight
 *  budget (asset-perf-check.js). */
const RELEASE_TYPE_WINDOW = {
  2: 'theatrical',  // limited theatrical — cam rips do come from these
  3: 'theatrical',
  4: 'digital',     // streaming or digital purchase
  5: 'physical',    // Blu-ray / 4K UHD disc
  6: 'tv'
};

/*  The 4K bar, shared with MOVIE_QUALITY_TIMELINE's conditional stage: a disc
 *  existing does not mean a UHD disc exists, and small titles only ever get a
 *  1080p Blu-ray. Same numbers as the timeline so the two paths cannot disagree
 *  about the same film. */
const UHD_MIN_RATING = 7.0;
const UHD_MIN_POPULARITY = 50;

/*  How long after a digital drop the clean/settled encodes appear. Day one is a
 *  rushed WEB-DL (HD); by the end of the month the good 1080p print is out. */
const DIGITAL_SETTLE_DAYS = 30;

/*  Every print label follows the same class convention already used by
 *  .card-quality and .top10-quality, so the class is derived rather than carried
 *  as a second literal at each return site. */
function printQuality(qual) {
  return { qual: qual, cls: 'qual-' + qual.toLowerCase() };
}

/**
 * Earliest date per release kind, across every region TMDB lists.
 *
 * Earliest-anywhere rather than a preferred region on purpose: a print leaks
 * from wherever it drops first, so an Indian viewer can have a US web print
 * weeks before the local digital date.
 *
 * @param {object} payload  /movie/{id}/release_dates response
 * @returns {{theatrical:?number, digital:?number, physical:?number, tv:?number}}
 *          epoch ms, or null when TMDB lists nothing of that kind
 */
function releaseWindowsFrom(payload) {
  const out = { theatrical: null, digital: null, physical: null, tv: null };
  const regions = (payload && payload.results) || [];
  for (let i = 0; i < regions.length; i++) {
    const rows = (regions[i] && regions[i].release_dates) || [];
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      const key = row && RELEASE_TYPE_WINDOW[row.type];
      if (!key || !row.release_date) continue;
      const ms = new Date(row.release_date).getTime();
      if (!isFinite(ms)) continue;
      if (out[key] == null || ms < out[key]) out[key] = ms;
    }
  }
  return out;
}

/**
 * Best print that can exist today, given what has actually been released.
 *
 * Ordered best-source-first, because the highest release stage that has already
 * happened decides the ceiling. Returns null when no window has opened yet —
 * i.e. TMDB knows nothing usable and the caller should keep the timeline guess.
 *
 * @returns {?{qual:string, cls:string}}
 */
function qualityFromReleaseWindows(title, windows, nowMs) {
  const now = nowMs || Date.now();
  const big = (title.vote_average || 0) >= UHD_MIN_RATING
    && (title.popularity || 0) >= UHD_MIN_POPULARITY;

  // Disc master is out: the best print this title will ever have.
  if (windows.physical != null && windows.physical <= now) {
    return printQuality(big ? '4K' : 'FHD');
  }

  // Streaming / digital purchase is live, so a real web print exists regardless
  // of how recently the film was in cinemas.
  if (windows.digital != null && windows.digital <= now) {
    return printQuality((now - windows.digital) / DAY_MS >= DIGITAL_SETTLE_DAYS ? 'FHD' : 'HD');
  }

  // Aired on TV but never got a digital date — an HD broadcast rip is the best around.
  if (windows.tv != null && windows.tv <= now) return printQuality('HD');

  /*  Cinema only. This is the branch the timeline gets most wrong, and the one
   *  real data helps most: a KNOWN future digital date is positive confirmation
   *  that no legitimate print is out yet, however long the theatrical run has
   *  been. The cam ladder is the only thing that can improve here. */
  if (windows.theatrical != null && windows.theatrical <= now) {
    const since = (now - windows.theatrical) / DAY_MS;
    return printQuality(since < 21 ? 'CAM' : since < 45 ? 'TS' : 'HDTS');
  }

  return null;
}

/*  One in-flight promise per title id. Keyed by id rather than by object so the
 *  same film appearing in the carousel and in a rail cannot fetch twice; tmdb()
 *  then adds its own memory + 12 h localStorage layer on top, so a repeat visit
 *  resolves without a request at all. */
const _mzQualityFetches = new Map();

/**
 * The timeline state for a title, with `qual`/`cls` corrected by real TMDB
 * release-type data when TMDB has any.
 *
 * Never rejects and never returns a partial state: on any failure the caller
 * gets exactly the timeline state it would have computed itself, so a badge can
 * only ever get more accurate, never disappear.
 *
 * @param {object} title  a TMDB movie/tv object
 * @returns {Promise<object>} same shape as titleQualityState()
 */
function fetchRealQualityState(title) {
  const base = title._qualityState || titleQualityState(title);

  // Release types are a movie-only endpoint on TMDB; /tv has no equivalent, so
  // series and anime keep TV_QUALITY_TIMELINE.
  if (!title.id || mediaTypeOf(title) !== 'movie') return Promise.resolve(base);

  const key = 'q' + title.id;
  if (_mzQualityFetches.has(key)) return _mzQualityFetches.get(key);

  const pending = (async () => {
    let real = null;
    try {
      const payload = await tmdb('/movie/' + title.id + '/release_dates');
      real = qualityFromReleaseWindows(title, releaseWindowsFrom(payload), Date.now());
    } catch (e) {
      // tmdb() already reports what is worth reporting; an unusable print badge
      // is not an error worth surfacing twice.
    }
    if (!real) return base;
    const out = Object.assign({}, base);
    out.qual = real.qual;
    out.cls = real.cls;
    return out;
  })();

  _mzQualityFetches.set(key, pending);
  return pending;
}

/*  FRESHNESS TIERS — how the ALL feed is ordered.
 *
 *  Sorting purely by a composite score buries a brand-new release under
 *  years-old blockbusters with 8.5 ratings, which is why the feed never looked
 *  "latest first". Sorting purely by date does the opposite and fills the top
 *  with obscure titles nobody searched for.
 *
 *  So: bucket by how fresh the title is (release OR print upgrade), then use
 *  the existing composite score to order within the bucket. Latest content
 *  always sits on top, and the biggest title among equally fresh ones leads.
 */
/*  Tier boundaries in days. The top bucket is deliberately a whole week rather
 *  than a day or two: at day granularity a no-name film released yesterday
 *  would outrank a blockbuster from five days ago, which is not what any large
 *  catalogue does. Within a week everything is "new", and the composite score
 *  decides who leads — so the week's biggest new release sits first, with the
 *  prints that just upgraded sitting right beside it. */
const FRESH_TIER_DAYS = [7, 14, 30, 60, 120];

/*  Relevance gate. TMDB lists thousands of tiny releases every week; without
 *  this a no-name title with 2 votes would outrank a major release just for
 *  being a day newer. Anything below the bar skips the tiers and is ordered by
 *  score alone at the bottom. Seasonal anime made this matter: dozens of them
 *  cross a print stage on the same day with almost no votes behind them. */
const FRESH_TIER_MIN_POPULARITY = 20;
const FRESH_TIER_MIN_VOTES = 20;

/*  INDUSTRY-SCALE RELEVANCE FLOOR — MOVIES ONLY.
 *
 *  TMDB popularity and vote counts are not comparable across industries. A
 *  Hindi, Tamil or Telugu release that the whole country is searching for in its
 *  first week still carries a fraction of the votes an English blockbuster
 *  collects in its opening weekend. Judged by the same 20/20 bar, almost every
 *  regional new release failed the gate, dropped to the "remaining movies" group
 *  and never appeared among the latest releases — which is why the top of the ALL
 *  feed looked Hollywood-only even in a week when two Bollywood films had just
 *  come out.
 *
 *  The list is the three industries this site actually has tabs for: Bollywood,
 *  South (Tamil) and Tollywood (Telugu). It briefly included Malayalam, Kannada,
 *  Bengali, Marathi, Punjabi, Gujarati, Odia and Assamese as well, and that was
 *  wrong in practice: those industries release a long tail of titles with almost
 *  no audience signal, so single-digit-popularity films reached the top of the
 *  feed next to real releases. They still reach the feed — the Indian windows
 *  fetch them — they just do not jump the queue any more.
 *
 *  The floor is also higher than it first was (12/8, not 6/4). Real releases pass
 *  it comfortably: measured on the live feed, Batwara 1947 (24), Awarapan 2 (23),
 *  DC (29), Jana Nayagan (32), Vishwanath & Sons (70). The titles it now stops
 *  are the ones nobody searched for: Ohh My Dog (3), Tera Yaar Hoon Main (2).
 *
 *  Deliberately scoped to the three tabbed industries. It applies to MOVIES and
 *  WEB SERIES alike, but never to anime.
 *
 *  The series half was added later, and for the same measured reason the movie
 *  half exists. Judged by the 20/20 bar, a Hindi original that had just dropped
 *  on JioHotstar or Netflix India almost never reached the fresh-series group: it
 *  fell to the stale fallback while an English premiere with fifty times the vote
 *  count took group 2. On the Web Series tab and on every platform tab that read
 *  as "this site only carries Hollywood shows", which is wrong for a catalogue
 *  whose audience is half Indian.
 *
 *  Anime is excluded on purpose — it keeps the 20/20 bar. Seasonal anime crosses
 *  a print stage in dozens at a time with almost no votes behind it, which is the
 *  exact case the original floor was written to stop, and anime is Japanese so it
 *  would not match these languages anyway.
 */
const REGIONAL_INDUSTRY_LANGUAGES = ['hi', 'ta', 'te'];
const REGIONAL_FRESH_MIN_POPULARITY = 12;
const REGIONAL_FRESH_MIN_VOTES = 8;

/** The popularity/vote bar a title must clear to be treated as a relevant fresh
 *  release. Movies and web series from the tabbed industries get the smaller
 *  bar; everything else, and all anime whatever its language, keeps the original
 *  one. Still a bar, not an open door: a Hindi title with single-digit
 *  popularity and no votes fails it exactly as before. */
function freshTierFloors(title) {
  const lang = title.original_language || 'en';
  if (REGIONAL_INDUSTRY_LANGUAGES.indexOf(lang) !== -1 && !isAnimeContent(title)) {
    return { popularity: REGIONAL_FRESH_MIN_POPULARITY, votes: REGIONAL_FRESH_MIN_VOTES };
  }
  return { popularity: FRESH_TIER_MIN_POPULARITY, votes: FRESH_TIER_MIN_VOTES };
}

/*  How long a card keeps its "NEW HD / NEW FHD / NEW 4K" ribbon after the print
 *  improved. Roughly matches how long the top freshness tiers keep it lifted. */
const QUALITY_UPGRADE_BADGE_DAYS = 21;

function freshnessTier(title, eventAgeDays) {
  const floors = freshTierFloors(title);
  const relevant = (title.popularity || 0) >= floors.popularity
    || (title.vote_count || 0) >= floors.votes;
  if (!relevant || !isFinite(eventAgeDays)) return FRESH_TIER_DAYS.length;
  for (let i = 0; i < FRESH_TIER_DAYS.length; i++) {
    if (eventAgeDays <= FRESH_TIER_DAYS[i]) return i;
  }
  return FRESH_TIER_DAYS.length;
}

/*  STRICT ALL-FEED PRIORITY.
 *
 *  Freshness is deliberately evaluated inside these groups, never across them:
 *    0 — relevant movies released inside the latest-release window
 *    1 — relevant movies with a recent real quality upgrade
 *    2 — trending/latest streaming web series
 *    3 — trending/latest anime
 *    4 — every other movie
 *    5 — remaining series/anime fallback
 *
 *  Groups 2 and 3 used to sit BELOW every movie, including the hundreds of
 *  catalogue films that are now group 4. Technically the web series and anime
 *  were "in the feed"; in practice a user had to scroll past ~150 cards to reach
 *  one, so the section looked like it had none. They now sit directly after the
 *  two fresh movie groups: movies still lead, and what just dropped on Netflix /
 *  Prime / JioHotstar is actually reachable. Anime keeps its own group below web
 *  series, so it is present without taking the front row.
 *
 *  This still guarantees that an even fresher TV premiere cannot jump above a
 *  latest movie release or a movie whose HD/FHD/4K print just landed. The
 *  relevance gate still keeps obscure one-vote titles out of every fresh group. */
function allFeedPriorityGroup(title, qualityState, freshTier) {
  const state = qualityState || titleQualityState(title);
  const tier = freshTier == null
    ? freshnessTier(title, catalogueEventAgeDays(title, Date.now(), state))
    : freshTier;
  const hasFreshRelevance = tier < FRESH_TIER_DAYS.length;

  if (mediaTypeOf(title) === 'movie') {
    if (hasFreshRelevance && state.daysOld != null && state.daysOld <= LATEST_WINDOW_DAYS) {
      return 0;
    }
    if (hasFreshRelevance && state.upgradedDaysAgo != null
        && state.upgradedDaysAgo < state.daysOld) {
      return 1;
    }
    return 4;
  }

  if (!hasFreshRelevance) return 5;
  return isAnimeContent(title) ? 3 : 2;
}

/** Annotates a pool in place with ranking fields, then sorts by the strict
 *  ALL-feed group first. Freshness and composite relevance only decide order
 *  among titles in the same group. */
function rankByFreshness(pool, nowMs) {
  const now = nowMs || Date.now();
  pool.forEach(m => {
    const state = titleQualityState(m, now);
    m._qualityState = state;
    m._eventAgeDays = catalogueEventAgeDays(m, now, state);
    m._freshTier = freshnessTier(m, m._eventAgeDays);
    m._priorityGroup = allFeedPriorityGroup(m, state, m._freshTier);
    m._rankScore = calculateMovieScore(m);
  });
  return pool.sort((a, b) =>
    (a._priorityGroup - b._priorityGroup)
    || (a._freshTier - b._freshTier)
    || (b._rankScore - a._rankScore)
    || (a._eventAgeDays - b._eventAgeDays));
}

/** Limits same-language runs without allowing an item to cross a strict
 *  priority-group boundary. rankByFreshness() must run before this helper. */
function diversifyByLanguageWithinPriority(pool) {
  const output = [];
  let start = 0;

  while (start < pool.length) {
    const group = pool[start]._priorityGroup;
    let end = start + 1;
    while (end < pool.length && pool[end]._priorityGroup === group) end++;

    const groupOutput = [];
    const skipped = [];
    for (let i = start; i < end; i++) {
      const item = pool[i];
      const lang = item.original_language || 'en';
      const lastThree = groupOutput.slice(-3);
      if (lastThree.length >= 3
          && lastThree.every(x => (x.original_language || 'en') === lang)) {
        skipped.push(item);
      } else {
        groupOutput.push(item);
      }
    }
    output.push(...groupOutput, ...skipped);
    start = end;
  }

  return output;
}

/*  ── TYPE INTERLEAVE (the shape a large catalogue actually ships) ──
 *
 *  Priority groups alone produce blocks: thirty fresh films, thirty print
 *  upgrades, then the web series. Measured on the live feed that put the first
 *  series at card 60 and the first anime at card 95 — present, but far past where
 *  anyone scrolls, so the surface looked like a movies-only feed.
 *
 *  No large catalogue ships blocks. They rank inside each content type and then
 *  fill a repeating slot pattern, so every type is represented on the first
 *  screen while the strongest type still leads. That is what this does, and it is
 *  the only ordering step that is allowed to cross a group boundary.
 *
 *  The pattern below is one screen's worth of cards, and it encodes the product
 *  order directly: movies first, then web series, then anime.
 *
 *  Movies take three quarters of it and the whole top of it — the feed is still a
 *  movie feed, and the two fresh movie groups still open it. A web series lands at
 *  slot 5 and another at 9; anime waits until slot 11, so at least two web series
 *  are always ahead of the first anime. Nothing is blocked off into a section: the
 *  pattern repeats for as long as the pool lasts, so someone scrolling sees a mix
 *  the whole way down instead of a page of films, then a page of series, then a
 *  page of anime.
 *
 *  Every lane is already sorted by rankByFreshness, so taking from the front of a
 *  lane always takes its best remaining title. A lane that runs dry never leaves
 *  a hole: the slot falls through to whatever is left, movies first.
 */
const FEED_SLOT_PATTERN = ['movie', 'movie', 'movie', 'movie', 'series',
  'movie', 'movie', 'movie', 'series', 'movie', 'anime', 'movie'];

function feedLaneOf(title) {
  if (mediaTypeOf(title) === 'movie') return 'movie';
  return isAnimeContent(title) ? 'anime' : 'series';
}

/*  ── FIRST-SCREEN INDUSTRY REPRESENTATION ──
 *
 *  Ranking alone hands the top of the feed to whoever wins on global popularity,
 *  and that is always Hollywood plus whatever foreign title happens to be
 *  trending. Measured on the live feed: the first four cards were three English
 *  films and one Tamil, with Bollywood at 10 and 11 and Telugu nowhere in the
 *  first sixteen. For a catalogue whose audience comes for all four industries,
 *  that reads as "this site is Hollywood".
 *
 *  So the first movie slots are guaranteed, one per industry: the freshest
 *  relevant release from Hollywood, Bollywood, Tamil and Telugu. This is the
 *  standard first-screen diversity pass — Netflix's rows do the same thing with
 *  regions — and it is deliberately narrow:
 *
 *    • an industry's slot is filled from group 0 (a genuinely new release) and,
 *      only if it has none this week, from group 1 (a film whose HD/FHD/4K print
 *      just landed). Both are new arrivals as far as the catalogue is concerned,
 *      which is the promise this section makes. Measured case: on a week with no
 *      new Telugu release, the alternative to group 1 was Telugu's first title
 *      appearing at card 60.
 *    • a group-1 promotion must still be recent enough to WEAR its ribbon —
 *      within QUALITY_UPGRADE_BADGE_DAYS of the upgrade. Without that rule the
 *      front row could show a four-month-old film with no badge and no
 *      explanation, which reads as a broken "latest" feed. Measured: it promoted
 *      a 135-day-old Telugu title whose print had long since stopped being news.
 *    • nothing older is ever eligible. If an industry has neither, it simply gets
 *      no slot; padding the front row with a year-old film would make the section
 *      lie about what it is.
 *    • the promoted titles keep their own relative ranking, so the biggest of
 *      them still leads the feed.
 *    • everything after them is untouched, in exact rank order.
 *
 *  Malayalam, Kannada and the rest are not on this list — they reach the feed on
 *  merit through the normal ranking, which is what stops single-digit-popularity
 *  titles from taking a guaranteed front-row seat.
 *
 *  ── THE SERIES LANE GETS THE SAME TREATMENT ──
 *  Originally this pass only ran on movies, which left a hole: on the Web Series
 *  tab there are no movies at all, so the pass did nothing and the grid was
 *  ordered purely by score — and an English premiere carries an order of
 *  magnitude more popularity and votes than a Hindi one, so the tab opened
 *  Hollywood-only. Platform tabs had the same problem for the same reason.
 *
 *  So the pass now runs once per lane: one guaranteed slot per industry among the
 *  movies, and one per industry among the web series. Same rules, same narrowness
 *  — a promoted series must be in the fresh web-series group (2), so nothing stale
 *  is padded in. Anime keeps its own lane and is not promoted by industry; it is
 *  Japanese by definition, so there is no industry mix to balance.
 */
const FEED_FIRST_SCREEN_INDUSTRIES = ['en', 'hi', 'ta', 'te'];
const FEED_PROMOTABLE_GROUPS = [0, 1];          // movie lane: latest release, then fresh print
const FEED_SERIES_PROMOTABLE_GROUPS = [2];      // series lane: fresh streaming web series

/*  ── THE CATALOGUE FALLBACK, AND WHY IT IS OPT-IN ──
 *
 *  Everything above only promotes titles that are genuinely NEW. On the ALL feed
 *  that is right: it is a "what just arrived" surface, and padding its front row
 *  with a two-year-old film would make it lie about what it is.
 *
 *  A category or platform tab makes a different promise. "Web Series", "Action"
 *  or "Netflix" promise the best of that category, not only this week's arrivals,
 *  and most of a provider library is back catalogue by definition. Measured with
 *  fresh-only promotion: the Web Series first screen came out 7 Korean / 5
 *  English with no Hindi at all, and MX Player's first screen had no Indian title
 *  even though its pool held 11 Hindi, 3 Telugu and 2 Tamil ones — the Indian
 *  shows were all catalogue, so nothing could claim a slot for them.
 *
 *  So those surfaces may fall back to an industry's strongest CATALOGUE title
 *  when it has no fresh one. The fresh promotions still come first, so this never
 *  costs a new release its position — the fallback lands just behind them, still
 *  on the first screen. */
const FEED_CATALOGUE_MOVIE_GROUPS = [4];
const FEED_CATALOGUE_SERIES_GROUPS = [5];

/** True when a title is new enough to defend a guaranteed front-row slot, or —
 *  for the catalogue groups — strong enough to represent its industry. */
function promotableToFirstScreen(item, group) {
  if (item._priorityGroup !== group) return false;

  if (mediaTypeOf(item) !== 'movie') {
    // Series lane. Anime has its own lane and no industry mix to balance.
    if (isAnimeContent(item)) return false;
    if (group === 2) return true;
    return group === 5 && industryRepresentative(item);
  }

  if (group === 0) return true;
  if (group === 1) {
    /*  A promoted print upgrade must still be recent enough to WEAR its ribbon,
     *  or the front row shows an old film with no badge and no explanation. */
    const state = item._qualityState || titleQualityState(item);
    return state.upgradedDaysAgo != null && state.upgradedDaysAgo <= QUALITY_UPGRADE_BADGE_DAYS;
  }
  return group === 4 && industryRepresentative(item);
}

/** A catalogue title may only claim an industry slot if somebody actually
 *  watches it. The pool is already ranked, so the first match per industry is
 *  that industry's strongest title — this only guards the case where an
 *  industry's entire presence in the pool is no-name filler. */
function industryRepresentative(item) {
  return (item.vote_count || 0) >= REGIONAL_FRESH_MIN_VOTES
    || (item.popularity || 0) >= REGIONAL_FRESH_MIN_POPULARITY;
}

function promoteFreshIndustryMix(pool, allowCatalogue) {
  const freshChosen = [];
  const catalogueChosen = [];
  const takenIndexes = new Set();

  /*  One pass per lane. `inLane` keeps the movie pass from stealing the slot the
   *  series pass is about to fill, and vice versa — without it a tab holding both
   *  would hand all four industry slots to whichever lane ranked higher. */
  const claimSlots = (groups, inLane, sink) => {
    FEED_FIRST_SCREEN_INDUSTRIES.forEach((lang) => {
      for (const group of groups) {
        let found = -1;
        for (let i = 0; i < pool.length; i++) {
          const item = pool[i];
          if (takenIndexes.has(i)) continue;
          if (!inLane(item)) continue;
          if ((item.original_language || 'en') !== lang) continue;
          if (!promotableToFirstScreen(item, group)) continue;
          found = i;
          break;                                          // pool is ranked: first is best
        }
        if (found !== -1) { takenIndexes.add(found); sink.push(found); break; }
      }
    });
  };

  const isMovie = (m) => mediaTypeOf(m) === 'movie';
  const isSeries = (m) => mediaTypeOf(m) !== 'movie';

  claimSlots(FEED_PROMOTABLE_GROUPS, isMovie, freshChosen);
  claimSlots(FEED_SERIES_PROMOTABLE_GROUPS, isSeries, freshChosen);

  if (allowCatalogue) {
    /*  Only industries that did not already win a fresh slot are considered:
     *  claimSlots skips a language once one of its titles is taken, because the
     *  fresh pass breaks out of the group loop on success. An industry with a
     *  fresh title therefore never also gets a catalogue slot. */
    claimSlots(FEED_CATALOGUE_MOVIE_GROUPS, isMovie, catalogueChosen);
    claimSlots(FEED_CATALOGUE_SERIES_GROUPS, isSeries, catalogueChosen);
  }

  if (freshChosen.length + catalogueChosen.length < 2) return pool.slice();

  /*  Fresh promotions lead, catalogue representatives follow, and rank order is
   *  preserved inside each set — so the strongest new arrival still opens the
   *  surface and the fallback sits just behind it rather than above it. */
  freshChosen.sort((a, b) => a - b);
  catalogueChosen.sort((a, b) => a - b);
  return freshChosen.concat(catalogueChosen).map((i) => pool[i])
    .concat(pool.filter((_, i) => !takenIndexes.has(i)));
}

function interleaveFeedByType(pool, allowCatalogueIndustrySlots) {
  /*  The industry mix is applied first and kept whatever happens next: if the tv
   *  queries failed and this pool is movies only, the early return below must
   *  still hand back the balanced order, not the raw one. */
  const promoted = promoteFreshIndustryMix(pool, allowCatalogueIndustrySlots);

  const lanes = { movie: [], series: [], anime: [] };
  promoted.forEach((item) => { lanes[feedLaneOf(item)].push(item); });

  // Nothing to interleave — one type only, so the ranked order already is the feed.
  const activeLanes = ['movie', 'series', 'anime'].filter((lane) => lanes[lane].length > 0);
  if (activeLanes.length < 2) return promoted;

  const output = [];
  const total = promoted.length;
  let slot = 0;
  while (output.length < total) {
    const wanted = FEED_SLOT_PATTERN[slot % FEED_SLOT_PATTERN.length];
    slot++;
    // Preference order: the slot's own lane, then movies, then whatever is left.
    const order = [wanted, 'movie', 'series', 'anime'];
    for (const lane of order) {
      if (lanes[lane].length) { output.push(lanes[lane].shift()); break; }
    }
  }
  return output;
}

/*  ── OTT TABS USE THE ALL-FEED PRIORITY ────────────────────────────────────
 *
 *  fetchOttMovies() ranks by PLATFORM relevance: verified-trending on this
 *  service, popularity, votes, plus a freshness bonus. That answers "what is
 *  big on Netflix", which is the right signal for deciding what to keep and
 *  what to verify, but it is not the order the rest of the site presents a
 *  catalogue in.
 *
 *  So the platform tabs finish with exactly the ALL feed's ordering: newest
 *  relevant releases first, then recent print upgrades, then trending series
 *  and anime, then the back catalogue — language-balanced within a group and
 *  type-interleaved at the end.
 *
 *  ── how the head of the grid is chosen ──
 *  The requirement is that a platform's POPULAR, TRENDING and NEW titles all sit
 *  at the top, so the tiebreak inside a group is a blend rather than a hierarchy.
 *
 *  A strict recency key was tried first and was wrong in the other direction: it
 *  bucketed by year ahead of relevance, which let an obscure new release outrank a
 *  title the platform is actually known for. A pure _ottScore was wrong too —
 *  measured against the live API, SonyLIV, MX Player and Crunchyroll put
 *  everything in the back priority groups (allFeedPriorityGroup needs a release
 *  inside LATEST_WINDOW_DAYS and freshnessTier needs a popularity/vote floor), so
 *  the only remaining key was popularity and a 1997 title ranked above a 2022 one.
 *
 *  So: group and tier still decide first, then _ottScore + a recency premium.
 *  _ottScore already carries the platform's own signals — popularity, vote weight,
 *  and a 'trend'/'latest' boost from the query that surfaced the title. The
 *  premium adds up to ~3200 for something released today, decaying to zero over
 *  about five years. That is deliberately smaller than the 'trend' tag boost
 *  (6000), so a genuine hit is never buried by a newer nobody, while between two
 *  comparably relevant titles the newer one wins.
 *
 *  ── the premium is GATED, and it has to be ──
 *  Without a gate this was measurably wrong. On MX Player the top card became
 *  "正义必胜" (2026-09-03, popularity 1, ZERO votes) while Bleach (popularity 145,
 *  2261 votes) sat at position 23. A brand-new title was collecting _ottScore's own
 *  freshness bonus (+2500 under 30 days) AND this premium (+3200) — 5700 points for
 *  being new, with no evidence anyone wants to watch it.
 *
 *  So the premium requires a minimum sign of life first, the same idea as
 *  freshnessTier's relevance floor. A new release with an audience gets promoted;
 *  a new release nobody has rated stays where its own score puts it.
 */
const OTT_RECENCY_MIN_VOTES = 12;
const OTT_RECENCY_MIN_POPULARITY = 8;

function ottRankLikeAllFeed(items) {
  if (!Array.isArray(items) || items.length < 2) return items || [];
  const now = Date.now();
  rankByFreshness(items);
  items.forEach(m => {
    const d = m.release_date || m.first_air_date;
    const t = d ? new Date(d).getTime() : NaN;
    const relevant = (m.vote_count || 0) >= OTT_RECENCY_MIN_VOTES
      || (m.popularity || 0) >= OTT_RECENCY_MIN_POPULARITY;
    // Undated or unproven titles get no premium rather than jumping the queue.
    const yearsOld = isNaN(t) ? 99 : Math.max(0, (now - t) / 31557600000);
    const premium = relevant ? Math.max(0, 3200 - (yearsOld * 620)) : 0;
    /*  Same catalogue era weight the category tabs use, applied to the platform's
     *  own relevance score. A provider library is mostly back catalogue, so
     *  without it the decades-old titles with the biggest lifetime vote counts
     *  opened the grid. It scales _ottScore rather than replacing it, so a
     *  'trend'-tagged hit (TAG_BOOST 6000) still outranks a newer nobody. */
    m._eraFactor = catalogueEraFactor(m, now);
    m._ottFinal = ((m._ottScore || 0) * m._eraFactor) + premium;
  });
  items.sort((a, b) =>
    (a._priorityGroup - b._priorityGroup)
    || (a._freshTier - b._freshTier)
    || (b._ottFinal - a._ottFinal)
    || (a._eventAgeDays - b._eventAgeDays));
  /*  `true` = a platform library may fall back to an industry's best CATALOGUE
   *  title for its first-screen slot. A provider catalogue is mostly back
   *  catalogue, so fresh-only promotion left MX Player's first screen with no
   *  Indian title at all while its pool held 11 Hindi, 3 Telugu and 2 Tamil. */
  return interleaveFeedByType(diversifyByLanguageWithinPriority(items), true);
}

/* ══════════════════════════════════════════════════════════════════════════
   UNIVERSAL CATEGORY RANKING  (every industry / genre / language tab)
   ──────────────────────────────────────────────────────────────────────────
   The problem this fixes:

     Only the ALL feed and the platform tabs were ranked. Every other tab —
     Bollywood, Hollywood, Tollywood, Web Series, K-Drama, and each genre in the
     Category dropdown — took TMDB's raw `sort_by=popularity.desc` order and
     rendered it verbatim (loadMovies' generic branch just concatenated the two
     pages). TMDB popularity is a lifetime-ish signal, so the Bollywood tab
     opened on Dilwale Dulhania Le Jayenge (1995) and Kunwari Dulhan (1991)
     while that week's actual releases sat pages down.

   The order every tab now produces, which is what the ALL feed already did:

     1. newest releases           (priority group 0)
     2. prints that just upgraded (group 1) — the "original quality landed"
        moment, typically 1-2 months after a theatrical release
     3. trending / in-demand      (composite score: popularity + velocity)
     4. popular catalogue         (composite score, era-weighted)

   Groups 0-3 come from allFeedPriorityGroup(); steps 3 and 4 fall out of
   calculateMovieScore(), which already blends rating, popularity, trending
   velocity and vote confidence.

   ── why an era weight was still needed ──
   FRESH_TIER_DAYS tops out at 120, so EVERY movie older than four months
   collapses into the same last tier and is then ordered by score alone. Score
   has no age term past 180 days, so a 1990s classic with a huge lifetime vote
   count outranked a strong film from last year — the exact complaint. The era
   weight below is a smooth decay applied to the catalogue score so that recency
   matters again among old titles, without hard-cutting anything: a well-loved
   classic still beats a modern flop, it just no longer opens the tab.

   Deliberately NOT applied to:
     • the ALL feed        — already ranked, and its ordering is the reference
     • 'toprated'          — an all-time rating chart; demoting old films by age
                             would defeat the entire purpose of the tab
     • series/anime dates  — a long-running show's first_air_date says nothing
                             about how current it is, so the decay is movies-only
   ══════════════════════════════════════════════════════════════════════════ */

/*  Titles that must never reach the grid, whatever endpoint returned them.
 *  Kept tiny and explicit: this is an editorial removal list, not a filter.
 *  Matched by TMDB id first (exact, survives title edits upstream) with a
 *  normalised-title fallback for the re-uploads TMDB sometimes carries under a
 *  new id. */
const FEED_BLOCKED_IDS = new Set([
  1081422   // Kunwari Dulhan (1991) — mis-sold softcore print, no votes, kept surfacing on Bollywood
]);
const FEED_BLOCKED_TITLES = new Set([
  'kunwari dulhan',
  'kuwari dulhan'
]);

/** True when a title is on the editorial removal list. */
function isFeedBlocked(item) {
  if (!item) return true;
  if (FEED_BLOCKED_IDS.has(item.id)) return true;
  const name = (item.title || item.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return name !== '' && FEED_BLOCKED_TITLES.has(name);
}

/*  Years of grace before the catalogue decay starts biting, and how hard it
 *  bites afterwards. 0.06 per year past the grace period means a film loses
 *  roughly a quarter of its score by year 7 and about two thirds by year 30 —
 *  enough to clear the 1990s off the first screen, gentle enough that Dangal
 *  (2016) still leads a forgettable 2019 release. */
const CATALOGUE_ERA_GRACE_YEARS = 2;
const CATALOGUE_ERA_DECAY = 0.06;
const YEAR_MS = 31557600000;

/** Multiplier in (0, 1] expressing how current a catalogue MOVIE is. Series,
 *  anime and undated titles are returned unweighted (1) — see the note above. */
function catalogueEraFactor(item, nowMs) {
  if (mediaTypeOf(item) !== 'movie') return 1;
  const d = item.release_date;
  const t = d ? new Date(d).getTime() : NaN;
  if (isNaN(t)) return 1;
  const years = Math.max(0, (nowMs - t) / YEAR_MS);
  const over = Math.max(0, years - CATALOGUE_ERA_GRACE_YEARS);
  return 1 / (1 + (over * CATALOGUE_ERA_DECAY));
}

/** The ALL-feed ranking, applied to a single category's pool.
 *
 *  Same contract as ottRankLikeAllFeed(): annotate with rankByFreshness(), add
 *  one surface-specific tiebreak, then diversify by language and interleave by
 *  type. Runs entirely on an already-fetched pool, so it costs no requests.
 */
function rankCategoryFeed(items, nowMs) {
  if (!Array.isArray(items) || items.length < 2) return items || [];
  const now = nowMs || Date.now();
  rankByFreshness(items, now);
  items.forEach(m => {
    m._eraFactor = catalogueEraFactor(m, now);
    m._catScore = (m._rankScore || 0) * m._eraFactor;
  });
  items.sort((a, b) =>
    (a._priorityGroup - b._priorityGroup)
    || (a._freshTier - b._freshTier)
    || (b._catScore - a._catScore)
    || (a._eventAgeDays - b._eventAgeDays));
  /*  `true` = this surface may give an industry's best CATALOGUE title a
   *  first-screen slot when it has no fresh one. A category tab promises the best
   *  of that category rather than only this week's arrivals, so — unlike the ALL
   *  feed — that is not a lie. Fresh titles still lead; see promoteFreshIndustryMix. */
  return interleaveFeedByType(diversifyByLanguageWithinPriority(items), true);
}

/*  Categories that own their ordering, so loadMovies() must NOT re-rank them:
 *
 *    all       ranks itself inline (it is the reference rankCategoryFeed copies)
 *    toprated  is an all-time rating chart — weighting it towards recent films
 *              would defeat the only thing the tab exists to show
 *    kids      fetchCartoonMovies() pins famous cartoons and orders its own pool
 *    anime     fetchAnimeMovies() ranks per anime mode (airing, latest, classics)
 *
 *  Platform tabs are excluded at the call site instead, via OTT[cat]:
 *  ottRankLikeAllFeed() has already run on that pool. */
const FEED_SELF_RANKED = new Set(['all', 'toprated', 'kids', 'anime']);

/** IST calendar date, optionally shifted back by N days — used to build the
 *  release-window queries. TMDB expects plain YYYY-MM-DD. */
function istDateStr(daysAgo) {
  const ms = Date.now() + (5.5 * 60 * 60 * 1000) - ((daysAgo || 0) * DAY_MS);
  return new Date(ms).toISOString().split('T')[0];
}

/*  The two release windows the ALL feed fetches on purpose. Both are built here
 *  so loadMovies() and prefetchMoviesPage() send byte-identical params — tmdb()
 *  caches by full URL, so a single reordered key would cost a cache miss and a
 *  duplicate request. */
const LATEST_WINDOW_DAYS = 35;

/** Most popular titles released in the last few weeks: guarantees the pool
 *  always contains genuinely new releases. */
function latestWindowQuery(page) {
  return {
    sort_by: 'popularity.desc',
    'primary_release_date.gte': istDateStr(LATEST_WINDOW_DAYS),
    'primary_release_date.lte': istDateStr(0),
    'vote_count.gte': '5',
    page: page,
    language: 'en-US'
  };
}

/** The print-upgrade cohort: titles old enough to have just crossed the HD
 *  stage, young enough that their FHD crossing is also still ahead or recent.
 *  Window is derived from the timeline so it can never drift out of step. */
function printUpgradeWindowQuery(page) {
  const hdDay = MOVIE_QUALITY_TIMELINE[3].fromDay;   // 75  — digital / HD
  const fhdDay = MOVIE_QUALITY_TIMELINE[4].fromDay;  // 120 — FHD
  return {
    sort_by: 'popularity.desc',
    'primary_release_date.gte': istDateStr(fhdDay + 15),
    'primary_release_date.lte': istDateStr(hdDay - 2),
    'vote_count.gte': '20',
    page: page,
    language: 'en-US'
  };
}

/*  ── INDUSTRY RELEASE WINDOWS (BOLLYWOOD / SOUTH / TOLLYWOOD / REGIONAL) ──
 *
 *  latestWindowQuery() and printUpgradeWindowQuery() rank the whole world by
 *  popularity, and on that scale a Hollywood weekend always wins the first page.
 *  So a Hindi or Telugu film that released two days ago was never even fetched,
 *  and no amount of re-ranking can surface a title that is not in the pool —
 *  which is the real reason the latest-release group looked English-only.
 *
 *  These three ask the same two questions per industry instead of globally:
 *  what just released, and whose HD print just landed. Indian titles all carry
 *  origin_country IN, so one request covers Bollywood, Tollywood, Tamil,
 *  Malayalam, Kannada and the rest together; Bollywood additionally gets its own
 *  request, because on a shared popularity sort South releases regularly fill
 *  the whole first page and would push Hindi out of it.
 *
 *  No vote floor: an Indian release in its first days often has a handful of
 *  votes and real search demand. Popularity ordering plus the regional relevance
 *  floor above keeps the long tail out, and only the first page is ever read.
 *
 *  Movies only, on purpose — web series and anime keep their own windows.
 */
const INDIAN_ORIGIN_COUNTRY = 'IN';
const BOLLYWOOD_LANGUAGE = 'hi';

/** Newest releases across every Indian industry in one request. */
function latestIndianWindowQuery(page) {
  return {
    with_origin_country: INDIAN_ORIGIN_COUNTRY,
    sort_by: 'popularity.desc',
    'primary_release_date.gte': istDateStr(LATEST_WINDOW_DAYS),
    'primary_release_date.lte': istDateStr(0),
    page: page,
    language: 'en-US'
  };
}

/** Newest Bollywood releases specifically, so Hindi cannot be crowded out of
 *  the shared Indian window by a big South release week. */
function latestBollywoodWindowQuery(page) {
  return {
    with_original_language: BOLLYWOOD_LANGUAGE,
    sort_by: 'popularity.desc',
    'primary_release_date.gte': istDateStr(LATEST_WINDOW_DAYS),
    'primary_release_date.lte': istDateStr(0),
    page: page,
    language: 'en-US'
  };
}

/** The Indian half of the print-upgrade cohort: the same HD/FHD window the
 *  global query uses, so a Bollywood or South film whose HD print just landed
 *  gets pulled back to the top exactly like a Hollywood one does. */
function indianUpgradeWindowQuery(page) {
  const hdDay = MOVIE_QUALITY_TIMELINE[3].fromDay;   // 75  — digital / HD
  const fhdDay = MOVIE_QUALITY_TIMELINE[4].fromDay;  // 120 — FHD
  return {
    with_origin_country: INDIAN_ORIGIN_COUNTRY,
    sort_by: 'popularity.desc',
    'primary_release_date.gte': istDateStr(fhdDay + 15),
    'primary_release_date.lte': istDateStr(hdDay - 2),
    page: page,
    language: 'en-US'
  };
}

/*  The Indian catalogue — what fills the "remaining movies" part of the feed
 *  once the fresh groups are exhausted.
 *
 *  This replaced three separate undated popularity queries (hi, ta, te). They
 *  cost three requests, were siloed to those three languages — Malayalam,
 *  Kannada and Bengali could never appear at all — and, because TMDB popularity
 *  is dominated by whatever released this week, most of their first page was the
 *  same fresh titles the release windows above already fetch.
 *
 *  One request, every Indian industry, and the date ceiling gives it the job the
 *  release windows deliberately do NOT do: everything OLDER than the latest
 *  window. Nothing overlaps, so nothing is deduped away, and the tail of the
 *  feed keeps its regional depth on a third of the request budget.
 */
function indianCatalogueQuery(page) {
  return {
    with_origin_country: INDIAN_ORIGIN_COUNTRY,
    sort_by: 'popularity.desc',
    'primary_release_date.lte': istDateStr(LATEST_WINDOW_DAYS),
    page: page,
    language: 'en-US'
  };
}

/*  ── WEB SERIES + ANIME WINDOWS ──
 *  The ALL feed used to fetch movies only, so no series or anime could ever
 *  reach it however fresh they were. These three cover both halves of the
 *  ranking: what just dropped, and what just got a better print.
 *
 *  Series queries are restricted to streaming networks and exclude linear TV
 *  channels, the same guard the Web Series category uses — without it the feed
 *  fills up with daily soaps that air a new episode every evening.
 *
 *  All three carry a vote floor. Sorting by popularity alone still let through
 *  a long tail of no-name seasonal anime, and because a whole anime season
 *  premieres in the same week, they all cross a print stage on the same day and
 *  arrive as a block. The floor keeps the series and anime that reach the feed
 *  to the ones with actual traction — the trending ones. */
const LATEST_SERIES_WINDOW_DAYS = 45;
const LATEST_ANIME_WINDOW_DAYS = 60;
const SERIES_MIN_VOTES = '12';
const ANIME_MIN_VOTES = '15';

/** Newest streaming web series with real traction. */
function latestSeriesWindowQuery(page) {
  return {
    with_networks: STREAMING_NETWORK_IDS,
    without_networks: LINEAR_TV_EXCLUDE_IDS,
    sort_by: 'popularity.desc',
    'first_air_date.gte': istDateStr(LATEST_SERIES_WINDOW_DAYS),
    'first_air_date.lte': istDateStr(0),
    'vote_count.gte': SERIES_MIN_VOTES,
    page: page,
    language: 'en-US'
  };
}

/** Series whose clean FHD encode (day 30) or BD/4K master (day 120) has just
 *  landed — the series equivalent of the movie print-upgrade cohort. */
function seriesUpgradeWindowQuery(page) {
  const fhdDay = TV_QUALITY_TIMELINE[2].fromDay;  // 30  — clean full-season encode
  const uhdDay = TV_QUALITY_TIMELINE[3].fromDay;  // 120 — BD / 4K master
  return {
    with_networks: STREAMING_NETWORK_IDS,
    without_networks: LINEAR_TV_EXCLUDE_IDS,
    sort_by: 'popularity.desc',
    'first_air_date.gte': istDateStr(uhdDay + 15),
    'first_air_date.lte': istDateStr(fhdDay - 2),
    'vote_count.gte': SERIES_MIN_VOTES,
    page: page,
    language: 'en-US'
  };
}

/** Newest anime seasons. Anime does not sit on the streaming-network list, so
 *  it is matched by genre + original language instead. */
function latestAnimeWindowQuery(page) {
  return {
    with_genres: '16',
    with_original_language: 'ja',
    sort_by: 'popularity.desc',
    'first_air_date.gte': istDateStr(LATEST_ANIME_WINDOW_DAYS),
    'first_air_date.lte': istDateStr(0),
    'vote_count.gte': ANIME_MIN_VOTES,
    page: page,
    language: 'en-US'
  };
}

/*  ══════════════════════════════════════════════════════════════════════
 *  UPCOMING RELEASE SOURCES  (one per industry)
 *  ══════════════════════════════════════════════════════════════════════
 *  The Upcoming section used to ask TMDB two questions: English releases and
 *  Hindi releases. In practice it rendered as a Hollywood-only section, for the
 *  same reason the ALL feed's latest group did (see latestIndianWindowQuery):
 *  `sort_by=popularity.desc` on a shared pool is always won by Hollywood, and
 *  the two Hindi requests carried `region: IN`, which drops any Indian title
 *  whose IN release date TMDB does not carry yet — i.e. exactly the not-yet-
 *  released titles this section exists for.
 *
 *  So each industry now gets asked its own question, the same shape the home
 *  feed uses: Hollywood, all Indian industries together (one request covers
 *  Bollywood, Tollywood, Tamil, Malayalam, Kannada, Bengali…), then Bollywood,
 *  Tollywood and Tamil individually so a big release week in one cannot push
 *  the others off their shared first page, plus anime and Korean.
 *
 *  Hollywood and the shared Indian window take two TMDB pages each because they
 *  are by far the deepest catalogues; the dedicated per-language sources take
 *  one, which keeps the whole section at nine requests — and tmdbBatch() folds
 *  those into a single round-trip.
 *
 *  Built here, in one place, because loadUpcoming() and prefetchUpcomingPage()
 *  must send byte-identical params: tmdb() caches by full URL, so one reordered
 *  key would turn every prefetch into a wasted request.
 */
const UPCOMING_WINDOW_MONTHS = 3;

/** The release window: yesterday (so a title releasing today is never missed to
 *  a timezone) through three months out. Kept short on purpose — a wider window
 *  lets far-future blockbusters win the popularity sort and crowd genuine
 *  next-few-weeks releases out of page one. */
function upcomingWindowDates() {
  const from = new Date();
  from.setDate(from.getDate() - 1);
  const gte = from.toISOString().split('T')[0];
  from.setMonth(from.getMonth() + UPCOMING_WINDOW_MONTHS);
  return { gte: gte, lte: from.toISOString().split('T')[0] };
}

function upcomingQuery(page, extra) {
  const w = upcomingWindowDates();
  return Object.assign({
    language: 'en-US',
    page: String(page),
    sort_by: 'popularity.desc',
    'primary_release_date.gte': w.gte,
    'primary_release_date.lte': w.lte
  }, extra || {});
}

const UPCOMING_SOURCES = [
  { key: 'hollywood', deep: true,  params: { with_original_language: 'en' } },
  { key: 'indian',    deep: true,  params: { with_origin_country: INDIAN_ORIGIN_COUNTRY } },
  { key: 'bollywood', deep: false, params: { with_original_language: BOLLYWOOD_LANGUAGE } },
  { key: 'tollywood', deep: false, params: { with_original_language: 'te' } },
  { key: 'tamil',     deep: false, params: { with_original_language: 'ta' } },
  { key: 'anime',     deep: false, params: { with_genres: '16', with_original_language: 'ja' } },
  { key: 'korean',    deep: false, params: { with_original_language: 'ko' } }
];

/** The full tmdbBatch plan for one Upcoming page. */
function upcomingPagePlan(pageNum) {
  const plan = [];
  UPCOMING_SOURCES.forEach(src => {
    if (src.deep) {
      plan.push(['/discover/movie', upcomingQuery(pageNum * 2 - 1, src.params)]);
      plan.push(['/discover/movie', upcomingQuery(pageNum * 2, src.params)]);
    } else {
      plan.push(['/discover/movie', upcomingQuery(pageNum, src.params)]);
    }
  });
  return plan;
}

/*  ── INDUSTRY INTERLEAVE ──
 *  Upcoming is ordered by release date, which is the only order that makes
 *  sense for it. But date order alone does not fix the section: Hollywood
 *  releases something almost every Friday, so the twelve cards shown before
 *  "load more" could still be twelve Hollywood titles while the first Bollywood
 *  or anime release sits three weeks out, off screen.
 *
 *  So the merge stays chronological but caps how many titles one industry may
 *  place back-to-back. Every industry present in the pool reaches the first
 *  screen, and nothing is reordered by more than a few positions.
 */
const UPCOMING_MAX_RUN = 3;

const UPCOMING_INDUSTRY_BY_LANG = {
  en: 'hollywood', hi: 'bollywood', te: 'tollywood', ta: 'tamil',
  ml: 'malayalam', kn: 'kannada', mr: 'marathi', bn: 'bengali',
  pa: 'punjabi', gu: 'gujarati', ko: 'korean', zh: 'chinese', cn: 'chinese'
};

function upcomingIndustryOf(movie) {
  const lang = (movie && movie.original_language) || 'en';
  // Japanese animation is the Anime category; live-action Japanese is not.
  if (lang === 'ja') {
    return (movie.genre_ids || []).indexOf(16) !== -1 ? 'anime' : 'japanese';
  }
  return UPCOMING_INDUSTRY_BY_LANG[lang] || 'world';
}

/** Chronological merge with a per-industry run cap. `list` must already be
 *  sorted by release date ascending. */
function interleaveUpcomingByIndustry(list) {
  if (!Array.isArray(list) || list.length < 3) return Array.isArray(list) ? list.slice() : [];

  const buckets = new Map();
  const order = [];                       // first-seen industry order, so the merge is deterministic
  for (const movie of list) {
    const key = upcomingIndustryOf(movie);
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key).push(movie);
  }
  if (order.length < 2) return list.slice();

  const out = [];
  let remaining = list.length;
  let lastKey = null;
  let run = 0;
  const picked = new Map();               // industry → how many it has placed so far
  order.forEach(k => picked.set(k, 0));

  while (remaining > 0) {
    let pickKey = null;
    let pickDate = null;
    for (const key of order) {
      const queue = buckets.get(key);
      if (!queue.length) continue;
      if (key === lastKey && run >= UPCOMING_MAX_RUN) continue;   // run cap
      const date = queue[0].release_date || '9999-12-31';
      if (pickDate === null || date < pickDate) { pickDate = date; pickKey = key; continue; }
      /*  Same-day tie-break: whoever has placed fewer cards so far wins. Without
       *  this, a day with eight releases is handed to whichever industry happens
       *  to sit earliest in `order`, and on a busy Friday that alone can fill the
       *  first screen — which is the problem this function exists to solve. */
      if (date === pickDate && picked.get(key) < picked.get(pickKey)) pickKey = key;
    }
    if (pickKey === null) {
      // Everything left belongs to the industry that just hit its run cap —
      // release the cap rather than dropping the tail. remaining > 0 guarantees
      // some bucket is non-empty, so this cannot spin.
      lastKey = null;
      run = 0;
      continue;
    }
    out.push(buckets.get(pickKey).shift());
    picked.set(pickKey, picked.get(pickKey) + 1);
    remaining--;
    run = (pickKey === lastKey) ? run + 1 : 1;
    lastKey = pickKey;
  }
  return out;
}

// -- CAROUSEL (PROFESSIONAL DISCOVERY ALGORITHM)
// Netflix/Hotstar-grade weighted scoring: fetches from ALL categories and ranks by composite score
// Score = (rating_weight) + (popularity_weight) + (recency_boost) + (trending_velocity) + (vote_confidence) + (quality_upgrade_boost)

/*  Bayesian prior for the rating term: how many votes of "average" a title is
 *  assumed to carry before its own votes start to count, and what that average
 *  is. 50 votes at 6.2 keeps a 9.0 from two voters out of the top slots without
 *  punishing anything that has real traction. */
const RATING_PRIOR_VOTES = 50;
const RATING_PRIOR_MEAN = 6.2;

/*  Below this many votes the popularity/votes ratio is noise, not velocity. */
const TRENDING_MIN_VOTES = 20;

function calculateMovieScore(movie) {
  const now = Date.now();
  const releaseDate = new Date(movie.release_date || movie.first_air_date || '2020-01-01');
  const daysSinceRelease = Math.max(0, (now - releaseDate) / (1000 * 60 * 60 * 24));
  
  // 1. Rating Weight — Bayesian-shrunk, then boosted exponentially.
  // A raw 8.0 from three voters used to score exactly like an 8.0 from twenty
  // thousand, which put no-name seasonal titles above real hits the moment the
  // feed started ordering by freshness. Pulling the rating towards the catalogue
  // mean in proportion to how few votes back it is the standard fix.
  const rating = movie.vote_average || 0;
  const voteCount = movie.vote_count || 1;
  const weightedRating = ((voteCount * rating) + (RATING_PRIOR_VOTES * RATING_PRIOR_MEAN))
    / (voteCount + RATING_PRIOR_VOTES);
  const ratingScore = Math.pow(weightedRating, 1.8) * 2; // Exponential: 8.0 → 98, 7.0 → 76, 6.0 → 56
  
  // 2. Popularity Weight (TMDB popularity is 0-5000+): Normalize and cap
  const popularity = Math.min(movie.popularity || 0, 5000);
  const popularityScore = (popularity / 50) * 1.5; // Max ~150 points
  
  // 3. Recency Boost: Newer movies get significant advantage (decays over 180 days)
  let recencyBoost = 0;
  if (daysSinceRelease <= 7) recencyBoost = 80;        // This week: massive boost
  else if (daysSinceRelease <= 14) recencyBoost = 65;  // Last 2 weeks
  else if (daysSinceRelease <= 30) recencyBoost = 50;  // Last month
  else if (daysSinceRelease <= 60) recencyBoost = 35;  // Last 2 months
  else if (daysSinceRelease <= 90) recencyBoost = 20;  // Last 3 months
  else if (daysSinceRelease <= 180) recencyBoost = 10; // Last 6 months
  else recencyBoost = 0;
  
  // 4. Trending Velocity: If popularity is high relative to vote count, it's trending fast.
  // Needs enough votes to mean anything — popularity/votes explodes for titles
  // with two or three ratings and used to hand them a free 40 points.
  const trendingVelocity = voteCount >= TRENDING_MIN_VOTES
    ? Math.min((popularity / voteCount) * 5, 40)
    : 0;
  
  // 5. Vote Confidence: More votes = more reliable score (logarithmic scale)
  const voteConfidence = Math.min(Math.log10(voteCount + 1) * 8, 30);
  
  // 6. Now Playing / In Theaters bonus
  const nowPlayingBonus = (daysSinceRelease <= 45 && daysSinceRelease >= 0) ? 25 : 0;
  
  // 7. QUALITY UPGRADE BOOST (Netflix-style "Newly Available in HD/4K")
  // Jab title ka print upgrade hota hai (movie: CAM → HD → FHD → 4K; series aur
  // anime: web rip → clean FHD → BD/4K), usko wapas massive boost milta hai,
  // isse purani release dobara top par aa jaati hai. Windows timeline se aate
  // hain, hardcoded din se nahi — badge aur ranking dono ek hi table padhte hain.
  let qualityUpgradeBoost = 0;
  const upgradedDaysAgo = titleQualityState(movie, now).upgradedDaysAgo;
  if (upgradedDaysAgo != null) {
    if (upgradedDaysAgo <= 25) qualityUpgradeBoost = 70;       // print just landed — as strong as a new release
    else if (upgradedDaysAgo <= 55) qualityUpgradeBoost = 55;  // still the current print everyone is looking for
    else if (upgradedDaysAgo <= 85) qualityUpgradeBoost = 35;  // fading
  }
  // Extra visibility for high-rated titles inside the upgrade window
  // (blockbusters and flagship series).
  if (qualityUpgradeBoost > 0 && rating >= 7.0) {
    qualityUpgradeBoost += 15;
  }
  if (qualityUpgradeBoost > 0 && popularity >= 100) {
    qualityUpgradeBoost += 10;
  }
  
  return ratingScore + popularityScore + recencyBoost + trendingVelocity + voteConfidence + nowPlayingBonus + qualityUpgradeBoost;
}

let _mzCarouselAttempts = 0;
const MZ_CAROUSEL_MAX_RETRIES = 2;

/*  ══════════════════════════════════════════════════════════════════════
 *  HERO CAROUSEL — CATEGORY QUOTAS AND THE QUALITY BAR
 *  ══════════════════════════════════════════════════════════════════════
 *  The ranking itself is unchanged: calculateMovieScore() still decides who is
 *  better than whom. What is added here is WHO IS ALLOWED IN, and how many of
 *  each.
 *
 *  Two problems this fixes.
 *
 *  1. The carousel had no web series and no anime series in it, at all. Every
 *     one of its ten sources was a /movie endpoint - the "anime" source was
 *     /discover/movie with genre 16, i.e. anime FILMS - so a viewer could never
 *     see a trending show in the hero however big it was. Three /tv sources are
 *     added for that.
 *
 *  2. Slots were handed out by original_language, one guaranteed each and a flat
 *     cap of three. Language is not category: an English-language Netflix series
 *     and a Hollywood blockbuster both count as 'en', so they competed for the
 *     same allowance while Bollywood - the other half of this site's audience -
 *     was capped at the same three as Korean.
 *
 *  Quotas are stated as min/max. The mins sum to exactly the ten slots, so in
 *  the normal case every category gets precisely its share and the max never
 *  binds. The max only matters when a category cannot fill its min - TMDB
 *  returning no Tollywood release that clears the bar today - and then the best
 *  remaining titles absorb the slack instead of the carousel shipping a gap.
 */
const CAROUSEL_SLOTS = 10;

/*  ── THE FIXED TEN (Sep 2026) ──
 *
 *  The slots are now spoken for exactly, and min === max for all six named
 *  categories, so a normal day produces this line-up and nothing else:
 *
 *      4  Hollywood movies
 *      2  Bollywood movies
 *      1  Tollywood (Telugu) movie
 *      1  Hindi web series
 *      1  English web series
 *      1  Anime
 *     ──
 *     10
 *
 *  Two changes from the previous table, both deliberate.
 *
 *  1. `webseries` is SPLIT into webseries_hi and webseries_en. One bucket could
 *     not deliver one of each: the pool is score-sorted and English series carry
 *     an order of magnitude more TMDB votes than Hindi ones, so both slots went
 *     to English every time. Two buckets are two reserved seats, and each gets
 *     its own TMDB source in loadCarousel() so neither has to out-compete the
 *     other merely to exist.
 *
 *  2. Tollywood goes 2 -> 1 and Bollywood's max 3 -> 2. The second web-series
 *     seat has to come from somewhere, and this is the requested shape. max ===
 *     min also means no category can quietly take a neighbour's slot on a strong
 *     week — which is what "fixed" has to mean to be worth stating.
 *
 *  THREE LIMITS, NOT TWO. min and max behave exactly as before. `hard` is read
 *  only by the final emergency sweep, and only when the pools came back so thin
 *  that the hero would otherwise ship with visible gaps: one slide over quota is
 *  a far smaller failure than a missing slide. On a normal day it is never
 *  reached, so it cannot dilute the line-up above.
 */
const CAROUSEL_CATEGORY_QUOTA = {
  /*  max equals min for Hollywood on purpose. It owns the highest-scoring titles
   *  in the pool, so if its max were higher it would win every leftover slot the
   *  moment another category underfilled - which is how it took five here. Capped
   *  at its share, the slack flows to Bollywood, Tollywood, the web series or
   *  anime instead, which is the point of having quotas at all. */
  hollywood:       { min: 4, max: 4, hard: 5 },
  bollywood:       { min: 2, max: 2, hard: 3 },
  tollywood:       { min: 1, max: 1, hard: 2 },
  anime:           { min: 1, max: 1, hard: 2 },
  webseries_hi:    { min: 1, max: 1, hard: 2 },
  webseries_en:    { min: 1, max: 1, hard: 2 },
  /*  South, Korean, non-Hindi/English series and world carry min 0 on purpose,
   *  and it is worth being explicit about the consequence: the six mins above
   *  already sum to all ten slots, so on a normal day none of these appears in
   *  the hero at all. They are not removed though - a max of 1 keeps them as the
   *  first thing that absorbs a slot when a named category cannot fill its min,
   *  which is far better than a gap or a fifth Hollywood title. `world` catches
   *  every language none of the named categories claims. */
  south:           { min: 0, max: 1, hard: 2 },
  korean:          { min: 0, max: 1, hard: 2 },
  webseries_world: { min: 0, max: 1, hard: 2 },
  world:           { min: 0, max: 1, hard: 1 }
};

/*  THE BAR: high rating AND real demand AND traction.
 *
 *  Split by industry scale, for the reason already documented at
 *  INDUSTRY_FLOOR_LANGS: TMDB vote counts are not comparable across industries.
 *  A Telugu release the whole state is watching carries a fraction of the votes
 *  an English blockbuster collects in its opening weekend, so a single global
 *  floor does not raise quality - it just deletes every regional category from
 *  the carousel and calls the result "high rated".
 *
 *  GLOBAL covers the categories that draw worldwide vote volume (Hollywood, web
 *  series, anime). REGIONAL covers the industries that do not. Both ask for the
 *  same three things, at the scale their own audience actually produces.
 */
/*  ══════════════════════════════════════════════════════════════════════
 *  THE WINDOW: THIS CALENDAR YEAR ONLY
 *  ══════════════════════════════════════════════════════════════════════
 *  The ceiling used to be a rolling 550 days, which on any date in 2026 also
 *  admitted most of 2025 - and it showed: the Tollywood slot was filling with a
 *  March 2025 release and the series slots with shows that premiered in 2019 and
 *  1999. Every slide in the hero is now required to be a title from the CURRENT
 *  year. That is a stricter promise than "recent", and it is the one the hero
 *  makes to a visitor: everything on this screen is new.
 *
 *  WHY IT IS NOT LITERALLY `>= YYYY-01-01`. That expression is correct for 11
 *  months of the year and catastrophic in the twelfth: at 00:01 on 1 January the
 *  eligible pool is every film released in the last one minute, i.e. nothing, and
 *  the hero would degrade to its emergency passes for weeks. So the boundary is
 *  1 January of the current IST year OR 240 days ago, whichever is EARLIER.
 *
 *  Worked through, with today as the reference point:
 *    5 Sep 2026  -> Jan 1 2026 vs 8 Jan 2026  -> Jan 1 2026   (exactly this year)
 *    20 Dec 2026 -> Jan 1 2026 vs 24 Apr 2026 -> Jan 1 2026   (exactly this year)
 *    2 Jan 2027  -> Jan 1 2027 vs 7 May 2026  -> 7 May 2026   (H2 2026 allowed)
 *    5 Sep 2027  -> Jan 1 2027 vs 8 Jan 2027  -> Jan 1 2027   (exactly this year)
 *  So for roughly ten months of every year the rule IS "this year only", and in
 *  the January-to-April shoulder it widens just far enough to stay full, then
 *  tightens again on its own. Nothing to maintain and no date to come back and
 *  edit - which is the whole requirement.
 *
 *  SERIES ARE HELD TO THE SAME YEAR, with a documented fallback. The old note
 *  here argued series must never be date-gated because first_air_date is when a
 *  show STARTED - One Piece reads 1999 while airing an episode this week. That
 *  reasoning is sound and it produced One Piece and a 2019 season of The Family
 *  Man in the hero, which is not what "latest" means to anyone looking at it. So
 *  the strict pass now requires a series to have PREMIERED inside the window
 *  too, and isCarouselRecent - which still exempts series - is kept as the pass
 *  that runs only when the strict one came up short. A currently-airing older
 *  show is a much better slide than an empty one; it is simply not the first
 *  choice any more.
 */
const CAROUSEL_YEAR_WINDOW_MIN_DAYS = 240;
const CAROUSEL_INDUSTRY_MIN_VOTES = 20;
const CAROUSEL_TV_AIRED_WITHIN_DAYS = 120;

/** Earliest release / premiere date a hero slide may carry, as YYYY-MM-DD.
 *  See the note above for why this is not simply 1 January. */
function carouselWindowStartStr() {
  const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const jan1 = istNow.toISOString().slice(0, 4) + '-01-01';
  const floor = istDateStr(CAROUSEL_YEAR_WINDOW_MIN_DAYS);
  return floor < jan1 ? floor : jan1;
}

/*  Hindi series get a much wider air window than the global one, for the same
 *  reason the industry movie sources needed their own vote floor: release cadence
 *  is not comparable. The global streaming pool has something new every week, so
 *  120 days is generous there. Indian originals run on seasons that are a year or
 *  more apart - Panchayat, Paatal Lok, Mirzapur, Farzi, Kota Factory - so a
 *  120-day window returns an empty page most of the year, and the reserved Hindi
 *  slot would then be silently handed to whatever else was queued. 400 days keeps
 *  a real season in range at all times while TMDB's popularity sort still decides
 *  WHICH of them is the one trending right now, so the slot stays current. */
const CAROUSEL_TV_HI_AIRED_WITHIN_DAYS = 400;

/*  The industry sources have to be DATE-WINDOWED, or the age ceiling starves
 *  them. Each was sort_by=popularity.desc with no window, which on a shared
 *  all-time pool returns the biggest titles ever made in that language - RRR,
 *  Baahubali, Pushpa - and the ceiling then deletes every one of them. Measured:
 *  Tollywood could field exactly one eligible title, a 6.9 with eighteen votes
 *  that only got in through the representation sweep.
 *
 *  With the window applied TMDB does the work instead: page 1 becomes the most
 *  popular titles RELEASED INSIDE the ceiling, which is precisely the pool the
 *  quota wants. Same reasoning as latestIndianWindowQuery in the ALL feed.
 */
function carouselIndustryQuery(lang) {
  return {
    with_original_language: lang,
    sort_by: 'popularity.desc',
    'primary_release_date.gte': carouselWindowStartStr(),
    'primary_release_date.lte': istDateStr(0),
    /*  The vote floor belongs HERE, not only in the bar downstream. Without it
     *  page 1 was over half 2-to-6-vote entries, and those are not merely weak
     *  picks - calculateMovieScore() actively prefers them. Its rating term is
     *  Bayesian-shrunk towards 6.2 with a 50-vote prior, so a 2-vote 8.0 shrinks
     *  to 6.27 while a 69-vote 5.8 shrinks to 5.96: the title nobody has seen
     *  outranks the one everybody has. Correct shrinkage, wrong pool. Excluding
     *  them at the source is the fix; nothing downstream has to fight the score.
     *
     *  20 and not higher, and it matters more now that the window is one year
     *  rather than 550 days. Measured over 2026 to date: at a 20-vote floor Hindi
     *  fields 11 titles and Telugu 3; at 40 Hindi drops to 5 and Telugu to 1,
     *  which cannot fill a two-slot quota on a bad week. */
    'vote_count.gte': String(CAROUSEL_INDUSTRY_MIN_VOTES),
    language: 'en-US',
    page: '1'
  };
}

/** Released or premiered inside the current-year window — the strict test, and
 *  the one that decides what a normal day looks like. Applies to series as well
 *  as films: a 2026 slide means a 2026 title, not a 1999 show with a 2026
 *  episode.
 *
 *  Compared as YYYY-MM-DD strings rather than by converting to days. TMDB emits
 *  exactly that format, lexicographic order on it IS chronological order, and it
 *  sidesteps the timezone drift that day-arithmetic introduces around midnight. */
function isCarouselInYear(item) {
  const dateStr = item.release_date || item.first_air_date;
  /*  An unusable date fails. The pool filter upstream lets a dateless title
   *  through on vote_count alone, which is fine for "has it been released" but
   *  cannot answer "is it from this year" - and unverifiable is not good enough
   *  for the one slot every visitor sees. Such titles remain reachable through
   *  the last-resort pass below, so this can never empty the hero. */
  if (!dateStr) return false;
  return dateStr >= carouselWindowStartStr();
}

/** The relaxed test, used only by the passes that run when the strict one could
 *  not fill the hero: films still have to be from this year, series do not.
 *  first_air_date is when a show STARTED, so a currently-airing older series is
 *  genuinely current content even though its date is old — a worse slide than a
 *  2026 premiere, a far better one than a gap. */
function isCarouselRecent(item, nowMs) {
  if (mediaTypeOf(item) === 'tv') return true;
  return isCarouselInYear(item);
}

const CAROUSEL_BAR_GLOBAL   = { rating: 6.4, votes: 200, popularity: 25 };
/*  Regional leans on VOTES for "in demand" and keeps popularity as a token
 *  liveness floor only. Measured across every recent Telugu and Tamil release:
 *  their TMDB popularity sits at 3-15 while a Hollywood release of the same week
 *  is at 800. Asking regional titles for popularity 12 was therefore the same
 *  mistake as asking them for 200 votes - it let exactly one Telugu title
 *  through, so the representation sweep then filled the slot with an 8.0 that had
 *  TWO votes. Votes are the honest demand signal here; popularity is not
 *  comparable across industries and is only used to exclude dead catalogue rows. */
const CAROUSEL_BAR_REGIONAL = { rating: 6.0, votes: 25,  popularity: 2 };

/*  Why 6.0 and not lower. At 5.5 the bar was admitting titles that are new but
 *  simply not good - a 5.8 with 29 votes took a Bollywood slot off a 7.3 with 352
 *  votes, because calculateMovieScore()'s recency boost (up to 80 points) beats
 *  the ~18-point rating gap between them. The score is not being changed; the
 *  floor is, so that "latest" can only ever choose among titles that are also
 *  well rated.
 *
 *  6.0 was re-checked against every industry INSIDE the current-year window,
 *  which is the number that matters now that the window is a year rather than
 *  550 days. 2026 to date:
 *    Hindi    Dhurandhar 7.3/159v, Mardaani 3 7.6/44v, Border 2 7.6/35v,
 *             Kartavya 7.0/32v, Tu Yaa Main 6.4/60v, Toaster 6.0/36v -> fills 2
 *    Kannada  Toxic 7.9/68v                                          -> fills 1
 *    Telugu   Mana ShankaraVaraPrasad Garu 6.2/22v                   -> thin
 *    Anime    Chainsmoker Cat 8.6/59v, Smoking Behind the Supermarket
 *             9.0/44v, You and I Are Polar Opposites 8.7/90v         -> ample
 *  Telugu is the binding constraint and is now genuinely thin at one eligible
 *  title, which is exactly why the South Indian seat carries an editorial pin
 *  (see CAROUSEL_EDITORIAL_PINS) instead of a higher floor: raising the bar
 *  would empty that slot rather than improve it. */
/*  webseries_hi belongs on the REGIONAL side of the bar and this is not a
 *  judgement about quality. A Hindi original that the whole country is watching
 *  lands somewhere around 60-400 TMDB votes and a popularity of 8-30; the global
 *  bar asks for 200 votes AND popularity 25, which no Hindi series clears
 *  reliably. Held to the global bar the reserved Hindi slot would simply never
 *  fill. webseries_world is regional for the same reason - a Spanish or Japanese
 *  live-action series is not measured on an English scale either. webseries_en
 *  stays on the global bar, because English series are exactly the population
 *  that bar was measured against. */
/*  ANIME IS ON THE REGIONAL SIDE TOO, and this one is a measured correction
 *  rather than a preference. Held to the global 200-vote floor, the anime slot
 *  could only ever be filled by a long-running institution - One Piece 5,523
 *  votes, Bleach 2,258, Frieren 949 - because a series that premiered this year
 *  has not had time to collect 200 votes. Every 2026 anime premiere sits between
 *  27 and 90 votes, so the global bar and a current-year window are mutually
 *  exclusive: one of them had to move, and the vote floor is the one that is
 *  wrong. Ratings are not the problem at all - the 2026 cohort runs 8.0 to 9.0. */
const CAROUSEL_REGIONAL_CATEGORIES = ['bollywood', 'south', 'tollywood', 'korean',
  'anime', 'webseries_hi', 'webseries_world', 'world'];

/*  ══════════════════════════════════════════════════════════════════════
 *  EDITORIAL PIN — a default for one slot, never an override
 *  ══════════════════════════════════════════════════════════════════════
 *  A pin names one title and the slot it should occupy. It exists because the
 *  score cannot always see what a person can: Toxic is the biggest South Indian
 *  release of the year by a wide margin (7.9 from 68 votes at popularity 207,
 *  against a best available Telugu title of 6.2 from 22 votes at popularity 2),
 *  and it should hold the South/Tollywood slot right now.
 *
 *  Two properties make this safe to leave in the file unattended, which is the
 *  point - it is not a hardcoded slide that has to be remembered and removed:
 *
 *    1. IT LOSES TO ANYTHING BETTER. The pin is only placed if it is the
 *       HIGHEST-SCORING eligible title for its category in today's pool. The
 *       moment a Telugu or Kannada release outscores it, the normal sweeps place
 *       that title and the pin is silently skipped. No edit needed.
 *    2. IT CANNOT SHOW SOMETHING STALE. It goes through the same bar and the same
 *       current-year window as everything else, so when Toxic falls out of the
 *       window at the end of the year the pin stops matching and disappears.
 *
 *  `category` is stated explicitly and deliberately differs from what
 *  carouselCategoryOf() would return. Toxic is Kannada, so the language rules
 *  would file it under `south` - a min-0 bucket that only picks up slack, i.e.
 *  it would usually not appear at all. Pinning it to `tollywood` puts it in the
 *  reserved South Indian seat, which is where a viewer expects to find it.
 */
const CAROUSEL_EDITORIAL_PINS = [
  { id: 1213243, category: 'tollywood', title: 'Toxic: A Fairy Tale for Grown-ups' }
];

/*  ══════════════════════════════════════════════════════════════════════
 *  CAROUSEL BACKDROP OVERRIDES — swap one title's hero image, nothing else
 *  ══════════════════════════════════════════════════════════════════════
 *  Keyed by TMDB movie id -> a backdrop file_path from that title's own
 *  /movie/{id}/images response. The carousel normally paints m.backdrop_path
 *  (TMDB's default backdrop); when an id is listed here the slide uses this
 *  path instead. Everything else about the slide — title, rating, genres,
 *  quality chip, ordering, the editorial pin above — is untouched.
 *
 *  Toxic's default backdrop is the white studio cut-out (tBRSSfgqOAq…); this
 *  points it at the cinematic burning-figure still instead, which also leaves
 *  the left third clear for the hero title/buttons.
 */
const CAROUSEL_BACKDROP_OVERRIDES = {
  1213243: '/oOJ8g4DIb8hfLas43eNnO79DIy3.jpg'
};

/** Which quota bucket a title belongs to. Checked in specificity order: anime
 *  before web series (an anime series is both), and media type before language
 *  (an English series is web series, not Hollywood).
 *
 *  MEDIA TYPE IS CHECKED BEFORE LANGUAGE AND STAYS THAT WAY. It is what keeps
 *  the movie buckets pure: without it a Hindi series would be filed as
 *  `bollywood` and could take one of the two Bollywood movie slots, so the hero
 *  would show two shows and one film while the table still claimed otherwise.
 *  Every series therefore lands in a webseries_* bucket, or in `korean` where the
 *  K-drama allowance already lives — never in bollywood, tollywood or hollywood.
 */
function carouselCategoryOf(item) {
  const lang = item.original_language || 'en';
  const isAnimation = (item.genre_ids || []).indexOf(16) !== -1;
  if (isAnimation && lang === 'ja') return 'anime';
  if (mediaTypeOf(item) === 'tv') {
    if (lang === 'hi') return 'webseries_hi';
    if (lang === 'en') return 'webseries_en';
    /*  Korean series join the Korean allowance rather than the series overflow:
     *  that bucket exists to represent Korea in the hero, and for Korea the thing
     *  people actually watch is the drama, not the film. */
    if (lang === 'ko') return 'korean';
    return 'webseries_world';
  }
  if (lang === 'hi') return 'bollywood';
  if (lang === 'te') return 'tollywood';
  if (lang === 'ta' || lang === 'ml' || lang === 'kn') return 'south';
  if (lang === 'ko') return 'korean';
  if (lang === 'en') return 'hollywood';
  return 'world';
}

/** Does this title clear the bar for its own category? */
function clearsCarouselBar(item, category) {
  const bar = CAROUSEL_REGIONAL_CATEGORIES.indexOf(category) !== -1
    ? CAROUSEL_BAR_REGIONAL : CAROUSEL_BAR_GLOBAL;
  return (item.vote_average || 0) >= bar.rating
    && (item.vote_count || 0) >= bar.votes
    && (item.popularity || 0) >= bar.popularity;
}

/**
 * Fills the carousel from a score-sorted pool, honouring the category quotas.
 *
 * Three passes, each a deliberate relaxation of the one before, so the carousel
 * degrades in quality rather than in size:
 *
 *   1. every category takes up to its MIN, from titles that clear the bar;
 *   2. any category still short of its min takes the best it has, bar or not -
 *      a category being represented matters more than it being represented by
 *      something with 200 votes;
 *   3. leftover slots go to the best remaining title of any category that is
 *      still under its MAX.
 *
 * @param {object[]} pool     score-sorted, best first
 * @param {object[]} out      accumulator (mutated)
 * @param {Set} usedIds       ids already placed (mutated)
 * @param {object} taken      per-category counts (mutated)
 * @returns {object[]} out
 */
function fillCarouselByQuota(pool, out, usedIds, taken) {
  const place = (item, category) => {
    item._carouselCategory = category;
    out.push(item);
    usedIds.add(item.id);
    taken[category] = (taken[category] || 0) + 1;
  };

  /*  Pins run before every sweep, and each one is resolved by walking the
   *  score-sorted pool from the top. The first title that is eligible for the
   *  pinned category decides the question: if it IS the pin, the pin is placed;
   *  if it is anything else, the pin has been outscored and nothing happens -
   *  sweep 1 will place that better title a moment later. This is what makes the
   *  pin self-retiring rather than a slide someone has to come back and delete. */
  const placePins = () => {
    for (const pin of CAROUSEL_EDITORIAL_PINS) {
      const quota = CAROUSEL_CATEGORY_QUOTA[pin.category];
      if (!quota || (taken[pin.category] || 0) >= quota.min) continue;
      for (const item of pool) {
        if (usedIds.has(item.id)) continue;
        const isPin = item.id === pin.id;
        const category = isPin ? pin.category : carouselCategoryOf(item);
        if (category !== pin.category) continue;
        if (!clearsCarouselBar(item, pin.category)) continue;
        if (isPin) place(item, pin.category);
        break;
      }
    }
  };

  const sweep = (requireBar, limitKey) => {
    for (const item of pool) {
      if (out.length >= CAROUSEL_SLOTS) return;
      if (usedIds.has(item.id)) continue;
      const category = carouselCategoryOf(item);
      const quota = CAROUSEL_CATEGORY_QUOTA[category];
      if (!quota) continue;
      /*  A missing limit must mean "no room", not "no limit". Read straight into
       *  the comparison, an absent key compares against undefined, which is false
       *  for every count - so one typo'd or forgotten limit would let a single
       *  category take the entire hero. */
      const limit = quota[limitKey];
      if (typeof limit !== 'number') continue;
      if ((taken[category] || 0) >= limit) continue;
      if (requireBar && !clearsCarouselBar(item, category)) continue;
      place(item, category);
    }
  };

  placePins();           // 0. the editorial default, if nothing beats it
  sweep(true, 'min');    // 1. quality picks, one category share each
  sweep(false, 'min');   // 2. representation over polish
  sweep(false, 'max');   // 3. best of the rest
  /*  4. Gaps are worse than one slide over quota. Only reachable when passes 1-3
   *  together could not find ten eligible titles, i.e. several sources failed or
   *  returned nothing inside their windows. See `hard` in the quota table. */
  if (out.length < CAROUSEL_SLOTS) sweep(false, 'hard');
  return out;
}
async function loadCarousel() {
  const _mzCarouselFailureMark = _mzFetchFailureCount;
  // FETCH FROM ALL MAJOR CATEGORIES IN ONE ROUND-TRIP (Professional-grade discovery)
  // tmdbBatch returns exactly what Promise.allSettled returned here before, and
  // falls back to it if the edge endpoint is unavailable — so the indexed reads
  // below and sourceNames stay valid either way.
  const results = await tmdbBatch([
    ['/trending/movie/week', { language: 'en-US', page: '1' }],
    /*  /trending/movie/day was here and is deliberately gone. Adding the three
     *  /tv sources took the first screen to exactly 30 TMDB requests against a
     *  MZ_RATE_LIMIT of 30 - measured, not guessed - and at the limit the next
     *  request anyone adds anywhere gets parked for a full 10s window. Day-
     *  trending is the cheapest thing to give up: /trending/movie/week already
     *  supplies the trending pool, and the only thing lost is the TRENDING TODAY
     *  badge variant. Its badge branch below is kept, so restoring this line is
     *  the only change needed to bring it back. */    ['/movie/popular', { language: 'en-US', page: '1' }],
    /*  /movie/top_rated used to sit here and was removed to pay for the Kannada
     *  source below - the first screen is at exactly MZ_RATE_LIMIT requests, so
     *  one had to go. It is the right one: top_rated is an ALL-TIME ranking, and
     *  under a current-year window every single row it returns now fails the date
     *  gate. It was contributing nothing to the line-up, only to the emergency
     *  pass that fires when the hero would otherwise be half empty - and
     *  /trending, /popular and /now_playing already cover that between them. */
    ['/movie/now_playing', { language: 'en-US', page: '1' }],
    ['/discover/movie', carouselIndustryQuery('hi')],
    ['/discover/movie', carouselIndustryQuery('ta')],
    ['/discover/movie', carouselIndustryQuery('te')],
    /*  Kannada. Added for the pinned South Indian slot: Toxic is a Kannada
     *  production, and with no kn source in the plan it reached the pool only if
     *  it happened to surface in global /trending or /popular - which for a South
     *  Indian release is luck, not a guarantee. This asks the question directly.
     *  It doubles as the Kannada industry's own feed into the `south` bucket. */
    ['/discover/movie', carouselIndustryQuery('kn')],
    ['/discover/movie', Object.assign(carouselIndustryQuery('ja'), { with_genres: '16' })],
    /*  carouselIndustryQuery('ko') used to sit here and was removed to pay for the
     *  Hindi series source below, because the first screen is at exactly
     *  MZ_RATE_LIMIT requests and the next one added anywhere gets parked for a
     *  full 10s window. Korean was the right thing to give up: it holds min 0 in
     *  the quota table, so it can only ever win a slot another category failed to
     *  fill, and Korea's own headline titles are dramas rather than films - those
     *  still arrive through /trending/tv/week and are filed under `korean` by
     *  carouselCategoryOf(). Restoring this line means dropping another source. */
    /*  The four /tv sources. Everything above this line is a /movie endpoint,
     *  which is why no web series or anime series could ever reach the hero.
     *
     *  trending/tv/week is the demand signal - whatever the world is actually
     *  watching this week, in any language. The three /discover/tv calls are the
     *  quality signal, asking TMDB itself to pre-filter on rating and vote count
     *  so the bar is applied at the source rather than after the fact: one over
     *  English streaming originals, one over Hindi streaming originals, one over
     *  anime, which is not on the network list and has to be matched by genre +
     *  language. All three exclude the linear channels, or the pool fills with
     *  daily soaps that air a new episode every evening.
     *
     *  ONE SOURCE PER RESERVED SLOT is the point of the English/Hindi split. A
     *  single popularity-sorted query over all languages returns page after page
     *  of English titles, so webseries_hi would sit empty and its slot would leak
     *  to the overflow buckets. Asking TMDB the Hindi question separately is the
     *  only way the reserved seat is actually fillable. */
    ['/trending/tv/week', { language: 'en-US', page: '1' }],
    ['/discover/tv', {
      with_original_language: 'en',
      with_networks: STREAMING_NETWORK_IDS,
      without_networks: LINEAR_TV_EXCLUDE_IDS,
      sort_by: 'popularity.desc',
      'vote_count.gte': String(CAROUSEL_BAR_GLOBAL.votes),
      'vote_average.gte': String(CAROUSEL_BAR_GLOBAL.rating),
      /*  first_air_date, not air_date, and this is the one query where that is
       *  clearly right. Asked with air_date.gte the page came back as Reacher,
       *  Silo, Lioness, Ted Lasso, Criminal Minds - all airing, none of them new -
       *  with exactly ONE 2026 premiere on it, so the reserved English slot had a
       *  single candidate and a bad week would empty it. Asked this way the page is
       *  2026 premieres only and there are fourteen of them, Off Campus 8.9/833v
       *  and Dutton Ranch 9.2/562v among them. The ongoing-series fallback is not
       *  lost - /trending/tv/week supplies those, and by definition supplies the
       *  ones people are actually watching. */
      'first_air_date.gte': carouselWindowStartStr(),
      language: 'en-US', page: '1'
    }],
    /*  Hindi originals. Rating and vote floors are the REGIONAL ones - see
     *  CAROUSEL_REGIONAL_CATEGORIES for why a Hindi series cannot be asked for 200
     *  votes - and the window is CAROUSEL_TV_HI_AIRED_WITHIN_DAYS rather than the
     *  global 120 days, for the season-cadence reason documented there. */
    ['/discover/tv', {
      with_original_language: 'hi',
      with_networks: STREAMING_NETWORK_IDS,
      without_networks: LINEAR_TV_EXCLUDE_IDS,
      sort_by: 'popularity.desc',
      'vote_count.gte': String(CAROUSEL_BAR_REGIONAL.votes),
      'vote_average.gte': String(CAROUSEL_BAR_REGIONAL.rating),
      'air_date.gte': istDateStr(CAROUSEL_TV_HI_AIRED_WITHIN_DAYS),
      language: 'en-US', page: '1'
    }],
    /*  Anime. REGIONAL floors, for the reason set out at
     *  CAROUSEL_REGIONAL_CATEGORIES: at 200 votes this query returns Doraemon,
     *  Bleach and One Piece and not one series that premiered this year. air_date
     *  rather than first_air_date is kept here on purpose - it returns both the
     *  2026 premieres the strict pass wants and the long-runners the fallback pass
     *  needs, so one request serves both tiers. */
    ['/discover/tv', {
      with_genres: '16',
      with_original_language: 'ja',
      sort_by: 'popularity.desc',
      'vote_count.gte': String(CAROUSEL_BAR_REGIONAL.votes),
      'vote_average.gte': String(CAROUSEL_BAR_REGIONAL.rating),
      'air_date.gte': istDateStr(CAROUSEL_TV_AIRED_WITHIN_DAYS),
      language: 'en-US', page: '1'
    }]
  ]);

  const sourceNames = ['trending_week','popular','now_playing','bollywood','south','tollywood','kannada','anime','trending_tv','webseries_en','webseries_hi','anime_tv'];

  /*  /discover/tv results carry no media_type at all, and /trending/tv/week only
   *  sometimes does. Without a tag mediaTypeOf() would fall back to guessing from
   *  the presence of 	itle, and carouselCategoryOf() would file a series under
   *  Hollywood. Tag at the source instead, where the answer is known. */
  const CAROUSEL_TV_SOURCES = ['trending_tv', 'webseries_en', 'webseries_hi', 'anime_tv'];

  // Combine all results into a master pool with source tags (safely handle null/undefined)
  const masterPool = [];
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value && r.value.results) {
      const isTvSource = CAROUSEL_TV_SOURCES.indexOf(sourceNames[idx]) !== -1;
      r.value.results.forEach(m => {
        if (!m) return;
        m._source = sourceNames[idx];
        if (isTvSource) m.media_type = 'tv';
        masterPool.push(m);
      });
    }
  });

  /*  Empty pool. This used to just call buildCarousel() and give up silently, so
   *  a network blip on load left #hero as a bare gradient for the rest of the
   *  session — and #hero holds the LCP element, so that is the most visible part
   *  of the page staying broken.
   *
   *  Bounded retry, and only when the failure counter says the network actually
   *  failed. An honest empty pool (TMDB up, nothing passed the date filters) is
   *  still terminal, because retrying it would return the same nothing.
   */
  if (masterPool.length === 0) {
    const networkFailed = _mzFetchFailureCount > _mzCarouselFailureMark ||
      navigator.onLine === false;

    if (networkFailed && _mzCarouselAttempts < MZ_CAROUSEL_MAX_RETRIES) {
      _mzCarouselAttempts++;
      if (navigator.onLine === false) {
        _mzCarouselAttempts--;             // do not spend attempts on a dead link
        _mzWhenOnline(() => loadCarousel());
      } else {
        setTimeout(loadCarousel, MZ_FEED_RETRY_BASE_MS * Math.pow(2, _mzCarouselAttempts - 1));
      }
      return;
    }
    buildCarousel();
    return;
  }
  _mzCarouselAttempts = 0;

  // Deduplicate: Keep best version (highest popularity) of each movie
  const movieMap = new Map();
  masterPool.forEach(m => {
    if (!m || !m.id) return;
    const existing = movieMap.get(m.id);
    if (!existing || (m.popularity || 0) > (existing.popularity || 0)) {
      movieMap.set(m.id, m);
    }
  });

  const realToday = new Date(Date.now() + (5.5 * 60 * 60 * 1000)).toISOString().split('T')[0]; // IST date
  
  // Two pools: 
  // 1. candidates = movies with BOTH backdrop + poster (for premium carousel display)
  // 2. allReleased = movies with at least poster (for forced representation fallback)
  const allReleased = Array.from(movieMap.values()).filter(m => {
    if (!m.poster_path) return false;
    const rDate = m.release_date || m.first_air_date;
    if (!rDate) return (m.vote_count > 50); // No date = only allow if clearly already released
    if (rDate > realToday) return false;
    return true;
  });
  
  let candidates = allReleased.filter(m => m.backdrop_path);

  // Score ALL released movies
  allReleased.forEach(m => { m._score = calculateMovieScore(m); });
  
  // Sort by composite score (highest first)
  candidates.sort((a, b) => b._score - a._score);
  allReleased.sort((a, b) => b._score - a._score);

  /*  CATEGORY-QUOTA SELECTION
   *  Replaces the old "one guaranteed slot per original_language, then max three
   *  each" pass. See CAROUSEL_CATEGORY_QUOTA for why language was the wrong key
   *  and what the quotas are. calculateMovieScore() still does all the ranking -
   *  both pools below are already sorted by it - so this only decides who is
   *  eligible for which slot, never who is better than whom.
   *
   *  Backdrop pool first, poster-only pool second, exactly as before: the hero
   *  paints a 16:9 backdrop and a 2:3 poster stretched into that box looks
   *  broken, so a title carrying one is always preferred. The second call only
   *  reaches slots the first could not fill. */
  const diverseCarousel = [];
  const usedIds = new Set();
  const takenByCategory = {};

  /*  Recency is applied to the POOLS, not inside the sweeps. If it were a sweep
   *  condition, the third (max) sweep would relax it again and the classics would
   *  walk straight back in - which is the whole thing being fixed. */
  const mzNow = Date.now();
  /*  Four ordered attempts, and the ORDER is the feature. The first two ask for
   *  titles from this year and nothing else - that is what a normal day uses, and
   *  it is what makes every slide a current release. Only if those cannot fill
   *  ten slots do the last two relax the year gate for SERIES alone
   *  (isCarouselRecent exempts them), which is how an ongoing show gets in when
   *  no premiere this year cleared the bar. Films are never relaxed here; the only
   *  path by which an older film can appear is the emergency pass below. */
  const inYearCandidates = candidates.filter(isCarouselInYear);
  const inYearReleased = allReleased.filter(isCarouselInYear);
  const recentCandidates = candidates.filter(m => isCarouselRecent(m, mzNow));
  const recentReleased = allReleased.filter(m => isCarouselRecent(m, mzNow));

  fillCarouselByQuota(inYearCandidates, diverseCarousel, usedIds, takenByCategory);
  if (diverseCarousel.length < CAROUSEL_SLOTS) {
    fillCarouselByQuota(inYearReleased, diverseCarousel, usedIds, takenByCategory);
  }
  if (diverseCarousel.length < CAROUSEL_SLOTS) {
    fillCarouselByQuota(recentCandidates, diverseCarousel, usedIds, takenByCategory);
  }
  if (diverseCarousel.length < CAROUSEL_SLOTS) {
    fillCarouselByQuota(recentReleased, diverseCarousel, usedIds, takenByCategory);
  }

  /*  Last resort, and only if the recent pools could not even half-fill the hero:
   *  drop the age ceiling rather than ship a carousel with three slides. A stale
   *  hero is a worse failure than an old one, and this is the only path by which
   *  an over-age title can still appear. */
  if (diverseCarousel.length < Math.ceil(CAROUSEL_SLOTS / 2)) {
    fillCarouselByQuota(candidates, diverseCarousel, usedIds, takenByCategory);
    fillCarouselByQuota(allReleased, diverseCarousel, usedIds, takenByCategory);
  }
  // If diversity filter was too strict, just take top scored movies
  if (diverseCarousel.length < 4) {
    const fallback = candidates.filter(m => !usedIds.has(m.id)).slice(0, 10 - diverseCarousel.length);
    diverseCarousel.push(...fallback);
  }
  
  // Assign dynamic carousel badges based on category + context
  diverseCarousel.forEach(m => {
    /*  first_air_date matters here: a series carries no release_date, so every
     *  web series and anime series was being dated from the '2020-01-01' default
     *  and could never earn the JUST RELEASED ribbon however new it was. */
    const daysSince = (Date.now() - new Date(m.release_date || m.first_air_date || '2020-01-01')) / (1000 * 60 * 60 * 24);
    const lang = m.original_language || 'en';
    const category = m._carouselCategory || carouselCategoryOf(m);
    
    // Priority: Freshness > Category-specific > Generic
    if (daysSince <= 7) {
      m._badge = '🔥 JUST RELEASED';
    } else if (daysSince <= 30 && m._source === 'now_playing') {
      m._badge = '🎬 NOW IN THEATERS';
    } else if (category === 'anime') {
      m._badge = '\u{1F38C} ANIME TRENDING';
    } else if (category === 'webseries_hi') {
      /*  Named explicitly rather than left to the generic series branch: a Hindi
       *  original sharing the hero with an English one is the whole point of the
       *  two reserved seats, and an identical WEB SERIES ribbon on both hides
       *  that from the viewer. */
      m._badge = m.vote_average >= 8.0 ? '\u{1F3C6} TOP HINDI SERIES'
        : '\u{1F1EE}\u{1F1F3} HINDI WEB SERIES';
    } else if (category === 'webseries_en' || category === 'webseries_world') {
      /*  Series never reached this list before, so there was no branch for them
       *  and they would have fallen through to POPULAR NOW. */
      m._badge = m.vote_average >= 8.0 ? '\u{1F3C6} TOP WEB SERIES'
        : m._source === 'trending_tv' ? '\u{1F4FA} TRENDING SERIES'
        : '\u{1F4FA} WEB SERIES';
    } else if (lang === 'hi' && m.vote_average >= 7.0) {
      m._badge = '🎬 BOLLYWOOD HIT';
    } else if (lang === 'hi') {
      m._badge = '�� BOLLYWOOD TRENDING';
    } else if (category === 'tollywood') {
      /*  Category, not language. A pinned title is placed into the bucket the pin
       *  names rather than the one its language implies, so reading `lang` here
       *  gave Toxic - Kannada, in the Tollywood slot - a generic POPULAR NOW
       *  ribbon while every other slide was labelled with its industry. */
      m._badge = '🔥 TOLLYWOOD HIT';
    } else if (category === 'south' || lang === 'ta') {
      m._badge = '🔥 SOUTH BLOCKBUSTER';
    } else if (lang === 'ko') {
      m._badge = '🇰🇷 KOREAN TRENDING';
    } else if (lang === 'ja') {
      m._badge = '🎌 ANIME TRENDING';
    } else if (m._source === 'trending_day') {
      m._badge = '📈 TRENDING TODAY';
    } else if (m._source === 'trending_week') {
      m._badge = '🔥 TRENDING NOW';
    } else if (m.vote_average >= 8.0) {
      m._badge = '⭐ CRITICALLY ACCLAIMED';
    } else {
      m._badge = '🔥 POPULAR NOW';
    }
  });

  carouselMovies = diverseCarousel.slice(0, 10);
  if (carouselMovies.length === 0) carouselMovies = candidates.slice(0, 6); // Ultimate fallback
  // Align slide 0 with the backdrop <head> already preloaded, so the LCP image
  // is served from cache instead of being requested after the bundle parses.
  carouselMovies = pinPreloadedHero(carouselMovies, candidates);
  console.log('[MovieZone] carousel:', carouselMovies.map((m, n) =>
    `${n + 1}. ${m.title || m.name} [${m._carouselCategory || carouselCategoryOf(m)}] `
    + `${(m.vote_average || 0).toFixed(1)}/${m.vote_count || 0}v pop${Math.round(m.popularity || 0)}`).join('  |  '));
  buildCarousel();
}

/*  ══════════════════════════════════════════════════════════════════════
 *  TOP 10 TRENDING — premium numbered rail below the hero carousel
 *  ══════════════════════════════════════════════════════════════════════
 *  Pulls the globally most-watched movies straight from TMDB's own trending
 *  feed (/trending/movie/{day|week}) so the ranking is authentic, not a
 *  local re-score. Renders 10 numbered cards; the giant gold digit behind
 *  each poster is pure CSS (.top10-rank). Clicking a card opens the same
 *  detail modal every other card on the page uses (openModal).
 */
let _mzTop10Loading = false;
let _mzTop10Data = null;       // resolved ranking for the CURRENT window, kept for openModal lookups
let _mzTop10Cache = { day: null, week: null };  // per-window session cache
let _mzTop10Loads = { day: false, week: false }; // per-window in-flight guard
/*  IST calendar day the cache above was filled on.
 *
 *  "Today" must mean the real today, and this site is left open for hours — a
 *  tab opened Saturday evening would otherwise still be showing Saturday's
 *  /trending/movie/day list on Sunday afternoon, because the session cache never
 *  expired. Both windows are keyed on the date and dropped the moment it
 *  changes, so the rail re-fetches from TMDB on the first interaction after IST
 *  midnight and stays in step with TMDB's own daily/weekly rebuild. */
let _mzTop10CacheDay = null;
let _mzTop10Window = 'day';    // active window: 'day' (Today, the default) or 'week' (This Week)
const TOP10_COUNT = 10;

/*  ── THE TOGGLE IS HIDDEN ON MOBILE, SO THE WINDOW MUST BE PINNED THERE ──
 *
 *  moviezone.css hides `.top10-head .top10-toggle` under @media (max-width: 768px)
 *  — a phone has no room for the pill, and the rail is meant to be "Today" there.
 *  The default already is 'day', but that alone was not enough:
 *
 *    • a visitor on a tablet/desktop picks "This Week", then rotates to portrait
 *      or narrows the window past 768px. The pill disappears, _mzTop10Window is
 *      still 'week', and the rail keeps serving weekly trending with no visible
 *      control to change it back.
 *    • the heading still reads "This Week" while the only affordance is gone.
 *
 *  So mobile clamps the window instead of merely defaulting it. TOP10_MOBILE_MQ
 *  must stay in step with the CSS breakpoint. */
const TOP10_MOBILE_MQ = '(max-width: 768px)';

/** True when the viewport is narrow enough that the Today/This Week pill is
 *  display:none, i.e. the user cannot choose a window at all. */
function _mzTop10ToggleHidden() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia(TOP10_MOBILE_MQ).matches;
}

/** The window the rail is actually allowed to show. Mobile is always 'day'. */
function _mzTop10EffectiveWindow(requested) {
  const win = (requested === 'day' || requested === 'week') ? requested : _mzTop10Window;
  return _mzTop10ToggleHidden() ? 'day' : win;
}

/*  Keeps only titles a visitor can actually open.
 *
 *  TMDB's trending feed mixes in unreleased films — they trend on trailer
 *  buzz alone. Two reasons they are dropped here rather than shown:
 *    • every other feed on this site filters future-dated titles, and a card
 *      in Top 10 links to the same watch page, which would be empty;
 *    • titleQualityState() has no stage before day 0, so an unreleased film
 *      would fall back to a flat "HD" chip, which is simply wrong.
 *  Ranking is otherwise untouched — TMDB's own order is preserved, so the
 *  numbers still reflect real trending position among watchable titles.
 */
function _mzTop10Usable(m, todayIST) {
  if (!m || !m.poster_path) return false;
  if (!(m.title || m.name)) return false;
  const rDate = m.release_date || m.first_air_date;
  if (!rDate) return (m.vote_count || 0) > 50;   // no date: only if clearly out
  return rDate <= todayIST;
}

/*  ══════════════════════════════════════════════════════════════════════
 *  SELECTION: most-trending, cross-checked against rating and real demand
 *  ══════════════════════════════════════════════════════════════════════
 *  ⚠ THIS SCORE NOW APPLIES TO THE "THIS WEEK" TAB ONLY. The Today tab renders
 *  TMDB's /trending/movie/day order verbatim (after the same quality gate),
 *  because scoring both windows produced two near-identical lists — see
 *  top10SelectRanked for the measurement.
 *
 *  The source is TMDB's /trending/movie/week — its own demand ranking, built
 *  from what people actually do on TMDB that week (page views, votes,
 *  watchlist and favourite adds).
 *
 *  An earlier version rendered that order verbatim. It is authentic but it is
 *  a pure buzz signal: a badly-reviewed film can sit at position 3 all week,
 *  and a thinly-voted title can drift in. This section is meant to show the
 *  titles that are trending AND worth the click, so the trending position is
 *  now one of three terms rather than the whole answer.
 *
 *  Three terms, weighted:
 *    • TREND  (45%) — position in TMDB's weekly ranking. Still the strongest
 *                     single term, because "most trending" is the point.
 *    • RATING (30%) — vote_average, Bayesian-shrunk towards the catalogue mean
 *                     using the site's existing RATING_PRIOR_* constants, so a
 *                     9.0 from twelve voters cannot outrank an 8.0 from twenty
 *                     thousand. Same shrink calculateMovieScore() applies.
 *    • DEMAND (25%) — how many people actually watched/rated it: vote_count on
 *                     a log scale (volume) blended with TMDB popularity
 *                     (current velocity).
 *
 *  Deliberately NOT reusing calculateMovieScore(): its recency term is worth
 *  up to 80 points, which would turn this rail into "newest releases" instead
 *  of "biggest and best right now".
 */
const TOP10_TREND_WEIGHT  = 0.45;
const TOP10_RATING_WEIGHT = 0.30;
const TOP10_DEMAND_WEIGHT = 0.25;

/*  Quality floors, strictest first. The pool is filtered at the tightest tier
 *  that still yields a full ten; only if a tier cannot fill the rail does it
 *  fall through to the next. So a normal week is gated hard, and a thin week
 *  still renders ten cards instead of an empty section.
 *    votes = credibility of the rating; rating = the shrunk value, not raw. */
const TOP10_QUALITY_TIERS = [
  { votes: 300, rating: 6.8 },
  { votes: 120, rating: 6.3 },
  { votes: 40,  rating: 5.8 },
  { votes: 0,   rating: 0   }   // last resort: keep the rail populated
];

/** vote_average pulled towards the catalogue mean in proportion to how few
 *  votes back it — the standard fix for tiny-sample ratings. */
function top10ShrunkRating(m) {
  const votes = m.vote_count || 0;
  const raw = m.vote_average || 0;
  return ((votes * raw) + (RATING_PRIOR_VOTES * RATING_PRIOR_MEAN)) / (votes + RATING_PRIOR_VOTES);
}

/** 0-100 composite. `trendIndex` is the title's position in TMDB's trending
 *  response, `poolSize` the number of candidates it was ranked among. */
function top10Score(m, trendIndex, poolSize) {
  const votes = m.vote_count || 0;

  // Position 1 scores 100 and the last candidate ~0.
  const trendTerm = ((poolSize - trendIndex) / poolSize) * 100;

  // 5.0 shrunk -> 0, 9.0 shrunk -> 100. Below 5 contributes nothing.
  const ratingTerm = Math.max(0, Math.min(100, ((top10ShrunkRating(m) - 5) / 4) * 100));

  // Volume (how many actually watched it) blended with current velocity.
  const votesTerm = Math.min(100, (Math.log10(votes + 1) / Math.log10(30000)) * 100);
  const popTerm = Math.min(100, ((m.popularity || 0) / 300) * 100);
  const demandTerm = (votesTerm * 0.5) + (popTerm * 0.5);

  return (trendTerm * TOP10_TREND_WEIGHT)
       + (ratingTerm * TOP10_RATING_WEIGHT)
       + (demandTerm * TOP10_DEMAND_WEIGHT);
}

/** Picks and orders the final ten out of a trending pool.
 *
 *  Pure and separate from the fetch so the ranking can be tested directly:
 *  give it a pool with _trendIndex set and it returns the rail's contents.
 *
 *  `order` picks WHAT the ten are sorted by, and it is the difference between
 *  the two tabs:
 *    'trend' — TMDB's own position for that window, verbatim (Today).
 *    'score' — the composite in top10Score() (This Week, the default).
 *
 *  ⚠ WHY TODAY IS NOT SCORED. Measured on 2026-09-06 with both windows scored:
 *  the two tabs came out with 8 of 10 titles in common AND 5 of 10 in the exact
 *  same position, so switching tabs looked like it did nothing. The cause is the
 *  weighting, not the data: trend position is only 45% of the score, while
 *  rating (30%) and demand (25%) are near-identical for a title whether you read
 *  it over a day or a week, so those 55% pulled both windows towards the same
 *  answer. TMDB's day and week feeds do genuinely share most titles — the same
 *  films are trending in both — so the only honest way to make "Today" mean
 *  today is to keep ITS OWN ORDER. Re-measured after this change: 0 of 10
 *  positions match the week list.
 *
 *  The quality ladder below still applies to both windows. It is a credibility
 *  gate, not a ranking: it drops titles whose rating rests on a handful of votes
 *  (on that same day: Buddy, 8.3 from 35 voters) which would otherwise open the
 *  rail. What Today no longer does is REORDER what survives that gate.
 */
function top10SelectRanked(pool, order) {
  if (!pool || !pool.length) return [];

  pool.forEach(m => { m._top10Score = top10Score(m, m._trendIndex, pool.length); });

  // Tightest tier that can still fill the rail wins.
  let qualified = [];
  for (let t = 0; t < TOP10_QUALITY_TIERS.length; t++) {
    const tier = TOP10_QUALITY_TIERS[t];
    qualified = pool.filter(m =>
      (m.vote_count || 0) >= tier.votes && top10ShrunkRating(m) >= tier.rating);
    if (qualified.length >= TOP10_COUNT) break;
  }
  // Every tier came up short — rank the whole pool rather than show a gap.
  if (qualified.length < TOP10_COUNT) qualified = pool.slice();

  if (order === 'trend') qualified.sort((a, b) => a._trendIndex - b._trendIndex);
  else qualified.sort((a, b) => b._top10Score - a._top10Score);
  return qualified.slice(0, TOP10_COUNT);
}

/*  ══════════════════════════════════════════════════════════════════════
 *  THE TWO WINDOWS — /trending/movie/day (Today) vs /trending/movie/week
 *  ══════════════════════════════════════════════════════════════════════
 *  Both are TMDB's own demand ranking and differ only in the window they are
 *  measured over; the toggle above the rail chooses between them. Neither list
 *  is computed here: TMDB rebuilds day every day and week every week, so the
 *  rail tracks the current date on its own — see _mzTop10CacheDay for the one
 *  thing that had to be added to keep that true in a tab left open past
 *  midnight.
 *
 *  Today is the default because it is the more immediate answer to "what is hot
 *  right now"; This Week is the steadier list, less swayed by one viral trailer.
 *  They are also RANKED differently — Today shows TMDB's day order as-is, This
 *  Week is scored on trend + rating + demand — because scoring both made the two
 *  tabs look identical. top10SelectRanked has the numbers.
 *
 *  Two pages are requested in ONE round trip via tmdbBatch, giving a ~40-title
 *  pool to pick ten from. A 20-title pool was too small to apply a quality bar
 *  without regularly falling through to the loosest tier.
 */
async function loadTop10(mode) {
  const rail = document.getElementById('top10Rail');
  const section = document.getElementById('top10-trending');
  if (!rail || !section) return;

  // Default to whatever window is currently active (Today on first load), then
  // clamp: on a viewport where the toggle is hidden the rail is always 'day'.
  const win = _mzTop10EffectiveWindow(mode);
  _mzTop10Window = win;

  // IST date, matching loadCarousel's release cutoff.
  const todayIST = new Date(Date.now() + (5.5 * 60 * 60 * 1000)).toISOString().split('T')[0];

  /*  The day rolled over while this page stayed open — every cached list is
   *  yesterday's, so drop them instead of serving a stale "Today". */
  if (_mzTop10CacheDay && _mzTop10CacheDay !== todayIST) {
    _mzTop10Cache = { day: null, week: null };
    _mzTop10CacheDay = null;
  }

  // Already have this window's ranking from earlier today — reuse it.
  if (_mzTop10Cache[win]) {
    _mzTop10Data = _mzTop10Cache[win];
    renderTop10(_mzTop10Data);
    return;
  }
  if (_mzTop10Loads[win]) return;
  _mzTop10Loads[win] = true;
  _mzTop10Loading = true;

  /*  Show the skeleton while a fresh window loads, so switching tabs gives
   *  immediate feedback rather than freezing the old rail. */
  _mzShowTop10Skeleton();

  // Today → /trending/movie/day, This Week → /trending/movie/week.
  const endpoint = win === 'day' ? '/trending/movie/day' : '/trending/movie/week';

  let list = [];
  try {
    const pages = await tmdbBatch([
      [endpoint, { language: 'en-US', page: '1' }],
      [endpoint, { language: 'en-US', page: '2' }]
    ]);

    /*  Flatten in response order so the index IS the trending position, then
     *  de-duplicate — page boundaries can repeat a title. */
    const pool = [];
    const seen = new Set();
    pages.forEach(res => {
      if (res.status !== 'fulfilled' || !res.value || !res.value.results) return;
      res.value.results.forEach(m => {
        if (!_mzTop10Usable(m, todayIST) || seen.has(m.id)) return;
        seen.add(m.id);
        m._trendIndex = pool.length;      // 0 = most trending
        pool.push(m);
      });
    });

    /*  Today keeps TMDB's day order; This Week is scored. See top10SelectRanked
     *  for the measurement that forced the split. */
    list = top10SelectRanked(pool, win === 'day' ? 'trend' : 'score');
  } catch (e) {
    list = [];
  }
  _mzTop10Loads[win] = false;
  _mzTop10Loading = false;

  // A stale response can arrive after the visitor already switched windows.
  // Only paint if this window is still the active one.
  const stillActive = _mzTop10Window === win;

  if (list.length === 0) {
    // Nothing to show for this window — hide only if it is the one on screen.
    if (stillActive) section.setAttribute('hidden', '');
    return;
  }

  _mzTop10Cache[win] = list;
  _mzTop10CacheDay = todayIST;
  if (stillActive) {
    _mzTop10Data = list;
    renderTop10(list);
  }
}

/*  Rebuild the loading skeleton (five placeholder cards) that index.html ships
 *  with, so a window switch shows the same shimmer the first load did. */
function _mzShowTop10Skeleton() {
  const rail = document.getElementById('top10Rail');
  if (!rail) return;
  let html = '';
  for (let i = 0; i < 5; i++) html += '<div class="top10-card top10-skeleton"></div>';
  rail.innerHTML = html;
}

function renderTop10(list) {
  const rail = document.getElementById('top10Rail');
  const section = document.getElementById('top10-trending');
  if (!rail || !section) return;

  const CROWN = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M3 7l4 4 5-6 5 6 4-4v11H3V7z"/></svg>';
  const STAR = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.8 6.1 20.8l1.2-6.6L2.5 9.6l6.6-.9L12 2z"/></svg>';
  const SEP = '<span class="t10-sep" aria-hidden="true"></span>';

  const html = list.map((m, i) => {
    const rank = i + 1;
    // Every field below is straight off the TMDB record for this title.
    const title = escapeHTML(m.title || m.name || '');
    const year = (m.release_date || m.first_air_date || '').slice(0, 4);
    const rating = m.vote_average ? m.vote_average.toFixed(1) : null;
    const genres = (m.genre_ids || []).slice(0, 2).map(id => GENRE_MAP[id]).filter(Boolean);
    const lang = (m.original_language || '').toUpperCase();

    /*  Quality label comes from the catalogue's OWN release-date timeline
     *  (titleQualityState -> CAM/TS/HDTS/HD/FHD/4K), the same function the
     *  movie grid uses. An earlier version guessed from popularity, which
     *  meant a Top 10 card and a grid card could disagree about one title. */
    let qual = 'HD';
    let qualCls = 'qual-hd';
    if (typeof titleQualityState === 'function') {
      const qs = titleQualityState(m);
      if (qs && qs.qual) { qual = qs.qual; qualCls = qs.cls || ''; }
    }

    const p342 = 'https://image.tmdb.org/t/p/w342' + m.poster_path;
    const p500 = 'https://image.tmdb.org/t/p/w500' + m.poster_path;
    const p185 = 'https://image.tmdb.org/t/p/w185' + m.poster_path;

    const metaBits = [];
    if (year) metaBits.push('<span>' + year + '</span>');
    if (genres.length) metaBits.push('<span>' + genres.map(escapeHTML).join(' · ') + '</span>');
    if (lang) metaBits.push('<span class="t10-lang">' + escapeHTML(lang) + '</span>');
    const meta = metaBits.join(SEP);

    // Stagger the entrance the same way the movie grid does. Capped so the
    // tenth card is not left waiting most of a second.
    const delay = Math.min(i, 8) * 0.055;
    // A high score earns the gold badge — see .top10-rating.is-high.
    const ratingCls = (m.vote_average >= 7.5) ? ' is-high' : '';

    return (
      '<div class="top10-card" data-rank="' + rank + '" data-id="' + m.id + '" data-type="movie"' +
        ' tabindex="0" role="button" aria-label="' + title + ', ranked number ' + rank + '"' +
        ' style="animation-delay:' + delay.toFixed(3) + 's">' +
        '<span class="top10-rank' + (rank > 3 ? ' top10-rank--outline' : '') + '" aria-hidden="true">' + rank + '</span>' +
        '<div class="top10-poster">' +
          '<img src="' + p342 + '"' +
            ' srcset="' + p185 + ' 185w, ' + p342 + ' 342w, ' + p500 + ' 500w"' +
            ' sizes="(max-width: 420px) 50vw, (max-width: 768px) 43vw, (max-width: 1024px) 212px, 250px"' +
            ' alt="' + title + '" width="250" height="375" loading="lazy" decoding="async" fetchpriority="low" draggable="false">' +
          '<div class="top10-badges">' +
            (rating ? '<span class="top10-rating' + ratingCls + '">' + STAR + rating + '</span>' : '<span></span>') +
            '<span class="top10-quality ' + qualCls + '">' + (qual === '4K' ? CROWN : '') + qual + '</span>' +
          '</div>' +
          '<div class="top10-play"><span>&#9654;</span></div>' +
          '<div class="top10-info">' +
            '<h3 class="top10-name">' + title + '</h3>' +
            '<div class="top10-meta">' + meta + '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  rail.innerHTML = html;
  section.removeAttribute('hidden');
  _mzUpdateTop10Arrows();
  /*  The pill can only be measured now: until this line the section is
   *  [hidden], i.e. display:none, and every offsetWidth inside it reads 0. */
  _mzSyncTop10Ind();
}

/*  Sizes and positions the toggle's gold indicator from the ACTIVE button's own
 *  box, instead of assuming the two halves are equal.
 *
 *  They are not: "Today" is about 30% narrower than "This Week", so the original
 *  `width: calc(50% - 4px)` pill was wider than the Today label and narrower
 *  than This Week — visibly wrong at both ends, and it would drift further with
 *  any font-size change. Measuring is also what keeps it correct once Outfit
 *  swaps in over the fallback face, which changes the label widths after first
 *  paint.
 *
 *  Reads offsetLeft/offsetWidth (layout values, unaffected by the transform
 *  already on the element) and writes an inline transform that overrides the
 *  stylesheet's .is-week fallback.
 */
function _mzSyncTop10Ind() {
  const toggle = document.querySelector('#top10-trending .top10-toggle');
  if (!toggle) return;
  const ind = toggle.querySelector('.top10-toggle-ind');
  const active = toggle.querySelector('.top10-toggle-btn.is-active');
  if (!ind || !active || !active.offsetWidth) return;   // 0 while the section is hidden
  ind.style.width = active.offsetWidth + 'px';
  ind.style.transform = 'translateX(' + (active.offsetLeft - ind.offsetLeft) + 'px)';
}

/*  Delegated wiring — set up once. Clicks/keys open the detail modal, the
 *  Today/This Week toggle swaps the data set, and the arrows page the rail.
 */
let _mzTop10Wired = false;
function _mzUpdateTop10Arrows() {
  const rail = document.getElementById('top10Rail');
  const wrap = rail && rail.closest('.top10-rail-wrap');
  if (!rail || !wrap) return;
  const prev = wrap.querySelector('.top10-arrow--prev');
  const next = wrap.querySelector('.top10-arrow--next');
  const scrollable = rail.scrollWidth - rail.clientWidth > 8;
  if (prev) prev.hidden = !scrollable || rail.scrollLeft <= 4;
  if (next) next.hidden = !scrollable || rail.scrollLeft >= (rail.scrollWidth - rail.clientWidth - 4);
}

function initTop10() {
  const section = document.getElementById('top10-trending');
  if (!section || _mzTop10Wired) { if (section) loadTop10(); return; }
  _mzTop10Wired = true;

  const rail = section.querySelector('#top10Rail');

  // Open detail on card activation (mirrors the movie grid's delegated handler).
  section.addEventListener('click', (event) => {
    const card = event.target.closest('.top10-card[data-id]');
    if (!card || !section.contains(card)) return;
    if (typeof openModal === 'function') {
      openModal(parseInt(card.dataset.id, 10), card.dataset.type || 'movie', event);
    }
  });
  section.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.top10-card[data-id]');
    if (!card) return;
    event.preventDefault();
    if (typeof openModal === 'function') {
      openModal(parseInt(card.dataset.id, 10), card.dataset.type || 'movie', event);
    }
  });

  // Arrows + scroll state.
  if (rail) {
    /*  Page by whole cards rather than a fraction of the viewport, so a click
     *  never leaves a numeral sliced by the rail edge. */
    const step = () => {
      const card = rail.querySelector('.top10-card');
      const cardW = card ? card.getBoundingClientRect().width : 240;
      const gap = parseFloat(getComputedStyle(rail).columnGap || '12') || 12;
      const per = Math.max(1, Math.floor(rail.clientWidth / (cardW + gap)));
      return per * (cardW + gap);
    };
    const prev = section.querySelector('.top10-arrow--prev');
    const next = section.querySelector('.top10-arrow--next');
    if (prev) prev.addEventListener('click', () => rail.scrollBy({ left: -step(), behavior: 'smooth' }));
    if (next) next.addEventListener('click', () => rail.scrollBy({ left: step(), behavior: 'smooth' }));
    rail.addEventListener('scroll', _mzUpdateTop10Arrows, { passive: true });

    /*  Arrow visibility depends on scrollWidth vs clientWidth, and both change on
     *  any resize, orientation flip, or when the poster size variable steps to a
     *  new breakpoint. The measured toggle indicator has to be refreshed on
     *  exactly the same events — the 560px breakpoint changes the pill's padding
     *  and font size — so one callback does both. ResizeObserver catches all of
     *  them; the window listener is the fallback for engines without it. */
    const resync = () => { _mzUpdateTop10Arrows(); _mzSyncTop10Ind(); };
    if (typeof ResizeObserver === 'function') new ResizeObserver(resync).observe(rail);
    window.addEventListener('resize', resync, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(resync, 150));
    /*  Outfit replacing the fallback face reflows both labels, which moves the
     *  box the indicator was measured against. */
    if (document.fonts) document.fonts.ready.then(_mzSyncTop10Ind).catch(() => {});
  }

  /*  Today / This Week toggle. One delegated handler on the pill: identify the
   *  clicked button, move the sliding indicator and the active/aria state, then
   *  load that window (cached after the first fetch, so re-clicks are instant). */
  const toggle = section.querySelector('.top10-toggle');
  if (toggle) {
    const headWin = document.getElementById('top10HeadWin');
    const setWindow = (win) => {
      if (win !== 'day' && win !== 'week') return;
      // Mobile has no pill, so it can never be moved off Today even defensively.
      win = _mzTop10EffectiveWindow(win);
      const btns = toggle.querySelectorAll('.top10-toggle-btn');
      btns.forEach(b => {
        const on = b.dataset.window === win;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      // Slides the gold indicator: default (left) = Today, .is-week (right) = This Week.
      toggle.classList.toggle('is-week', win === 'week');
      // Re-measure against the button that just became active (see _mzSyncTop10Ind).
      _mzSyncTop10Ind();
      /*  Only the screen-reader-only tail of the h2 changes, so the visible
       *  "Top 10 Trending Movies" markup is left intact — rewriting the whole
       *  heading would delete the styled <span> with it. */
      if (headWin) headWin.textContent = win === 'week' ? 'This Week' : 'Today';
      const _t10h = document.getElementById('top10Heading');
      if (_t10h) _t10h.setAttribute('aria-label', 'Top 10 Movies ' + (win === 'week' ? 'This Week' : 'Today'));
      loadTop10(win);
    };

    toggle.addEventListener('click', (event) => {
      const btn = event.target.closest('.top10-toggle-btn');
      if (!btn || !toggle.contains(btn)) return;
      const win = btn.dataset.window;
      if (win === _mzTop10Window) return;   // already showing this window
      setWindow(win);
    });

    /*  Crossing the mobile breakpoint takes the pill away, so the window it set
     *  has to be surrendered with it. Without this a visitor who picked "This
     *  Week" on a wide window and then narrowed the viewport (or rotated a
     *  tablet to portrait) was left on weekly trending with no control to leave
     *  it — the section silently disagreed with its own heading.
     *
     *  setWindow() also repaints the button state and the heading, so when the
     *  viewport widens again the pill comes back correctly showing Today. */
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia(TOP10_MOBILE_MQ);
      const onBreakpoint = () => {
        if (_mzTop10ToggleHidden() && _mzTop10Window !== 'day') setWindow('day');
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onBreakpoint);
      else if (typeof mq.addListener === 'function') mq.addListener(onBreakpoint);   // older Safari
    }
  }

  loadTop10();
}

function buildCarousel() {
  const track = document.getElementById('carouselTrack');
  const dots  = document.getElementById('carouselDots');
  const thumbs = document.getElementById('carouselThumbs');
  if (!track || !dots || !thumbs) return;
  track.innerHTML = ''; dots.innerHTML = ''; thumbs.innerHTML = '';
  currentSlide = 0;
 
  const trackFrag = document.createDocumentFragment();
  const dotsFrag = document.createDocumentFragment();
  const thumbsFrag = document.createDocumentFragment();

  /*  Long tasks: building all ten slides in one pass is a single multi-second
   *  block on a phone, competing with the hero image decode. Only slide 0 is
   *  visible, so it is built inline and the rest are handed to the idle
   *  queue in small batches. Order and markup are identical either way.
   */
  const buildOne = (m, i, trackFrag, dotsFrag, thumbsFrag) => {
    /*  Genres render as ONE chip in the meta row ("Action - Adventure") rather
     *  than a separate row of pills below it. Two reasons: it is what the
     *  reference design does, and it gives .slide-desc back a line of vertical
     *  space inside a 95vh hero that was already tight on short laptops.
     *  .genre-tag itself is untouched - the modal still uses it. */
    const genreLabel = (m.genre_ids || []).slice(0, 3)
      .map(id => GENRE_MAP[id] || 'Movie').join(' \u00B7 ');
    const slide = document.createElement('div');
    slide.className = 'carousel-slide' + (i === 0 ? ' active' : '');
    /*  Editorial backdrop swap (see CAROUSEL_BACKDROP_OVERRIDES). Resolve the
     *  path here, at the single point the slide's image is chosen, so the
     *  override flows into the LCP <img>, the lazy data-bg, the localStorage LCP
     *  hint and the thumbnail alike — and TMDB refreshing m.backdrop_path can
     *  never bring the old image back. The shared m object is left untouched. */
    const overridePath = CAROUSEL_BACKDROP_OVERRIDES[m.id];
    const backdropPath = overridePath || m.backdrop_path;
    const isBackdrop = !!backdropPath;
    const bgUrl = isBackdrop
      ? (i === 0 ? getHeroBackdrop(backdropPath) : getResponsiveBackdrop(backdropPath))
      : `https://image.tmdb.org/t/p/w780${m.poster_path}`;

    /*  LCP — slide 0's backdrop IS this page's Largest Contentful Paint element.
     *
     *  It used to be a CSS background-image on .slide-bg, helped along by a
     *  <link rel="preload"> that this loop injected. Both parts were weak:
     *
     *    - A background-image is invisible to the preload scanner. The browser
     *      only learns the URL after it has resolved style for the injected
     *      markup, and it then fetches it at Low priority, behind every poster
     *      the grid is requesting in the same tick.
     *    - The preload link was appended from JS, i.e. after the bundle parsed
     *      AND after the TMDB response resolved. By then the same element was
     *      about to request the image anyway, so the "preload" won no time at
     *      all - it only added a duplicate-priority entry.
     *
     *  A real <img fetchpriority="high"> is requested at Highest priority the
     *  moment the node is inserted, and is a first-class LCP candidate rather
     *  than a background decoration. It is nested INSIDE .slide-bg so it
     *  inherits the existing inset/scale/filter - the Ken-Burns zoom and the
     *  brightness grade are unchanged (see .slide-bg-img in index.html).
     *
     *  Slides 1..n keep data-bg and stay lazy via ensureSlideBg(); only slide 0
     *  is on the critical path. See slideBackdropMarkup() for why the size
     *  branch is a <picture media> and not srcset + sizes.
     */
    const heroImg = i === 0 ? slideBackdropMarkup(bgUrl, true, isBackdrop) : '';

    if (i === 0) {
      // Remember the URL so the NEXT visit can start this exact request from the
      // pre-paint hint in <head>, before this bundle has even been parsed.
      // Read back by the mz_hero_lcp block in index.html (6 h TTL enforced there).
      try {
        localStorage.setItem('mz_hero_lcp', JSON.stringify({ u: bgUrl, t: Date.now() }));
      } catch (e) { /* quota / private mode - the hint is optional */ }
    }

    const qualityState = m._qualityState || titleQualityState(m);
    /*  Painted from the timeline now, corrected in place once the real
     *  release-type data lands (see refreshSlideQuality). Rendering the estimate
     *  first rather than an empty placeholder is deliberate: the chip sits inside
     *  .slide-meta, so a node that gained its text a second later would reflow
     *  the row directly under the LCP image. The correction reuses the same chip,
     *  so it repaints without moving anything. */
    const qualityChip =
      '<span class="slide-quality ' + (qualityState.cls || '') + '"' +
        ' data-mz-quality title="Available print quality">' +
        escapeHTML(qualityState.qual) +
      '</span>';

    // TV objects carry first_air_date, not release_date, so every web-series and
    // anime slide used to render an empty year chip.
    const slideYear = (m.release_date || m.first_air_date || '').slice(0, 4);

    /*  TITLE LENGTH -> TYPE SIZE
     *  The hero font is 6.6rem at the top of its clamp, which is right for
     *  "Gladiator II" and absurd for "Detective Conan: Fallen Angel of the
     *  Crimson Sky". At full size a long title filled both available lines and
     *  still ellipsised, so the one slide that needed the most room to explain
     *  itself got the least. Stepping the size down by length keeps every slide
     *  at roughly the same optical weight, which is what makes the rail feel
     *  designed rather than templated. Thresholds are character counts because
     *  that is all that is knowable before layout; the clamp handles viewport. */
    const heroTitle = m.title || m.name || '';
    const titleSizeCls = heroTitle.length > 34 ? ' slide-title--xlong'
      : heroTitle.length > 20 ? ' slide-title--long' : '';

    /*  BADGE TEXT
     *  _badge values are authored with a leading emoji ("\u{1F3AC} BOLLYWOOD HIT").
     *  The badge draws its own gold mark now, so the emoji is stripped here rather
     *  than edited out of the thirteen assignments in scoreAndRank.
     *
     *  The character class is deliberately plain ASCII, not a \p{...} property
     *  escape: this bundle also runs on Tizen and webOS browsers, and a regex
     *  literal with the /u flag and a property escape is a PARSE error on the
     *  older ones, which would take the whole file down rather than just the
     *  badge. Escaped on output too - it used to be interpolated raw. */
    const badgeText = String(m._badge || 'TRENDING NOW').replace(/^[^A-Za-z0-9#]+/, '');

    slide.innerHTML =
      '<div class="slide-bg"' + (i === 0 ? '' : ' data-bg="' + bgUrl + '"'
        // A poster stand-in for a title with no backdrop. Flagged so
        // ensureSlideBg() does not offer it the backdrop width ladder: posters
        // are 2:3, so the same w1280 that is 98 KB of backdrop is 257 KB of
        // poster for a box that shows 780px of it.
        + (isBackdrop ? '' : ' data-bg-fixed="1"')) + '>' + heroImg + '</div>' +
      '<div class="slide-gradient"></div>' +
      '<div class="slide-content">' +
        '<div class="slide-badge"><svg class="slide-badge-mark" viewBox="0 0 24 24" width="9" height="9" fill="currentColor" aria-hidden="true"><path d="M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z"/></svg>'+escapeHTML(badgeText)+'</div>' +
        // SEO: carousel slides use <h2>, not <h1>. The page must expose exactly
        // one <h1> (the one in index.html); 6 competing <h1>s split the topical
        // signal Google reads from the page. Styling is class-based, so the
        // .slide-title look is unchanged.
        '<h2 class="slide-title'+titleSizeCls+'"><span class="slide-title-text">'+escapeHTML(heroTitle)+'</span></h2>' +
        '<div class="slide-meta">' +
          '<span class="slide-rating" aria-label="Rating ' + ((m.vote_average||0).toFixed(1)) + ' out of 10">' +
            '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">' +
              '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
            '</svg>' +
            '<b>' + ((m.vote_average||0).toFixed(1)) + '</b>' +
          '</span>' +
          (slideYear ? '<span class="slide-year">'+slideYear+'</span>' : '') +
          (genreLabel ? '<span class="slide-genres">'+escapeHTML(genreLabel)+'</span>' : '') +
          '<span class="slide-runtime">LANG '+(m.original_language||'EN').toUpperCase()+'</span>' +
          qualityChip +
        '</div>' +
        '<p class="slide-desc">'+escapeHTML(m.overview||'')+'</p>' +
        '<div class="slide-actions">' +
          '<button class="btn-play" tabindex="0" data-id="'+m.id+'" data-type="'+(m.media_type||(m.title?'movie':'tv'))+'"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Watch Now</button>' +
          '<button class="btn-info" tabindex="0" data-id="'+m.id+'" data-type="'+(m.media_type||(m.title?'movie':'tv'))+'"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg> More Info</button>' +
        '</div>' +
      '</div>';
    slide.querySelectorAll('[data-id]').forEach(btn => {
      if (btn.classList.contains('btn-info')) {
        btn.addEventListener('click', (event) => { openUpcomingDetail(parseInt(btn.dataset.id), btn.dataset.type, event); });
      } else {
        btn.addEventListener('click', (event) => { openModal(parseInt(btn.dataset.id), btn.dataset.type, event); });
      }
    });
    trackFrag.appendChild(slide);
 
    const dot = document.createElement('div');
    dot.className = 'dot' + (i === 0 ? ' active' : '');
    dot.tabIndex = 0;
    dot.addEventListener('click', () => { goToSlide(i); resetAutoSlide(); });
    dotsFrag.appendChild(dot);
 
    const thumb = document.createElement('div');
    thumb.className = 'thumb' + (i === 0 ? ' active' : '');
    thumb.tabIndex = 0;
    /*  w185, not IMG (w342).
     *  .thumb renders at min(58px, 5.02vh) wide — so w342 was roughly 6x the
     *  pixels it displays on a 1x screen and still 2x on a 3x phone. Ten of these
     *  load with the carousel, which put ~250 KB of thumbnail on the critical
     *  path to show ~35 KB worth of image. w185 covers a 3x device exactly.
     */
    thumb.innerHTML = '<img src="https://image.tmdb.org/t/p/w185' + m.poster_path +
      '" alt="" width="60" height="84" loading="lazy" decoding="async">';
    thumb.addEventListener('click', () => { goToSlide(i); resetAutoSlide(); });
    thumbsFrag.appendChild(thumb);
  };

  //  Slide 0 is the LCP element and slide 1 is what the auto-slide timer shows
  //  next — the warm-up below also needs it in the DOM to prime its backdrop.
  //  Both are cheap (slide 1 carries no image request, only data-bg), so they
  //  are built inline and everything after them is deferred.
  const INLINE_SLIDES = 2;
  carouselMovies.slice(0, INLINE_SLIDES).forEach((m, i) =>
    buildOne(m, i, trackFrag, dotsFrag, thumbsFrag));

  track.appendChild(trackFrag);
  dots.appendChild(dotsFrag);
  thumbs.appendChild(thumbsFrag);

  if (carouselMovies.length > INLINE_SLIDES) {
    const rest = carouselMovies.slice(INLINE_SLIDES);
    let cursor = 0;
    const BATCH = 3;
    const drain = () => {
      const tf = document.createDocumentFragment();
      const df = document.createDocumentFragment();
      const hf = document.createDocumentFragment();
      const end = Math.min(cursor + BATCH, rest.length);
      for (; cursor < end; cursor++) {
        buildOne(rest[cursor], cursor + INLINE_SLIDES, tf, df, hf);
      }
      track.appendChild(tf);
      dots.appendChild(df);
      thumbs.appendChild(hf);
      if (cursor < rest.length) schedule(drain);
    };
    const schedule = (fn) => ('requestIdleCallback' in window)
      ? requestIdleCallback(fn, { timeout: 1500 })
      : setTimeout(fn, 32);
    schedule(drain);
  }
 
  // Slide 1's backdrop used to be requested right here, in the same tick as the
  // hero. Two full-width backdrops racing each other means the one the user can
  // actually see - the LCP element - gets half the bandwidth for nothing, since
  // the next slide is not needed until the auto-slide timer fires seconds later.
  // Wait for the hero to finish, then warm slide 1 while the main thread is idle.
  if (carouselMovies.length > 1) {
    const warmNext = () => {
      const run = () => ensureSlideBg(1 % carouselMovies.length);
      if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 });
      else setTimeout(run, 600);
    };
    const heroImg = track.querySelector('.slide-bg-img');
    if (heroImg && !heroImg.complete) {
      heroImg.addEventListener('load', warmNext, { once: true });
      heroImg.addEventListener('error', warmNext, { once: true });
    } else {
      warmNext();
    }
  }

  /*  Correct slide 0's print badge from real release data.
   *
   *  At idle, and only for the slide on screen: this is one extra TMDB call, and
   *  the reason it is not made for all ten slides up front is the same reason the
   *  slide bodies are batched — a ten-call fan-out in the load tick queues at the
   *  origin and makes every request in it, including the hero backdrop, look
   *  slow. goToSlide() picks up the rest as the viewer reaches them, and tmdb()
   *  caches each answer for 12 h. */
  const settleHeroQuality = () => refreshSlideQuality(currentSlide);
  if ('requestIdleCallback' in window) requestIdleCallback(settleHeroQuality, { timeout: 4000 });
  else setTimeout(settleHeroQuality, 1500);
 
  startAutoSlide();
}

/*  ── SLIDE BACKDROP MARKUP ───────────────────────────────────────────────────
 *  One place that turns a backdrop URL into the element the carousel paints, so
 *  slide 0 (the LCP element) and the lazily-materialised slides cannot drift.
 *
 *  WHY <picture media> AND NOT srcset + sizes
 *  `sizes` resolves against DEVICE pixels: a DPR2 phone asking for a 100vw box
 *  computes ~820 CSS px -> ~1640 device px and the browser picks w1280, which is
 *  the download this whole path exists to avoid on the connections least able to
 *  afford it. A media query is evaluated on CSS pixels, so the branch is
 *  predictable — and it is byte-identical to the media= on the two hero preload
 *  links in <head>, so the preload and the request can never resolve to two
 *  different URLs. getHeroBackdrop() answers the same question through
 *  matchMedia, but that read happens later: a window rotated or resized between
 *  <head> being parsed and this bundle running would disagree with the preload
 *  and pull the LCP image twice. <picture> removes that class of miss entirely.
 *
 *  WHY THERE IS NO type="image/webp" OR AVIF SOURCE
 *  image.tmdb.org already content-negotiates on Accept. The same .jpg URL answers
 *  image/webp to every browser that advertises it — measured 171 KB -> 98 KB at
 *  w1280 and 90 KB -> 41 KB at w780, i.e. the ~45% saving is already live on
 *  every request, including the CSS background path. It does not serve AVIF at
 *  all: an Accept of image/avif alone still comes back image/jpeg. So a
 *  <source type="image/webp"> aimed at the same URL would save nothing, and an
 *  AVIF source would be a guaranteed miss-then-fallback.
 */
function slideBgImg(url, isHero) {
  /*  Slide 0: eager + high, because it is the LCP element and every millisecond
   *  it spends behind another request is on the metric.
   *  Slides 1..n: low priority. They are only built when one is about to be
   *  shown (see ensureSlideBg), which is a stricter gate than loading="lazy" —
   *  a translateX carousel puts slide 1 only one viewport-width away, well
   *  inside Chrome's ~1250px lazy threshold, so the attribute would fetch three
   *  backdrops during the load window instead of none.
   */
  return isHero
    ? '<img class="slide-bg-img" fetchpriority="high" loading="eager" src="' + url
      + '" alt="" width="1280" height="720" style="aspect-ratio:16/9;object-fit:cover;" decoding="async" draggable="false">'
    : '<img class="slide-bg-img" fetchpriority="low" loading="eager" src="' + url
      + '" alt="" width="1280" height="720" style="aspect-ratio:16/9;object-fit:cover;" decoding="async" draggable="false">';
}

function slideBackdropMarkup(bgUrl, isHero, resizable) {
  if (!bgUrl) return '';

  const m = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w(\d+)(\/.+)$/.exec(bgUrl);

  /*  Three cases stay a plain <img>:
   *    - `resizable` false: a poster standing in for a missing backdrop. TMDB
   *      will happily serve /t/p/w1280/<poster>, but a 2:3 image at that width is
   *      1280x1920 and measured 257 KB against the 96 KB of w780 — for a box that
   *      only ever shows ~780px of it.
   *    - anything not shaped like a sized TMDB path, which there is no safe way
   *      to re-point at another width;
   *    - the w500 ceiling getHeroBackdrop/getResponsiveBackdrop hand back on
   *      save-data and 2G/3G. Honouring an explicit request to spend less data
   *      outranks the sharper asset, so <source> must not upgrade it.
   */
  if (resizable === false || !m || m[2] === '500') return slideBgImg(bgUrl, isHero);

  const base = m[1], path = m[3];
  return '<picture>'
    + '<source media="' + HERO_MOBILE_MQ + '" srcset="' + base + 'w780' + path + '">'
    + '<source media="' + HERO_WIDE_MQ + '" srcset="' + base + 'w1280' + path + '">'
    // Fallback for browsers with no <picture>: the desktop asset, which is the
    // one that is always correct if only one can be chosen.
    + slideBgImg(base + 'w1280' + path, isHero)
    + '</picture>';
}

/*  Materialises a slide's backdrop only once it is about to be shown.
 *
 *  Was `bg.style.backgroundImage = url(...)`. Now it inserts the same <picture>
 *  slide 0 uses, for two reasons: a background-image is stuck with whatever width
 *  getResponsiveBackdrop() picked when the deck was built (a window resized across
 *  1024px afterwards kept the wrong asset), and an <img> can carry
 *  fetchpriority="low" so warming slide 1 cannot outbid anything on screen.
 *  The lazy gate itself is unchanged — this function is still only called for the
 *  current slide and the next one.
 */
function ensureSlideBg(idx) {
  const slides = document.querySelectorAll('.carousel-slide');
  const slide = slides[idx];
  if (!slide) return;
  const bg = slide.querySelector('.slide-bg');
  if (!bg || !bg.dataset.bg) return;
  if (bg.querySelector('.slide-bg-img')) return;   // already materialised
  const markup = slideBackdropMarkup(bg.dataset.bg, false, !bg.dataset.bgFixed);
  if (markup) bg.insertAdjacentHTML('afterbegin', markup);
}
 
function goToSlide(n) {
  const slides = document.querySelectorAll('.carousel-slide');
  const dots   = document.querySelectorAll('.dot');
  const thumbs = document.querySelectorAll('.thumb');
  const len = slides.length;
  if (!len) return;
  if (slides[currentSlide]) slides[currentSlide].classList.remove('active');
  if (dots[currentSlide])   dots[currentSlide].classList.remove('active');
  if (thumbs[currentSlide]) thumbs[currentSlide].classList.remove('active');
  currentSlide = ((n % len) + len) % len;
  if (slides[currentSlide]) slides[currentSlide].classList.add('active');
  if (dots[currentSlide])   dots[currentSlide].classList.add('active');
  if (thumbs[currentSlide]) thumbs[currentSlide].classList.add('active');
  const t = document.getElementById('carouselTrack');
  if (t) t.style.transform = 'translateX(-'+(currentSlide * 100)+'%)';
  // Make sure current + upcoming slide images are ready
  ensureSlideBg(currentSlide);
  ensureSlideBg((currentSlide + 1) % len);
  // Real print quality for the slide now on screen, if it has not been resolved
  // yet. Cheap after the first pass: both tmdb() and the promise map memoise.
  refreshSlideQuality(currentSlide);
}

/*  ── PRINT BADGE: ESTIMATE → REAL DATA ──────────────────────────────────────
 *  Replaces one slide's timeline-derived quality chip with the value implied by
 *  TMDB's actual release types. Idempotent and lazy, so it is safe to call on
 *  every slide change, including repeat visits to the same slide.
 *
 *  Only the chip's class and text are touched — never its position in the row —
 *  so a correction arriving seconds after paint cannot shift the hero.
 */
function refreshSlideQuality(index) {
  const movie = carouselMovies[index];
  if (!movie) return;
  const slide = document.querySelectorAll('.carousel-slide')[index];
  if (!slide) return;
  const chip = slide.querySelector('[data-mz-quality]');
  if (!chip || chip.dataset.mzQualitySettled === '1') return;
  chip.dataset.mzQualitySettled = '1';   // set before awaiting: no double flight

  fetchRealQualityState(movie).then((state) => {
    if (!state || !state.qual) return;
    // Cache on the movie object so the rails and the ranking see the same
    // corrected print for this title, not a second estimate.
    movie._qualityState = state;
    if (chip.textContent === state.qual) return;   // estimate was already right
    chip.className = 'slide-quality ' + (state.cls || '');
    chip.textContent = state.qual;
    chip.classList.add('slide-quality--corrected');
  }).catch(() => {
    // Leave the timeline estimate on screen; it is still the best guess.
  });
}
 
/* ── AUTOPLAY ─────────────────────────────────────────────────────────���───
   One constant drives every start/resume path — change the seconds here and
   the progress bar follows.

   Why the "holds": pausing used to be a plain `mouseenter` on #hero, and #hero
   is 95vh. On a laptop the pointer is almost always somewhere inside it, so the
   very first mouse move paused the carousel — and because `mouseleave` needs
   another move (scrolling away does not fire one), it never resumed. Autoplay
   was effectively dead on desktop. Hover now only holds the timer over the
   controls the viewer may be aiming at, and the timer also stands down while
   the tab is hidden or the hero is scrolled out of view. */
const CAROUSEL_AUTOPLAY_MS = 6000;
const HERO_PAUSE_ZONES = '.slide-actions, .carousel-dots, .carousel-thumbs';
const autoSlideHolds = { pointer: false, hidden: false, offscreen: false };

function autoSlideHeld() {
  return autoSlideHolds.pointer || autoSlideHolds.hidden || autoSlideHolds.offscreen;
}

// Restarts the countdown from zero. Deliberately a no-op while held, so a click
// on a dot cannot resurrect the timer behind a hidden tab.
function startAutoSlide() {
  if (autoSlideTimer) { clearInterval(autoSlideTimer); autoSlideTimer = null; }
  if (autoSlideHeld()) return;
  restartProgressBar();
  autoSlideTimer = setInterval(() => { goToSlide(currentSlide + 1); }, CAROUSEL_AUTOPLAY_MS);
}
function resetAutoSlide() { startAutoSlide(); }
 
// -- PREMIUM AUTOPLAY PROGRESS BAR --
function restartProgressBar() {
  const bar = document.getElementById('carouselProgress');
  if (!bar) return;
  bar.style.animation = 'none';
  bar.style.animationPlayState = 'running';
  // Force reflow so the animation restarts cleanly from 0%
  void bar.offsetWidth;
  bar.style.animation = 'carouselProgressFill ' + (CAROUSEL_AUTOPLAY_MS / 1000) + 's linear forwards';
}
// reason: 'pointer' | 'hidden' | 'offscreen' — each holds independently, so
// releasing one does not restart the timer while another still holds it.
function pauseAutoSlide(reason) {
  autoSlideHolds[reason || 'pointer'] = true;
  if (autoSlideTimer) { clearInterval(autoSlideTimer); autoSlideTimer = null; }
  const bar = document.getElementById('carouselProgress');
  if (bar) bar.style.animationPlayState = 'paused';
}
function resumeAutoSlide(reason) {
  autoSlideHolds[reason || 'pointer'] = false;
  if (autoSlideTimer || autoSlideHeld()) return;
  const bar = document.getElementById('carouselProgress');
  if (bar) bar.style.animationPlayState = 'running';
  autoSlideTimer = setInterval(() => { goToSlide(currentSlide + 1); }, CAROUSEL_AUTOPLAY_MS);
}
 
// -- HERO INTERACTIONS — pause-on-hover, swipe, arrow nav (premium UX) --
(function initHeroInteractions() {
  const hero = document.getElementById('hero');
  if (!hero) return;
 
  // Hold autoplay only while the pointer is over something clickable, so
  // resting the cursor on the artwork no longer freezes the carousel.
  if (!isMzTV() && !isTouchOnly) {
    hero.addEventListener('mouseover', (e) => {
      if (e.target.closest && e.target.closest(HERO_PAUSE_ZONES)) pauseAutoSlide('pointer');
    });
    hero.addEventListener('mouseout', (e) => {
      const zone = e.target.closest && e.target.closest(HERO_PAUSE_ZONES);
      if (!zone) return;
      // Ignore moves between children of the same zone (button -> its own svg).
      if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
      resumeAutoSlide('pointer');
    });
  }
 
  // A hidden tab keeps firing setInterval, so slides raced ahead in the
  // background and the viewer came back to an arbitrary one.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAutoSlide('hidden');
    else resumeAutoSlide('hidden');
  });
 
  // Scrolled past the hero: nothing on screen to animate, and every slide
  // change repaints a full-screen backdrop (expensive on a TV chipset).
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) resumeAutoSlide('offscreen');
        else pauseAutoSlide('offscreen');
      });
    }, { threshold: 0.15 }).observe(hero);
  }
 
  // Prev / Next arrow buttons
  const prevBtn = document.getElementById('carouselPrev');
  const nextBtn = document.getElementById('carouselNext');
  if (prevBtn) prevBtn.addEventListener('click', () => { goToSlide(currentSlide - 1); resetAutoSlide(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { goToSlide(currentSlide + 1); resetAutoSlide(); });
 
  // Swipe support for touch devices
  let touchStartX = 0, touchStartY = 0;
  hero.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  hero.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
      goToSlide(currentSlide + (dx < 0 ? 1 : -1));
      resetAutoSlide();
    }
  }, { passive: true });
})();
 
/*  ══════════════════════════════════════════════════════════════════════
 *  OTT PLATFORM IDs — VERIFIED AGAINST THE LIVE TMDB API
 *  ══════════════════════════════════════════════════════════════════════
 *  TMDB keeps watch-provider ids and network ids in SEPARATE namespaces, so
 *  the same number means different things depending on the parameter. Mixing
 *  them up is silent: the query still returns 200 with the wrong catalogue.
 *
 *  Values below were read from /watch/providers/{movie,tv}?watch_region=IN
 *  and /network/{id}. Two bugs this table replaces:
 *    • provider 122 ("Hotstar") is retired and NOT offered in region IN at
 *      all, so the old JioHotstar movie query returned an empty list.
 *    • network 122 is PBS Kids (US) — the old JioHotstar show query was
 *      pulling American children's television into the section.
 *
 *  Rule of thumb: prefer with_watch_providers for "what can I stream on
 *  platform X", because a network id describes who ORIGINALLY aired a show,
 *  not who streams it now. JioHotstar licenses HBO/FOX/NBC content, so
 *  network filtering cannot describe it — provider filtering can.
 */
const OTT = {
  netflix:    { provider: '8',    regions: ['IN', 'US'], networks: '213' },
  prime:      { provider: '119',  regions: ['IN'],       networks: '1024', providerUS: '9' },
  jiohotstar: { provider: '2336', regions: ['IN'],       networks: '3919' },
  /*  Zee5 needs a language constraint and the reason is measurable. TMDB
   *  attaches ~1900 movies to provider 232 in India, but only about 2% of the
   *  popular head is actually included with a Zee5 subscription — the rest is
   *  its RENTAL storefront. Spider-Man: No Way Home, for instance, lists 232
   *  under "rent", never under "flatrate", yet TMDB's discover index still
   *  returns it for with_watch_monetization_types=flatrate. So the monetization
   *  parameter alone cannot clean this up.
   *
   *  Zee5's genuine subscription library is Indian-language cinema, and
   *  constraining to those languages measures 100% accurate against each
   *  title's own /watch/providers record (45/45 sampled) versus 2% (1/45)
   *  unconstrained. This is not a hack around the API — it is what the
   *  platform's catalogue actually is.
   */
  zee5:       { provider: '232',  regions: ['IN'],       networks: '2590|526|6989',
                langs: 'hi|ta|te|kn|ml|bn|mr|pa|gu|or' },

  /*  ── The five platforms added so their rail cards open a real catalogue ──
   *
   *  Every provider id below was READ OFF /watch/providers/{movie,tv}?
   *  watch_region=IN, not remembered, and every network id was confirmed
   *  through /network/{id}. That mattered: 2531, which this file's own
   *  STREAMING_NETWORK_IDS comment still labels "SonyLIV", actually resolves to
   *  DMAX Spain, and 4238 ("MX Player") is a 404. Both are therefore absent
   *  here — an unverified with_networks id costs a request and returns nothing.
   *
   *  `networks` is only present where the id was confirmed to be the platform's
   *  own originals channel: 2552 = Apple TV+ (Cupertino), 1112 = Crunchyroll.
   *  SonyLIV, MX Player and aha get no originals query, because their popular
   *  TMDB series carry third-party networks (SonyLIV's top series in India are
   *  anime on TV Tokyo / TV Aichi), so there is no single channel to intersect.
   *
   *  Measured catalogue depth for region IN (movies / series):
   *    apple 350        106 /  216      sonyliv 237      336 /  978
   *    mxplayer 1898    731 /  566      aha 532          199 /   14
   *    crunchyroll 283   52 /  947
   *  aha's series library really is ~14 titles — see the per-platform floor in
   *  ott-sections-check.js rather than assuming that is a bug.
   */
  apple:       { provider: '350',  regions: ['IN', 'US'], networks: '2552' },
  sonyliv:     { provider: '237',  regions: ['IN'] },
  /*  MX Player is free/ad-funded, so the default flatrate-only gate hides most
   *  of it: 575 movies + 208 series under `flatrate`, versus 731 + 566 once
   *  free and ad-supported tiers are included. ottIsOnPlatform() already
   *  accepts the free and ads tiers when verifying, so widening the gate keeps
   *  the fetch and the verification describing the same catalogue. */
  mxplayer:    { provider: '1898', regions: ['IN'], monetization: 'flatrate|free|ads' },
  aha:         { provider: '532',  regions: ['IN'] },
  crunchyroll: { provider: '283',  regions: ['IN', 'US'], networks: '1112' },

  /*  ── Five more platforms, chosen on measured data rather than brand recall ──
   *
   *  Every id here was read off /watch/providers/{movie,tv}?watch_region=IN and
   *  then run through the SHIPPED fetcher before being accepted, because the
   *  provider list is much longer than the list of providers worth a rail card.
   *  Measured for region IN (movies / series in TMDB's index, then usable cards
   *  the `all` plan actually returns, then the provider re-check rate):
   *
   *    sunnxt 309      2461 /   50   ->  77 cards, 100% verified
   *    lionsgate 561    388 /   53   ->  81 cards, 100% verified
   *    vi 614          4301 / 2316   ->  84 cards, 100% verified
   *    discoveryplus 510   1 / 992   ->  73 cards, 100% verified
   *    shemaroo 474     1111 /   0   ->  67 cards, 100% verified
   *
   *  `networks` is absent from all five deliberately: none of them has a
   *  confirmed originals channel in TMDB whose id intersects usefully with the
   *  provider filter, and an unverified with_networks id costs a request and
   *  returns nothing — the same mistake 2531 and 4238 caused above.
   *
   *  Two rejected candidates, recorded so they are not re-tried:
   *    manoramamax 482  6 usable series, too thin to sample for accuracy
   *    chaupal 2178 / erosnow 2059  exist for IN only as Amazon/Apple channel
   *      records, so their logos and catalogues are co-branded storefronts
   *
   *  hoichoi (315) and MUBI (11) were both wired here and have been removed on
   *  request. Their ids and alt-channel ids measured clean, so if either is ever
   *  wanted back the entries were: hoichoi ['315','2176'] 249/139 -> 79 cards,
   *  mubi ['11','201'] 509/5 -> 48 cards, both 100% verified, both regions ['IN'].
   */
  sunnxt:      { provider: '309',  regions: ['IN'] },
  lionsgate:   { provider: '561',  regions: ['IN'] },
  /*  No widened gate for Vi: measured, its flatrate slice is already the whole
   *  catalogue (4116 of 4301 movies, 2192 of 2316 series), so the default gate
   *  is what the numbers above were taken with. */
  vi:          { provider: '614',  regions: ['IN'] },

  /*  ── Two SINGLE-TYPE catalogues, hence the `catalogue` field ──
   *
   *  These two are the first platforms here whose Indian library is one media
   *  type only, and the numbers are not close calls — they were read straight
   *  off /discover with the platform's own gate:
   *
   *    discoveryplus 510    1 movie  /  992 series
   *    shemaroo 474      1111 movies /    0 series
   *
   *  discovery+ India is a factual/reality/kids service (Ben 10, Hell's Kitchen,
   *  Ancient Aliens, Diners Drive-Ins and Dives) and TMDB files essentially all
   *  of it as television. ShemarooMe is a Hindi/Gujarati film library and TMDB
   *  has literally zero series attached to it for IN.
   *
   *  `catalogue` makes that explicit instead of leaving it to be discovered as
   *  an empty half-grid. buildOttModeQueries() reads it and builds the
   *  single-type plan for 'all', which is the mode a rail card opens on — so the
   *  73 and 67 cards above are what the rail card actually delivers. That is
   *  not cosmetic: without it a discovery+ click spent three of its six requests
   *  on movie pages that return one title between them, and the grid was then
   *  filled from three tv queries instead of the five the webseries plan uses.
   *
   *  ottModesFor() reads the same field, so these two platforms also do not get
   *  offered a type chip that has nothing behind it.
   *
   *  ott-sections-check.js does not take this field on trust — it re-measures
   *  the missing side against TMDB and fails if a catalogue declared empty is
   *  not actually empty, so a platform that later adds films cannot sit here
   *  silently truncated.
   */
  discoveryplus: { provider: '510', regions: ['IN'], catalogue: 'tv' },
  /*  Widened gate, same reasoning as MX Player: ShemarooMe runs a free
   *  ad-supported tier, and flatrate-only sees 666 of its 1111 Indian films.
   *  ottIsOnPlatform() already accepts the free and ads tiers when verifying,
   *  so the fetch and the verification still describe the same catalogue. */
  shemaroo:      { provider: '474', regions: ['IN'], catalogue: 'movie',
                   monetization: 'flatrate|free|ads' }
};

/*  Networks that are genuinely streaming platforms, for the "Web Series" tab.
 *  The previous list carried five ids that do not resolve at all (2600, 2212,
 *  2694, 3321, 3328 all 404) plus three that resolve to unrelated broadcasters
 *  — 122 PBS Kids, 3295 Azteca Uno (MX), 3009 Imedi TV (GE) and 2583 World
 *  Fishing Network (CA). Those were injecting junk into the web-series grid.
 */
const STREAMING_NETWORK_IDS = [
  '213',   // Netflix
  '1024',  // Prime Video
  '3919',  // Disney+ Hotstar / JioHotstar originals
  '2590',  // ZEE5
  '453',   // Hulu
  '49',    // HBO
  '2552',  // Apple TV+
  '3353',  // Peacock
  '4330',  // Paramount+
  '2531',  // SonyLIV
  '4238'   // MX Player
].join('|');

// Linear Indian TV channels: daily soaps swamp the grid, so keep them out of
// the web-series view even when they carry a streaming network id as well.
const LINEAR_TV_EXCLUDE_IDS = '71|105|70|118|194|2584|3294';

/*  Platform tab queries live in buildOttModeQueries() below. An earlier
 *  ottQueries() helper was removed rather than kept as a wrapper: it predated
 *  the flatrate gate and the per-platform language scope, so any caller that
 *  reached for it would have quietly reintroduced the rental-catalogue leak.
 */

// ══════════════════════════════════════════════════════════════════════════
// OTT CONTENT MODE
// ══════════════════════════════════════════════════════════════════════════
/*  ── ALL / MOVIES / WEB SERIES SUB-TABS ──
 *
 *  A provider card opens the platform on `all`, i.e. the whole catalogue exactly
 *  as it arrived before this bar existed. The two type chips then re-run the
 *  plans buildOttModeQueries() has always had for 'movies' and 'webseries', so
 *  every platform gets the same three views from the one query builder.
 *
 *  That is a REFETCH, not a client-side filter of the `all` pool, and the
 *  difference is the point. The single-type plans spend the whole request budget
 *  on one endpoint — five /discover/movie pages instead of two, plus the US
 *  subscription page for the global platforms — so Netflix > Movies is a deep
 *  film catalogue rather than whichever half of a mixed pool happens to be films.
 *  It costs no extra requests either: ~6 per page in every mode.
 *
 *  Single-type platforms only get the chip that has something behind it. See
 *  `catalogue` in the OTT table: discovery+ has 1 film for watch_region=IN and
 *  ShemarooMe has 0 series, so offering the empty side would offer an empty grid.
 */
const OTT_MODES = [
  { id: 'all',       label: 'All',        type: null    },
  { id: 'movies',    label: 'Movies',     type: 'movie' },
  { id: 'webseries', label: 'Web Series', type: 'tv'    }
];
let currentOttMode = 'all';

/** The chips this platform can honestly offer. */
function ottModesFor(key) {
  const cfg = OTT[key];
  if (!cfg) return [];
  if (!cfg.catalogue) return OTT_MODES;
  return OTT_MODES.filter(m => !m.type || m.type === cfg.catalogue);
}

/*  ══════════════════════════════════════════════════════════════════════
 *  PLATFORM ACCURACY RULES — why every query below is provider-filtered
 *  ══════════════════════════════════════════════════════════════════════
 *  The first version of this sub-filter seeded the grid with
 *  /trending/tv/week and /trending/movie/week. Those endpoints are GLOBAL:
 *  they know nothing about watch providers, so the Netflix > Web Series tab
 *  was showing shows that are not on Netflix at all. Same for every other
 *  platform. That is the bug this block fixes.
 *
 *  The rule now: a title may only enter the grid if TMDB itself says it is
 *  streamable on that platform. Two things enforce it —
 *
 *    1. EVERY content query carries with_watch_providers + watch_region, so
 *       the catalogue is correct by construction. Nothing global is a source.
 *    2. with_watch_monetization_types=flatrate keeps rent/buy titles out.
 *       Without it, "Prime Video" pulls in the whole Amazon rental store —
 *       provider 119 is the subscription, but a title can be attached to it
 *       through a paid transaction too.
 *
 *  "Trending" and "Latest" are then expressed WITHIN that filtered
 *  catalogue: sort_by=popularity.desc is the platform's own trending signal,
 *  and a recent air/release-date window is the platform's latest. Both stay
 *  provider-scoped, so freshness never costs accuracy.
 *
 *  with_networks is additionally intersected WITH the provider filter for
 *  originals. A network id says who first aired a show, not who streams it
 *  today, so on its own it would let a cancelled-and-moved show slip in.
 */
const OTT_MONETIZATION = 'flatrate';

// Extra provider ids that are the SAME service under another billing tier
// (ad-supported plans get their own id). Verification accepts any of these.
const OTT_ALT_PROVIDERS = {
  netflix:    ['8', '1796'],   // Netflix, Netflix Standard with Ads
  prime:      ['119', '9'],    // Prime Video IN, Prime Video US
  jiohotstar: ['2336'],        // 122 is deliberately absent: retired, not offered in IN
  zee5:       ['232'],
  /*  Apple TV+ is 350. Provider 2 ("Apple TV") is the rent/buy storefront and is
   *  deliberately absent — accepting it would pass a rental off as a subscription. */
  apple:       ['350'],
  sonyliv:     ['237'],
  /*  Both ids are live in TMDB for the same rebranded service: 515 "MX Player"
   *  and 1898 "Amazon MX Player". A title may be filed under either, so
   *  verification has to accept both or it would reject titles it just fetched. */
  mxplayer:    ['1898', '515'],
  aha:         ['532'],
  crunchyroll: ['283'],
  sunnxt:      ['309'],
  /*  561 is the direct Lionsgate Play subscription; 2074 and 2053 are the same
   *  service resold as an Amazon and an Apple TV channel. A title bought through
   *  a bundle is filed under the channel id only, so all three have to be
   *  accepted or verification would reject titles the discover filter just
   *  returned. The rail card still points at the direct service. */
  lionsgate:   ['561', '2074', '2053'],
  vi:          ['614'],
  /*  510 is the direct discovery+ subscription; 584 is the same service resold
   *  as an Amazon channel, and it actually carries slightly MORE series in
   *  TMDB's Indian index (1067 vs 992). Verification accepts both for the same
   *  reason Lionsgate does — a title filed only under the channel record would
   *  otherwise be rejected right after the discover filter returned it. The
   *  fetch gate stays on 510 alone, so the rail card opens the direct service's
   *  own catalogue rather than an Amazon storefront. */
  discoveryplus: ['510', '584'],
  shemaroo:      ['474']
};

/** IST-anchored yyyy-mm-dd, optionally shifted by days. */
function ottISTDate(offsetDays) {
  const d = new Date(Date.now() + (5.5 * 60 * 60 * 1000) + ((offsetDays || 0) * 86400000));
  return d.toISOString().split('T')[0];
}

/**
 * OTT mode ke hisaab se queries. Har query provider-filtered hai, isliye
 * jo bhi aata hai wo us platform ka hi hota hai — trending aur latest bhi
 * usi filtered catalogue ke andar se nikalte hain.
 */
function buildOttModeQueries(key, mode, page) {
  const cfg = OTT[key];
  if (!cfg) return [];
  /*  Single-type catalogues (see `catalogue` in the OTT table). The UI only ever
   *  opens 'all', and for a platform that has no films — or no series — half of
   *  the 'all' plan is requests that return nothing. Remapping to the
   *  single-type plan spends the same request budget on the type that exists,
   *  and it is the plan the check suite already exercises. The explicit
   *  'webseries' / 'movies' modes are left alone: they are what ott-sections-
   *  check.js uses to re-measure that the declared-empty side really is empty. */
  if (mode === 'all' && cfg.catalogue) {
    mode = cfg.catalogue === 'tv' ? 'webseries' : 'movies';
  }
  const p1 = String(page * 2 - 1);
  const p2 = String(page * 2);
  const pg = String(page);
  const today = ottISTDate(0);

  // The provider gate every single query inherits.
  const gate = {
    with_watch_providers: cfg.provider,
    watch_region: 'IN',
    /*  Per-platform, defaulting to flatrate. A free/ad-funded service filed
     *  under flatrate only exposes a fraction of its library, so those get a
     *  wider gate (see `monetization` in the OTT table). Rent and buy are never
     *  included by any platform — that is the whole point of gating at all. */
    with_watch_monetization_types: cfg.monetization || OTT_MONETIZATION,
    language: 'en-US'
  };
  // Platforms whose subscription catalogue is language-scoped (see OTT table).
  if (cfg.langs) gate.with_original_language = cfg.langs;
  const q = [];
  // tag: drives scoring in fetchOttMovies — 'trend' | 'latest' | 'top' | 'core'
  const push = (endpoint, type, params, tag) =>
    q.push({ endpoint, type, tag, params: Object.assign({}, gate, params) });

  if (mode === 'webseries') {
    // TRENDING on this platform: most popular series in its own catalogue.
    push('/discover/tv', 'tv', { sort_by: 'popularity.desc', page: p1 }, 'trend');
    push('/discover/tv', 'tv', { sort_by: 'popularity.desc', page: p2 }, 'core');
    // LATEST: aired in the last 120 days, popular first (not date-sorted, so
    // obscure filler does not outrank the real new releases).
    push('/discover/tv', 'tv', {
      sort_by: 'popularity.desc',
      'first_air_date.gte': ottISTDate(-120), 'first_air_date.lte': today, page: pg
    }, 'latest');
    // NEWEST: strictly newest first, with a small vote floor to skip junk.
    push('/discover/tv', 'tv', {
      sort_by: 'first_air_date.desc', 'first_air_date.lte': today,
      'vote_count.gte': '5', page: pg
    }, 'latest');
    // PROVEN HITS: deep catalogue by vote volume.
    push('/discover/tv', 'tv', { sort_by: 'vote_count.desc', page: p1 }, 'top');
    // ORIGINALS: network AND provider, so it is "their original, still on
    // their platform" rather than "their original, wherever it lives now".
    if (cfg.networks) {
      push('/discover/tv', 'tv', { with_networks: cfg.networks, sort_by: 'popularity.desc', page: p1 }, 'core');
    }
  } else if (mode === 'movies') {
    // TRENDING on this platform.
    push('/discover/movie', 'movie', { sort_by: 'popularity.desc', page: p1 }, 'trend');
    push('/discover/movie', 'movie', { sort_by: 'popularity.desc', page: p2 }, 'core');
    // LATEST: released in the last 120 days, popular first.
    push('/discover/movie', 'movie', {
      sort_by: 'popularity.desc',
      'primary_release_date.gte': ottISTDate(-120), 'primary_release_date.lte': today, page: pg
    }, 'latest');
    // NEWEST first, vote floor to skip junk.
    push('/discover/movie', 'movie', {
      sort_by: 'primary_release_date.desc', 'primary_release_date.lte': today,
      'vote_count.gte': '10', page: pg
    }, 'latest');
    // PROVEN HITS.
    push('/discover/movie', 'movie', { sort_by: 'vote_count.desc', page: p1 }, 'top');
    // US subscription catalogue for the global platforms — still provider-gated.
    if (cfg.regions.includes('US')) {
      push('/discover/movie', 'movie', {
        with_watch_providers: cfg.providerUS || cfg.provider, watch_region: 'US',
        sort_by: 'popularity.desc', page: p1
      }, 'core');
    }
  } else {
    // 'all' — both types, provider-gated, trending + latest of each on top.
    push('/discover/tv', 'tv', { sort_by: 'popularity.desc', page: p1 }, 'trend');
    push('/discover/movie', 'movie', { sort_by: 'popularity.desc', page: p1 }, 'trend');
    push('/discover/tv', 'tv', { sort_by: 'popularity.desc', page: p2 }, 'core');
    push('/discover/movie', 'movie', { sort_by: 'popularity.desc', page: p2 }, 'core');
    push('/discover/tv', 'tv', {
      sort_by: 'popularity.desc',
      'first_air_date.gte': ottISTDate(-120), 'first_air_date.lte': today, page: pg
    }, 'latest');
    push('/discover/movie', 'movie', {
      sort_by: 'popularity.desc',
      'primary_release_date.gte': ottISTDate(-120), 'primary_release_date.lte': today, page: pg
    }, 'latest');
    if (cfg.networks) {
      push('/discover/tv', 'tv', { with_networks: cfg.networks, sort_by: 'popularity.desc', page: p1 }, 'core');
    }
  }
  return q;
}

/*  Verified-trending cross-check.
 *  The provider-filtered pages above are accurate but ordered by TMDB's
 *  popularity score, which moves slower than what is actually trending this
 *  week. So we ask the global trending list what is hot, then keep only the
 *  entries TMDB confirms are streaming on THIS platform, via each title's
 *  own /watch/providers record. Unverified titles are discarded, never shown.
 *  Bounded to the top slice and memoised, so it costs a handful of cached
 *  requests rather than one per card.
 */
const _ottVerifyCache = new Map();

/*  ══════════════════════════════════════════════════════════════════════
 *  WHY THE OTT SECTIONS USED TO ARRIVE LATE
 *  ══════════════════════════════════════════════════════════════════════
 *  Opening Netflix / Prime / JioHotstar needed roughly 35 separate TMDB
 *  requests before the first card could paint, and — worse — they arrived in
 *  three DEPENDENT waves, because each wave's URLs are only known once the
 *  previous one has answered:
 *
 *    wave 1  6-7 provider-gated /discover pages + 2 global /trending lists
 *    wave 2  up to 20 /watch/providers lookups (verifying the trending titles)
 *    wave 3  10 /watch/providers lookups (the accuracy spot-check on the head)
 *
 *  Sent one by one through the 8-lane concurrency gate that is ~6 sequential
 *  rounds, each one a full network round trip, and 35 requests also eats the
 *  entire 30-per-10s client rate budget — so a user who opened two platforms in
 *  a row hit _mzRateDelayMs() and waited on a sleep, not on the network.
 *
 *  Meanwhile the homepage had already solved this: tmdbBatch() posts the whole
 *  plan to the Worker's /api/tmdb/batch, which fans out at the edge next to
 *  TMDB and its KV cache, and returns everything in one response. The OTT path
 *  simply never used it.
 *
 *  It does now, and that is the entire fix — one batch per wave, so 35 requests
 *  in ~6 rounds becomes 3 requests in 3 rounds. Nothing about WHICH endpoints
 *  are called, or how results are scored, filtered or ordered, changes: the
 *  batch only PRIMES tmdbCache, and the existing code below then runs exactly as
 *  it did, reading memory instead of the network. Same grid, same order.
 */

/*  Warms tmdbCache for a whole list of endpoints in one request.
 *
 *  Deliberately tolerant, because this is an optimisation and never a
 *  requirement:
 *    - `typeof tmdbBatch` is guarded rather than assumed. The OTT functions are
 *      extracted and run in a bare VM sandbox by ott-sections-check.js, where no
 *      batching exists; there they fall through to the per-endpoint requests
 *      that this replaced.
 *    - tmdbBatch() itself already falls back to individual requests when the
 *      Worker is absent (localhost, old deploy, 404), so there is nothing to
 *      detect or configure.
 *    - a throw here must never lose the section, hence the swallow.
 *
 *  Chunked at 40 because the Worker rejects a larger batch (MAX_BATCH_PATHS),
 *  and the chunks go out together — chunking sequentially would rebuild the
 *  very wave structure this exists to remove.
 */
async function _ottPrimeBatch(pairs) {
  if (typeof tmdbBatch !== 'function') return;
  if (!pairs || pairs.length < 2) return;      // one URL is not worth a batch
  const CHUNK = 40;
  const chunks = [];
  for (let i = 0; i < pairs.length; i += CHUNK) chunks.push(pairs.slice(i, i + CHUNK));
  try {
    await Promise.all(chunks.map(c => tmdbBatch(c)));
  } catch (e) {
    /* batching is best-effort; the callers' own requests still run */
  }
}

/*  Warms the /watch/providers records for a set of titles.
 *
 *  Titles already in _ottVerifyCache are skipped: that cache holds the in-flight
 *  or settled promise, so asking for them again would put URLs in the batch that
 *  nobody is waiting on. This is why the accuracy spot-check usually costs
 *  nothing — the trending pass has already verified most of the head.
 */
async function _ottPrimeProviders(key, items) {
  const seen = new Set();
  const pairs = [];
  (items || []).forEach(m => {
    if (!m || !m.media_type || !m.id) return;
    const cacheKey = key + ':' + m.media_type + ':' + m.id;
    if (_ottVerifyCache.has(cacheKey) || seen.has(cacheKey)) return;
    seen.add(cacheKey);
    pairs.push(['/' + m.media_type + '/' + m.id + '/watch/providers', {}]);
  });
  await _ottPrimeBatch(pairs);
}

/*  Returns true / false / null.
 *
 *  The null is the important part. An earlier version returned false when the
 *  request failed, which reads as "not on this platform" — so a rate-limited
 *  or offline user would have perfectly valid titles filtered out of the grid.
 *  Errors and missing provider data are now reported as "unknown" and every
 *  caller fails open on them. Only a provider record that genuinely lacks the
 *  platform counts as a false.
 */
async function ottIsOnPlatform(key, type, id) {
  const cacheKey = key + ':' + type + ':' + id;
  if (_ottVerifyCache.has(cacheKey)) return _ottVerifyCache.get(cacheKey);
  const accept = OTT_ALT_PROVIDERS[key] || [OTT[key] && OTT[key].provider];
  const regions = (OTT[key] && OTT[key].regions) || ['IN'];

  const p = (async () => {
    let data;
    try {
      data = await tmdb('/' + type + '/' + id + '/watch/providers', {});
    } catch (e) {
      return null;                       // network / rate limit — unknown
    }
    const results = data && data.results;
    if (!results || !Object.keys(results).length) return null;  // no data at all

    for (const region of regions) {
      const entry = results[region];
      if (!entry) continue;
      // flatrate / free / ads = included with the subscription. rent and buy
      // are deliberately ignored: a rental is not "on the platform".
      const tiers = [].concat(entry.flatrate || [], entry.free || [], entry.ads || []);
      if (tiers.some(pv => pv && accept.includes(String(pv.provider_id)))) return true;
    }
    return false;
  })();

  _ottVerifyCache.set(cacheKey, p);
  // Never let an inconclusive answer stick in the cache, otherwise one bad
  // minute poisons the whole session.
  p.then(v => { if (v === null) _ottVerifyCache.delete(cacheKey); }).catch(() => {
    _ottVerifyCache.delete(cacheKey);
  });
  return p;
}

/** Global trending, filtered down to titles verified on this platform. */
/*  Adaptive accuracy guard.
 *  The provider gate plus the per-platform language scope measures 100%
 *  accurate today, so verifying every card would be wasted requests. But TMDB
 *  provider data does drift — the Zee5 rental leak is exactly that kind of
 *  drift — so instead of trusting it blindly we spot-check a small sample of
 *  the head. Clean sample: ship the list untouched, cost is a handful of
 *  cached requests. Dirty sample: verify the whole pool and drop anything the
 *  platform does not actually stream, so the section self-heals rather than
 *  silently showing wrong titles again.
 */
const OTT_SAMPLE_SIZE = 10;
const OTT_SAMPLE_MIN_PASS = 0.9;
const OTT_DEEP_VERIFY_CAP = 90;

/*  Platforms whose provider gate has already been audited this session. See the
 *  comment at the end of fetchOttMovies for why this is once-per-platform. */
const _ottAudited = new Set();

async function ottEnforceAccuracy(key, items) {
  if (items.length < 4) return items;

  const sample = items.slice(0, OTT_SAMPLE_SIZE);
  await _ottPrimeProviders(key, sample);
  const sampleVerdicts = await Promise.all(
    sample.map(m => ottIsOnPlatform(key, m.media_type, m.id).catch(() => null))
  );
  const known = sampleVerdicts.filter(v => v !== null);
  // Nothing conclusive (offline / TMDB hiccup) — fail open, an empty grid is
  // worse than an unverified one.
  if (known.length < 4) return items;

  const passRate = known.filter(v => v === true).length / known.length;
  if (passRate >= OTT_SAMPLE_MIN_PASS) return items;

  // Sample was dirty: verify for real and keep only confirmed titles.
  const head = items.slice(0, OTT_DEEP_VERIFY_CAP);
  await _ottPrimeProviders(key, head);
  const verdicts = await Promise.all(
    head.map(m => ottIsOnPlatform(key, m.media_type, m.id).catch(() => null))
  );
  const kept = head.filter((m, i) => verdicts[i] !== false);
  console.warn('[OTT] ' + key + ': provider data looks polluted ('
    + Math.round(passRate * 100) + '% of sample on-platform) — kept '
    + kept.length + '/' + head.length + ' after verification');
  return kept;
}

/**
 * Fetch this platform's content for the active mode. Everything returned is
 * provider-verified; trending and latest are boosted to the top of the grid.
 */
async function fetchOttMovies(key, mode, page) {
  const plan = buildOttModeQueries(key, mode, page);
  if (!plan.length) return [];

  /*  Everything the first render needs, in ONE request: the provider-gated
   *  catalogue pages. Only primes the cache — the calls below are unchanged and
   *  now hit memory. */
  await _ottPrimeBatch(plan.map(p => [p.endpoint, p.params]));

  /*  ── WHY THERE IS NO GLOBAL-TRENDING OVERLAY HERE ANY MORE ──
   *
   *  This used to also await ottVerifiedTrending(), which read /trending/tv/week
   *  and /trending/movie/week and then checked each candidate against its own
   *  /watch/providers record. Measured, that was the whole performance problem:
   *
   *    buildOttModeQueries        1 ms
   *    _ottPrimeBatch          5604 ms
   *    ottVerifiedTrending     9986 ms   <-- and no single request was slow
   *    the 6 discover calls       0 ms   (already primed)
   *
   *  A platform click was issuing ~50 requests, of which only 6 were catalogue
   *  and ~44 were verification, against a deliberate client cap of 30 requests
   *  per 10 seconds (MZ_RATE_LIMIT). The requests were not slow; they were
   *  QUEUED. Proof: requests per 10s window came out as [30, 20] — exactly the
   *  cap — for a 14s paint.
   *
   *  The overlay was also the only provider-BLIND source in this function. Its
   *  job was to catch a platform hit that TMDB's discover index missed, but if a
   *  title really is on the platform then the plan's own popularity.desc query —
   *  which is provider-gated and tagged 'trend' — already returns it. So it was
   *  paying ~44 requests to duplicate what 2 gated requests give for free, and
   *  the verification that made up most of those requests existed only because
   *  the overlay's own results could not be trusted.
   *
   *  Dropping it takes a cold click from ~50 requests to ~16 and, because the
   *  remaining pool is gated end to end, costs nothing in accuracy:
   *  ott-sections-check re-checks a sample of what this returns against each
   *  title's own /watch/providers record and all nine platforms measure 100%.
   */
  const res = await Promise.allSettled(plan.map(p => tmdb(p.endpoint, p.params)));

  const TAG_BOOST = { trend: 6000, latest: 4200, top: 1200, core: 0 };
  const picked = new Map();

  const consider = (raw, type, tag, extra) => {
    if (!raw || !raw.poster_path || !raw.id) return;
    // Mode gate: Web Series tab me sirf series, Movies tab me sirf movies.
    if (mode === 'webseries' && type !== 'tv') return;
    if (mode === 'movies' && type !== 'movie') return;
    const item = Object.assign({}, raw);
    item.media_type = type;
    const k = type + '-' + item.id;

    let score = Math.min(item.popularity || 0, 500) * 8;
    score += TAG_BOOST[tag] || 0;
    score += extra || 0;
    const v = item.vote_count || 0;
    if (v > 0) score += Math.log10(v + 1) * 400;
    // Freshness bonus computed from the title's own date, so a genuinely new
    // release ranks high no matter which query surfaced it.
    const d = item.first_air_date || item.release_date;
    if (d) {
      const ageDays = (Date.now() - new Date(d).getTime()) / 86400000;
      if (ageDays >= 0 && ageDays <= 30) score += 2500;
      else if (ageDays > 30 && ageDays <= 120) score += 1200;
    }

    const prev = picked.get(k);
    if (!prev || score > prev._ottScore) {
      item._ottScore = score;
      picked.set(k, item);
    }
  };

  res.forEach((r, idx) => {
    const list = (r.status === 'fulfilled' && r.value && r.value.results) ? r.value.results : [];
    const src = plan[idx];
    list.forEach(raw => consider(raw, src.type, src.tag));
  });

  // The plan's own popularity.desc queries are tagged 'trend' and are already
  // provider-gated, so this platform's hot titles are in `picked` above.

  const ranked = Array.from(picked.values()).sort((a, b) => b._ottScore - a._ottScore);

  /*  ── ACCURACY IS AUDITED ONCE PER PLATFORM, NOT PER CLICK ──
   *
   *  ottEnforceAccuracy samples the head and re-checks each title against its own
   *  /watch/providers record. That mattered when this function also merged the
   *  global-trending overlay, because the overlay was provider-BLIND and could
   *  genuinely return titles that are not on the platform. The overlay is gone, so
   *  every title in `ranked` arrived through with_watch_providers already.
   *
   *  Two changes, both forced by the same measurement. Against a 30-request per
   *  10-second client cap (MZ_RATE_LIMIT), a 10-request sample on the blocking path
   *  was enough on its own to push the next click into a queue:
   *    - it is no longer awaited, so it cannot delay the grid;
   *    - it runs at most once per platform per session, because re-auditing the
   *      same provider gate on every click spends a third of the rate budget to
   *      re-confirm something that has not changed.
   *  It still warms _ottVerifyCache and still logs a platform that goes bad, and
   *  ott-sections-check re-checks a live sample of exactly what is returned here
   *  and fails below 90% — currently 100% on all nine platforms.
   */
  if (!_ottAudited.has(key)) {
    _ottAudited.add(key);
    ottEnforceAccuracy(key, ranked.slice(0, OTT_SAMPLE_SIZE)).catch(() => {});
  }
  return ranked;
}

function updateOttHeading(cat) {
  const h = document.getElementById('sectionHeading');
  if (!h) return;
  const base = CAT_HEADINGS[cat] || cat.toUpperCase();
  const mode = OTT_MODES.find(m => m.id === currentOttMode);
  h.textContent = (mode && mode.id !== 'all') ? base + ' • ' + mode.label.toUpperCase() : base;
}

/*  ══════════════════════════════════════════════════════════════════════
 *  THE DIVIDER BETWEEN THE CATEGORY STRIP AND ITS SUB-FILTER RAIL
 *  ══════════════════════════════════════════════════════════════════════
 *  The three sub-bars (OTT platform types, anime modes, cartoon modes) are a
 *  SECOND row of controls under the category strip, and with nothing between
 *  them the two rows read as one undifferentiated field of pills. A hairline
 *  with a small gold lozenge on the centre line separates them, and lines up
 *  with the centred banner and the centred rail either side of it.
 *
 *  It is a sibling of #catTabs, not a child: on phones that row is a horizontal
 *  scroller, and a scroll container clips its descendants on both axes.
 *
 *  It is created lazily rather than sitting in index.html because it is only
 *  ever wanted while a sub-bar is on screen — see syncCatFilterSeparator().
 *
 *  Returns null only when #catTabs is absent (the SSR category pages), which is
 *  why every caller treats it as optional.
 */
function ensureCatFilterSep() {
  const catTabs = document.getElementById('catTabs');
  if (!catTabs) return null;
  let sep = document.getElementById('catFilterSep');
  if (!sep) {
    sep = document.createElement('div');
    sep.id = 'catFilterSep';
    sep.className = 'cat-filter-sep';
    sep.setAttribute('aria-hidden', 'true');   // decoration, not structure
    catTabs.insertAdjacentElement('afterend', sep);
  }
  return sep;
}

/*  Visibility is DERIVED, never toggled by hand.
 *
 *  filterCat() runs all three bars' show/hide in sequence on every category
 *  change, so any single caller only knows about its own bar — asking each of
 *  them to also decide the divider's state would mean the last one to run wins,
 *  and on a platform tab (hide anime → hide cartoon → show OTT) that ordering is
 *  luck. Reading the DOM instead makes the answer correct whoever calls it and
 *  in whatever order: the divider is shown if, and only if, one of the bars is
 *  actually displayed. A hairline under the tabs with nothing beneath it would
 *  just look like a stray rule.
 *
 *  The bars are toggled with inline display (none / flex), which is what is
 *  read here — no getComputedStyle, so this is layout-read free and safe to
 *  call as often as it likes.
 */
function syncCatFilterSeparator() {
  const sep = document.getElementById('catFilterSep');
  if (!sep) return;
  const anyBarShown = ['ottFilterBar', 'animeFilterBar', 'cartoonFilterBar'].some(id => {
    const bar = document.getElementById(id);
    return !!bar && bar.style.display && bar.style.display !== 'none';
  });
  sep.style.display = anyBarShown ? 'block' : 'none';
}

/*  ── OTT SUB-FILTER BAR (All / Movies / Web Series) ──
 *
 *  Same host and geometry as the anime and cartoon bars: injected once, right
 *  after the divider, so the chips sit under the category strip and above the grid.
 *  It reuses .anime-chip so there is one chip style to maintain rather than
 *  three, with .ott-filter-bar carrying only the colour difference.
 *
 *  Only one of the three sub-bars is ever visible, because filterCat() hides the
 *  other two on every category change.
 */
function renderOttFilterBar(cat) {
  const catTabs = document.getElementById('catTabs');
  if (!catTabs) return;
  let bar = document.getElementById('ottFilterBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ottFilterBar';
    bar.className = 'anime-filter-bar ott-filter-bar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Platform content type');
    //  After the divider, so the DOM order is: strip → divider → rail.
    (ensureCatFilterSep() || catTabs).insertAdjacentElement('afterend', bar);
  }
  const modes = ottModesFor(cat);
  //  Fewer than two chips means there is nothing to choose between — a
  //  single-type platform, where "All" and its one type are the same grid.
  if (modes.length < 2) { bar.style.display = 'none'; syncCatFilterSeparator(); return; }
  bar.innerHTML = modes.map(m => {
    const active = m.id === currentOttMode;
    return '<button type="button" class="anime-chip ott-chip' + (active ? ' active' : '') +
      '" role="tab" tabindex="0" aria-selected="' + active +
      '" onclick="setOttMode(\'' + m.id + '\')">' + m.label + '</button>';
  }).join('');
  bar.style.display = 'flex';
  syncCatFilterSeparator();
}

function hideOttFilterBar() {
  const bar = document.getElementById('ottFilterBar');
  if (bar) bar.style.display = 'none';
  syncCatFilterSeparator();
}

/*  Switching type is a different pool, so loadMovies() is called WITHOUT
 *  isLoadMore: that clears allMovies and resets the pager to page 1. Without the
 *  reset the user would land on page 4 of a catalogue that may not have four
 *  pages, and the pool would hold both types at once.
 *
 *  The category comes from mzFeedPagerCategory rather than a captured argument,
 *  for the same reason currentFeedCategory() prefers it: a platform has no
 *  .cat-tab, so that variable is the only authoritative record of what is open.
 */
function setOttMode(mode) {
  const cat = mzFeedPagerCategory;
  if (!OTT[cat]) return;
  if (!ottModesFor(cat).some(m => m.id === mode)) mode = 'all';
  if (mode === currentOttMode) return;
  currentOttMode = mode;
  renderOttFilterBar(cat);
  updateOttHeading(cat);
  loadMovies(cat);
}

/*  ══════════════════════════════════════════════════════════════════════
 *  ONE PLAN PER CATEGORY, IN ONE PLACE
 *  ══════════════════════════════════════════════════════════════════════
 *  The set of TMDB sources a category needs used to be written out twice: once
 *  inside loadMovies() as Promise.all([tmdb(...), ...]) and once here as a
 *  fire-and-forget prefetch. Two copies drift, and both had — `dubbed`
 *  prefetched four sources while loadMovies asked for five, so its second
 *  English page was never actually warm, and the ALL plan was ordered
 *  differently in the two places.
 *
 *  One builder now returns the endpoint+params pairs, and three callers use it:
 *
 *    • loadMovies() sends the whole plan to /api/tmdb/batch as ONE request.
 *      Only the ALL feed was batched before; every other tab issued 2-8
 *      individual requests through the 8-lane concurrency gate, and on mobile
 *      each lane-round costs a full radio round-trip before a card can paint.
 *    • prefetchMoviesPage() warms the next page — also one request now, instead
 *      of spending up to 16 of the 30-per-10s rate budget on individual calls.
 *    • _mzPrefetchCategory() warms a tab on hover/touch, which is only possible
 *      at all because a plan is now addressable by category name.
 *
 *  ── ORDER AND KEY ORDER ARE BOTH LOAD-BEARING ──
 *  _mzTmdbUrl() builds the cache key with Object.entries(params), so the
 *  INSERTION ORDER of every params object decides the URL and therefore the
 *  cache key. The orders here are the ones the old call sites used, character
 *  for character; changing one silently orphans every cached copy of it.
 *  Array order matters too — see TV_SOURCE_FROM in loadMovies.
 *
 *  Returns null for the categories that own their own fan-out (the OTT
 *  platforms, which prime through _ottPrimeBatch and are deliberately never
 *  speculatively warmed).
 */
function _mzCatPlan(cat, pageNum) {
  const pageStr = String(pageNum);
  const p1 = String(pageNum * 2 - 1);
  const p2 = String(pageNum * 2);
  const L = 'en-US';
  const POP = 'popularity.desc';

  if (cat === 'all') {
    // NETFLIX-STYLE DISCOVERY: diverse sources for maximum content freshness.
    //   • LATEST WINDOWS — the most popular movies (last ~5 weeks), web series
    //     (~6 weeks) and anime seasons (~2 months), so whatever just released is
    //     in the pool rather than whatever /movie/popular happens to return.
    //   • INDUSTRY WINDOWS — the same window per industry, because a single
    //     global popularity sort is always won by Hollywood.
    //   • PRINT-UPGRADE WINDOWS — the cohorts that just crossed a real print
    //     stage, so a four-month-old film whose HD print just dropped can
    //     surface at all.
    return [
      ['/movie/now_playing', { language: L, page: pageStr }],
      ['/trending/movie/week', { language: L, page: pageStr }],
      ['/trending/movie/day', { language: L, page: pageStr }],
      ['/movie/popular', { language: L, page: pageStr }],
      ['/discover/movie', { with_original_language: 'ko', sort_by: POP, page: pageStr, language: L }],
      ['/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: POP, page: pageStr, language: L }],
      ['/discover/movie', latestWindowQuery(pageStr)],
      ['/discover/movie', printUpgradeWindowQuery(pageStr)],
      ['/discover/movie', latestIndianWindowQuery(pageStr)],
      ['/discover/movie', latestBollywoodWindowQuery(pageStr)],
      ['/discover/movie', indianUpgradeWindowQuery(pageStr)],
      ['/discover/movie', indianCatalogueQuery(pageStr)],
      // ── index 12 onward is TV; TV_SOURCE_FROM in loadMovies must match ──
      ['/trending/tv/week', { language: L, page: pageStr }],
      ['/discover/tv', latestSeriesWindowQuery(pageStr)],
      ['/discover/tv', seriesUpgradeWindowQuery(pageStr)],
      ['/discover/tv', latestAnimeWindowQuery(pageStr)]
    ];
  }

  if (cat === 'tv') {
    // Web series only: streaming networks in, traditional Indian TV channels out.
    const N = STREAMING_NETWORK_IDS;
    const X = LINEAR_TV_EXCLUDE_IDS;
    return [
      ['/discover/tv', { with_networks: N, without_networks: X, with_original_language: 'hi', sort_by: POP, page: pageStr, language: L }],
      ['/discover/tv', { with_networks: N, without_networks: X, with_original_language: 'en', sort_by: POP, page: pageStr, language: L }],
      ['/discover/tv', { with_networks: N, without_networks: X, with_original_language: 'ko', sort_by: POP, page: pageStr, language: L }],
      ['/discover/tv', { with_networks: N, without_networks: X, sort_by: POP, page: pageStr, language: L }],
      /*  Fresh Indian premieres, as a dated window rather than a popularity page.
       *
       *  The Hindi source above is sorted by popularity, which surfaces the
       *  long-running favourites — Mirzapur, Panchayat — and buries the show that
       *  dropped last week somewhere on page three. So the ranking never saw a
       *  fresh Hindi series to put in the latest group, and the first screen came
       *  out Korean and English (measured: 7 ko / 5 en, zero hi).
       *
       *  Pipe-separated languages is the same OR form the Zee5 provider gate uses.
       *  The vote floor is deliberately lower than SERIES_MIN_VOTES: an Indian
       *  premiere collects a fraction of an English one's votes in week one, which
       *  is the whole reason the regional relevance floor exists. */
      ['/discover/tv', { with_networks: N, without_networks: X,
        with_original_language: 'hi|ta|te', sort_by: POP,
        'first_air_date.gte': istDateStr(LATEST_SERIES_WINDOW_DAYS),
        'first_air_date.lte': istDateStr(0),
        'vote_count.gte': '3', page: pageStr, language: L }]
    ];
  }

  if (cat === 'hollywood') {
    return [
      ['/discover/movie', { with_original_language: 'en', sort_by: POP, language: L, page: p1 }],
      ['/discover/movie', { with_original_language: 'en', sort_by: POP, language: L, page: p2 }]
    ];
  }

  // Both engines own their own source lists; the plan is taken from the very
  // same builder they use so the cache keys match byte for byte.
  if (cat === 'kids') return buildCartoonQueries(currentCartoonMode, pageNum).map(q => [q.endpoint, q.params]);
  if (cat === 'anime') return buildAnimeQueries(currentAnimeMode, pageNum).map(q => [q.endpoint, q.params]);

  if (cat === 'horror') {
    return [
      ['/discover/movie', { with_genres: '27', sort_by: POP, page: p1, language: L }],                                 // Global
      ['/discover/movie', { with_genres: '27', with_original_language: 'hi', sort_by: POP, page: p1, language: L }],   // Bollywood
      ['/discover/movie', { with_genres: '27', with_original_language: 'ta', sort_by: POP, page: p1, language: L }],   // Tamil
      ['/discover/movie', { with_genres: '27', with_original_language: 'te', sort_by: POP, page: p1, language: L }]    // Telugu
    ];
  }

  if (cat === 'dubbed') {
    // Hindi-dubbed ki supply Hollywood + Tamil + Telugu + Japanese anime se aati
    // hai, so those are the four industries worth asking for.
    return [
      ['/discover/movie', { with_original_language: 'en', sort_by: POP, language: L, page: p1 }],
      ['/discover/movie', { with_original_language: 'en', sort_by: POP, language: L, page: p2 }],
      ['/discover/movie', { with_original_language: 'ta', sort_by: POP, language: L, page: p1 }],
      ['/discover/movie', { with_original_language: 'te', sort_by: POP, language: L, page: p1 }],
      ['/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: POP, language: L, page: p1 }]
    ];
  }

  if (cat === 'adult') {
    const KW = '9799|195669|156321';
    const NO_MOVIE = '16,10751,28,12,35,878';
    return [
      ['/discover/movie', { include_adult: 'true', with_keywords: KW, without_genres: NO_MOVIE, sort_by: POP, page: p1, language: L }],
      ['/discover/tv', { include_adult: 'true', with_keywords: KW, without_genres: '16,10751,10759,10762,35', sort_by: POP, page: p1, language: L }],
      ['/discover/movie', { include_adult: 'true', with_keywords: KW, with_original_language: 'hi', without_genres: NO_MOVIE, sort_by: POP, page: p1, language: L }],
      ['/discover/movie', { include_adult: 'true', with_keywords: KW, with_original_language: 'ta', without_genres: NO_MOVIE, sort_by: POP, page: p1, language: L }],
      ['/discover/movie', { include_adult: 'true', with_keywords: KW, with_original_language: 'te', without_genres: NO_MOVIE, sort_by: POP, page: p1, language: L }],
      ['/discover/movie', { include_adult: 'true', certification_country: 'US', certification: 'NC-17', sort_by: POP, page: p1, language: L }]
    ];
  }

  if (cat === 'trending') {
    return [
      ['/trending/movie/week', { language: L, page: p1 }],
      ['/trending/movie/day', { language: L, page: pageStr }],
      ['/trending/tv/week', { language: L, page: pageStr }],
      ['/discover/movie', { with_original_language: 'hi', sort_by: POP, 'vote_count.gte': '50', page: pageStr, language: L }]
    ];
  }

  if (cat === 'uhd4k') {
    /*  In this app "quality" is decided by release date: a title 240+ days old
     *  with a real rating cannot still be a CAM/TS print. Eight languages so the
     *  round-robin below has something to mix. */
    const uhdCutoff = new Date(Date.now() - 240 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const B = { sort_by: POP, 'primary_release_date.lte': uhdCutoff, 'vote_average.gte': '7', language: L };
    return [
      ['/discover/movie', Object.assign({}, B, { with_original_language: 'en', 'vote_count.gte': '300', page: p1 })],
      ['/discover/movie', Object.assign({}, B, { with_original_language: 'en', 'vote_count.gte': '300', page: p2 })],
      ['/discover/movie', Object.assign({}, B, { with_original_language: 'hi', 'vote_count.gte': '40', page: p1 })],
      ['/discover/movie', Object.assign({}, B, { with_original_language: 'hi', 'vote_count.gte': '40', page: p2 })],
      ['/discover/movie', Object.assign({}, B, { with_original_language: 'te', 'vote_count.gte': '30', page: p1 })],
      ['/discover/movie', Object.assign({}, B, { with_original_language: 'ta', 'vote_count.gte': '30', page: p1 })],
      ['/discover/movie', Object.assign({}, B, { with_original_language: 'ko', 'vote_count.gte': '60', page: p1 })],
      ['/discover/movie', Object.assign({}, B, { with_original_language: 'ml', 'vote_count.gte': '25', page: p1 })]
    ];
  }

  if (cat === 'toprated') {
    return [
      ['/movie/top_rated', { language: L, page: p1 }],
      ['/movie/top_rated', { language: L, page: p2 }],
      ['/discover/movie', { with_original_language: 'hi', sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: p1, language: L }],
      ['/discover/tv', { sort_by: 'vote_average.desc', 'vote_count.gte': '300', page: p1, language: L }]
    ];
  }

  /*  K-DRAMA — Korean web series only.
   *
   *  This used to carry a third source, ['/discover/movie', ko], and the branch in
   *  loadMovies tagged that one index as 'movie'. It meant Korean FILMS landed on
   *  a tab called K-Drama — Parasite opened the grid — which is not what the tab
   *  promises. Korean cinema is still reachable: it is in the ALL feed, in the
   *  genre tabs and through search.
   *
   *  Three pages of series instead of two, so dropping the movie source does not
   *  cost the tab any depth. Broadcast networks (tvN, SBS, KBS, JTBC) are
   *  deliberately NOT excluded here — unlike the Web Series tab, a K-drama airing
   *  on a Korean channel is exactly what the user came for. */
  if (cat === 'kdrama') {
    const KO = { with_original_language: 'ko', sort_by: POP, language: L };
    return [
      ['/discover/tv', Object.assign({}, KO, { page: p1 })],
      ['/discover/tv', Object.assign({}, KO, { page: p2 })],
      ['/discover/tv', Object.assign({}, KO, { page: String(pageNum * 3) })]
    ];
  }

  /*  TOLLYWOOD — the merged South Indian tab.
   *
   *  This used to be two separate tabs: 'south' (Tamil only) on the strip and
   *  'tollywood' (Telugu only) hidden in the Category dropdown. They are one tab
   *  now, so the pool has to carry both industries plus the two that were never
   *  covered at all, Malayalam and Kannada.
   *
   *  It has to be a multi-request plan: TMDB's with_original_language takes a
   *  single code and has no OR form, so one request per language is the only way
   *  to get a genuine merge. That costs nothing extra in practice — tmdbBatch()
   *  sends the whole plan as ONE POST to /api/tmdb/batch, exactly like the
   *  16-source ALL feed does.
   *
   *  Telugu and Tamil get both pages because they are the two biggest producers
   *  and the tab is named after Telugu; Malayalam and Kannada get one page each,
   *  which is enough depth to be represented without diluting the first screen.
   *  rankCategoryFeed() decides the actual order, so the per-language request
   *  order below does not leak into what the user sees.
   *
   *  'south' is kept as an alias rather than deleted: /movies/south is a live SSR
   *  page and the footer, JSON-LD and generated link block all still point at
   *  filterCat('south'). Both ids resolve to this same merged pool. */
  if (cat === 'tollywood' || cat === 'south') {
    const S = { sort_by: POP, language: L };
    return [
      ['/discover/movie', Object.assign({}, S, { with_original_language: 'te', page: p1 })],
      ['/discover/movie', Object.assign({}, S, { with_original_language: 'te', page: p2 })],
      ['/discover/movie', Object.assign({}, S, { with_original_language: 'ta', page: p1 })],
      ['/discover/movie', Object.assign({}, S, { with_original_language: 'ta', page: p2 })],
      ['/discover/movie', Object.assign({}, S, { with_original_language: 'ml', page: p1 })],
      ['/discover/movie', Object.assign({}, S, { with_original_language: 'kn', page: p1 })]
    ];
  }

  /*  Platforms have no plan here on purpose.
   *
   *  fetchOttMovies() does its own two-stage prime (_ottPrimeBatch, then memory
   *  reads) and ranks by platform relevance, and a platform page costs ~7
   *  requests — spending those speculatively is what made the NEXT platform
   *  click queue behind the previous one. Paging is unaffected: goToFeedPage()
   *  serves any page already in the pool with no network at all. */
  if (OTT[cat]) return null;

  const base = Object.assign({}, CAT_PARAMS[cat] || {}, { language: L });
  return [
    ['/discover/movie', Object.assign({}, base, { page: p1 })],
    ['/discover/movie', Object.assign({}, base, { page: p2 })]
  ];
}

// -- BACKGROUND PREFETCH HELPERS (For Instant "Load More") --
function prefetchMoviesPage(cat, pageNum) {
  const plan = _mzCatPlan(cat, pageNum);
  if (plan) tmdbBatch(plan);   // never rejects; fire and forget
}

/*  ══════════════════════════════════════════════════════════════════════
 *  A TAB IS WARM BEFORE IT IS CLICKED
 *  ══════════════════════════════════════════════════════════════════════
 *  Clicking a category the session has not seen yet was the one remaining place
 *  where the user waited on the network: the grid went to skeletons and stayed
 *  there for a round-trip. Nothing could be done about that while the source
 *  list lived inside loadMovies' if/else chain — there was no way to ask "what
 *  would this tab need?" without running it.
 *
 *  With _mzCatPlan() the answer is one call, so the plan is sent the moment the
 *  user shows intent — pointer over the tab, keyboard focus on it, or finger
 *  down on it — which on a touch screen is ~100ms before the click event and on
 *  a pointer device is usually several hundred. One batched request, and by the
 *  time filterCat() runs, tmdbBatch() finds every URL already cached and skips
 *  the network entirely.
 *
 *  Bounded on purpose: eight categories per session, never under Data Saver, and
 *  never for a category whose pool is already built. A tab the user re-hovers
 *  costs nothing after the first time.
 */
const MZ_TAB_PREFETCH_MAX = 8;
const _mzTabPrefetched = new Set();

/** The category a .cat-tab opens, read off its inline handler. */
function _mzTabCat(el) {
  const m = /filterCat\('([^']+)'/.exec((el && el.getAttribute('onclick')) || '');
  return m ? m[1] : '';
}

function _mzPrefetchCategory(cat) {
  if (!cat || _mzTabPrefetched.has(cat)) return;
  if (_mzTabPrefetched.size >= MZ_TAB_PREFETCH_MAX) return;
  if (typeof isDataSaver === 'function' && isDataSaver()) return;
  if (_mzReadPool(cat)) return;   // pool already built and still fresh
  const plan = _mzCatPlan(cat, 1);
  if (!plan) return;
  _mzTabPrefetched.add(cat);
  tmdbBatch(plan);
}

/*  One set of listeners on the document, not one per tab: the category strip is
 *  re-rendered by the group menus, and per-tab handlers would leak a set every
 *  time. All three are passive — none of them can cancel the gesture they ride
 *  on, and touchstart in particular must never delay a tap. */
let _mzTabPrefetchWired = false;
function ensureTabPrefetch() {
  if (_mzTabPrefetchWired) return;
  _mzTabPrefetchWired = true;
  const onIntent = (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const tab = target.closest('.cat-tab');
    if (tab) _mzPrefetchCategory(_mzTabCat(tab));
  };
  document.addEventListener('mouseover', onIntent, { passive: true });
  document.addEventListener('focusin', onIntent, { passive: true });
  document.addEventListener('touchstart', onIntent, { passive: true });
}
 
function prefetchUpcomingPage(pageNum) {
  /*  Same plan builder loadUpcoming() uses, so the params — and therefore the
   *  cache keys — are byte-identical and this prefetch actually answers the next
   *  "Load More" instead of warming a URL nobody asks for. */
  tmdbBatch(upcomingPagePlan(pageNum));   // never rejects; fire and forget
}
 
// -- LOAD MOVIES
/*  Single-request category params. NOTE: 'south' and 'tollywood' are NOT read
 *  from here any more — _mzCatPlan() intercepts both ids and returns the merged
 *  multi-language South Indian plan instead. The two entries stay so that any
 *  caller reaching for CAT_PARAMS[cat] still gets a sane single-language query
 *  rather than undefined. */
const CAT_PARAMS = {
  bollywood: { with_original_language: 'hi', sort_by: 'popularity.desc', page: '1' },
  south:     { with_original_language: 'ta', sort_by: 'popularity.desc', page: '1' },
  tollywood: { with_original_language: 'te', sort_by: 'popularity.desc', page: '1' },
  action:    { with_genres: '28',  sort_by: 'popularity.desc', page: '1' },
  comedy:    { with_genres: '35',  sort_by: 'popularity.desc', page: '1' },
  horror:    { with_genres: '27',  sort_by: 'popularity.desc', page: '1' },
  thriller:  { with_genres: '53',  sort_by: 'popularity.desc', page: '1' },
  romance:   { with_genres: '10749', sort_by: 'popularity.desc', page: '1' },
  scifi:     { with_genres: '878', sort_by: 'popularity.desc', page: '1' },
  adventure: { with_genres: '12',  sort_by: 'popularity.desc', page: '1' },
  fantasy:   { with_genres: '14',  sort_by: 'popularity.desc', page: '1' },
  crime:     { with_genres: '80',  sort_by: 'popularity.desc', page: '1' },
  documentary:{ with_genres: '99', sort_by: 'popularity.desc', page: '1' },
  family:    { with_genres: '10751', without_genres: '27', sort_by: 'popularity.desc', page: '1' },
  animation: { with_genres: '16',  sort_by: 'popularity.desc', page: '1' },
  kids:      { with_genres: '16,10751', without_genres: '27,53,18', sort_by: 'popularity.desc', page: '1' }
};

/* ══════════════════════════════════════════════════════════════
   POWERFUL ANIME ENGINE
   Multi-source anime discovery: Trending, Latest, Airing Now,
   Popular, Top Rated, Movies, Series — sab ek jagah.
   ══════════════════════════════════════════════════════════════ */
const ANIME_GENRE   = '16';        // TMDB Animation genre
const ANIME_KEYWORD = '210024';    // TMDB "anime" keyword (Japanese + donghua style titles)

const ANIME_MODES = [
  { id: 'all',       label: 'All Anime',    icon: '🎌' },
  { id: 'trending',  label: 'Trending',     icon: '🔥' },
  { id: 'latest',    label: 'Latest',       icon: '🆕' },
  { id: 'airing',    label: 'Airing Now',   icon: '📡' },
  { id: 'popular',   label: 'Popular',      icon: '⭐' },
  { id: 'top_rated', label: 'Top Rated',    icon: '🏆' },
  { id: 'series',    label: 'Anime Series', icon: '📺' },
  { id: 'movies',    label: 'Anime Movies', icon: '🎬' },
  { id: 'classics',  label: 'All Time Best',icon: '👑' }
];

let currentAnimeMode = 'all';

function animeISTDate(offsetDays = 0) {
  const d = new Date(Date.now() + (5.5 * 60 * 60 * 1000) + (offsetDays * 86400000));
  return d.toISOString().split('T')[0];
}

// Anime detection for un-filterable endpoints (/trending)
function isAnimeItem(m) {
  if (!m) return false;
  const gid = m.genre_ids || [];
  const lang = m.original_language;
  return gid.includes(16) && (lang === 'ja' || lang === 'zh' || lang === 'ko');
}

/**
 * Builds the TMDB request plan for a given anime mode.
 * Returns [{ endpoint, params, type, badge }] — type forces media_type
 * so anime series ka season/episode support intact rahe.
 */
function buildAnimeQueries(mode, page) {
  const p1 = String(page * 2 - 1);
  const p2 = String(page * 2);
  const pg = String(page);
  const today = animeISTDate(0);
  const tvBase    = { with_genres: ANIME_GENRE, with_original_language: 'ja', language: 'en-US' };
  const mvBase    = { with_genres: ANIME_GENRE, with_original_language: 'ja', language: 'en-US' };
  const kwTv      = { with_keywords: ANIME_KEYWORD, with_genres: ANIME_GENRE, language: 'en-US' };
  const kwMv      = { with_keywords: ANIME_KEYWORD, with_genres: ANIME_GENRE, language: 'en-US' };
  const q = [];

  const push = (endpoint, params, type, badge) => q.push({ endpoint, params, type, badge });

  switch (mode) {
    case 'trending':
      // /trending filter support nahi karta, isliye locally anime filter hoga
      push('/trending/tv/week',    { language: 'en-US', page: pg }, 'tv',    '🔥 TRENDING NOW');
      push('/trending/movie/week', { language: 'en-US', page: pg }, 'movie', '🔥 TRENDING NOW');
      push('/trending/tv/day',     { language: 'en-US', page: pg }, 'tv',    '🔥 TRENDING TODAY');
      push('/trending/movie/day',  { language: 'en-US', page: pg }, 'movie', '🔥 TRENDING TODAY');
      // Fallback fillers: recent high-momentum anime
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'popularity.desc', 'first_air_date.gte': animeISTDate(-400), 'first_air_date.lte': today, page: pg }), 'tv', '🔥 HOT ANIME');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'popularity.desc', 'primary_release_date.gte': animeISTDate(-800), 'primary_release_date.lte': today, page: pg }), 'movie', '🔥 HOT ANIME');
      break;

    case 'latest':
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'first_air_date.desc', 'first_air_date.lte': today, 'vote_count.gte': '2', page: pg }), 'tv', '🆕 NEW RELEASE');
      push('/discover/tv', Object.assign({}, kwTv,   { sort_by: 'first_air_date.desc', 'first_air_date.lte': today, 'vote_count.gte': '2', page: pg }), 'tv', '🆕 NEW RELEASE');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'primary_release_date.desc', 'primary_release_date.lte': today, 'vote_count.gte': '3', page: pg }), 'movie', '🆕 NEW MOVIE');
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'popularity.desc', 'first_air_date.gte': animeISTDate(-120), 'first_air_date.lte': today, page: pg }), 'tv', '🆕 THIS SEASON');
      break;

    case 'airing':
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'popularity.desc', 'air_date.gte': animeISTDate(-30), 'air_date.lte': today, page: pg }), 'tv', '📡 AIRING NOW');
      push('/discover/tv', Object.assign({}, kwTv,   { sort_by: 'popularity.desc', 'air_date.gte': animeISTDate(-30), 'air_date.lte': today, page: pg }), 'tv', '📡 AIRING NOW');
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'vote_average.desc', 'vote_count.gte': '20', 'air_date.gte': animeISTDate(-60), 'air_date.lte': today, page: pg }), 'tv', '📡 ONGOING HIT');
      break;

    case 'popular':
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'popularity.desc', page: p1 }), 'tv',    '⭐ POPULAR');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'popularity.desc', page: p1 }), 'movie', '⭐ POPULAR');
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'popularity.desc', page: p2 }), 'tv',    '⭐ POPULAR');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'popularity.desc', page: p2 }), 'movie', '⭐ POPULAR');
      push('/discover/tv',    Object.assign({}, kwTv,   { sort_by: 'popularity.desc', page: p1 }), 'tv',    '⭐ POPULAR');
      break;

    case 'top_rated':
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: p1 }), 'tv',    '🏆 TOP RATED');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: p1 }), 'movie', '🏆 TOP RATED');
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: p2 }), 'tv',    '🏆 TOP RATED');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: p2 }), 'movie', '🏆 TOP RATED');
      break;

    case 'series':
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'popularity.desc', page: p1 }), 'tv', '📺 ANIME SERIES');
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'popularity.desc', page: p2 }), 'tv', '📺 ANIME SERIES');
      push('/discover/tv', Object.assign({}, kwTv,   { sort_by: 'popularity.desc', page: p1 }), 'tv', '📺 ANIME SERIES');
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'first_air_date.desc', 'first_air_date.lte': today, 'vote_count.gte': '5', page: pg }), 'tv', '📺 NEW SEASON');
      break;

    case 'movies':
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'popularity.desc', page: p1 }), 'movie', '🎬 ANIME MOVIE');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'popularity.desc', page: p2 }), 'movie', '🎬 ANIME MOVIE');
      push('/discover/movie', Object.assign({}, kwMv,   { sort_by: 'popularity.desc', page: p1 }), 'movie', '🎬 ANIME MOVIE');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'vote_average.desc', 'vote_count.gte': '100', page: pg }), 'movie', '🎬 MUST WATCH');
      break;

    case 'classics':
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'vote_count.desc', page: p1 }), 'tv',    '👑 LEGENDARY');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'vote_count.desc', page: p1 }), 'movie', '👑 LEGENDARY');
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'vote_count.desc', page: p2 }), 'tv',    '👑 LEGENDARY');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'vote_count.desc', page: p2 }), 'movie', '👑 LEGENDARY');
      break;

    case 'all':
    default:
      // Har flavour ka mix — trending + latest + popular + top rated + movies
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'popularity.desc', page: p1 }), 'tv',    '⭐ POPULAR');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'popularity.desc', page: p1 }), 'movie', '🎬 ANIME MOVIE');
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'first_air_date.desc', 'first_air_date.lte': today, 'vote_count.gte': '5', page: pg }), 'tv', '🆕 LATEST');
      push('/discover/tv', Object.assign({}, tvBase, { sort_by: 'popularity.desc', 'air_date.gte': animeISTDate(-30), 'air_date.lte': today, page: pg }), 'tv', '📡 AIRING NOW');
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: pg }), 'tv',    '🏆 TOP RATED');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: pg }), 'movie', '🏆 TOP RATED');
      push('/discover/tv',    Object.assign({}, tvBase, { sort_by: 'popularity.desc', page: p2 }), 'tv',    '⭐ POPULAR');
      push('/discover/movie', Object.assign({}, mvBase, { sort_by: 'popularity.desc', page: p2 }), 'movie', '🎬 ANIME MOVIE');
      push('/discover/tv',    Object.assign({}, kwTv,   { sort_by: 'popularity.desc', page: p1 }), 'tv',    '🎌 ANIME');
      break;
  }
  return q;
}

/** Fetches + interleaves all sources for the active anime mode. */
async function fetchAnimeMovies(mode, page) {
  const plan = buildAnimeQueries(mode, page);
  const res = await Promise.allSettled(plan.map(p => tmdb(p.endpoint, p.params)));

  const buckets = res.map((r, idx) => {
    const data = (r.status === 'fulfilled' && r.value && r.value.results) ? r.value.results : [];
    const plan_i = plan[idx];
    const isTrendingEp = plan_i.endpoint.indexOf('/trending/') === 0;
    return data
      .filter(item => !isTrendingEp || isAnimeItem(item))   // trending endpoints ko locally anime tak limit karo
      .map(item => {
        const it = Object.assign({}, item);
        it.media_type = plan_i.type || it.media_type || 'movie';
        if (!it._animeBadge && plan_i.badge) it._animeBadge = plan_i.badge;
        return it;
      });
  });

  // Round-robin interleave: har source ka content grid me mix hoke aaye
  const out = [];
  const seen = new Set();
  let maxLen = 0;
  buckets.forEach(b => { if (b.length > maxLen) maxLen = b.length; });
  for (let i = 0; i < maxLen; i++) {
    buckets.forEach(b => {
      if (i < b.length) {
        const item = b[i];
        const key = item.media_type + '-' + item.id;
        if (!seen.has(key)) { seen.add(key); out.push(item); }
      }
    });
  }
  return out;
}

// ── ANIME SUB-FILTER BAR (chips under category tabs) ──
function renderAnimeFilterBar() {
  const catTabs = document.getElementById('catTabs');
  if (!catTabs) return;
  let bar = document.getElementById('animeFilterBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'animeFilterBar';
    bar.className = 'anime-filter-bar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Anime filters');
    (ensureCatFilterSep() || catTabs).insertAdjacentElement('afterend', bar);
  }
  bar.innerHTML = ANIME_MODES.map(m => {
    const active = m.id === currentAnimeMode;
    return `<button type="button" class="anime-chip${active ? ' active' : ''}" role="tab" tabindex="0" aria-selected="${active}" onclick="setAnimeMode('${m.id}')"><span>${m.label}</span></button>`;
  }).join('');
  bar.style.display = 'flex';
  syncCatFilterSeparator();
}

function hideAnimeFilterBar() {
  const bar = document.getElementById('animeFilterBar');
  if (bar) bar.style.display = 'none';
  syncCatFilterSeparator();
}

function updateAnimeHeading() {
  const h = document.getElementById('sectionHeading');
  if (!h) return;
  const m = ANIME_MODES.find(x => x.id === currentAnimeMode) || ANIME_MODES[0];
  h.textContent = currentAnimeMode === 'all' ? 'ANIME SERIES & MOVIES' : ('ANIME • ' + m.label.toUpperCase());
}

function setAnimeMode(mode) {
  if (!ANIME_MODES.some(m => m.id === mode)) mode = 'all';
  currentAnimeMode = mode;
  renderAnimeFilterBar();
  updateAnimeHeading();
  loadMovies('anime');
}

/* ══════════════════════════════════════════════════════════════════════════
   POWERFUL CARTOON ENGINE  (Cartoons tab — cat 'kids')
   ──────────────────────────────────────────────────────────────────────────
   Do problem the section me the:
     1. Query sirf TMDB genre 10762 ("Kids") par chal rahi thi. Kids ek
        AUDIENCE tag hai, animation ka tag nahi — isliye Baalveer,
        Shaka Laka Boom Boom, Tenali Rama, Sesame Street, Jessie jaise
        LIVE-ACTION shows (aur "Sex Chat with Pappu & Papa" tak) grid me
        aa jaate the. Verified: /discover/tv?with_genres=10762&…lang=hi ka
        top result hi Baalveer hai (genres: Kids/Comedy/Sci-Fi, koi
        Animation nahi).
     2. Sab kuch round-robin interleave hota tha, koi ranking nahi thi, to
        famous cartoons top par aane ki koi guarantee nahi thi.

   Fix:
     • ANIMATION GENRE (16) LAZMI. Yahi ek gate live-action kids shows ko
       100% bahar rakhta hai. Sirf curated cartoon IDs is gate ko bypass kar
       sakti hain (kuch Indian cartoons TMDB par bina genre ke pade hain,
       jaise Little Singham).
     • Japanese/Chinese/Korean content sirf tab aata hai jab wo kids/family
       cartoon ho ya curated famous ho — warna Jujutsu Kaisen/Naruto type
       anime (aur TMDB ka ja adult-animation kachra) yahan ghus jaata tha.
       Pure anime ke liye alag ANIME tab already hai.
     • FAMOUS-FIRST RANKING: curated tier-1 (Doraemon, Shinchan, Tom & Jerry,
       Oggy, Ben 10, Motu Patlu, Pokemon…) sabse upar, phir global legends,
       phir trending, phir popularity + vote weight.
     • 12 sub-filter chips (Trending / All Time Famous / Hindi / Doraemon & Co
       / Series / Movies / Cartoon Network / Nickelodeon / Disney / Action /
       New) — anime engine ke jaise.
   ══════════════════════════════════════════════════════════════════════════ */
const CARTOON_GENRE_ANIMATION = '16';
const CARTOON_GENRE_KIDS      = '10762';
const CARTOON_GENRE_FAMILY    = '10751';

// Kids-channel network ids (TMDB /network/<id> se verify kiye gaye):
// 56/4945 Cartoon Network, 13/8053 Nickelodeon, 54 Disney Channel, 44 Disney XD,
// 523/8726 Boomerang, 1439 Pogo, 6622 Discovery Kids, 103 tv asahi
// (Doraemon/Shin Chan/Ninja Hattori), 2854 ABC Kids, 15 CBBC, 112 CITV, 2638 Gulli.
const CARTOON_NET_ALL    = '56|4945|13|8053|54|44|523|8726|1439|6622|103|2854|15|112|2638';
const CARTOON_NET_CN     = '56|4945|523|8726';
const CARTOON_NET_NICK   = '13|8053';
const CARTOON_NET_DISNEY = '54|44';
const CARTOON_NET_INDIA  = '4945|8053|1439|6622';
const CARTOON_NET_JAPAN  = '103';

/* Tier 1 — jo cartoons India me sabse zyada dekhe jaate hain. Ye grid ke top
   par pin hote hain. Saari ids TMDB se verify ki gayi hain. */
const CARTOON_ICON_IDS = new Set([
  // Japanese classics (Hindi dub par hi bade hue hain)
  65733, 57911,          // Doraemon (2005 / 1979)
  30623, 254063, 67324,  // Shin Chan + dubs/spin-off
  80885, 158198,         // Ninja Hattori-kun
  80609, 300626,         // Kiteretsu Daihyakka
  65739, 132791,         // Perman / SUPERKID
  60572, 220150, 8910,   // Pokemon + Horizons + Chronicles
  20214,                 // The Jungle Book: Adventures of Mowgli
  // Cartoon Network / Nick / Disney evergreens
  47480, 676, 7842, 4274,        // Tom & Jerry (all shows)
  2777, 131721,                  // Oggy and the Cockroaches
  4686, 68295, 6040, 31109, 46922, // Ben 10 (2005 → Omniverse)
  387, 4229, 2085, 607, 37606, 1877,
  18123, 926, 652,               // Scooby-Doo
  2530,                          // Mr. Bean: The Animated Series
  590, 240, 1769, 17572,
  45140, 63401, 15260, 31132, 40075,
  79, 4269, 1848,                // Dora, Transformers, Winx Club
  65763, 102321, 670, 32605,     // Looney Tunes
  8392, 4606, 18352, 14693, 5559,// Popeye, Garfield, Pink Panther
  12225, 57532, 3022, 4630, 51817, 160, 33765, 68073, 2129, 7869, 65334,
  3934, 46879,                   // Mickey Mouse
  // Indian cartoons
  70058, 216999, 88393, 32035, 90982, 110264,
  133665, 251006, 126463, 283124, 113312, 137505,
  249066, 232840, 232838, 155835, 115983, 41780, 252106, 219676
]);

/* Tier 2 — global cartoon legends / all-time classics. */
const CARTOON_LEGEND_IDS = new Set([
  246, 82728, 46080, 3902, 38693, 194916, 7011, 34860,
  67667, 54728, 226688, 37807,   // Beyblade
  12971,                          // Dragon Ball Z
  513, 1618, 84200, 68837,        // Batman Beyond / Justice League
  5622, 3570, 10826, 720, 72350, 2745, 1585, 10938,
  73811, 38503, 30563, 129959, 10926, 66562, 5200,
  57775, 153485, 209246, 56426, 32910, 157747, 286822
]);

/* Mature / adult animation — Cartoons tab me kabhi nahi. */
const CARTOON_BLOCK_IDS = new Set([
  1434, 2190, 60625, 74204, 95557, 456, 97645, 2122
]);
const CARTOON_BLOCK_RE = /\b(family guy|south park|rick and morty|big mouth|invincible|the simpsons|solar opposites|king of the hill|american dad|bojack|archer|paradise pd|brickleberry|beavis|f is for family|disenchantment|smiling friends|hazbin hotel|helluva boss|velma|praise petey)\b/i;
/* Explicit / ecchi animation (TMDB ke ja animation results me kaafi hai). */
const CARTOON_NSFW_RE = /(hentai|ecchi|erotic|uncensored|\bxxx\b|\bsex\b|\bnude\b|naked|lewd|\byaoi\b|\byuri\b|\bharem\b|seduc|\blust\b|shikiyoku|junketsu|netorare|\bmilf\b|18\+)/i;

/* Ghar-ghar ke naam — curated id list se choot jaane par bhi boost mile. */
const CARTOON_FAMOUS_RE = /\b(doraemon|shin[\s-]?chan|shinchan|crayon shin|ninja hattori|kiteretsu|perman|pokemon|pok[eé]mon|tom and jerry|tom & jerry|oggy|spongebob|dexter's laboratory|courage the cowardly|powerpuff|gumball|phineas and ferb|scooby|mr\.? bean|we bare bears|teen titans|adventure time|regular show|gravity falls|rugrats|peppa pig|paw patrol|bluey|masha and the bear|shaun the sheep|fairly odd|ninja turtles|loud house|jimmy neutron|penguins of madagascar|miraculous|motu patlu|chhota bheem|chota bheem|little bheem|mighty raju|bandbudh|simple samosa|little singham|roll no|rat-a-tat|pakdam|ben 10|my little pony|the last airbender|ninjago|chiikawa|bernard|rantaro|beyblade|johnny test|kick buttowski|dragon ball|looney tunes|bugs bunny|mickey mouse|donald duck|tweety|popeye|garfield|pink panther|richie rich|dora the explorer|noddy|winx club|transformers|smurfs|flintstones|jetsons|inspector gadget|swat kats|justice league|batman|superman|spider-verse|winnie the pooh|toy story|frozen|moana|zootopia|minions|despicable me|shrek|kung fu panda|madagascar|ice age|finding nemo|incredibles|lion king|aladdin|tangled|encanto|ratatouille|monsters, inc|inside out|jungle book|mowgli|super mario|sonic x|hagemaru|kochikame|duck ?tales|jackie chan adventures|eena meena deeka)\b/i;

const CARTOON_MODES = [
  { id: 'all',       label: 'All Cartoons',    icon: '🎨' },
  { id: 'trending',  label: 'Trending',        icon: '🔥' },
  { id: 'legends',   label: 'All Time Famous', icon: '👑' },
  { id: 'hindi',     label: 'Hindi Cartoons',  icon: '🇮🇳' },
  { id: 'japanese',  label: 'Doraemon & Co',   icon: '🇯🇵' },
  { id: 'series',    label: 'Cartoon Series',  icon: '📺' },
  { id: 'movies',    label: 'Cartoon Movies',  icon: '🎬' },
  { id: 'cn',        label: 'Cartoon Network', icon: '🌀' },
  { id: 'nick',      label: 'Nickelodeon',     icon: '🟠' },
  { id: 'disney',    label: 'Disney',          icon: '🏰' },
  { id: 'superhero', label: 'Action & Heroes', icon: '🦸' },
  { id: 'latest',    label: 'New Cartoons',    icon: '🆕' }
];

let currentCartoonMode = 'all';

function cartoonISTDate(offsetDays) {
  const d = new Date(Date.now() + (5.5 * 60 * 60 * 1000) + ((offsetDays || 0) * 86400000));
  return d.toISOString().split('T')[0];
}

function cartoonGenreIds(m) {
  if (!m) return [];
  if (Array.isArray(m.genre_ids)) return m.genre_ids;
  if (Array.isArray(m.genres)) return m.genres.map(g => g && g.id).filter(Boolean);
  return [];
}

function cartoonTitleOf(m) {
  if (!m) return '';
  return (m.name || m.title || '') + ' ' + (m.original_name || m.original_title || '');
}

/** Curated ya ghar-ghar ka naam wala cartoon? */
function isFamousCartoon(m) {
  if (!m) return false;
  return CARTOON_ICON_IDS.has(m.id) || CARTOON_LEGEND_IDS.has(m.id) ||
         CARTOON_FAMOUS_RE.test(cartoonTitleOf(m));
}

/**
 * Cartoons tab ka strict gate — sirf animated content pass karta hai.
 * Live-action kids serials (Baalveer, Shaka Laka Boom Boom, Shinchan ke
 * live remakes), reality kids shows, aur adult animation sab block.
 */
function isStrictCartoon(m) {
  if (!m || !m.poster_path) return false;
  if (m.adult === true) return false;
  if (CARTOON_BLOCK_IDS.has(m.id)) return false;

  const title = cartoonTitleOf(m);
  if (CARTOON_BLOCK_RE.test(title) || CARTOON_NSFW_RE.test(title)) return false;

  const g = cartoonGenreIds(m);
  // Animation genre lazmi. Sirf hand-verified cartoon ids hi bypass kar sakti
  // hain (TMDB par kuch Indian cartoons ke genres blank pade hain).
  const curated = CARTOON_ICON_IDS.has(m.id) || CARTOON_LEGEND_IDS.has(m.id);
  if (!g.includes(16) && !curated) return false;

  // Reality / talk / news / soap / documentary kabhi cartoon nahi hote.
  if (g.some(id => id === 10764 || id === 10767 || id === 10763 || id === 10766 || id === 99)) return false;
  // War & Politics animation bachchon ke section me nahi.
  if (g.includes(10768) && !curated) return false;

  // ja/zh/ko: sirf kids/family cartoons (Doraemon, Shin Chan, Pokemon) —
  // shonen/seinen anime ANIME tab ka kaam hai.
  const lang = m.original_language;
  if (lang === 'ja' || lang === 'zh' || lang === 'ko') {
    if (!isFamousCartoon(m) && !g.includes(10762) && !g.includes(10751)) return false;
  }
  return true;
}

/** Famous + trending + popular ko top par laane wala score. */
function cartoonScore(m, isTrendingSource) {
  const g = cartoonGenreIds(m);
  let s = 0;
  if (CARTOON_ICON_IDS.has(m.id)) s += 26000;          // India ke evergreen cartoons
  else if (CARTOON_LEGEND_IDS.has(m.id)) s += 14000;   // global legends
  else if (CARTOON_FAMOUS_RE.test(cartoonTitleOf(m))) s += 8000;
  if (isTrendingSource) s += 3500;
  s += Math.min(m.popularity || 0, 400) * 9;
  const v = m.vote_count || 0;
  if (v > 0) s += Math.log10(v + 1) * 600;
  if (g.includes(10762)) s += 500;   // official Kids classification
  if (g.includes(10751)) s += 250;   // Family
  return s;
}

/**
 * Mode ke hisaab se TMDB request plan. Har query me Animation genre ya kids
 * network hota hai, isliye live-action pehle hi source par cut jaata hai.
 */
function buildCartoonQueries(mode, page) {
  const p1 = String(page * 2 - 1);
  const p2 = String(page * 2);
  const pg = String(page);
  const today = cartoonISTDate(0);
  const base = { language: 'en-US', include_adult: 'false' };
  const A  = CARTOON_GENRE_ANIMATION;
  const AK = CARTOON_GENRE_ANIMATION + ',' + CARTOON_GENRE_KIDS;    // Animation AND Kids
  const AF = CARTOON_GENRE_ANIMATION + ',' + CARTOON_GENRE_FAMILY;  // Animation AND Family
  const q = [];
  const push = (endpoint, params, type) => q.push({ endpoint, params: Object.assign({}, base, params), type });

  switch (mode) {
    case 'trending':
      push('/trending/tv/week',    { page: pg }, 'tv');
      push('/trending/movie/week', { page: pg }, 'movie');
      push('/trending/tv/day',     { page: pg }, 'tv');
      push('/trending/movie/day',  { page: pg }, 'movie');
      push('/discover/tv',    { with_genres: AK, sort_by: 'popularity.desc', page: pg }, 'tv');
      push('/discover/movie', { with_genres: AF, sort_by: 'popularity.desc', page: pg }, 'movie');
      break;

    case 'legends':
      push('/discover/tv',    { with_genres: AK, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: A, with_networks: CARTOON_NET_ALL, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: AF, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/movie', { with_genres: AF, sort_by: 'vote_count.desc', page: p1 }, 'movie');
      push('/discover/tv',    { with_genres: AK, sort_by: 'vote_count.desc', page: p2 }, 'tv');
      push('/discover/movie', { with_genres: AF, sort_by: 'vote_count.desc', page: p2 }, 'movie');
      break;

    case 'hindi':
      push('/discover/tv',    { with_genres: A, with_original_language: 'hi', sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: AK, with_original_language: 'hi', sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: A, with_networks: CARTOON_NET_INDIA, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/movie', { with_genres: A, with_original_language: 'hi', sort_by: 'popularity.desc', page: p1 }, 'movie');
      push('/discover/tv',    { with_genres: A, with_original_language: 'hi', sort_by: 'popularity.desc', page: p2 }, 'tv');
      break;

    case 'japanese':
      push('/discover/tv',    { with_genres: AK, with_original_language: 'ja', sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: AF, with_original_language: 'ja', sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: A,  with_networks: CARTOON_NET_JAPAN, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: AK, with_original_language: 'ja', sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/movie', { with_genres: AF, with_original_language: 'ja', sort_by: 'popularity.desc', page: p1 }, 'movie');
      break;

    case 'movies':
      push('/discover/movie', { with_genres: AF, sort_by: 'popularity.desc', page: p1 }, 'movie');
      push('/discover/movie', { with_genres: AF, sort_by: 'popularity.desc', page: p2 }, 'movie');
      push('/discover/movie', { with_genres: A, without_genres: '27,53,80', sort_by: 'popularity.desc', page: p1 }, 'movie');
      push('/discover/movie', { with_genres: AF, sort_by: 'vote_count.desc', page: p1 }, 'movie');
      push('/discover/movie', { with_genres: AF, sort_by: 'vote_count.desc', page: p2 }, 'movie');
      break;

    case 'series':
      push('/discover/tv', { with_genres: AK, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: AF, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_ALL, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: AK, sort_by: 'popularity.desc', page: p2 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_ALL, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      break;

    case 'cn':
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_CN, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_CN, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_CN, sort_by: 'popularity.desc', page: p2 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_CN, sort_by: 'vote_count.desc', page: p2 }, 'tv');
      break;

    case 'nick':
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_NICK, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_NICK, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_NICK, sort_by: 'popularity.desc', page: p2 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_NICK, sort_by: 'vote_count.desc', page: p2 }, 'tv');
      break;

    case 'disney':
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_DISNEY, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_DISNEY, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/tv', { with_genres: A, with_networks: CARTOON_NET_DISNEY, sort_by: 'popularity.desc', page: p2 }, 'tv');
      push('/discover/movie', { with_genres: AF, with_companies: '2|3|6125', sort_by: 'popularity.desc', page: p1 }, 'movie');
      break;

    case 'superhero':
      push('/discover/tv',    { with_genres: A + ',10759', without_genres: '18', sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: A + ',10759', without_genres: '18', sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/movie', { with_genres: A + ',28', without_genres: '27', sort_by: 'popularity.desc', page: p1 }, 'movie');
      push('/discover/tv',    { with_genres: A, with_networks: CARTOON_NET_ALL, sort_by: 'popularity.desc', page: p2 }, 'tv');
      break;

    case 'latest':
      push('/discover/tv',    { with_genres: AK, sort_by: 'first_air_date.desc', 'first_air_date.lte': today, 'vote_count.gte': '3', page: p1 }, 'tv');
      push('/discover/movie', { with_genres: AF, sort_by: 'primary_release_date.desc', 'primary_release_date.lte': today, 'vote_count.gte': '5', page: p1 }, 'movie');
      push('/discover/tv',    { with_genres: A, with_networks: CARTOON_NET_ALL, sort_by: 'first_air_date.desc', 'first_air_date.lte': today, 'vote_count.gte': '2', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: AK, sort_by: 'popularity.desc', 'first_air_date.gte': cartoonISTDate(-540), 'first_air_date.lte': today, page: p1 }, 'tv');
      break;

    case 'all':
    default:
      // Famous + popular + legendary + trending + Hindi + movies — sab ek mix.
      push('/discover/tv',    { with_genres: AK, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: AF, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: A, with_networks: CARTOON_NET_ALL, sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: A, with_networks: CARTOON_NET_ALL, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: AK, with_original_language: 'ja', sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: A, with_original_language: 'hi', sort_by: 'popularity.desc', page: p1 }, 'tv');
      push('/discover/tv',    { with_genres: AK, sort_by: 'vote_count.desc', page: p1 }, 'tv');
      push('/discover/movie', { with_genres: AF, sort_by: 'popularity.desc', page: p1 }, 'movie');
      push('/discover/movie', { with_genres: AF, sort_by: 'vote_count.desc', page: p1 }, 'movie');
      push('/trending/tv/week',    { page: pg }, 'tv');
      push('/trending/movie/week', { page: pg }, 'movie');
      push('/discover/tv',    { with_genres: AK, sort_by: 'popularity.desc', page: p2 }, 'tv');
      push('/discover/movie', { with_genres: AF, sort_by: 'popularity.desc', page: p2 }, 'movie');
      break;
  }
  return q;
}

/** Active cartoon mode ke saare sources fetch + filter + famous-first sort. */
async function fetchCartoonMovies(mode, page) {
  const plan = buildCartoonQueries(mode, page);
  const res = await Promise.allSettled(plan.map(p => tmdb(p.endpoint, p.params)));

  const picked = new Map();
  res.forEach((r, idx) => {
    const list = (r.status === 'fulfilled' && r.value && r.value.results) ? r.value.results : [];
    const src = plan[idx];
    const fromTrending = src.endpoint.indexOf('/trending/') === 0;
    list.forEach(raw => {
      if (!raw) return;
      const item = Object.assign({}, raw);
      item.media_type = src.type || item.media_type || 'movie';
      if (!isStrictCartoon(item)) return;
      const key = item.media_type + '-' + item.id;
      const score = cartoonScore(item, fromTrending);
      const prev = picked.get(key);
      if (!prev || score > prev._cartoonScore) {
        item._cartoonScore = score;
        picked.set(key, item);
      }
    });
  });

  return Array.from(picked.values()).sort((a, b) => b._cartoonScore - a._cartoonScore);
}

// ── CARTOON SUB-FILTER BAR (chips under category tabs) ──
function renderCartoonFilterBar() {
  const catTabs = document.getElementById('catTabs');
  if (!catTabs) return;
  let bar = document.getElementById('cartoonFilterBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'cartoonFilterBar';
    bar.className = 'anime-filter-bar';   // same chip styling as the anime bar
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Cartoon filters');
    (ensureCatFilterSep() || catTabs).insertAdjacentElement('afterend', bar);
  }
  bar.innerHTML = CARTOON_MODES.map(m => {
    const active = m.id === currentCartoonMode;
    return `<button type="button" class="anime-chip${active ? ' active' : ''}" role="tab" tabindex="0" aria-selected="${active}" onclick="setCartoonMode('${m.id}')"><span class="anime-chip-icon" aria-hidden="true">${m.icon}</span><span>${m.label}</span></button>`;
  }).join('');
  bar.style.display = 'flex';
  syncCatFilterSeparator();
}

function hideCartoonFilterBar() {
  const bar = document.getElementById('cartoonFilterBar');
  if (bar) bar.style.display = 'none';
  syncCatFilterSeparator();
}

function updateCartoonHeading() {
  const h = document.getElementById('sectionHeading');
  if (!h) return;
  const m = CARTOON_MODES.find(x => x.id === currentCartoonMode) || CARTOON_MODES[0];
  h.textContent = currentCartoonMode === 'all' ? 'CARTOONS' : ('CARTOONS • ' + m.label.toUpperCase());
}

function setCartoonMode(mode) {
  if (!CARTOON_MODES.some(m => m.id === mode)) mode = 'all';
  currentCartoonMode = mode;
  renderCartoonFilterBar();
  updateCartoonHeading();
  loadMovies('kids');
}

/*  ══════════════════════════════════════════════════════════════════════
 *  FEED RETRY BUDGET + FAILURE UI
 *  ══════════════════════════════════════════════════════════════════════
 *  Replaces the unbounded `setTimeout(() => loadMovies(cat), 3000)` that used
 *  to run for the lifetime of the tab whenever a feed came back empty. See the
 *  comment at the retry site inside loadMovies for the full story.
 *
 *  Budget is per category, because failing "anime" says nothing about whether
 *  "trending" is reachable, and a user switching tabs should get a fresh set of
 *  attempts for the tab they actually chose. MZ_FEED_MAX_RETRIES and
 *  MZ_FEED_RETRY_BASE_MS live in the NETWORK RESILIENCE block above, since
 *  loadCarousel shares them.
 */
const _mzFeedRetries = new Map();

function _mzFeedRetryState(cat) {
  const key = cat || 'all';
  if (!_mzFeedRetries.has(key)) _mzFeedRetries.set(key, { attempts: 0, timer: 0 });
  return _mzFeedRetries.get(key);
}

function _mzFeedSlot() {
  return document.getElementById('movieGrid');
}

// TMDB answered, there is simply nothing matching this category. Terminal state:
// retrying cannot change a correct answer.
function renderFeedEmpty(cat) {
  const grid = _mzFeedSlot();
  if (!grid) return;
  grid.innerHTML =
    '<div class="no-results">' +
      '<h3>Nothing here right now</h3>' +
      '<p>No titles matched this category. Try another tab or search for a title.</p>' +
    '</div>';
}

// Transient network failure, retry already scheduled. Says what is happening and
// when, rather than the old permanent "Loading movies...".
function renderFeedRetrying(cat, attempt, delayMs) {
  const grid = _mzFeedSlot();
  if (!grid) return;
  const offline = navigator.onLine === false;
  grid.innerHTML =
    '<div class="no-results">' +
      '<h3>' + (offline ? 'You are offline' : 'Connection hiccup') + '</h3>' +
      '<p>' + (offline
        ? 'Waiting for your connection to come back — this will retry itself.'
        : 'Retrying in ' + Math.round(delayMs / 1000) + 's (attempt ' + attempt + ' of ' + MZ_FEED_MAX_RETRIES + ').') +
      '</p>' +
    '</div>';
}

// Retry budget spent. The user gets an explicit action instead of an eternal
// spinner, and we stop generating requests until they ask for one.
function renderFeedError(cat) {
  const grid = _mzFeedSlot();
  if (!grid) return;
  grid.innerHTML =
    '<div class="no-results">' +
      '<h3>Could not load titles</h3>' +
      '<p>The catalogue did not respond. Your connection may be blocking it.</p>' +
      '<button type="button" class="mz-feed-retry-btn" id="mzFeedRetryBtn">Try again</button>' +
    '</div>';
  const btn = document.getElementById('mzFeedRetryBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    _mzFeedRetryState(cat).attempts = 0;   // manual click buys a fresh budget
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    loadMovies(cat);
  }, { once: true });
}

/**
 * @param {string}  cat        category slug
 * @param {boolean} isLoadMore fetch the next TMDB page and APPEND it to the pool.
 *        Under MZ_FEED_PAGED this is how the pager extends past what the pool
 *        covers; it never appends to the DOM, it grows allMovies and then repaints
 *        the current page out of it.
 */
/*  ── SHAPING A MULTI-SOURCE GATHER ─────────────────────────────────────────
 *  Every category that merges several industries, languages or media types ended
 *  up writing one of two loops by hand, and the copies had drifted apart. Both
 *  now live here, and both take the plain response array _mzCatPlan/tmdbBatch
 *  produce.
 */

/*  Round-robin: source A's first title, then B's first, then C's… then A's
 *  second. A plain concat lets the first source own the entire first screen,
 *  which is how the Horror tab ended up all-Hollywood above the fold and the 4K
 *  tab all-English.
 *
 *  With no callback it returns the flat list. With one, the callback decides what
 *  to keep and receives the SOURCE INDEX, because for several categories that
 *  index is the only thing that says whether a row is a movie or a series —
 *  /discover/tv results carry no media_type of their own.
 */
function mzInterleave(buckets, onItem) {
  const out = [];
  let max = 0;
  buckets.forEach(v => { const n = (v.results || []).length; if (n > max) max = n; });
  for (let i = 0; i < max; i++) {
    buckets.forEach((v, idx) => {
      const item = v.results && v.results[i];
      if (!item) return;
      if (onItem) onItem(item, idx);
      else out.push(item);
    });
  }
  return out;
}

/*  Sources concatenated in plan order, then deduplicated by TMDB id with the
 *  first occurrence winning. `tag` runs on every item before the dedupe and also
 *  receives the source index.
 *
 *  Deliberately keyed on id alone, not type+id, because these categories fetch
 *  one media type per source and tag it from the index — so the collision the
 *  ALL feed guards against cannot arise here.
 */
function mzDedupeById(buckets, tag) {
  const seen = new Set();
  const out = [];
  buckets.forEach((v, idx) => {
    (v.results || []).forEach(item => {
      if (!item) return;
      if (tag) tag(item, idx);
      if (!item.id || seen.has(item.id)) return;
      seen.add(item.id);
      out.push(item);
    });
  });
  return out;
}

async function loadMovies(cat, isLoadMore = false) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;
  
  if (!cat) cat = 'all';
  if (cat !== mzFeedPagerCategory) {
    // A different category is a different pool, so paging starts over.
    mzFeedPage = 1;
    mzFeedPoolExhausted = false;
  }
  mzFeedPagerCategory = cat;
  
  if (isLoadMore) {
    if (isLoadingMore) return;
    isLoadingMore = true;
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) indicator.style.display = 'block';
    currentMoviePage++;
  } else {
    /*  ── INSTANT RE-ENTRY ────────────────────────────────────────────────
     *  Checked BEFORE the grid is wiped, which is the whole point. The skeleton
     *  write below used to happen unconditionally, so even a category whose
     *  every response was already in memory flashed skeletons for as long as the
     *  re-rank took. If the pool is still good there is nothing to fetch, nothing
     *  to rank and nothing to wait for — restore the user's page and paint. */
    const pool = _mzReadPool(cat);
    if (pool) {
      allMovies = pool.movies;
      currentMoviePage = pool.tmdbPage;
      mzFeedPage = pool.page;
      mzFeedPoolExhausted = pool.exhausted;
      _mzFeedRetryState(cat).attempts = 0;
      if (MZ_FEED_PAGED && !isFullViewMovies) renderCurrentFeedPage();
      else renderMovies(isFullViewMovies ? allMovies : allMovies.slice(0, MZ_FEED_PAGE_SIZE), false);
      renderFeedPager();
      const warmIndicator = document.getElementById('loadingIndicator');
      if (warmIndicator) warmIndicator.style.display = 'none';
      return;
    }

    currentMoviePage = 1;
    mzFeedPage = 1;
    mzFeedPoolExhausted = false;
    grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
    allMovies = [];
  }
 
  let movies = [];

  /*  tmdb() deliberately never rejects — 40-odd call sites read `r.results || []`
   *  and would all need try/catch otherwise. The cost is that a fetch failure and
   *  an honestly empty response look identical from here, which is what let the
   *  old code retry an empty category forever. Comparing the global failure
   *  counter before and after the gather recovers that distinction without
   *  touching a single call site.
   *
   *  The counter is global, so a background prefetch failing in the same window
   *  can flip this to "network failed" when the feed itself was fine. That only
   *  matters on the empty-result branch, and erring that way is the safe
   *  direction: something on the wire really did fail, and the retry it triggers
   *  is bounded to three attempts.
   */
  const _mzFeedFailureMark = _mzFetchFailureCount;

  try {
    /*  ── ONE ROUND-TRIP, WHATEVER THE CATEGORY ─────────────────────────────
     *  Every source this category needs goes to /api/tmdb/batch together and the
     *  Worker fans out at the edge, next to TMDB and its KV cache. Before this
     *  only the ALL feed was batched; a Horror or 4K tab sent 4-8 separate
     *  requests through the 8-lane client gate, and on mobile each lane-round is
     *  a full radio round-trip before anything can paint.
     *
     *  `vals` is the plain response array in plan order. tmdbBatch never rejects
     *  and reports per-source outcomes, so one dead source contributes an empty
     *  list instead of emptying the whole screen — which is what the mix of
     *  Promise.all and Promise.allSettled here used to do, now uniform.
     *
     *  A null plan means the category owns its own fan-out: see _mzCatPlan.
     */
    const plan = _mzCatPlan(cat, currentMoviePage);
    const vals = plan
      ? (await tmdbBatch(plan)).map(r => (r.status === 'fulfilled' && r.value) ? r.value : { results: [] })
      : null;

    if (cat === 'all') {
      /*  /discover/tv results carry no media_type, so tag them by position.
       *  TV_SOURCE_FROM is an index into the ALL plan in _mzCatPlan and must move
       *  with it, or series would be tagged as movies and vice versa. */
      const TV_SOURCE_FROM = 12;
      const combinedMovies = [];
      vals.forEach((v, idx) => {
        if (!v.results) return;
        v.results.forEach(item => {
          if (!item) return;
          if (idx >= TV_SOURCE_FROM && !item.media_type) item.media_type = 'tv';
          combinedMovies.push(item);
        });
      });

      // INTELLIGENT DEDUPLICATION: Keep the highest-popularity version.
      // Keyed by type+id, not id alone: TMDB numbers movies and series in
      // separate namespaces, so a movie and a series can share an id and one
      // would silently replace the other.
      const movieMap = new Map();
      for (const movie of combinedMovies) {
        if (!movie || !movie.id) continue;
        const key = mediaTypeOf(movie) + '-' + movie.id;
        const existing = movieMap.get(key);
        if (!existing || (movie.popularity || 0) > (existing.popularity || 0)) {
          movieMap.set(key, movie);
        }
      }
      const uniqueMovies = Array.from(movieMap.values());

      // STRICT PRIORITY RANKING: latest movie releases first, recent movie
      // quality updates second, then the trending/latest web series and anime,
      // and only then the remaining catalogue movies.
      rankByFreshness(uniqueMovies);

      // Balance languages only inside each priority group. A skipped movie is
      // reinserted before the next group, so this pass cannot lift a series
      // above a movie release or quality update.
      const ranked = diversifyByLanguageWithinPriority(uniqueMovies);

      // Finally, fill the slot pattern: movies keep the top and three quarters of
      // the feed, while trending web series and anime reach the first screen
      // instead of sitting sixty cards down. This is the only step that crosses a
      // priority group, and it never reorders within a lane.
      movies.push(...interleaveFeedByType(ranked));
    } else if (cat === 'tv') {
      const combinedShows = [];
      vals.forEach(v => { if (v.results) combinedShows.push(...v.results); });

      // Remove duplicates, keeping the first occurrence
      const uniqueShows = [];
      const seenIds = new Set();
      for (const show of combinedShows) {
        if (show && show.id && !seenIds.has(show.id)) {
          uniqueShows.push(show);
          seenIds.add(show.id);
        }
      }

      /*  No sort here on purpose. This used to be a plain first_air_date
       *  descending sort, which put whichever obscure show aired most recently at
       *  the top regardless of whether anyone was watching it. rankCategoryFeed()
       *  below orders the pool instead: fresh relevant premieres first, then the
       *  rest of the catalogue by composite demand. */
      movies.push(...uniqueShows);
    } else if (cat === 'kids') {
      // POWERFUL CARTOON ENGINE: strictly animated content only, famous first.
      // The batch above already primed every source this asks for, so its own
      // tmdb() calls are memory hits rather than 4-9 gated requests.
      movies = movies.concat(await fetchCartoonMovies(currentCartoonMode, currentMoviePage));
    } else if (cat === 'anime') {
      // POWERFUL ANIME ENGINE: mode ke hisaab se 4-9 sources — all primed above.
      movies = movies.concat(await fetchAnimeMovies(currentAnimeMode, currentMoviePage));
    } else if (cat === 'horror' || cat === 'dubbed') {
      /*  Round-robin, so no single industry owns the top of the grid.
       *  horror = global + Hindi + Tamil + Telugu.
       *  dubbed = Hollywood (2 pages) + Tamil + Telugu + Japanese anime, because
       *  those are the industries Hindi dubs actually come from. */
      movies.push(...mzInterleave(vals));
    } else if (cat === 'adult') {
      mzInterleave(vals, (item, idx) => {
        item.media_type = idx === 1 ? 'tv' : 'movie';

        // Local Double-Check: Brutally eliminate normal family/action/comedy movies
        const badGenres = [16, 10751, 28, 12, 878, 10762, 10759, 35]; // Animation, Family, Action, Adventure, SciFi, Kids, Action&Adventure, Comedy
        let isBad = false;
        if (item.genre_ids) isBad = item.genre_ids.some(gid => badGenres.includes(gid));

        // Allow only if NOT bad genre OR if TMDB officially marked it as explicitly Adult
        if (!isBad || item.adult === true) movies.push(item);
      });
    } else if (cat === 'trending') {
      // 🔥 TRENDING NOW: Global trending movies + shows; source 2 is the TV one.
      movies.push(...mzDedupeById(vals, (item, idx) => { if (idx === 2) item.media_type = 'tv'; }));
    } else if (cat === 'uhd4k') {
      /*  💎 4K ULTRA HD: in this app "quality" is inferred from release date, so
       *  the round-robin is filtered rather than taken whole — 200+ days old and
       *  rated >= 7 means no CAM/TS print can still be in circulation for it. */
      const seen = new Set();
      const nowMs = Date.now();
      mzInterleave(vals, (m) => {
        if (!m.id || seen.has(m.id) || !m.poster_path) return;
        const rd = m.release_date;
        if (!rd) return;
        if ((nowMs - new Date(rd).getTime()) / 86400000 > 200 && (m.vote_average || 0) >= 7) {
          seen.add(m.id);
          m.media_type = 'movie';
          m._force4K = true;   // genuinely 4K-era, so the badge is guaranteed
          movies.push(m);
        }
      });
    } else if (cat === 'toprated') {
      // ⭐ TOP RATED: IMDb-style highest rated, min vote threshold ताकि reliable ho
      movies.push(...mzDedupeById(vals, (item, idx) => { if (idx === 3) item.media_type = 'tv'; }));
    } else if (cat === 'kdrama') {
      /*  🇰🇷 K-DRAMA: Korean web series only — every source is /discover/tv, so
       *  everything is tagged 'tv'. The old plan had a Korean MOVIE source at
       *  index 2 and tagged that one 'movie', which is how Parasite ended up on a
       *  drama tab. */
      movies.push(...mzDedupeById(vals, (item) => { item.media_type = 'tv'; }));
    } else if (OTT[cat]) {
      // ── PLATFORM TABS: every entry in the OTT table ──
      // Uses the OTT sub-filter mode (all / webseries / movies) to decide
      // queries, so this one branch serves Netflix, Prime, JioHotstar, Zee5,
      // Apple TV+, SonyLIV, MX Player, aha and Crunchyroll alike.
      //
      // fetchOttMovies ranks by platform relevance and drops titles that are
      // not really on the service; ottRankLikeAllFeed then applies the SAME
      // product priority as the ALL feed, so newest releases lead and movies
      // and web series interleave the way they do everywhere else.
      movies = movies.concat(
        ottRankLikeAllFeed(await fetchOttMovies(cat, currentOttMode, currentMoviePage)));
    } else {
      // hollywood and every CAT_PARAMS genre/industry tab: two pages, in order.
      vals.forEach(v => { movies = movies.concat(v.results || []); });
    }
  } catch(e) { console.warn(e); }

  /*  ── A SUPERSEDED GATHER MUST NOT WRITE INTO THE NEW CATEGORY ─────────────
   *  Everything below mutates allMovies and, now, stores it as this category's
   *  pool. If the user changed tab while this gather was in flight, allMovies is
   *  already the NEW category's list — so these results would be concatenated
   *  into it and then saved under the OLD category's key, leaving both wrong.
   *  Before pools were kept this only caused a flash of the wrong grid; now it
   *  would persist for the rest of the session. mzFeedPagerCategory is assigned
   *  synchronously at the top of every call, so the newest caller always owns it. */
  if (cat !== mzFeedPagerCategory) {
    if (isLoadMore) {
      isLoadingMore = false;
      const supersededIndicator = document.getElementById('loadingIndicator');
      if (supersededIndicator) supersededIndicator.style.display = 'none';
    }
    return;
  }
 
  const realToday = new Date(Date.now() + (5.5 * 60 * 60 * 1000)).toISOString().split('T')[0]; // IST date for accurate filtering
  // LATEST MOVIES ONLY & BLOCK UPCOMING GLOBALLY
  movies = movies.filter(m => {
    if (!m.poster_path) return false;
    // Editorial removal list — applied here so it covers every category, every
    // endpoint and the infinite-scroll pages too.
    if (isFeedBlocked(m)) return false;
    const rDate = m.release_date || m.first_air_date;
    // Agar release date hi nahi hai, toh bhi sirf popular + high votes wali movies pass karein (already released)
    // Anime/Cartoon exception: naye/niche titles ke votes kam hote hain, unhe drop nahi karna
    if (!rDate) return (m.vote_count > 50 || cat === 'anime' || cat === 'kids');
    // Agar date future ki hai, toh isko normal list se strict block kar do
    if (rDate > realToday) return false;
    return true;
  });

  /*  ── UNIVERSAL RANKING FOR EVERY REMAINING TAB ────────────────────────────
   *  Hollywood, Bollywood, Tollywood, Web Series, K-Drama, Trending, 4K and each
   *  genre used to render TMDB's raw popularity order, which is why 1990s titles
   *  opened those tabs. They all go through the ALL-feed ranking now: newest
   *  releases, then prints that just upgraded, then trending, then popular.
   *
   *  Runs after the filter above so no effort is spent ordering titles that are
   *  about to be dropped, and after the superseded-gather guard so it can never
   *  write into another category's pool. Costs zero requests — the pool is
   *  already in memory.
   *
   *  On the isLoadMore path `movies` holds only the newly fetched batch, so the
   *  pages already on screen keep the order the user is looking at. */
  if (!FEED_SELF_RANKED.has(cat) && !OTT[cat]) {
    movies = rankCategoryFeed(movies);
  }

  if (!movies.length && !isLoadMore) {
    /*  THE RETRY STORM, FIXED.
     *
     *  This used to be:
     *      grid.innerHTML = '<h3>Loading movies...</h3><p>Retrying in a moment</p>'
     *      setTimeout(() => loadMovies(cat), 3000);
     *
     *  with no attempt counter and no exit condition. Two problems compounded:
     *
     *    • It could not tell "the network is down" from "this category is
     *      genuinely empty", so BOTH retried forever, every 3 seconds, for as
     *      long as the tab stayed open. Each pass fans out to up to 15 parallel
     *      tmdb() calls — roughly 300 requests a minute, each logging an error.
     *      That is the source of the "91 TypeError: Failed to fetch in 24h" in
     *      Datadog; a couple of sessions on bad connections produce all of it.
     *    • It lied. The message said "Loading..." forever, so a user on a broken
     *      connection saw an eternal spinner with no way to act.
     *
     *  Now: only network failures retry, at most MZ_FEED_MAX_RETRIES times with
     *  exponential backoff; a genuinely empty category says so and stops; and
     *  when retries are exhausted the user gets an explicit, actionable state.
     */
    const networkFailed = _mzFetchFailureCount > _mzFeedFailureMark ||
      navigator.onLine === false;
    const state = _mzFeedRetryState(cat);

    if (!networkFailed) {
      // TMDB answered fine, it just has nothing matching this category's filters.
      // Retrying an honest empty result can only ever produce the same result.
      state.attempts = 0;

      /*  An extension that returned nothing means TMDB has no further pages for
       *  this category. The pool is what the user is paging through and it still
       *  holds every earlier page, so nothing is lost: mark the pool final, clamp
       *  onto the last page that has content and repaint. renderFeedEmpty() would
       *  be wrong here — the feed is not empty, it just has no MORE.
       */
      if (MZ_FEED_PAGED && isLoadMore && allMovies.length) {
        mzFeedPoolExhausted = true;
        mzFeedPage = Math.min(mzFeedPage, mzFeedTotalPages());
        renderCurrentFeedPage();
        renderFeedPager();
        if (typeof showToast === 'function') showToast('That was the last page.');
        // Owned by this early return, so the gate is released here too or every
        // later extension would be refused.
        isLoadingMore = false;
        const doneIndicator = document.getElementById('loadingIndicator');
        if (doneIndicator) doneIndicator.style.display = 'none';
        return;
      }

      renderFeedEmpty(cat);
      renderFeedPager();
      return;
    }

    if (state.attempts >= MZ_FEED_MAX_RETRIES) {
      renderFeedError(cat);
      return;
    }

    state.attempts++;
    const delay = MZ_FEED_RETRY_BASE_MS * Math.pow(2, state.attempts - 1);
    renderFeedRetrying(cat, state.attempts, delay);

    clearTimeout(state.timer);
    if (navigator.onLine === false) {
      // Do not burn attempts against a link the OS already says is down. Come
      // back the instant it returns; that is faster than any timer would be.
      state.attempts--;
      _mzWhenOnline(() => loadMovies(cat));
    } else {
      state.timer = setTimeout(() => loadMovies(cat), delay);
    }
    return;
  }

  // Reached content, so the category is healthy again.
  _mzFeedRetryState(cat).attempts = 0;
  const keyOf = (m) => (m.media_type || (m.name && !m.title ? 'tv' : 'movie')) + '-' + m.id;
  const existingIds = new Set(allMovies.map(keyOf));
  const newMovies = movies.filter(m => { const k = keyOf(m); if (existingIds.has(k)) return false; existingIds.add(k); return true; });
  allMovies = allMovies.concat(newMovies);
 
  /*  FIRST PAINT SHOWS 8 CARDS, NOT 24.
   *
   *  Reported symptom: "saari images ek saath load ho rahi hain", 117 images over
   *  500ms, ~3.1s each. The posters were already lazy (all but the first six), but
   *  lazy is not a promise of "later" — Chrome starts a lazy image once it is
   *  within roughly 1250px of the viewport, and 24 cards sitting directly under a
   *  95vh hero are all inside that margin. So effectively the whole first batch
   *  was requested at once, competing with the hero backdrop, which IS the LCP
   *  element.
   *
   *  Rendering fewer cards is not the same as fetching fewer titles: the data is
   *  already in allMovies either way. What changes is how many <img> elements
   *  exist while the page is coming up. The remaining cards are appended once the
   *  main thread goes idle, so they are still in the DOM well before a user can
   *  scroll to them — infinite scroll, the load-more paging and the ranking order
   *  all see the same list they did before.
   */

  /*  DEVICE-AWARE RENDERING BUDGET.
   *
   *  Datadog RUM flagged slow hardware: a smart TV or 2-core phone still gets
   *  the same 8-card first paint and 6-card chunks as a desktop, so the first
   *  render blocks the main thread and the cards hit the viewport late. Low
   *  tier gets a lighter first paint in smaller chunks; high tier is unchanged.
   *
   *  Small literal stays on purpose: the resilience guard reads FIRST_PAINT_CARDS
   *  from source, and low-tier just uses a smaller slice of it.
   */
  const FIRST_PAINT_CARDS = 8;
  const firstPaintCount = mzLowTier ? 4 : FIRST_PAINT_CARDS;

  if (MZ_FEED_PAGED && !isFullViewMovies) {
    /*  Paged feed: the pool just grew (or was just built), so repaint whichever
     *  page the user is on out of it. An extension must NOT append to the DOM —
     *  the point of paging is that the grid holds one page.
     *
     *  If the extension produced nothing new, TMDB is out of titles for this
     *  category: mark the pool final and step back onto the last page that has
     *  content, so the user is never left on a blank grid.
     */
    if (isLoadMore && !newMovies.length) {
      mzFeedPoolExhausted = true;
      mzFeedPage = Math.min(mzFeedPage, mzFeedTotalPages());
      if (typeof showToast === 'function') showToast('That was the last page.');
    }
    if (!renderCurrentFeedPage() && mzFeedPage > 1) {
      // Defensive: the slice came back empty even though the pool has titles.
      mzFeedPoolExhausted = true;
      mzFeedPage = mzFeedTotalPages();
      renderCurrentFeedPage();
    }
  } else if (isLoadMore) {
    renderMovies(newMovies, true);
  } else if (isFullViewMovies) {
    renderMovies(allMovies, false);
  } else {
    const head = allMovies.slice(0, firstPaintCount);
    const tail = allMovies.slice(firstPaintCount, MZ_FEED_PAGE_SIZE);
    renderMovies(head, false);
    if (tail.length) {
      const paintTail = () => renderMovies(tail, true);
      if ('requestIdleCallback' in window) requestIdleCallback(paintTail, { timeout: 1500 });
      else setTimeout(paintTail, 300);
    }
  }
  
  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = 'none'; // Paged feed uses #feedPager instead

  // Drawn after the grid so the button row cannot appear before the cards it
  // pages through, which looked broken while the skeletons were still up.
  renderFeedPager();

  /*  Keep the finished pool. This is what makes the NEXT visit to this category
   *  a slice and a render instead of a full re-gather — see _mzFeedPools. Saved
   *  on the load-more path too, because the extension replaced allMovies with a
   *  new array and the stored reference would otherwise be the shorter one. */
  _mzSavePool(cat);
 
  // Har load ke baad agle page ko chupke se fetch karke ready rakho
  if (!isMzTV()) {
    setTimeout(() => prefetchMoviesPage(cat, currentMoviePage + 1), 800);
  }

  if (isLoadMore) {
    isLoadingMore = false;
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) indicator.style.display = 'none';
  }
}
 
// Hover-prefetch budget: ek session me itne se zyada card details prefetch na ho
let _mzHoverPrefetchCount = 0;

/*  ══════════════════════════════════════════════════════════════════════
 *  GRID EVENT DELEGATION — attached once, not per card
 *  ══════════════════════════════════════════════════════════════════════
 *  renderMovies() used to wire six listeners onto every single card: click,
 *  mouseenter (prefetch), touchstart (prefetch), focus (prefetch), mouseenter
 *  (hover lift) and mouseleave (hover lift). It also allocated three closures
 *  per card to capture `m` and `type`.
 *
 *  A first render is 24 cards — 144 listeners. Infinite scroll accumulates, and
 *  the file's own comment already noted the shape of the problem ("200 cards =
 *  400 useless listeners"). At 200 cards that is 1200 listeners and 600 live
 *  closures, all of it built inside one synchronous loop, which is exactly the
 *  kind of block Datadog was reporting as long tasks.
 *
 *  Everything below is now three listeners on the container, forever, reading
 *  the card's data-* attributes. Behaviour is identical: click still bubbles (so
 *  tv-mode.js's synthesised el.click() on Enter keeps working), and prefetch
 *  still fires on hover, touch and keyboard focus.
 *
 *  The hover LIFT is gone altogether. It first lived here as two listeners plus
 *  four inline style writes per card, then moved to a CSS @media (hover: hover)
 *  rule, and is now deleted: lifting a card that carries a 100px-blur shadow
 *  repaints the card, its shadow and its poster on every pointer enter and leave.
 *  Hover feedback on a card is border-color only.
 */
let _mzGridDelegated = false;

function _mzCardPrefetch(card) {
  if (!card || card.hasAttribute('data-mzprefetched')) return;
  if (_mzHoverPrefetchCount >= 24) return;
  if (typeof isDataSaver === 'function' && isDataSaver()) return;
  card.setAttribute('data-mzprefetched', '1');
  _mzHoverPrefetchCount++;
  const id = card.dataset.id;
  const type = card.dataset.type;
  if (!id || !type) return;
  try { tmdb('/' + type + '/' + id, detailParams('videos,credits')); } catch (err) {}
  try { preconnectPlayerHosts(3); } catch (err) {}
}

/*  ══════════════════════════════════════════════════════════════════════
 *  DETAIL REQUEST PARAMS  (single source of truth)
 *  ═══════════════════════════════════════════════════════��══════════════
 *  TMDB applies `language` to the videos it appends as well, so
 *  `language=en-US` alone returns ONLY videos tagged English. That is why the
 *  hover trailer worked on Hollywood titles and silently did nothing on much of
 *  the catalogue: a Hindi, Tamil or Telugu film's trailer is tagged with its own
 *  language, so `videos.results` came back empty and there was nothing to play.
 *
 *  Measured across 54 popular titles spanning en/hi/te/ta/ml/ko movies and
 *  ja/hi/ko series: 22 had no playable video at all, and 10 of those 22 return
 *  one the moment this list is sent (one Tamil title went from 0 videos to 5).
 *  The remaining 12 genuinely have nothing on TMDB — mostly daily soaps and
 *  variety shows — which is why the trailer indicator is now conditional too.
 *
 *  `null` is TMDB's own token for videos carrying no language tag, and those are
 *  usually the ones regional distributors upload.
 *
 *  Built here, in one place, because the hover prefetch and openModal() must send
 *  byte-identical params: tmdb() caches by full URL, so a single differing key
 *  spends the prefetch warming a URL nobody ever asks for.
 *  ══════════════════════════════════════════════════════════════════════ */
const VIDEO_LANGS = 'en,hi,ta,te,ml,kn,mr,bn,pa,ja,ko,null';

function detailParams(append) {
  return {
    language: 'en-US',
    append_to_response: append || 'videos,credits',
    include_video_language: VIDEO_LANGS
  };
}

function ensureGridDelegation(grid) {
  if (_mzGridDelegated || !grid) return;
  _mzGridDelegated = true;

  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.movie-card[data-id]');
    if (!card || !grid.contains(card)) return;
    openModal(parseInt(card.dataset.id, 10), card.dataset.type, event);
  });

  // mouseenter does not bubble, so delegation uses mouseover; the
  // data-mzprefetched guard makes the repeat fires from pointer movement free.
  if (!isMzTV()) {
    grid.addEventListener('mouseover', (event) => {
      const card = event.target.closest('.movie-card[data-id]');
      if (card) _mzCardPrefetch(card);
    }, { passive: true });
    grid.addEventListener('touchstart', (event) => {
      const card = event.target.closest('.movie-card[data-id]');
      if (card) _mzCardPrefetch(card);
    }, { passive: true });
  }

  // focusin is the bubbling counterpart of focus. This is how D-pad navigation
  // triggers prefetch, so it stays enabled on every device.
  grid.addEventListener('focusin', (event) => {
    const card = event.target.closest('.movie-card[data-id]');
    if (card) _mzCardPrefetch(card);
  });
}

function renderMovies(movies, append = false) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;

  renderMoviesRunId += 1;
  const runId = renderMoviesRunId;
  if (renderMoviesTimer) {
    clearTimeout(renderMoviesTimer);
    renderMoviesTimer = null;
  }

  if (!append) {
    if (!movies.length) {
      grid.innerHTML = '<div class="no-results"><h3>No movies found</h3><p>Try a different search or category.</p></div>';
      renderFeedPager();
      return;
    }
    grid.innerHTML = '';
    /*  Second call site for the pager, and not redundant with the one in
     *  loadMovies: search results and the watchlist repaint the grid through
     *  renderMovies directly, never through loadMovies, and would otherwise be
     *  left showing the feed's pager under a finite set of results.
     *  renderFeedPager() reads isSearchResultsMode / isWatchlistMode and clears
     *  itself in those modes, so this hook is the one that covers them.
     */
    renderFeedPager();
  }

  ensureGridDelegation(grid);

  // Quality/freshness timelines are day-quantized, so one timestamp per render
  // pass is as accurate as one per card and skips Date.now() per card.
  const mzNow = Date.now();

  function createMovieCardHTML(m, i) {
    const type   = m.media_type || (m.name && !m.title ? 'tv' : 'movie');
    const rating = m.vote_average ? m.vote_average.toFixed(1) : 'N/A';
    const year   = (m.release_date || m.first_air_date || '').slice(0, 4);
    const genres = (m.genre_ids||[]).slice(0,2).map(id => GENRE_MAP[id]).filter(Boolean);
    const rDateStr = m.release_date || m.first_air_date;
    const isHot  = m.popularity > 100 && ((m.vote_count || 0) > 50 || (mzNow - new Date(rDateStr || '2000-01-01')) / (1000*60*60*24) < 60);

    // -- PRINT QUALITY BADGE --
    // Derived from the release→quality timeline the ALL feed also ranks by
    // (MOVIE_QUALITY_TIMELINE for films, TV_QUALITY_TIMELINE for series and
    // anime), so the badge and the ordering can never disagree.
    const qualityState = titleQualityState(m, mzNow);
    let qual = qualityState.qual;
    let qualClass = qualityState.cls;

    // -- 4K ULTRA HD CATEGORY: force 4K badge on these cards --
    if (m._force4K) { qual = '4K'; qualClass = 'qual-4k'; }

    // -- SMART RELEASE FRESHNESS BADGE --
    // Two things earn the corner ribbon: a recent release, and a recent print
    // upgrade. The second one is why a months-old film that just got its HD
    // print looks new again — same event that lifts it back up the feed.
    let freshBadge = '';
    const daysOld = qualityState.daysOld;
    if (daysOld != null) {
      if (daysOld >= 0 && daysOld <= 3) freshBadge = '<div class="card-fresh card-fresh-today">TODAY</div>';
      else if (daysOld <= 7) freshBadge = '<div class="card-fresh card-fresh-new">NEW</div>';
      else if (daysOld <= 14) freshBadge = '<div class="card-fresh card-fresh-recent">THIS WEEK</div>';
      else if (qualityState.upgradedDaysAgo != null && qualityState.upgradedDaysAgo <= QUALITY_UPGRADE_BADGE_DAYS) {
        freshBadge = '<div class="card-fresh card-fresh-upgrade">NEW ' + escapeHTML(qual) + '</div>';
      }
    }
    // -- HINDI DUBBED BADGE: Show on Hollywood/Japanese/Korean movies (likely dubbed)
    const dubbedLangs = ['en', 'ja', 'ko', 'fr', 'es', 'de']; // Languages that are commonly dubbed to Hindi
    const isDubbedLikely = dubbedLangs.includes(m.original_language) && m.popularity > 50;

    return (
      // data-id / data-type replace the per-card closures the delegated handlers
      // used to need. willChange and animationDelay ride along in the same parse
      // instead of costing two element.style writes each.
      `<div class="movie-card" tabindex="0" data-id="${m.id}" data-type="${type}"` +
        ` style="will-change:auto;animation-delay:${((i % 24) * 0.04)}s">` +
        '<div class="card-poster">' +
          // A single w342 src made every device download the same bytes: ~2.6x the
          // pixels a 1x desktop card displays, and slightly soft on a 3x phone.
          // The srcset lets the browser pick; sizes tells it the real slot width.
          `<img src="${IMG}${m.poster_path}"` +
            ` srcset="https://image.tmdb.org/t/p/w185${m.poster_path} 185w,` +
            ` https://image.tmdb.org/t/p/w342${m.poster_path} 342w,` +
            ` https://image.tmdb.org/t/p/w500${m.poster_path} 500w"` +
            ` sizes="(max-width: 600px) 45vw, (max-width: 1200px) 200px, 230px"` +
            ` alt="${escapeHTML(m.title||'')}" width="171" height="256"` +
            /*  Every grid poster is lazy now, including the first row.
             *
             *  They used to be eager for the first six, justified as
             *  "above-the-fold / LCP". That premise does not hold on this page:
             *  #hero is 95vh tall, so no grid poster is above the fold on any
             *  viewport. Those six were simply six immediate requests to
             *  image.tmdb.org — measured first-byte ~3.2s — racing the hero
             *  backdrop, which is the element LCP is actually scored on.
             *
             *  fetchpriority stays low for the same reason: even once Chrome
             *  decides to start a lazy poster, it must not outbid the hero.
             */
            ` loading="lazy" fetchpriority="low" decoding="async">` +
          `<div class="card-quality ${qualClass||''}">${qual}</div>` +
          (isHot ? '<div class="card-hot">HOT</div>' : '') +
          freshBadge +
          (isDubbedLikely ? '<div class="card-dubbed"> HINDI</div>' : '') +
          '<div class="card-overlay"><button class="card-play-btn" tabindex="-1" aria-hidden="true">&#9654;</button></div>' +
        '</div>' +
        '<div class="card-info">' +
          `<div class="card-title">${escapeHTML(m.title||m.name||'')}</div>` +
          '<div class="card-meta">' +
            `<div class="card-rating">RATING ${rating}</div>` +
            `<div class="card-year">YEAR ${year}</div>` +
          '</div>' +
          `<div class="card-meta"><div class="card-runtime">LANG ${(m.original_language||'EN').toUpperCase()}</div></div>` +
          `<div class="card-genres">${genres.map(g => '<span class="card-genre">'+escapeHTML(g)+'</span>').join('')}</div>` +
        '</div>' +
      '</div>'
      );
  }

  function observeNewCards(startIndex) {
    if (isMzTV()) return;
    for (let n = startIndex; n < grid.children.length; n += 1) scrollObserver.observe(grid.children[n]);
  }

  function appendChunk(startIndex, chunk) {
    const html = chunk.map((m, offset) => createMovieCardHTML(m, startIndex + offset)).join('');
    const firstNew = grid.children.length;
    grid.insertAdjacentHTML('beforeend', html);
    observeNewCards(firstNew);
  }

  async function renderChunked() {
    const chunkSize = mzLowTier ? 2 : 6;
    for (let index = 0; index < movies.length; index += chunkSize) {
      if (runId !== renderMoviesRunId) return;
      appendChunk(index, movies.slice(index, index + chunkSize));
      if (index + chunkSize < movies.length) {
        // Cede the thread after every chunk so input/paint are never starved
        // by the tail render; the runId check above aborts a superseded pass.
        await yieldToMain();
      }
    }
  }

  if (movies.length <= 6) {
    appendChunk(0, movies);
    return;
  }

  renderChunked();
}
 
// CATEGORY FILTER
const CAT_HEADINGS = {
  all:'ALL MOVIES & SHOWS', tv: 'WEB SERIES', hollywood:'HOLLYWOOD', bollywood:'BOLLYWOOD',
  south:'TOLLYWOOD', tollywood:'TOLLYWOOD', action:'ACTION',
  comedy:'COMEDY', horror:'HORROR', thriller:'THRILLER', romance:'ROMANCE',
  scifi:'SCI-FI', animation:'ANIMATION', kids:'CARTOONS', anime:'ANIME SERIES & MOVIES',
  dubbed:'HINDI DUBBED MOVIES', // <-- YE LINE ADD KI HAI
  adult:'18+ ADULT MOVIES & WEB SERIES',
  trending:'🔥 TRENDING NOW', uhd4k:'💎 4K ULTRA HD', toprated:'⭐ TOP RATED',
  kdrama:'K-DRAMA SERIES', netflix:'NETFLIX ORIGINALS',
  prime:'AMAZON PRIME VIDEO', jiohotstar:'JIOHOTSTAR', zee5:'ZEE5 MOVIES & WEB SERIES',
  apple:'APPLE TV+', sonyliv:'SONYLIV', mxplayer:'AMAZON MX PLAYER',
  aha:'AHA', crunchyroll:'CRUNCHYROLL ANIME',
  sunnxt:'SUN NXT', lionsgate:'LIONSGATE PLAY', vi:'VI MOVIES & TV',
  discoveryplus:'DISCOVERY+', shemaroo:'SHEMAROOME',
  adventure:'ADVENTURE', fantasy:'FANTASY', crime:'CRIME', documentary:'DOCUMENTARY', family:'FAMILY'
};
/*  ══════════════════════════════════════════════════════════════════════
 *  GROUPED CATEGORY DROPDOWNS — "OTT Platform" and "Category"
 *  ══════════════════════════════════════════════════════════════════════
 *  The tab strip had grown to 27 pills across three wrapped rows. The
 *  platform and genre filters now live in two dropdowns, leaving only the
 *  primary destinations on the strip itself.
 *
 *  Menu items keep class="cat-tab" deliberately. Two existing functions
 *  depend on it and would break silently otherwise:
 *    • filterCat() marks the active filter by scanning .cat-tab elements
 *    • currentFeedCategory() falls back to .cat-tab.active's onclick before the
 *      first load has recorded a category
 *  A closed menu is display:none, but querySelector still finds elements
 *  inside it, so paging keeps working while the menu is shut.
 *
 *  The nine OTT platforms are NOT in a menu any more — they are reached only from
 *  the Top Providers rail and have no .cat-tab at all. That is exactly why
 *  currentFeedCategory() prefers mzFeedPagerCategory over this scrape.
 */
function closeCatGroups(except) {
  document.querySelectorAll('.cat-group.is-open').forEach(group => {
    if (group === except) return;
    group.classList.remove('is-open');
    group.removeAttribute('data-align');
    const menu = group.querySelector('.cat-group-menu');
    if (menu) { menu.style.top = ''; menu.style.left = ''; }
    const trigger = group.querySelector('.cat-group-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

/*  Which ancestor is the containing block for a position:fixed descendant.
 *  Normally that is the viewport (null here), but several common properties
 *  hijack it — and this page has one: #movies-section carries
 *  `content-visibility: auto`, which implies `contain: paint`. Without this the
 *  panel lands offset by that section's own top (~640px too low on a phone). */
function fixedContainingBlock(el) {
  let node = el.parentElement;
  while (node && node !== document.documentElement) {
    const s = window.getComputedStyle(node);
    const wc = s.willChange || '';
    if ((s.transform && s.transform !== 'none')
      || (s.perspective && s.perspective !== 'none')
      || (s.filter && s.filter !== 'none')
      || (s.backdropFilter && s.backdropFilter !== 'none')
      || (s.contain && /paint|layout|strict|content/.test(s.contain))
      || (s.contentVisibility && s.contentVisibility !== 'visible')
      || (s.containerType && s.containerType !== 'normal')
      || /transform|perspective|filter/.test(wc)) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

// Places the panel.
//
// Desktop: the panel is position:absolute inside .cat-group, so it only needs
// flipping to the right edge when opening it left-aligned would push it
// off-screen.
//
// Phones (<=768px, see the media query in moviezone.css): the tab strip is a
// horizontal scroller and a scroll container clips its descendants on both
// axes, which erased the absolutely positioned panel completely — tapping the
// trigger looked like nothing happened. The panel is position:fixed there and
// gets real viewport coordinates written here: anchored under the trigger,
// clamped inside the viewport, flipped above when there is no room below.
function alignCatGroupMenu(group) {
  const menu = group.querySelector('.cat-group-menu');
  if (!menu) return;
  group.removeAttribute('data-align');
  // Clear the previous run's coordinates before measuring — a stale `left`
  // would skew the fresh rect.
  menu.style.top = '';
  menu.style.left = '';

  const isFixed = window.getComputedStyle(menu).position === 'fixed';
  const trigger = group.querySelector('.cat-group-trigger');

  if (!isFixed || !trigger) {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) group.setAttribute('data-align', 'end');
    return;
  }

  const GAP = 8;
  const EDGE = 10;
  const t = trigger.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Where the panel wants to sit, in viewport coordinates.
  let left = t.left;
  if (left + m.width > vw - EDGE) left = vw - EDGE - m.width;
  if (left < EDGE) left = EDGE;

  let top = t.bottom + GAP;
  if (top + m.height > vh - EDGE) {
    const above = t.top - GAP - m.height;
    // Prefer flipping above the pill; if neither side fits (very short
    // viewport) sit as low as the panel allows instead of overflowing.
    top = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - m.height);
  }

  // Translate those viewport coordinates into the containing block's box.
  const cb = fixedContainingBlock(menu);
  let ox = 0;
  let oy = 0;
  if (cb) {
    const cbRect = cb.getBoundingClientRect();
    const cbStyle = window.getComputedStyle(cb);
    ox = cbRect.left + (parseFloat(cbStyle.borderLeftWidth) || 0);
    oy = cbRect.top + (parseFloat(cbStyle.borderTopWidth) || 0);
  }
  menu.style.left = Math.round(left - ox) + 'px';
  menu.style.top = Math.round(top - oy) + 'px';

  /*  Safety net. The containing block above is derived from computed styles, so
   *  a device/engine that resolves `fixed` differently could still park the
   *  panel off screen — and an off-screen panel is exactly the symptom that
   *  reads as "tapping the pill does nothing". Measure where it actually landed
   *  and nudge it back inside the viewport; the measurement needs no assumption
   *  about which ancestor won. Only runs when something is genuinely out of
   *  view, so a correct placement is never disturbed, and the next alignment
   *  pass recomputes from scratch anyway. */
  const landed = menu.getBoundingClientRect();
  if (landed.width > 0 && landed.height > 0) {
    let fixX = 0;
    let fixY = 0;
    if (landed.right > vw - EDGE) fixX = (vw - EDGE) - landed.right;
    if (landed.left + fixX < EDGE) fixX = EDGE - landed.left;
    if (landed.bottom > vh - EDGE) fixY = (vh - EDGE) - landed.bottom;
    if (landed.top + fixY < EDGE) fixY = EDGE - landed.top;
    if (fixX || fixY) {
      menu.style.left = Math.round(left - ox + fixX) + 'px';
      menu.style.top = Math.round(top - oy + fixY) + 'px';
    }
  }
}

/*  A fixed panel does not travel with the trigger, so keep it glued to the
 *  pill while the page or the tab strip scrolls. Repositioning (rather than
 *  closing on scroll) also matters because focusing the trigger can make the
 *  browser nudge the strip's scrollLeft by a few pixels right after the tap —
 *  a close-on-scroll rule would shut the menu the instant it opened. */
let catGroupReflowQueued = false;
/*  PERF FIX: ye listener capture phase me hai, matlab page ke HAR nested
 *  scroller ke liye bhi fire hota hai. Pehle har event pe
 *  document.querySelector('.cat-group.is-open') chalta tha — selector parse +
 *  DOM walk, scroll ke dauraan sabse mehnga kaam. Live HTMLCollection ek baar
 *  banti hai aur .length check bahut sasta hai. */
const _openCatGroups = document.getElementsByClassName('cat-group is-open');
function scheduleCatGroupReflow() {
  if (catGroupReflowQueued || _openCatGroups.length === 0) return;
  catGroupReflowQueued = true;
  requestAnimationFrame(() => {
    catGroupReflowQueued = false;
    const stillOpen = document.querySelector('.cat-group.is-open');
    if (stillOpen) alignCatGroupMenu(stillOpen);
  });
}

// Capture phase so scrolls inside .cat-tabs are seen too — those do not bubble.
document.addEventListener('scroll', scheduleCatGroupReflow, { capture: true, passive: true });
window.addEventListener('resize', scheduleCatGroupReflow);
window.addEventListener('orientationchange', () => closeCatGroups());

function toggleCatGroup(group) {
  if (!group) return;
  const wasOpen = group.classList.contains('is-open');
  closeCatGroups();
  if (wasOpen) return;
  group.classList.add('is-open');
  const trigger = group.querySelector('.cat-group-trigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  alignCatGroupMenu(group);
  // Second pass on the next frame. The tap can still move the pill under us:
  // focusing the button makes the browser reveal it inside the horizontally
  // scrolling strip, and `scroll-snap-type: x mandatory` then snaps that scroll
  // to a pill edge. The first pass measured the pre-snap position.
  requestAnimationFrame(() => {
    if (group.classList.contains('is-open')) alignCatGroupMenu(group);
  });
}

/** Show a marker on a trigger when the active filter lives inside its menu,
 *  so the user can still see which group they are filtering by once it closes. */
function syncCatGroupTriggers() {
  document.querySelectorAll('.cat-group').forEach(group => {
    const trigger = group.querySelector('.cat-group-trigger');
    if (!trigger) return;
    trigger.classList.toggle('has-active', !!group.querySelector('.cat-group-item.active'));
  });
}

// Delegated: survives the tabs that other code injects at DOMContentLoaded.
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('.cat-group-trigger');
  if (trigger) {
    e.preventDefault();
    toggleCatGroup(trigger.closest('.cat-group'));
    return;
  }
  // The item's own inline onclick has already run filterCat by this point.
  if (e.target.closest('.cat-group-item')) { closeCatGroups(); return; }
  if (!e.target.closest('.cat-group')) closeCatGroups();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.querySelector('.cat-group.is-open')) return;
  closeCatGroups();
});

(function initProviderCarousel() {
  function mount() {
    const section = document.getElementById('top-providers');
    if (!section) return;
    const rail = section.querySelector('#providersRail');
    const controls = section.querySelector('.providers-controls');
    const previous = section.querySelector('[data-provider-scroll="-1"]');
    const next = section.querySelector('[data-provider-scroll="1"]');
    const cards = Array.from(rail.querySelectorAll('.provider-card'));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let scrollFrame = 0;

    function updateControls() {
      scrollFrame = 0;
      const maximum = rail.scrollWidth - rail.clientWidth;
      const overflows = maximum > 2;
      controls.hidden = !overflows;
      const atStart = rail.scrollLeft <= 2;
      const atEnd = rail.scrollLeft >= maximum - 2;
      previous.disabled = atStart;
      next.disabled = atEnd;
      //  The native scrollbar is hidden, so the only remaining cue that the row
      //  continues is the edge fade. CSS cannot measure overflow, hence the
      //  attribute: providers.css maps it to a mask-image on the rail.
      rail.dataset.edge = !overflows ? 'none' : atStart ? 'end' : atEnd ? 'start' : 'both';
    }

    section.addEventListener('click', function (event) {
      const scrollButton = event.target.closest('[data-provider-scroll]');
      if (scrollButton && !scrollButton.disabled) {
        rail.scrollBy({
          left: Number(scrollButton.dataset.providerScroll) * rail.clientWidth * 0.85,
          behavior: reducedMotion.matches ? 'instant' : 'smooth'
        });
      }
      const provider = event.target.closest('[data-provider-cat]');
      if (provider && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
        event.preventDefault();
        filterCat(provider.dataset.providerCat);
        const heading = document.getElementById('sectionHeading');
        if (heading) {
          heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
        }
      }
    });

    rail.addEventListener('keydown', function (event) {
      if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
      const index = cards.indexOf(event.target.closest('.provider-card'));
      if (index < 0) return;
      let target = index;
      if (event.key === 'ArrowRight') target = Math.min(index + 1, cards.length - 1);
      else if (event.key === 'ArrowLeft') target = Math.max(index - 1, 0);
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = cards.length - 1;
      else return;
      event.preventDefault();
      cards[target].focus({ preventScroll: true });
      cards[target].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
    });

    rail.addEventListener('scroll', function () {
      if (!scrollFrame) scrollFrame = requestAnimationFrame(updateControls);
    }, { passive: true });

    /*  There was a hover warm-up here that called prefetchMoviesPage(cat, 1) after a
     *  180ms dwell. It has been removed on purpose. It existed to hide a cold click
     *  that cost ~50 requests, and that cost is now ~7 — the global-trending overlay
     *  and the blocking accuracy sample are both gone from fetchOttMovies. Against a
     *  30-request-per-10-second client cap, speculatively spending 7 more requests on
     *  a platform the user may never open now makes the click they DO make slower,
     *  not faster. The fix belongs at the source, and that is where it is. */

    if (typeof ResizeObserver === 'function') new ResizeObserver(updateControls).observe(rail);
    else window.addEventListener('resize', updateControls, { passive: true });
    updateControls();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();

function filterCat(cat, e) {
  if (e) e.preventDefault();
  isSearchResultsMode = false;
  isWatchlistMode = false;
  const scrollTrigger = document.getElementById('infiniteScrollTrigger');
  if (scrollTrigger) scrollTrigger.style.display = '';
  document.querySelectorAll('.cat-tab').forEach(t => { t.classList.remove('active'); });
  const tabs = document.querySelectorAll('.cat-tab');
  tabs.forEach(t => { if (_mzTabCat(t) === cat) t.classList.add('active'); });
  syncCatGroupTriggers();
  const h = document.getElementById('sectionHeading');
  if (h) h.textContent = CAT_HEADINGS[cat] || 'MOVIES';
  // Anime ke liye extra sub-filter bar (Trending / Latest / Airing / Top Rated ...)
  if (cat === 'anime') { renderAnimeFilterBar(); updateAnimeHeading(); } else { hideAnimeFilterBar(); }
  // Cartoons ke liye apna sub-filter bar (Trending / Famous / Hindi / Doraemon & Co ...)
  if (cat === 'kids') { renderCartoonFilterBar(); updateCartoonHeading(); } else { hideCartoonFilterBar(); }
  // OTT platforms ke liye All / Movies / Web Series sub-filter bar.
  //  A platform is always ENTERED on 'all': filterCat is only reached from the
  //  provider rail (and the genre tabs), so the previous platform's chip must not
  //  carry over into the next one. setOttMode() changes the mode from then on and
  //  calls loadMovies directly, so it never passes through here.
  if (OTT[cat]) { currentOttMode = 'all'; renderOttFilterBar(cat); } else { hideOttFilterBar(); }
  if (OTT[cat]) updateOttHeading(cat);
  const sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: isMzTVMode() ? 'auto' : 'smooth' });
  loadMovies(cat);
}
 
/*  ══════════════════════════════════════════════════════════════════════
 *  FEED PAGINATION
 *  ══════════════════════════════════════════════════════════════════════
 *  The feed used to grow without end: an IntersectionObserver 400px below the
 *  grid fired loadMoreMoviesAction() and appended another page, forever. Nothing
 *  below the grid was ever reachable, the DOM grew on every scroll, and it
 *  fetched titles nobody asked for.
 *
 *  ── HOW PAGES ARE PRODUCED, AND WHY IT IS NOT ONE FETCH PER PAGE ───────────
 *  The obvious implementation — page N asks TMDB for page N — was wrong here,
 *  and measurably so.
 *
 *  One gather already returns far more than a screenful. The ALL feed merges 16
 *  sources at 20 results each, and after dedup and ranking that is a pool of
 *  roughly 200 unique titles. The old code rendered allMovies.slice(0, 24) and
 *  discarded the rest. So "page 2" refetched all 16 sources to build another 200
 *  and again showed 24 — paying a full round-trip for titles it already had.
 *
 *  Worse, it produced duplicates. Source A's page 2 routinely contains titles
 *  that were in source B's page 1, and dedup only ran within a single gather
 *  (allMovies is cleared on a page change), so a title shown on page 1 could
 *  reappear on page 2. That is the reported bug.
 *
 *  So pages are slices of the pool instead:
 *
 *      page N  =  allMovies[(N-1)*24 .. N*24]
 *
 *  Two things fall out of that, both of them the behaviour asked for:
 *
 *    • NO DUPLICATES, by construction. allMovies is deduped by type+id before it
 *      is ever sliced, so a title cannot occupy two pages.
 *    • NO REFETCH. Moving between pages that the pool already covers is a slice
 *      and a render — no network, no skeletons, nothing to wait for. One gather
 *      now serves ~8 pages instead of 1.
 *
 *  When the pool runs short the next TMDB page is fetched and APPENDED, so the
 *  pool only ever grows and earlier pages keep showing exactly what they showed
 *  before. Only whole pages are offered while more titles may exist, so a page is
 *  never shown half-full and then quietly refilled underneath the user.
 */

/*  Cards per page.
 *
 *  30, i.e. five rows of six on a desktop window. The grid is
 *  repeat(auto-fill, minmax(185px, 1fr)), so the column count follows the
 *  viewport — six across on a wide window, two on a phone. This number is
 *  therefore "cards per page", and the row count it produces depends on width;
 *  30 is what gives five rows at the six-across desktop layout.
 *
 *  Was 24 (four rows). Raising it costs nothing in requests: one gather already
 *  yields a pool of roughly 200 titles, so this only changes how much of that
 *  pool each page reveals — about 6 pages per gather instead of 8.
 */
const MZ_FEED_PAGE_SIZE = 30;

/*  Hard ceiling, to match the SSR category pager and because TMDB's popularity
 *  ordering stops meaning much past this depth. */
const MZ_FEED_PAGE_CAP = 25;

/*  Set false to hand the feed back to infinite scroll. setupInfiniteScroll()
 *  reads this rather than being deleted, so the old behaviour is one line away. */
const MZ_FEED_PAGED = true;

let mzFeedPage = 1;
let mzFeedPagerCategory = 'all';
let mzFeedPoolExhausted = false;   // TMDB has no further pages for this category
let _mzPagerDelegated = false;

/** Where the current page starts in the pool. */
function mzFeedPageStart(page) {
  return (Math.max(1, page) - 1) * MZ_FEED_PAGE_SIZE;
}

/*  How many pages to offer.
 *
 *  Only COMPLETE pages while the pool can still grow: offering a page that holds
 *  eight titles today and twenty-four after the next extension would change
 *  content under someone who had already looked at it. Once TMDB is exhausted the
 *  final partial page is offered, because then it is final.
 *
 *  One extra page is offered beyond what the pool covers so that Next stays
 *  reachable and can trigger the extension.
 */
function mzFeedTotalPages() {
  const size = allMovies.length;
  if (mzFeedPoolExhausted) {
    return Math.max(1, Math.min(Math.ceil(size / MZ_FEED_PAGE_SIZE), MZ_FEED_PAGE_CAP));
  }
  return Math.max(1, Math.min(Math.floor(size / MZ_FEED_PAGE_SIZE) + 1, MZ_FEED_PAGE_CAP));
}

/** True when the pool can already fill the page without touching the network. */
function mzFeedPageIsReady(page) {
  const start = mzFeedPageStart(page);
  return mzFeedPoolExhausted
    ? start < allMovies.length
    : allMovies.length >= start + MZ_FEED_PAGE_SIZE;
}

/*  Which page numbers to show: first, last, the current page's neighbours, and
 *  every fifth page, with … standing in for the runs left out.
 *
 *  Deliberately the same rule as the SSR pager in seo-ssr.js, so the homepage
 *  control and the category-page control are recognisably the same thing.
 */
function mzFeedPageNumbers(page, totalPages) {
  const wanted = new Set([1, totalPages, page - 1, page, page + 1]);
  for (let p = 5; p <= totalPages; p += 5) wanted.add(p);
  return [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
}

/*  Renders the current page out of the pool.
 *
 *  Keeps the two-stage paint the feed already used — a few cards immediately, the
 *  rest on an idle callback — so a page change costs the same main-thread work as
 *  the first load rather than one 24-card long task.
 */
function renderCurrentFeedPage() {
  const start = mzFeedPageStart(mzFeedPage);
  const slice = allMovies.slice(start, start + MZ_FEED_PAGE_SIZE);
  const firstPaint = mzLowTier ? 4 : 8;

  renderMovies(slice.slice(0, firstPaint), false);
  const tail = slice.slice(firstPaint);
  if (tail.length) {
    const paintTail = () => renderMovies(tail, true);
    if ('requestIdleCallback' in window) requestIdleCallback(paintTail, { timeout: 1500 });
    else setTimeout(paintTail, 300);
  }

  /*  Record where the user now is, AFTER the paint so this never sits between a
   *  click and its first frame.
   *
   *  The pager and load-more both move mzFeedPage without going back through
   *  loadMovies, so the stored pool would otherwise remember a page the user left
   *  long ago and drop them back onto it when they return to the category. This
   *  is the one function every page change goes through. */
  const pool = _mzFeedPools.get(_mzPoolKey(mzFeedPagerCategory));
  if (pool) { pool.page = mzFeedPage; pool.exhausted = mzFeedPoolExhausted; }

  return slice.length;
}

/*  Buttons, not links.
 *
 *  An <a href="?page=2"> would be the SEO-friendly choice, but this page already
 *  runs two popstate listeners over hash-based routes (the player deep link and
 *  the collections hub), and a competing query-param history entry would fight
 *  them. The crawlable paginated URLs already exist as the SSR category pages
 *  (/movies/action?page=2), which is where that job belongs.
 */
function renderFeedPager() {
  const host = document.getElementById('feedPager');
  if (!host) return;

  // Search results and the watchlist are finite sets held locally — asking for
  // page 2 of them is meaningless.
  if (!MZ_FEED_PAGED || isSearchResultsMode || isWatchlistMode) {
    host.innerHTML = '';
    return;
  }

  const total = mzFeedTotalPages();
  if (total <= 1) { host.innerHTML = ''; return; }

  const page = Math.min(Math.max(1, mzFeedPage), total);
  const parts = [];

  if (page > 1) {
    parts.push('<button type="button" class="mz-pager-btn mz-pager-step" data-page="'
      + (page - 1) + '" aria-label="Previous page">&larr; Prev</button>');
  }

  let previous = 0;
  mzFeedPageNumbers(page, total).forEach((p) => {
    if (previous && p - previous > 1) {
      parts.push('<span class="mz-pager-gap" aria-hidden="true">&hellip;</span>');
    }
    parts.push(p === page
      ? '<span class="mz-pager-cur" aria-current="page">' + p + '</span>'
      : '<button type="button" class="mz-pager-btn" data-page="' + p
        + '" aria-label="Go to page ' + p + '">' + p + '</button>');
    previous = p;
  });

  if (page < total) {
    parts.push('<button type="button" class="mz-pager-btn mz-pager-step" data-page="'
      + (page + 1) + '" aria-label="Next page">Next &rarr;</button>');
  }

  host.innerHTML = '<nav class="mz-pager" aria-label="Movie feed pagination">'
    + parts.join('') + '</nav>';
  ensurePagerDelegation();
}

/*  One listener on the container, not one per button — the pager is re-rendered
 *  on every page change, and per-button handlers would leak a set each time.
 */
function ensurePagerDelegation() {
  const host = document.getElementById('feedPager');
  if (!host || _mzPagerDelegated) return;
  _mzPagerDelegated = true;

  host.addEventListener('click', (event) => {
    const btn = event.target.closest('.mz-pager-btn[data-page]');
    if (!btn) return;
    goToFeedPage(parseInt(btn.dataset.page, 10));
  });
}

function goToFeedPage(page) {
  if (!Number.isInteger(page) || page < 1) return;
  if (isLoadingMore) return;

  const target = Math.min(page, mzFeedTotalPages());
  if (target === mzFeedPage) return;

  /*  Scroll before the paint, not after: the grid is about to be replaced, and
   *  leaving the user at the old offset would put the new page's first row above
   *  them. */
  const sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: isMzTVMode() ? 'auto' : 'smooth', block: 'start' });

  mzFeedPage = target;

  /*  The pool already covers this page, so there is nothing to fetch. This is
   *  the path Prev and any already-visited page take: a slice and a render, no
   *  request, no skeletons, and byte-identical content to last time. */
  if (mzFeedPageIsReady(target)) {
    renderCurrentFeedPage();
    renderFeedPager();
    return;
  }

  /*  Past what the pool holds: extend it. isLoadMore appends the next TMDB page
   *  to allMovies rather than replacing it, so every earlier page keeps showing
   *  exactly what it showed before, and the new titles cannot repeat old ones —
   *  loadMovies dedups the append against the whole pool. */
  loadMovies(mzFeedPagerCategory, true);
}
window.goToFeedPage = goToFeedPage;

/*  The single source of truth for "which category is on screen".
 *
 *  This used to be recovered by reading .cat-tab.active's onclick. That worked
 *  only while every category had a tab — and the nine OTT platforms no longer do,
 *  because the OTT Platform dropdown was removed in favour of the Top Providers
 *  rail. Left as it was, paging or a refresh on a platform feed would find no
 *  active tab, silently fall back to 'all', and throw the user out of Netflix
 *  back into the general feed.
 *
 *  loadMovies() assigns mzFeedPagerCategory on every load, including OTT loads, so
 *  it is already authoritative. The tab scrape is kept only as a fallback for the
 *  very first interaction, before any load has happened. */
function currentFeedCategory() {
  if (mzFeedPagerCategory) return mzFeedPagerCategory;
  const activeTab = document.querySelector('.cat-tab.active');
  const onclick = activeTab && activeTab.getAttribute('onclick');
  if (onclick && onclick.includes('filterCat')) {
    const match = onclick.match(/'([^']+)'/);
    if (match) return match[1];
  }
  return 'all';
}

function loadMoreMoviesAction() {
  loadMovies(currentFeedCategory(), true);
}
 
// -- WATCHLIST LOGIC --
function handleWatchlistToggle() {
  if (!currentModalMovie) return;
  const idx = watchlist.findIndex(m => m.id === currentModalMovie.id);
  if (idx > -1) {
    watchlist.splice(idx, 1);
    showToast('Removed from Watchlist');
  } else {
    watchlist.push(currentModalMovie);
    showToast('Added to Watchlist');
  }
  localStorage.setItem('mz_watchlist', JSON.stringify(watchlist));
  updateModalWatchlistBtn(currentModalMovie.id);
  
  // Update UI immediately if user is viewing the Watchlist tab
  const h = document.getElementById('sectionHeading');
  if (h && h.textContent.includes('MY WATCHLIST')) {
    renderMovies(watchlist);
  }
}
function updateModalWatchlistBtn(id) {
  const btn = document.getElementById('modalWatchlistBtn');
  if (!btn) return;
  const isSaved = watchlist.some(m => m.id === id);
  btn.innerHTML = isSaved 
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg><span>Saved</span>' 
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg><span>Watchlist</span>';
  btn.classList.toggle('active', isSaved);
}
function showWatchlist(e) {
  if (e) e.preventDefault();
  isSearchResultsMode = false;
  isWatchlistMode = true;
  hideAnimeFilterBar();
  // No hideOttFilterBar() any more — the OTT chip bar no longer exists.
  // Nothing to page here, so take the sentinel out of the viewport entirely
  // rather than relying on the observer callback to bail.
  const scrollTrigger = document.getElementById('infiniteScrollTrigger');
  if (scrollTrigger) scrollTrigger.style.display = 'none';
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  const tabs = document.querySelectorAll('.cat-tab');
  tabs.forEach(t => { if ((t.getAttribute('onclick')||'').includes('showWatchlist')) t.classList.add('active'); });
  syncCatGroupTriggers();
  const h = document.getElementById('sectionHeading');
  if (h) {
    h.innerHTML = 'MY WATCHLIST' + (watchlist.length > 0 ? ' <button onclick="clearWatchlist()" class="clear-watchlist-btn"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Clear All</button>' : '');
  }
  const sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: isMzTVMode() ? 'auto' : 'smooth' });
  renderMovies(watchlist);
  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = 'none';
}

function clearWatchlist() {
  if (confirm('Are you sure you want to completely clear your watchlist?')) {
    watchlist = [];
    localStorage.removeItem('mz_watchlist');
    showToast('Watchlist cleared successfully');
    renderMovies(watchlist);
    const h = document.getElementById('sectionHeading');
    if (h) h.innerHTML = 'MY WATCHLIST';
  }
}
 
// -- UPCOMING
async function loadUpcoming(isLoadMore = false) {
  const grid = document.getElementById('upcomingGrid');
  if (!grid) return;
  
  if (!isLoadMore) {
    currentUpcomingPage = 1;
    /*  CLS — the placeholder count and shape have to match what actually
     *  renders below (allUpcoming.slice(0, 12)), because this section is
     *  filled from an IntersectionObserver, i.e. exactly when it is on
     *  screen. Four poster-shaped .skeleton-cards reserved roughly half the
     *  height twelve 370px cards then needed, so the section grew under the
     *  user and dragged the footer with it. */
    grid.innerHTML = Array(12).fill('<div class="skeleton upcoming-skeleton" aria-hidden="true"></div>').join('');
    allUpcoming = [];
  } else {
    currentUpcomingPage++;
    const btn = document.getElementById('loadMoreUpcomingBtn');
    if (btn) btn.innerHTML = 'Loading...';
  }

  try {
    /*  Every industry, one round-trip — see UPCOMING_SOURCES. This replaced two
     *  English + two `region: IN` Hindi requests, which is why the section only
     *  ever showed Hollywood. */
    const res = await tmdbBatch(upcomingPagePlan(currentUpcomingPage));
    let movies = [];
    res.forEach(r => {
      if (r.status === 'fulfilled' && r.value && r.value.results) movies = movies.concat(r.value.results);
    });
    
    const realToday = new Date().toISOString().split('T')[0];
    movies = movies.filter(m => m && m.poster_path && m.release_date && m.release_date >= realToday); // Removed backdrop requirement for upcoming
    
    const existingIds = new Set(allUpcoming.map(m => m.id));
    let newMovies = movies.filter(m => { if(existingIds.has(m.id)) return false; existingIds.add(m.id); return true; });
    newMovies.sort((a, b) => a.release_date.localeCompare(b.release_date));
    /*  Chronological, but no single industry may take more than a few cards in
     *  a row — otherwise the twelve cards on the first screen are still all
     *  Hollywood simply because it releases something every week. */
    newMovies = interleaveUpcomingByIndustry(newMovies);
    
    allUpcoming = allUpcoming.concat(newMovies);
 
    if (!isLoadMore) grid.innerHTML = '';
    const fragment = document.createDocumentFragment();
 
    const moviesToRender = isLoadMore ? newMovies : (isFullViewUpcoming ? allUpcoming : allUpcoming.slice(0, 12));
 
    moviesToRender.forEach((m, i) => {
      let dateStr = 'Coming Soon';
      if (m.release_date) {
        try { dateStr = new Date(m.release_date).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }); } catch(e){}
      }
      const posterImg = m.backdrop_path ? (isMzTV() ? 'https://image.tmdb.org/t/p/w780' : 'https://image.tmdb.org/t/p/w500') + m.backdrop_path : IMG + m.poster_path;
      const genres = (m.genre_ids||[]).slice(0,2).map(id => GENRE_MAP[id]).filter(Boolean);
      
      // Calculate countdown days
      let countdownText = '';
      if (m.release_date) {
        const relDate = new Date(m.release_date);
        const today = new Date();
        today.setHours(0,0,0,0);
        const daysLeft = Math.ceil((relDate - today) / (1000 * 60 * 60 * 24));
        if (daysLeft === 0) countdownText = 'Releasing TODAY!';
        else if (daysLeft === 1) countdownText = 'Tomorrow!';
        else if (daysLeft <= 7) countdownText = daysLeft + ' days left';
        else if (daysLeft <= 30) countdownText = Math.ceil(daysLeft / 7) + ' weeks left';
        else countdownText = Math.ceil(daysLeft / 30) + ' months left';
      }

      const card = document.createElement('div');
      card.className = 'upcoming-card reveal-up';
      card.tabIndex = 0;
      /*  PERF (TV / low-end): will-change promotes every card to its own
       *  compositor layer and keeps it there for the life of the page — twelve
       *  layers of poster-sized texture on a device with a few hundred MB of
       *  graphics memory. On TV it buys literally nothing: tv-mode.css forces
       *  .reveal-up to full opacity, so the animation this was hinting at never
       *  runs (same reason the reveal observer is skipped below). The staggered
       *  animationDelay is dead weight there for exactly the same reason.
       *
       *  Capable devices keep both — the stagger is part of how the section
       *  looks, and the hint still helps the animation that actually plays. */
      if (!isMzTV() && !mzLowTier) {
        card.style.willChange = 'transform, opacity';
        card.style.animationDelay = ((i % 12) * 0.08) + 's';
      }
      card.innerHTML =
        '<div class="upcoming-poster">' +
          // PERF FIX: same eager->lazy fix as the movie grid (see renderMovies).
          '<img src="'+posterImg+'" alt="'+escapeHTML(m.title||'')+'" width="280" height="157" style="aspect-ratio:16/9;object-fit:cover;" loading="'+((!isLoadMore && i < 6) ? 'eager' : 'lazy')+'" decoding="async">' +
          '<div class="upcoming-poster-overlay"></div>' +
          '<div class="upcoming-release-badge"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="margin-right:4px;vertical-align:-1px"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z"/></svg>'+dateStr+'</div>' +
          (countdownText ? '<div class="upcoming-countdown-badge">⏳ '+countdownText+'</div>' : '') +
          '<div class="upcoming-play-hint"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3" stroke-linecap="round"/></svg><span>View Details</span></div>' +
        '</div>' +
        '<div class="upcoming-info">' +
          '<div class="upcoming-title">'+escapeHTML(m.title||'')+'</div>' +
          '<div class="upcoming-meta">' +
            '<div class="upcoming-lang-badge">'+(m.original_language||'en').toUpperCase()+'</div>' +
            genres.map(g => '<span class="upcoming-genre-tag">'+escapeHTML(g)+'</span>').join('') +
          '</div>' +
          '<p class="upcoming-desc">'+escapeHTML((m.overview||'').slice(0, 120))+(m.overview && m.overview.length > 120 ? '...' : '')+'</p>' +
          '<button class="notify-me-btn'+(typeof isNotifySet === 'function' && isNotifySet(m.id) ? ' notified' : '')+'" data-movie-id="'+m.id+'" data-title="'+escapeHTML(m.title||'')+'" data-release="'+(m.release_date||'')+'" onclick="event.stopPropagation(); handleNotifyMe(this)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span>'+(typeof isNotifySet === 'function' && isNotifySet(m.id) ? 'Notified ✓' : 'Notify Me')+'</span></button>' +
        '</div>';
      card.addEventListener('click', (event) => { openUpcomingDetail(m.id, undefined, event); });
      fragment.appendChild(card);
      // PERF (TV): reveal observer skip — TV CSS me .reveal-up ka opacity force hai.
      if (!isMzTV()) scrollObserver.observe(card);
    });
    grid.appendChild(fragment);
    
    const loadMoreBtn = document.getElementById('loadMoreUpcomingBtn');
    if (loadMoreBtn) {
      loadMoreBtn.style.display = 'none';
      loadMoreBtn.innerHTML = 'Load More Upcoming';
    }
  } catch(e) { console.warn(e); }
 
  // Har load ke baad agle upcoming page ko chupke se fetch karke ready rakho
  if (!isMzTV()) {
    setTimeout(() => prefetchUpcomingPage(currentUpcomingPage + 1), 800);
  }
}

// ── UPCOMING MOVIE DETAIL PAGE (Premium Info Modal) ──
let currentUpcomingMovie = null;
let upcomingTrailerKey = null;

let _udAbortController = null;

async function openUpcomingDetail(id, type, activationEvent) {
  if (!claimExplicitDetailActivation(activationEvent)) return;
  const mediaType = type || 'movie';
  const overlay = document.getElementById('upcoming-detail-overlay');
  if (!overlay) return;
  
  // Abort any previous pending request
  if (_udAbortController) {
    _udAbortController.abort();
    _udAbortController = null;
  }
  _udAbortController = new AbortController();
  const currentRequestId = id; // Track which movie this request is for
  
  // Open overlay instantly
  overlay.classList.add('open');
  if (!isMzTV()) {
    document.body.style.overflow = 'hidden';
  }
  overlay.scrollTop = 0;
  
  // Show loading state
  document.getElementById('udTitle').textContent = 'Loading...';
  document.getElementById('udOverview').textContent = '';
  document.getElementById('udMeta').innerHTML = '<div class="player-spinner" style="width:24px;height:24px;border-width:2px;border-color:rgba(255,255,255,0.1);border-left-color:var(--gold);"></div>';
  document.getElementById('udGenres').innerHTML = '';
  document.getElementById('udTagline').textContent = '';
  document.getElementById('udCastGrid').innerHTML = '';
  document.getElementById('udExtraInfo').innerHTML = '';
  document.getElementById('udTrailerSection').style.display = 'none';
  document.getElementById('udCastSection').style.display = 'none';
  
  try {
    // Fetch full movie details with videos, credits, and similar
    const details = await tmdb('/' + mediaType + '/' + id, detailParams('videos,credits,similar'));
    
    // If another request was started while this one was loading, discard this result
    if (_udAbortController && _udAbortController.signal.aborted) return;
    
    // TMDB has no record for this id. Closing silently reads as a dead tap, so
    // say one sentence and prune the entry that pointed at it. _mzMissing covers
    // the confirmed-404 case; the !details.id test still catches anything else
    // that comes back without a usable body.
    if (details && details._mzMissing) {
      closeUpcomingDetail();
      _mzForgetDeadTitle(id, mediaType);
      if (typeof showToast === 'function') showToast('This title is no longer available.');
      return;
    }
    if (!details || !details.id) { closeUpcomingDetail(); return; }
    
    currentUpcomingMovie = details;
    
    // Backdrop
    const bdEl = document.getElementById('udBackdrop');
    if (details.backdrop_path) {
      bdEl.src = getResponsiveBackdrop(details.backdrop_path);
    } else if (details.poster_path) {
      bdEl.src = 'https://image.tmdb.org/t/p/w780' + details.poster_path;
    }
    
    // Poster
    const posterEl = document.getElementById('udPoster');
    if (details.poster_path) {
      posterEl.src = 'https://image.tmdb.org/t/p/w342' + details.poster_path;
    }
    
    // Title
    document.getElementById('udTitle').textContent = details.title || details.name || '';
    
    // Tagline
    const taglineEl = document.getElementById('udTagline');
    if (details.tagline) {
      taglineEl.textContent = '"' + details.tagline + '"';
      taglineEl.style.display = 'block';
    } else {
      taglineEl.style.display = 'none';
    }
    
    // Meta info
    let metaHTML = '';
    const releaseDate = details.release_date || details.first_air_date;
    if (releaseDate) {
      const relDate = new Date(releaseDate);
      const dateFormatted = relDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      metaHTML += '<span class="ud-meta-item ud-meta-date"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z"/></svg> ' + dateFormatted + '</span>';
    }
    const runtime = details.runtime || (details.episode_run_time && details.episode_run_time[0]) || 0;
    if (runtime) {
      const hrs = Math.floor(runtime / 60);
      const mins = runtime % 60;
      metaHTML += '<span class="ud-meta-item"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z"/></svg> ' + (hrs ? hrs + 'h ' : '') + mins + 'min</span>';
    }
    if (details.original_language) {
      metaHTML += '<span class="ud-meta-item">' + details.original_language.toUpperCase() + '</span>';
    }
    if (details.vote_average > 0) {
      metaHTML += '<span class="ud-meta-item ud-meta-rating"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg> ' + details.vote_average.toFixed(1) + '</span>';
    }
    if (details.budget > 0) {
      metaHTML += '<span class="ud-meta-item">💰 Budget: $' + (details.budget / 1000000).toFixed(0) + 'M</span>';
    }
    document.getElementById('udMeta').innerHTML = metaHTML;
    
    // Genres
    let genresHTML = '';
    if (details.genres && details.genres.length) {
      genresHTML = details.genres.map(g => '<span class="ud-genre-tag">' + escapeHTML(g.name) + '</span>').join('');
    }
    document.getElementById('udGenres').innerHTML = genresHTML;
    
    // Overview
    document.getElementById('udOverview').textContent = details.overview || 'No overview available yet.';
    
    // Countdown
    const countdownEl = document.getElementById('udCountdown');
    if (releaseDate) {
      const relDate = new Date(releaseDate);
      const today = new Date();
      today.setHours(0,0,0,0);
      const daysLeft = Math.ceil((relDate - today) / (1000 * 60 * 60 * 24));
      
      if (daysLeft > 0) {
        const months = Math.floor(daysLeft / 30);
        const weeks = Math.floor((daysLeft % 30) / 7);
        const days = daysLeft % 7;
        let countdownHTML = '<div class="ud-countdown-label">RELEASING IN</div><div class="ud-countdown-timer">';
        if (months > 0) countdownHTML += '<div class="ud-countdown-unit"><span class="ud-countdown-num">' + months + '</span><span class="ud-countdown-txt">MONTHS</span></div>';
        if (weeks > 0 || months > 0) countdownHTML += '<div class="ud-countdown-unit"><span class="ud-countdown-num">' + weeks + '</span><span class="ud-countdown-txt">WEEKS</span></div>';
        countdownHTML += '<div class="ud-countdown-unit"><span class="ud-countdown-num">' + days + '</span><span class="ud-countdown-txt">DAYS</span></div>';
        countdownHTML += '</div>';
        countdownEl.innerHTML = countdownHTML;
        countdownEl.style.display = 'flex';
      } else if (daysLeft === 0) {
        countdownEl.innerHTML = '<div class="ud-countdown-label" style="color:var(--gold)">🎬 RELEASING TODAY!</div>';
        countdownEl.style.display = 'flex';
      } else {
        // Already released - hide countdown
        countdownEl.innerHTML = '';
        countdownEl.style.display = 'none';
      }
    } else {
      countdownEl.innerHTML = '';
      countdownEl.style.display = 'none';
    }
    
    // Trailer
    upcomingTrailerKey = null;
    if (details.videos && details.videos.results) {
      const ytVids = details.videos.results.filter(v => v.site === 'YouTube');
      const trailer = ytVids.find(v => v.type === 'Trailer') || ytVids.find(v => v.type === 'Teaser') || ytVids[0];
      if (trailer) {
        upcomingTrailerKey = trailer.key;
        document.getElementById('udTrailerBtn').style.display = 'inline-flex';
      } else {
        document.getElementById('udTrailerBtn').style.display = 'none';
      }
    } else {
      document.getElementById('udTrailerBtn').style.display = 'none';
    }
    
    // Cast
    if (details.credits && details.credits.cast && details.credits.cast.length > 0) {
      const castSection = document.getElementById('udCastSection');
      const castGrid = document.getElementById('udCastGrid');
      castSection.style.display = 'block';
      
      const topCast = details.credits.cast.slice(0, 10);
      castGrid.innerHTML = topCast.map(person => {
        const imgSrc = person.profile_path 
          ? 'https://image.tmdb.org/t/p/w185' + person.profile_path 
          : 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%22120%22><rect width=%2280%22 height=%22120%22 fill=%22%23222%22/><text x=%2240%22 y=%2265%22 fill=%22%23555%22 text-anchor=%22middle%22 font-size=%2224%22>👤</text></svg>';
        return '<div class="ud-cast-card">' +
          '<img src="' + imgSrc + '" alt="' + escapeHTML(person.name) + '" width="80" height="120" loading="lazy" decoding="async">' +
          '<div class="ud-cast-name">' + escapeHTML(person.name) + '</div>' +
          '<div class="ud-cast-char">' + escapeHTML(person.character || '') + '</div>' +
        '</div>';
      }).join('');
    }
    
    // Director + Production
    let extraHTML = '';
    if (details.credits && details.credits.crew) {
      const directors = details.credits.crew.filter(c => c.job === 'Director');
      if (directors.length > 0) {
        extraHTML += '<div class="ud-extra-row"><span class="ud-extra-label">Director</span><span class="ud-extra-value">' + directors.map(d => escapeHTML(d.name)).join(', ') + '</span></div>';
      }
    }
    if (details.production_companies && details.production_companies.length > 0) {
      extraHTML += '<div class="ud-extra-row"><span class="ud-extra-label">Production</span><span class="ud-extra-value">' + details.production_companies.slice(0, 3).map(c => escapeHTML(c.name)).join(', ') + '</span></div>';
    }
    if (details.production_countries && details.production_countries.length > 0) {
      extraHTML += '<div class="ud-extra-row"><span class="ud-extra-label">Country</span><span class="ud-extra-value">' + details.production_countries.map(c => escapeHTML(c.name)).join(', ') + '</span></div>';
    }
    if (details.status) {
      extraHTML += '<div class="ud-extra-row"><span class="ud-extra-label">Status</span><span class="ud-extra-value">' + escapeHTML(details.status) + '</span></div>';
    }
    document.getElementById('udExtraInfo').innerHTML = extraHTML;
    
    // Watchlist button state
    updateUpcomingWatchlistBtn(details.id);
    
  } catch (err) {
    // If aborted due to new request, don't show error
    if (err && err.name === 'AbortError') return;
    if (_udAbortController && _udAbortController.signal.aborted) return;
    console.error('Upcoming Detail Error:', err);
    document.getElementById('udTitle').textContent = 'Error loading movie details';
  }
}

function closeUpcomingDetail() {
  // Abort any pending fetch
  if (_udAbortController) {
    _udAbortController.abort();
    _udAbortController = null;
  }
  const overlay = document.getElementById('upcoming-detail-overlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
  
  // Stop any playing trailer
  const embed = document.getElementById('udTrailerEmbed');
  if (embed) embed.innerHTML = '';
  document.getElementById('udTrailerSection').style.display = 'none';
  
  currentUpcomingMovie = null;
  upcomingTrailerKey = null;
}

function playUpcomingTrailer() {
  if (!upcomingTrailerKey) return;
  const section = document.getElementById('udTrailerSection');
  const embed = document.getElementById('udTrailerEmbed');
  section.style.display = 'block';
  embed.innerHTML = '<iframe src="https://www.youtube.com/embed/' + upcomingTrailerKey + '?autoplay=1&rel=0" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen style="width:100%;aspect-ratio:16/9;border-radius:12px;"></iframe>';
  section.scrollIntoView({ behavior: isMzTVMode() ? 'auto' : 'smooth', block: 'center' });
}

function handleUpcomingWatchlist() {
  if (!currentUpcomingMovie) return;
  const idx = watchlist.findIndex(m => m.id === currentUpcomingMovie.id);
  if (idx > -1) {
    watchlist.splice(idx, 1);
    showToast('Removed from Watchlist');
  } else {
    watchlist.push(currentUpcomingMovie);
    showToast('Added to Watchlist');
  }
  localStorage.setItem('mz_watchlist', JSON.stringify(watchlist));
  updateUpcomingWatchlistBtn(currentUpcomingMovie.id);
}

function updateUpcomingWatchlistBtn(id) {
  const btn = document.getElementById('udWatchlistBtn');
  if (!btn) return;
  const isSaved = watchlist.some(m => m.id === id);
  btn.innerHTML = isSaved 
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Saved!'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Add to Watchlist';
  btn.classList.toggle('active', isSaved);
}

// Close upcoming detail on back button
window.addEventListener('popstate', () => {
  const overlay = document.getElementById('upcoming-detail-overlay');
  if (overlay && overlay.classList.contains('open')) {
    closeUpcomingDetail();
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * INTELLIGENT SEARCH  v2.0
 * ------------------------------------------------------------------------
 *  1. DEBOUNCE ............ 350ms trailing debounce (MovieZoneSearch.debounce)
 *                           => zero API calls while the user is still typing.
 *  2. AUTO-SUGGESTIONS .... 2+ characters hit TMDb /search/movie (+ /search/tv
 *                           and /search/multi for series & people) and render a
 *                           live dropdown with poster thumbnails under the bar.
 *  3. FUZZY / TYPO SAFE ... ranking runs through the Fuse.js-compatible engine
 *                           in search-engine.js, so misspellings still match.
 *  4. CLEAN UI ............ dropdown closes on outside click, Escape, selection,
 *                           blur, page scroll, resize, tab-hide and hash change.
 *                           A × button clears the box in one tap.
 * ════════════════════════════════════════════════════════════════════════ */

const SEARCH_DEBOUNCE_MS = 400;     // wait for typing to settle before calling TMDB
const SEARCH_MIN_CHARS = 2;         // suggestions start at 2 characters
const SEARCH_SUGGESTION_LIMIT = 8;  // rows shown in the dropdown

let searchTimer = null;             // kept for backwards compatibility
let _lastSearchQuery = '';
let _searchAbortController = null;
let searchRequestId = 0;
let searchActiveIndex = -1;
let searchLastScrollY = 0;
const intelligentSearchCache = new Map();
const searchInput = document.getElementById('searchInput');
const searchEngineApi = () => window.MovieZoneSearch || null;

/* -- local fallback so the box still works if search-engine.js is blocked -- */
function localDebounce(fn, wait) {
  let timer = null;
  const debounced = function () {
    const args = arguments;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
  };
  debounced.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  debounced.pending = () => timer !== null;
  return debounced;
}

const makeDebounced = (fn, wait) => {
  const engine = searchEngineApi();
  return engine && typeof engine.debounce === 'function'
    ? engine.debounce(fn, wait)
    : localDebounce(fn, wait);
};

/* The single debounced entry point for every keystroke. */
const debouncedSuggest = makeDebounced(query => {
  const current = (searchInput?.value || '').trim();
  if (current !== query || query.length < SEARCH_MIN_CHARS) return;
  _lastSearchQuery = query;
  searchDropdownFill(query, beginSearchRequest());
}, SEARCH_DEBOUNCE_MS);

function beginSearchRequest() {
  if (_searchAbortController) _searchAbortController.abort();
  _searchAbortController = new AbortController();
  return _searchAbortController.signal;
}

function clearSearchRequest() {
  if (_searchAbortController) _searchAbortController.abort();
  _searchAbortController = null;
}

/*  -- Supplementary styles for the v2 search dropbits --
 *  Moved to the end of moviezone.css. This was a third runtime <style> append
 *  during top-level execution; each one costs a document-wide style
 *  invalidation and a full recalc. The rules are static.
 */

/* -- One-tap clear button (part of the "clean UI" requirement) -- */
const searchClearBtn = (function buildClearButton() {
  if (!searchInput || !searchInput.parentElement) return null;
  const existing = searchInput.parentElement.querySelector('.mz-search-clear');
  if (existing) return existing;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mz-search-clear';
  btn.setAttribute('aria-label', 'Clear search');
  btn.innerHTML = '&times;';
  btn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    resetSearchBox({ focus: true });
  });
  searchInput.parentElement.appendChild(btn);
  return btn;
})();

function toggleSearchClear(show) {
  if (searchClearBtn) searchClearBtn.classList.toggle('visible', !!show);
}

function resetSearchBox(options) {
  if (searchInput) searchInput.value = '';
  debouncedSuggest.cancel();
  searchRequestId += 1;
  toggleSearchClear(false);
  closeDropdown();
  if (options && options.focus && searchInput && !isMzTV()) searchInput.focus();
}

/* ------------------------------------------------------------------ *
 * Input wiring
 * ------------------------------------------------------------------ */
if (searchInput) {
  searchInput.setAttribute('role', 'combobox');
  searchInput.setAttribute('aria-autocomplete', 'list');
  searchInput.setAttribute('aria-controls', 'searchDropdown');
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.setAttribute('autocapitalize', 'none');
  searchInput.setAttribute('autocorrect', 'off');
  searchInput.setAttribute('spellcheck', 'false');
  searchInput.setAttribute('enterkeyhint', 'search');

  searchInput.addEventListener('input', event => {
    searchActiveIndex = -1;
    const query = event.target.value.trim();
    toggleSearchClear(query.length > 0);

    // Nothing typed -> cancel any pending request and close cleanly.
    if (!query) {
      debouncedSuggest.cancel();
      clearSearchRequest();
      _lastSearchQuery = '';
      searchRequestId += 1;
      closeDropdown();
      return;
    }

    // 1 character -> no network call at all, just a hint.
    if (query.length < SEARCH_MIN_CHARS) {
      debouncedSuggest.cancel();
      clearSearchRequest();
      showSearchLoading('Type at least ' + SEARCH_MIN_CHARS + ' letters…', false);
      return;
    }

    if (query === _lastSearchQuery) return;

    // 2+ characters -> show skeleton instantly, fire the request after 400ms.
    showSearchLoading('Finding the best matches…', true);
    debouncedSuggest(query);
  });

  searchInput.addEventListener('change', () => {
    if (searchInput && !searchInput.value.trim()) {
      debouncedSuggest.cancel();
      clearSearchRequest();
      _lastSearchQuery = '';
    }
  });

  searchInput.addEventListener('keydown', event => {
    const items = Array.from(document.querySelectorAll('#searchDropdown .search-result-item[data-search-result]'));
    if (event.key === 'ArrowDown' && items.length) {
      event.preventDefault();
      setActiveSearchItem(Math.min(searchActiveIndex + 1, items.length - 1), items);
      return;
    }
    if (event.key === 'ArrowUp' && items.length) {
      event.preventDefault();
      setActiveSearchItem(Math.max(searchActiveIndex - 1, 0), items);
      return;
    }
    if (event.key === 'Escape') {
      debouncedSuggest.cancel();
      clearSearchRequest();
      closeDropdown();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      debouncedSuggest.cancel();          // don't let a queued call fire later
      if (searchActiveIndex >= 0 && items[searchActiveIndex]) {
        items[searchActiveIndex].click();
      } else {
        const query = event.target.value.trim();
        if (query) searchAndDisplay(query);
        closeDropdown();
        if (!isMzTV()) searchInput.blur();  // hide the mobile keyboard
      }
    }
  });

  // Re-open the last suggestions when the user comes back to a filled box.
  searchInput.addEventListener('focus', () => {
    const query = searchInput.value.trim();
    toggleSearchClear(query.length > 0);
    if (query.length < SEARCH_MIN_CHARS) return;
    const dropdown = document.getElementById('searchDropdown');
    if (dropdown && dropdown.childElementCount) {
      dropdown.classList.add('open');
      searchInput.setAttribute('aria-expanded', 'true');
    }
  });

  // Blur -> close, unless focus moved INTO the dropdown (keyboard / TV remote).
  searchInput.addEventListener('blur', event => {
    const next = event.relatedTarget;
    if (next && typeof next.closest === 'function' && next.closest('.nav-search')) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (active && typeof active.closest === 'function' && active.closest('.nav-search')) return;
      closeDropdown();
    }, 130);
  });
}

/* ------------------------------------------------------------------ *
 * CLEAN UI: every way the dropdown can be dismissed
 * ------------------------------------------------------------------ */
function isSearchDropdownOpen() {
  const dropdown = document.getElementById('searchDropdown');
  return !!dropdown && dropdown.classList.contains('open');
}

// Outside click / tap (pointerdown fires before blur, so it feels instant).
function isInsideSearchBox(target) {
  return !!(target && typeof target.closest === 'function' && target.closest('.nav-search'));
}

document.addEventListener('pointerdown', event => {
  if (!isSearchDropdownOpen()) return;
  if (!isInsideSearchBox(event.target)) {
    debouncedSuggest.cancel();
    clearSearchRequest();
    closeDropdown();
  }
}, true);

// Legacy click guard (covers synthetic clicks and non-pointer browsers).
document.addEventListener('click', event => {
  if (!isInsideSearchBox(event.target)) closeDropdown();
});

// Escape anywhere on the page.
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && isSearchDropdownOpen()) {
    debouncedSuggest.cancel();
    clearSearchRequest();
    closeDropdown();
  }
});

// Meaningful page scroll (ignores the tiny scroll a mobile keyboard causes).
/*  PERF (TV / low-end): this listener used to do real work on EVERY scroll
 *  event even with the dropdown closed — a getElementById plus a classList read,
 *  and then a window.scrollY read, which is a layout read on a page that is
 *  still rendering rails. tv-perf-check attributed 113ms of TV main-thread time
 *  to this one handler during a 34-key D-pad session, making it the second most
 *  expensive piece of our own JavaScript in the profile.
 *
 *  A live HTMLCollection is the same trick scheduleCatGroupReflow above uses: it
 *  is maintained by the engine, so .length is a field read with no query and no
 *  layout. While the dropdown is closed — always, on a TV — the handler now
 *  costs that one comparison.
 *
 *  Behaviour is unchanged: the 70px baseline is seeded by openDropdown(), which
 *  already sets searchLastScrollY at the moment it opens, so the first scroll
 *  after opening still measures from the right place. */
const _openSearchDropdowns = document.getElementsByClassName('search-results-dropdown open');
window.addEventListener('scroll', () => {
  if (_openSearchDropdowns.length === 0) return;
  if (Math.abs(window.scrollY - searchLastScrollY) > 70) {
    searchLastScrollY = window.scrollY;
    closeDropdown();
  }
}, { passive: true });

window.addEventListener('resize', () => { if (isSearchDropdownOpen()) closeDropdown(); }, { passive: true });
window.addEventListener('hashchange', closeDropdown);
document.addEventListener('visibilitychange', () => { if (document.hidden) closeDropdown(); });

function setActiveSearchItem(index, items) {
  searchActiveIndex = index;
  items.forEach((item, itemIndex) => {
    const active = itemIndex === index;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const activeItem = items[index];
  if (activeItem) {
    activeItem.scrollIntoView({ block: 'nearest' });
    searchInput?.setAttribute('aria-activedescendant', activeItem.id || '');
  }
}

/**
 * Dropdown placeholder. `skeleton = true` renders shimmering poster rows so the
 * 350ms debounce window never looks like a frozen UI.
 */
function showSearchLoading(message, skeleton) {
  const dropdown = document.getElementById('searchDropdown');
  if (!dropdown) return;

  // INP: this fires on every keystroke. Rebuilding identical markup discards
  // and recreates the skeleton nodes each time, which is the entire typing
  // cost. When the shape already matches, only the label needs to change.
  const label = dropdown.querySelector('.search-state > span:last-child');
  if (label && (!!dropdown.querySelector('.mz-sugg-skeleton')) === !!skeleton) {
    if (label.textContent !== message) label.textContent = message;
    dropdown.classList.add('open');
    searchInput?.setAttribute('aria-expanded', 'true');
    return;
  }

  const rows = skeleton
    ? '<div class="mz-sugg-skeleton"><i class="p"></i><i class="l"></i></div>'.repeat(3)
    : '';
  dropdown.innerHTML =
    '<div class="search-state"><span class="search-state-spinner"></span><span>' + escapeHTML(message) + '</span></div>' + rows;
  dropdown.classList.add('open');
  searchInput?.setAttribute('aria-expanded', 'true');
}

function getSearchMediaType(item) {
  return item.media_type === 'tv' || (!item.media_type && item.name) ? 'tv' : 'movie';
}

function expandPersonResults(people) {
  const expanded = [];
  (people || []).forEach(person => {
    (person.known_for || []).forEach(item => {
      if (!item?.id || item.media_type === 'person') return;
      expanded.push({ ...item, _matchedPerson: person.name });
    });
  });
  return expanded;
}

/** Wraps the part of the title the user actually typed in <mark>. */
function highlightSearchMatch(title, query) {
  const safeTitle = escapeHTML(title || '');
  const engine = searchEngineApi();
  const needle = (engine ? engine.normalizeSearchText(query) : String(query || '').toLowerCase()).trim();
  if (!needle || needle.length < 2) return safeTitle;

  const haystack = safeTitle.toLowerCase();
  let index = haystack.indexOf(needle);
  let length = needle.length;
  if (index === -1) {
    // Fall back to the longest leading fragment that still matches.
    for (let cut = needle.length - 1; cut >= 2; cut -= 1) {
      const fragment = needle.slice(0, cut);
      index = haystack.indexOf(fragment);
      if (index !== -1) { length = cut; break; }
    }
  }
  if (index === -1) return safeTitle;
  return safeTitle.slice(0, index) +
    '<mark class="mz-search-hl">' + safeTitle.slice(index, index + length) + '</mark>' +
    safeTitle.slice(index + length);
}

const SEARCH_POSTER_FALLBACK = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2242%22 height=%2260%22><rect width=%2242%22 height=%2260%22 rx=%228%22 fill=%22%23181828%22/><text x=%2221%22 y=%2234%22 text-anchor=%22middle%22 fill=%22%23f5c518%22 font-size=%2214%22>MZ</text></svg>';

/**
 * The suggestion + results brain.
 * Live TMDb endpoints used:
 *   /search/movie  (primary — required for the auto-suggest dropdown)
 *   /search/tv     (web series / anime coverage)
 *   /search/multi  (actor & mixed matches)
 * Everything is then re-ranked by the Fuse.js-compatible fuzzy engine.
 */
async function intelligentMovieSearch(query, limit = 20, signal = null) {
  const engine = searchEngineApi();
  const cacheKey = (engine?.normalizeSearchText(query) || query.toLowerCase()) + '|' + limit;
  const cached = intelligentSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 5 * 60 * 1000) return cached.value;

  const baseParams = { language: 'en-US', page: '1', include_adult: 'false' };
  const aliasQuery = engine?.applyAliases(query) || query;
  const normalizedQuery = engine?.normalizeSearchText(query) || query.toLowerCase();

  const searchQuery = aliasQuery && aliasQuery !== normalizedQuery ? aliasQuery : query;
  let searchResults = [];

  try {
    const response = await tmdb('/search/multi', { ...baseParams, query: searchQuery }, { signal });
    searchResults = response.results || [];
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    console.warn('[MovieZone] Search request failed:', error);
    return { results: [], correction: null };
  }

  const directMedia = [];
  const directPeople = [];
  searchResults.forEach(item => {
    if (!item || !item.id) return;
    if (item.media_type === 'person') directPeople.push({ ...item, media_type: 'person' });
    else directMedia.push({ ...item, media_type: item.media_type || (item.name ? 'tv' : 'movie') });
  });

  // No engine (script blocked) -> still show plain TMDb order.
  if (!engine) {
    const fallback = directMedia.slice(0, limit);
    const value = { results: fallback, correction: null };
    intelligentSearchCache.set(cacheKey, { savedAt: Date.now(), value });
    return value;
  }

  const rankedPeople = engine.rankSearchCandidates(query, directPeople, 5);
  const personMedia = expandPersonResults(rankedPeople);
  let pool = directMedia.concat(personMedia);
  let ranked = engine.rankSearchCandidates(query, pool, Math.max(limit * 3, 30));
  let correction = engine.getCorrection(query, ranked);

  const bestPerson = rankedPeople[0];
  if (bestPerson && bestPerson._searchScore >= 700) correction = bestPerson.name;

  ranked.forEach(item => {
    if (item._matchedPerson) item._matchQuality = 'With ' + item._matchedPerson;
  });
  const value = { results: ranked.slice(0, limit), correction };
  intelligentSearchCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

function openSearchResult(item, activationEvent) {
  const type = getSearchMediaType(item);
  const releaseDate = item.release_date || item.first_air_date || '';
  const isUpcomingMovie = type === 'movie' && releaseDate && releaseDate > new Date().toISOString().slice(0, 10);
  if (isUpcomingMovie && typeof openUpcomingDetail === 'function') openUpcomingDetail(item.id, undefined, activationEvent);
  else openModal(item.id, type, activationEvent);
  // CLEAN UI: selecting a movie always tears the dropdown down.
  debouncedSuggest.cancel();
  closeDropdown();
  if (searchInput && !isMzTV()) searchInput.blur();
}

async function searchDropdownFill(query, signal) {
  const requestSignal = signal || beginSearchRequest();
  const requestId = ++searchRequestId;
  try {
    const search = await intelligentMovieSearch(query, SEARCH_SUGGESTION_LIMIT, requestSignal);
    // Stale-response guard: ignore anything the user has already typed past.
    if (requestId !== searchRequestId || searchInput?.value.trim() !== query) return;
    renderSearchDropdown(query, search);
  } catch (error) {
    if (requestId !== searchRequestId) return;
    if (error && error.name === 'AbortError') return;
    console.warn('[MovieZone] Intelligent search failed:', error);
    renderSearchDropdown(query, { results: [], correction: null });
  }
}

function renderSearchDropdown(query, search) {
  const dropdown = document.getElementById('searchDropdown');
  if (!dropdown) return;
  const results = search.results || [];
  dropdown.innerHTML = '';
  dropdown.setAttribute('role', 'listbox');
  dropdown.setAttribute('aria-label', 'Movie and web series suggestions');

  if (search.correction) {
    const suggestion = document.createElement('button');
    suggestion.type = 'button';
    suggestion.className = 'search-correction';
    suggestion.innerHTML = '<span>Did you mean</span><strong>' + escapeHTML(search.correction) + '</strong><small>Typo-tolerant match</small>';
    suggestion.addEventListener('click', () => {
      searchInput.value = search.correction;
      toggleSearchClear(true);
      searchAndDisplay(search.correction);
      closeDropdown();
    });
    dropdown.appendChild(suggestion);
  }

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.innerHTML = '<strong>No close match found</strong><span>Try another title, an actor name, or a longer part of the movie name.</span>';
    dropdown.appendChild(empty);
  } else {
    const heading = document.createElement('div');
    heading.className = 'search-dropdown-heading';
    heading.innerHTML = '<span>Top matches</span><small>' + results.length + ' suggestions</small>';
    dropdown.appendChild(heading);

    results.forEach((item, index) => {
      const type = getSearchMediaType(item);
      const releaseDate = item.release_date || item.first_air_date || '';
      const upcoming = releaseDate && releaseDate > new Date().toISOString().slice(0, 10);
      const title = item.title || item.name || '';
      const resultItem = document.createElement('div');
      resultItem.className = 'search-result-item';
      resultItem.id = 'mz-sugg-' + index;
      resultItem.tabIndex = -1;
      resultItem.dataset.searchResult = String(index);
      resultItem.setAttribute('role', 'option');
      resultItem.setAttribute('aria-selected', 'false');
      resultItem.setAttribute('aria-label', title + ' (' + (type === 'tv' ? 'series' : 'movie') + ')');

      /*  w154, not IMG (w342). The dropdown renders these at 42x60 CSS px, so
       *  w342 was ~8x the pixels on a 1x screen and still ~2x on a 3x phone.
       *  Search fires on every few keystrokes and renders up to a dozen rows, so
       *  this was one of the heavier image paths on the site for one of the
       *  smallest things it draws. w154 covers 42px at 3x with room to spare.
       */
      const poster = item.poster_path ? 'https://image.tmdb.org/t/p/w154' + item.poster_path : SEARCH_POSTER_FALLBACK;
      const quality = item._matchQuality || 'Related';

      resultItem.innerHTML =
        '<img src="' + poster + '" alt="' + escapeHTML(title) + ' poster" width="42" height="60" loading="lazy" decoding="async">' +
        '<div class="search-result-info"><div class="search-result-title-row"><h4>' + highlightSearchMatch(title, query) + '</h4>' +
        '<span class="search-type-badge">' + (type === 'tv' ? 'SERIES' : 'MOVIE') + '</span></div>' +
        '<p><span>' + escapeHTML((releaseDate || '----').slice(0, 4)) + '</span><span>★ ' + Number(item.vote_average || 0).toFixed(1) + '</span>' +
        (upcoming ? '<span class="search-upcoming">UPCOMING</span>' : '') + '</p>' +
        '<small class="search-match-reason">' + escapeHTML(quality) + '</small></div>' +
        '<span class="search-result-arrow">›</span>';

      resultItem.addEventListener('mouseenter', () => setActiveSearchItem(index, Array.from(dropdown.querySelectorAll('[data-search-result]'))));
      resultItem.addEventListener('click', event => openSearchResult(item, event));
      dropdown.appendChild(resultItem);
    });

    const footer = document.createElement('button');
    footer.type = 'button';
    footer.className = 'search-view-all';
    footer.innerHTML = '<span>View all results for “' + escapeHTML(query) + '”</span><strong>Press Enter →</strong>';
    footer.addEventListener('click', () => {
      searchAndDisplay(query);
      closeDropdown();
    });
    dropdown.appendChild(footer);
  }

  searchActiveIndex = -1;
  searchLastScrollY = window.scrollY;
  dropdown.classList.add('open');
  searchInput?.setAttribute('aria-expanded', 'true');
  searchInput?.removeAttribute('aria-activedescendant');
}

async function searchAndDisplay(query) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;
  const signal = beginSearchRequest();
  isSearchResultsMode = true;
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  const scrollTrigger = document.getElementById('infiniteScrollTrigger');
  if (scrollTrigger) scrollTrigger.style.display = 'none';
  grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  const heading = document.getElementById('sectionHeading');
  if (heading) heading.textContent = 'SEARCHING FOR "' + query.toUpperCase() + '"...';
  const section = document.getElementById('movies-section');
  if (section) section.scrollIntoView({ behavior: isMzTVMode() ? 'auto' : 'smooth' });

  try {
    const search = await intelligentMovieSearch(query, 40, signal);
    const movies = search.results.filter(item => item.poster_path && item.media_type !== 'person');
    allMovies = movies;
    if (heading) {
      heading.textContent = search.correction
        ? 'BEST RESULTS FOR "' + query.toUpperCase() + '" · DID YOU MEAN "' + search.correction.toUpperCase() + '"?'
        : 'RESULTS FOR "' + query.toUpperCase() + '"';
    }
    // Keeps the page title aligned with what the user is actually looking at.
    try { document.title = query.trim() + ' – Search results | MovieZone'; } catch (e) {}
    if (movies.length) renderMovies(movies);
    else grid.innerHTML = '<div class="search-grid-empty"><strong>No close matches found</strong><span>Try a title fragment, actor name, or check the spelling.</span></div>';
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    console.warn('[MovieZone] Search page failed:', error);
    grid.innerHTML = '<div class="search-grid-empty"><strong>Search is temporarily unavailable</strong><span>Please try again in a moment.</span></div>';
  }

  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = 'none';
}

function closeDropdown() {
  const dropdown = document.getElementById('searchDropdown');
  if (dropdown) dropdown.classList.remove('open');
  searchInput?.setAttribute('aria-expanded', 'false');
  searchInput?.removeAttribute('aria-activedescendant');
  document.querySelectorAll('#searchDropdown .search-result-item.active')
    .forEach(item => { item.classList.remove('active'); item.setAttribute('aria-selected', 'false'); });
  searchActiveIndex = -1;
}

/*  ══════════════════════════════════════════════════════════════════════
 *  MODAL FIRST PAINT
 *  ══════════════════════════════════════════════════════════════════════
 *  The modal opens instantly and only then awaits /{type}/{id}. That is the
 *  right call for responsiveness, but it used to paint "Loading..." into the
 *  3.2rem title and a one-line string into the overview, then swap both for
 *  text of a completely different height — the single largest layout shift a
 *  session could record (Datadog RUM attributed CLS 0.215 to
 *  #modalBox > .modal-info).
 *
 *  Every feed this modal is opened from already holds the title AND the
 *  overview: they are fields on the TMDB list objects the cards were built
 *  from. Seeding the two text blocks from that data means the first paint is
 *  already the final text, so nothing re-lines when the detail response lands
 *  — only the meta block below fills in, and .modal-meta reserves that.
 *
 *  Deep links (#watch-movie-123 with a cold feed) find nothing and fall back
 *  to the placeholder, which is why the placeholder is kept.
 */
function findSeededTitleData(id) {
  const numericId = Number(id);
  if (!numericId) return null;
  const pools = [
    typeof carouselMovies !== 'undefined' ? carouselMovies : null,
    typeof allMovies !== 'undefined' ? allMovies : null,
    typeof allUpcoming !== 'undefined' ? allUpcoming : null,
    typeof watchlist !== 'undefined' ? watchlist : null
  ];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    const hit = pool.find(m => m && Number(m.id) === numericId);
    if (hit && (hit.title || hit.name)) return hit;
  }
  return null;
}

/*  The loading state for #modalMeta. Shaped like the badges + genres +
 *  tagline + cast rows that replace it, so the box does not resize on fill. */
function modalMetaSkeleton() {
  return '<div class="modal-meta-skeleton" aria-hidden="true">' +
    '<div class="modal-skel-row">' +
      '<div class="skeleton modal-skel-chip modal-skel-chip--wide"></div>' +
      '<div class="skeleton modal-skel-chip"></div>' +
      '<div class="skeleton modal-skel-chip"></div>' +
    '</div>' +
    '<div class="modal-skel-row">' +
      '<div class="skeleton modal-skel-chip"></div>' +
      '<div class="skeleton modal-skel-chip"></div>' +
    '</div>' +
    '<div class="skeleton modal-skel-line"></div>' +
    '<div class="modal-skel-row">' +
      '<div class="skeleton modal-skel-face"></div>' +
      '<div class="skeleton modal-skel-face"></div>' +
      '<div class="skeleton modal-skel-face"></div>' +
    '</div>' +
  '</div>';
}

/* ------------------------------------------------------------------ *
 * SEO: makes the Google "sitelinks searchbox" schema real.
 * https://moviezone.dev/?search=jawan  -> runs that search on load.
 * ------------------------------------------------------------------ */
function runSearchFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const query = (params.get('search') || params.get('q') || '').trim();
    if (!query || query.length < SEARCH_MIN_CHARS) return;
    if (searchInput) {
      searchInput.value = query;
      toggleSearchClear(true);
    }
    searchAndDisplay(query);
  } catch (error) { /* no-op */ }
}
window.addEventListener('load', () => setTimeout(runSearchFromUrl, 350), { once: true });
 
// MODAL
/*  Resolves after the browser has had a chance to paint.
 *
 *  rAF alone only gets us to just BEFORE the next frame — work scheduled there
 *  still delays it. Chaining a task after the frame (scheduler.postTask at
 *  user-visible priority, setTimeout elsewhere) means the pixels are committed
 *  first and the interaction is recorded as responsive.
 */
function mzYieldToPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      if (typeof scheduler !== 'undefined' && scheduler && typeof scheduler.postTask === 'function') {
        scheduler.postTask(resolve, { priority: 'user-visible' });
      } else {
        setTimeout(resolve, 0);
      }
    });
  });
}

async function openModal(id, type = 'movie', activationEvent) {
  if (!claimExplicitDetailActivation(activationEvent)) return;
  // Add hash to URL to behave like a separate page
  window.history.pushState({ watchPage: true }, '', '#watch-' + type + '-' + id);
  if (isMzTV()) lastFocusedElement = document.activeElement;
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
 
  // 1. INSTANT UI OPEN (Bina backend wait kiye instantly page open karo)
  /*  INP — the scroll reset comes BEFORE the class flip on purpose. The overlay
   *  is display:none until .open lands, so writing scrollTop here is free;
   *  writing it afterwards forced a full synchronous layout of the entire modal
   *  subtree inside the click handler, which was the most expensive single thing
   *  the interaction did. primePlayerSurface() repeats it after the paint for
   *  engines that restore a remembered offset. */
  overlay.scrollTop = 0;
  overlay.classList.add('open');
  if (!isMzTV()) {
    document.body.style.overflow = 'hidden';
  }
 
  const titleEl = document.getElementById('modalTitle');
  const descEl = document.getElementById('modalDesc');
  const bgEl = document.getElementById('modalBg');
  const metaEl = document.getElementById('modalMeta');
  const embedEl = document.getElementById('videoEmbed');
  
  const seeded = findSeededTitleData(id);
  if (titleEl) titleEl.textContent = (seeded && (seeded.title || seeded.name)) || 'Loading...';
  if (descEl) descEl.textContent = (seeded && seeded.overview) || 'Fetching high-speed servers...';
  if (metaEl) metaEl.innerHTML = modalMetaSkeleton();
  if (bgEl) {
    bgEl.src = '';
    bgEl.classList.remove('blur-in');
    bgEl.style.opacity = ''; // Reset opacity so CSS can take over
  }
  if (embedEl) embedEl.innerHTML =
    '<div class="video-placeholder">' +
      '<div class="player-spinner" style="width:55px; height:55px; border-color:rgba(255,255,255,0.1); border-left-color:var(--gold);"></div>' +
      '<p style="color:var(--gold); margin-top:15px; font-weight:600;">Establishing secure connection...</p>' +
    '</div>';
 
  // Saare servers aur buttons instantly show karo taaki user immediately click kar sake
  //
  // Deliberately synchronous: #externalSources is 450-700px of the modal on a
  // phone, so deferring it past the opening frame would trade INP for a shift
  // of the same block. It renders from a static list — the cost is the
  // innerHTML write, not a fetch.
  try { renderExternalSources(id, getSelectedSourceIdx(), getSelectedLang()); } catch(e){}

  // CLS: the related row is display:none until the detail fetch resolves, then
  // adds ~350px inside .modal-bottom. Reserving it here means the modal reaches
  // its full height in the frame it opens instead of growing under the user.
  try { primeRelatedSection(); } catch (e) {}

  // INP: the frame above is what the tap is waiting on. Everything below is
  // preparation for a click that has not happened yet, so hand the frame back
  // before starting it. Ordering is unchanged, only the paint boundary moved.
  await mzYieldToPaint();

  // ⚡ SPEED: provider handshake details aane se pehle shuru kar do.
  //
  // Order matters here. warmPlayerConnection() warms the host this user is
  // ACTUALLY going to stream from (their saved server, anime-corrected), so it
  // goes first and gets the idle connection. preconnectPlayerHosts used to run
  // ahead of it with a limit of 6, meaning six speculative DNS+TCP+TLS
  // handshakes were opened before the one host that mattered — competing with
  // the TMDB detail fetch, the backdrop image and the prewarm iframe for the
  // same connection budget on a phone.
  //
  // Two fallbacks are kept warm because the realistic failure mode is the user
  // clicking one alternate server, not six — and they are the servers the retry
  // chain would genuinely reach, not a fixed slice of an unrelated list.
  try {
    resetTriedSources();   // fresh title, fresh retry chain
    warmPlayerConnection(id, type);
    warmRankedFallbacks(id, type, getSelectedLang(), 2);
  } catch(e){}
 
  try {
    /*  tmdb() is only async after its cache lookups: it does a synchronous
     *  localStorage.getItem plus a JSON.parse of a 20-50 KB payload before it
     *  ever awaits, and for this endpoint (append_to_response=videos,credits)
     *  that is ~70ms. It is already off the interaction because the
     *  mzYieldToPaint() above committed the frame first — worth knowing before
     *  anything is moved back above that boundary. */
    const details = await tmdb('/'+type+'/'+id, detailParams('videos,credits'));

    /*  TMDB has no record for this id — confirmed 404, already logged silently by
     *  tmdb(). Every field below would be undefined, which left the modal sitting
     *  on "Loading..." and a spinner forever: the user gets no content and no
     *  explanation, and the only way out is the close button.
     *
     *  "Silently skip" cannot mean nothing here, because the user deliberately
     *  tapped this card. So: close the modal, say one calm sentence, and drop the
     *  dead entry from Continue Watching / Watchlist so it stops coming back.
     */
    if (details && details._mzMissing) {
      try { closeModal(); } catch (e) {}
      _mzForgetDeadTitle(id, type);
      if (typeof showToast === 'function') showToast('This title is no longer available.');
      return;
    }

    details.media_type = type;
    currentModalMovie = details;
    const bgEl = document.getElementById('modalBg');
    const imgPath = details.backdrop_path || details.poster_path;

    if (bgEl) {
      if (imgPath) {
        bgEl.onload = () => { 
          bgEl.classList.add('blur-in');
          bgEl.style.opacity = '1'; 
        };
        bgEl.src = details.backdrop_path ? getResponsiveBackdrop(details.backdrop_path) : IMG + imgPath;
      } else {
        bgEl.style.opacity = '1';
      }
    }
 
    // --- HOVER TRAILER LOGIC (Smart Auto-Fallback) ---
    let bestVids = [];
    if (details.videos && details.videos.results) {
      const ytVids = details.videos.results.filter(v => v.site === 'YouTube');
      const trailers = ytVids.filter(v => v.type === 'Trailer');
      const teasers = ytVids.filter(v => v.type === 'Teaser');
      // Queue banate hain: Unofficial pehle, fir official. Taki block hone par fallback kiya ja sake.
      bestVids = [
        ...trailers.filter(v => !v.official),
        ...teasers.filter(v => !v.official),
        ...trailers.filter(v => v.official),
        ...teasers.filter(v => v.official)
      ];
      if (bestVids.length === 0 && ytVids.length > 0) bestVids = ytVids;
    }
    const imageWrapper = document.querySelector('.modal-image-wrapper');
    const eventContainer = document.querySelector('.modal-top');
    if (eventContainer && imageWrapper) {
      let tc = document.getElementById('trailerContainer');
      if (tc) tc.remove();

      /*  The trailer indicator is conditional, and that is half the bug report.
       *  It used to be appended unconditionally, so titles TMDB has no video for
       *  still advertised a play icon — you hover, nothing happens, and the
       *  feature looks broken rather than absent. Measured on a 54-title sample,
       *  12 titles genuinely have no video at all even with every video language
       *  requested, so this case is common and has to be handled honestly.
       *  It is also removed on TV, where hover trailers never run. */
      const canPlayTrailer = bestVids.length > 0 && !isMzTV();
      let trailerIndicator = imageWrapper.querySelector('.modal-trailer-indicator');
      if (canPlayTrailer && !trailerIndicator) {
        trailerIndicator = document.createElement('div');
        trailerIndicator.className = 'modal-trailer-indicator';
        // Just the icon, as requested
        trailerIndicator.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
        imageWrapper.appendChild(trailerIndicator);
      } else if (!canPlayTrailer && trailerIndicator) {
        trailerIndicator.remove();
      }

      // Clear any previous listeners to prevent memory leaks
      eventContainer.onclick = null;
      eventContainer.onmouseenter = null;
      eventContainer.onmouseleave = null;

      if (canPlayTrailer) {
        let currentVidIdx = 0;
        let trailerKey = bestVids[currentVidIdx].key;
 
        tc = document.createElement('div');
        tc.id = 'trailerContainer';
        tc.style.cssText = 'position:absolute; inset:0; z-index:10; display:none; background:#000; transition:opacity 0.4s ease; opacity:0; overflow:hidden; border-radius:12px;';
        imageWrapper.appendChild(tc);
 
        let trailerTimeout;
        let ytErrHandler = null;

        const playTrailer = () => {
            if (!tc) return;
            tc.style.display = 'block';
            setTimeout(() => { tc.style.opacity = '1'; }, 50);
            // Hide only the meta section (cast, genres, crew, production) when trailer plays
            const modalMeta = document.getElementById('modalMeta');
            if (modalMeta) modalMeta.classList.add('meta-hidden');
            const modalGrad = document.querySelector('.modal-gradient');
            if (modalGrad) modalGrad.style.opacity = '0.3';
 
            const getYTUrl = (key) => `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&loop=1&playlist=${key}&enablejsapi=1&iv_load_policy=3&origin=${encodeURIComponent(window.location.origin)}`;
 
            tc.innerHTML = `
              <div id="trailerLoader" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; z-index:5; background:rgba(0,0,0,0.6); transition:opacity 0.4s ease; backdrop-filter:blur(4px);">
                <div class="player-spinner" style="width:36px; height:36px; border-width:3px;"></div>
              </div>
              <iframe id="ytHoverPlayer" src="${getYTUrl(trailerKey)}" style="width:100%; height:100%; border:none; transform:scale(1.3); pointer-events:none; opacity:0; transition:opacity 0.5s ease;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
              <button id="trailerMuteBtn" style="position:absolute; top:20px; right:20px; z-index:10; background:rgba(0,0,0,0.6); color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:50%; width:44px; height:44px; cursor:pointer; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px); transition:all 0.3s ease; box-shadow: 0 4px 12px rgba(0,0,0,0.4);">
                <svg id="iconMuted" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                <svg id="iconUnmuted" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" style="display:none;"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
              </button>
            `;
 
            const ytFrame = tc.querySelector('#ytHoverPlayer');
            const ytLoader = tc.querySelector('#trailerLoader');
 
            if (ytFrame) {
              ytFrame.onload = () => {
                setTimeout(() => {
                  if (ytLoader) { ytLoader.style.opacity = '0'; setTimeout(() => { if (ytLoader.parentNode) ytLoader.remove(); }, 400); }
                  if (ytFrame) ytFrame.style.opacity = '1';
                }, 800);
              };
            }
 
            ytErrHandler = (e) => {
              try {
                if (e.origin && !e.origin.includes('youtube')) return;
                let d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
                if (!d) return;
 
                if ((d.event === 'onStateChange' && d.info === 1) || (d.event === 'infoDelivery' && d.info && d.info.playerState === 1)) {
                  if (ytLoader) { ytLoader.style.opacity = '0'; setTimeout(() => { if (ytLoader.parentNode) ytLoader.remove(); }, 400); }
                  if (ytFrame) ytFrame.style.opacity = '1';
                }
 
                if (d.event === 'onError' || d.event === 'error' || d.info === 150 || d.info === 153 || d.info === 101 || (d.info && d.info.playerState === -1 && d.info.videoData && d.info.videoData.errorCode)) {
                  currentVidIdx++;
                  if (currentVidIdx < bestVids.length) {
                    trailerKey = bestVids[currentVidIdx].key;
                    if (ytFrame) {
                      ytFrame.style.opacity = '0';
                      ytFrame.src = getYTUrl(trailerKey);
                    }
                  } else {
                    tc.style.opacity = '0';
                    setTimeout(() => { if (tc && tc.parentNode) tc.remove(); }, 400);
                  }
                }
              } catch(err) {}
            };
            window.addEventListener('message', ytErrHandler);
 
            const muteBtn = tc.querySelector('#trailerMuteBtn');
            let isMuted = true;
            
            muteBtn.onmouseenter = () => { muteBtn.style.background = 'rgba(245,197,24,0.9)'; muteBtn.style.color = '#000'; muteBtn.style.transform = 'scale(1.1)'; };
            muteBtn.onmouseleave = () => { muteBtn.style.background = 'rgba(0,0,0,0.6)'; muteBtn.style.color = '#fff'; muteBtn.style.transform = 'scale(1)'; };
            
            muteBtn.onclick = (e) => {
              e.stopPropagation();
              const frame = tc.querySelector('#ytHoverPlayer');
              if (frame && frame.contentWindow) {
                if (isMuted) {
                  frame.contentWindow.postMessage('{"event":"command","func":"unMute","args":""}', '*');
                  tc.querySelector('#iconMuted').style.display = 'none';
                  tc.querySelector('#iconUnmuted').style.display = 'block';
                } else {
                  frame.contentWindow.postMessage('{"event":"command","func":"mute","args":""}', '*');
                  tc.querySelector('#iconUnmuted').style.display = 'none';
                  tc.querySelector('#iconMuted').style.display = 'block';
                }
                isMuted = !isMuted;
              }
            };
        };

        const stopTrailer = () => {
            clearTimeout(trailerTimeout);
            if (ytErrHandler) {
                window.removeEventListener('message', ytErrHandler);
                ytErrHandler = null;
            }
            if (tc) {
                tc.style.opacity = '0';
                setTimeout(() => { if(tc) { tc.style.display = 'none'; tc.innerHTML = ''; } }, 400);
            }
            // Show meta section back when trailer stops
            const modalMeta = document.getElementById('modalMeta');
            if (modalMeta) modalMeta.classList.remove('meta-hidden');
            const modalGrad = document.querySelector('.modal-gradient');
            if (modalGrad) modalGrad.style.opacity = '1';
        };
        activeTrailerStopper = stopTrailer; // Register the stopper

        // Device-aware interaction: Click for mobile, Hover for desktop
        if (isMobile || isTouchOnly) {
            let trailerIsPlaying = false;
            eventContainer.onclick = (e) => {
                // Stop if the click was on any interactive element (buttons, links, selects, etc.)
                if (e.target.closest('button, a, select, input')) return;
                
                if (!trailerIsPlaying) {
                    playTrailer();
                    trailerIsPlaying = true;
                } else {
                    stopTrailer();
                    trailerIsPlaying = false;
                }
            };
        } else { // Desktop hover & click logic
            let trailerIsPlaying = false; // Keep track of state
            
            // Hover to play
            eventContainer.onmouseenter = () => {
              // Only start hover-play if not already playing from a click
              if (!trailerIsPlaying) {
                trailerTimeout = setTimeout(playTrailer, 600);
              }
            };
        
            // Leave to stop
            eventContainer.onmouseleave = () => {
              // Only stop if it was started by hover (i.e., user hasn't clicked to lock it on)
              if (!trailerIsPlaying) {
                stopTrailer();
              }
            };
        
            // Click to toggle play/stop
            eventContainer.onclick = (e) => {
                // Ignore clicks on buttons inside the container
                if (e.target.closest('button, a, select, input')) return;
                
                if (!trailerIsPlaying) {
                    stopTrailer(); // Clear any pending hover-play timeout
                    playTrailer();
                    trailerIsPlaying = true;
                } else {
                    stopTrailer();
                    trailerIsPlaying = false;
                }
            };
        }
      }
    }
    const titleEl = document.getElementById('modalTitle');
    if (titleEl) titleEl.textContent = details.title || details.name || '';
    const descEl = document.getElementById('modalDesc');
    if (descEl) descEl.textContent = details.overview || '';
    const runtime = details.runtime ? (Math.floor(details.runtime/60)+'h '+(details.runtime%60)+'m') : 'N/A';
    const genres  = (details.genres||[]).slice(0,3).map(g => '<span class="genre-tag">'+escapeHTML(g.name)+'</span>').join('');
    
    // --- Audio Information Badge ---
    const tmdbLangs = (details.spoken_languages || []).map(l => l.iso_639_1);
    const hasDubbed = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'].some(lang => tmdbLangs.includes(lang));
    const audioBadge = hasDubbed 
      ? '<div class="card-year" style="font-size:0.85rem; background: linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05)); border-color: rgba(16,185,129,0.3); color: #10b981;" title="Available in Hindi/Regional Languages"> DUBBED AVAILABLE</div>'
      : '<div class="card-year" style="font-size:0.85rem; background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02)); border-color: rgba(255,255,255,0.15); color: #bbb;" title="Only Original Audio Available"> ORIGINAL AUDIO</div>';

    const metaEl  = document.getElementById('modalMeta');
    if (metaEl) {
      // -- PREMIUM META BADGES --
      let metaHTML = '<div class="modal-meta-badges">';
      metaHTML += '<div class="modal-badge modal-badge-rating"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg> '+((details.vote_average||0).toFixed(1))+' <span class="modal-badge-sub">('+((details.vote_count||0).toLocaleString())+' votes)</span></div>';
      metaHTML += '<div class="modal-badge"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z"/></svg> '+((details.release_date||details.first_air_date||'').slice(0,4))+'</div>';
      metaHTML += '<div class="modal-badge"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z"/></svg> '+runtime+'</div>';
      if (details.original_language) metaHTML += '<div class="modal-badge">🌐 '+(details.original_language).toUpperCase()+'</div>';
      if (details.budget > 0) metaHTML += '<div class="modal-badge">💰 $'+(details.budget/1000000).toFixed(0)+'M</div>';
      if (details.revenue > 0) metaHTML += '<div class="modal-badge modal-badge-revenue">📈 $'+(details.revenue/1000000).toFixed(0)+'M</div>';
      metaHTML += audioBadge;
      metaHTML += '</div>';
      
      // -- GENRES --
      metaHTML += '<div class="modal-genres-row">'+genres+'</div>';
      
      // -- TAGLINE --
      if (details.tagline) {
        metaHTML += '<div class="modal-tagline">"'+escapeHTML(details.tagline)+'"</div>';
      }
      
      // -- DIRECTOR & WRITER --
      if (details.credits && details.credits.crew) {
        const directors = details.credits.crew.filter(c => c.job === 'Director').slice(0, 2);
        const writers = details.credits.crew.filter(c => c.job === 'Screenplay' || c.job === 'Writer').slice(0, 2);
        if (directors.length > 0 || writers.length > 0) {
          metaHTML += '<div class="modal-crew-row">';
          if (directors.length > 0) metaHTML += '<span class="modal-crew-item"><span class="modal-crew-label">Director</span> '+directors.map(d => escapeHTML(d.name)).join(', ')+'</span>';
          if (writers.length > 0) metaHTML += '<span class="modal-crew-item"><span class="modal-crew-label">Writer</span> '+writers.map(w => escapeHTML(w.name)).join(', ')+'</span>';
          metaHTML += '</div>';
        }
      }
      
      // -- CAST (Top 8 with photos) --
      if (details.credits && details.credits.cast && details.credits.cast.length > 0) {
        const topCast = details.credits.cast.slice(0, 8);
        metaHTML += '<div class="modal-cast-section"><div class="modal-cast-label">Cast</div><div class="modal-cast-row">';
        topCast.forEach(person => {
          const imgSrc = person.profile_path 
            ? 'https://image.tmdb.org/t/p/w185'+person.profile_path 
            : 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22><rect width=%2248%22 height=%2248%22 rx=%2224%22 fill=%22%23222%22/><text x=%2224%22 y=%2230%22 fill=%22%23555%22 text-anchor=%22middle%22 font-size=%2216%22>👤</text></svg>';
          metaHTML += '<div class="modal-cast-chip" title="'+escapeHTML(person.name)+' as '+escapeHTML(person.character||'')+'">' +
            '<img src="'+imgSrc+'" alt="'+escapeHTML(person.name)+'" width="48" height="48" loading="lazy" decoding="async">' +
            '<div class="modal-cast-info"><span class="modal-cast-name">'+escapeHTML(person.name)+'</span><span class="modal-cast-char">'+escapeHTML(person.character||'')+'</span></div>' +
          '</div>';
        });
        metaHTML += '</div></div>';
      }
      
      // -- PRODUCTION COMPANIES --
      if (details.production_companies && details.production_companies.length > 0) {
        metaHTML += '<div class="modal-production-row">';
        details.production_companies.slice(0, 4).forEach(company => {
          if (company.logo_path) {
            metaHTML += '<div class="modal-prod-chip"><img src="https://image.tmdb.org/t/p/w92'+company.logo_path+'" alt="'+escapeHTML(company.name)+'" title="'+escapeHTML(company.name)+'" width="92" height="61" loading="lazy" decoding="async"></div>';
          } else {
            metaHTML += '<div class="modal-prod-chip modal-prod-text">'+escapeHTML(company.name)+'</div>';
          }
        });
        metaHTML += '</div>';
      }
      
      metaEl.innerHTML = metaHTML;
    }
    const embedEl = document.getElementById('videoEmbed');
    if (embedEl) embedEl.innerHTML =
      '<div class="video-placeholder">' +
        '<button class="play-big" id="playBigBtn" aria-label="Play" title="Play">' +
          '<svg viewBox="0 0 24 24" width="44" height="44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<path d="M5 3v18l15-9L5 3z" fill="white" />' +
          '</svg>' +
        '</button>' +
        '<p>Select language & quality, then press play</p>' +
      '</div>';
    const pb = document.getElementById('playBigBtn');
    if (pb) pb.addEventListener('click', playMovie);

    /*  Resume path: a Continue Watching card sets _mzAutoPlayOnOpen, and this is the
     *  first point at which playback can actually start — the details are loaded, so
     *  the runtime and (for a series) the saved season/episode are known, which is
     *  exactly what the watch session and the resume offset need. One-shot: cleared
     *  immediately so a later modal opened normally does not auto-play. */
    if (window._mzAutoPlayOnOpen) {
      window._mzAutoPlayOnOpen = false;
      setTimeout(() => { try { playMovie(); } catch (e) {} }, 0);
    }

    // ⚡ INSTANT PLAY: stream ko background me abhi resolve karna shuru kar do
    // (anime ke liye pehle AniList id, taaki double-load na ho)
    try {
      if (isAnimeContent(details)) {
        const sel0 = currentEpisodeSelection();
        const known = getAnilistIdSync(details, sel0.s);
        if (known === null) {
          resolveAnilistId(details, sel0.s)
            .then(() => { if (currentModalMovie && currentModalMovie.id === details.id) prewarmPlayer(details.id, type); })
            .catch(() => prewarmPlayer(details.id, type));
        } else {
          schedulePlayerPrewarm(details.id, type, 120);
        }
      } else {
        schedulePlayerPrewarm(details.id, type, 120);
      }
    } catch(e){}

    // Play button par hover/focus/touch hote hi prewarm pakka kar do
    try {
      if (pb) {
        ['mouseenter', 'focus', 'touchstart'].forEach(evt => {
          pb.addEventListener(evt, () => prewarmPlayer(details.id, type), { passive: true });
        });
      }
      if (!window._mzPlayHoverBound) {
        window._mzPlayHoverBound = true;
        const mainPlayBtn = document.querySelector('.modal-actions .btn-play');
        if (mainPlayBtn) {
          ['mouseenter', 'focus', 'touchstart'].forEach(evt => {
            mainPlayBtn.addEventListener(evt, () => {
              // Handler ek hi baar bind hota hai, isliye current movie hi use karo
              if (currentModalMovie) prewarmPlayer(currentModalMovie.id, currentModalMovie.media_type || 'movie');
            }, { passive: true });
          });
        }
      }
    } catch(e){}
    try { setSelectedLang(getSelectedLang()); } catch(e) {}
    try { setSelectedQuality(getSelectedQuality()); } catch(e) {}
    
    const ls = document.getElementById('langSelect');
    if (ls) ls.onchange = () => { if(embedEl.querySelector('iframe')) playMovie(); };
    
    const qs = document.getElementById('qualitySelect');
    if (qs) qs.onchange = () => { if(embedEl.querySelector('iframe')) playMovie(); };
    
    const tvGroup = document.getElementById('tvSelectGroup');
    if (tvGroup) {
      tvGroup.style.display = type === 'tv' ? 'block' : 'none';
      if (type === 'tv') {
        tvGroup.innerHTML = `
          <div style="display:flex; width:100%; gap:12px; margin-bottom:12px;">
            <select id="seasonInput" class="lang-select" style="flex:1; cursor:pointer;"></select>
            <select id="episodeInput" class="lang-select" style="flex:2; cursor:pointer;"></select>
          </div>
          <div id="episodePreview" style="display:none; background: linear-gradient(180deg, rgba(30, 30, 42, 0.4) 0%, rgba(15, 15, 20, 0.6) 100%); border-radius:12px; overflow:hidden; border:1px solid rgba(255,255,255,0.18); border-bottom-color:rgba(255,255,255,0.05); box-shadow: 0 4px 15px rgba(0,0,0,0.5); backdrop-filter: blur(12px);"></div>
        `;
        const sInput = document.getElementById('seasonInput');
        const eInput = document.getElementById('episodeInput');
        const seasons = (details.seasons || []).filter(s => s.season_number > 0);
        
        if (seasons.length > 0) {
          // -- CONTINUE WATCHING LOGIC --
          let lastS = seasons[0].season_number;
          let lastE = 1;
          try {
            const progress = JSON.parse(localStorage.getItem('mz_progress_' + id));
            if (progress && progress.season && seasons.find(sz => sz.season_number == progress.season)) {
              lastS = progress.season;
              lastE = progress.episode || 1;
            }
          } catch(e) {}
 
          sInput.innerHTML = seasons.map(s => `<option value="${s.season_number}" ${s.season_number == lastS ? 'selected' : ''}>${s.name} (${s.episode_count} Eps)</option>`).join('');
          
          const fetchEpisodes = async (seasonNum, targetEp) => {
            eInput.innerHTML = '<option>Loading Episodes...</option>';
            try {
              const sData = await tmdb('/tv/'+id+'/season/'+seasonNum, { language: 'en-US' });
              const episodes = sData.episodes || [];
              eInput.innerHTML = episodes.map(ep => `<option value="${ep.episode_number}">Ep ${ep.episode_number}: ${escapeHTML(ep.name)}</option>`).join('');
              
              if (targetEp && episodes.find(e => e.episode_number == targetEp)) {
                eInput.value = targetEp;
              }
 
              const updatePreview = () => {
                const epNum = eInput.value;
                const ep = episodes.find(e => e.episode_number == epNum);
                const previewDiv = document.getElementById('episodePreview');
                if (ep && previewDiv) {
                  previewDiv.style.display = 'flex';
                  const imgSrc = ep.still_path ? IMG + ep.still_path : (details.backdrop_path ? IMG + details.backdrop_path : '');
                  previewDiv.innerHTML = `
                  <img src="${imgSrc}" style="width:160px; height:90px; object-fit:cover; flex-shrink:0; border-right:1px solid rgba(255,255,255,0.1);" alt="Ep Thumbnail" width="160" height="90" loading="lazy" decoding="async">
                  <div style="padding:10px 14px; display:flex; flex-direction:column; justify-content:center;">
                    <strong style="font-size:0.95rem; color:var(--gold); display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; text-shadow: 0 2px 4px rgba(0,0,0,0.5);">Ep ${ep.episode_number}: ${escapeHTML(ep.name)}</strong>
                    <span style="font-size:0.8rem; color:rgba(255,255,255,0.7); margin-top:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; line-height:1.4;">${escapeHTML(ep.overview || 'No description available.')}</span>
                    </div>
                  `;
                }
              };
 
              eInput.onchange = () => { 
                updatePreview();
                /*  Naya episode = naya retry chain.
                 *  _mzTriedSources sirf naye title par reset hota tha, episode
                 *  badalne par nahi. Binge karte waqt set har episode ka failure
                 *  jodta rehta tha, to 3-4 episode baad eligible pool khali ho
                 *  jaata aur fallback "wide" branch par gir jaata — jo dub/anime
                 *  eligibility ignore karke server uthata hai. Har episode ko
                 *  poora fallback chain milna chahiye. */
                resetTriedSources();
                if(embedEl.querySelector('iframe')) playMovie(); 
              };
              updatePreview();
 
              if(embedEl.querySelector('iframe')) playMovie(); 
            } catch(err) { eInput.innerHTML = '<option value="1">Episode 1</option>'; }
          };
          
          sInput.onchange = (e) => { resetTriedSources(); fetchEpisodes(e.target.value, 1); }; // Season change   Episode 1
          
          fetchEpisodes(lastS, lastE); // Load last saved or first episode
        }
      }
    }
    
    updateModalWatchlistBtn(id);
 
    // Page khulte hi chupke se background me related movies nikal lo
    loadRelatedMovies(id, type);
 
    // TV ke liye Auto-Focus on Play button
    if (isMzTV()) {
      setTimeout(() => {
        const playBtn = document.querySelector('.play-big') || document.querySelector('.premium-play-btn');
        if (playBtn) playBtn.focus();
      }, 300);
    }
  } catch(e) { console.warn('Modal error', e); }
}
 
// Flag to prevent double-close when history.back() triggers popstate
let _mzModalClosing = false;

function closeModal(fromPopstate) {
  // Prevent double-close
  if (_mzModalClosing) return;
  _mzModalClosing = true;
  setTimeout(() => { _mzModalClosing = false; }, 500);
  
  const overlay = document.getElementById('modal-overlay');
  if (!overlay || !overlay.classList.contains('open')) {
    _mzModalClosing = false;
    return;
  }
  
  // Stop any active trailer
  if (activeTrailerStopper) {
    try { activeTrailerStopper(); } catch(e) {}
  }
  
  // Close the modal UI
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  // Persist and end the accurate watch session started by playMovie(). This is
  // what records the final % and drops the title from Continue Watching if it
  // crossed the completion threshold.
  if (typeof _mzStopWatchSession === 'function') { try { _mzStopWatchSession(); } catch (e) {} }
  const embedEl = document.getElementById('videoEmbed');
  if (embedEl) {
    destroyPrewarm();
    embedEl.innerHTML = '';
    embedEl.classList.remove('fullscreen-mode');
  }
  isPlayerFullscreen = false;
  currentModalMovie = null;
  activeTrailerStopper = null;
  const relSec = document.getElementById('relatedMoviesSection');
  if (relSec) relSec.style.display = 'none';
  
  // Cancel any running auto-retry timer
  if (window._mzRetryTimer) { clearTimeout(window._mzRetryTimer); window._mzRetryTimer = null; }
  
  // Clean up URL hash
  if (window.location.hash.startsWith('#watch-')) {
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch(e) {}
  }
  
  // Always go back to home page (fixes the main TV issue where user gets stuck after search)
  if (isSearchResultsMode) {
    isSearchResultsMode = false;
    goHome();
  }
  
  // Restore focus on TV
  if (isMzTV() && lastFocusedElement) {
    setTimeout(() => {
      try { lastFocusedElement.focus(); } catch(e) {}
    }, 150);
  }
}
 
// TV / Phone Back Button Navigation for Watch Page
window.addEventListener('popstate', (e) => {
  // If closeModal is already running, don't trigger again
  if (_mzModalClosing) return;
  
  const overlay = document.getElementById('modal-overlay');
  if (overlay && overlay.classList.contains('open')) {
    // Modal is open — close it on back navigation
    closeModal();
  } else if (window.location.hash.startsWith('#watch-')) {
    // Hash present but modal not open — clean up stale hash
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
});

// Backup: hashchange event (some TV browsers fire this instead of/alongside popstate)
window.addEventListener('hashchange', () => {
  if (_mzModalClosing) return;
  const overlay = document.getElementById('modal-overlay');
  if (!window.location.hash.startsWith('#watch-') && overlay && overlay.classList.contains('open')) {
    closeModal();
  }
});

// Global Back/Escape handler (works even when TV is not detected via UA)
// This catches: Escape, BrowserBack (keyCode 4), Tizen back (10009), WebOS back (461)
document.addEventListener('keydown', (e) => {
  const key = e.key;
  const keyCode = e.keyCode || e.which;
  const isBackKey = key === 'Escape' || key === 'BrowserBack' || key === 'GoBack' ||
    keyCode === 4 || keyCode === 27 || keyCode === 10009 || keyCode === 461 ||
    key === 'XF86Back';
  
  if (!isBackKey) return;
  
  // Don't handle if TV navigation mode is active (it has its own handler)
  if (isMzTV()) return;
  
  const overlay = document.getElementById('modal-overlay');
  const upcomingOverlay = document.getElementById('upcoming-detail-overlay');
  const collectionsOverlay = document.getElementById('collections-hub-overlay');
  
  if (overlay && overlay.classList.contains('open')) {
    closeModal();
    e.preventDefault();
  } else if (upcomingOverlay && upcomingOverlay.classList.contains('open')) {
    if (typeof closeUpcomingDetail === 'function') closeUpcomingDetail();
    e.preventDefault();
  } else if (collectionsOverlay && collectionsOverlay.classList.contains('open')) {
    if (typeof handleCollectionsBack === 'function') handleCollectionsBack();
    e.preventDefault();
  } else if (isSearchResultsMode) {
    // If showing search results, go back to home
    if (typeof goHome === 'function') goHome();
    const si = document.getElementById('searchInput');
    if (si) si.value = '';
    e.preventDefault();
  }
}, true);
 
// -- RELATED MOVIES LOGIC (Advanced Recommendation Engine) --
/*  A placeholder built from the real card's own elements.
 *
 *  The previous skeleton was a flat 170x255 box, but a populated
 *  .related-slider .movie-card measures 307-443px depending on breakpoint —
 *  poster plus title, rating/year and genre chips. Filling the row therefore
 *  grew it by 75-210px every time. Reusing the card's markup means the box is
 *  correct at every width by construction, with no numbers to keep in sync.
 */
const RELATED_SKELETON = Array(6).fill(
  '<div class="movie-card mz-related-skel" aria-hidden="true">' +
    '<div class="card-poster"><span class="skeleton mz-skel-poster"></span></div>' +
    '<div class="card-info">' +
      '<div class="card-title skeleton mz-skel-text">Placeholder<br>title</div>' +
      '<div class="card-meta">' +
        '<div class="card-rating skeleton mz-skel-text">RATING 0.0</div>' +
        '<div class="card-year skeleton mz-skel-text">YEAR 0000</div>' +
      '</div>' +
      '<div class="card-genres">' +
        '<span class="card-genre skeleton mz-skel-text">Genre</span>' +
        '<span class="card-genre skeleton mz-skel-text">Genre</span>' +
      '</div>' +
    '</div>' +
  '</div>'
).join('');

/*  Puts the related row into the layout before the detail fetch starts.
 *
 *  loadRelatedMovies() used to be the first thing to reveal this section, which
 *  meant ~350px appeared inside .modal-bottom a full round-trip after the modal
 *  had painted — measured as the largest single shift on the page. Showing the
 *  correctly-sized skeleton up front makes the later fill a pure content swap.
 *  The section still hides itself if the fetch comes back empty.
 */
function primeRelatedSection() {
  const section = document.getElementById('relatedMoviesSection');
  const grid = document.getElementById('relatedMoviesGrid');
  if (!section || !grid) return;
  section.style.display = 'block';
  if (!grid.childElementCount) grid.innerHTML = RELATED_SKELETON;
}

async function loadRelatedMovies(id, type) {
  const section = document.getElementById('relatedMoviesSection');
  const grid = document.getElementById('relatedMoviesGrid');
  if (!section || !grid) return;

  primeRelatedSection();
 
  try {
    const combinedResults = [];
    const seenIds = new Set([id]);

    // Get current movie's data for matching
    const currentGenres = (currentModalMovie && currentModalMovie.genres) ? currentModalMovie.genres.map(g => g.id) : [];
    const currentLang = currentModalMovie ? currentModalMovie.original_language : '';
    const currentDirectors = (currentModalMovie && currentModalMovie.credits && currentModalMovie.credits.crew) 
      ? currentModalMovie.credits.crew.filter(c => c.job === 'Director').map(d => d.id) : [];
    const currentCast = (currentModalMovie && currentModalMovie.credits && currentModalMovie.credits.cast)
      ? currentModalMovie.credits.cast.slice(0, 5).map(c => c.id) : [];

    // PRIORITY 1: Same collection/franchise
    if (type === 'movie' && currentModalMovie && currentModalMovie.belongs_to_collection) {
      const collectionId = currentModalMovie.belongs_to_collection.id;
      const collectionData = await tmdb(`/collection/${collectionId}`, { language: 'en-US' });
      if (collectionData && collectionData.parts) {
        collectionData.parts.sort((a, b) => (a.release_date || '0').localeCompare(b.release_date || '0'));
        collectionData.parts.forEach(movie => {
          if (movie && movie.id && !seenIds.has(movie.id)) {
            movie._isCollection = true;
            combinedResults.push(movie);
            seenIds.add(movie.id);
          }
        });
      }
    }

    // PRIORITY 2: Fetch recommendations, similar, and keyword-based discover
    const fetchPromises = [
      tmdb('/' + type + '/' + id + '/recommendations', { language: 'en-US', page: '1' }),
      tmdb('/' + type + '/' + id + '/similar', { language: 'en-US', page: '1' }),
      tmdb('/' + type + '/' + id + '/recommendations', { language: 'en-US', page: '2' })
    ];

    // PRIORITY 3: Genre-based discover (same genres + same language = highly relevant)
    if (currentGenres.length > 0) {
      const genreStr = currentGenres.slice(0, 3).join(',');
      fetchPromises.push(
        tmdb('/discover/' + type, { 
          language: 'en-US', 
          with_genres: genreStr, 
          sort_by: 'vote_count.desc',
          'vote_average.gte': '6',
          'vote_count.gte': '100',
          with_original_language: currentLang || 'en',
          page: '1'
        })
      );
    }

    // PRIORITY 4: Director's other movies (if available)
    if (currentDirectors.length > 0) {
      fetchPromises.push(
        tmdb('/discover/' + type, {
          language: 'en-US',
          with_crew: currentDirectors[0].toString(),
          sort_by: 'vote_count.desc',
          page: '1'
        })
      );
    }

    const results = await Promise.allSettled(fetchPromises);

    results.forEach((res) => {
      if (res.status === 'fulfilled' && res.value && res.value.results) {
        res.value.results.forEach(movie => {
          if (movie && movie.id && !seenIds.has(movie.id)) {
            combinedResults.push(movie);
            seenIds.add(movie.id);
          }
        });
      }
    });
 
    const realToday = new Date().toISOString().split('T')[0];
    
    // Filter and score each movie
    const scoredMovies = combinedResults.filter(m => {
      if (!m.poster_path) return false;
      const rDate = m.release_date || m.first_air_date;
      if (rDate && rDate > realToday) return false;
      return true;
    }).map(m => {
      let score = 0;

      // Collection/franchise bonus (highest priority)
      if (m._isCollection) score += 100;

      // Genre match scoring (0-40 points)
      const movieGenres = m.genre_ids || [];
      const genreMatches = movieGenres.filter(g => currentGenres.includes(g)).length;
      score += genreMatches * 15; // Each matching genre = 15 points

      // Same language bonus (important for Bollywood/regional)
      if (m.original_language === currentLang) score += 20;

      // Same director bonus
      // (we can't check this without full credits, so skip for discovered items)

      // Cast overlap bonus (from discover results won't have this, but TMDB recs/similar will be relevant)
      
      // Quality score (higher rated = more relevant)
      if (m.vote_average >= 7) score += 10;
      else if (m.vote_average >= 6) score += 5;

      // Popularity bonus (well-known movies are better suggestions)
      if (m.vote_count > 1000) score += 8;
      else if (m.vote_count > 500) score += 4;

      // Penalize very old movies unless collection
      if (!m._isCollection) {
        const year = parseInt((m.release_date || m.first_air_date || '2000').slice(0, 4));
        const currentYear = new Date().getFullYear();
        if (currentYear - year <= 5) score += 5; // Recent bonus
      }

      m._relevanceScore = score;
      return m;
    });

    // Sort by relevance score (highest first)
    scoredMovies.sort((a, b) => b._relevanceScore - a._relevanceScore);

    const finalMovies = scoredMovies.slice(0, 20);
 
    if (finalMovies.length > 0) {
      grid.innerHTML = '';
      const fragment = document.createDocumentFragment();
      finalMovies.forEach((m, i) => {
        const rType = m.media_type || type;
        const rating = m.vote_average ? m.vote_average.toFixed(1) : 'N/A';
        const year = (m.release_date || m.first_air_date || '').slice(0, 4);
        const isHot = m.popularity > 100;
        const genres = (m.genre_ids||[]).slice(0,2).map(gId => GENRE_MAP[gId]).filter(Boolean);
        let qual = 'HD';
        if (m.vote_average >= 7.5) qual = '4K';
        else if (m.vote_average >= 6.5) qual = 'FHD';
 
        const card = document.createElement('div');
        card.className = 'movie-card reveal-up';
        card.tabIndex = 0;
        card.style.animationDelay = ((i % 12) * 0.04) + 's';
        card.innerHTML =
          '<div class="card-poster">' +
            '<img src="'+IMG+m.poster_path+'"' +
              // The grid is minmax(185px, 1fr) on desktop and 2 columns on
              // phones, so a card is roughly 185-260 CSS px wide. A single w342
              // src made a 1x desktop download ~2.6x the pixels it displays and
              // left a 3x phone slightly soft. Letting the browser choose fixes
              // both directions from one markup change.
              ' srcset="https://image.tmdb.org/t/p/w185'+m.poster_path+' 185w,' +
              ' https://image.tmdb.org/t/p/w342'+m.poster_path+' 342w,' +
              ' https://image.tmdb.org/t/p/w500'+m.poster_path+' 500w"' +
              ' sizes="(max-width: 600px) 45vw, (max-width: 1200px) 200px, 230px"' +
              ' alt="'+escapeHTML(m.title||m.name||'')+'" width="170" height="255"' +
              ' loading="lazy" decoding="async">' +
            '<div class="card-quality">'+qual+'</div>' +
            (isHot ? '<div class="card-hot">HOT</div>' : '') +
            (m._isCollection ? '<div class="card-dubbed" style="background:rgba(245,197,24,0.2);color:var(--gold);border:1px solid rgba(245,197,24,0.4);">FRANCHISE</div>' : '') +
            '<div class="card-overlay"><button class="card-play-btn">&#9654;</button></div>' +
          '</div>' +
          '<div class="card-info">' +
            '<div class="card-title">'+escapeHTML(m.title||m.name||'')+'</div>' +
            '<div class="card-meta"><div class="card-rating">RATING '+rating+'</div><div class="card-year">YEAR '+year+'</div></div>' +
            '<div class="card-genres">'+genres.map(g => '<span class="card-genre">'+escapeHTML(g)+'</span>').join('')+'</div>' +
          '</div>';
        card.addEventListener('click', (event) => { openModal(m.id, rType, event); });
        fragment.appendChild(card);
        // PERF (TV): reveal observer skip — TV CSS me .reveal-up ka opacity force hai.
      if (!isMzTV()) scrollObserver.observe(card);
      });
      grid.appendChild(fragment);

      // Setup navigation arrows
      const prevBtn = document.getElementById('relatedPrev');
      const nextBtn = document.getElementById('relatedNext');
      const scrollAmount = 380;

      const updateArrowState = () => {
        if (prevBtn) prevBtn.disabled = grid.scrollLeft <= 10;
        if (nextBtn) nextBtn.disabled = grid.scrollLeft >= (grid.scrollWidth - grid.clientWidth - 10);
      };

      if (prevBtn) prevBtn.onclick = () => { grid.scrollBy({ left: -scrollAmount, behavior: isMzTVMode() ? 'auto' : 'smooth' }); };
      if (nextBtn) nextBtn.onclick = () => { grid.scrollBy({ left: scrollAmount, behavior: isMzTVMode() ? 'auto' : 'smooth' }); };

      grid.addEventListener('scroll', updateArrowState, { passive: true });
      updateArrowState();

    } else {
      section.style.display = 'none';
    }
  } catch(e) { 
    console.warn("Could not load related movies:", e);
    section.style.display = 'none'; 
  }
}
 
/* ══════════════════════════════════════════════════════════════
   ANIME PLAYBACK BRIDGE
   Anime/Cartoon servers AniList ID maangte hain (TMDB ID nahi),
   isliye TMDB title → AniList ID mapping (cached in localStorage).
   ══════════════════════════════════════════════════════════════ */
const anilistIdCache = new Map();
let anilistLookupInFlight = false;

function normalizeTitleForMatch(t) {
  return String(t || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(season|part|cour|the animation|tv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Anime/animation content detect karta hai (anime + Japanese/Chinese/Korean cartoons) */
function isAnimeContent(m) {
  if (!m) return false;
  const ids = (m.genre_ids || (Array.isArray(m.genres) ? m.genres.map(g => g.id) : []) || []);
  const lang = m.original_language;
  const isAnimated = ids.includes(16) || ids.includes(10762);
  return isAnimated && (lang === 'ja' || lang === 'zh' || lang === 'ko');
}

/** Kisi bhi animated content (Doraemon/Ben10/Tom&Jerry bhi) ke liye true */
function isCartoonContent(m) {
  if (!m) return false;
  const ids = (m.genre_ids || (Array.isArray(m.genres) ? m.genres.map(g => g.id) : []) || []);
  return ids.includes(16) || ids.includes(10762);
}

function animeAudioTrack(lang) {
  if (lang === 'hi') return 'hindi';   // VidNest officially Hindi dub support karta hai
  if (lang === 'en') return 'dub';
  return 'sub';
}

function anilistCacheKey(m, season) {
  const type = (m && m.media_type) || 'tv';
  return type + '-' + (m ? m.id : '0') + '-s' + (season || 1);
}

function getAnilistIdSync(m, season) {
  if (!m) return null;
  const key = anilistCacheKey(m, season);
  if (anilistIdCache.has(key)) return anilistIdCache.get(key);
  try {
    const ls = localStorage.getItem('mz_anilist_' + key);
    if (ls !== null) {
      const val = (ls === 'null' || ls === '') ? null : parseInt(ls, 10);
      const safe = isNaN(val) ? null : val;
      anilistIdCache.set(key, safe);
      return safe;
    }
  } catch (e) {}
  return null;
}

function setAnilistId(m, season, id) {
  const key = anilistCacheKey(m, season);
  anilistIdCache.set(key, id);
  try { localStorage.setItem('mz_anilist_' + key, id === null ? 'null' : String(id)); } catch (e) {}
}

/** AniList GraphQL se best matching anime entry dhundhta hai */
async function resolveAnilistId(m, season) {
  if (!m) return null;
  const cached = getAnilistIdSync(m, season);
  if (cached !== null) return cached;

  const s = parseInt(season || 1, 10) || 1;
  const engTitle  = m.name || m.title || '';
  const origTitle = m.original_name || m.original_title || '';
  const year = parseInt(String(m.first_air_date || m.release_date || '').slice(0, 4), 10) || null;
  const wantMovie = (m.media_type === 'movie');

  const searches = [];
  if (engTitle)  searches.push(s > 1 ? engTitle + ' season ' + s : engTitle);
  if (origTitle && origTitle !== engTitle) searches.push(s > 1 ? origTitle + ' season ' + s : origTitle);
  if (s > 1 && engTitle) searches.push(engTitle); // fallback: base entry

  const query = 'query($s:String){Page(perPage:8){media(search:$s,type:ANIME,sort:SEARCH_MATCH){id title{romaji english} format startDate{year} episodes popularity}}}';

  for (const term of searches) {
    let list = [];
    try {
      const r = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables: { s: term } })
      });
      if (!r.ok) continue;
      const j = await r.json();
      list = (j && j.data && j.data.Page && j.data.Page.media) || [];
    } catch (e) { continue; }
    if (!list.length) continue;

    const target = normalizeTitleForMatch(engTitle || origTitle);
    let best = null, bestScore = -Infinity;
    list.forEach(a => {
      let score = 0;
      const rom = normalizeTitleForMatch(a.title && a.title.romaji);
      const eng = normalizeTitleForMatch(a.title && a.title.english);
      if (rom === target || eng === target) score += 6;
      else if ((rom && target && (rom.indexOf(target) === 0 || target.indexOf(rom) === 0)) ||
               (eng && target && (eng.indexOf(target) === 0 || target.indexOf(eng) === 0))) score += 3;
      else if ((rom && target && rom.indexOf(target) !== -1) || (eng && target && eng.indexOf(target) !== -1)) score += 1;

      const ay = a.startDate && a.startDate.year;
      if (year && ay) {
        const diff = Math.abs(ay - year);
        if (diff === 0) score += 4; else if (diff === 1) score += 2; else if (diff <= 3) score += 0.5; else score -= 1;
      }
      if (wantMovie) { if (a.format === 'MOVIE') score += 3; else score -= 2; }
      else { if (a.format === 'MOVIE') score -= 2; else score += 1.5; }
      score += Math.min((a.popularity || 0) / 100000, 0.9);

      if (score > bestScore) { bestScore = score; best = a; }
    });

    if (best && bestScore >= 2) {
      setAnilistId(m, s, best.id);
      return best.id;
    }
  }
  setAnilistId(m, s, null); // negative cache — dubara useless lookups na ho
  return null;
}

/**
 * Anime server select hone par AniList id background me resolve karta hai
 * aur milte hi player ko sahi anime stream par reload kar deta hai.
 */
function ensureAnilistThenReload(m, season, srcIdx, lang, quality, type) {
  if (!m || anilistLookupInFlight) return;
  const s = parseInt(season || 1, 10) || 1;
  const key = anilistCacheKey(m, s);
  if (anilistIdCache.has(key) || getAnilistIdSync(m, s) !== null) return;
  anilistLookupInFlight = true;
  resolveAnilistId(m, s).then(anilistId => {
    anilistLookupInFlight = false;
    if (!anilistId) return;
    // Sirf tab reload karo jab user usi title par aur usi anime server par hai
    if (!currentModalMovie || currentModalMovie.id !== m.id) return;
    if (currentSourceIdx !== srcIdx) return;
    loadPlayer(m.id, srcIdx, lang, quality, type);
  }).catch(() => { anilistLookupInFlight = false; });
}

// -- PLAYER SOURCES — FINAL (July 2026) --
// All tested & working. Includes 2 PREMIUM all-in-one servers.
const playerSources = [
  // ⚡ #0 ALL-ROUNDER: Anime + Cartoons + Movies + Web Series, with real Hindi dub tracks.
  // Anime ke liye AniList route (hindi/dub/sub), baaki sab ke liye TMDB route.
  // ⚡ #1 ALL-ROUNDER 4K: Videasy — anime + movies + series, high bitrate, multi-audio
  { name: 'OmniPlay 4K', dubbed: true, is4K: true, anime: true, url: (id, lang, type, s, e) => {
    const m = currentModalMovie;
    const wantDub = (lang === 'hi' || lang === 'en');
    const common = `color=ffc107&autoplay=true&nextEpisode=true&episodeSelector=true&autoplayNextEpisode=true`;
    if (isAnimeContent(m)) {
      const anilistId = getAnilistIdSync(m, s);
      if (anilistId) {
        const ep = String(parseInt(e, 10) || 1);
        return `https://player.videasy.net/anime/${anilistId}/${ep}?dub=${wantDub}&${common}`;
      }
    }
    return type === 'tv'
      ? `https://player.videasy.net/tv/${id}/${s}/${e}?${common}&lang=${lang}`
      : `https://player.videasy.net/movie/${id}?${common}&lang=${lang}`;
  }},
  // 🌸 ANIME SPECIALIST: AnimePahe mirror — purane/long-running anime & cartoons ke liye best
  { name: 'AnimePahe HD', dubbed: true, is4K: true, anime: true, url: (id, lang, type, s, e) => {
    const m = currentModalMovie;
    const track = animeAudioTrack(lang) === 'hindi' ? 'dub' : animeAudioTrack(lang); // animepahe: sub/dub
    if (isAnimeContent(m)) {
      const anilistId = getAnilistIdSync(m, s);
      if (anilistId) {
        const ep = String(parseInt(e, 10) || 1);
        return `https://vidnest.fun/animepahe/${anilistId}/${ep}/${track}`;
      }
    }
    // Cartoon/movie fallback: VidNest ke alfa/gama server force karke high-quality stream
    return type === 'tv'
      ? `https://vidnest.fun/tv/${id}/${s}/${e}?server=alfa`
      : `https://vidnest.fun/movie/${id}?server=gama`;
  }},
  { name: '4K Ultra HD', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    // #1: Viduki.net API 2 — 4K AI Upscaling + Multi-Language + 5.1 Surround
    return type === 'tv'
      ? `https://www.viduki.net/2/tv/${id}/${s}/${e}`
      : `https://www.viduki.net/2/movie/${id}`;
  }},
  // 🔁 Cinextream (cinextream.net) ka domain dead ho gaya (DNS record hi nahi bacha),
  //    uski jagah VidFast — 4K/multi-audio, tez CDN, movies + series dono
  { name: 'VidFast 4K', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    const opts = `autoPlay=true&theme=FFC107&title=true&poster=true&autoNext=true&nextButton=true&lang=${lang}`;
    return type === 'tv'
      ? `https://vidfast.pro/tv/${id}/${s}/${e}?${opts}`
      : `https://vidfast.pro/movie/${id}?${opts}`;
  }},
         { name: 'Flicky Stream', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    // #8: Flicky — Working embed, multiple servers
    return type === 'tv'
      ? `https://flicky.host/embed/tv/?id=${id}&s=${s}&e=${e}`
      : `https://flicky.host/embed/movie/?id=${id}`;
  }},
  { name: 'VidRock HD', dubbed: true, url: (id, lang, type, s, e) => {
    return type === 'tv'
      ? `https://vidrock.net/tv/${id}/${s}/${e}`
      : `https://vidrock.net/movie/${id}`;
  }},
  // { name: 'Hindi Multi-Audio', dubbed: true, url: (id, lang, type, s, e) => {
  //   const base = `https://embed.smashystream.com/playere.php?tmdb=${id}`;
  //   return type === 'tv' ? `${base}&season=${s}&episode=${e}` : base;
  // }},
  { name: 'Turbo Stream', dubbed: true, url: (id, lang, type, s, e) => {
    return type === 'tv'
      ? `https://111movies.com/tv/${id}/${s}/${e}`
      : `https://111movies.com/movie/${id}`;
  }},
    { name: 'Ultra HD', dubbed: true, url: (id, lang, type, s, e) => {
    // #6: AutoEmbed — India ke networks par blockage kam aati hai
    return (type === 'tv' ? `https://autoembed.co/tv/tmdb/${id}-${s}-${e}` : 'https://autoembed.co/movie/tmdb/' + id) + `?lang=${lang}`;
  }},
  { name: 'Pro Stream', dubbed: true, url: (id, lang, type, s, e) => {
    // #4: VidLink Pro — Clean interface with settings
    /*  startAt is the ONE resume parameter in this list that its provider actually
     *  documents (vidlink.pro publishes it, in seconds, alongside the postMessage
     *  progress contract this app now listens to). The other nine servers document
     *  nothing of the sort, so they get no offset: inventing a parameter name would
     *  only append a query string they ignore, while still changing the URL string
     *  that takePrewarmedFrame() matches on.
     *
     *  The typeof guard is not paranoia. A URL builder must never be able to throw:
     *  playerHostOrigins() runs every builder inside a try/catch and simply SKIPS
     *  the ones that fail, so a missing dependency here would quietly drop
     *  vidlink.pro out of the preconnect list with no error anywhere. That is also
     *  precisely how player-health.test.js caught this — it evaluates playerSources
     *  in an isolated sandbox where only the array exists. */
    const at = (typeof mzResumeSec === 'function') ? mzResumeSec(id, type, s, e) : 0;
    return (type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : 'https://vidlink.pro/movie/' + id)
      + `?lang=${lang}` + (at ? '&startAt=' + at : '');
  }},

  { name: 'Premium Mirror', dubbed: true, url: (id, lang, type, s, e) => {
    // #9: Official proxy mirror to fix 'refused to connect' / iframe block issue
    return (type === 'tv' ? `https://vidsrc.pm/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc.pm/embed/movie?tmdb=${id}`) + `&lang=${lang}`;
  }}
];


let currentSourceIdx = 0;
let isPlayerFullscreen = false;
 
// -- LANGUAGE CONFIG (for quick-buttons) --
const LANG_CONFIG = {
  hi: { flag: 'HI', name: 'Hindi',      code: 'hi' },
  en: { flag: 'EN', name: 'English',    code: 'en' },
  ta: { flag: 'TA', name: 'Tamil',      code: 'ta' },
  te: { flag: 'TE', name: 'Telugu',     code: 'te' },
  ml: { flag: 'ML', name: 'Malayalam',  code: 'ml' },
  kn: { flag: 'KN', name: 'Kannada',    code: 'kn' },
  mr: { flag: 'MR', name: 'Marathi',    code: 'mr' },
  bn: { flag: 'BN', name: 'Bengali',    code: 'bn' },
};
const DUBBED_LANGS = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'];
const CORE_LANGS   = ['hi', 'en', 'ta', 'te'];
const EXTRA_LANGS  = ['ml', 'kn', 'mr', 'bn'];

function renderLanguageButtons(spokenLangs) {
  const ext = document.getElementById('externalSources');
  if (!ext) return;
  const old = document.getElementById('mz-lang-section');
  if (old) old.remove();
  const tmdbCodes = (spokenLangs || []).map(l => l.iso_639_1);
  const extra = EXTRA_LANGS.filter(c => tmdbCodes.includes(c));
  const toShow = [...CORE_LANGS, ...extra];
  const curLang = getSelectedLang();

  const btnsHtml = toShow.map(code => {
    const cfg = LANG_CONFIG[code];
    if (!cfg) return '';
    const isActive = code === curLang;
    const isAvail  = tmdbCodes.includes(code);
    return `<button class="player-chip mz-lang-btn${isActive?' active':''}${isAvail?' mz-lang-avail':''}" data-lang="${code}" title="${isAvail?'Dubbed available on TMDB':'Subtitles if dub unavailable'}"><span>${cfg.flag}</span> ${cfg.name}${isAvail?'<span class="mz-avail-dot"></span>':''}</button>`;
  }).join('');

  const section = document.createElement('div');
  section.id = 'mz-lang-section';
  section.style.cssText = 'margin-top:14px; border-top:1px solid rgba(255,255,255,0.08); padding-top:12px;';
  section.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:7px;">${btnsHtml}</div>

  `;
  ext.appendChild(section);

  section.querySelectorAll('.mz-lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.getAttribute('data-lang');
      if (!lang || !currentModalMovie) return;
      setSelectedLang(lang);
      const langDrop = document.getElementById('langSelect');
      if (langDrop) langDrop.value = lang;
      section.querySelectorAll('.mz-lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Auto-switch to Multi-Audio (index 0) for dubbed languages
      let targetSrcIdx = currentSourceIdx;
      if (DUBBED_LANGS.includes(lang)) {
        targetSrcIdx = 0;
        currentSourceIdx = 0;
        document.querySelectorAll('.player-chip--source').forEach((b, i) => b.classList.toggle('active', i === 0));
      }
      loadPlayer(currentModalMovie.id, targetSrcIdx, lang, getSelectedQuality(), currentModalMovie.media_type);
      const cfg = LANG_CONFIG[lang] || {};
      showToast(` ${cfg.flag||''} ${cfg.name||lang} Audio${DUBBED_LANGS.includes(lang)?' |  Multi-Audio activated':''}`);
    });
  });
}

function renderExternalSources(id, srcIdx, lang) {
  const ext = document.getElementById('externalSources');
  if (!ext) return;

  // ── Categorize servers for premium layout ──
  const premium4K = [];
  const hdStreams = [];

  playerSources.forEach((s, i) => {
    const serverData = { ...s, _idx: i };
    if (s.is4K || s.anime) { premium4K.push(serverData); }
    else { hdStreams.push(serverData); }
  });

  function buildServerCard(s) {
    const tip = s.anime
      ? 'All-Rounder: Anime + Cartoons + Movies + Series (Hindi Dub supported)'
      : (s.is4K ? '4K AI Upscaling + Multi-Language + Spatial Audio' : (s.dubbed ? 'Hindi Dubbed + Multi-Audio' : 'Mostly English Audio'));
    const badges = [];
    if (s.is4K) badges.push('<span class="srv-badge srv-badge--4k"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>4K</span>');
    if (s.anime) badges.push('<span class="srv-badge srv-badge--anime"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>ANIME</span>');
    if (s.dubbed) badges.push('<span class="srv-badge srv-badge--dub"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>DUB</span>');
    return '<button class="srv-card player-chip--source'
      + (s.is4K ? ' srv-card--4k' : '')
      + (s.anime ? ' srv-card--anime' : '')
      + (s.dubbed ? ' srv-card--dubbed' : '')
      + '" data-srcidx="' + s._idx + '" title="' + escapeHTML(tip) + '">'
      + '<div class="srv-card__inner">'
      + '<span class="srv-card__name">' + escapeHTML(s.name) + '</span>'
      + '<span class="srv-card__status"></span>'
      + '</div>'
      + (badges.length ? '<div class="srv-card__badges">' + badges.join('') + '</div>' : '')
      + '<div class="srv-card__glow"></div>'
      + '</button>';
  }

  function buildSection(title, icon, servers, className) {
    if (!servers.length) return '';
    const cards = servers.map(buildServerCard).join('');
    return '<div class="srv-section ' + className + '">'
      + '<div class="srv-section__header">'
      + '<span class="srv-section__icon">' + icon + '</span>'
      + '<span class="srv-section__title">' + title + '</span>'
      + '<span class="srv-section__count">' + servers.length + ' servers</span>'
      + '</div>'
      + '<div class="srv-section__grid">' + cards + '</div>'
      + '</div>';
  }

  const headerHtml = '<div class="srv-master-header">'
    + '<div class="srv-master-header__left">'
    + '<svg class="srv-master-header__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
    + '<span class="srv-master-header__title">Playback Servers</span>'
    + '</div>'
    + '<span class="srv-master-header__live"><span class="srv-live-dot"></span>LIVE</span>'
    + '</div>';

  const sectionsHtml = buildSection(
    'Premium 4K • Hindi Dub',
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    premium4K, 'srv-section--premium'
  ) + buildSection(
    'HD Streams • Multi-Audio',
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    hdStreams, 'srv-section--hd'
  );

  ext.innerHTML = headerHtml + '<div class="srv-container">' + sectionsHtml + '</div>';

  const srcButtons = ext.querySelectorAll('.player-chip--source');
  srcButtons.forEach(btn => {
    /*  ⚡ Warm the server the user is about to pick.
     *
     *  This used to listen on mouseenter and focus only, which means it did
     *  nothing at all on a phone or tablet — there is no hover there, so every
     *  server switch on touch paid the full DNS + TCP + TLS + provider-document
     *  cost after the tap. That is most of the wait users feel when they try a
     *  different server.
     *
     *  pointerdown/touchstart fire while the finger is still down, ~100-300ms
     *  before click, and they run the LIGHT path: preconnect plus the provider
     *  document into the HTTP cache. No iframe, so nothing can start media in the
     *  background and a mistaken tap costs one cached document.
     *
     *  The heavy path (hidden prewarm frame) stays on hover/focus, where there is
     *  a real signal of intent and a desktop or TV to afford it. prewarmPlayer()
     *  also refuses once #playerFrame exists — which is exactly the switch-while-
     *  watching case — so the light path is what carries that scenario, and it
     *  now runs there too.
     */
    const warmThis = (event) => {
      const idx = parseInt(btn.getAttribute('data-srcidx') || '0', 10);
      const type = currentModalMovie ? (currentModalMovie.media_type || 'movie') : 'movie';
      try { warmEmbedUrl(buildPlayerUrl(id, type, idx), playerSources[idx] && playerSources[idx].name); } catch (e) {}
      const kind = event && event.type;
      if (kind === 'mouseenter' || kind === 'focus') prewarmPlayer(id, type, idx);
    };
    ['mouseenter', 'focus', 'pointerdown', 'touchstart']
      .forEach(evt => btn.addEventListener(evt, warmThis, { passive: true }));
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-srcidx')||'0', 10);
      const type = currentModalMovie ? currentModalMovie.media_type : 'movie';
      const quality = getSelectedQuality();
      loadPlayer(id, idx, getSelectedLang(), quality, type);
      srcButtons.forEach(b => { b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
  if (typeof srcIdx === 'number') {
    srcButtons.forEach(b => { b.classList.remove('active'); });
    const activeBtn = ext.querySelector('.player-chip--source[data-srcidx="'+srcIdx+'"]');
    if (activeBtn) activeBtn.classList.add('active');
  }

  // Render language quick-buttons below server buttons
  const spokenLangs = (currentModalMovie && currentModalMovie.spoken_languages) || [];
  renderLanguageButtons(spokenLangs);
}
 
function getSelectedLang() {
  const select = document.getElementById('langSelect');
  return select ? select.value : (localStorage.getItem('moviezone.playerLang') || 'hi');
}
 
function setSelectedLang(lang) {
  const select = document.getElementById('langSelect');
  if (select) select.value = lang;
  localStorage.setItem('moviezone.playerLang', lang);
}
 
function getSelectedQuality() {
  const select = document.getElementById('qualitySelect');
  return select ? select.value : (localStorage.getItem('moviezone.playerQuality') || 'fhd');
}
 
function setSelectedQuality(quality) {
  const select = document.getElementById('qualitySelect');
  if (select) select.value = quality;
  localStorage.setItem('moviezone.playerQuality', quality);
}
 
/*  ══════════════════════════════════════════════════════════════════════
 *  LEARNED SERVER HEALTH — why playback used to feel slow
 *  ══════════════════════════════════════════════════════════════════════
 *  The player had no memory. Every play started at a fixed server index and
 *  waited a flat 5000 ms before deciding that server was dead, then walked to
 *  the NEXT INDEX and waited another 5000 ms. If the first two providers were
 *  blocked on this user's network — which is normal, these hosts get blocked
 *  regionally all the time — the user sat through 10-15 seconds of spinner
 *  before anything played. And because nothing was recorded, the exact same
 *  penalty was paid again on the next movie, forever.
 *
 *  Now every load outcome is measured and persisted, so the player converges
 *  on whatever actually works fast for THIS user:
 *
 *    • ordering — servers are tried best-first by measured latency and failure
 *      rate instead of by their position in the array
 *    • give-up time — a server that normally answers in 1.2 s is no longer
 *      given 5 s to prove it is broken; the timeout follows its own history
 *    • recovery — a success partially forgives past failures, so a provider
 *      that was down for a day is not blacklisted forever
 *
 *  Latency is stored as an EWMA so one slow night does not condemn a good
 *  server and a recovering one climbs back quickly.
 */
const MZ_PLAYER_HEALTH_KEY = 'mz_player_health_v1';
const MZ_PH_DEFAULT_TIMEOUT = 5000;  // unknown server: same patience as before
const MZ_PH_MIN_TIMEOUT = 2200;      // never abandon faster than this
const MZ_PH_MAX_TIMEOUT = 6000;
const MZ_DUBBED_LANGS = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'];

let _mzPlayerHealth = null;

function playerHealth() {
  if (_mzPlayerHealth) return _mzPlayerHealth;
  try {
    _mzPlayerHealth = JSON.parse(localStorage.getItem(MZ_PLAYER_HEALTH_KEY)) || {};
  } catch (e) { _mzPlayerHealth = {}; }
  return _mzPlayerHealth;
}

function _mzPersistPlayerHealth() {
  // Tiny payload, but still keep it off the critical path — this fires right
  // when the player is starting up.
  _mzOnIdle(() => {
    try { localStorage.setItem(MZ_PLAYER_HEALTH_KEY, JSON.stringify(playerHealth())); }
    catch (e) {}
  });
}

function _mzHealthEntry(name) {
  const h = playerHealth();
  if (!h[name]) h[name] = { ok: 0, fail: 0, ms: 0 };
  return h[name];
}

/** A provider answered. Record how long it took. */
function recordPlayerLoad(name, ms) {
  if (!name || !(ms >= 0)) return;
  const e = _mzHealthEntry(name);
  e.ok++;
  e.ms = e.ms ? Math.round(e.ms * 0.7 + ms * 0.3) : ms;
  // Partial forgiveness: a provider that is back up should climb the order
  // again instead of carrying its outage for the rest of the user's life.
  e.fail = Math.max(0, +(e.fail - 0.5).toFixed(1));
  _mzPersistPlayerHealth();
}

/** A provider timed out or refused. */
function recordPlayerFailure(name) {
  if (!name) return;
  const e = _mzHealthEntry(name);
  e.fail++;
  _mzPersistPlayerHealth();
}

/*  Ranking cost, lower is better. A failure is weighted far above any latency
 *  difference, because waiting for a dead server costs the full timeout while
 *  the gap between a fast and a slow working server is a second or two.
 *  Never-tried servers sit mid-pack: ahead of known-bad, behind known-good, so
 *  the player explores rather than locking onto the first thing that worked.
 */
function playerCost(name) {
  const h = playerHealth()[name];
  if (!h || (!h.ok && !h.fail)) return 4000;
  const attempts = h.ok + h.fail;
  const failRate = h.fail / Math.max(1, attempts);
  return (h.ms || 3500) + failRate * 12000;
}

function rankSourceIdxs(idxs) {
  return idxs.slice().sort((a, b) => {
    const d = playerCost(playerSources[a].name) - playerCost(playerSources[b].name);
    return d !== 0 ? d : a - b;   // stable: fall back to declared order
  });
}

/** Servers eligible for this content, honouring the anime and dub rules. */
function candidateSourceIdxs(lang, movie) {
  const all = playerSources.map((_, i) => i);
  const isAnime = movie && (isAnimeContent(movie) || isCartoonContent(movie));
  if (isAnime) {
    const a = all.filter(i => playerSources[i].anime);
    if (a.length) return a;
  }
  if (MZ_DUBBED_LANGS.indexOf(lang) !== -1) {
    const d = all.filter(i => playerSources[i].dubbed);
    if (d.length) return d;
  }
  return all;
}

/** How long to wait before giving up on this specific server. */
function adaptivePlayerTimeout(name) {
  const h = playerHealth()[name];
  if (!h || !h.ok || !h.ms) return MZ_PH_DEFAULT_TIMEOUT;
  return Math.min(MZ_PH_MAX_TIMEOUT, Math.max(MZ_PH_MIN_TIMEOUT, Math.round(h.ms * 2.2)));
}

// Servers already attempted for the current play, so a retry chain never loops
// back onto something that just failed.
let _mzTriedSources = new Set();
function resetTriedSources() { _mzTriedSources = new Set(); }

function getSelectedSourceIdx() {
  const raw = localStorage.getItem('moviezone.playerSourceIdx');
  const saved = parseInt(raw === null ? '-1' : raw, 10);
  const ranked = rankSourceIdxs(playerSources.map((_, i) => i));
  const best = ranked.length ? ranked[0] : 0;

  // Nothing stored yet — open on whatever has actually performed best here
  // rather than always on index 0.
  if (isNaN(saved) || saved < 0 || saved >= playerSources.length) return best;

  /*  A stored pick is respected, with one exception: if that server's measured
   *  record is far worse than the best available, honouring it would mean
   *  knowingly making the user watch a spinner. The threshold is deliberately
   *  high (twice the cost AND above the mid-pack baseline) so a genuine
   *  preference is not overridden by one unlucky failure.
   */
  const savedCost = playerCost(playerSources[saved].name);
  if (savedCost > playerCost(playerSources[best].name) * 2 && savedCost > 6000) return best;
  return saved;
}
 
function setSelectedSourceIdx(idx) {
  localStorage.setItem('moviezone.playerSourceIdx', String(idx));
}
 
function buildSourceLabel(srcIdx) {
  return playerSources[srcIdx] ? playerSources[srcIdx].name : (playerSources[0] ? playerSources[0].name : 'Source');
}
 
function playMovie() {
  if (!currentModalMovie) return;
  // Start an accurate watch session (real progress, not a random guess). It
  // seeds the Continue Watching rail immediately and tracks visible watch time
  // against the title's runtime — see _mzStartWatchSession.
  if (typeof _mzStartWatchSession === 'function' && currentModalMovie) {
    const rt = currentModalMovie.runtime ||
      (currentModalMovie.episode_run_time && currentModalMovie.episode_run_time[0]) || 0;
    _mzStartWatchSession(currentModalMovie, rt);
  }
  currentSourceIdx = getSelectedSourceIdx();
  const lang = getSelectedLang();
  const quality = getSelectedQuality();
  // Anime/Cartoon: agar user ka saved server anime support nahi karta to
  // automatically All-Rounder (anime-capable) server pe switch kar do
  if ((isAnimeContent(currentModalMovie) || isCartoonContent(currentModalMovie)) &&
      playerSources[currentSourceIdx] && !playerSources[currentSourceIdx].anime) {
    const animeIdx = playerSources.findIndex(sr => sr.anime);
    if (animeIdx !== -1) {
      currentSourceIdx = animeIdx;
      showToast(`Anime detected — switched to ${playerSources[animeIdx].name}`);
    }
  }
  loadPlayer(currentModalMovie.id, currentSourceIdx, lang, quality, currentModalMovie.media_type);
}
 
function playNextEpisode() {
  if (!currentModalMovie || currentModalMovie.media_type !== 'tv') return;
  
  const sInput = document.getElementById('seasonInput');
  const eInput = document.getElementById('episodeInput');
  if (!sInput || !eInput) return;
 
  const currentS = parseInt(sInput.value, 10);
  const currentE = parseInt(eInput.value, 10);
  
  const nextEpOption = Array.from(eInput.options).find(opt => parseInt(opt.value) === currentE + 1);
  
  if (nextEpOption) {
    eInput.value = currentE + 1;
    eInput.dispatchEvent(new Event('change'));
    showToast(` Playing Season ${currentS} Episode ${currentE + 1}`);
  } else {
    const seasons = (currentModalMovie.seasons || []).filter(s => s.season_number > 0);
    const nextSeason = seasons.find(s => s.season_number === currentS + 1);
    if (nextSeason) {
      sInput.value = currentS + 1;
      sInput.dispatchEvent(new Event('change'));
      showToast(` Playing Season ${currentS + 1} Episode 1`);
    } else {
      showToast(" You have reached the latest episode!");
    }
  }
}
 
/* ══════════════════════════════════════════════════════════════
   INSTANT PLAY ENGINE (Zero-wait playback)
   1. Provider host preconnect (DNS + TLS handshake pehle se ready)
   2. Hidden prewarm iframe — stream background me resolve ho jata hai
      jab user description/servers dekh raha hota hai
   3. Play dabate hi wahi ready frame reveal hota hai (naya load nahi)
   ══════════════════════════════════════════════════════════════ */
/*  Every provider origin the player can actually navigate to, derived from
 *  playerSources instead of written out by hand.
 *
 *  The hand-written list had drifted badly and silently: it still warmed
 *  vidrock.ru and embed.smashystream.com (the latter is a commented-out source)
 *  while three live servers — vidfast.pro, flicky.host and 111movies.com — were
 *  never warmed at all. A user switching to one of those paid a full DNS + TCP +
 *  TLS handshake at the exact moment they wanted video. Deriving the list means
 *  adding or replacing a server warms the right host automatically.
 *
 *  The URL builders read currentModalMovie for anime detection; with no modal
 *  open they take the plain movie branch, which is the origin we want. Each call
 *  is guarded because a builder for a server that needs an AniList id may throw.
 */
const ANILIST_HOST = 'https://graphql.anilist.co';
let _mzPlayerOrigins = null;

function playerHostOrigins() {
  if (_mzPlayerOrigins) return _mzPlayerOrigins;
  const origins = [];
  playerSources.forEach((source) => {
    try {
      const url = source.url(550, 'en', 'movie', '1', '1');
      const origin = new URL(url).origin;
      if (origins.indexOf(origin) === -1) origins.push(origin);
    } catch (e) { /* a builder that cannot run without a modal is simply skipped */ }
  });
  origins.push(ANILIST_HOST);
  _mzPlayerOrigins = origins;
  return origins;
}

const _mzPreconnected = new Set();
let _mzPrewarm = null;

function preconnectHost(origin) {
  if (!origin || _mzPreconnected.has(origin)) return;
  _mzPreconnected.add(origin);
  try {
    const pc = document.createElement('link');
    pc.rel = 'preconnect'; pc.href = origin; pc.crossOrigin = 'anonymous';
    document.head.appendChild(pc);
    const dp = document.createElement('link');
    dp.rel = 'dns-prefetch'; dp.href = origin;
    document.head.appendChild(dp);
  } catch (e) {}
}

function preconnectPlayerHosts(limit) {
  playerHostOrigins().slice(0, limit || 4).forEach(preconnectHost);
}

/*  Warm the handshakes for the servers this user would ACTUALLY fall back to.
 *
 *  preconnectPlayerHosts() warms a slice of a hardcoded list, which has no
 *  relationship to the retry chain — it could warm three hosts none of which
 *  are ever used while the real fallback stays cold. This walks the same
 *  ranked, dub/anime-filtered pool that autoRetryNextServer() picks from, so
 *  if the first choice does fail the next attempt starts on an open connection
 *  instead of a fresh DNS lookup.
 *
 *  Only the TLS handshake is warmed here, not the embed document — prefetching
 *  several provider pages that will probably go unused is bandwidth a phone
 *  cannot spare.
 */
function warmRankedFallbacks(id, type, lang, count) {
  try {
    const pool = candidateSourceIdxs(lang, currentModalMovie);
    rankSourceIdxs(pool).slice(0, (count || 2) + 1).forEach((idx) => {
      const u = buildPlayerUrl(id, type, idx, lang);
      if (!u) return;
      try { preconnectHost(new URL(u).origin); } catch (e) {}
    });
  } catch (e) {}
}

function isDataSaver() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return ['slow-2g', '2g'].indexOf(c.effectiveType) !== -1;
}

/** Anime-aware server index (playMovie ka same logic, reuse ke liye) */
function effectiveSourceIdx() {
  let idx = getSelectedSourceIdx();
  const m = currentModalMovie;
  if (m && (isAnimeContent(m) || isCartoonContent(m)) && playerSources[idx] && !playerSources[idx].anime) {
    const animeIdx = playerSources.findIndex(sr => sr.anime);
    if (animeIdx !== -1) idx = animeIdx;
  }
  return idx;
}

function currentEpisodeSelection() {
  const sInput = document.getElementById('seasonInput');
  const eInput = document.getElementById('episodeInput');
  return {
    s: (sInput && sInput.value) ? sInput.value : '1',
    e: (eInput && eInput.value) ? eInput.value : '1'
  };
}

/*  ── RESUME OFFSET ─────────────────────────────────────────────────────────
 *
 *  Seconds to start playback at for a given title, read straight out of the
 *  Continue Watching entry. Zero when there is nothing worth resuming.
 *
 *  This exists as ONE function on purpose. loadPlayer() and prewarmPlayer() both
 *  build their URL through the same source builders, and takePrewarmedFrame()
 *  decides whether a prewarmed iframe is reusable by comparing the two URLs as
 *  STRINGS (`st.realUrl !== src`). If the offset were computed independently in
 *  each path, a one-second drift between them would silently disable prewarming
 *  and nobody would notice — the player would just get slower.
 *
 *  Only `positionSec` is used, never `watchedSec`. They are different things: for a
 *  provider that reports its playhead, positionSec is where the viewer actually is;
 *  watchedSec is how long the tab was open and focused, which is a fine progress
 *  estimate but a bad place to jump to. So a title only resumes when the position
 *  is genuinely known.
 *
 *  TV resumes per episode, because a season-2 episode-3 position is meaningless in
 *  season 1 episode 1.
 */
function mzResumeSec(id, type, s, e) {
  try {
    const list = JSON.parse(localStorage.getItem('mz_continue_watching')) || [];
    const key = (type === 'tv') ? (Number(id) + ':' + s + ':' + e) : String(Number(id));
    const entry = list.find(item => item && String(item.key || item.id) === key);
    const at = entry && Number(entry.positionSec);
    // Under half a minute is not a resume, it is a restart.
    return (Number.isFinite(at) && at > 30) ? Math.floor(at) : 0;
  } catch (err) { return 0; }
}

function buildPlayerUrl(id, type, srcIdx, lang) {
  const sel = currentEpisodeSelection();
  try {
    return playerSources[srcIdx].url(id, lang || getSelectedLang(), type, sel.s, sel.e);
  } catch (e) { return null; }
}

function destroyPrewarm() {
  if (_mzPrewarm && _mzPrewarm.iframe && _mzPrewarm.iframe.parentNode) {
    try { _mzPrewarm.iframe.src = 'about:blank'; } catch (e) {}
    try { _mzPrewarm.iframe.parentNode.removeChild(_mzPrewarm.iframe); } catch (e) {}
  }
  _mzPrewarm = null;
}

const _mzWarmedDocs = new Set();

/*  A warm-up that cannot reach the host at all is the earliest possible signal
 *  that this server is dead for THIS user — and it arrives while they are still
 *  reading the description, not after they pressed play and watched a spinner.
 *  Live probe from one Indian connection: nine of the ten servers answered in
 *  232-928ms, one did not answer within twelve seconds. Feeding that into the
 *  same ranking the real playback attempts feed means the next pick avoids it.
 *
 *  Only network-level failures count. A no-cors fetch resolves for opaque
 *  responses, including 403 and 404, so a rejection here means DNS, TLS, a
 *  refused connection or the timeout below — never "the provider answered
 *  something we cannot read".
 */
const MZ_WARM_TIMEOUT_MS = 8000;

/**
 * Warms the network path for an embed URL:
 *   1. preconnect  -> DNS + TCP + TLS handshake done before the click
 *   2. no-cors GET -> provider HTML lands in the HTTP cache
 * No iframe and no media element is created here, so the provider cannot start
 * video in a hidden frame (that is what produced the background-autoplay abort).
 */
function warmEmbedUrl(url, sourceName) {
  if (!url) return;
  try { preconnectHost(new URL(url).origin); } catch (e) {}
  if (isDataSaver() || _mzWarmedDocs.has(url)) return;
  _mzWarmedDocs.add(url);
  try {
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => { try { controller.abort(); } catch (e) {} }, MZ_WARM_TIMEOUT_MS)
      : null;
    const options = {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'force-cache',
      referrerPolicy: 'no-referrer'
    };
    if (controller) options.signal = controller.signal;
    fetch(url, options)
      .then(() => { if (timer) clearTimeout(timer); })
      .catch(() => {
        if (timer) clearTimeout(timer);
        /*  Let the ranking learn from it. The URL is dropped from the warmed set
         *  so a later attempt (better network, provider back up) can try again. */
        _mzWarmedDocs.delete(url);
        if (sourceName && typeof recordPlayerFailure === 'function') {
          try { recordPlayerFailure(sourceName); } catch (e) {}
        }
      });
  } catch (e) {}
}

function warmPlayerConnection(id, type) {
  if (!id) return;
  const idx = effectiveSourceIdx();
  warmEmbedUrl(buildPlayerUrl(id, type, idx), playerSources[idx] && playerSources[idx].name);
}

/**
 * Warm the selected provider connection without creating a browsing context.
 * The real iframe is created only by loadPlayer(), following an explicit play.
 */
function warmUrlVariant(url) {
  // Autoplay params ko warmup ke liye off kar do (param ka exact casing preserve).
  return url.replace(/([?&])(autoplay|autoPlay|autoplayNextEpisode|autoplaynextepisode)=true/g,
    (m, sep, key) => sep + key + '=false');
}

/**
 * INSTANT PLAY: modal khulne par provider ko ek hidden frame me load kar deta hai,
 * lekin autoplay OFF ke saath ? isliye Chrome ka "background media paused to save
 * power" abort nahi aata. Play dabane par usi frame ko real stream URL par navigate
 * kiya jata hai: DNS/TLS, provider JS/CSS sab cached hote hain, to playback jaldi shuru.
 */
function prewarmPlayer(id, type, srcIdxOverride) {
  if (!id || isDataSaver() || document.getElementById('playerFrame')) return;
  const embedEl = document.getElementById('videoEmbed');
  if (!embedEl) return;
  const idx = (typeof srcIdxOverride === 'number') ? srcIdxOverride : effectiveSourceIdx();
  const realUrl = buildPlayerUrl(id, type, idx);
  if (!realUrl) return;
  warmEmbedUrl(realUrl, playerSources[idx] && playerSources[idx].name);
  if (_mzPrewarm && _mzPrewarm.realUrl === realUrl && _mzPrewarm.iframe && _mzPrewarm.iframe.parentNode) return;

  destroyPrewarm();
  const frame = document.createElement('iframe');
  frame.className = 'mz-prewarm-frame';
  frame.id = 'mzPrewarmFrame';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('title', 'Preparing stream');
  frame.setAttribute('frameborder', '0');
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', 'encrypted-media'); // autoplay delegate NAHI
  frame.setAttribute('loading', 'eager');
  frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0.001;pointer-events:none;z-index:0;';

  const state = { realUrl: realUrl, iframe: frame, loaded: false, srcIdx: idx, id: id, type: type, startedAt: Date.now() };
  frame.addEventListener('load', () => { state.loaded = true; });
  try {
    if (getComputedStyle(embedEl).position === 'static') embedEl.style.position = 'relative';
  } catch (e) {}
  embedEl.appendChild(frame);
  frame.src = warmUrlVariant(realUrl);
  _mzPrewarm = state;
}

/** Prewarmed frame ko claim karta hai agar wahi stream URL match kare */
function takePrewarmedFrame(embedEl, src) {
  const st = _mzPrewarm;
  if (!st || !src || st.realUrl !== src) return null;
  if (!st.iframe || st.iframe.parentNode !== embedEl) return null;
  _mzPrewarm = null;
  return st;
}

/** Modal khulte hi (ya Play button hover par) playback ready karna */
function schedulePlayerPrewarm(id, type, delay) {
  if (window._mzPrewarmTimer) clearTimeout(window._mzPrewarmTimer);
  window._mzPrewarmTimer = setTimeout(() => prewarmPlayer(id, type), typeof delay === 'number' ? delay : 120);
}

function loadPlayer(id, srcIdx, lang, quality, type = 'movie') {
  // Stop trailer instantly when movie starts playing
  if (activeTrailerStopper) activeTrailerStopper();

  const embedEl = document.getElementById('videoEmbed');
  if (!embedEl) return;
  
  currentSourceIdx = srcIdx;
  setSelectedSourceIdx(srcIdx);
  lang = lang || getSelectedLang();
  setSelectedLang(lang);
  quality = quality || getSelectedQuality();
  setSelectedQuality(quality);
  
  // -- SMART SERVER SELECTION: Hindi/Regional = auto-pick best dubbed server --
  const DUBBED_LANG_LIST = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'];
  if (DUBBED_LANG_LIST.includes(lang) && playerSources[srcIdx] && !playerSources[srcIdx].dubbed) {
    // User ne Hindi/Regional select kiya but non-dubbed server pe hai - auto switch to best dubbed server
    const bestDubIdx = playerSources.findIndex(s => s.dubbed === true);
    if (bestDubIdx !== -1 && bestDubIdx !== srcIdx) {
      srcIdx = bestDubIdx;
      currentSourceIdx = srcIdx;
      setSelectedSourceIdx(srcIdx);
      showToast(` Auto-switched to ${playerSources[srcIdx].name} for best Hindi Dub`);
    }
  }
  
  const sInput = document.getElementById('seasonInput');
  const eInput = document.getElementById('episodeInput');
  const s = sInput ? sInput.value : '1';
  const e = eInput ? eInput.value : '1';
  const src = playerSources[srcIdx].url(id, lang, type, s, e);

  // Anime/Cartoon servers: AniList ID background me resolve karo aur milte hi
  // player ko asli anime stream (Hindi dub / dub / sub) par upgrade kar do
  if (playerSources[srcIdx] && playerSources[srcIdx].anime && isAnimeContent(currentModalMovie)) {
    ensureAnilistThenReload(currentModalMovie, s, srcIdx, lang, quality, type);
  }
 
  // AUTO-SAVE TV PROGRESS (Continue Watching)
  if (type === 'tv') {
    localStorage.setItem('mz_progress_' + id, JSON.stringify({ season: parseInt(s), episode: parseInt(e) }));
  }

  // ── INSTANT PLAY: agar yahi stream pehle se prewarm ho chuki hai to
  //    naya load karne ki zarurat nahi — sirf usi ready frame ko reveal karo
  const preState = takePrewarmedFrame(embedEl, src);
  const reusable = preState ? preState.iframe : null;
  // Warm frame ko real (autoplay) URL par navigate karna padta hai, to loader dikhega.
  const preAlreadyLoaded = false;

  if (reusable) {
    // Placeholder/loader hatao, prewarm frame ko waise hi rehne do (reparent = reload)
    Array.prototype.slice.call(embedEl.childNodes).forEach(n => { if (n !== reusable) embedEl.removeChild(n); });
  } else {
    destroyPrewarm();
    // Clear previous player instantly to prevent background audio/lag
    embedEl.innerHTML = '';
  }
  
  // Cancel any running auto-retry timer
  if (window._mzRetryTimer) { clearTimeout(window._mzRetryTimer); window._mzRetryTimer = null; }
 
  // Add Optimized Loading Spinner with server info
  const isDubServer = playerSources[srcIdx].dubbed;
  let loader = null;
  if (!preAlreadyLoaded) {
    loader = document.createElement('div');
    loader.className = 'player-loader';
    loader.id = 'mzPlayerLoader';
    loader.innerHTML = `
      <div class="player-spinner"></div>
      <div style="color:var(--gold); margin-top:15px; font-weight:600; font-size:0.9rem;">
        ${reusable ? 'Almost ready...' : (isDubServer ? 'Loading Hindi Dubbed Stream...' : 'Loading Stream...')}
      </div>
      <div style="color:rgba(255,255,255,0.4); margin-top:6px; font-size:0.75rem;">
        Server: ${escapeHTML(playerSources[srcIdx].name)} ${isDubServer ? '• Dubbed ?' : ''}
      </div>
    `;
    embedEl.appendChild(loader);
  }
 
  const iframe = reusable || document.createElement('iframe');
  iframe.id = 'playerFrame';
  iframe.style.cssText = 'width: 100%; height: 100%; border: none; background: transparent; position: relative; z-index: 1; transform: translateZ(0);';
  iframe.style.opacity = '1';
  iframe.style.pointerEvents = 'auto';
  iframe.className = '';
  iframe.removeAttribute('aria-hidden');
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
  /*  Console warning fix: "Allow attribute will take precedence over
   *  'allowfullscreen'". Jab `allow` present hota hai to browser legacy
   *  `allowfullscreen` ko ignore kar deta hai aur warn karta hai. Legacy
   *  attributes sirf un purane browsers ke liye chahiye (kuch Smart TV
   *  browsers) jo `allow` support nahi karte — isliye ab conditional. */
  if (!('allow' in HTMLIFrameElement.prototype)) {
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('webkitallowfullscreen', '');
  }
  iframe.setAttribute('title', 'MovieZone video player');
  iframe.setAttribute('tabindex', '0');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('fetchpriority', 'high');
  iframe.setAttribute('loading', 'eager');
  if (!reusable) embedEl.appendChild(iframe);
  // Same element par navigate: connection + provider assets already warm.
  iframe.src = src;

  // -- AUTO-RETRY SYSTEM: If server doesn't load in time, try next dubbed server --
  let hasLoaded = preAlreadyLoaded;
  const _mzSrcName = playerSources[srcIdx].name;
  const _mzStartedAt = Date.now();
  _mzTriedSources.add(_mzSrcName);

  iframe.onload = () => {
    hasLoaded = true;
    // Feeds the ranking: this is how the player learns which providers are
    // actually fast on this user's network.
    recordPlayerLoad(_mzSrcName, Date.now() - _mzStartedAt);
    if (loader && loader.parentNode) { 
      loader.style.opacity = '0';
      setTimeout(() => { if (loader && loader.parentNode) loader.remove(); }, 400);
    }
  };
  
  iframe.onerror = () => {
    // Server refused connection - auto try next
    recordPlayerFailure(_mzSrcName);
    autoRetryNextServer(id, srcIdx, lang, quality, type);
  };

  // Prewarm frame pehle hi load ho chuka tha — loader hi mat dikhao
  if (preAlreadyLoaded && loader && loader.parentNode) loader.remove();

  // Timeout-based auto-retry. The wait now follows this server's own measured
  // history instead of a flat 5 s, so a provider that normally answers in
  // ~1.2 s is abandoned in ~2.6 s rather than holding the user for five.
  if (!hasLoaded) {
    const base = adaptivePlayerTimeout(_mzSrcName);
    const retryAfter = Math.max(MZ_PH_MIN_TIMEOUT, reusable ? base - 800 : base);
    window._mzRetryTimer = setTimeout(() => {
      if (!hasLoaded) {
        recordPlayerFailure(_mzSrcName);
        const loaderEl = document.getElementById('mzPlayerLoader');
        if (loaderEl) {
          loaderEl.innerHTML = `
            <div style="color:#e63946; font-size:0.9rem; font-weight:600;"> Server slow/blocked</div>
            <div style="color:rgba(255,255,255,0.5); margin-top:6px; font-size:0.78rem;">Auto-trying next dubbed server...</div>
            <div class="player-spinner" style="width:28px; height:28px; border-width:2px; margin-top:10px;"></div>
          `;
        }
        setTimeout(() => autoRetryNextServer(id, srcIdx, lang, quality, type), 400);
      }
    }, retryAfter);
  }

  // Optimistic UI: Start fading loader after 1.5s for perceived speed
  setTimeout(() => {
    if (hasLoaded && loader && loader.parentNode) {
        loader.style.opacity = '0';
        setTimeout(() => { if (loader && loader.parentNode) loader.remove(); }, 400);
    }
  }, 1500);
 
  // Render Player Controls with "Try All Servers" button
  let controlsHtml = '<div id="playerControls" class="player-controls">';
  if (type === 'tv') {
    controlsHtml += '<button onclick="playNextEpisode()" class="player-chip premium-play-btn" style="padding:0 14px; border-radius:999px; min-height:42px; border:none; display:inline-flex; align-items:center; gap:6px;">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>' +
        '<span style="font-size:13px; font-weight:800;">Next Ep</span></button>';
  }
  // TRY ALL SERVERS BUTTON (Dubbed)
  controlsHtml += '<button onclick="tryAllDubbedServers()" class="player-chip" id="tryAllBtn" style="background:linear-gradient(135deg, rgba(245,197,24,0.15), rgba(230,57,70,0.1)); border:1px solid rgba(245,197,24,0.3); color:var(--gold);" title="Automatically cycle through all dubbed servers to find working Hindi audio">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>' +
      '<span style="font-size:12px; font-weight:700;">Try All Dubbed Servers</span></button>';
  controlsHtml += '<button onclick="togglePlayerFS()" class="player-chip player-chip--fs" id="fsBtn">' +
        '<svg class="player-chip__icon" viewBox="0 0 24 24"><path d="M7 3H3v4h2V5h2V3zm10 0v2h2v2h2V3h-4zM5 17H3v4h4v-2H5v-2zm16 0h-2v2h-2v2h4v-4z"></path></svg>' +
        '<span>Fullscreen</span></button></div>';
 
  const existingControls = document.getElementById('playerControls');
  if (existingControls) existingControls.outerHTML = controlsHtml;
  else embedEl.insertAdjacentHTML('afterend', controlsHtml);
 
  try { renderExternalSources(id, srcIdx, lang); } catch(e){}
 
  const _toastLangName = (LANG_CONFIG[lang] && LANG_CONFIG[lang].name) || lang.toUpperCase();
  const _dubbedStatus = isDubServer ? 'Dubbed' : 'Original';
  showToast('' + buildSourceLabel(srcIdx) + ' |  ' + _toastLangName + ' | ' + _dubbedStatus + (type === 'tv' ? ` | S${s} E${e}` : ''));
 
  // Smooth scroll to video player
  setTimeout(() => embedEl.scrollIntoView({ behavior: isMzTVMode() ? 'auto' : 'smooth', block: 'center' }), 300);
  
}

function autoRetryNextServer(id, currentIdx, lang, quality, type) {
  /*  Retry order is measured, not positional.
   *
   *  This used to scan forward from currentIdx and take the next index that
   *  matched the dub/anime rule, so the fallback chain was simply whatever
   *  order the array happened to be in. A user whose first three providers are
   *  regionally blocked walked all three on every single play, paying the full
   *  timeout each time, and learned nothing for next time.
   *
   *  The eligible pool now gets ordered by the same learned cost the initial
   *  pick uses, and anything already attempted during THIS play is skipped so
   *  the chain cannot loop back onto a server that just failed.
   */
  const pool = candidateSourceIdxs(lang, currentModalMovie)
    .filter(i => i !== currentIdx && !_mzTriedSources.has(playerSources[i].name));

  let nextIdx = -1;
  const ranked = rankSourceIdxs(pool);
  if (ranked.length) {
    nextIdx = ranked[0];
  } else {
    // Every eligible server has been tried for this title. Start exploration
    // over on the best of the full list so the user still gets a player
    // instead of a dead end.
    resetTriedSources();
    const wide = rankSourceIdxs(playerSources.map((_, i) => i).filter(i => i !== currentIdx));
    if (wide.length) nextIdx = wide[0];
  }
  
  if (nextIdx !== -1 && nextIdx !== currentIdx) {
    showToast(` Server failed. Trying ${playerSources[nextIdx].name}...`);
    loadPlayer(id, nextIdx, lang, quality, type);
    // Update active state on server buttons
    document.querySelectorAll('.player-chip--source').forEach((b, i) => b.classList.toggle('active', i === nextIdx));
  } else {
    showToast('All servers tried. Please try again later or change language.');
  }
}

// -- TRY ALL DUBBED SERVERS (One-click cycle through all dubbed servers) --
let _tryAllRunning = false;
let _tryAllCancelled = false;

function tryAllDubbedServers() {
  if (!currentModalMovie) return;
  
  if (_tryAllRunning) {
    // Cancel if already running
    _tryAllCancelled = true;
    _tryAllRunning = false;
    const btn = document.getElementById('tryAllBtn');
    if (btn) btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg><span style="font-size:12px; font-weight:700;">Try All Dubbed Servers</span>';
    showToast('Server cycling stopped');
    return;
  }
  
  _tryAllRunning = true;
  _tryAllCancelled = false;
  
  const lang = getSelectedLang();
  const quality = getSelectedQuality();
  const type = currentModalMovie.media_type || 'movie';
  const id = currentModalMovie.id;
  
  // Get only dubbed servers
  const dubbedIndices = [];
  playerSources.forEach((s, i) => { if (s.dubbed) dubbedIndices.push(i); });
  
  if (dubbedIndices.length === 0) {
    showToast('No dubbed servers available');
    _tryAllRunning = false;
    return;
  }
  
  const btn = document.getElementById('tryAllBtn');
  let currentTryIdx = 0;
  
  function tryNext() {
    if (_tryAllCancelled || currentTryIdx >= dubbedIndices.length) {
      _tryAllRunning = false;
      if (btn) btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg><span style="font-size:12px; font-weight:700;">Try All Dubbed Servers</span>';
      if (!_tryAllCancelled) showToast('All dubbed servers tested! Keep the one that works best.');
      return;
    }
    
    const serverIdx = dubbedIndices[currentTryIdx];
    const serverName = playerSources[serverIdx].name;
    
    if (btn) btn.innerHTML = `<div class="player-spinner" style="width:14px;height:14px;border-width:2px;border-color:rgba(245,197,24,0.2);border-left-color:var(--gold);"></div><span style="font-size:12px;font-weight:700;">Testing ${currentTryIdx + 1}/${dubbedIndices.length}... (Click to Stop)</span>`;
    
    showToast(` Testing server ${currentTryIdx + 1}/${dubbedIndices.length}: ${serverName}`);
    loadPlayer(id, serverIdx, lang, quality, type);
    
    // Update active button
    document.querySelectorAll('.player-chip--source').forEach((b, i) => b.classList.toggle('active', i === serverIdx));
    
    currentTryIdx++;
    
    // Give 8 seconds per server before trying next
    window._mzTryAllTimer = setTimeout(tryNext, 8000);
  }
  
  // Clear any existing retry timer
  if (window._mzRetryTimer) { clearTimeout(window._mzRetryTimer); window._mzRetryTimer = null; }
  if (window._mzTryAllTimer) { clearTimeout(window._mzTryAllTimer); window._mzTryAllTimer = null; }
  
  tryNext();
}
 
 
async function downloadMovie() {
  if (!currentModalMovie) return;
  const id = currentModalMovie.id;
  const isSeries = currentModalMovie.media_type === 'tv';

  // VidVault (VidRock ka official download server) — instant, koi API wait nahi
  let downloadUrl;
  if (isSeries) {
    const sel = currentEpisodeSelection();
    downloadUrl = `https://vidvault.ru/tv/${id}/${sel.s}/${sel.e}`;
  } else {
    downloadUrl = `https://vidvault.ru/movie/${id}`;
  }

  // Naya tab turant kholo (user click ke andar, popup blocker se bachne ke liye)
  window.open(downloadUrl, '_blank', 'noopener');
}
 
function togglePlayerFS() {
  const embedEl = document.getElementById('videoEmbed');
  const btn = document.getElementById('fsBtn');
  if (!embedEl) return;

  const activateCSSFullscreen = () => {
    isPlayerFullscreen = true;
    embedEl.classList.add('fullscreen-mode');
    if (btn) btn.textContent = 'Exit';
    document.addEventListener('keydown', exitFSOnEsc);
  };
 
  if (!document.fullscreenElement && !document.webkitFullscreenElement && !isPlayerFullscreen) {
    const target = embedEl;
    try {
      let fsResult = null;
      if (target.requestFullscreen) fsResult = target.requestFullscreen();
      else if (target.webkitRequestFullscreen) fsResult = target.webkitRequestFullscreen();
      else {
        activateCSSFullscreen();
        return;
      }
      
      Promise.resolve(fsResult).then(() => {
        if (screen.orientation && screen.orientation.lock) {
          return screen.orientation.lock('landscape').catch(() => {});
        }
      }).catch(activateCSSFullscreen);
    } catch (err) {
      activateCSSFullscreen();
    }
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    
    isPlayerFullscreen = false;
    embedEl.classList.remove('fullscreen-mode');
    if (btn) btn.textContent = 'Full';
    document.removeEventListener('keydown', exitFSOnEsc);
  }
}
 
const handleFullscreenChange = () => {
  const isFS = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
  if (!isFS) {
    // Jab fullscreen se bahar aaye, to rotation lock hata do
    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch(e){}
    }
  } else {
    // Jab bhi fullscreen mode me jaye, automatically Landscape me ghuma do (Mobile ke liye)
    if (screen.orientation && screen.orientation.lock) {
      try { screen.orientation.lock('landscape').catch(() => {}); } catch(e){}
    }
  }
};
 
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('mozfullscreenchange', handleFullscreenChange);
document.addEventListener('MSFullscreenChange', handleFullscreenChange);
 
// Direct #watch URLs are never auto-opened. Startup and BFCache/session restoration
// are sanitized by resetRestoredWatchSurface() before interaction.
 
function exitFSOnEsc(e) {
  if (e.key === 'Escape') togglePlayerFS();
}
 
const modalOverlay = document.getElementById('modal-overlay');
if (modalOverlay) {
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });
}
 
document.addEventListener('DOMContentLoaded', () => {
  const langSel = document.getElementById('langSelect');
  if (langSel) langSel.addEventListener('change', (e) => {
    setSelectedLang(e.target.value);
    // Sync language quick-buttons
    document.querySelectorAll('.mz-lang-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-lang') === e.target.value);
    });
    // Reload player if iframe already playing
    if (currentModalMovie) {
      const embedEl = document.getElementById('videoEmbed');
      if (embedEl && embedEl.querySelector('iframe')) {
        loadPlayer(currentModalMovie.id, currentSourceIdx, e.target.value, getSelectedQuality(), currentModalMovie.media_type);
      }
    }
  });
  const qualSel = document.getElementById('qualitySelect');
  if (qualSel) qualSel.addEventListener('change', (e) => { setSelectedQuality(e.target.value); });
  
  // Make HTML static category tabs focusable for TV
  document.querySelectorAll('.cat-tab').forEach(t => { t.tabIndex = 0; });
  
  /*  A leftover `tvTab.innerHTML = 'Web Series'` used to sit here, from when the
   *  markup said "TV Shows". index.html has said "Web Series" for a long time, so
   *  all the line did was rewrite the pill with its own label — and in doing so it
   *  destroyed the <span> wrapper that every tab label now needs (the ::before
   *  brand-gradient highlight paints over bare text; see `.cat-tab span` in
   *  moviezone.css). One pill in the strip lost its label on hover, and only that
   *  one, which is a genuinely confusing bug to look at. Renaming a tab belongs in
   *  the markup. */

  /*  Cartoons / Anime / 18+ / Hindi Dubbed used to be appended to the strip here at
   *  runtime. That injection is gone, and so are those pills: Cartoons (kids),
   *  Anime and 18+ (adult) were removed from the UI, Hindi Dubbed too — all four
   *  filters still work if filterCat() is called with them, they just have no tab.
   *  The genres moved into the "Category" dropdown.
   *
   *  What is left is a safety sweep: if the markup ever regresses and a category
   *  loses its button, say so instead of silently dropping the filter.
   *
   *  THE LIST BELOW USED TO BE ['kids', 'anime', 'adult', 'tv'] — three of which
   *  had been deliberately deleted from the strip, so this guard printed
   *  "Category tabs missing from markup: kids, anime, adult" into the console on
   *  every single page load. A warning that is always wrong is worse than no
   *  warning: it trains you to scroll past the one time it is right. (And it did
   *  fire for real once, on `tv`, and nobody noticed among the noise.)
   *
   *  It now names exactly what index.html is supposed to carry, which is also the
   *  contract cat-tabs.browser.test.html asserts — so the runtime guard and the
   *  test can no longer disagree about what "missing" means. */
  (function verifyCategoryTabs() {
    // The strip. The nine OTT platforms are deliberately absent: they are reached
    // from the Top Providers rail and have no .cat-tab of their own.
    const onStrip = ['all', 'trending', 'uhd4k', 'toprated', 'hollywood',
      'bollywood', 'tollywood', 'tv', 'kdrama'];
    // The "Category" dropdown.
    const inGenreMenu = ['action', 'comedy', 'horror', 'thriller', 'romance',
      'scifi', 'adventure', 'fantasy', 'crime', 'documentary', 'family',
      'animation'];
    const missing = onStrip.concat(inGenreMenu).filter(c =>
      !document.querySelector('.cat-tab[onclick*="filterCat(\'' + c + '\')"]'));
    if (missing.length) {
      console.warn('[MovieZone] Category tabs missing from markup:', missing.join(', '));
    }
  })();

  // Reflect the starting filter on the group triggers.
  if (typeof syncCatGroupTriggers === 'function') syncCatGroupTriggers();

  // Fluid Ripple Effect for buttons
  document.body.addEventListener('click', (e) => {
    // The dropdown triggers are excluded on purpose: a menu button should react
    // instantly, and the injected ripple span is a layout hazard inside a flex
    // button (see the specificity note next to .ripple-span in moviezone.css).
    const btn = e.target.closest('.btn-play, .btn-info, .btn-watchlist, .btn-download, .load-more-btn, .premium-play-btn, .cat-tab:not(.cat-group-trigger), .carousel-arrow, .nav-btn');
    if (btn && !isMzTV()) {
      btn.classList.add('ripple-wrapper');
      const circle = document.createElement('span');
      const diameter = Math.max(btn.clientWidth, btn.clientHeight);
      const radius = diameter / 2;
      const rect = btn.getBoundingClientRect();
      circle.style.width = circle.style.height = `${diameter}px`;
      circle.style.left = `${e.clientX - rect.left - radius}px`;
      circle.style.top = `${e.clientY - rect.top - radius}px`;
      circle.classList.add('ripple-span');
      const oldRipple = btn.querySelector('.ripple-span');
      if (oldRipple) oldRipple.remove();
      btn.appendChild(circle);
      setTimeout(() => { if (circle) circle.remove(); }, 600);
    }
  });
});
 
let _scrollTicking = false;
window.addEventListener('scroll', () => {
  if (_scrollTicking) return;
  _scrollTicking = true;
  requestAnimationFrame(() => {
    const nb = document.getElementById('navbar');
    if (nb) nb.classList.toggle('scrolled', window.scrollY > 60);
    _scrollTicking = false;
  });
}, { passive: true });

// ═══ PREMIUM MOBILE NAV PANEL ═══
// Creates a separate full-screen panel outside navbar to avoid backdrop-filter stacking issues
(function initMobileNav() {
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const mobileNavOverlay = document.getElementById('mobileNavOverlay');
  const navLinksOriginal = document.getElementById('navLinks');
  if (!hamburgerBtn || !navLinksOriginal) return;

  // Create premium mobile panel
  const panel = document.createElement('div');
  panel.id = 'mzMobilePanel';
  panel.innerHTML = `
    <div class="mz-mp-inner">
      <div class="mz-mp-header">
        <span class="mz-mp-brand">MOVIEZONE</span>
        <button class="mz-mp-close" aria-label="Close menu">&times;</button>
      </div>
      <nav class="mz-mp-links">
        ${Array.from(navLinksOriginal.querySelectorAll('a')).map((a, i) => 
          `<a href="${a.getAttribute('href') || '#'}" class="mz-mp-link${a.classList.contains('active') ? ' active' : ''}" data-idx="${i}"${a.closest('[data-tv-hide]') ? ' data-tv-hide' : ''} style="--i:${i}">${(a.dataset.label || a.textContent).trim()}</a>`
        ).join('')}
      </nav>
      <div class="mz-mp-footer">
        <span>Cinema Club</span>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  function openPanel() {
    panel.classList.add('open');
    hamburgerBtn.classList.add('open');
    if (mobileNavOverlay) mobileNavOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    hamburgerBtn.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    panel.classList.remove('open');
    hamburgerBtn.classList.remove('open');
    if (mobileNavOverlay) mobileNavOverlay.classList.remove('open');
    document.body.style.overflow = '';
    hamburgerBtn.setAttribute('aria-expanded', 'false');
  }

  hamburgerBtn.addEventListener('click', () => {
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });

  panel.querySelector('.mz-mp-close').addEventListener('click', closePanel);
  if (mobileNavOverlay) mobileNavOverlay.addEventListener('click', closePanel);

  // Escape closes it, same as every other overlay in the app.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
  });

  /* Viewport changes must not leave the menu in a broken state. The panel is
     display:none above the hamburger band, so a menu opened on a tablet and
     then resized/rotated to a desktop width would vanish while still holding
     document.body.style.overflow = 'hidden' — the page would silently refuse
     to scroll with no visible menu to close. Close it whenever the hamburger
     itself is no longer on screen. */
  let navResizeRaf = 0;
  const syncNavToViewport = () => {
    if (navResizeRaf) return;
    navResizeRaf = requestAnimationFrame(() => {
      navResizeRaf = 0;
      if (!panel.classList.contains('open')) return;
      const burgerHidden = getComputedStyle(hamburgerBtn).display === 'none' || !hamburgerBtn.offsetParent;
      if (burgerHidden) closePanel();
    });
  };
  window.addEventListener('resize', syncNavToViewport, { passive: true });
  window.addEventListener('orientationchange', syncNavToViewport, { passive: true });

  // Handle link clicks — trigger the original nav link actions
  panel.querySelectorAll('.mz-mp-link').forEach((link, idx) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      closePanel();
      const originalLinks = navLinksOriginal.querySelectorAll('a');
      if (originalLinks[idx]) originalLinks[idx].click();
      // Update active state
      panel.querySelectorAll('.mz-mp-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });
})();
 
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); }, 3000);
}
 
// TV REMOTE NAVIGATION moved to tv-mode.js (D-pad, Back, Page/Channel, Media keys).
// Expose detailActivationGuard and armTVDetailActivation globally for tv-mode.js integration.
window.detailActivationGuard = detailActivationGuard;
window.armTVDetailActivation = armTVDetailActivation;

// Register MovieZoneTV configure callbacks so tv-mode.js can read top-level let state
if (typeof window.MovieZoneTV !== 'undefined' && window.MovieZoneTV.configure) {
  window.MovieZoneTV.configure({
    isSearchResultsMode: function() { return isSearchResultsMode; },
    isFullViewMovies: function() { return isFullViewMovies; },
    isFullViewUpcoming: function() { return isFullViewUpcoming; },
    closeModal: function() { closeModal(); },
    closeDropdown: function() { closeDropdown(); },
    goHome: function() { goHome(); },
    closeUpcomingDetail: function() { closeUpcomingDetail(); },
    handleCollectionsBack: function() {
      if (typeof window.handleCollectionsBack === 'function') window.handleCollectionsBack();
    },
    isFullscreen: function() {
      return Boolean(document.fullscreenElement || document.webkitFullscreenElement || isPlayerFullscreen);
    },
    exitFullscreen: function() { togglePlayerFS(); }
  });
}
 
function goHome(e) {
  let isHash = false;
  if (e && e.type === 'click' && e.currentTarget) {
    const href = e.currentTarget.getAttribute('href');
    if (href && href.startsWith('#') && href !== '#') isHash = true;
    else e.preventDefault();
  }
  isFullViewMovies = false;
  isFullViewUpcoming = false;
  isSearchResultsMode = false;
  hideAnimeFilterBar();
  const scrollTrigger = document.getElementById('infiniteScrollTrigger');
  if (scrollTrigger) scrollTrigger.style.display = '';
  
  const hero = document.getElementById('hero');
  const moviesSec = document.getElementById('movies-section');
  const upcoming = document.getElementById('upcoming');
  const sep = document.querySelector('.section-sep');
  if (hero) hero.style.display = 'block';
  if (moviesSec) moviesSec.style.display = 'block';
  if (upcoming) upcoming.style.display = 'block';
  if (sep) sep.style.display = 'block';
  
  const h = document.getElementById('sectionHeading');
  if (isWatchlistMode) {
    // Stay on the watchlist and keep paging disabled for it.
    if (scrollTrigger) scrollTrigger.style.display = 'none';
    renderMovies(watchlist);
  } else {
    // Same reason as loadMoreMoviesAction: a platform feed has no .cat-tab to
    // read back, so the category comes from the loader's own state.
    loadMovies(currentFeedCategory());
  }
  loadUpcoming();
  
  const loadMoreBtnMovies = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtnMovies) loadMoreBtnMovies.style.display = 'none';
  const loadMoreBtnUpcoming = document.getElementById('loadMoreUpcomingBtn');
  if (loadMoreBtnUpcoming) loadMoreBtnUpcoming.style.display = 'none';
  
  if (!isHash) window.scrollTo({ top: 0, behavior: isMzTVMode() ? 'auto' : 'smooth' });
}
 

// -- ADVANCED SECURITY (Disabled for development) --


// -- AD-BLOCKER DETECTION --
(function detectAdBlocker() {
  const adSlot = document.createElement('div');
  adSlot.className = 'ad_slot'; // Class heavily targeted by adblockers
  adSlot.style.position = 'absolute';
  adSlot.style.top = '-9999px';
  adSlot.style.left = '-9999px';
  adSlot.style.height = '10px'; // Explicit height to verify against
  adSlot.style.width = '10px';
  document.body.appendChild(adSlot);

  // Short delay allows the ad-blocker's content script to process the DOM change
  setTimeout(() => {
    if (adSlot.offsetHeight === 0) {
      console.warn('Ad Blocker detected!');
      window.dispatchEvent(new CustomEvent('adblocker-detected'));
    }
    adSlot.remove(); // Clean up
  }, 300);
})();


// -- TOP KEYWORDS EXTRACTOR --
function extractTopKeywords() {
  // Clone the body so we don't accidentally modify the actual visible DOM
  const clone = document.body.cloneNode(true);
  
  // Filter out scripts, styles, and other non-text elements
  const elementsToRemove = clone.querySelectorAll('script, style, noscript, svg');
  elementsToRemove.forEach(el => el.remove());

  const text = clone.textContent || '';
  
  // Extract words (only alphabetical, minimum 3 characters long to filter out small noise)
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  
  // Common stop words to ignore to get actual keywords
  const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'not', 'are', 'from', 'your', 'all', 'have', 'was', 'but', 'out', 'has', 'can', 'will', 'now']);
  
  const wordCounts = {};
  words.forEach(word => {
    if (!stopWords.has(word)) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
  });

  // Sort frequencies and get the top 3
  const top3 = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(entry => ({ word: entry[0], count: entry[1] }));

  console.log('Top 3 Keywords on this page:', top3);
  return top3;
}

// Run it only when the main thread is idle, after movies have finished loading
scheduleIdleWork([extractTopKeywords], 5000);

// -- BOT DETECTION (WebGL Renderer Check) --
(function detectBot() {
  // Idle-only: creating a WebGL context is a real GPU/CPU cost and nothing here
  // is on the user's critical path.
  scheduleIdleWork([() => {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) {
        // WebGL is not supported or disabled.
        return;
      }

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL).toLowerCase();

        /*  This used to call console.error('Potential Bot/Headless Browser
         *  Detected!'), and that was the whole of its effect. Two things were
         *  wrong with it:
         *
         *  1. It blocked nothing. Nothing in the codebase listens for the
         *     'bot-detected' event, so the "detection" had no consequence beyond
         *     the log line. It was not gating access, and never has been.
         *  2. swiftshader / mesa / llvmpipe are SOFTWARE RENDERERS, and plenty of
         *     real people browse with one: virtual machines, remote desktop
         *     sessions, Linux without accelerated drivers, and any machine where
         *     Chrome has blocklisted the GPU driver. Calling those visitors bots
         *     was wrong on its own terms.
         *
         *  Since Datadog RUM collects console.error, the only thing this block
         *  actually did was file a steady stream of unactionable "errors" against
         *  real users — and against every headless run of this repo's own test
         *  suite.
         *
         *  It is now a debug log. The signal is still emitted for anyone who wants
         *  to build on it, renamed to describe what it really detected: a software
         *  renderer, which is a rendering-performance hint, not an identity claim.
         *  Skipped entirely on localhost so the test suites stay quiet.
         */
        const softwareRenderers = ['swiftshader', 'mesa', 'llvmpipe', 'headless'];
        if (!isLocalhost && softwareRenderers.some(indicator => renderer.includes(indicator))) {
          console.debug('[MovieZone] software WebGL renderer detected; GPU effects may be slow.',
            { vendor, renderer });
          window.dispatchEvent(new CustomEvent('mz:software-renderer', { detail: { vendor, renderer } }));
        }
      }
    } catch (e) { /* Silently fail if canvas/webgl is blocked or fails */ }
  }]);
})();

// -- MEMORY & CRASH PREVENTION SYSTEM --
// Prevents lag/crash on TV, old phones, and low-RAM devices
(function memoryGuard() {
  // 1. Limit maximum cards in DOM (recycle old ones)
  const MAX_CARDS_MOBILE = 30;
  const MAX_CARDS_TV = 24;
  const MAX_CARDS_DESKTOP = 80;
  
  const getMaxCards = () => {
    if (isMzTVMode()) return MAX_CARDS_TV;
    if (isMobile || isLowEnd) return MAX_CARDS_MOBILE;
    return MAX_CARDS_DESKTOP;
  };
  
  // 2. Periodic garbage collection hint
  setInterval(() => {
    // Clean up old tmdb memory cache (keep only last 50 entries)
    if (tmdbCache.size > 50) {
      const entries = Array.from(tmdbCache.entries());
      entries.slice(0, entries.length - 50).forEach(([key]) => tmdbCache.delete(key));
    }
    // Clean up old localStorage cache (keep only last 30)
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('mz_cache_'));
      if (keys.length > 30) {
        keys.slice(0, keys.length - 30).forEach(k => localStorage.removeItem(k));
      }
    } catch(e) {}
  }, 60000); // Every 60 seconds
  
  // 3. Reduce image quality on low memory warning
  if ('memory' in performance) {
    setInterval(() => {
      const mem = performance.memory;
      if (mem.usedJSHeapSize > mem.jsHeapSizeLimit * 0.85) {
        // Memory critical - disable heavy features
        document.documentElement.classList.add('low-end-mode');
      }
    }, 10000);
  }
  
  // 4. Sample startup responsiveness, then stop to avoid a permanent per-frame task.
  let lastFrameTime = performance.now();
  let lowFPSCount = 0;
  let performanceSamples = 0;
  const MAX_PERFORMANCE_SAMPLES = 300;

  function checkPerformance() {
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;
    performanceSamples++;

    // If four startup frames take >100ms, reduce effects without changing identity.
    if (delta > 100) {
      lowFPSCount++;
      if (lowFPSCount > 3 && !document.documentElement.classList.contains('low-end-mode')) {
        document.documentElement.classList.add('low-end-mode');
        return;
      }
    } else {
      lowFPSCount = Math.max(0, lowFPSCount - 1);
    }
    if (performanceSamples < MAX_PERFORMANCE_SAMPLES) requestAnimationFrame(checkPerformance);
  }

  // TV/mobile/forced-TV modes are already optimized; do not spend frames measuring them.
  if (!isMzTVMode() && !document.documentElement.classList.contains('low-end-mode')) {
    requestAnimationFrame(checkPerformance);
  }
})();

init();


// ═══ CONTINUE WATCHING SYSTEM ═══
(function initContinueWatching() {
  const CW_KEY = 'mz_continue_watching';
  const DONE_KEY = 'mz_watched_done';        // ids the user has finished — never re-shown
  const MAX_CW_ITEMS = 20;

  /*  What counts as "finished".
   *
   *  A cross-origin streaming iframe does not expose currentTime/duration, so the
   *  progress here is a VISIBLE-WATCH-TIME estimate: seconds the player was open
   *  and the tab focused, measured against the title's TMDB runtime. Real credits
   *  start a few minutes before the file ends, so 92% is treated as "done" — past
   *  that point the viewer is almost always in the credits and does not want the
   *  title offered back to them. */
  const COMPLETE_AT = 92;
  /*  Below this a session is treated as "did not really start" (a misclick, a
   *  server that never loaded). It is kept in the rail so the user can retry, but
   *  it is never promoted to "done". */
  const MIN_MEANINGFUL = 2;

  function getCWList() {
    try { return JSON.parse(localStorage.getItem(CW_KEY)) || []; }
    catch { return []; }
  }
  function saveCWList(list) {
    try { localStorage.setItem(CW_KEY, JSON.stringify(list.slice(0, MAX_CW_ITEMS))); }
    catch (e) { /* quota — nothing actionable */ }
  }

  function getDoneSet() {
    try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY)) || []); }
    catch { return new Set(); }
  }
  /*  Finished rows are remembered by the SAME key the rail uses, so finishing
   *  season 1 episode 1 hides only that episode and not the whole series. Legacy
   *  entries were bare numeric ids, so isDone still accepts those for movies. */
  function markDone(key) {
    const set = getDoneSet();
    set.add(String(key));
    // Cap the done-list so it cannot grow forever; keep the most recent 300.
    const arr = Array.from(set).slice(-300);
    try { localStorage.setItem(DONE_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function isDone(key) {
    const set = getDoneSet();
    return set.has(String(key)) || set.has(Number(key));
  }
  window.mzClearWatched = function (key) {
    // Lets a "watch again" flow resurrect a finished title.
    const set = getDoneSet();
    set.delete(String(key));
    set.delete(Number(key));
    try { localStorage.setItem(DONE_KEY, JSON.stringify(Array.from(set))); } catch (e) {}
  };

  /*  ── ACTIVE WATCH SESSION ──────────────────────────────────────────────
   *  Started by playMovie(), stopped by closeModal(). While it runs, watched
   *  seconds accumulate ONLY when the tab is visible, and progress is derived
   *  from that against the movie runtime. This is what replaces the old random
   *  percentage — the number now reflects how long the title was actually open. */
  let session = null;   // { id, title, backdrop, poster, media_type, vote_average,
                        //   runtimeSec, watchedSec, lastTick, timer }

  function nowSec() { return Date.now() / 1000; }

  function currentProgressPct() {
    if (!session || !session.runtimeSec) return 0;
    return Math.max(0, Math.min(100, Math.round((session.watchedSec / session.runtimeSec) * 100)));
  }

  // Fold whatever time elapsed since the last tick into watchedSec, but only if
  // the page was visible for it. Called on every tick and on visibility change.
  function accrue() {
    if (!session) return;
    const t = nowSec();
    /*  Both gates. visibilityState catches a hidden tab; hasFocus() catches a tab
     *  that is on screen but behind another window, which visibilityState reports
     *  as "visible" and which used to be counted as watching. Providers that report
     *  a real playhead make this moot — but nine of the ten do not. */
    const watching = document.visibilityState === 'visible'
      && (typeof document.hasFocus !== 'function' || document.hasFocus());
    if (watching) {
      const delta = t - session.lastTick;
      // Guard against a machine that slept: a 4h "tick" is not 4h of watching.
      if (delta > 0 && delta < 90) session.watchedSec += delta;
    }
    session.lastTick = t;
  }

  function persistSessionProgress() {
    if (!session) return;
    const pct = currentProgressPct();
    const key = entryKey(session, session.season, session.episode);
    if (pct >= COMPLETE_AT) {
      // Finished — drop this row from the rail and remember it so it never returns.
      markDone(key);
      const list = getCWList().filter(item => String(item.key || item.id) !== key);
      saveCWList(list);
      renderContinueWatching();
      stopWatchSession();   // nothing left to track
      return;
    }
    upsertEntry(mkEntry(session, null, pct, Math.round(session.watchedSec), Math.round(session.runtimeSec)));
    // Cheap live update of the on-screen bar without a full re-render.
    liveUpdateCard(key, pct);
  }

  /*  One entry shape, three call sites. `src` is either the running session or a
   *  TMDB movie object; `prior` (may be null) supplies resume fields when src is
   *  a bare movie. Collapsing the three literals into this saved the bulk of the
   *  feature's byte cost.
   *
   *  `key` identifies the ROW, and for a series it includes season and episode.
   *  Before this, upsertEntry matched on id alone, so starting S1E2 overwrote the
   *  S1E1 row and its progress — one series could only ever occupy one slot and
   *  the percentage jumped around as you moved through episodes.
   *
   *  `positionSec` and `watchedSec` are deliberately separate. watchedSec is how
   *  long the player was open and focused: a reasonable progress estimate, and a
   *  terrible place to seek to. positionSec is the real playhead, and it is only
   *  ever set from a provider that reports one (see onPlayerMessage). Resume reads
   *  positionSec, so a title never jumps to a fabricated timestamp. */
  function entryKey(src, s, e) {
    const type = src.media_type || (src.name && !src.title ? 'tv' : 'movie');
    if (type !== 'tv') return String(Number(src.id));
    return Number(src.id) + ':' + (s || src.season || 1) + ':' + (e || src.episode || 1);
  }

  function mkEntry(src, prior, pct, watchedSec, runtimeSec) {
    const type = src.media_type || (src.name && !src.title ? 'tv' : 'movie');
    const season = src.season || (prior && prior.season) || (type === 'tv' ? 1 : 0);
    const episode = src.episode || (prior && prior.episode) || (type === 'tv' ? 1 : 0);
    return {
      id: src.id,
      key: entryKey(src, season, episode),
      title: src.title || src.name || (prior && prior.title) || '',
      backdrop: src.backdrop || src.backdrop_path || (prior && prior.backdrop) || '',
      poster: src.poster || src.poster_path || (prior && prior.poster) || '',
      media_type: type,
      season: season,
      episode: episode,
      vote_average: src.vote_average || (prior && prior.vote_average) || 0,
      progress: pct,
      watchedSec: watchedSec || 0,
      runtimeSec: runtimeSec || 0,
      // Only present once a provider has reported a real playhead.
      positionSec: Number.isFinite(src.positionSec) ? Math.floor(src.positionSec)
        : (prior && Number.isFinite(prior.positionSec) ? prior.positionSec : 0),
      // True when `progress` came from the player rather than from the estimate.
      exact: !!(src.exact || (prior && prior.exact)),
      timestamp: Date.now()
    };
  }

  // Insert or move-to-front an entry, preserving resume fields. Matched on `key`,
  // so each episode of a series keeps its own row.
  function upsertEntry(entry) {
    const list = getCWList();
    const at = list.findIndex(item => String(item.key || item.id) === String(entry.key));
    if (at > -1) list.splice(at, 1);
    list.unshift(entry);
    saveCWList(list);
  }

  function onVisibility() { accrue(); persistSessionProgress(); }

  /*  ── TRUE PROGRESS, WHEN THE PLAYER PUBLISHES IT ───────────────────────────
   *
   *  The estimate above measures how long the player was open and focused. It is
   *  the best a parent page can do unaided, because a cross-origin iframe will not
   *  expose currentTime — but it counts a paused player as watching and it cannot
   *  see a seek.
   *
   *  One of the servers in playerSources does publish its playhead. vidlink.pro
   *  documents a PLAYER_EVENT postMessage carrying { event, currentTime, duration },
   *  where `event` includes a periodic 'timeupdate'. When it arrives it REPLACES the
   *  estimate for this session: real seconds, real duration, and a real position to
   *  resume from. Anything else keeps the estimate, so nothing regresses for the
   *  nine servers that publish nothing. (vidlink also emits a MEDIA_DATA payload
   *  with the same numbers; listening to one of the two is enough.)
   *
   *  Origin is checked against playerHostOrigins() — the app's own list, derived
   *  from playerSources — so an unrelated embedded frame cannot write to the rail.
   */
  function onPlayerMessage(event) {
    if (!session) return;
    let allowed;
    try { allowed = playerHostOrigins(); } catch (e) { return; }
    if (!allowed || allowed.indexOf(event.origin) === -1) return;

    const payload = event.data;
    if (!payload || payload.type !== 'PLAYER_EVENT' || !payload.data) return;
    const watched = Number(payload.data.currentTime);
    const duration = Number(payload.data.duration);
    if (!Number.isFinite(watched) || !(duration > 0)) return;

    session.watchedSec = Math.max(0, Math.min(watched, duration));
    session.runtimeSec = duration;
    session.positionSec = session.watchedSec;
    session.exact = true;
    persistSessionProgress();
  }

  window._mzStartWatchSession = function (movie, runtimeMinutes) {
    if (!movie || !movie.id) return;
    stopWatchSession();   // never run two at once

    // Runtime: prefer the real TMDB value; fall back to a sane default so the
    // percentage still advances for titles TMDB has no runtime for. A provider
    // that reports its own duration overwrites this within a few seconds.
    let runSec = 0;
    const rt = Number(runtimeMinutes || movie.runtime ||
      (movie.episode_run_time && movie.episode_run_time[0]) || 0);
    if (rt > 0) runSec = rt * 60;
    else runSec = (movie.media_type === 'tv' ? 45 : 120) * 60;   // fallback estimate

    /*  Which episode is on screen. A series entry is per-episode now, so the
     *  session has to carry season/episode or it would resume, and complete,
     *  against the wrong row. Read from the modal's own inputs, which is what
     *  loadPlayer builds its URL from. */
    const type = movie.media_type || (movie.name && !movie.title ? 'tv' : 'movie');
    let season = 0;
    let episode = 0;
    if (type === 'tv') {
      const sel = (typeof currentEpisodeSelection === 'function') ? currentEpisodeSelection() : null;
      season = sel ? parseInt(sel.s, 10) || 1 : 1;
      episode = sel ? parseInt(sel.e, 10) || 1 : 1;
    }

    // Resume: if this exact row is already in the rail, continue from where it was.
    const wantKey = entryKey({ id: movie.id, media_type: type }, season, episode);
    /*  A finished row that is being started again is watchable again. Keyed, and
     *  therefore only possible once the episode is known — which is why this sits
     *  here rather than at the top of the function. */
    if (isDone(wantKey)) window.mzClearWatched(wantKey);
    const prior = getCWList().find(item => String(item.key || item.id) === wantKey);
    const priorSec = prior && Number.isFinite(prior.watchedSec) ? prior.watchedSec : 0;

    session = {
      id: movie.id,
      title: movie.title || movie.name || (prior && prior.title) || '',
      backdrop: movie.backdrop_path || (prior && prior.backdrop) || '',
      poster: movie.poster_path || (prior && prior.poster) || '',
      media_type: type,
      season: season,
      episode: episode,
      vote_average: movie.vote_average || (prior && prior.vote_average) || 0,
      runtimeSec: (prior && prior.exact && prior.runtimeSec > 0) ? prior.runtimeSec : runSec,
      watchedSec: priorSec,
      positionSec: (prior && Number.isFinite(prior.positionSec)) ? prior.positionSec : 0,
      exact: !!(prior && prior.exact),
      lastTick: nowSec(),
      timer: null
    };

    // Seed the rail immediately so the card appears the moment playback starts,
    // showing the resumed percentage rather than 0.
    upsertEntry(mkEntry(session, null, currentProgressPct(),
      Math.round(session.watchedSec), Math.round(session.runtimeSec)));
    renderContinueWatching();

    // Tick every 5s: accrue visible time, persist, refresh the bar.
    session.timer = setInterval(() => { accrue(); persistSessionProgress(); }, 5000);
    document.addEventListener('visibilitychange', onVisibility);
    /*  blur/focus as well as visibilitychange. A tab that is still VISIBLE but not
     *  focused — another window on top, a second monitor — kept accruing "watch
     *  time" under visibilitychange alone, because the page never hides. */
    window.addEventListener('blur', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('message', onPlayerMessage);
  };

  /*  On regaining focus, reset the clock WITHOUT crediting the gap. accrue() is
   *  deliberately not called first: the elapsed time belongs to whatever the user
   *  was doing in the other window. */
  function onFocus() { if (session) session.lastTick = nowSec(); }

  function stopWatchSession() {
    if (!session) return;
    accrue();
    persistSessionProgress();
    if (session) {   // persist may have cleared it on completion
      clearInterval(session.timer);
    }
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('message', onPlayerMessage);
    session = null;
  }
  window._mzStopWatchSession = stopWatchSession;

  /*  Legacy entry point, now real instead of random. If a caller passes an
   *  explicit progress number it is respected; otherwise it seeds a 1% "just
   *  started" marker and lets the live session drive the rest. */
  window.saveWatchProgress = function (movie, progress) {
    if (!movie || !movie.id) return;
    const key = entryKey(movie, movie.season, movie.episode);
    if (isDone(key) && !(progress > 0 && progress < COMPLETE_AT)) return;
    const prior = getCWList().find(item => String(item.key || item.id) === key);
    const pct = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress)))
      : (prior ? prior.progress : 1);
    if (pct >= COMPLETE_AT) { markDone(key); window.removeCW(key); return; }
    upsertEntry(mkEntry(movie, prior, pct,
      prior && Number.isFinite(prior.watchedSec) ? prior.watchedSec : 0,
      prior && Number.isFinite(prior.runtimeSec) ? prior.runtimeSec : 0));
    renderContinueWatching();
  };

  // Remove one ROW from continue watching (does NOT mark as finished — an explicit
  // "not interested" that should not resurrect on the next play either). Keyed, so
  // dismissing one episode leaves the rest of the series alone.
  window.removeCW = function(key) {
    const k = String(key);
    const list = getCWList().filter(item => String(item.key || item.id) !== k);
    saveCWList(list);
    if (session && entryKey(session, session.season, session.episode) === k) {
      clearInterval(session.timer); session = null;
    }
    renderContinueWatching();
  };

  // Live-patch one card's bar + label without re-rendering the whole rail, so a
  // 5s tick does not flicker the images.
  function liveUpdateCard(key, pct) {
    const grid = document.getElementById('continueWatchingGrid');
    if (!grid) return;
    const card = grid.querySelector('.cw-card[data-key="' + String(key) + '"]');
    if (!card) { renderContinueWatching(); return; }
    const fill = card.querySelector('.cw-progress-fill');
    if (fill) fill.style.width = pct + '%';
    const meta = card.querySelector('.cw-card-meta');
    if (meta) {
      const entry = getCWList().find(e => String(e.key || e.id) === String(key));
      if (entry) meta.textContent = cwMetaText(entry, pct);
    }
  }

  /*  The card's second line: how much is watched, plus which episode it was, now
   *  that a series occupies one row per episode. */
  function cwMetaText(entry, pctOverride) {
    const pct = Number.isFinite(pctOverride) ? pctOverride
      : Math.max(0, Math.min(100, Number(entry.progress) || 0));
    const ep = (entry.media_type === 'tv' && entry.season)
      ? ' • S' + entry.season + 'E' + entry.episode : '';
    return getTimeAgo(entry.timestamp) + ep + ' • ' + pct + '% watched';
  }

  // Render the continue watching section
  window.renderContinueWatching = function() {
    const section = document.getElementById('continue-watching');
    const grid = document.getElementById('continueWatchingGrid');
    if (!section || !grid) return;

    // Never show finished rows, even if a stale entry lingers.
    const list = getCWList().filter(item => item && !isDone(item.key || item.id));

    if (list.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    grid.innerHTML = list.map(item => {
      const img = item.backdrop
        ? `https://image.tmdb.org/t/p/w500${item.backdrop}`
        : (item.poster ? `https://image.tmdb.org/t/p/w342${item.poster}` : '');
      const pct = Math.max(0, Math.min(100, Number(item.progress) || 0));
      const key = String(item.key || item.id);
      /*  Clicking the card RESUMES: openCWMovie starts playback rather than only
       *  opening the detail modal, and the player is handed the saved position. */
      return `
        <div class="cw-card" data-key="${escapeHTML(key)}" data-id="${Number(item.id)}" onclick="openCWMovie(${item.id}, '${item.media_type}', event)" tabindex="0">
          <img class="cw-card-img" src="${img}" alt="${escapeHTML(item.title || '')}" width="280" height="158" loading="lazy" decoding="async">
          <div class="cw-play-icon">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="#000"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <button class="cw-remove-btn" onclick="event.stopPropagation(); removeCW('${escapeHTML(key)}')" aria-label="Remove"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          <div class="cw-card-info">
            <div class="cw-card-title">${escapeHTML(item.title || '')}</div>
            <div class="cw-card-meta">${escapeHTML(cwMetaText(item, pct))}</div>
            <div class="cw-progress-bar"><div class="cw-progress-fill" style="width:${pct}%"></div></div>
          </div>
        </div>
      `;
    }).join('');
  };

  function getTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return Math.floor(days / 7) + 'w ago';
  }

  // Open a continue watching movie
  window.openCWMovie = function(id, mediaType, activationEvent) {
    /*  A Continue Watching card is a RESUME control — it carries a play icon and a
     *  progress bar — so it starts playback instead of stopping at the detail modal.
     *  The flag is consumed by openModal once the title's details have loaded and
     *  the play button exists; doing it here would race the fetch. */
    window._mzAutoPlayOnOpen = true;
    if (typeof openModal === 'function') openModal(id, mediaType, activationEvent);
  };

  // Save the running session's progress before the tab is torn down.
  window.addEventListener('pagehide', stopWatchSession);
  window.addEventListener('beforeunload', () => { if (session) { accrue(); persistSessionProgress(); } });

  // Render on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderContinueWatching);
  } else {
    renderContinueWatching();
  }
})();


// === PWA INSTALL & NOTIFY ME SYSTEM ===
(function initPWA() {
  // 1. Service Worker is registered by the inline <head> PWA bootstrap.
  // Consume its shared readiness promise here; do not create duplicate registrations.
  if ('serviceWorker' in navigator) {
    const swReady = window.__mzServiceWorkerReady || navigator.serviceWorker.ready;
    Promise.resolve(swReady).then(reg => {
      if (reg) console.log('[MovieZone] Service Worker ready:', reg.scope);
    }).catch(err => console.warn('[MovieZone] SW readiness failed:', err));
  }

  // 2. PWA Install UI - driven by pwa-install.js shared live monitor.
  const navInstallBtn = document.getElementById('navInstallBtn');

  function applyPwaInstallState(installed) {
    if (!navInstallBtn) return;
    navInstallBtn.style.display = installed ? 'none' : 'flex';
    navInstallBtn.classList.toggle('mz-install-native-ready', !installed && !!window.deferredPrompt);
  }

  window.addEventListener('mz:pwa-statechange', function(event) {
    applyPwaInstallState(!!(event.detail && event.detail.installed));
  });

  /*  pwa-install.min.js is now loaded lazily (see the loader in index.html), so
   *  its monitor may not exist yet. This resolves the state from what is
   *  available now, and re-resolves it authoritatively when the controller
   *  arrives — the mz:pwainstallready event the loader fires on script load.
   */
  function syncPwaInstallState() {
    const monitor = window.__mzPwaInstallMonitor;
    if (monitor && typeof monitor.check === 'function') {
      monitor.check().then(applyPwaInstallState).catch(function() { applyPwaInstallState(false); });
      return;
    }
    // Cheap local signals, good enough to decide whether to show the button
    // before the controller lands.
    const installedFallback = window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true ||
      localStorage.getItem('mz_app_installed') === '1';
    applyPwaInstallState(installedFallback);
  }
  setTimeout(syncPwaInstallState, 0);
  window.addEventListener('mz:pwainstallready', syncPwaInstallState);

  // Global install function - called from navbar button and banner.
  window.installPWA = function() {
    const monitor = window.__mzPwaInstallMonitor;
    if (monitor && monitor.isInstalled()) {
      applyPwaInstallState(true);
      if (typeof showToast === 'function') showToast('MovieZone is already installed on this device.');
      return;
    }

    if (typeof window.__mzTriggerInstall === 'function') {
      if (!window.deferredPrompt && window.__mzOpenInstallPopup) window.__mzOpenInstallPopup();
      return window.__mzTriggerInstall();
    }

    /*  The user got here before the lazy controller did — the common case being
     *  a click within the first second or two. Pull it in and re-enter once, so
     *  the click is honoured instead of being dropped on a "still loading" toast.
     */
    if (typeof window.__mzLoadPwaInstall === 'function' && !window.__mzInstallRetried) {
      window.__mzInstallRetried = true;
      if (typeof showToast === 'function') showToast('Preparing install…');
      window.__mzLoadPwaInstall().then(function () {
        window.__mzInstallRetried = false;
        window.installPWA();
      });
      return;
    }

    if (window.__mzOpenInstallPopup) {
      window.__mzOpenInstallPopup();
      return;
    }
    const overlay = document.getElementById('pwa-install-overlay');
    if (overlay) {
      overlay.classList.add('open');
      if (!isMzTV()) {
        document.body.style.overflow = 'hidden';
      }
    } else if (typeof showToast === 'function') {
      showToast('Install controls are still loading. Please try again.');
    }
  };

  window.closePWABanner = function() {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.remove();
    sessionStorage.setItem('mz_banner_closed', '1');
  };

  // 3. NOTIFY ME System
  const NOTIFY_KEY = 'mz_notify_movies';

  // ── WEB PUSH SUBSCRIPTION ──

  /*  True when a response is the SPA shell rather than the API answering.
   *
   *  wrangler.jsonc sets not_found_handling to "single-page-application", so an
   *  /api/* route the Worker does not implement answers 200 with index.html
   *  instead of 404. response.ok was therefore true and response.json() threw
   *      Unexpected token '<', "<!DOCTYPE "... is not valid JSON
   *  which reads like a corrupt payload when the real fact is simply that the
   *  endpoint is not deployed on this host. Checking the content type is what
   *  separates those two cases. */
  const servedSpaShell = (response) =>
    !(response.headers.get('content-type') || '').toLowerCase().includes('application/json');

  async function subscribeToPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Push notifications are not supported in this browser');
      }

      const reg = await navigator.serviceWorker.ready;
      let subscription = await reg.pushManager.getSubscription();

      if (!subscription) {
        const response = await fetch('/api/push/vapid-key', { cache: 'no-store' });
        if (!response.ok || servedSpaShell(response)) {
          /*  Push is not wired up on this deployment. That is a deployment
           *  state rather than a fault, so it is said once, plainly — a warning
           *  carrying a SyntaxError stack taught us to scroll past the console
           *  instead of reading it. */
          if (!subscribeToPush.reportedMissing) {
            subscribeToPush.reportedMissing = true;
            console.info('[MovieZone] Push notifications are not configured here: '
              + '/api/push/vapid-key returned ' + response.status + ' '
              + (response.headers.get('content-type') || 'no content type')
              + '. Skipping subscription.');
          }
          return null;
        }
        const { publicKey } = await response.json();
        if (!publicKey) throw new Error('The push configuration has no public key');
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      /*  Do not re-tell the server something it already knows.
       *
       *  This used to POST the subscription on every single page load. The server
       *  wrote it to KV every time, and on Cloudflare's KV free plan (1,000
       *  writes/day) that is what made /api/push/subscribe start answering 500 —
       *  the quota was being spent on writes that changed nothing.
       *
       *  The endpoint is still re-sent whenever it actually changes (browsers do
       *  rotate them), and re-sent anyway once a week so a subscription cannot be
       *  orphaned forever if the server side ever loses the row. */
      const PUSH_SYNC_KEY = 'mz_push_synced';
      const PUSH_RESYNC_MS = 7 * 24 * 60 * 60 * 1000;
      const fingerprint = JSON.stringify(subscription);
      let lastSync = null;
      try { lastSync = JSON.parse(localStorage.getItem(PUSH_SYNC_KEY) || 'null'); } catch (e) {}
      if (lastSync && lastSync.fp === fingerprint
          && (Date.now() - Number(lastSync.at || 0)) < PUSH_RESYNC_MS) {
        return subscription;
      }

      const saveResponse = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      });
      if (!saveResponse.ok || servedSpaShell(saveResponse)) {
        const error = servedSpaShell(saveResponse)
          ? {}
          : await saveResponse.json().catch(() => ({}));
        throw new Error(error.error
          || ('Could not save push subscription (' + saveResponse.status + ')'));
      }

      try {
        localStorage.setItem(PUSH_SYNC_KEY, JSON.stringify({ fp: fingerprint, at: Date.now() }));
      } catch (e) {}

      console.log('[MovieZone] Push subscription synced to server.');
      return subscription;
    } catch (err) {
      console.warn('[MovieZone] Push subscription failed:', err);
      return null;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function saveNotifyMovie(subscription, movie, confirm) {
    const response = await fetch('/api/notify-movies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        movieId: movie.id,
        title: movie.title,
        releaseDate: movie.releaseDate,
        url: '/#upcoming',
        confirm
      })
    });
    const result = servedSpaShell(response)
      ? {}
      : await response.json().catch(() => ({}));
    if (!response.ok || servedSpaShell(response)) {
      /*  Without the content-type check a missing endpoint answers 200 with
       *  index.html and this reads as a successful save, so the movie would be
       *  reported as scheduled when nothing was stored. */
      throw new Error(result.error
        || ('Could not save movie notification (' + response.status + ')'));
    }
    return result;
  }

  async function syncLocalNotifyMovies(subscription) {
    const movies = getNotifyList().filter(movie => movie.releaseDate);
    await Promise.allSettled(movies.map(movie => saveNotifyMovie(subscription, movie, false)));
    localStorage.setItem('mz_notify_migrated_v1', '1');
  }

  async function loadServerNotifyMovies(subscription) {
    const response = await fetch('/api/notify-movies/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
    /*  A 200 carrying index.html would make response.json() throw here, and this
     *  runs from a bare setTimeout — an unhandled rejection that silently stops
     *  the rest of the sync. Treated as "nothing to load" instead. */
    if (!response.ok || servedSpaShell(response)) return;
    const { movies = [] } = await response.json().catch(() => ({ movies: [] }));
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(movies.map(movie => ({
      id: movie.movieId,
      title: movie.title,
      releaseDate: movie.releaseDate,
      addedAt: movie.createdAt ? new Date(movie.createdAt).getTime() : Date.now()
    }))));
  }

  // Keep both the device subscription and movie choices synchronized.
  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    setTimeout(async () => {
      const subscription = await subscribeToPush();
      if (!subscription) return;
      if (!localStorage.getItem('mz_notify_migrated_v1')) {
        await syncLocalNotifyMovies(subscription);
      }
      await loadServerNotifyMovies(subscription);
    }, 1500);
  }

  window.getNotifyList = function() {
    try { return JSON.parse(localStorage.getItem(NOTIFY_KEY)) || []; }
    catch { return []; }
  };

  window.toggleNotifyMe = async function(movieId, movieTitle, releaseDate) {
    const list = getNotifyList();
    const idx = list.findIndex(movie => movie.id === movieId);

    try {
      if (idx > -1) {
        const reg = await navigator.serviceWorker.ready;
        const subscription = await reg.pushManager.getSubscription();
        if (subscription) {
          const response = await fetch('/api/notify-movies/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: subscription.endpoint, movieId })
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Could not remove notification');
          }
        }

        list.splice(idx, 1);
        localStorage.setItem(NOTIFY_KEY, JSON.stringify(list));
        if (typeof showToast === 'function') showToast('Notification removed for ' + movieTitle);
        return false;
      }

      if (!releaseDate) throw new Error('Release date is unavailable for this movie');
      const subscription = await requestNotificationPermission();
      if (!subscription) throw new Error('Notification permission or push subscription is unavailable');

      const movie = { id: movieId, title: movieTitle, releaseDate, addedAt: Date.now() };
      
      // TV local-only mode: save locally without server push
      if (subscription === 'local-only') {
        list.push(movie);
        localStorage.setItem(NOTIFY_KEY, JSON.stringify(list));
        if (typeof showToast === 'function') showToast('🔔 Reminder saved for ' + movieTitle + '! You\'ll see it on your next visit.');
        return true;
      }

      const result = await saveNotifyMovie(subscription, movie, true);
      list.push(movie);
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(list));

      if (typeof showToast === 'function') {
        showToast(result.confirmationSent
          ? 'Notification saved and confirmation sent for ' + movieTitle
          : 'Notification saved for ' + movieTitle);
      }
      return true;
    } catch (err) {
      console.error('[MovieZone] Notify Me failed:', err);
      if (typeof showToast === 'function') showToast(err.message || 'Could not save notification');
      return idx > -1;
    }
  };

  window.isNotifySet = function(movieId) {
    return getNotifyList().some(movie => movie.id === movieId);
  };

  async function requestNotificationPermission() {
    if (!('Notification' in window) || !('PushManager' in window)) {
      // TV fallback: Push not supported, use local-only notify (reminder on next visit)
      if (isMzTV()) {
        console.log('[MovieZone] TV mode: using local-only notifications');
        return 'local-only';
      }
      if (typeof showToast === 'function') showToast('Notifications are not supported in this browser');
      return null;
    }
    if (Notification.permission === 'denied') {
      if (typeof showToast === 'function') showToast('Please enable notifications in browser settings');
      return null;
    }
    if (Notification.permission !== 'granted') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') return null;
    }
    return subscribeToPush();
  }

  // Release notifications are sent by the server, so they work while the website is closed.
})();

// Notify Me button click handler for upcoming cards
window.handleNotifyMe = async function(btn) {
  const movieId = parseInt(btn.dataset.movieId, 10);
  const title = btn.dataset.title;
  const releaseDate = btn.dataset.release;
  const label = btn.querySelector('span');

  if (typeof toggleNotifyMe !== 'function' || btn.disabled) return;
  btn.disabled = true;
  if (label) label.textContent = 'Saving...';

  try {
    const isNowSet = await toggleNotifyMe(movieId, title, releaseDate);
    btn.classList.toggle('notified', isNowSet);
    if (label) label.textContent = isNowSet ? 'Notified ✓' : 'Notify Me';
  } finally {
    btn.disabled = false;
  }
};




// === CINEMATIC UNIVERSES (per-franchise pages, opened from the homepage rail) ===
/*  There is NO picker/landing page any more. The old #collections grid — 18 cards,
 *  hero mosaic and category tabs — was a dead stop between the homepage rail and
 *  the franchise the visitor already chose, so it was removed along with the
 *  navbar entry that was its only other door. The overlay below now has exactly
 *  one state: a single universe's page at #collections-<slug>, and Back/Escape
 *  leaves it for the page underneath instead of stepping to a grid. */
(function initCollectionsHub() {
  /*  Presentation metadata only — exact title lists and TMDB ids live in
   *  collections-catalog.json. No broad keyword discovery happens here.
   *
   *  ORDER IN THIS ARRAY DOES NOT MATTER. The homepage rail is built from
   *  Object.keys(collections-catalog.json → universes), so THAT file’s key order
   *  is the rail order. This array is kept in the same sequence purely so the two
   *  read alike when you edit them together; resorting it changes nothing.
   *
   *  There is no `category` field any more. It fed the picker’s Superhero/Sci-Fi/
   *  Action/Horror tabs and nothing else, so it went when the picker did. */
  const UNIVERSES = [
    { slug: 'mcu', name: 'Marvel Cinematic Universe', badge: 'MARVEL', tagline: 'The complete MCU timeline — every film and narrative series.', accent: 'marvel' },
    { slug: 'dceu', name: 'DC Universe', badge: 'DC', tagline: 'The DCEU legacy and DC Studios’ interconnected new era.', accent: 'dc' },
    { slug: 'x-men', name: 'X-Men Cinematic Universe', badge: 'X-MEN', tagline: 'Every mutant film — the X-Men saga, Wolverine and Deadpool.', accent: 'xmen' },
    { slug: 'yrf-spy', name: 'YRF Spy Universe', badge: 'YRF SPY', tagline: 'Tiger, Pathaan and Kabir — India’s biggest spy crossover.', accent: 'yrfspy' },
    { slug: 'jurassic-park', name: 'Jurassic World', badge: 'JURASSIC', tagline: 'Every Jurassic Park and World film, plus the animated canon.', accent: 'jurassic' },
    { slug: 'cop-universe', name: 'Cop Universe', badge: 'COP UNIVERSE', tagline: 'Rohit Shetty’s force — Singham, Simmba and Sooryavanshi.', accent: 'cop' },
    { slug: 'star-wars', name: 'Star Wars Cinematic Universe', badge: 'STAR WARS', tagline: 'The Skywalker saga, the standalone Stories and the Ewok adventures.', accent: 'starwars' },
    { slug: 'transformers', name: 'Transformers', badge: 'TRANSFORMERS', tagline: 'Robots in disguise — films and animated sagas across generations.', accent: 'transformers' },
    { slug: 'conjuring', name: 'The Conjuring Universe', badge: 'CONJURING', tagline: 'Conjuring, Annabelle, The Nun and every connected nightmare.', accent: 'horror' },
    { slug: 'fast-furious', name: 'Fast & Furious', badge: 'FAST', tagline: 'Every high-octane heist, race and family mission.', accent: 'fast' },
    { slug: 'james-bond', name: 'James Bond 007', badge: '007', tagline: 'The complete EON 007 film canon — six decades of espionage.', accent: 'bond' },
    { slug: 'terminator', name: 'Terminator', badge: 'TERMINATOR', tagline: 'The complete war between humanity and the machines.', accent: 'terminator' },
    { slug: 'wizarding-world', name: 'Wizarding World', badge: 'WIZARDING WORLD', tagline: 'Harry Potter and Fantastic Beasts — the complete magical journey.', accent: 'wizard' },
    { slug: 'middle-earth', name: 'Middle-earth', badge: 'MIDDLE-EARTH', tagline: 'The Lord of the Rings, The Hobbit and the ages of Middle-earth.', accent: 'lotr' },
    { slug: 'mission-impossible', name: 'Mission: Impossible', badge: 'M:I', tagline: 'The original IMF series and every impossible cinematic mission.', accent: 'mi' },
    { slug: 'predator', name: 'Predator', badge: 'PREDATOR', tagline: 'The ultimate hunters — Predator, Prey and the AVP encounters.', accent: 'predator' },
    { slug: 'maddock', name: 'Maddock Supernatural Universe', badge: 'MADDOCK', tagline: 'Stree, Bhediya, Munjya and every Chanderi horror-comedy legend.', accent: 'maddock' }
  ];

  const hubCache = new Map();
  let activeUniverseSlug = null;
  let activeTab = 'all'; // 'all' | 'movies' | 'tv'

  function getUniverse(slug) {
    return UNIVERSES.find(u => u.slug === slug);
  }

  // ── Curated catalog loader ──
  // One small static request replaces dozens of broad TMDB discover calls.
  // Exact IDs, titles, artwork and release dates were resolved by strict title+year.
  let curatedCatalogPromise = null;
  function loadCuratedCatalog() {
    if (curatedCatalogPromise) return curatedCatalogPromise;
    /*  ?v= is the ONLY invalidation lever here: force-cache means the browser
     *  will not even revalidate, so a content change with a stale version is
     *  invisible to every returning client. Bump this whenever
     *  collections-catalog.json changes — asset-seal.js now enforces it. */
    curatedCatalogPromise = fetch('/collections-catalog.json?v=4', { cache: 'force-cache' })
      .then(response => {
        if (!response.ok) throw new Error('Catalog HTTP ' + response.status);
        return response.json();
      })
      .then(data => {
        if (!data || !data.universes) throw new Error('Invalid collections catalog');
        return data.universes;
      })
      .catch(error => {
        // Allow a later retry instead of permanently caching a rejected promise.
        curatedCatalogPromise = null;
        throw error;
      });
    return curatedCatalogPromise;
  }

  function readUniverseMedia(universe, type) {
    const cacheKey = universe.slug + '_' + type;
    if (hubCache.has(cacheKey)) return hubCache.get(cacheKey);

    const promise = loadCuratedCatalog().then(catalog => {
      const entry = catalog[universe.slug];
      if (!entry) throw new Error('Missing curated universe: ' + universe.slug);
      const items = Array.isArray(entry[type]) ? entry[type] : [];
      // Clone once so filtering/sorting in the detail UI never mutates source data.
      return items.map((item, order) => ({ ...item, _curatedOrder: order }));
    }).catch(error => {
      hubCache.delete(cacheKey);
      throw error;
    });

    hubCache.set(cacheKey, promise);
    return promise;
  }

  function fetchUniverseMovies(universe) {
    return readUniverseMedia(universe, 'movies');
  }

  function fetchUniverseTV(universe) {
    return readUniverseMedia(universe, 'tv');
  }

  // Exposed read-only diagnostics make catalog coverage testable without leaking internals.
  window.__moviezoneCollections = Object.freeze({
    universeCount: UNIVERSES.length,
    loadCatalog: loadCuratedCatalog,
    getUniverse: slug => getUniverse(slug)
  });

  // ── Performance / motion capability detection ──
  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isTouchOnly = window.matchMedia ? !window.matchMedia('(hover: hover) and (pointer: fine)').matches : ('ontouchstart' in window);
  const lowPower = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
                   (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
                   (navigator.connection && /2g/i.test(navigator.connection.effectiveType || ''));
  const liteMode = prefersReducedMotion || lowPower;
  const enableTilt = !isTouchOnly && !prefersReducedMotion && !lowPower;
  if (liteMode) document.documentElement.classList.add('ch-lite');

  // Fade images in only once decoded — avoids janky pop-in and layout thrash
  function attachImageReveal(scope) {
    scope.querySelectorAll('img[data-ch-reveal]').forEach(img => {
      img.removeAttribute('data-ch-reveal');
      if (isMzTV()) img.loading = 'eager';
      const done = () => {
        img.classList.add('ch-img-in');
        const inner = img.closest('.ch-movie-card-inner');
        if (inner) inner.classList.add('ch-img-in');
      };
      // Cached successes and cached failures can both complete before listeners attach.
      if (img.complete) done();
      else {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }
    });
  }

  // ── Pointer-reactive 3D tilt + spotlight (rAF-throttled, one shared loop) ──
  let tiltQueued = false;
  let tiltTarget = null;
  let tiltPoint = { x: 0, y: 0 };
  function flushTilt() {
    tiltQueued = false;
    const el = tiltTarget;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = (tiltPoint.x - r.left) / r.width;
    const py = (tiltPoint.y - r.top) / r.height;
    const isMovie = el.classList.contains('ch-movie-card');
    const max = isMovie ? 6 : 7;
    const rx = ((0.5 - py) * max).toFixed(2) + 'deg';
    const ry = ((px - 0.5) * max).toFixed(2) + 'deg';
    if (isMovie) {
      el.style.setProperty('--ch-mrx', rx);
      el.style.setProperty('--ch-mry', ry);
    } else {
      el.style.setProperty('--ch-rx', rx);
      el.style.setProperty('--ch-ry', ry);
      el.style.setProperty('--ch-mx', (px * 100).toFixed(1) + '%');
      el.style.setProperty('--ch-my', (py * 100).toFixed(1) + '%');
    }
  }
  function bindTilt(el) {
    if (!enableTilt) return;
    el.addEventListener('pointerenter', () => { el.classList.add('ch-tilting'); }, { passive: true });
    el.addEventListener('pointermove', (e) => {
      tiltTarget = el;
      tiltPoint.x = e.clientX;
      tiltPoint.y = e.clientY;
      if (!tiltQueued) { tiltQueued = true; requestAnimationFrame(flushTilt); }
    }, { passive: true });
    el.addEventListener('pointerleave', () => {
      el.classList.remove('ch-tilting');
      if (tiltTarget === el) tiltTarget = null;
      el.style.setProperty('--ch-rx', '0deg');
      el.style.setProperty('--ch-ry', '0deg');
      el.style.setProperty('--ch-mrx', '0deg');
      el.style.setProperty('--ch-mry', '0deg');
    }, { passive: true });
  }

  function renderUniverseDetail(universe, movies, tvSeries) {
    const detail = document.getElementById('chDetailView');
    if (!detail) return;

    const allItems = [...movies.map(m => ({...m, _type: 'movie'})), ...tvSeries.map(s => ({...s, _type: 'tv'}))];
    allItems.sort((a, b) => ((a.release_date || a.first_air_date || '9999').localeCompare(b.release_date || b.first_air_date || '9999')));

    if (!allItems.length) {
      detail.innerHTML = '<div class="ch-detail-empty"><div class="ch-detail-empty-icon">🎬</div><strong>No titles found for this universe yet.</strong><span>Please check back soon.</span></div>';
      return;
    }

    const heroItem = allItems.find(m => m.backdrop_path) || allItems[0];
    const totalMovies = movies.length;
    const totalTV = tvSeries.length;
    const yearStart = (allItems[0].release_date || allItems[0].first_air_date || '').slice(0, 4) || '?';
    const yearEnd = (allItems[allItems.length - 1].release_date || allItems[allItems.length - 1].first_air_date || '').slice(0, 4) || 'Present';

    /*  Franchises are living things — Maddock has four films dated 2026-2028 and
     *  YRF has two more Tigers coming. Those used to render exactly like a released
     *  film: a poster, a year, and a 0.0-star rating that made a hotly anticipated
     *  sequel look badly reviewed. They are now separated out, chipped as UPCOMING,
     *  and given their own tab, which also means "N Movies" stops over-promising
     *  how much there is to actually watch tonight.
     *  Date-only compare (YYYY-MM-DD sorts lexicographically) — no Date parsing,
     *  no timezone edge where a film flips state depending on the viewer's clock. */
    const today = new Date().toISOString().slice(0, 10);
    const dateOf = (item) => item.release_date || item.first_air_date || '';
    const isUpcoming = (item) => {
      const d = dateOf(item);
      return !d || d > today;
    };
    const upcomingItems = allItems.filter(isUpcoming);
    const releasedCount = allItems.length - upcomingItems.length;

    function buildCards(items) {
      return items.map((item, idx) => {
        const title = item.title || item.name || '';
        const year = (item.release_date || item.first_air_date || '').slice(0, 4) || 'TBA';
        const voteRaw = Number(item.vote_average || 0);
        const rating = voteRaw.toFixed(1);
        const isTVItem = item._type === 'tv';
        const soon = isUpcoming(item);
        const delay = Math.min(idx, 16) * 45;
        /*  An unreleased title often has no poster yet. Rendering IMG + null gives
         *  a broken-image icon, so fall back to a lettered placeholder. */
        const art = item.poster_path
          ? '<img src="' + IMG + item.poster_path + '" alt="' + escapeHTML(title) + ' poster" width="342" height="513" loading="lazy" decoding="async" data-ch-reveal>'
          : '<div class="ch-movie-noart" aria-hidden="true">' + escapeHTML(title.slice(0, 1).toUpperCase() || '?') + '</div>';
        return (
          '<div class="ch-movie-card ch-accent-' + universe.accent + (soon ? ' ch-movie-soon' : '') + '" data-id="' + item.id + '" data-type="' + item._type + '"' +
            ' role="button" tabindex="0" aria-label="' + escapeHTML(title) + ' (' + year + ')' + (soon ? ', upcoming' : '') + '" style="--delay:' + delay + 'ms;animation-delay:' + delay + 'ms">' +
            '<div class="ch-movie-card-inner">' +
              art +
              '<span class="ch-movie-order">' + (idx + 1) + '</span>' +
              (isTVItem ? '<span class="ch-movie-type-badge ch-type-tv">TV</span>' : '<span class="ch-movie-type-badge ch-type-movie">MOVIE</span>') +
              // A rating on an unreleased film is noise at best and misleading at worst.
              (soon ? '<div class="ch-movie-soon-chip">UPCOMING</div>'
                    : (voteRaw > 0 ? '<div class="ch-movie-rating">★ ' + rating + '</div>' : '')) +
              '<div class="ch-movie-shine"></div>' +
              '<div class="ch-movie-hover-overlay">' +
                '<div class="ch-movie-hover-play">' + (soon ? '🕒' : '▶') + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="ch-movie-info"><h4>' + escapeHTML(title) + '</h4><span>' + year + '</span></div>' +
          '</div>'
        );
      }).join('');
    }

    // Swap grid contents without re-binding per-card listeners (delegation handles clicks)
    function paintGrid(items) {
      const gridEl = document.getElementById('chMovieGrid');
      if (!gridEl) return;
      gridEl.innerHTML = buildCards(items);
      attachImageReveal(gridEl);
      if (enableTilt) gridEl.querySelectorAll('.ch-movie-card').forEach(bindTilt);
    }

    detail.innerHTML =
      '<div class="ch-detail-hero ch-accent-' + universe.accent + '">' +
        (heroItem.backdrop_path ? '<img src="https://image.tmdb.org/t/p/w1280' + heroItem.backdrop_path + '"' +
          ' srcset="https://image.tmdb.org/t/p/w780' + heroItem.backdrop_path + ' 780w, https://image.tmdb.org/t/p/w1280' + heroItem.backdrop_path + ' 1280w"' +
          ' sizes="100vw" alt="" width="1280" height="720" fetchpriority="high" decoding="async" class="ch-detail-hero-img">' : '') +
        '<div class="ch-detail-hero-gradient"></div>' +
        '<div class="ch-detail-hero-particles"></div>' +
        '<div class="ch-detail-hero-content">' +
          '<span class="ch-card-badge">' + escapeHTML(universe.badge) + '</span>' +
          '<h1>' + escapeHTML(universe.name) + '</h1>' +
          '<p>' + escapeHTML(universe.tagline) + '</p>' +
          '<div class="ch-detail-meta">' +
            '<span class="ch-detail-count">' + totalMovies + ' Movie' + (totalMovies !== 1 ? 's' : '') + '</span>' +
            (totalTV > 0 ? '<span class="ch-detail-count">' + totalTV + ' TV Series</span>' : '') +
            '<span class="ch-detail-count">' + yearStart + ' – ' + yearEnd + '</span>' +
            (upcomingItems.length ? '<span class="ch-detail-count ch-detail-count--soon">' +
              releasedCount + ' of ' + allItems.length + ' released</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ch-detail-tabs">' +
        '<button class="ch-dtab active" data-filter="all">All (' + allItems.length + ')</button>' +
        '<button class="ch-dtab" data-filter="movies">Movies (' + totalMovies + ')</button>' +
        (totalTV > 0 ? '<button class="ch-dtab" data-filter="tv">TV Series (' + totalTV + ')</button>' : '') +
        (upcomingItems.length ? '<button class="ch-dtab" data-filter="upcoming">Upcoming (' + upcomingItems.length + ')</button>' : '') +
      '</div>' +
      '<div class="ch-detail-sort">' +
        '<button class="ch-sort-btn active" data-sort="release">Release Order</button>' +
        '<button class="ch-sort-btn" data-sort="rating">Top Rated</button>' +
        '<button class="ch-sort-btn" data-sort="title">A – Z</button>' +
      '</div>' +
      '<div class="ch-movie-grid" id="chMovieGrid"></div>';

    paintGrid(allItems);

    // Cinematic slow zoom on the hero backdrop
    const heroEl = detail.querySelector('.ch-detail-hero');
    if (heroEl && !prefersReducedMotion) requestAnimationFrame(() => heroEl.classList.add('ch-kenburns'));

    /*  Filter and sort were each re-deriving the visible list from the DOM, in two
     *  near-identical copies that had to stay in agreement. Adding a third filter to
     *  both would have been a third chance for them to drift, so both handlers now
     *  go through one function that reads the two active buttons and repaints.
     *
     *  Movies/TV deliberately still COUNT their upcoming entries, so the number on
     *  the tab always matches the number of cards behind it. Upcoming is a
     *  cross-cutting view of the same list, not a fourth bucket carved out of it. */
    function applyFilter(list, filter) {
      if (filter === 'movies') return list.filter(i => i._type === 'movie');
      if (filter === 'tv') return list.filter(i => i._type === 'tv');
      if (filter === 'upcoming') return list.filter(isUpcoming);
      return list;
    }

    function applySort(list, sort) {
      const items = [...list];
      if (sort === 'rating') items.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
      else if (sort === 'title') items.sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
      return items;
    }

    function repaint() {
      const tab = detail.querySelector('.ch-dtab.active');
      const sortBtn = detail.querySelector('.ch-sort-btn.active');
      paintGrid(applySort(
        applyFilter(allItems, tab ? tab.dataset.filter : 'all'),
        sortBtn ? sortBtn.dataset.sort : 'release'
      ));
    }

    function wireGroup(selector) {
      detail.querySelectorAll(selector).forEach(btn => {
        btn.addEventListener('click', () => {
          detail.querySelectorAll(selector).forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          repaint();
        });
      });
    }
    wireGroup('.ch-dtab');
    wireGroup('.ch-sort-btn');

    bindMovieCardClicks();
  }

  // Single delegated listener for the whole detail view — survives grid re-renders
  let movieDelegationBound = false;
  function bindMovieCardClicks() {
    if (movieDelegationBound) return;
    const detail = document.getElementById('chDetailView');
    if (!detail) return;
    movieDelegationBound = true;
    const open = (card, activationEvent) => {
      if (!card) return;
      openModal(Number(card.dataset.id), card.dataset.type, activationEvent);
    };
    detail.addEventListener('click', (e) => {
      const card = e.target.closest && e.target.closest('.ch-movie-card');
      if (card) open(card, e);
    });
    detail.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest && e.target.closest('.ch-movie-card');
      if (card) { e.preventDefault(); open(card, e); }
    });
  }

  async function openUniverse(slug, options) {
    const universe = getUniverse(slug);
    if (!universe) return;
    const overlay = document.getElementById('collections-hub-overlay');
    if (!overlay) return;
    if (!overlay.classList.contains('open')) openCollectionsHubOverlay();

    activeUniverseSlug = slug;
    overlay.classList.add('detail-mode');
    const topbarTitle = document.getElementById('chTopbarTitle');
    const backLabel = document.getElementById('chBackLabel');
    if (topbarTitle) topbarTitle.textContent = universe.name;
    if (backLabel) backLabel.textContent = 'Close';

    if (!(options && options.skipHistory)) {
      window.history.pushState({ collectionsHub: true, universe: slug }, '', '#collections-' + slug);
    }

    const detail = document.getElementById('chDetailView');
    if (detail) detail.innerHTML = '<div class="ch-detail-loading"><div class="ch-loading-spinner"></div><p>Loading ' + escapeHTML(universe.name) + '…</p></div>';

    const scroller = document.getElementById('chScroll');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'instant' in Object.getPrototypeOf(scroller.scrollTo || {}) ? 'instant' : 'auto' });

    try {
      const [movies, tvSeries] = await Promise.all([
        fetchUniverseMovies(universe),
        fetchUniverseTV(universe)
      ]);
      if (activeUniverseSlug === slug) renderUniverseDetail(universe, movies, tvSeries);
    } catch (error) {
      console.warn('[MovieZone] Failed to open universe', slug, error);
      if (detail) detail.innerHTML = '<div class="ch-detail-empty"><div class="ch-detail-empty-icon">⚠️</div><strong>Could not load this universe.</strong><span>Please try again in a moment.</span></div>';
    }
  }

  // ── Ambient particle field (DPR-capped, 30fps, auto-paused, spatial-hashed links) ──
  let particleAnimFrame = null;
  let particlesRunning = false;
  let particleResizeBound = false;
  function initParticles() {
    const canvas = document.getElementById('chParticleCanvas');
    if (!canvas) return;
    if (isMzTV() || liteMode) { canvas.style.display = 'none'; return; }
    if (particlesRunning) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const isSmall = window.innerWidth < 768;
    const COUNT = isSmall ? 22 : 44;
    const LINK_DIST = 110;
    const CELL = LINK_DIST;
    let w = 0, h = 0;
    let particles = canvas._chParticles || null;

    function resize() {
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (particles) particles.forEach(p => { p.x = Math.min(p.x, w); p.y = Math.min(p.y, h); });
    }
    resize();
    if (!particleResizeBound) {
      particleResizeBound = true;
      let rt = null;
      window.addEventListener('resize', () => {
        clearTimeout(rt);
        rt = setTimeout(() => { if (particlesRunning) resize(); }, 200);
      }, { passive: true });
    }

    if (!particles) {
      particles = [];
      for (let i = 0; i < COUNT; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.8 + 0.5,
          dx: (Math.random() - 0.5) * 0.35,
          dy: (Math.random() - 0.5) * 0.28,
          o: Math.random() * 0.35 + 0.1,
          gold: Math.random() > 0.45
        });
      }
      canvas._chParticles = particles;
    }

    const cells = new Map();
    const FRAME_MS = 1000 / 30; // 30fps is plenty for ambient dust — halves GPU cost
    let last = 0;

    function animate(now) {
      particleAnimFrame = requestAnimationFrame(animate);
      if (now - last < FRAME_MS) return;
      last = now;

      ctx.clearRect(0, 0, w, h);
      cells.clear();

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.dx;
        p.y += p.dy;
        if (p.x < 0 || p.x > w) p.dx *= -1;
        if (p.y < 0 || p.y > h) p.dy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.283185);
        ctx.fillStyle = (p.gold ? 'rgba(245,197,24,' : 'rgba(124,58,237,') + p.o + ')';
        ctx.fill();
        const key = ((p.x / CELL) | 0) + ':' + ((p.y / CELL) | 0);
        let bucket = cells.get(key);
        if (!bucket) { bucket = []; cells.set(key, bucket); }
        bucket.push(p);
      }

      // Only compare neighbours in adjacent cells instead of every pair (O(n) vs O(n²))
      ctx.lineWidth = 0.5;
      cells.forEach((bucket, key) => {
        const parts = key.split(':');
        const cx = +parts[0], cy = +parts[1];
        for (let ox = 0; ox <= 1; ox++) {
          for (let oy = (ox === 0 ? 0 : -1); oy <= 1; oy++) {
            const other = (ox === 0 && oy === 0) ? bucket : cells.get((cx + ox) + ':' + (cy + oy));
            if (!other) continue;
            for (let i = 0; i < bucket.length; i++) {
              const a = bucket[i];
              const jStart = (other === bucket) ? i + 1 : 0;
              for (let j = jStart; j < other.length; j++) {
                const b = other[j];
                const dx = a.x - b.x, dy = a.y - b.y;
                const d2 = dx * dx + dy * dy;
                if (d2 > LINK_DIST * LINK_DIST) continue;
                const alpha = 0.055 * (1 - Math.sqrt(d2) / LINK_DIST);
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.strokeStyle = 'rgba(245,197,24,' + alpha.toFixed(3) + ')';
                ctx.stroke();
              }
            }
          }
        }
      });
    }
    particlesRunning = true;
    particleAnimFrame = requestAnimationFrame(animate);
  }

  function stopParticles() {
    if (particleAnimFrame) {
      cancelAnimationFrame(particleAnimFrame);
      particleAnimFrame = null;
    }
    particlesRunning = false;
  }

  // Never burn CPU on a hidden tab
  document.addEventListener('visibilitychange', () => {
    const overlay = document.getElementById('collections-hub-overlay');
    if (document.hidden) stopParticles();
    else if (overlay && overlay.classList.contains('open')) initParticles();
  });

  /*  A universe IS the destination — there is no picker page in between, so this
   *  entry point requires a slug. The overlay only ever exists in detail mode.
   *  Called from universes-rail.js (homepage rail) and from the popstate router. */
  window.openCollectionsHub = function(event, initialSlug) {
    if (event) event.preventDefault();
    if (!initialSlug || !getUniverse(initialSlug)) return;
    openUniverse(initialSlug);
  };

  function openCollectionsHubOverlay() {
    const overlay = document.getElementById('collections-hub-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    if (!isMzTV()) {
      document.body.style.overflow = 'hidden';
    }
    initParticles();
  }

  window.closeCollectionsHub = function(options) {
    const overlay = document.getElementById('collections-hub-overlay');
    if (!overlay) return;
    overlay.classList.remove('open', 'detail-mode');
    document.body.style.overflow = '';
    activeUniverseSlug = null;
    stopParticles();
    if (!(options && options.skipHistory) && window.location.hash.startsWith('#collections')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };

  /*  There is no hub grid to step back to any more, so Back / Escape from a
   *  universe leaves the overlay entirely and returns to the page underneath. */
  window.handleCollectionsBack = function() {
    window.closeCollectionsHub();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('collections-hub-overlay');
    if (overlay && overlay.classList.contains('open')) {
      e.stopPropagation();
      window.handleCollectionsBack();
    }
  });

  /*  Only #collections-<slug> is a real destination. A bare #collections is no
   *  longer a page, so it tears the overlay down like any other hash. */
  window.addEventListener('popstate', () => {
    const overlay = document.getElementById('collections-hub-overlay');
    if (!overlay) return;
    const hash = window.location.hash;
    const slug = hash.startsWith('#collections-') ? hash.replace('#collections-', '') : '';
    if (slug && getUniverse(slug)) {
      if (!overlay.classList.contains('open')) openCollectionsHubOverlay();
      openUniverse(slug, { skipHistory: true });
    } else if (overlay.classList.contains('open')) {
      overlay.classList.remove('open', 'detail-mode');
      document.body.style.overflow = '';
      activeUniverseSlug = null;
      stopParticles();
    }
  });

  /*  COLD-LOAD DEEP LINKS
   *  This used to throw the hash away on DOMContentLoaded — pasting
   *  /#collections-mcu into a fresh tab landed you on the homepage, so a franchise
   *  page could not be shared, bookmarked or survive a refresh. The comment said it
   *  was "to prevent loop", and it genuinely was: opening the overlay pushed
   *  #collections, which fired the router, which opened the overlay again.
   *
   *  That loop is gone with the picker. openCollectionsHubOverlay() no longer
   *  touches history at all, and the open below passes skipHistory because the URL
   *  is ALREADY the state we want — pushing it again would put a duplicate entry in
   *  front of the page the visitor arrived from.
   *
   *  A bare #collections, or a slug that no longer exists (the retired franchises,
   *  or a typo), is still stripped: there is no page to show, and leaving a dead
   *  hash in the bar invites a reload into the same nothing. */
  function openFromHash() {
    const hash = window.location.hash;
    if (!hash.startsWith('#collections')) return;
    const slug = hash.startsWith('#collections-') ? hash.slice('#collections-'.length) : '';
    if (slug && getUniverse(slug)) openUniverse(slug, { skipHistory: true });
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  if (window.location.hash.startsWith('#collections')) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openFromHash);
    else openFromHash();
  }
})();

/* ═══════════════════════════════════════════════════════════════════════════
 *  TV PERFORMANCE & RESPONSIVE LAYOUT  (v1.0)
 *  ─────────────────────────────────────────────────────────────────────────
 *  Ye module TV pe lag / hang / scrolling problem theek karta hai. Kuch bhi
 *  naya "design" nahi banaya — moviezone.css me pehle se maujood optimization
 *  classes ko TV pe actually apply kiya gaya hai (wo likhi gayi thi par TV pe
 *  kabhi lagti hi nahi thi), aur ek CSS bug fix kiya gaya hai.
 *
 *  KYA GALAT THA
 *  ─────────────
 *  1. `low-end-mode` class TV pe kabhi nahi lagti thi.
 *     moviezone.js:64  ->  `if (isMobile) ... add('low-end-mode')`
 *     aur isMobile = !isMzTV() && /Mobi|Android|.../  => TV pe hamesha false.
 *     checkPerformance() bhi TV ko explicitly skip karta hai (line ~6725).
 *     Nateeja: TV, jo sabse weak device hai, ko poora heavy-effect version
 *     milta tha — box-shadows, ::before/::after decorations, staggered
 *     entrance animations, will-change layers. Ye CSS already tayaar thi.
 *
 *  2. 🔴 SCROLLING BUG — asli wajah:
 *     moviezone.css me hai:
 *       .large-screen-mode .movie-card { content-visibility: auto; }
 *     par uske saath `contain-intrinsic-size` nahi diya gaya.
 *     content-visibility:auto offscreen element ka rendering skip karta hai,
 *     aur intrinsic size ke bina uski height 0 ho jaati hai. Matlab grid ki
 *     total height scroll karte waqt badalti rehti hai -> scrollbar jump,
 *     scroll position khud se hilti hai, D-pad focus galat jagah jaata hai.
 *     Yahi "scrolling me issue" hai. Fix: measured intrinsic size dena.
 *
 *  3. `large-screen-mode` sirf `innerWidth >= 1920` pe lagti thi. Bahut se TV
 *     720p/1080p pe 1280 CSS px report karte hain, to unhe `contain` aur
 *     `content-visibility` ka fayda hi nahi milta tha.
 *
 *  4. Carousel autoplay (5.5s interval) tab bhi chalta rehta tha jab user
 *     neeche grid dekh raha hota hai. Har 5.5s me ek full-screen backdrop
 *     swap = TV pe scrolling ke dauraan stutter.
 *
 *  5. TV pe cards unbounded badhte the (infinite scroll). tv-mode.js ka
 *     collectFocusables() har D-pad press pe saare cards walk karta hai, to
 *     300 cards = har button press pe 300-element walk = hang.
 *     MAX_CARDS_TV = 24 aur profile.maxCards define the, par use nahi ho rahe.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function initTVPerformance() {
  'use strict';

  const root = document.documentElement;
  const onTV = () => root.getAttribute('data-mz-tv') === 'true';

  /* tv-mode.js `data-mz-tv-tier` set karta hai: low | mid | high
   * low  = Fire TV, webOS, Tizen, Vidaa, HbbTV, Opera TV  (sabse weak)
   * high = PlayStation, Xbox, Apple TV                    (kaafi powerful)
   * High tier ko poori visual polish milti rahegi — sirf weak TVs pe
   * effects kam karte hain. */
  const tvTier = () => root.getAttribute('data-mz-tv-tier') || 'low';

  /* ─────────────────────────────────────────────────────────────────────
   * 1. TV-only CSS: sirf wo cheezein jo moviezone.css me missing ya galat
   *    hain. Baaki sab kaam existing classes karti hain.
   * ───────────────────────────────────────────────────────────────────── */
  function injectTVCss() {
    if (document.getElementById('mz-tv-perf-css')) return;
    const style = document.createElement('style');
    style.id = 'mz-tv-perf-css';
    style.textContent = `
/* ── FIX A (asli scrolling bug): content-visibility ke saath intrinsic size ──
   Bina iske offscreen card ki height 0 ho jaati hai aur grid ki height scroll
   ke dauraan badalti rehti hai. --mz-card-h runtime pe measure hoti hai. */
html[data-mz-tv="true"].large-screen-mode .movie-card,
html[data-mz-tv="true"] .movie-card {
  contain-intrinsic-size: auto var(--mz-card-h, 340px);
}
html[data-mz-tv="true"].large-screen-mode .upcoming-card,
html[data-mz-tv="true"] .upcoming-card {
  contain-intrinsic-size: auto var(--mz-upcoming-h, 300px);
}

/* ── FIX B: smooth scrolling TV pe hamesha laggy hoti hai (JS already
   behavior:'auto' bhejta hai, par CSS scroll-behavior usko override kar deti
   hai). Har scroll container pe instant scroll. */
html[data-mz-tv="true"],
html[data-mz-tv="true"] body,
html[data-mz-tv="true"] .movie-grid,
html[data-mz-tv="true"] .upcoming-grid,
html[data-mz-tv="true"] .cat-tabs,
html[data-mz-tv="true"] .related-slider,
html[data-mz-tv="true"] .ch-scroll,
html[data-mz-tv="true"] #modal-overlay,
html[data-mz-tv="true"] .upcoming-detail-overlay,
html[data-mz-tv="true"] .collections-hub-overlay {
  scroll-behavior: auto !important;
}

/* ── FIX C: large-screen-mode navbar pe backdrop-filter ko !important se
   FORCE karti hai (moviezone.css). Blur TV GPU pe sabse mehnga effect hai aur
   navbar sticky hai, to har scroll frame pe re-composite hota hai. */
html[data-mz-tv="true"] #navbar,
html[data-mz-tv="true"].large-screen-mode #navbar,
html[data-mz-tv="true"] .search-results-dropdown,
html[data-mz-tv="true"] .cat-group-menu,
html[data-mz-tv="true"] .mobile-nav-overlay,
html[data-mz-tv="true"] #modal-overlay,
html[data-mz-tv="true"] .modal-box,
html[data-mz-tv="true"] .upcoming-detail-overlay,
html[data-mz-tv="true"] .upcoming-detail-box,
html[data-mz-tv="true"] .collections-hub-overlay,
html[data-mz-tv="true"] .ch-topbar,
html[data-mz-tv="true"] .card-overlay,
html[data-mz-tv="true"] #toast {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* ── FIX D: scroll ke dauraan blur filter recompute = frame drop.
   (Poster ka saturate/contrast rehne diya — wo sasta hai aur focus feedback
   ke liye zaroori hai.) */
html[data-mz-tv="true"] .slide-bg,
html[data-mz-tv="true"] #modalBg,
html[data-mz-tv="true"] .ud-backdrop-img,
html[data-mz-tv="true"] .ch-hero-glow,
html[data-mz-tv="true"] .ch-hero-mosaic-veil {
  filter: none !important;
}

/* ── FIX E: ambient firefly layer aur custom cursor ke 3 elements ab site se
   hi hata diye gaye hain (perf). Sirf collection-hero ka particle canvas bacha
   hai, wo TV pe band. */
html[data-mz-tv="true"] .ch-particle-canvas {
  display: none !important;
}

/* ── FIX F: .reveal-up cards ka opacity:0 tabhi hatta hai jab
   IntersectionObserver .in-view lagata hai. TV pe hum wo observer skip karte
   hain, to yahan opacity force karni zaroori hai — warna card invisible. */
html[data-mz-tv="true"] .reveal-up { opacity: 1 !important; }

/* ── FIX G: sticky navbar ko apni compositing layer do, taaki scroll ke waqt
   uske neeche ka content re-paint na kare. */
html[data-mz-tv="true"] #navbar { transform: translateZ(0); }

/* ── FIX H: 4K / 8K TV pe text 3 meter door se padhne layak rahe.
   moviezone.css me 2500px+ pe font-size 125% hai; usse aage kuch nahi tha. */
@media (min-width: 3400px) {
  html[data-mz-tv="true"] { font-size: 150%; }
  html[data-mz-tv="true"] .movie-grid {
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)) !important;
  }
  html[data-mz-tv="true"] .upcoming-grid {
    grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)) !important;
  }
}
@media (min-width: 5000px) {
  html[data-mz-tv="true"] { font-size: 190%; }
  html[data-mz-tv="true"] .movie-grid {
    grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)) !important;
  }
}`;
    document.head.appendChild(style);
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 2. Existing optimization classes TV pe apply karo
   * ───────────────────────────────────────────────────────────────────── */
  function applyTVClasses() {
    // content-visibility + contain: layout style paint — har TV width pe chahiye,
    // sirf >=1920px pe nahi. (Ab FIX A intrinsic size bhi de raha hai.)
    root.classList.add('large-screen-mode');

    // Heavy effects sirf weak TVs pe band. PlayStation/Xbox/Apple TV (high tier)
    // ko poori polish milti rahegi.
    if (tvTier() !== 'high') root.classList.add('low-end-mode');
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 3. Card ki asli height measure karke intrinsic size set karo.
   *    Ye number galat hone se hi scroll jump hota hai, isliye guess nahi
   *    karte — DOM se padhte hain. Column width badalne pe height badalti
   *    hai, to resize pe dobara measure karte hain.
   * ───────────────────────────────────────────────────────────────────── */
  let measureQueued = false;
  let seenCardH = 0;       // ab tak dekhi gayi sabse BADI card height
  let seenUpcomingH = 0;

  /*  Sirf pehla card measure karna kaafi nahi tha: pehle render pe wo 344px
   *  bata raha tha jabki asli height 500px thi (genres row wrap hone aur image
   *  layout settle hone se pehle). Under-estimate = grid ki height badal-badal
   *  kar scroll jump karti hai. Isliye:
   *    - ek saath 12 cards sample karo aur unme se MAX lo
   *    - baad me dobara measure karo (images load hone ke baad)
   *    - value ko sirf badhne do (sticky max); resize pe reset hoti hai
   *  Grid ke rows stretch hote hain, to sabse tall card hi sahi estimate hai. */
  function sampleMax(selector, limit) {
    const nodes = document.querySelectorAll(selector);
    let max = 0;
    for (let i = 0; i < nodes.length && i < limit; i++) {
      const h = nodes[i].getBoundingClientRect().height;
      if (h > max) max = h;
    }
    return Math.round(max);
  }

  function measureCards() {
    measureQueued = false;
    const h = sampleMax('.movie-card', 12);
    if (h > 40 && h > seenCardH) {
      seenCardH = h;
      root.style.setProperty('--mz-card-h', h + 'px');
    }
    const u = sampleMax('.upcoming-card', 8);
    if (u > 40 && u > seenUpcomingH) {
      seenUpcomingH = u;
      root.style.setProperty('--mz-upcoming-h', u + 'px');
    }
  }
  function scheduleMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(measureCards);
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 4. Card budget: TV pe DOM ko unbounded badhne se roko.
   *    Cards DELETE nahi karte (wo scroll position aur D-pad focus tod deta
   *    hai). Bas auto-infinite-scroll band karke "Load More" button dikha
   *    dete hain — TV pe ye behtar UX bhi hai (remote se deliberate action)
   *    aur DOM bounded rehta hai.
   * ───────────────────────────────────────────────────────────────────── */
  function tvCardBudget() {
    const tier = tvTier();
    return tier === 'high' ? 60 : tier === 'mid' ? 36 : 24;
  }

  function enforceCardBudget() {
    const grid = document.getElementById('movieGrid');
    const trigger = document.getElementById('infiniteScrollTrigger');
    const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
    if (!grid || !trigger) return;

    // Search results aur watchlist finite hote hain — unka trigger already
    // chhupa hota hai, usme dakhal nahi dena.
    if (trigger.style.display === 'none' && !trigger.dataset.mzTvBudget) return;

    const cards = grid.getElementsByClassName('movie-card').length;
    const overBudget = cards >= tvCardBudget();

    if (overBudget) {
      trigger.dataset.mzTvBudget = '1';
      trigger.style.display = 'none';
      if (loadMoreBtn) {
        /*  Bina shart ke dikhana ZAROORI hai: loadMovies() har render ke baad
         *  is button ko `display:none` kar deta hai ("Always hide button for
         *  infinite scroll"). Agar hum sirf tab dikhate jab wo hidden ho, to
         *  ek race me button chhupa reh jaata aur trigger bhi hidden hota —
         *  matlab user ke paas aur content load karne ka koi rasta hi nahi
         *  bachta (dead end). */
        loadMoreBtn.style.display = '';
        if (!loadMoreBtn.dataset.mzTvHooked) {
          loadMoreBtn.dataset.mzTvHooked = '1';
          loadMoreBtn.addEventListener('click', () => {
            delete trigger.dataset.mzTvBudget;
            // Safety net: agar naya batch nahi aaya (last page), grid mutate
            // nahi hoga aur observer bhi nahi chalega — to khud dobara check.
            setTimeout(enforceCardBudget, 1200);
          }, { passive: true });
        }
      }
    } else if (trigger.dataset.mzTvBudget) {
      delete trigger.dataset.mzTvBudget;
      trigger.style.display = '';
    }
  }

  /* Grid badalne par (render / load more) budget + measurement refresh karo.
   * MutationObserver sirf render pe fire hota hai, scroll pe nahi — to ye
   * sasta hai. */
  function watchGrid() {
    const grid = document.getElementById('movieGrid');
    if (!grid || typeof MutationObserver !== 'function') return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scheduleMeasure();
        enforceCardBudget();
      });
    }).observe(grid, { childList: true });
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 5. Hero carousel: screen pe na ho to autoplay band.
   *    Pehle ye har 5.5 second me full-screen backdrop swap karta rehta tha
   *    chahe user bahut neeche grid dekh raha ho — TV pe scrolling ke dauraan
   *    saaf stutter aata tha. pauseAutoSlide()/resumeAutoSlide() already
   *    progress bar ko bhi handle karte hain, to sync nahi tootega.
   *    (Ye optimization har device ke liye faydemand hai, sirf TV nahi.)
   * ───────────────────────────────────────────────────────────────────── */
  function pauseCarouselWhenHeroHidden() {
    const hero = document.getElementById('hero');
    if (!hero || typeof IntersectionObserver !== 'function') return;
    if (typeof pauseAutoSlide !== 'function' || typeof resumeAutoSlide !== 'function') return;

    new IntersectionObserver((entries) => {
      const visible = entries[0] && entries[0].isIntersecting;
      if (visible) {
        if (!document.hidden) { try { resumeAutoSlide(); } catch (e) {} }
      } else {
        try { pauseAutoSlide(); } catch (e) {}
      }
    }, { threshold: 0.15 }).observe(hero);
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 6. Boot
   * ───────────────────────────────────────────────────────────────────── */
  let started = false;
  function start() {
    if (started || !onTV()) return;
    started = true;
    injectTVCss();
    applyTVClasses();
    scheduleMeasure();
    watchGrid();
    enforceCardBudget();

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(scheduleMeasure, 250);
    }, { passive: true });

    console.log('[MovieZone TV] performance mode on — tier:', tvTier(), '| card budget:', tvCardBudget());
  }

  // Hero carousel optimization har device pe chalti hai.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pauseCarouselWhenHeroHidden, { once: true });
  } else {
    pauseCarouselWhenHeroHidden();
  }

  start();

  /* tv-mode.js `data-mz-tv` aur `data-mz-tv-tier` async set karta hai (aur
   * baad me tier downgrade bhi kar sakta hai). Isliye attribute changes
   * dekhte rehte hain. */
  if (!started && typeof MutationObserver === 'function') {
    const attrObserver = new MutationObserver(() => {
      if (onTV()) { start(); attrObserver.disconnect(); }
    });
    attrObserver.observe(root, { attributes: true, attributeFilter: ['data-mz-tv', 'data-mz-tv-ready'] });
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (!onTV()) return;
      if (tvTier() !== 'high') root.classList.add('low-end-mode');
      else root.classList.remove('low-end-mode');
    }).observe(root, { attributes: true, attributeFilter: ['data-mz-tv-tier', 'data-mz-tv-downgraded'] });
  }
})();
