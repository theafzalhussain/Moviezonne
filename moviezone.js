﻿﻿﻿// Improved Localhost Detection: Includes local IPs (192.168.x.x) often used in testing
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.');
// TV detection is handled by tv-mode.js which sets html[data-mz-tv="true"].
// This getter reads the data attribute set by the isolated TV module.
const isMzTV = () => document.documentElement.getAttribute('data-mz-tv') === 'true';

// Balanced Performance: phones/tablets use low-end mode; confirmed TVs use data-mz-tv.
const isMobile = !isMzTV() && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const isLowEnd = (navigator.deviceMemory && navigator.deviceMemory < 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4);
const isTouchOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(pointer: fine)').matches;

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
(function largeScreenPerf() {
  if (window.innerWidth >= 1920) document.documentElement.classList.add('large-screen-mode');
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
// -- PREMIUM CURSOR GLOW & CLICK SPARKS --
// Disable on TV, Touch, and Mobile to save CPU/battery and ensure smooth performance
if (!isMzTV() && !isTouchOnly && !isMobile) {
  const cursorGlow = document.getElementById('cursor-glow');
  const cursorRing = document.getElementById('cursor-ring');
  const cursorDot = document.getElementById('cursor-dot');
  
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let ringX = mouseX;
  let ringY = mouseY;
  
  let cursorIdleTimer;
  let isCursorMoving = true;
  let cursorRafId = 0;

  /*  INP — the mousemove handler used to write cursorGlow.style.transform and
   *  cursorDot.style.transform directly. Every pointer move (and a mouse emits
   *  them far faster than 60 Hz) therefore dirtied style inside the input task,
   *  so any interaction that landed in the same frame queued behind that work.
   *
   *  The handler now only records coordinates - the writes happen once per frame
   *  in animateCursorRing, which already existed and already ran on rAF. Same
   *  pixels, one style write per frame instead of one per event.
   */
  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    isCursorMoving = true;
    clearTimeout(cursorIdleTimer);
    cursorIdleTimer = setTimeout(() => { isCursorMoving = false; }, 150);
    startCursorLoop();
  }, { passive: true });

  // Smooth 3D Trailing Animation for the Ring
  /*  This loop used to call requestAnimationFrame unconditionally, forever: on
   *  every desktop visit the browser ran a main-thread task every frame for the
   *  whole session, even with the mouse parked. It now parks itself once the ring
   *  has caught up with the pointer, and mousemove restarts it. Idle desktop
   *  sessions go from 60 tasks/second to zero, which is main-thread budget that
   *  interactions get to use instead.
   */
  function animateCursorRing() {
    const settled = !isCursorMoving &&
      Math.abs(mouseX - ringX) <= 0.1 && Math.abs(mouseY - ringY) <= 0.1;

    if (!settled) {
      // Super Fast Cursor Speed (0.45 is 2.5x faster than 0.18)
      ringX += (mouseX - ringX) * 0.45;
      ringY += (mouseY - ringY) * 0.45;

      if (cursorRing) {
        const velX = mouseX - ringX;
        const velY = mouseY - ringY;
        const rotateX = -velY * 0.8;
        const rotateY = velX * 0.8;

        // Use pure hardware-accelerated transform instead of top/left
        cursorRing.style.transform = `translate3d(${ringX}px, ${ringY}px, 0) translate(-50%, -50%) perspective(500px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(5px)`;
      }
    }

    // Batched pointer-follow writes, moved here out of the mousemove handler.
    const follow = `translate3d(${mouseX}px, ${mouseY}px, 0) translate(-50%, -50%)`;
    if (cursorGlow) cursorGlow.style.transform = follow;
    if (cursorDot) cursorDot.style.transform = follow;

    if (settled) { cursorRafId = 0; return; }
    cursorRafId = requestAnimationFrame(animateCursorRing);
  }

  function startCursorLoop() {
    if (!cursorRafId) cursorRafId = requestAnimationFrame(animateCursorRing);
  }
  startCursorLoop();

  // Interactive Hover Glow Effects
  const interactiveElements = 'a, button, .movie-card, .upcoming-card, .thumb, .cat-tab, input, select, .player-chip, .nav-logo';
  document.body.addEventListener('mouseover', (e) => {
    if (e.target.closest(interactiveElements)) document.body.classList.add('cursor-hover');
  });
  document.body.addEventListener('mouseout', (e) => {
    if (e.target.closest(interactiveElements)) document.body.classList.remove('cursor-hover');
  });

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

// -- SERVER PRECONNECT (FAST STREAMING, LCP-SAFE) --
// Pehle ye function turant 7 servers se preconnect (DNS+TCP+TLS) karta tha. Wo
// 7 handshakes first poster download se compete karte the aur LCP (Google ka
// Core Web Vitals ranking factor) late ho jata tha.
// Ab: DNS resolve turant (sasta hai), TLS handshake page interactive hone ke
// baad idle time me. Playback speed same, LCP fast. Movie khulte waqt
// openModal() already preconnectPlayerHosts(4) call karta hai.
(function preconnectServers() {
  const servers = ['https://www.viduki.net', 'https://cinextream.net', 'https://www.2embed.stream', 'https://vidnest.fun', 'https://vidsrc.sbs', 'https://multiembed.mov', 'https://autoembed.co'];

  const addHint = (rel, url, crossOrigin) => {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = url;
    if (crossOrigin) link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  };

  // Cheap: DNS only, no socket. Safe to do immediately.
  servers.forEach(url => addHint('dns-prefetch', url));

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && (conn.saveData || ['slow-2g', '2g'].indexOf(conn.effectiveType) !== -1)) return;

  // Expensive: full TLS handshake — only for the two most-used providers, and
  // only once the browser is idle (i.e. after the first paint is done).
  const warm = () => servers.slice(0, 2).forEach(url => addHint('preconnect', url, true));
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
let currentSlide = 0;
let carouselMovies = [];
let autoSlideTimer = null;
let isLoadingMore = false;
let isSearchResultsMode = false;
let renderMoviesRunId = 0;
let renderMoviesTimer = null;
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

function resetRestoredWatchSurface() {
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
 *  ══════════════════════════════════════════════════════════════════════
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
 */
const MZ_MAX_CONCURRENT_FETCHES = 4;

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

  let qs = '';
  if (Object.keys(params).length) {
    qs = '?' + Object.entries(params).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  }
  const urlStr = BASE + endpoint + qs;

  
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
      // Agar data 12 ghante se naya hai, toh fresh manenge
      if (parsed.timestamp && (Date.now() - parsed.timestamp < 12 * 60 * 60 * 1000)) {
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
  function initNonCritical() {
    loadUpcoming();
  }

  try {
    // Load carousel and movies in parallel (Promise.allSettled ensures one failure doesn't block other)
    await Promise.allSettled([
      loadCarousel(),
      loadMovies('all')
    ]);

    // 3. Delay upcoming fetching until the page has settled.
    setTimeout(() => {
      if ('requestIdleCallback' in window) requestIdleCallback(initNonCritical, { timeout: 5000 });
      else initNonCritical();
    }, 800);

    // 4. Safety net only. index.html already drops the loader on DOMContentLoaded,
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

  // Luxury Ambient Particles (Jugnu)
  // Only create on desktop - mobile/TV gets zero particles for performance
  if (!isMzTV() && !isMobile && !document.querySelector('.ambient-particles')) {
    const pContainer = document.createElement('div');
    pContainer.className = 'ambient-particles';
    document.body.appendChild(pContainer);

    // Optimized: 18 Fireflies for desktop (was 35 - less GPU load)
    const particleCount = isLowEnd ? 8 : 18;
    for (let i = 0; i < particleCount; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      
      let size = Math.random() * 3.5 + 1.5; // Size between 1.5px to 5px
      const isGold = Math.random() > 0.5;

      // Randomly assign gold or accent colors
      if (isGold) {
        // Minor size boost for golden fireflies ONLY on large screens
        if (!isMobile) {
          size = size * 1.5 + 1;
        }
        
        p.style.setProperty('--p-color', 'var(--gold)');
        p.style.setProperty('--p-glow1', 'var(--gold)');
        p.style.setProperty('--p-glow2', 'var(--gold2)');
        p.style.setProperty('--p-glow3', 'var(--gold3)');
      } else {
        p.style.setProperty('--p-color', 'var(--accent)');
        p.style.setProperty('--p-glow1', 'var(--accent)');
        p.style.setProperty('--p-glow2', 'var(--accent2)');
        p.style.setProperty('--p-glow3', 'var(--accent3)');
      }

      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 100 + 'vw';
      p.style.setProperty('--duration', (Math.random() * 18 + 12) + 's'); // Float speed (12s to 30s)
      p.style.setProperty('--drift', (Math.random() * 160 - 80) + 'px'); // Left/Right sway (-80px to 80px)
      p.style.animationDelay = '-' + (Math.random() * 25) + 's'; // Start instantly at different heights

      pContainer.appendChild(p);
    }
  }

  setupInfiniteScroll();
  setupUpcomingInfiniteScroll();
}

function setupInfiniteScroll() {
    const trigger = document.getElementById('infiniteScrollTrigger');
    if (!trigger) return;

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

/*  How long a card keeps its "NEW HD / NEW FHD / NEW 4K" ribbon after the print
 *  improved. Roughly matches how long the top freshness tiers keep it lifted. */
const QUALITY_UPGRADE_BADGE_DAYS = 21;

function freshnessTier(title, eventAgeDays) {
  const relevant = (title.popularity || 0) >= FRESH_TIER_MIN_POPULARITY
    || (title.vote_count || 0) >= FRESH_TIER_MIN_VOTES;
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
 *    2 — every other movie
 *    3 — relevant latest/trending web series and anime
 *    4 — remaining series/anime fallback
 *
 *  This guarantees that an even fresher TV premiere cannot jump above a latest
 *  movie release or a movie whose HD/FHD/4K print just landed. The relevance
 *  gate still prevents obscure one-vote titles from entering a fresh group. */
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
    return 2;
  }

  return hasFreshRelevance ? 3 : 4;
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

async function loadCarousel() {
  const _mzCarouselFailureMark = _mzFetchFailureCount;
  // FETCH FROM ALL MAJOR CATEGORIES IN PARALLEL (Professional-grade discovery)
  const results = await Promise.allSettled([
    tmdb('/trending/movie/week', { language: 'en-US', page: '1' }),
    tmdb('/trending/movie/day', { language: 'en-US', page: '1' }),
    tmdb('/movie/popular', { language: 'en-US', page: '1' }),
    tmdb('/movie/top_rated', { language: 'en-US', page: '1' }),
    tmdb('/movie/now_playing', { language: 'en-US', page: '1' }),
    tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', language: 'en-US', page: '1' }),
    tmdb('/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', language: 'en-US', page: '1' }),
    tmdb('/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', language: 'en-US', page: '1' }),
    tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', language: 'en-US', page: '1' }),
    tmdb('/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc', language: 'en-US', page: '1' })
  ]);

  const sourceNames = ['trending_week','trending_day','popular','top_rated','now_playing','bollywood','south','tollywood','anime','korean'];

  // Combine all results into a master pool with source tags (safely handle null/undefined)
  const masterPool = [];
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value && r.value.results) {
      r.value.results.forEach(m => { if (m) { m._source = sourceNames[idx]; masterPool.push(m); } });
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

  // FORCED REPRESENTATION: Ensure EVERY category gets at least 1 slot in carousel
  const diverseCarousel = [];
  const usedIds = new Set();
  
  // Step 1: Pick the BEST movie from each language/category (guaranteed slots)
  // First try from candidates (with backdrop), then fallback to allReleased (poster only)
  const langGroupsBackdrop = {};
  const langGroupsAll = {};
  candidates.forEach(m => {
    const lang = m.original_language || 'en';
    if (!langGroupsBackdrop[lang]) langGroupsBackdrop[lang] = [];
    langGroupsBackdrop[lang].push(m);
  });
  allReleased.forEach(m => {
    const lang = m.original_language || 'en';
    if (!langGroupsAll[lang]) langGroupsAll[lang] = [];
    langGroupsAll[lang].push(m);
  });
  
  // Priority order: English (Hollywood), Hindi (Bollywood), Tamil (South), Telugu (Tollywood), Korean, Japanese (Anime)
  const priorityLangs = ['en', 'hi', 'ta', 'te', 'ko', 'ja'];
  
  // Pick top 1 from each priority language (prefer backdrop, fallback to poster-only)
  for (const lang of priorityLangs) {
    if (diverseCarousel.length >= 10) break;
    
    // Try with backdrop first
    const backdropPool = langGroupsBackdrop[lang] || [];
    let best = backdropPool.find(m => !usedIds.has(m.id));
    
    // Fallback: pick from poster-only pool
    if (!best) {
      const allPool = langGroupsAll[lang] || [];
      best = allPool.find(m => !usedIds.has(m.id));
    }
    
    if (best) {
      diverseCarousel.push(best);
      usedIds.add(best.id);
    }
  }
  
  // Step 2: Fill remaining slots (up to 10) with highest scored movies regardless of language
  // But don't allow more than 3 from same language total
  const langCount = {};
  diverseCarousel.forEach(m => {
    const lang = m.original_language || 'en';
    langCount[lang] = (langCount[lang] || 0) + 1;
  });
  
  for (const movie of candidates) {
    if (diverseCarousel.length >= 10) break;
    if (usedIds.has(movie.id)) continue;
    
    const lang = movie.original_language || 'en';
    if ((langCount[lang] || 0) >= 3) continue; // Max 3 per language
    
    diverseCarousel.push(movie);
    usedIds.add(movie.id);
    langCount[lang] = (langCount[lang] || 0) + 1;
  }
  
  // Step 3: Keep carousel in mixed order (forced picks first gives natural diversity)
  // No re-sorting - the forced representation already ensures mix
  
  // If diversity filter was too strict, just take top scored movies
  if (diverseCarousel.length < 4) {
    const fallback = candidates.filter(m => !usedIds.has(m.id)).slice(0, 10 - diverseCarousel.length);
    diverseCarousel.push(...fallback);
  }
  
  // Assign dynamic carousel badges based on category + context
  diverseCarousel.forEach(m => {
    const daysSince = (Date.now() - new Date(m.release_date || '2020-01-01')) / (1000 * 60 * 60 * 24);
    const lang = m.original_language || 'en';
    
    // Priority: Freshness > Category-specific > Generic
    if (daysSince <= 7) {
      m._badge = '🔥 JUST RELEASED';
    } else if (daysSince <= 30 && m._source === 'now_playing') {
      m._badge = '🎬 NOW IN THEATERS';
    } else if (lang === 'hi' && m.vote_average >= 7.0) {
      m._badge = '🎬 BOLLYWOOD HIT';
    } else if (lang === 'hi') {
      m._badge = '🎬 BOLLYWOOD TRENDING';
    } else if (lang === 'ta') {
      m._badge = '🔥 SOUTH BLOCKBUSTER';
    } else if (lang === 'te') {
      m._badge = '🔥 TOLLYWOOD HIT';
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
    } else if (m._source === 'top_rated') {
      m._badge = '🏆 TOP RATED';
    } else {
      m._badge = '🔥 POPULAR NOW';
    }
  });

  carouselMovies = diverseCarousel.slice(0, 10);
  if (carouselMovies.length === 0) carouselMovies = candidates.slice(0, 6); // Ultimate fallback
  console.log('🎬 Carousel Movies:', carouselMovies.map(m => `${m.title || m.name} (${m.original_language})`));
  buildCarousel();
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
 
  carouselMovies.forEach((m, i) => {
    const genres = (m.genre_ids||[]).slice(0,3).map(id => '<span class="genre-tag">'+escapeHTML(GENRE_MAP[id]||'Movie')+'</span>').join('');
    const slide = document.createElement('div');
    slide.className = 'carousel-slide' + (i === 0 ? ' active' : '');
    const bgUrl = m.backdrop_path ? getResponsiveBackdrop(m.backdrop_path) : `https://image.tmdb.org/t/p/w780${m.poster_path}`;

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
     *  is on the critical path.
     */
    const heroImg = i === 0
      ? '<img class="slide-bg-img" src="' + bgUrl + '" alt="" width="1280" height="720" style="aspect-ratio:16/9;object-fit:cover;" fetchpriority="high" decoding="async" draggable="false">'
      : '';

    if (i === 0) {
      // Remember the URL so the NEXT visit can start this exact request from the
      // pre-paint hint in <head>, before this bundle has even been parsed.
      // Read back by the mz_hero_lcp block in index.html (6 h TTL enforced there).
      try {
        localStorage.setItem('mz_hero_lcp', JSON.stringify({ u: bgUrl, t: Date.now() }));
      } catch (e) { /* quota / private mode - the hint is optional */ }
    }

    slide.innerHTML =
      '<div class="slide-bg"' + (i === 0 ? '' : ' data-bg="' + bgUrl + '"') + '>' + heroImg + '</div>' +
      '<div class="slide-gradient"></div>' +
      '<div class="slide-content">' +
        '<div class="slide-badge">'+(m._badge || '🔥 TRENDING NOW')+'</div>' +
        // SEO: carousel slides use <h2>, not <h1>. The page must expose exactly
        // one <h1> (the one in index.html); 6 competing <h1>s split the topical
        // signal Google reads from the page. Styling is class-based, so the
        // .slide-title look is unchanged.
        '<h2 class="slide-title">'+escapeHTML(m.title||m.name||'')+'</h2>' +
        '<div class="slide-meta">' +
          '<div class="slide-rating">RATING '+((m.vote_average||0).toFixed(1))+'</div>' +
          '<span class="slide-year">'+((m.release_date||'').slice(0,4))+'</span>' +
          '<span class="slide-runtime">LANG '+(m.original_language||'EN').toUpperCase()+'</span>' +
        '</div>' +
        '<div class="slide-genres">'+genres+'</div>' +
        '<p class="slide-desc">'+escapeHTML(m.overview||'')+'</p>' +
        '<div class="slide-actions">' +
          '<button class="btn-play" tabindex="0" data-id="'+m.id+'" data-type="'+(m.media_type||(m.title?'movie':'tv'))+'"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Play Now</button>' +
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
  });
 
  track.appendChild(trackFrag);
  dots.appendChild(dotsFrag);
  thumbs.appendChild(thumbsFrag);
 
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
 
  startAutoSlide();
}
 
// Sets the background-image of a slide only once it's about to be shown (lazy loading)
function ensureSlideBg(idx) {
  const slides = document.querySelectorAll('.carousel-slide');
  const slide = slides[idx];
  if (!slide) return;
  const bg = slide.querySelector('.slide-bg');
  if (bg && bg.dataset.bg && !bg.style.backgroundImage) {
    bg.style.backgroundImage = "url('" + bg.dataset.bg + "')";
  }
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
}
 
/* ── AUTOPLAY ─────────────────────────────────────────────────────────────
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
                langs: 'hi|ta|te|kn|ml|bn|mr|pa|gu|or' }
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
// OTT SUB-FILTER: Web Series & Movies (like Cartoons sub-tabs)
// ══════════════════════════════════════════════════════════════════════════
const OTT_MODES = [
  { id: 'all',       label: 'All',          icon: '🎬' },
  { id: 'webseries', label: 'Web Series',   icon: '📺' },
  { id: 'movies',    label: 'Movies',       icon: '🍿' }
];

let currentOttMode = 'all';

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
  zee5:       ['232']
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
  const p1 = String(page * 2 - 1);
  const p2 = String(page * 2);
  const pg = String(page);
  const today = ottISTDate(0);

  // The provider gate every single query inherits.
  const gate = {
    with_watch_providers: cfg.provider,
    watch_region: 'IN',
    with_watch_monetization_types: OTT_MONETIZATION,
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
async function ottVerifiedTrending(key, mode, page) {
  const pg = String(page);
  const wants = [];
  if (mode !== 'movies') wants.push({ endpoint: '/trending/tv/week', type: 'tv' });
  if (mode !== 'webseries') wants.push({ endpoint: '/trending/movie/week', type: 'movie' });

  const res = await Promise.allSettled(
    wants.map(w => tmdb(w.endpoint, { language: 'en-US', page: pg }))
  );

  const candidates = [];
  res.forEach((r, i) => {
    const list = (r.status === 'fulfilled' && r.value && r.value.results) ? r.value.results : [];
    // Top slice only — the tail of the trending list is not worth verifying.
    list.slice(0, 10).forEach(raw => {
      if (!raw || !raw.poster_path || !raw.id) return;
      const item = Object.assign({}, raw);
      item.media_type = wants[i].type;
      candidates.push(item);
    });
  });

  const verdicts = await Promise.all(
    candidates.map(c => ottIsOnPlatform(key, c.media_type, c.id))
  );
  return candidates.filter((c, i) => verdicts[i]);
}

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

async function ottEnforceAccuracy(key, items) {
  if (items.length < 4) return items;

  const sample = items.slice(0, OTT_SAMPLE_SIZE);
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

  // Provider-gated catalogue and the verified-trending overlay, in parallel.
  const [res, verifiedTrending] = await Promise.all([
    Promise.allSettled(plan.map(p => tmdb(p.endpoint, p.params))),
    ottVerifiedTrending(key, mode, page).catch(() => [])
  ]);

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

  // Verified trending sits above everything else — it is both confirmed on
  // the platform and confirmed hot right now.
  verifiedTrending.forEach(item => consider(item, item.media_type, 'trend', 4000));

  const ranked = Array.from(picked.values()).sort((a, b) => b._ottScore - a._ottScore);
  return ottEnforceAccuracy(key, ranked);
}

// ── OTT SUB-FILTER BAR (chips under category tabs) ──
function renderOttFilterBar() {
  const catTabs = document.getElementById('catTabs');
  if (!catTabs) return;
  let bar = document.getElementById('ottFilterBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ottFilterBar';
    bar.className = 'anime-filter-bar ott-filter-bar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'OTT content filters');
    catTabs.insertAdjacentElement('afterend', bar);
  }
  bar.innerHTML = OTT_MODES.map(m => {
    const active = m.id === currentOttMode;
    return `<button type="button" class="anime-chip${active ? ' active' : ''}" role="tab" tabindex="0" aria-selected="${active}" onclick="setOttMode('${m.id}')"><span class="anime-chip-icon" aria-hidden="true">${m.icon}</span><span>${m.label}</span></button>`;
  }).join('');
  bar.style.display = 'flex';
}

function hideOttFilterBar() {
  const bar = document.getElementById('ottFilterBar');
  if (bar) bar.style.display = 'none';
}

function updateOttHeading(cat) {
  const h = document.getElementById('sectionHeading');
  if (!h) return;
  const platformName = CAT_HEADINGS[cat] || cat.toUpperCase();
  const m = OTT_MODES.find(x => x.id === currentOttMode) || OTT_MODES[0];
  if (currentOttMode === 'all') {
    h.textContent = platformName;
  } else {
    h.textContent = platformName + ' • ' + m.label.toUpperCase();
  }
}

function setOttMode(mode) {
  if (!OTT_MODES.some(m => m.id === mode)) mode = 'all';
  currentOttMode = mode;
  renderOttFilterBar();
  // Find which OTT platform is currently active
  const activeTab = document.querySelector('.cat-tab.active');
  let ottCat = 'netflix';
  if (activeTab) {
    const match = (activeTab.getAttribute('onclick') || '').match(/'([^']+)'/);
    if (match && OTT[match[1]]) ottCat = match[1];
  }
  updateOttHeading(ottCat);
  loadMovies(ottCat);
}

// -- BACKGROUND PREFETCH HELPERS (For Instant "Load More") --
function prefetchMoviesPage(cat, pageNum) {
  const pageStr = String(pageNum);
  const p1 = String(pageNum * 2 - 1);
  const p2 = String(pageNum * 2);
  if (cat === 'all') {
    tmdb('/trending/movie/week', { language: 'en-US', page: pageStr });
    tmdb('/trending/movie/day', { language: 'en-US', page: pageStr });
    tmdb('/movie/popular', { language: 'en-US', page: pageStr });
    tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/movie/now_playing', { language: 'en-US', page: pageStr });
    // Same freshness windows loadMovies('all') uses — identical params so the
    // prefetch actually warms the cache instead of missing it.
    tmdb('/discover/movie', latestWindowQuery(pageStr));
    tmdb('/discover/movie', printUpgradeWindowQuery(pageStr));
    tmdb('/trending/tv/week', { language: 'en-US', page: pageStr });
    tmdb('/discover/tv', latestSeriesWindowQuery(pageStr));
    tmdb('/discover/tv', seriesUpgradeWindowQuery(pageStr));
    tmdb('/discover/tv', latestAnimeWindowQuery(pageStr));
  } else if (cat === 'hollywood') {
    tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p1 });
    tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p2 });
  } else if (cat === 'tv') {
    const STREAMING_NETWORKS = STREAMING_NETWORK_IDS;
    const TV_CHANNELS_TO_EXCLUDE = LINEAR_TV_EXCLUDE_IDS;
    tmdb('/discover/tv', { with_networks: STREAMING_NETWORKS, without_networks: TV_CHANNELS_TO_EXCLUDE, with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/tv', { with_networks: STREAMING_NETWORKS, without_networks: TV_CHANNELS_TO_EXCLUDE, with_original_language: 'en', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/tv', { with_networks: STREAMING_NETWORKS, without_networks: TV_CHANNELS_TO_EXCLUDE, with_original_language: 'ko', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/tv', { with_networks: STREAMING_NETWORKS, without_networks: TV_CHANNELS_TO_EXCLUDE, sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
  } else if (cat === 'kids') {
    // Cartoon engine ke active-mode sources chupke se warm kar do
    buildCartoonQueries(currentCartoonMode, pageNum).forEach(q => tmdb(q.endpoint, q.params));
  } else if (cat === 'anime') {
    // Anime engine ke saare active-mode sources ko chupke se warm kar do
    buildAnimeQueries(currentAnimeMode, pageNum).forEach(q => tmdb(q.endpoint, q.params));
  } else if (cat === 'adult') {
    tmdb('/discover/movie', { include_adult: 'true', with_keywords: '9799|195669|156321', without_genres: '16,10751,28,12,35,878', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/tv', { include_adult: 'true', with_keywords: '9799|195669|156321', without_genres: '16,10751,10759,10762,35', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { include_adult: 'true', with_keywords: '9799|195669|156321', with_original_language: 'hi', without_genres: '16,10751,28,12,35,878', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { include_adult: 'true', with_keywords: '9799|195669|156321', with_original_language: 'ta', without_genres: '16,10751,28,12,35,878', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { include_adult: 'true', with_keywords: '9799|195669|156321', with_original_language: 'te', without_genres: '16,10751,28,12,35,878', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { include_adult: 'true', certification_country: 'US', certification: 'NC-17', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
  } else if (cat === 'horror') {
    tmdb('/discover/movie', { with_genres: '27', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { with_genres: '27', with_original_language: 'hi', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { with_genres: '27', with_original_language: 'ta', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { with_genres: '27', with_original_language: 'te', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
  } else if (cat === 'dubbed') {
    tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p1 });
    tmdb('/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', language: 'en-US', page: p1 });
    tmdb('/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', language: 'en-US', page: p1 });
    tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', language: 'en-US', page: p1 });
  
  }
  else if (cat === 'trending') {
    tmdb('/trending/movie/week', { language: 'en-US', page: p1 });
    tmdb('/trending/movie/day', { language: 'en-US', page: pageStr });
    tmdb('/trending/tv/week', { language: 'en-US', page: pageStr });
    tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', 'vote_count.gte': '50', page: pageStr, language: 'en-US' });
  }
  else if (cat === 'uhd4k') {
    const uhdCutoff = new Date(Date.now() - 240 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const uhdBase = { sort_by: 'popularity.desc', 'primary_release_date.lte': uhdCutoff, 'vote_average.gte': '7', language: 'en-US' };
    tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'en', 'vote_count.gte': '300', page: p1 }));
    tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'en', 'vote_count.gte': '300', page: p2 }));
    tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'hi', 'vote_count.gte': '40', page: p1 }));
    tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'hi', 'vote_count.gte': '40', page: p2 }));
    tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'te', 'vote_count.gte': '30', page: p1 }));
    tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'ta', 'vote_count.gte': '30', page: p1 }));
    tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'ko', 'vote_count.gte': '60', page: p1 }));
    tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'ml', 'vote_count.gte': '25', page: p1 }));
  }
  else if (cat === 'toprated') {
    tmdb('/movie/top_rated', { language: 'en-US', page: p1 });
    tmdb('/movie/top_rated', { language: 'en-US', page: p2 });
    tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: p1, language: 'en-US' });
    tmdb('/discover/tv', { sort_by: 'vote_average.desc', 'vote_count.gte': '300', page: p1, language: 'en-US' });
  }
  else if (cat === 'kdrama') {
    tmdb('/discover/tv', { with_original_language: 'ko', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/tv', { with_original_language: 'ko', sort_by: 'popularity.desc', page: p2, language: 'en-US' });
    tmdb('/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
  }
  else if (OTT[cat]) {
    // Netflix / Prime / JioHotstar / Zee5 — use active OTT mode for prefetch
    buildOttModeQueries(cat, currentOttMode, pageNum).forEach(q => tmdb(q.endpoint, q.params));
  }
  else {
    const base = Object.assign({}, CAT_PARAMS[cat] || {}, { language: 'en-US' });
    tmdb('/discover/movie', Object.assign({}, base, { page: p1 }));
    tmdb('/discover/movie', Object.assign({}, base, { page: p2 }));
  }
}
 
function prefetchUpcomingPage(pageNum) {
  const p1 = String(pageNum * 2 - 1);
  const p2 = String(pageNum * 2);
  const d = new Date(); d.setDate(d.getDate() - 1); const today = d.toISOString().split('T')[0];
  d.setMonth(d.getMonth() + 3); const future = d.toISOString().split('T')[0];
  tmdb('/discover/movie', { language: 'en-US', page: p1, sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'en' });
  tmdb('/discover/movie', { language: 'en-US', page: p2, sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'en' });
  tmdb('/discover/movie', { language: 'en-US', page: p1, sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'hi', region: 'IN' });
  tmdb('/discover/movie', { language: 'en-US', page: p2, sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'hi', region: 'IN' });
}
 
// -- LOAD MOVIES
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
    catTabs.insertAdjacentElement('afterend', bar);
  }
  bar.innerHTML = ANIME_MODES.map(m => {
    const active = m.id === currentAnimeMode;
    return `<button type="button" class="anime-chip${active ? ' active' : ''}" role="tab" tabindex="0" aria-selected="${active}" onclick="setAnimeMode('${m.id}')"><span class="anime-chip-icon" aria-hidden="true">${m.icon}</span><span>${m.label}</span></button>`;
  }).join('');
  bar.style.display = 'flex';
}

function hideAnimeFilterBar() {
  const bar = document.getElementById('animeFilterBar');
  if (bar) bar.style.display = 'none';
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
    catTabs.insertAdjacentElement('afterend', bar);
  }
  bar.innerHTML = CARTOON_MODES.map(m => {
    const active = m.id === currentCartoonMode;
    return `<button type="button" class="anime-chip${active ? ' active' : ''}" role="tab" tabindex="0" aria-selected="${active}" onclick="setCartoonMode('${m.id}')"><span class="anime-chip-icon" aria-hidden="true">${m.icon}</span><span>${m.label}</span></button>`;
  }).join('');
  bar.style.display = 'flex';
}

function hideCartoonFilterBar() {
  const bar = document.getElementById('cartoonFilterBar');
  if (bar) bar.style.display = 'none';
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

async function loadMovies(cat, isLoadMore = false) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;
  
  if (!cat) cat = 'all';
  
  if (isLoadMore) {
    if (isLoadingMore) return;
    isLoadingMore = true;
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) indicator.style.display = 'block';
    currentMoviePage++;
  } else {
    currentMoviePage = 1;
    grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
    allMovies = [];
  }
 
  let movies = [];
  const pageStr = String(currentMoviePage);
  const p1 = String(currentMoviePage * 2 - 1);
  const p2 = String(currentMoviePage * 2);

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
    if (cat === 'all') {
      // NETFLIX-STYLE DISCOVERY: Fetch diverse sources for maximum content freshness
      //
      // The last six queries exist for the freshness ranking below and are the
      // reason it can actually work:
      //   • LATEST WINDOWS — the most popular movies (last ~5 weeks), web series
      //     (last ~6 weeks) and anime seasons (last ~2 months), so whatever just
      //     released is always in the candidate pool rather than whatever
      //     /movie/popular happens to return.
      //   • PRINT-UPGRADE WINDOWS — the cohorts that just crossed a real print
      //     stage: movies at the HD/FHD marks, series at their clean-encode and
      //     BD/4K marks. Without deliberately fetching them, a four-month-old
      //     film whose HD print just dropped would never appear in the pool, so
      //     no amount of re-ranking could surface it.
      //
      // Series and anime are also the only way TV reaches this feed at all —
      // before this it fetched movies exclusively.
      const res = await Promise.allSettled([
        tmdb('/movie/now_playing', { language: 'en-US', page: pageStr }),
        tmdb('/trending/movie/week', { language: 'en-US', page: pageStr }),
        tmdb('/trending/movie/day', { language: 'en-US', page: pageStr }),
        tmdb('/movie/popular', { language: 'en-US', page: pageStr }),
        tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', latestWindowQuery(pageStr)),
        tmdb('/discover/movie', printUpgradeWindowQuery(pageStr)),
        tmdb('/trending/tv/week', { language: 'en-US', page: pageStr }),
        tmdb('/discover/tv', latestSeriesWindowQuery(pageStr)),
        tmdb('/discover/tv', seriesUpgradeWindowQuery(pageStr)),
        tmdb('/discover/tv', latestAnimeWindowQuery(pageStr))
      ]);
      
      // /discover/tv results carry no media_type, so tag them here instead of
      // relying on the name-vs-title guess further down the pipeline.
      const TV_SOURCE_FROM = 11;
      const combinedMovies = [];
      res.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value && r.value.results) {
          r.value.results.forEach(item => {
            if (!item) return;
            if (idx >= TV_SOURCE_FROM && !item.media_type) item.media_type = 'tv';
            combinedMovies.push(item);
          });
        }
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
      // quality updates second, remaining movies next, and only then the
      // latest/trending web series and anime.
      rankByFreshness(uniqueMovies);

      // Balance languages only inside each priority group. A skipped movie is
      // reinserted before the next group, so this pass cannot lift a series
      // above a movie release or quality update.
      movies.push(...diversifyByLanguageWithinPriority(uniqueMovies));
    } else if (cat === 'tv') {
      // EXPANDED OTT LIST: Now includes JioCinema, MX Player, HBO, aha, Hoichoi and more major platforms.
      const STREAMING_NETWORKS = STREAMING_NETWORK_IDS;
      // EXCLUSION LIST: Traditional Indian TV channels to strictly remove from Web Series section
      const TV_CHANNELS_TO_EXCLUDE = LINEAR_TV_EXCLUDE_IDS;

      // Fetch a diverse set of web series from major streaming platforms, removing traditional TV shows.
      const res = await Promise.allSettled([
        // Top Hindi Web Series from streaming platforms
        tmdb('/discover/tv', {
            with_networks: STREAMING_NETWORKS,
            without_networks: TV_CHANNELS_TO_EXCLUDE,
            with_original_language: 'hi',
            sort_by: 'popularity.desc',
            page: pageStr,
            language: 'en-US'
        }),
        // Top English Web Series from streaming platforms
        tmdb('/discover/tv', {
            with_networks: STREAMING_NETWORKS,
            without_networks: TV_CHANNELS_TO_EXCLUDE,
            with_original_language: 'en',
            sort_by: 'popularity.desc',
            page: pageStr,
            language: 'en-US'
        }),
        // Top Korean Web Series from streaming platforms
        tmdb('/discover/tv', {
            with_networks: STREAMING_NETWORKS,
            without_networks: TV_CHANNELS_TO_EXCLUDE,
            with_original_language: 'ko',
            sort_by: 'popularity.desc',
            page: pageStr,
            language: 'en-US'
        }),
        // General popular shows from these platforms as a fallback
        tmdb('/discover/tv', { 
            with_networks: STREAMING_NETWORKS, 
            without_networks: TV_CHANNELS_TO_EXCLUDE,
            sort_by: 'popularity.desc', 
            page: pageStr, 
            language: 'en-US' 
        })
      ]);

      const combinedShows = [];
      res.forEach(r => {
        if (r.status === 'fulfilled' && r.value.results) {
          combinedShows.push(...r.value.results);
        }
      });

      // Remove duplicates, keeping the first occurrence
      const uniqueShows = [];
      const seenIds = new Set();
      for (const show of combinedShows) {
        if (show && show.id && !seenIds.has(show.id)) {
          uniqueShows.push(show);
          seenIds.add(show.id);
        }
      }

      // Sort by first air date, newest first, to show latest on top
      uniqueShows.sort((a, b) => {
        const dateA = a.first_air_date || '0';
        const dateB = b.first_air_date || '0';
        return dateB.localeCompare(dateA);
      });

      movies.push(...uniqueShows);
    } else if (cat === 'hollywood') {
      const res = await Promise.all([
        tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p1 }),
        tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p2 })
      ]);
      res.forEach(r => { movies = movies.concat(r.results||[]); });
    } else if (cat === 'kids') {
      // POWERFUL CARTOON ENGINE: strictly animated content only, famous first
      movies = movies.concat(await fetchCartoonMovies(currentCartoonMode, currentMoviePage));
    } else if (cat === 'anime') {
      // POWERFUL ANIME ENGINE: mode ke hisaab se 4-9 sources parallel fetch
      movies = movies.concat(await fetchAnimeMovies(currentAnimeMode, currentMoviePage));
    } else if (cat === 'horror') {
      const res = await Promise.all([
        tmdb('/discover/movie', { with_genres: '27', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Global Horror Movies
        tmdb('/discover/movie', { with_genres: '27', with_original_language: 'hi', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Bollywood Horror
        tmdb('/discover/movie', { with_genres: '27', with_original_language: 'ta', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Tamil Horror
        tmdb('/discover/movie', { with_genres: '27', with_original_language: 'te', sort_by: 'popularity.desc', page: p1, language: 'en-US' })  // Telugu Horror
      ]);
      let maxLength = 0;
      res.forEach(r => { if (r.results && r.results.length > maxLength) maxLength = r.results.length; });
      for (let i = 0; i < maxLength; i++) {
        res.forEach(r => {
          if (r.results && i < r.results.length) {
            movies.push(r.results[i]);
          }
        });
      }
    } else if (cat === 'dubbed') {
      // Hindi Dubbed ke liye: Hollywood + Tamil + Telugu + Anime Movies (Kyunki yahi sab dub hoti hain)
      const res = await Promise.all([
        tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p1 }),
        tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p2 }),
        tmdb('/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', language: 'en-US', page: p1 }),
        tmdb('/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', language: 'en-US', page: p1 }),
        tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', language: 'en-US', page: p1 })
      ]);
      let maxLength = 0;
      res.forEach(r => { if (r.results && r.results.length > maxLength) maxLength = r.results.length; });
      for (let i = 0; i < maxLength; i++) {
        res.forEach(r => {
          if (r.results && i < r.results.length) {
            movies.push(r.results[i]);
          }
        });
      }

    } else if (cat === 'adult') {
      const res = await Promise.all([
        tmdb('/discover/movie', { include_adult: 'true', with_keywords: '9799|195669|156321', without_genres: '16,10751,28,12,35,878', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Global 18+
        tmdb('/discover/tv', { include_adult: 'true', with_keywords: '9799|195669|156321', without_genres: '16,10751,10759,10762,35', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // 18+ Web Series
        tmdb('/discover/movie', { include_adult: 'true', with_keywords: '9799|195669|156321', with_original_language: 'hi', without_genres: '16,10751,28,12,35,878', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Bollywood 18+
        tmdb('/discover/movie', { include_adult: 'true', with_keywords: '9799|195669|156321', with_original_language: 'ta', without_genres: '16,10751,28,12,35,878', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Tamil 18+
        tmdb('/discover/movie', { include_adult: 'true', with_keywords: '9799|195669|156321', with_original_language: 'te', without_genres: '16,10751,28,12,35,878', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Telugu 18+
        tmdb('/discover/movie', { include_adult: 'true', certification_country: 'US', certification: 'NC-17', sort_by: 'popularity.desc', page: p1, language: 'en-US' }) // NC-17
      ]);
      let maxLength = 0;
      res.forEach(r => { if (r.results && r.results.length > maxLength) maxLength = r.results.length; });
      for (let i = 0; i < maxLength; i++) {
        res.forEach((r, idx) => {
          if (r.results && i < r.results.length) {
            const item = r.results[i];
            item.media_type = idx === 1 ? 'tv' : 'movie';
            
            // Local Double-Check: Brutally eliminate normal family/action/comedy movies
            const badGenres = [16, 10751, 28, 12, 878, 10762, 10759, 35]; // Animation, Family, Action, Adventure, SciFi, Kids, Action&Adventure, Comedy
            let isBad = false;
            if (item.genre_ids) isBad = item.genre_ids.some(gid => badGenres.includes(gid));
            
            // Allow only if NOT bad genre OR if TMDB officially marked it as explicitly Adult
            if (!isBad || item.adult === true) {
              movies.push(item);
            }
          }
        });
      }
    } else if (cat === 'trending') {
      // 🔥 TRENDING NOW: Global trending movies + shows, interleaved
      const res = await Promise.allSettled([
        tmdb('/trending/movie/week', { language: 'en-US', page: p1 }),
        tmdb('/trending/movie/day', { language: 'en-US', page: pageStr }),
        tmdb('/trending/tv/week', { language: 'en-US', page: pageStr }),
        tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', 'vote_count.gte': '50', page: pageStr, language: 'en-US' })
      ]);
      const combined = [];
      res.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value && r.value.results) {
          r.value.results.forEach(item => { if (idx === 2) item.media_type = 'tv'; combined.push(item); });
        }
      });
      const seen = new Set();
      combined.forEach(m => { if (m && m.id && !seen.has(m.id)) { seen.add(m.id); movies.push(m); } });
    } else if (cat === 'uhd4k') {
      // 💎 4K ULTRA HD: is app me "quality" release-date se decide hoti hai.
      // CAM/TS/HD movies (0-120 din purani) yahan na aa saken, isliye sirf
      // 240+ din purani, high-rated (>=7) movies fetch karte hain — badge 4K.
      // UNLIMITED volume ke liye 8 languages + do pages har load par,
      // aur infinite scroll page aage badhata rehta hai.
      const uhdCutoff = new Date(Date.now() - 240 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const uhdBase = { sort_by: 'popularity.desc', 'primary_release_date.lte': uhdCutoff, 'vote_average.gte': '7', language: 'en-US' };
      const res = await Promise.allSettled([
        tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'en', 'vote_count.gte': '300', page: p1 })),
        tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'en', 'vote_count.gte': '300', page: p2 })),
        tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'hi', 'vote_count.gte': '40', page: p1 })),
        tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'hi', 'vote_count.gte': '40', page: p2 })),
        tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'te', 'vote_count.gte': '30', page: p1 })),
        tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'ta', 'vote_count.gte': '30', page: p1 })),
        tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'ko', 'vote_count.gte': '60', page: p1 })),
        tmdb('/discover/movie', Object.assign({}, uhdBase, { with_original_language: 'ml', 'vote_count.gte': '25', page: p1 }))
      ]);
      const buckets = res.map(r => (r.status === 'fulfilled' && r.value && r.value.results) ? r.value.results : []);
      let maxLen = 0; buckets.forEach(b => { if (b.length > maxLen) maxLen = b.length; });
      const seen = new Set();
      const nowMs = Date.now();
      // Round-robin interleave taaki har language mix hoke aaye
      for (let i = 0; i < maxLen; i++) {
        buckets.forEach(b => {
          const m = b[i];
          if (!m || !m.id || seen.has(m.id) || !m.poster_path) return;
          const rd = m.release_date;
          if (!rd) return;
          const daysOld = (nowMs - new Date(rd).getTime()) / 86400000;
          // 4K-era guarantee: 200+ din purani + rating >=7 (koi CAM/TS possible nahi)
          if (daysOld > 200 && (m.vote_average || 0) >= 7) {
            seen.add(m.id);
            m.media_type = 'movie';
            m._force4K = true; // badge guaranteed 4K (movie genuinely 4K-era hai)
            movies.push(m);
          }
        });
      }
    } else if (cat === 'toprated') {
      // ⭐ TOP RATED: IMDb-style highest rated, min vote threshold ताकि reliable ho
      const res = await Promise.allSettled([
        tmdb('/movie/top_rated', { language: 'en-US', page: p1 }),
        tmdb('/movie/top_rated', { language: 'en-US', page: p2 }),
        tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'vote_average.desc', 'vote_count.gte': '150', page: p1, language: 'en-US' }),
        tmdb('/discover/tv', { sort_by: 'vote_average.desc', 'vote_count.gte': '300', page: p1, language: 'en-US' })
      ]);
      const combined = [];
      res.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value && r.value.results) {
          r.value.results.forEach(item => { if (idx === 3) item.media_type = 'tv'; combined.push(item); });
        }
      });
      const seen = new Set();
      combined.forEach(m => { if (m && m.id && !seen.has(m.id)) { seen.add(m.id); movies.push(m); } });
    } else if (cat === 'kdrama') {
      // 🇰🇷 K-DRAMA: Korean web series + movies
      const res = await Promise.allSettled([
        tmdb('/discover/tv', { with_original_language: 'ko', sort_by: 'popularity.desc', page: p1, language: 'en-US' }),
        tmdb('/discover/tv', { with_original_language: 'ko', sort_by: 'popularity.desc', page: p2, language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc', page: p1, language: 'en-US' })
      ]);
      const combined = [];
      res.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value && r.value.results) {
          r.value.results.forEach(item => { item.media_type = idx === 2 ? 'movie' : 'tv'; combined.push(item); });
        }
      });
      const seen = new Set();
      combined.forEach(m => { if (m && m.id && !seen.has(m.id)) { seen.add(m.id); movies.push(m); } });
    } else if (OTT[cat]) {
      // ── PLATFORM TABS: Netflix / Prime Video / JioHotstar / Zee5 ──
      // Uses OTT sub-filter mode (all / webseries / movies) to decide queries.
      // Trending/latest content is boosted to the top via scoring.
      movies = movies.concat(await fetchOttMovies(cat, currentOttMode, currentMoviePage));
    } else {
      const base = Object.assign({}, CAT_PARAMS[cat] || {}, { language: 'en-US' });
      const res = await Promise.all([
        tmdb('/discover/movie', Object.assign({}, base, { page: p1 })),
        tmdb('/discover/movie', Object.assign({}, base, { page: p2 }))
      ]);
      res.forEach(r => { movies = movies.concat(r.results||[]); });
    }
  } catch(e) { console.warn(e); }
 
  const realToday = new Date(Date.now() + (5.5 * 60 * 60 * 1000)).toISOString().split('T')[0]; // IST date for accurate filtering
  // LATEST MOVIES ONLY & BLOCK UPCOMING GLOBALLY
  movies = movies.filter(m => {
    if (!m.poster_path) return false;
    const rDate = m.release_date || m.first_air_date;
    // Agar release date hi nahi hai, toh bhi sirf popular + high votes wali movies pass karein (already released)
    // Anime/Cartoon exception: naye/niche titles ke votes kam hote hain, unhe drop nahi karna
    if (!rDate) return (m.vote_count > 50 || cat === 'anime' || cat === 'kids');
    // Agar date future ki hai, toh isko normal list se strict block kar do
    if (rDate > realToday) return false;
    return true;
  });

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
      renderFeedEmpty(cat);
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
  const FIRST_PAINT_CARDS = 8;

  if (isLoadMore) {
    renderMovies(newMovies, true);
  } else if (isFullViewMovies) {
    renderMovies(allMovies, false);
  } else {
    const head = allMovies.slice(0, FIRST_PAINT_CARDS);
    const tail = allMovies.slice(FIRST_PAINT_CARDS, 24);
    renderMovies(head, false);
    if (tail.length) {
      const paintTail = () => renderMovies(tail, true);
      if ('requestIdleCallback' in window) requestIdleCallback(paintTail, { timeout: 1500 });
      else setTimeout(paintTail, 300);
    }
  }
  
  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = 'none'; // Always hide button for infinite scroll
 
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
 *  The hover LIFT moved to CSS entirely — see the @media (hover: hover) rule on
 *  .movie-card in moviezone.css. It was two listeners and four inline style
 *  writes per hover to do what one CSS rule does on the compositor.
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
  try { tmdb('/' + type + '/' + id, { language: 'en-US', append_to_response: 'videos,credits' }); } catch (err) {}
  try { preconnectPlayerHosts(3); } catch (err) {}
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
      return;
    }
    grid.innerHTML = '';
  }

  ensureGridDelegation(grid);

  function createMovieCardHTML(m, i) {
    const type   = m.media_type || (m.name && !m.title ? 'tv' : 'movie');
    const rating = m.vote_average ? m.vote_average.toFixed(1) : 'N/A';
    const year   = (m.release_date || m.first_air_date || '').slice(0, 4);
    const genres = (m.genre_ids||[]).slice(0,2).map(id => GENRE_MAP[id]).filter(Boolean);
    const rDateStr = m.release_date || m.first_air_date;
    const isHot  = m.popularity > 100 && ((m.vote_count || 0) > 50 || (Date.now() - new Date(rDateStr || '2000-01-01')) / (1000*60*60*24) < 60);

    // -- PRINT QUALITY BADGE --
    // Derived from the release→quality timeline the ALL feed also ranks by
    // (MOVIE_QUALITY_TIMELINE for films, TV_QUALITY_TIMELINE for series and
    // anime), so the badge and the ordering can never disagree.
    const qualityState = titleQualityState(m, Date.now());
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
      '<div class="movie-card" tabindex="0" data-id="' + m.id + '" data-type="' + type + '"' +
        ' style="will-change:auto;animation-delay:' + ((i % 24) * 0.04) + 's">' +
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
          '<div class="card-quality '+(qualClass||'')+'">'+qual+'</div>' +
          (isHot ? '<div class="card-hot">HOT</div>' : '') +
          freshBadge +
          (isDubbedLikely ? '<div class="card-dubbed"> HINDI</div>' : '') +
          '<div class="card-overlay"><button class="card-play-btn" tabindex="-1" aria-hidden="true">&#9654;</button></div>' +
        '</div>' +
        '<div class="card-info">' +
          '<div class="card-title">'+escapeHTML(m.title||m.name||'')+'</div>' +
          '<div class="card-meta">' +
            '<div class="card-rating">RATING '+rating+'</div>' +
            '<div class="card-year">YEAR '+year+'</div>' +
          '</div>' +
          '<div class="card-meta"><div class="card-runtime">LANG '+(m.original_language||'EN').toUpperCase()+'</div></div>' +
          '<div class="card-genres">'+genres.map(g => '<span class="card-genre">'+escapeHTML(g)+'</span>').join('')+'</div>' +
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

  function renderChunked() {
    const chunkSize = 6;
    let index = 0;

    const renderNextChunk = () => {
      if (runId !== renderMoviesRunId) return;
      const chunk = movies.slice(index, index + chunkSize);
      appendChunk(index, chunk);
      index += chunk.length;
      if (index < movies.length) {
        requestAnimationFrame(() => {
          renderMoviesTimer = setTimeout(renderNextChunk, 0);
        });
      }
    };

    renderNextChunk();
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
  south:'SOUTH INDIAN', tollywood:'TOLLYWOOD', action:'ACTION',
  comedy:'COMEDY', horror:'HORROR', thriller:'THRILLER', romance:'ROMANCE',
  scifi:'SCI-FI', animation:'ANIMATION', kids:'CARTOONS', anime:'ANIME SERIES & MOVIES',
  dubbed:'HINDI DUBBED MOVIES', // <-- YE LINE ADD KI HAI
  adult:'18+ ADULT MOVIES & WEB SERIES',
  trending:'🔥 TRENDING NOW', uhd4k:'💎 4K ULTRA HD', toprated:'⭐ TOP RATED',
  kdrama:'K-DRAMA & KOREAN', netflix:'NETFLIX ORIGINALS',
  prime:'AMAZON PRIME VIDEO', jiohotstar:'JIOHOTSTAR', zee5:'ZEE5 MOVIES & WEB SERIES',
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
 *    • loadMoreMoviesAction() reads .cat-tab.active's onclick to decide which
 *      category the infinite scroll should page next
 *  A closed menu is display:none, but querySelector still finds elements
 *  inside it, so paging keeps working while the menu is shut.
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

function filterCat(cat, e) {
  if (e) e.preventDefault();
  isSearchResultsMode = false;
  isWatchlistMode = false;
  const scrollTrigger = document.getElementById('infiniteScrollTrigger');
  if (scrollTrigger) scrollTrigger.style.display = '';
  document.querySelectorAll('.cat-tab').forEach(t => { t.classList.remove('active'); });
  const tabs = document.querySelectorAll('.cat-tab');
  tabs.forEach(t => { if ((t.getAttribute('onclick')||'').indexOf("'"+cat+"'") !== -1) t.classList.add('active'); });
  syncCatGroupTriggers();
  const h = document.getElementById('sectionHeading');
  if (h) h.textContent = CAT_HEADINGS[cat] || 'MOVIES';
  // Anime ke liye extra sub-filter bar (Trending / Latest / Airing / Top Rated ...)
  if (cat === 'anime') { renderAnimeFilterBar(); updateAnimeHeading(); } else { hideAnimeFilterBar(); }
  // Cartoons ke liye apna sub-filter bar (Trending / Famous / Hindi / Doraemon & Co ...)
  if (cat === 'kids') { renderCartoonFilterBar(); updateCartoonHeading(); } else { hideCartoonFilterBar(); }
  // OTT platforms ke liye Web Series & Movies sub-filter bar
  if (OTT[cat]) { renderOttFilterBar(); updateOttHeading(cat); } else { hideOttFilterBar(); }
  const sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: isMzTVMode() ? 'auto' : 'smooth' });
  loadMovies(cat);
}
 
function loadMoreMoviesAction() {
  const activeTab = document.querySelector('.cat-tab.active');
  let cat = 'all';
  if (activeTab && activeTab.getAttribute('onclick')?.includes('filterCat')) {
    const match = activeTab.getAttribute('onclick').match(/'([^']+)'/);
    if (match) cat = match[1];
  }
  loadMovies(cat, true);
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
  hideOttFilterBar();
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
    grid.innerHTML = Array(4).fill('<div class="skeleton skeleton-card"></div>').join('');
    allUpcoming = [];
  } else {
    currentUpcomingPage++;
    const btn = document.getElementById('loadMoreUpcomingBtn');
    if (btn) btn.innerHTML = 'Loading...';
  }
 
  const p1 = String(currentUpcomingPage * 2 - 1);
  const p2 = String(currentUpcomingPage * 2);
 
  try {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const today = d.toISOString().split('T')[0];
    d.setMonth(d.getMonth() + 3);
    const future = d.toISOString().split('T')[0];
 
    const res = await Promise.all([
      tmdb('/discover/movie', { language: 'en-US', page: p1, sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'en' }),
      tmdb('/discover/movie', { language: 'en-US', page: p2, sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'en' }),
      tmdb('/discover/movie', { language: 'en-US', page: p1, sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'hi', region: 'IN' }),
      tmdb('/discover/movie', { language: 'en-US', page: p2, sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'hi', region: 'IN' })
    ]);
    let movies = [];
    res.forEach(r => { movies = movies.concat(r.results||[]); });
    
    const realToday = new Date().toISOString().split('T')[0];
    movies = movies.filter(m => m.poster_path && m.release_date && m.release_date >= realToday); // Removed backdrop requirement for upcoming
    
    const existingIds = new Set(allUpcoming.map(m => m.id));
    const newMovies = movies.filter(m => { if(existingIds.has(m.id)) return false; existingIds.add(m.id); return true; });
    newMovies.sort((a, b) => a.release_date.localeCompare(b.release_date));
    
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
      card.style.willChange = 'transform, opacity';
      card.style.animationDelay = ((i % 12) * 0.08) + 's';
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
    const details = await tmdb('/' + mediaType + '/' + id, { language: 'en-US', append_to_response: 'videos,credits,similar' });
    
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
let searchCatalogPromise = null;
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
window.addEventListener('scroll', () => {
  if (!isSearchDropdownOpen()) { searchLastScrollY = window.scrollY; return; }
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

async function loadSearchCatalog() {
  if (searchCatalogPromise) return searchCatalogPromise;
  searchCatalogPromise = (async () => {
    const sources = [
      [tmdb('/trending/all/week', { language: 'en-US', page: '1' }), null],
      [tmdb('/movie/popular', { language: 'en-US', page: '1' }), 'movie'],
      [tmdb('/movie/popular', { language: 'en-US', page: '2' }), 'movie'],
      [tmdb('/tv/popular', { language: 'en-US', page: '1' }), 'tv'],
      [tmdb('/movie/top_rated', { language: 'en-US', page: '1' }), 'movie'],
      [tmdb('/discover/movie', { language: 'en-US', with_original_language: 'hi', sort_by: 'popularity.desc', page: '1' }), 'movie'],
      [tmdb('/discover/movie', { language: 'en-US', with_original_language: 'ta', sort_by: 'popularity.desc', page: '1' }), 'movie'],
      [tmdb('/discover/movie', { language: 'en-US', with_original_language: 'te', sort_by: 'popularity.desc', page: '1' }), 'movie'],
      [tmdb('/person/popular', { language: 'en-US', page: '1' }), 'person'],
      [tmdb('/person/popular', { language: 'en-US', page: '2' }), 'person']
    ];
    const settled = await Promise.allSettled(sources.map(source => source[0]));
    const media = [];
    const people = [];
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const forcedType = sources[index][1];
      (result.value?.results || []).forEach(item => {
        const type = item.media_type || forcedType || (item.name ? 'tv' : 'movie');
        if (type === 'person') people.push({ ...item, media_type: 'person' });
        else media.push({ ...item, media_type: type });
      });
    });
    return { media, people };
  })().catch(error => {
    searchCatalogPromise = null;
    console.warn('[MovieZone] Search catalog failed:', error);
    return { media: [], people: [] };
  });
  return searchCatalogPromise;
}

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
async function openModal(id, type = 'movie', activationEvent) {
  if (!claimExplicitDetailActivation(activationEvent)) return;
  // Add hash to URL to behave like a separate page
  window.history.pushState({ watchPage: true }, '', '#watch-' + type + '-' + id);
  if (isMzTV()) lastFocusedElement = document.activeElement;
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
 
  // 1. INSTANT UI OPEN (Bina backend wait kiye instantly page open karo)
  overlay.classList.add('open');
  if (!isMzTV()) {
    document.body.style.overflow = 'hidden';
  }
  overlay.scrollTop = 0;
 
  const titleEl = document.getElementById('modalTitle');
  const descEl = document.getElementById('modalDesc');
  const bgEl = document.getElementById('modalBg');
  const metaEl = document.getElementById('modalMeta');
  const embedEl = document.getElementById('videoEmbed');
  
  if (titleEl) titleEl.textContent = 'Loading...';
  if (descEl) descEl.textContent = 'Fetching high-speed servers...';
  if (metaEl) metaEl.innerHTML = '<div class="player-spinner" style="width:28px; height:28px; border-width:3px; margin: 5px 0;"></div>';
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
  try { renderExternalSources(id, getSelectedSourceIdx(), getSelectedLang()); } catch(e){}

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
    const details = await tmdb('/'+type+'/'+id, { language: 'en-US', append_to_response: 'videos,credits' });

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

      // NEW: Add trailer indicator icon
      let trailerIndicator = imageWrapper.querySelector('.modal-trailer-indicator');
      if (!trailerIndicator) {
        trailerIndicator = document.createElement('div');
        trailerIndicator.className = 'modal-trailer-indicator';
        // Just the icon, as requested
        trailerIndicator.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
        imageWrapper.appendChild(trailerIndicator);
      }
      // END NEW

      // Clear any previous listeners to prevent memory leaks
      eventContainer.onclick = null;
      eventContainer.onmouseenter = null;
      eventContainer.onmouseleave = null;

      if (bestVids.length > 0 && !isMzTV()) {
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
async function loadRelatedMovies(id, type) {
  const section = document.getElementById('relatedMoviesSection');
  const grid = document.getElementById('relatedMoviesGrid');
  if (!section || !grid) return;
 
  section.style.display = 'block';
  grid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card" style="flex-shrink:0;width:170px;height:255px;border-radius:12px;"></div>').join('');
 
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
    return (type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : 'https://vidlink.pro/movie/' + id) + `?lang=${lang}`;
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
    // ⚡ Hover/focus par us server ki stream pehle se warm kar do
    const warmThis = () => {
      const idx = parseInt(btn.getAttribute('data-srcidx') || '0', 10);
      const type = currentModalMovie ? (currentModalMovie.media_type || 'movie') : 'movie';
      prewarmPlayer(id, type, idx);
    };
    ['mouseenter', 'focus'].forEach(evt => btn.addEventListener(evt, warmThis, { passive: true }));
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
  // Save to Continue Watching
  if (typeof saveWatchProgress === 'function' && currentModalMovie) {
    saveWatchProgress(currentModalMovie, Math.floor(Math.random() * 50 + 25));
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
const PLAYER_HOSTS = [
  'https://vidnest.fun',
  'https://player.videasy.net',
  'https://www.viduki.net',
  'https://vidrock.net',
  'https://vidrock.ru',
  'https://embed.smashystream.com',
  'https://autoembed.co',
  'https://vidlink.pro',
  'https://vidsrc.pm',
  'https://graphql.anilist.co'
];
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
  PLAYER_HOSTS.slice(0, limit || 4).forEach(preconnectHost);
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

/**
 * Warms the network path for an embed URL:
 *   1. preconnect  -> DNS + TCP + TLS handshake done before the click
 *   2. no-cors GET -> provider HTML lands in the HTTP cache
 * No iframe and no media element is created here, so the provider cannot start
 * video in a hidden frame (that is what produced the background-autoplay abort).
 */
function warmEmbedUrl(url) {
  if (!url) return;
  try { preconnectHost(new URL(url).origin); } catch (e) {}
  if (isDataSaver() || _mzWarmedDocs.has(url)) return;
  _mzWarmedDocs.add(url);
  try {
    fetch(url, {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'force-cache',
      referrerPolicy: 'no-referrer'
    }).catch(() => {});
  } catch (e) {}
}

function warmPlayerConnection(id, type) {
  if (!id) return;
  warmEmbedUrl(buildPlayerUrl(id, type, effectiveSourceIdx()));
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
  warmEmbedUrl(realUrl);
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
 
function togglePlayerLang() {
  if (!currentModalMovie) return;
  const nextLang = getSelectedLang() === 'hi' ? 'en' : 'hi';
  setSelectedLang(nextLang);
  loadPlayer(currentModalMovie.id, currentSourceIdx, nextLang, getSelectedQuality(), currentModalMovie.media_type);
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
  
  // Change TV Shows tab text to Web Series
  const tvTab = document.querySelector('.cat-tab[onclick*="filterCat(\'tv\')"]');
  if (tvTab) {
    tvTab.innerHTML = 'Web Series';
  }

  /*  Cartoons / Anime / 18+ / Hindi Dubbed used to be appended here at runtime.
   *  Cartoons, Anime and 18+ are now declared on the strip in index.html and the
   *  genres live in the "Category" dropdown, so injecting them again would push
   *  duplicate pills onto the strip and undo the grouping. Hindi Dubbed was
   *  dropped from the UI entirely; filterCat('dubbed') still works if called.
   *  A safety sweep instead: if markup ever regresses and a category ends up
   *  missing, log it rather than silently dropping the filter. */
  (function verifyCategoryTabs() {
    const required = ['kids', 'anime', 'adult', 'tv', 'zee5', 'netflix', 'prime', 'jiohotstar'];
    const missing = required.filter(c =>
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
          `<a href="${a.getAttribute('href') || '#'}" class="mz-mp-link${a.classList.contains('active') ? ' active' : ''}${a.classList.contains('nav-premium') ? ' mz-mp-premium' : ''}" data-idx="${i}"${a.closest('[data-tv-hide]') ? ' data-tv-hide' : ''} style="--i:${i}">${(a.dataset.label || a.textContent).trim()}</a>`
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
    const activeTab = document.querySelector('.cat-tab.active');
    let currentCat = 'all';
    if (activeTab && activeTab.getAttribute('onclick')?.includes('filterCat')) {
      const match = activeTab.getAttribute('onclick').match(/'([^']+)'/);
      if (match) currentCat = match[1];
    }
    loadMovies(currentCat);
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

// Run it briefly after the dynamic content (movies) finishes loading
setTimeout(extractTopKeywords, 3000);

// -- BOT DETECTION (WebGL Renderer Check) --
(function detectBot() {
  // Run this check after a short delay to not block the initial render.
  setTimeout(() => {
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
  }, 4500); // Run after other initial scripts.
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
        const particles = document.querySelector('.ambient-particles');
        if (particles) particles.remove();
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
        const particles = document.querySelector('.ambient-particles');
        if (particles) particles.remove();
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
  const MAX_CW_ITEMS = 20;

  function getCWList() {
    try { return JSON.parse(localStorage.getItem(CW_KEY)) || []; }
    catch { return []; }
  }

  function saveCWList(list) {
    localStorage.setItem(CW_KEY, JSON.stringify(list.slice(0, MAX_CW_ITEMS)));
  }

  // Save watch progress (called when user plays a movie)
  window.saveWatchProgress = function(movie, progress) {
    if (!movie || !movie.id) return;
    const list = getCWList();
    const existing = list.findIndex(item => item.id === movie.id);
    if (existing > -1) list.splice(existing, 1);
    list.unshift({
      id: movie.id,
      title: movie.title || movie.name,
      backdrop: movie.backdrop_path || '',
      poster: movie.poster_path || '',
      media_type: movie.media_type || (movie.name && !movie.title ? 'tv' : 'movie'),
      progress: progress || Math.floor(Math.random() * 60 + 20), // percentage
      timestamp: Date.now(),
      vote_average: movie.vote_average || 0
    });
    saveCWList(list);
    renderContinueWatching();
  };

  // Remove from continue watching
  window.removeCW = function(id) {
    const list = getCWList().filter(item => item.id !== id);
    saveCWList(list);
    renderContinueWatching();
  };

  // Render the continue watching section
  window.renderContinueWatching = function() {
    const section = document.getElementById('continue-watching');
    const grid = document.getElementById('continueWatchingGrid');
    if (!section || !grid) return;

    const list = getCWList();
    if (list.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    grid.innerHTML = list.map(item => {
      const img = item.backdrop
        ? `https://image.tmdb.org/t/p/w500${item.backdrop}`
        : (item.poster ? `https://image.tmdb.org/t/p/w342${item.poster}` : '');
      const timeAgo = getTimeAgo(item.timestamp);
      return `
        <div class="cw-card" onclick="openCWMovie(${item.id}, '${item.media_type}', event)" tabindex="0">
          <img class="cw-card-img" src="${img}" alt="${escapeHTML(item.title || '')}" width="280" height="158" loading="lazy" decoding="async">
          <div class="cw-play-icon">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="#000"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <button class="cw-remove-btn" onclick="event.stopPropagation(); removeCW(${item.id})" aria-label="Remove"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          <div class="cw-card-info">
            <div class="cw-card-title">${item.title}</div>
            <div class="cw-card-meta">${timeAgo} • ${item.progress}% watched</div>
            <div class="cw-progress-bar"><div class="cw-progress-fill" style="width:${item.progress}%"></div></div>
          </div>
        </div>
      `;
    }).join('');
  };

  function getTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return Math.floor(days / 7) + 'w ago';
  }

  // Open a continue watching movie
  window.openCWMovie = function(id, mediaType, activationEvent) {
    // Reuse existing openModal function, preserving the explicit click/remote event.
    if (typeof openModal === 'function') openModal(id, mediaType, activationEvent);
  };

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
  async function subscribeToPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Push notifications are not supported in this browser');
      }

      const reg = await navigator.serviceWorker.ready;
      let subscription = await reg.pushManager.getSubscription();

      if (!subscription) {
        const response = await fetch('/api/push/vapid-key', { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load the push configuration');
        const { publicKey } = await response.json();
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      const saveResponse = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      });
      if (!saveResponse.ok) {
        const error = await saveResponse.json().catch(() => ({}));
        throw new Error(error.error || 'Could not save push subscription');
      }

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
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not save movie notification');
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
    if (!response.ok) return;
    const { movies = [] } = await response.json();
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




// === COLLECTIONS HUB (Premium Cinematic Universes — JioHotstar-level luxury) ===
(function initCollectionsHub() {
  // Exact title lists and TMDB metadata live in collections-catalog.json.
  // This array contains presentation metadata only — no broad keyword discovery.
  const UNIVERSES = [
    // ── SUPERHERO ──
    { slug: 'mcu', name: 'Marvel Cinematic Universe', badge: 'MARVEL', tagline: 'The complete MCU timeline — every film and narrative series.', accent: 'marvel', category: 'superhero' },
    { slug: 'dceu', name: 'DC Universe', badge: 'DC', tagline: 'The DCEU legacy and DC Studios’ interconnected new era.', accent: 'dc', category: 'superhero' },
    // ── SCI-FI ──
    { slug: 'terminator', name: 'Terminator', badge: 'TERMINATOR', tagline: 'The complete war between humanity and the machines.', accent: 'terminator', category: 'scifi' },
    { slug: 'transformers', name: 'Transformers', badge: 'TRANSFORMERS', tagline: 'Robots in disguise — films and animated sagas across generations.', accent: 'transformers', category: 'scifi' },
    // ── FANTASY ──
    { slug: 'wizarding-world', name: 'Wizarding World', badge: 'WIZARDING WORLD', tagline: 'Harry Potter and Fantastic Beasts — the complete magical journey.', accent: 'wizard', category: 'fantasy' },
    { slug: 'middle-earth', name: 'Middle-earth', badge: 'MIDDLE-EARTH', tagline: 'The Lord of the Rings, The Hobbit and the ages of Middle-earth.', accent: 'lotr', category: 'fantasy' },
    { slug: 'pirates', name: 'Pirates of the Caribbean', badge: 'PIRATES', tagline: 'Captain Jack Sparrow and every voyage across the cursed seas.', accent: 'pirates', category: 'fantasy' },
    // ── ACTION ──
    { slug: 'fast-furious', name: 'Fast & Furious', badge: 'FAST', tagline: 'Every high-octane heist, race and family mission.', accent: 'fast', category: 'action' },
    { slug: 'james-bond', name: 'James Bond 007', badge: '007', tagline: 'The complete EON 007 film canon — six decades of espionage.', accent: 'bond', category: 'action' },
    { slug: 'mission-impossible', name: 'Mission: Impossible', badge: 'M:I', tagline: 'The original IMF series and every impossible cinematic mission.', accent: 'mi', category: 'action' },
    { slug: 'jurassic-park', name: 'Jurassic World', badge: 'JURASSIC', tagline: 'Every Jurassic Park and World film, plus the animated canon.', accent: 'jurassic', category: 'action' },
    { slug: 'predator', name: 'Predator', badge: 'PREDATOR', tagline: 'The ultimate hunters — Predator, Prey and the AVP encounters.', accent: 'predator', category: 'action' },
    // ── HORROR ──
    { slug: 'conjuring', name: 'The Conjuring Universe', badge: 'CONJURING', tagline: 'Conjuring, Annabelle, The Nun and every connected nightmare.', accent: 'horror', category: 'horror' },
    // ── ANIMATION ──
    { slug: 'despicable-me', name: 'Despicable Me & Minions', badge: 'MINIONS', tagline: 'Gru, the Minions and every supervillain adventure.', accent: 'minions', category: 'animation' },
    { slug: 'toy-story', name: 'Toy Story', badge: 'PIXAR', tagline: 'The complete Toy Story saga and its animated spin-offs.', accent: 'toystory', category: 'animation' },
    { slug: 'shrek', name: 'Shrek', badge: 'DREAMWORKS', tagline: 'Shrek, Puss in Boots and every Far Far Away adventure.', accent: 'shrek', category: 'animation' },
    { slug: 'kung-fu-panda', name: 'Kung Fu Panda', badge: 'DREAMWORKS', tagline: 'Po’s complete journey across films and animated series.', accent: 'kungfu', category: 'animation' },
    { slug: 'ice-age', name: 'Ice Age', badge: 'BLUE SKY', tagline: 'Manny, Sid, Diego, Scrat and every adventure with the herd.', accent: 'iceage', category: 'animation' }
  ];

  const hubCache = new Map();
  let activeUniverseSlug = null;
  let activeTab = 'all'; // 'all' | 'movies' | 'tv'
  let activeCategory = 'all';

  function getUniverse(slug) {
    return UNIVERSES.find(u => u.slug === slug);
  }

  // ── Curated catalog loader ──
  // One small static request replaces dozens of broad TMDB discover calls.
  // Exact IDs, titles, artwork and release dates were resolved by strict title+year.
  let curatedCatalogPromise = null;
  function loadCuratedCatalog() {
    if (curatedCatalogPromise) return curatedCatalogPromise;
    curatedCatalogPromise = fetch('/collections-catalog.json?v=2', { cache: 'force-cache' })
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

  const ARROW_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';

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

  // Set exact values immediately; use a compositor-only pop instead of frame-dependent counting.
  function countUp(el, target, suffix) {
    if (!el) return;
    el.textContent = (Number(target) || 0) + (suffix || '');
    if (!prefersReducedMotion && typeof el.animate === 'function') {
      el.animate([
        { opacity: 0.45, transform: 'translate3d(0,6px,0) scale(0.94)' },
        { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }
      ], { duration: 480, easing: 'cubic-bezier(0.22,1,0.36,1)' });
    }
  }

  function buildHubCard(universe, index) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ch-card ch-accent-' + universe.accent;
    card.setAttribute('data-slug', universe.slug);
    card.setAttribute('data-category', universe.category);
    card.setAttribute('aria-label', universe.name + ' — explore collection');
    card.style.setProperty('--delay', Math.min(index, 12) * 55 + 'ms');
    card.innerHTML =
      '<div class="ch-card-media">' +
        '<div class="ch-card-posters" id="chPosters-' + universe.slug + '"><div class="ch-card-skeleton"></div></div>' +
        '<div class="ch-card-sheen"></div>' +
      '</div>' +
      '<div class="ch-card-overlay"></div>' +
      '<div class="ch-card-glow"></div>' +
      '<div class="ch-card-spotlight"></div>' +
      '<div class="ch-card-body">' +
        '<span class="ch-card-badge">' + escapeHTML(universe.badge) + '</span>' +
        '<h3>' + escapeHTML(universe.name) + '</h3>' +
        '<p>' + escapeHTML(universe.tagline) + '</p>' +
        '<div class="ch-card-meta">' +
          '<span class="ch-card-count" id="chCount-' + universe.slug + '">Loading…</span>' +
          '<span class="ch-card-cta">Explore ' + ARROW_SVG + '</span>' +
        '</div>' +
      '</div>';
    card.addEventListener('click', () => openUniverse(universe.slug));
    bindTilt(card);
    return card;
  }

  // ── Netflix-style hero poster mosaic (all universes merged) ──
  let mosaicBuilt = false;
  async function buildHeroMosaic() {
    const wrap = document.getElementById('chHeroMosaic');
    const grid = document.getElementById('chHeroMosaicGrid');
    if (!wrap || !grid || mosaicBuilt) return;
    mosaicBuilt = true;

    // Reuses the same cached promises the cards use — zero extra network calls
    const perUniverse = await Promise.all(UNIVERSES.map(async (u) => {
      try {
        const [movies, tv] = await Promise.all([
          fetchUniverseMovies(u),
          fetchUniverseTV(u)
        ]);
        return [...movies, ...tv].filter(x => x.poster_path).map(x => x.poster_path);
      } catch (e) { return []; }
    }));

    // Round-robin interleave so Marvel, DC, Wizarding World… all appear mixed together
    const pool = [];
    const seen = new Set();
    const longest = perUniverse.reduce((m, l) => Math.max(m, l.length), 0);
    for (let i = 0; i < longest; i++) {
      for (let u = 0; u < perUniverse.length; u++) {
        const p = perUniverse[u][i];
        if (p && !seen.has(p)) { seen.add(p); pool.push(p); }
      }
    }
    if (!pool.length) return;

    const vw = wrap.offsetWidth || window.innerWidth;
    const vh = wrap.offsetHeight || 640;
    const isNarrow = vw < 768;
    const cols = vw < 560 ? 8 : vw < 900 ? 11 : vw < 1400 ? 13 : 16;
    const gap = isNarrow ? 5 : 7;
    const gridW = vw * (isNarrow ? 1.7 : 1.28);
    const tileW = (gridW - gap * (cols - 1)) / cols;
    const rows = Math.min(10, Math.ceil((vh * 1.4) / (tileW * 1.5 + gap)) + 1);
    const maxTiles = isMzTV() ? 48 : (isNarrow ? 42 : (liteMode ? 60 : 112));
    const total = Math.min(cols * rows, maxTiles);

    grid.style.setProperty('--cols', cols);

    let html = '';
    for (let i = 0; i < total; i++) {
      // stride keeps neighbouring tiles from being the same franchise
      const path = pool[(i * 7) % pool.length];
      html += '<div class="ch-mosaic-tile"><img src="https://image.tmdb.org/t/p/w185' + path +
              '" alt="" width="185" height="278" loading="lazy" decoding="async" data-ch-reveal></div>';
    }
    grid.innerHTML = html;
    attachImageReveal(grid);
    requestAnimationFrame(() => wrap.classList.add('ch-mosaic-in'));
  }

  function renderHubGrid() {
    const grid = document.getElementById('chGrid');
    if (!grid || grid.dataset.built) return;
    grid.dataset.built = '1';
    const fragment = document.createDocumentFragment();
    UNIVERSES.forEach((u, i) => fragment.appendChild(buildHubCard(u, i)));
    grid.appendChild(fragment);

    // Update stats
    const statUniverses = document.getElementById('chStatUniverses');
    if (statUniverses) countUp(statUniverses, UNIVERSES.length);

    // Load counts and poster previews. Promise.all guarantees one exact global total.
    Promise.all(UNIVERSES.map(async (universe) => {
      try {
        const [movies, tvSeries] = await Promise.all([
          fetchUniverseMovies(universe),
          fetchUniverseTV(universe)
        ]);
        const total = movies.length + tvSeries.length;
        const countEl = document.getElementById('chCount-' + universe.slug);
        if (countEl) {
          let text = movies.length + ' Movie' + (movies.length !== 1 ? 's' : '');
          if (tvSeries.length > 0) text += ' · ' + tvSeries.length + ' Series';
          countEl.textContent = text;
        }
        const postersEl = document.getElementById('chPosters-' + universe.slug);
        if (postersEl) {
          const allItems = [...movies, ...tvSeries].filter(m => m.backdrop_path || m.poster_path);
          const heroItem = allItems.find(m => m.backdrop_path) || allItems[0];
          if (heroItem && heroItem.backdrop_path) {
            postersEl.innerHTML =
              '<img src="https://image.tmdb.org/t/p/w780' + heroItem.backdrop_path + '"' +
              ' srcset="https://image.tmdb.org/t/p/w500' + heroItem.backdrop_path + ' 500w, https://image.tmdb.org/t/p/w780' + heroItem.backdrop_path + ' 780w"' +
              ' sizes="(max-width: 768px) 90vw, 420px" alt="" width="780" height="439" loading="lazy" decoding="async"' +
              ' class="ch-card-backdrop" data-ch-reveal>';
          } else if (allItems.length > 0) {
            postersEl.innerHTML = allItems.slice(0, 3).map(m =>
              '<img src="' + IMG + m.poster_path + '" alt="" width="342" height="513" loading="lazy" decoding="async" data-ch-reveal>'
            ).join('');
          } else {
            postersEl.innerHTML = '<div class="ch-card-empty">Coming soon</div>';
          }
          attachImageReveal(postersEl);
        }
        return total;
      } catch (e) {
        const countEl = document.getElementById('chCount-' + universe.slug);
        if (countEl) countEl.textContent = 'Unavailable';
        return 0;
      }
    })).then(totals => {
      const statTitles = document.getElementById('chStatTitles');
      if (statTitles) countUp(statTitles, totals.reduce((sum, count) => sum + count, 0), '+');
    });

    // Category tab listeners
    initCategoryTabs();

    // Cinematic poster wall behind the hero
    buildHeroMosaic();
  }

  function initCategoryTabs() {
    const tabsContainer = document.getElementById('chCategoryTabs');
    if (!tabsContainer) return;
    tabsContainer.querySelectorAll('.ch-cat-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        tabsContainer.querySelectorAll('.ch-cat-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeCategory = btn.dataset.cat;
        filterGridByCategory();
      });
    });
  }

  function filterGridByCategory() {
    const grid = document.getElementById('chGrid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.ch-card');
    let visibleIdx = 0;
    cards.forEach(card => {
      const cat = card.dataset.category;
      const show = activeCategory === 'all' || cat === activeCategory;
      card.style.display = show ? '' : 'none';
      if (show) {
        card.style.setProperty('--delay', Math.min(visibleIdx, 12) * 55 + 'ms');
        card.classList.remove('ch-card-animate');
        void card.offsetWidth;
        card.classList.add('ch-card-animate');
        visibleIdx++;
      }
    });
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

    function buildCards(items) {
      return items.map((item, idx) => {
        const title = item.title || item.name || '';
        const year = (item.release_date || item.first_air_date || '').slice(0, 4) || 'TBA';
        const voteRaw = Number(item.vote_average || 0);
        const rating = voteRaw.toFixed(1);
        const isTVItem = item._type === 'tv';
        const delay = Math.min(idx, 16) * 45;
        return (
          '<div class="ch-movie-card ch-accent-' + universe.accent + '" data-id="' + item.id + '" data-type="' + item._type + '"' +
            ' role="button" tabindex="0" aria-label="' + escapeHTML(title) + ' (' + year + ')" style="--delay:' + delay + 'ms;animation-delay:' + delay + 'ms">' +
            '<div class="ch-movie-card-inner">' +
              '<img src="' + IMG + item.poster_path + '" alt="' + escapeHTML(title) + ' poster" width="342" height="513" loading="lazy" decoding="async" data-ch-reveal>' +
              '<span class="ch-movie-order">' + (idx + 1) + '</span>' +
              (isTVItem ? '<span class="ch-movie-type-badge ch-type-tv">TV</span>' : '<span class="ch-movie-type-badge ch-type-movie">MOVIE</span>') +
              (voteRaw > 0 ? '<div class="ch-movie-rating">★ ' + rating + '</div>' : '') +
              '<div class="ch-movie-shine"></div>' +
              '<div class="ch-movie-hover-overlay">' +
                '<div class="ch-movie-hover-play">▶</div>' +
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
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ch-detail-tabs">' +
        '<button class="ch-dtab active" data-filter="all">All (' + allItems.length + ')</button>' +
        '<button class="ch-dtab" data-filter="movies">Movies (' + totalMovies + ')</button>' +
        (totalTV > 0 ? '<button class="ch-dtab" data-filter="tv">TV Series (' + totalTV + ')</button>' : '') +
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

    // Tab filtering
    detail.querySelectorAll('.ch-dtab').forEach(tab => {
      tab.addEventListener('click', () => {
        detail.querySelectorAll('.ch-dtab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const filter = tab.dataset.filter;
        let filtered = allItems;
        if (filter === 'movies') filtered = allItems.filter(i => i._type === 'movie');
        else if (filter === 'tv') filtered = allItems.filter(i => i._type === 'tv');
        const activeSort = detail.querySelector('.ch-sort-btn.active');
        paintGrid(applySort(filtered, activeSort ? activeSort.dataset.sort : 'release'));
      });
    });

    function applySort(list, sort) {
      const items = [...list];
      if (sort === 'rating') items.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
      else if (sort === 'title') items.sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
      return items;
    }

    // Sort functionality
    detail.querySelectorAll('.ch-sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        detail.querySelectorAll('.ch-sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const activeFilter = detail.querySelector('.ch-dtab.active').dataset.filter;
        let items = allItems;
        if (activeFilter === 'movies') items = allItems.filter(i => i._type === 'movie');
        else if (activeFilter === 'tv') items = allItems.filter(i => i._type === 'tv');
        paintGrid(applySort(items, btn.dataset.sort));
      });
    });

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
    if (!overlay.classList.contains('open')) openCollectionsHubOverlay({ skipHistory: true });

    activeUniverseSlug = slug;
    overlay.classList.add('detail-mode');
    const topbarTitle = document.getElementById('chTopbarTitle');
    const backLabel = document.getElementById('chBackLabel');
    if (topbarTitle) topbarTitle.textContent = universe.name;
    if (backLabel) backLabel.textContent = 'Collections';

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

  function closeUniverseDetail(options) {
    const overlay = document.getElementById('collections-hub-overlay');
    if (!overlay) return;
    overlay.classList.remove('detail-mode');
    activeUniverseSlug = null;
    const topbarTitle = document.getElementById('chTopbarTitle');
    const backLabel = document.getElementById('chBackLabel');
    if (topbarTitle) topbarTitle.textContent = 'Collections & Universes';
    if (backLabel) backLabel.textContent = 'Close';
    if (!(options && options.skipHistory) && window.location.hash.startsWith('#collections-')) {
      window.history.pushState({ collectionsHub: true }, '', '#collections');
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

  window.openCollectionsHub = function(event, initialSlug) {
    if (event) event.preventDefault();
    openCollectionsHubOverlay({});
    if (initialSlug) openUniverse(initialSlug);
  };

  function openCollectionsHubOverlay(options) {
    const overlay = document.getElementById('collections-hub-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    if (!isMzTV()) {
      document.body.style.overflow = 'hidden';
    }
    renderHubGrid();
    initParticles();
    if (!(options && options.skipHistory) && !window.location.hash.startsWith('#collections')) {
      window.history.pushState({ collectionsHub: true }, '', '#collections');
    }
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

  window.handleCollectionsBack = function() {
    const overlay = document.getElementById('collections-hub-overlay');
    if (overlay && overlay.classList.contains('detail-mode')) closeUniverseDetail();
    else window.closeCollectionsHub();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('collections-hub-overlay');
    if (overlay && overlay.classList.contains('open')) {
      e.stopPropagation();
      window.handleCollectionsBack();
    }
  });

  window.addEventListener('popstate', () => {
    const overlay = document.getElementById('collections-hub-overlay');
    if (!overlay) return;
    const hash = window.location.hash;
    if (hash.startsWith('#collections-')) {
      const slug = hash.replace('#collections-', '');
      if (getUniverse(slug)) {
        if (!overlay.classList.contains('open')) openCollectionsHubOverlay({ skipHistory: true });
        openUniverse(slug, { skipHistory: true });
      }
    } else if (hash === '#collections') {
      if (!overlay.classList.contains('open')) openCollectionsHubOverlay({ skipHistory: true });
      else closeUniverseDetail({ skipHistory: true });
    } else if (overlay.classList.contains('open')) {
      overlay.classList.remove('open', 'detail-mode');
      document.body.style.overflow = '';
      activeUniverseSlug = null;
      stopParticles();
    }
  });

  // Deep-link support — clean up stale #collections hash on page load to prevent loop
  if (window.location.hash.startsWith('#collections')) {
    document.addEventListener('DOMContentLoaded', () => {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    });
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

/* ── FIX E: TV pe mouse nahi hota, to custom cursor ke 3 elements bekaar
   compositing layers hain. */
html[data-mz-tv="true"] #cursor-glow,
html[data-mz-tv="true"] #cursor-ring,
html[data-mz-tv="true"] #cursor-dot,
html[data-mz-tv="true"] .ambient-particles,
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
