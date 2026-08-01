/* ═══════════════════════════════════════════════════════════════════════════
   MOVIEZONE — TV MODE
   Isolated module for Smart TV / set-top-box support. Loaded BEFORE moviezone.js
   (see index.html) because moviezone.js reads html[data-mz-tv] at parse time.

   Responsibilities
     1. Detect real TV hardware (never guess from screen size alone).
     2. Tag <html> with data-mz-tv / -platform / -tier so CSS + moviezone.js adapt.
     3. Own D-pad (arrow) spatial navigation, OK, Back, media and channel keys —
        moviezone.js deliberately steps aside for us (`if (isMzTV()) return;`).
     4. Keep TVs smooth: TV chipsets are ~5-10x slower than a phone, so we strip
        continuous work (animations, blur, big decodes) and cap in-flight images.

   Pure logic (detection, key mapping, spatial geometry, perf policy) is exported
   for Node so tv-mode.test.js can verify it without a browser or DOM library.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════
     SECTION 1 — PURE CORE (no DOM access; unit tested in Node)
     ═══════════════════════════════════════════════════════════════ */

  // Ordered most-specific first: the first match wins, so "Fire TV" is never
  // reported as plain "Android TV" and Tizen is never reported as generic.
  var TV_UA_PATTERNS = [
    { platform: 'fire-tv',     re: /\bAFT[A-Z0-9]{1,5}\b/ },
    { platform: 'fire-tv',     re: /\b(?:fire\s*tv|firetv)\b/i },
    { platform: 'android-tv',  re: /\b(?:android\s*tv|googletv|google\s*tv|nexusplayer|shield\s*android\s*tv)\b/i },
    // LG ships the token as "Web0S" — a literal zero, not the letter O.
    { platform: 'webos',       re: /\b(?:webos|web0s)(?:\.tv)?\b|\bnetcast\b|\blg\s*browser\b|\blgtv\b/i },
    { platform: 'tizen',       re: /\btizen\b/i },
    { platform: 'vidaa',       re: /\bvidaa\b/i },
    { platform: 'roku',        re: /\broku\b/i },
    { platform: 'chromecast',  re: /\bcrkey\b/i },
    { platform: 'apple-tv',    re: /\b(?:apple\s*tv|appletv|tvos)\b/i },
    { platform: 'bravia',      re: /\bbravia\b/i },
    { platform: 'philips-tv',  re: /\b(?:nettv|philipstv)\b/i },
    { platform: 'vestel',      re: /\bvestel\b/i },
    { platform: 'panasonic-tv', re: /\bviera\b/i },
    { platform: 'opera-tv',    re: /\b(?:opera\s*tv|dtvopera|pov_tv)\b/i },
    { platform: 'hbbtv',       re: /\bhbbtv\b/i },
    { platform: 'playstation', re: /\bplaystation\b/i },
    { platform: 'xbox',        re: /\bxbox\b/i },
    { platform: 'smart-tv',    re: /\b(?:smart[\s_-]?tv|smarttv|inettvbrowser|hisensetv|aquos|dtv)\b/i },
    // Standalone "TV" token last: real TVs put it in the UA, phones do not.
    { platform: 'generic-tv',  re: /(?:^|[\s;(_-])tv(?:[\s;)_-]|$)/i }
  ];

  /**
   * Decide whether we are on a TV. Deliberately conservative: a 4K desktop
   * monitor is NOT a TV, so resolution alone never flips this on. Only a
   * user-agent hint, a pointer-less input stack, or an explicit ?tv=1 counts.
   *
   * @param {Object} env  { userAgent, search, hasFinePointer, hasAnyPointer, screenWidth }
   * @returns {{isTv:boolean, platform:string, confidence:string, reason:string}}
   */
  function detectTvPlatform(env) {
    var e = env || {};
    var ua = typeof e.userAgent === 'string' ? e.userAgent : '';
    var search = typeof e.search === 'string' ? e.search : '';

    // 1. Explicit override always wins (?tv=1 to force on, ?tv=0 to force off).
    var forced = readTvOverride(search);
    if (forced === false) {
      return { isTv: false, platform: 'browser', confidence: 'forced-off', reason: 'tv=0 in query string' };
    }

    // 2. User-agent hints — the only trustworthy device identity signal.
    var matched = matchTvUserAgent(ua);

    if (forced === true) {
      return {
        isTv: true,
        platform: matched ? matched.platform : 'forced-tv',
        confidence: 'forced-on',
        reason: 'tv=1 in query string'
      };
    }
    if (matched) {
      return { isTv: true, platform: matched.platform, confidence: 'confirmed', reason: 'user-agent match' };
    }

    // 3. No pointing device at all (not even a coarse one) means a remote-only
    //    device. Emulated coarse pointers on phones/tablets never report this.
    if (e.hasAnyPointer === false && e.hasFinePointer === false) {
      return { isTv: true, platform: 'remote-only', confidence: 'probable', reason: 'no pointing device reported' };
    }

    return { isTv: false, platform: 'browser', confidence: 'none', reason: 'no TV signal' };
  }

  // Returns true (force on), false (force off) or null (no override present).
  // Accepts a bare "?tv" as well as "?tv=1"; "?tvmode=1" is not an override.
  function readTvOverride(search) {
    var match = /[?&]tv(?:=([^&#]*))?(?=[&#]|$)/i.exec(search || '');
    if (!match) return null;
    if (match[1] == null || match[1] === '') return true; // ?tv / ?tv=
    var value = String(match[1]).toLowerCase();
    if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
    return true; // tv=1, tv=true, tv=on ...
  }

  function matchTvUserAgent(ua) {
    if (!ua) return null;
    for (var i = 0; i < TV_UA_PATTERNS.length; i++) {
      if (TV_UA_PATTERNS[i].re.test(ua)) return TV_UA_PATTERNS[i];
    }
    return null;
  }

  /* ── Remote key mapping ───────────────────────────────────────────────────
     TV remotes are wildly inconsistent: webOS sends 461 for Back, Tizen sends
     10009, Android TV sends Escape, HbbTV boxes send Backspace. Media and
     channel keys use the CEA-2014 / HbbTV numeric range. We map by BOTH
     KeyboardEvent.key and legacy keyCode so every platform lands somewhere. */
  var KEY_NAME_ACTIONS = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    Left: 'left', Right: 'right', Up: 'up', Down: 'down', // legacy IE/WebKit TV names
    Enter: 'ok', ' ': 'ok', Spacebar: 'ok', Select: 'ok', Accept: 'ok',
    Escape: 'back', Esc: 'back', Backspace: 'back', BrowserBack: 'back',
    GoBack: 'back', XF86Back: 'back', Cancel: 'back', Exit: 'back',
    Home: 'home', BrowserHome: 'home',
    PageUp: 'pageUp', PageDown: 'pageDown',
    ChannelUp: 'pageUp', ChannelDown: 'pageDown',
    MediaPlay: 'play', MediaPause: 'pause', MediaPlayPause: 'playPause',
    Pause: 'pause', Play: 'play', MediaStop: 'stop', Stop: 'stop',
    MediaFastForward: 'forward', FastFwd: 'forward',
    MediaRewind: 'rewind', Rewind: 'rewind',
    MediaTrackNext: 'next', MediaTrackPrevious: 'previous',
    ColorF0Red: 'red', ColorF1Green: 'green', ColorF2Yellow: 'yellow', ColorF3Blue: 'blue',
    Search: 'search', BrowserSearch: 'search', Info: 'info', Find: 'search'
  };

  var KEY_CODE_ACTIONS = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down',
    13: 'ok', 32: 'ok', 29443: 'ok',              // 29443 = Tizen OK
    8: 'back', 27: 'back', 461: 'back', 10009: 'back', 166: 'back', 4: 'back',
    36: 'home', 10071: 'home',
    33: 'pageUp', 34: 'pageDown', 427: 'pageUp', 428: 'pageDown',
    415: 'play', 19: 'pause', 413: 'stop', 10252: 'playPause', 179: 'playPause',
    417: 'forward', 412: 'rewind', 425: 'forward', 424: 'rewind',
    176: 'next', 177: 'previous',
    403: 'red', 404: 'green', 405: 'yellow', 406: 'blue',
    457: 'info', 10182: 'exit', 10133: 'search'
  };

  /**
   * Translate a keyboard/remote event into a MovieZone TV action name.
   * @returns {string|null} action or null when the key is not ours to handle.
   */
  function mapRemoteKey(event) {
    if (!event) return null;
    var byName = event.key != null ? KEY_NAME_ACTIONS[event.key] : null;
    if (byName) return byName;
    var code = event.keyCode != null ? event.keyCode : event.which;
    if (code != null && KEY_CODE_ACTIONS[code]) return KEY_CODE_ACTIONS[code];
    return null;
  }

  var DIRECTIONS = { left: 1, right: 1, up: 1, down: 1 };
  function isDirection(action) { return Object.prototype.hasOwnProperty.call(DIRECTIONS, action); }

  /* ── Spatial navigation geometry ────────────────────────────────────────── */

  function overlap1D(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  }

  /**
   * Classic 10-foot-UI spatial navigation: from `origin`, find the best
   * candidate rect in `direction`. Elements sharing the origin's row (for
   * left/right) or column (for up/down) always win over misaligned ones, which
   * is what makes a poster grid feel predictable under a D-pad.
   *
   * @param {string} direction  'left' | 'right' | 'up' | 'down'
   * @param {Object} origin     rect-like {left, top, right, bottom}
   * @param {Array}  candidates array of rect-like objects (null entries skipped)
   * @param {Object} [options]  { tolerance }
   * @returns {number} index into candidates, or -1 when nothing lies that way
   */
  function pickNextFocus(direction, origin, candidates, options) {
    if (!origin || !candidates || !candidates.length || !isDirection(direction)) return -1;
    var tolerance = options && options.tolerance != null ? options.tolerance : 6;

    var vertical = direction === 'up' || direction === 'down';
    var originCross = vertical
      ? (origin.left + origin.right) / 2
      : (origin.top + origin.bottom) / 2;

    var best = -1;
    var bestScore = Infinity;

    for (var i = 0; i < candidates.length; i++) {
      var r = candidates[i];
      if (!r) continue;

      var advance;   // how far the candidate sits in the travel direction
      var crossHit;  // shared extent on the perpendicular axis
      var crossMid;  // candidate centre on the perpendicular axis
      var crossSpan; // smaller of the two perpendicular sizes

      if (direction === 'right') {
        advance = r.left - origin.right;
        crossHit = overlap1D(origin.top, origin.bottom, r.top, r.bottom);
        crossMid = (r.top + r.bottom) / 2;
        crossSpan = Math.min(origin.bottom - origin.top, r.bottom - r.top);
      } else if (direction === 'left') {
        advance = origin.left - r.right;
        crossHit = overlap1D(origin.top, origin.bottom, r.top, r.bottom);
        crossMid = (r.top + r.bottom) / 2;
        crossSpan = Math.min(origin.bottom - origin.top, r.bottom - r.top);
      } else if (direction === 'down') {
        advance = r.top - origin.bottom;
        crossHit = overlap1D(origin.left, origin.right, r.left, r.right);
        crossMid = (r.left + r.right) / 2;
        crossSpan = Math.min(origin.right - origin.left, r.right - r.left);
      } else { // up
        advance = origin.top - r.bottom;
        crossHit = overlap1D(origin.left, origin.right, r.left, r.right);
        crossMid = (r.left + r.right) / 2;
        crossSpan = Math.min(origin.right - origin.left, r.right - r.left);
      }

      // Must genuinely lie ahead. `tolerance` forgives sub-pixel layout noise.
      if (advance < -tolerance) continue;

      var aligned = crossHit > Math.min(10, Math.max(1, crossSpan) * 0.3);
      var drift = Math.abs(crossMid - originCross);
      // Aligned neighbours are ranked by travel distance; misaligned ones are
      // pushed behind every aligned option by a flat penalty.
      var score = Math.max(0, advance) + drift * (aligned ? 0.2 : 4) + (aligned ? 0 : 10000);

      if (score < bestScore) { bestScore = score; best = i; }
    }

    return best;
  }

  /* ── Performance policy ─────────────────────────────────────────────────── */

  // Chipset reality check. Sticks and older panels get the strictest budget.
  var LOW_TIER_PLATFORMS = { 'fire-tv': 1, webos: 1, tizen: 1, vidaa: 1, hbbtv: 1, 'opera-tv': 1,
    vestel: 1, 'philips-tv': 1, 'panasonic-tv': 1, 'netcast': 1, roku: 1, chromecast: 1, 'generic-tv': 1, 'smart-tv': 1 };
  var HIGH_TIER_PLATFORMS = { playstation: 1, xbox: 1, 'apple-tv': 1 };

  /**
   * Pick a rendering budget for this device.
   * @param {Object} env { platform, deviceMemory, hardwareConcurrency, screenWidth }
   */
  function computePerfProfile(env) {
    var e = env || {};
    var platform = e.platform || 'browser';
    var memory = typeof e.deviceMemory === 'number' ? e.deviceMemory : null;
    var cores = typeof e.hardwareConcurrency === 'number' ? e.hardwareConcurrency : null;

    var tier = 'mid';
    if (HIGH_TIER_PLATFORMS[platform]) tier = 'high';
    else if (LOW_TIER_PLATFORMS[platform]) tier = 'low';

    // Hardware facts override the platform guess in both directions.
    if ((memory !== null && memory <= 2) || (cores !== null && cores <= 2)) tier = 'low';
    else if (tier !== 'low' && memory !== null && memory >= 6 && cores !== null && cores >= 6) tier = 'high';

    // 4K panels cost 4x the fill rate of 1080p; never treat them as high tier.
    if (tier === 'high' && e.screenWidth >= 3840) tier = 'mid';

    if (tier === 'low') {
      // prefetch:1 — one warmed title at a time. A remote fires no mouseenter, so
      // without this every Play on a TV is a cold fetch; one request is cheap and
      // the proxy caches it, while a bigger number would compete with scrolling.
      return { tier: 'low', maxCards: 24, posterWidth: 185, deferOffscreenImages: true,
        animations: false, particles: false, blur: false, prefetch: 1, focusScrollBlock: 'nearest' };
    }
    if (tier === 'high') {
      return { tier: 'high', maxCards: 60, posterWidth: 342, deferOffscreenImages: false,
        animations: true, particles: false, blur: true, prefetch: 4, focusScrollBlock: 'center' };
    }
    return { tier: 'mid', maxCards: 36, posterWidth: 342, deferOffscreenImages: true,
      animations: false, particles: false, blur: false, prefetch: 2, focusScrollBlock: 'center' };
  }

  var core = {
    TV_UA_PATTERNS: TV_UA_PATTERNS,
    detectTvPlatform: detectTvPlatform,
    readTvOverride: readTvOverride,
    matchTvUserAgent: matchTvUserAgent,
    mapRemoteKey: mapRemoteKey,
    isDirection: isDirection,
    pickNextFocus: pickNextFocus,
    overlap1D: overlap1D,
    computePerfProfile: computePerfProfile
  };

  /* ═══════════════════════════════════════════════════════════════
     SECTION 2 — BROWSER LAYER
     ═══════════════════════════════════════════════════════════════ */

  var hasDom = typeof window !== 'undefined' && typeof document !== 'undefined' &&
    !!document.documentElement;

  // Callbacks handed over by moviezone.js via MovieZoneTV.configure().
  var hooks = {};
  var state = { isTv: false, platform: 'browser', confidence: 'none', tier: 'browser', profile: null, ready: false };

  var api = {
    // Pure core, also useful for debugging from the TV browser console.
    TV_UA_PATTERNS: TV_UA_PATTERNS,
    detectTvPlatform: detectTvPlatform,
    readTvOverride: readTvOverride,
    matchTvUserAgent: matchTvUserAgent,
    mapRemoteKey: mapRemoteKey,
    isDirection: isDirection,
    pickNextFocus: pickNextFocus,
    overlap1D: overlap1D,
    computePerfProfile: computePerfProfile,

    /** moviezone.js registers its internal state accessors + close handlers here. */
    configure: function (callbacks) {
      if (!callbacks) return api;
      for (var key in callbacks) {
        if (Object.prototype.hasOwnProperty.call(callbacks, key) && typeof callbacks[key] === 'function') {
          hooks[key] = callbacks[key];
        }
      }
      return api;
    },
    isTV: function () { return state.isTv; },
    getState: function () {
      return { isTv: state.isTv, platform: state.platform, confidence: state.confidence,
        tier: state.tier, profile: state.profile, ready: state.ready };
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    module.exports.core = core;
  }
  if (!hasDom) return;
  window.MovieZoneTV = api;

  /* ── Detection + tagging (runs immediately: moviezone.js reads the attribute
        while it is still parsing, so DOMContentLoaded would be far too late) ── */

  function safeMatchMedia(query) {
    try {
      return typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : null;
    } catch (err) { return null; }
  }

  var nav = window.navigator || {};
  var detection = detectTvPlatform({
    userAgent: nav.userAgent || '',
    search: window.location ? window.location.search : '',
    hasFinePointer: safeMatchMedia('(pointer: fine)'),
    hasAnyPointer: safeMatchMedia('(any-pointer: fine), (any-pointer: coarse)'),
    screenWidth: window.screen ? window.screen.width : window.innerWidth
  });

  state.isTv = detection.isTv;
  state.platform = detection.platform;
  state.confidence = detection.confidence;

  if (!state.isTv) return; // Phones, tablets and desktops leave here untouched.

  var profile = computePerfProfile({
    platform: detection.platform,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    screenWidth: window.screen ? window.screen.width : window.innerWidth
  });
  state.profile = profile;
  state.tier = profile.tier;

  var root = document.documentElement;
  root.setAttribute('data-mz-tv', 'true');
  root.setAttribute('data-mz-tv-platform', detection.platform);
  root.setAttribute('data-mz-tv-tier', profile.tier);
  root.setAttribute('data-mz-tv-confidence', detection.confidence);

  /* ── Small helpers ─────────────────────────────────────────────────────── */

  function byId(id) { return document.getElementById(id); }

  function callHook(name) {
    var fn = hooks[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(); } catch (err) { return undefined; }
  }

  function isEditable(el) {
    if (!el) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.isContentEditable === true;
  }

  function isVisibleRect(rect) {
    return !!rect && rect.width > 1 && rect.height > 1;
  }

  /* ── Focus scope: when an overlay is open, the D-pad must stay inside it ── */

  var OVERLAY_SCOPES = [
    { id: 'pwa-install-tv-overlay', openClass: 'open' },
    { id: 'pwa-install-overlay', openClass: 'open' },
    { id: 'modal-overlay', openClass: 'open' },
    { id: 'upcoming-detail-overlay', openClass: 'open' },
    { id: 'collections-hub-overlay', openClass: 'open' }
  ];

  function activeScope() {
    for (var i = 0; i < OVERLAY_SCOPES.length; i++) {
      var el = byId(OVERLAY_SCOPES[i].id);
      if (el && el.classList.contains(OVERLAY_SCOPES[i].openClass)) return el;
    }
    var dropdown = byId('searchDropdown');
    if (dropdown && dropdown.classList.contains('open')) return null; // dropdown lives in the navbar
    return null;
  }

  var FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '.movie-card',
    '.upcoming-card',
    '.search-result-item',
    '.cat-tab',
    '.ch-cat-tab',
    '.ch-card',
    '.carousel-thumb',
    '.carousel-dot'
  ].join(',');

  /* Focusable cache.
     Rebuilding the candidate list meant a querySelectorAll plus one
     getBoundingClientRect per element on EVERY key press. With a few hundred
     tiles in an infinite-scroll grid that is a forced synchronous layout per
     press — measured as the single most repeated cost during D-pad use.

     Two changes fix it:
       1. the list is cached and only rebuilt when the DOM or the viewport changes
       2. geometry is stored in DOCUMENT space (rect + scroll offset), which does
          not change while scrolling, so scrolling never invalidates the cache.
     Spatial navigation is purely relative, so document space works unchanged. */
  var focusCache = { entries: null, scope: null, byElement: null };

  function invalidateFocusCache() {
    focusCache.entries = null;
    focusCache.byElement = null;
  }

  /* Reading window.pageXOffset / scrollTop forces the browser to flush layout, so
     these are read at most once per key event and reused. */
  var scrollSnapshot = { x: 0, y: 0, valid: false };

  function refreshScrollSnapshot() {
    scrollSnapshot.x = window.pageXOffset || document.documentElement.scrollLeft || 0;
    scrollSnapshot.y = window.pageYOffset || document.documentElement.scrollTop || 0;
    scrollSnapshot.valid = true;
  }

  function scrollOffsetX() {
    if (!scrollSnapshot.valid) refreshScrollSnapshot();
    return scrollSnapshot.x;
  }
  function scrollOffsetY() {
    if (!scrollSnapshot.valid) refreshScrollSnapshot();
    return scrollSnapshot.y;
  }
  function invalidateScrollSnapshot() { scrollSnapshot.valid = false; }

  function toDocRect(rect, offsetX, offsetY) {
    return {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      right: rect.right + offsetX,
      bottom: rect.bottom + offsetY,
      width: rect.width,
      height: rect.height
    };
  }

  function buildFocusables(scope) {
    var nodes = scope.querySelectorAll(FOCUSABLE_SELECTOR);
    var offsetX = scrollOffsetX();
    var offsetY = scrollOffsetY();
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') continue;
      if (el.tabIndex < 0) continue;
      if (el.closest('[hidden]')) continue;
      var rect = el.getBoundingClientRect();
      if (!isVisibleRect(rect)) continue; // display:none / collapsed / closed overlay
      out.push({ el: el, rect: toDocRect(rect, offsetX, offsetY) });
    }
    return out;
  }

  // Returns focusables with document-space rects, rebuilding only when needed.
  function collectFocusables() {
    var scope = activeScope() || document.body;
    if (focusCache.entries && focusCache.scope === scope) return focusCache.entries;
    focusCache.entries = buildFocusables(scope);
    focusCache.scope = scope;
    focusCache.byElement = null;
    return focusCache.entries;
  }

  // Cached element -> entry lookup, so the focused element's geometry costs a map
  // hit instead of a getBoundingClientRect (which forces a full layout flush).
  function cachedEntryFor(el) {
    var entries = collectFocusables();
    if (!focusCache.byElement) {
      var map = typeof Map === 'function' ? new Map() : null;
      if (map) {
        for (var i = 0; i < entries.length; i++) map.set(entries[i].el, entries[i]);
      }
      focusCache.byElement = map;
    }
    if (focusCache.byElement) return focusCache.byElement.get(el) || null;
    for (var j = 0; j < entries.length; j++) {
      if (entries[j].el === el) return entries[j];
    }
    return null;
  }

  /* ── Prefetch on rest (makes Play feel instant) ────────────────────────────
     moviezone.js warms a title's details and the player hosts on `mouseenter`
     or `touchstart`. A remote fires neither, so on TV every Play was a cold
     fetch. Once the highlight has rested on a card we hand moviezone.js the
     same `mouseenter` it expects, so the detail page and player are already
     warm by the time OK is pressed.

     Debounced so sweeping across a row costs nothing, and skipped entirely on
     the weakest boxes where the extra work would compete with scrolling. */
  var PREFETCH_REST_MS = profile.tier === 'low' ? 900 : 650;
  var prefetchTimer = null;

  function schedulePrefetch(el) {
    if (!profile.prefetch) return;              // low tier opts out
    if (!el || !el.classList) return;
    if (!el.classList.contains('movie-card') && !el.classList.contains('upcoming-card')) return;
    if (el.hasAttribute('data-mztv-prefetched')) return;

    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(function () {
      prefetchTimer = null;
      if (document.activeElement !== el) return; // moved on already
      el.setAttribute('data-mztv-prefetched', '1');
      try {
        // Synthetic, so it never affects :hover styling — it only triggers the
        // prefetch listener moviezone.js attached to each card.
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: false }));
      } catch (err) {}
    }, PREFETCH_REST_MS);
  }

  function focusEntry(entry, direction) {
    if (!entry || !entry.el) return false;
    var el = entry.el;
    try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
    scrollFocusIntoView(el, direction, entry.rect);
    schedulePrefetch(el);
    return true;
  }

  /* Scrolling is the most expensive thing a TV browser does: every scroll forces
     layout and repaint of everything on screen. Two rules keep it cheap:
       1. work from the CACHED document-space rect — a live getBoundingClientRect
          here forces a full layout flush on every single key press, which
          profiling showed to be the largest self-time cost of the whole session
       2. only scroll when the target is actually hidden behind the navbar or off
          an edge. Most D-pad moves land on something already visible, and the
          cheapest scroll is no scroll. */
  var TOP_KEEPOUT = 112;    // sticky navbar + breathing room
  var BOTTOM_KEEPOUT = 24;

  function scrollFocusIntoView(el, direction, docRect) {
    var viewportH = window.innerHeight || 720;
    var viewportW = window.innerWidth || 1280;

    var rect = docRect
      ? { top: docRect.top - scrollOffsetY(), bottom: docRect.bottom - scrollOffsetY(),
          left: docRect.left - scrollOffsetX(), right: docRect.right - scrollOffsetX() }
      : el.getBoundingClientRect();

    var needsVertical = rect.top < TOP_KEEPOUT || rect.bottom > viewportH - BOTTOM_KEEPOUT;
    var needsHorizontal = rect.left < 0 || rect.right > viewportW;
    if (!needsVertical && !needsHorizontal) return; // already visible — do nothing

    var vertical = direction === 'up' || direction === 'down';
    try {
      el.scrollIntoView({
        behavior: 'auto',
        block: needsVertical ? (vertical ? profile.focusScrollBlock : 'nearest') : 'nearest',
        inline: needsHorizontal ? 'center' : 'nearest'
      });
    } catch (err) {
      el.scrollIntoView(direction === 'up' || direction === 'left');
    }
  }

  /* ── D-pad movement ────────────────────────────────────────────────────── */

  // Geometry comes from the cache; only an element we have never indexed costs a
  // live measurement.
  function currentFocus() {
    var el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;

    var cached = cachedEntryFor(el);
    if (cached) return cached;

    var rect = el.getBoundingClientRect();
    if (!isVisibleRect(rect)) return null;
    return { el: el, rect: toDocRect(rect, scrollOffsetX(), scrollOffsetY()) };
  }

  // No focus yet (fresh launch): start from whatever sits top-left on screen.
  function focusFirstOnScreen(direction) {
    var entries = collectFocusables();
    if (!entries.length) return false;
    var viewportH = window.innerHeight || 720;
    var offsetY = scrollOffsetY();
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < entries.length; i++) {
      var r = entries[i].rect;
      var viewTop = r.top - offsetY;
      if (viewTop + r.height < 0 || viewTop > viewportH) continue;
      var score = viewTop * 2 + r.left;
      if (score < bestScore) { bestScore = score; best = entries[i]; }
    }
    return focusEntry(best || entries[0], direction);
  }

  function moveFocus(direction) {
    var current = currentFocus();
    if (!current) return focusFirstOnScreen(direction);

    var entries = collectFocusables();
    if (!entries.length) return false;

    var rects = [];
    var selfIndex = -1;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].el === current.el) { selfIndex = i; rects.push(null); }
      else rects.push(entries[i].rect);
    }

    var pick = pickNextFocus(direction, current.rect, rects);
    if (pick >= 0) return focusEntry(entries[pick], direction);

    // Nothing lies that way. Left/right at a row edge should continue in reading
    // order (into the next/previous row) — that is what viewers expect from a grid.
    if ((direction === 'right' || direction === 'left') && selfIndex >= 0) {
      var step = direction === 'right' ? 1 : -1;
      var neighbour = entries[selfIndex + step];
      if (neighbour) return focusEntry(neighbour, direction);
    }

    // Vertical dead end: page the view so long lists still reach their footer.
    if (direction === 'down' || direction === 'up') {
      scrollPage(direction === 'down' ? 1 : -1);
      return true;
    }
    return false;
  }

  function scrollPage(sign) {
    var amount = Math.round((window.innerHeight || 720) * 0.8) * sign;
    try { window.scrollBy({ top: amount, left: 0, behavior: 'auto' }); }
    catch (err) { window.scrollBy(0, amount); }
  }

  /* ── OK / activation ──────────────────────────────────────────────────── */

  // Buttons and links fire a native click on Enter; a div.movie-card does not,
  // so it needs a synthesised one. moviezone.js guards against untrusted
  // activation, so we refresh its arm state first (no-op when the guard is off).
  var NATIVE_ENTER_TAGS = { BUTTON: 1, A: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1 };

  function activateFocused(event) {
    var el = document.activeElement;
    if (!el || el === document.body) return false;
    if (isEditable(el)) return false;            // search box owns its own Enter
    if (NATIVE_ENTER_TAGS[el.tagName]) return false; // let the browser do it

    if (typeof window.armTVDetailActivation === 'function') {
      try { window.armTVDetailActivation(false); } catch (err) {}
    }
    try {
      el.click();
    } catch (err) {
      return false;
    }
    if (event) event.preventDefault();
    return true;
  }

  /* ── Back button ──────────────────────────────────────────────────────── */

  function isOpen(id) {
    var el = byId(id);
    return !!el && el.classList.contains('open');
  }

  function handleBack() {
    // Most-nested surface first, exactly mirroring the Escape handling that
    // moviezone.js applies on non-TV devices.
    if (callHook('isFullscreen') === true) { callHook('exitFullscreen'); return true; }

    if (isOpen('pwa-install-tv-overlay')) {
      var tvDismiss = byId('pwaTvDismissBtn');
      if (tvDismiss) { tvDismiss.click(); return true; }
    }
    if (isOpen('pwa-install-overlay')) {
      var laterBtn = byId('pwaLaterBtn') || byId('pwaCloseBtn');
      if (laterBtn) { laterBtn.click(); return true; }
    }

    var dropdown = byId('searchDropdown');
    if (dropdown && dropdown.classList.contains('open')) { callHook('closeDropdown'); return true; }

    if (isOpen('modal-overlay')) { callHook('closeModal'); return true; }
    if (isOpen('upcoming-detail-overlay')) { callHook('closeUpcomingDetail'); return true; }
    if (isOpen('collections-hub-overlay')) { callHook('handleCollectionsBack'); return true; }

    if (callHook('isSearchResultsMode') === true || callHook('isFullViewMovies') === true ||
        callHook('isFullViewUpcoming') === true) {
      callHook('goHome');
      return true;
    }

    // Already home. Hand the key to the platform so Back exits the app instead
    // of trapping the viewer (Tizen/webOS need an explicit call).
    return exitApplication();
  }

  function exitApplication() {
    try {
      if (window.tizen && window.tizen.application) {
        window.tizen.application.getCurrentApplication().exit();
        return true;
      }
    } catch (err) {}
    try {
      if (window.webOS && window.webOS.platformBack) { window.webOS.platformBack(); return true; }
    } catch (err) {}
    return false; // let the browser's own Back run
  }

  /* ── Media / channel / colour keys ────────────────────────────────────── */

  function clickIfPresent(selector) {
    var el = document.querySelector(selector);
    if (!el) return false;
    el.click();
    return true;
  }

  function handleMediaAction(action) {
    switch (action) {
      case 'play':
      case 'playPause':
        // Streams run in cross-origin iframes we cannot script, so the useful
        // behaviour is starting playback from the detail page.
        if (isOpen('modal-overlay')) return clickIfPresent('#modal-overlay .btn-play');
        return activateFocused(null);
      case 'pause':
        return false;
      case 'stop':
        if (isOpen('modal-overlay')) { callHook('closeModal'); return true; }
        return false;
      case 'next':
        return clickIfPresent('#relatedNext');
      case 'previous':
        return clickIfPresent('#relatedPrev');
      case 'pageUp':
        scrollPage(-1); return true;
      case 'pageDown':
        scrollPage(1); return true;
      case 'home':
        callHook('goHome');
        window.scrollTo(0, 0);
        return true;
      case 'search':
      case 'green': {
        var input = byId('searchInput');
        if (input) { input.focus(); scrollFocusIntoView(input, 'up'); return true; }
        return false;
      }
      case 'red':
        callHook('goHome');
        window.scrollTo(0, 0);
        return true;
      case 'exit':
        return exitApplication();
      default:
        return false;
    }
  }

  /* ── Key listener ─────────────────────────────────────────────────────── */

  // Remotes emit key-repeat far faster than a weak TV can relayout. Coalescing
  // to one move per frame budget keeps the highlight glued to the finger.
  var MOVE_INTERVAL_MS = profile.tier === 'low' ? 110 : 70;
  // -Infinity, not 0: performance.now() is already tens of milliseconds by the
  // time the page is interactive, so a 0 start would swallow the very first
  // D-pad press of the session.
  var lastMoveAt = -Infinity;

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function onKeyDown(event) {
    var action = mapRemoteKey(event);
    if (!action) return;

    // One scroll-position read per key event, reused by every geometry helper.
    invalidateScrollSnapshot();

    var focused = document.activeElement;

    // Text fields, number spinners and <select> keep their native key handling
    // (the search box implements its own ArrowUp/Down/Enter behaviour).
    if (isEditable(focused)) {
      if (action === 'back') {
        // Escape/Back inside the search box: let moviezone close the dropdown,
        // then hand focus back to the grid so the remote is not stuck.
        callHook('closeDropdown');
        try { focused.blur(); } catch (err) {}
        event.preventDefault();
        return;
      }
      if (action === 'up' || action === 'down' || action === 'left' || action === 'right' || action === 'ok') {
        return; // native / moviezone handling
      }
    }

    if (isDirection(action)) {
      var t = now();
      if (t - lastMoveAt < MOVE_INTERVAL_MS) { event.preventDefault(); return; }
      lastMoveAt = t;
      if (moveFocus(action)) event.preventDefault();
      return;
    }

    if (action === 'ok') {
      if (activateFocused(event)) return;
      if (!document.activeElement || document.activeElement === document.body) {
        focusFirstOnScreen('down');
        event.preventDefault();
      }
      return;
    }

    if (action === 'back') {
      if (handleBack()) event.preventDefault();
      return;
    }

    if (handleMediaAction(action)) event.preventDefault();
  }

  document.addEventListener('keydown', onKeyDown, true);

  /* ── Keep focus alive when overlays open/close ─────────────────────────── */

  function focusInto(container) {
    if (!container) return false;
    var nodes = container.querySelectorAll(FOCUSABLE_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var rect = nodes[i].getBoundingClientRect();
      if (isVisibleRect(rect) && nodes[i].tabIndex >= 0) {
        focusEntry({ el: nodes[i] }, 'down');
        return true;
      }
    }
    return false;
  }

  // Reading a rect forces layout, so the freshly shown overlay can be measured
  // right away — no need to wait for a frame. requestAnimationFrame is avoided
  // here on purpose: TV browsers throttle it aggressively when they think the
  // page is idle, which would leave the remote with nothing focused.
  function handleOverlayOpened(el) {
    if (el.contains(document.activeElement)) return;
    if (focusInto(el)) return;
    // Some overlays get their content injected a beat later; try once more.
    setTimeout(function () {
      if (el.classList.contains('open') && !el.contains(document.activeElement)) focusInto(el);
    }, 90);
  }

  function watchOverlays() {
    if (typeof MutationObserver !== 'function') return;
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var target = records[i].target;
        if (!target.classList || !target.classList.contains('open')) continue;
        handleOverlayOpened(target);
      }
    });
    for (var s = 0; s < OVERLAY_SCOPES.length; s++) {
      var el = byId(OVERLAY_SCOPES[s].id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /* ── DOM sweep: focusability + image pressure relief ────────────────────
     One MutationObserver drives both jobs so a fast-scrolling grid triggers a
     single rAF batch instead of two competing ones.

     Focusability: renderMovies() gives .movie-card a tabIndex, but collection
     cards, carousel thumbs and dots are plain divs. Without a tab index the
     D-pad simply cannot reach them, so we grant one.

     Images: moviezone.js marks posters loading="eager" on TV to avoid lazy-load
     pops while D-padding. On a low-tier stick that means dozens of simultaneous
     decodes and a multi-second freeze. We park far-offscreen posters and restore
     them through an IntersectionObserver well before they are needed. */

  var FOCUSABLE_PROMOTIONS = '.movie-card, .upcoming-card, .ch-card, .search-result-item, .carousel-thumb, .carousel-dot, .cw-card, .continue-watching-card';

  var posterObserver = null;
  var sweepInstalled = false;
  var sweepScheduled = false;

  function ensureFocusable() {
    var nodes = document.querySelectorAll(FOCUSABLE_PROMOTIONS);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.hasAttribute('tabindex')) continue;
      el.setAttribute('tabindex', '0');
    }
  }

  function ensurePosterObserver() {
    if (posterObserver || typeof IntersectionObserver !== 'function') return posterObserver;
    // Purely observer-driven: no getBoundingClientRect anywhere, because a rect
    // read forces a synchronous layout of the whole grid.
    posterObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var img = entries[i].target;
        if (entries[i].isIntersecting) {
          var parked = img.getAttribute('data-mztv-src');
          if (parked) {
            img.setAttribute('src', parked);
            img.removeAttribute('data-mztv-src');
          }
          continue;
        }
        // Out of range and still loading: park the download/decode until needed.
        if (img.complete || img.getAttribute('data-mztv-src')) continue;
        var src = img.getAttribute('src');
        if (!src) continue;
        img.setAttribute('data-mztv-src', src);
        img.removeAttribute('src'); // width/height attributes keep the layout stable
      }
    }, { rootMargin: '400px 0px' });
    return posterObserver;
  }

  function parkOffscreenPosters() {
    if (!profile.deferOffscreenImages) return;
    var observer = ensurePosterObserver();
    if (!observer) return;

    var imgs = document.querySelectorAll('.movie-card img:not([data-mztv-seen]), .upcoming-card img:not([data-mztv-seen])');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].setAttribute('data-mztv-seen', '1');
      observer.observe(imgs[i]);
    }
  }

  function runSweep() {
    sweepScheduled = false;
    ensureFocusable();
    parkOffscreenPosters();
    invalidateFocusCache(); // tab indexes may have changed the candidate set
  }

  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    var ran = false;
    function once() {
      if (ran) return;
      ran = true;
      runSweep();
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
    // Safety net: several TV browsers throttle rAF once they decide the page is
    // idle, and the sweep is what makes new cards reachable by the D-pad.
    setTimeout(once, 60);
  }

  /* ── Render-budget containment ────────────────────────────────────────────
     Infinite scroll grows the grid without limit — measured at 137 tiles after a
     short browse, and moviezone.js's own card cap (getMaxCards) is dead code that
     nothing calls.

     The heavy lifting is left to the browser: moviezone.css already marks cards
     `content-visibility: auto`, and tv-mode.css adds `contain-intrinsic-size:
     auto ...` so a skipped tile keeps its remembered box instead of collapsing to
     the hard-coded 200x320 (that 2px-per-row mismatch was forcing a relayout of
     the whole grid every time a row scrolled in).

     An earlier version tagged every distant tile from an IntersectionObserver and
     applied `content-visibility: hidden`. Measured result: worst frame improved
     but the MEDIAN frame more than doubled, because scrolling flipped attributes
     on dozens of tiles and each flip invalidated style. Native `auto` does the
     same job off the main thread, so the per-tile bookkeeping is gone.

     Whole sections are different: there are only four of them, they flip rarely,
     and the hero keeps cross-fading a full-screen backdrop image even when it is
     far above the viewport. Those are worth an observer. */

  // Sections are skipped only while completely off screen, so nothing visible changes.
  var IDLE_SECTION_IDS = ['hero', 'continue-watching', 'upcoming'];
  var IDLE_SECTION_SELECTORS = ['.site-footer'];

  function watchIdleSections() {
    if (typeof IntersectionObserver !== 'function') return;
    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var el = entries[i].target;
        if (entries[i].isIntersecting) el.removeAttribute('data-mztv-idle');
        else el.setAttribute('data-mztv-idle', '1');
      }
      invalidateFocusCache(); // a skipped section removes its focusables
    }, { rootMargin: '25% 0px' });

    IDLE_SECTION_IDS.forEach(function (id) {
      var el = byId(id);
      if (el) observer.observe(el);
    });
    IDLE_SECTION_SELECTORS.forEach(function (selector) {
      var el = document.querySelector(selector);
      if (el) observer.observe(el);
    });
  }

  function setupDomSweep() {
    if (sweepInstalled) { scheduleSweep(); return; }
    sweepInstalled = true;
    if (typeof MutationObserver === 'function' && document.body) {
      new MutationObserver(scheduleSweep).observe(document.body, { childList: true, subtree: true });
    }
    scheduleSweep();
  }

  /* ── Frame watchdog: drop to the strictest budget if the TV struggles ──── */

  function watchFrameBudget() {
    if (profile.tier === 'low') return; // already at the floor
    var samples = 0;
    var slow = 0;
    var last = now();
    function tick() {
      var t = now();
      var delta = t - last;
      last = t;
      samples++;
      if (delta > 45) slow++;         // < ~22fps
      if (samples < 90) { requestAnimationFrame(tick); return; }
      if (slow / samples > 0.35) {
        profile = computePerfProfile({ platform: detection.platform, deviceMemory: 1, hardwareConcurrency: 1 });
        state.profile = profile;
        state.tier = profile.tier;
        root.setAttribute('data-mz-tv-tier', profile.tier);
        root.setAttribute('data-mz-tv-downgraded', 'true');
        MOVE_INTERVAL_MS = 110;
        setupDomSweep(); // picks up the now-enabled poster parking
      }
    }
    requestAnimationFrame(tick);
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  function boot() {
    watchOverlays();
    watchIdleSections();
    setupDomSweep();
    watchFrameBudget();
    // Layout-affecting events invalidate the cached navigation geometry.
    window.addEventListener('resize', invalidateFocusCache, { passive: true });
    window.addEventListener('orientationchange', invalidateFocusCache, { passive: true });
    window.addEventListener('load', invalidateFocusCache, { once: true });
    // Flag-only: no layout read here, so this stays free during scrolling.
    window.addEventListener('scroll', invalidateScrollSnapshot, { passive: true });
    state.ready = true;
    root.setAttribute('data-mz-tv-ready', 'true');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
