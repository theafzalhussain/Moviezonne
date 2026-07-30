/**
 * tv-mode.js — Isolated Google TV / Android TV / Smart TV support module.
 * Sets html[data-mz-tv="true"] for TV detection.
 * Provides D-pad spatial navigation, Page/Channel/Back keys, cancellable scrolling,
 * overlay/player focus hierarchy, and navbar item removal.
 * Exposes window.MovieZoneTV API and CommonJS exports for pure helpers/tests.
 * Must load BEFORE moviezone.js (inline or defer-ordered).
 */
(function tvModeInit(root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    // CommonJS — export pure helpers for testing
    module.exports = factory(true);
  } else {
    // Browser — auto-init
    var api = factory(false);
    root.MovieZoneTV = api;
  }
})(typeof window !== 'undefined' ? window : global, function tvFactory(isNodeEnv) {
  'use strict';

  // ─── PURE HELPERS (exported for testing) ──────────────────────────────────

  /**
   * TV Detection — pure function operating on UA string and optional userAgentData.
   * Targets Google/Android TV signatures across brands (Chromecast, Sony, TCL,
   * Xiaomi, Hisense, Shield, Fire TV, etc.). Android phones must NEVER auto-promote.
   * Additional TV signatures (Tizen, WebOS, Roku, etc.) are intentionally included
   * for broad Smart TV coverage.
   */
  var TV_UA_REGEX = /SmartTV|Web0S|WebOS|Tizen|VIDAA|Roku|RokuOS|AppleTV|Apple TV|Android TV|AndroidTV|BRAVIA|AFT[A-Z0-9]+|Fire TV|FireTV|CrKey|Chromecast|GoogleTV|Google TV|PlayStation|PS[45]|Xbox One|XBOX|SmartCast|PHILIPSTV|HbbTV|Opera TV|NETTV|Panasonic.*Viera|Vestel|DuneHD|Eltex|NetCast|MITV|MiTV/i;

  var TV_PLATFORM_REGEX = /smarttv|tizen|webos|android tv|googletv|chromecast|firetv/;
  var TV_BRAND_REGEX = /tizen|webos|smarttv|googletv|firetv/;

  var DESKTOP_OS_REGEX = /Windows NT|Macintosh|Mac OS X|CrOS|Ubuntu|Fedora|Linux x86_64|Linux i686/i;
  var MOBILE_DEVICE_REGEX = /Mobi|Android|iPhone|iPad|iPod/i;

  function detectTV(userAgent, userAgentData, urlTvParam) {
    // URL override takes absolute priority
    if (urlTvParam === '1') return true;
    if (urlTvParam === '0') return false;

    var ua = userAgent || '';

    // Check confirmed TV signatures in the UA string
    if (TV_UA_REGEX.test(ua)) return true;

    // Check userAgentData platform hints (Chromium reduced-UA)
    if (userAgentData) {
      var platform = (userAgentData.platform || '').toLowerCase();
      if (TV_PLATFORM_REGEX.test(platform)) return true;
      var brands = userAgentData.brands || [];
      var brandStr = brands.map(function(b) { return b.brand; }).join(' ').toLowerCase();
      if (TV_BRAND_REGEX.test(brandStr)) return true;
    }

    // Standard desktop/mobile OS signatures are never promoted to TV mode
    if (DESKTOP_OS_REGEX.test(ua) || MOBILE_DEVICE_REGEX.test(ua)) return false;

    return false;
  }

  /**
   * Key normalization — maps platform-specific key names/codes to canonical actions.
   */
  function normalizeKey(key, keyCode) {
    // Direction keys — legacy Android TV browsers may expose only keyCode.
    if (key === 'ArrowLeft' || keyCode === 37) return 'left';
    if (key === 'ArrowRight' || keyCode === 39) return 'right';
    if (key === 'ArrowUp' || keyCode === 38) return 'up';
    if (key === 'ArrowDown' || keyCode === 40) return 'down';

    // Enter/Select — 23 is DPAD_CENTER and 66 is KEYCODE_ENTER on Android TV.
    if (key === 'Enter' || keyCode === 13 || keyCode === 23 || keyCode === 66) return 'enter';
    if (key === ' ' || keyCode === 32) return 'space';

    // Page/Channel scroll
    if (key === 'PageDown' || key === 'ChannelDown' || keyCode === 34 || keyCode === 428) return 'pagedown';
    if (key === 'PageUp' || key === 'ChannelUp' || keyCode === 33 || keyCode === 427) return 'pageup';

    // Back keys (Android=4, Tizen=10009, WebOS=461)
    if (key === 'Escape' || key === 'BrowserBack' || key === 'GoBack' ||
        keyCode === 4 || keyCode === 27 || keyCode === 10009 || keyCode === 461) return 'back';
    if (key === 'Backspace' || keyCode === 8) return 'backspace';

    // Media keys
    if (key === 'MediaPlayPause' || key === 'MediaPlay' || key === 'MediaPause' ||
        keyCode === 179 || keyCode === 415 || keyCode === 19) return 'playpause';
    if (key === 'MediaStop' || keyCode === 413) return 'stop';
    if (key === 'MediaFastForward' || keyCode === 417) return 'fastforward';
    if (key === 'MediaRewind' || keyCode === 412) return 'rewind';

    return null;
  }

  /**
   * Nearest-target scoring — pure spatial calculation.
   * Returns distance score or Infinity if not in direction.
   */
  function scoreCandidate(currentRect, candidateRect, direction) {
    var cx = currentRect.left + currentRect.width / 2;
    var cy = currentRect.top + currentRect.height / 2;
    var ex = candidateRect.left + candidateRect.width / 2;
    var ey = candidateRect.top + candidateRect.height / 2;
    var dx = ex - cx;
    var dy = ey - cy;

    var inDirection = false;
    switch (direction) {
      case 'left':  inDirection = dx < -10; break;
      case 'right': inDirection = dx > 10; break;
      case 'up':    inDirection = dy < -10; break;
      case 'down':  inDirection = dy > 10; break;
    }
    if (!inDirection) return Infinity;

    var primaryDist, crossDist;
    if (direction === 'left' || direction === 'right') {
      primaryDist = Math.abs(dx);
      crossDist = Math.abs(dy);
    } else {
      primaryDist = Math.abs(dy);
      crossDist = Math.abs(dx);
    }
    return primaryDist + crossDist * 3;
  }

  /**
   * Scroll calculation — compute target scrollTop for a page-scroll.
   * Returns { target, clamped } where target is the ideal position and
   * clamped is bounded to [0, maxScroll].
   */
  function computeScrollTarget(currentScrollTop, viewportHeight, direction, maxScroll) {
    var amount = Math.max(240, Math.round((viewportHeight || 600) * 0.78));
    var target = currentScrollTop + (amount * direction);
    var clamped = Math.max(0, Math.min(target, maxScroll));
    return { target: target, clamped: clamped };
  }

  /**
   * Scroll interpolation — compute intermediate position for animation frame.
   * t is normalized progress [0..1], uses easeOutCubic.
   */
  function interpolateScroll(start, end, t) {
    var eased = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
    return start + (end - start) * eased;
  }

  // ─── NODE ENVIRONMENT: Export pure helpers only ────────────────────────────
  if (isNodeEnv) {
    return {
      detectTV: detectTV,
      normalizeKey: normalizeKey,
      scoreCandidate: scoreCandidate,
      computeScrollTarget: computeScrollTarget,
      interpolateScroll: interpolateScroll,
      _TV_UA_REGEX: TV_UA_REGEX,
      _DESKTOP_OS_REGEX: DESKTOP_OS_REGEX,
      _MOBILE_DEVICE_REGEX: MOBILE_DEVICE_REGEX
    };
  }



  // ─── BROWSER ENVIRONMENT ─────────────────────────────────────────────────

  // ─── TV DETECTION ─────────────────────────────────────────────────────────
  var ua = navigator.userAgent;
  var urlParams = new URLSearchParams(window.location.search);
  var tvParam = urlParams.get('tv');

  var userAgentData = navigator.userAgentData || null;
  var detectedTV = detectTV(ua, userAgentData, tvParam);

  if (tvParam === '1') {
    console.log('[MovieZone TV] TV mode forced via ?tv=1');
  } else if (tvParam === '0') {
    console.log('[MovieZone TV] TV mode disabled via ?tv=0');
  }

  // Set the data attribute that all other modules read
  if (detectedTV) {
    document.documentElement.setAttribute('data-mz-tv', 'true');
  }

  console.log('[MovieZone TV] Detection:', detectedTV, '| UA:', ua.substring(0, 80));

  // ─── STATE ──────────────────────────────────────────────────────────────────
  var _active = detectedTV;
  var _destroyed = false;
  var activeScrollAnimation = null;
  var _lastFocusBeforeModal = null;
  var _mutationFrame = null;
  var _managedFocusTarget = null;

  // Configure callbacks — moviezone.js registers these to communicate state
  var _callbacks = {
    isSearchResultsMode: null,
    isFullViewMovies: null,
    isFullViewUpcoming: null,
    closeModal: null,
    closeDropdown: null,
    goHome: null,
    handleCollectionsBack: null,
    closeUpcomingDetail: null,
    closePwaOverlay: null,
    closePwaTvOverlay: null,
    isFullscreen: null,
    exitFullscreen: null
  };

  // ─── API OBJECT ─────────────────────────────────────────────────────────────
  var api = {
    // Detection
    detectTV: detectTV,
    isActive: function() { return _active && !_destroyed; },

    // Pure helpers
    normalizeKey: normalizeKey,
    scoreCandidate: scoreCandidate,
    computeScrollTarget: computeScrollTarget,
    interpolateScroll: interpolateScroll,

    // Configure — moviezone.js calls this to register state callbacks
    configure: function(opts) {
      if (!opts) return;
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k) && k in _callbacks) {
          _callbacks[k] = opts[k];
        }
      }
    },

    // Cleanup
    cleanup: function() {
      _destroyed = true;
      cancelTVScroll();
      if (_mutationFrame) { cancelAnimationFrame(_mutationFrame); _mutationFrame = null; }
      if (_observer) { _observer.disconnect(); _observer = null; }
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('focus', handleFocus, true);
      document.removeEventListener('DOMContentLoaded', removeTVHiddenItems);
      document.removeEventListener('DOMContentLoaded', refreshTVDOM);
      document.removeEventListener('DOMContentLoaded', removeHeavyEffects);
    },

    // Re-init (for testing)
    init: function() {
      _destroyed = false;
      _active = detectedTV;
    },

    // Expose for external checks (read-only)
    get detected() { return detectedTV; }
  };

  // Legacy compat
  window.__mzTVDetected = detectedTV;

  // Exit early if not TV — everything below is TV-only runtime
  if (!detectedTV) return api;



  // ─── INITIAL STATE ──────────────────────────────────────────────────────────
  if (!window.history.state || !window.history.state.mzHome) {
    window.history.replaceState({ mzHome: true }, '', window.location.pathname + window.location.search);
  }

  // ─── REMOVE HOLLYWOOD/SOUTH FROM DOM ON TV ──────────────────────────────────
  function removeTVHiddenItems() {
    document.querySelectorAll('[data-tv-hide]').forEach(function(el) {
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('tabindex', '-1');
      var links = el.querySelectorAll('a, button');
      links.forEach(function(link) { link.setAttribute('tabindex', '-1'); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', removeTVHiddenItems);
  } else {
    removeTVHiddenItems();
  }

  // ─── D-PAD SPATIAL NAVIGATION ───────────────────────────────────────────────
  var TV_FOCUSABLE_SELECTORS = '.movie-card, .upcoming-card, .cat-tab, .btn-play, .btn-info, .player-chip, .nav-links a, .carousel-arrow, input:not([disabled]), select:not([disabled]), #playerFrame, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  var TV_IMAGE_SELECTORS = '.movie-card img, .upcoming-card img, .cw-card img, .ch-mosaic-tile img, .ch-card-posters img, .ch-movie-card img, #modal-overlay img, #upcoming-detail-overlay img';

  var tvPageReady = false;
  var tvFirstInteractionTime = 0;

  function markFocusable() {
    document.querySelectorAll(TV_FOCUSABLE_SELECTORS).forEach(function(el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
  }

  function prepareTVImages() {
    document.querySelectorAll(TV_IMAGE_SELECTORS).forEach(function(img) {
      if (img.getAttribute('loading') !== 'eager') img.setAttribute('loading', 'eager');
      if (img.hasAttribute('data-ch-reveal') || img.closest('.collections-hub-overlay')) {
        img.classList.add('ch-img-in');
        var inner = img.closest('.ch-movie-card-inner');
        if (inner) inner.classList.add('ch-img-in');
      }
    });
  }

  function refreshTVDOM() {
    _mutationFrame = null;
    markFocusable();
    prepareTVImages();
    removeTVHiddenItems();
  }

  function scheduleTVDOMRefresh() {
    if (_mutationFrame) return;
    _mutationFrame = requestAnimationFrame(refreshTVDOM);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshTVDOM);
  } else {
    refreshTVDOM();
  }

  var _observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length > 0) {
        scheduleTVDOMRefresh();
        break;
      }
    }
  });
  _observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

  function getActiveFocusRoot() {
    var downloadOverlay = document.getElementById('dlModal');
    if (downloadOverlay && getComputedStyle(downloadOverlay).display !== 'none') return downloadOverlay;

    var overlayIds = [
      'modal-overlay',
      'upcoming-detail-overlay',
      'collections-hub-overlay',
      'pwa-install-tv-overlay',
      'pwa-install-overlay'
    ];
    for (var i = 0; i < overlayIds.length; i++) {
      var overlay = document.getElementById(overlayIds[i]);
      if (overlay && overlay.classList.contains('open')) return overlay;
    }
    return document;
  }

  function getVisibleFocusables() {
    var root = getActiveFocusRoot();
    var els = root.querySelectorAll(TV_FOCUSABLE_SELECTORS);
    return Array.from(els).filter(function(el) {
      if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function findNearest(current, direction) {
    var focusables = getVisibleFocusables();
    var currentRect = current.getBoundingClientRect();
    var best = null;
    var bestDist = Infinity;

    for (var i = 0; i < focusables.length; i++) {
      var el = focusables[i];
      if (el === current) continue;
      var r = el.getBoundingClientRect();
      var dist = scoreCandidate(currentRect, r, direction);
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }
    return best;
  }



  // ─── CANCELLABLE RAF SCROLLING ──────────────────────────────────────────────
  var SCROLL_DURATION_MS = 180;

  function cancelTVScroll() {
    if (activeScrollAnimation) {
      cancelAnimationFrame(activeScrollAnimation);
      activeScrollAnimation = null;
    }
  }

  // Detect reduced-motion preference or low-power
  function shouldUseInstantScroll() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
             (navigator.deviceMemory && navigator.deviceMemory < 2);
    } catch (e) { return false; }
  }

  function getTVScrollContainer() {
    var overlayIds = ['modal-overlay', 'upcoming-detail-overlay', 'pwa-install-tv-overlay', 'pwa-install-overlay'];
    for (var i = 0; i < overlayIds.length; i++) {
      var overlay = document.getElementById(overlayIds[i]);
      if (overlay && overlay.classList.contains('open')) return overlay;
    }

    var collections = document.getElementById('collections-hub-overlay');
    if (collections && collections.classList.contains('open')) {
      return document.getElementById('chScroll') || collections;
    }

    return document.scrollingElement || document.documentElement;
  }

  function getScrollOwnerInfo(scroller) {
    var isDocument = scroller === document.scrollingElement ||
      scroller === document.documentElement || scroller === document.body;
    return {
      isDocument: isDocument,
      viewportHeight: isDocument ? window.innerHeight : scroller.clientHeight,
      currentScrollTop: isDocument ? (window.pageYOffset || document.documentElement.scrollTop) : scroller.scrollTop,
      maxScroll: isDocument
        ? (document.documentElement.scrollHeight - window.innerHeight)
        : (scroller.scrollHeight - scroller.clientHeight)
    };
  }

  function applyScroll(scroller, info, position) {
    if (info.isDocument) {
      window.scrollTo(0, position);
    } else {
      scroller.scrollTop = position;
    }
  }

  function scrollTVPage(direction) {
    cancelTVScroll();
    var scroller = getTVScrollContainer();
    if (!scroller) return;

    var info = getScrollOwnerInfo(scroller);
    var result = computeScrollTarget(info.currentScrollTop, info.viewportHeight, direction, info.maxScroll);

    // Instant fallback for reduced-motion or low-power devices
    if (shouldUseInstantScroll()) {
      applyScroll(scroller, info, result.clamped);
      return;
    }

    // Animated scroll with requestAnimationFrame
    var startPos = info.currentScrollTop;
    var endPos = result.clamped;
    if (startPos === endPos) return;

    var startTime = null;

    function animateFrame(timestamp) {
      if (!startTime) startTime = timestamp;
      var elapsed = timestamp - startTime;
      var t = Math.min(elapsed / SCROLL_DURATION_MS, 1);
      var pos = interpolateScroll(startPos, endPos, t);
      applyScroll(scroller, info, pos);

      if (t < 1) {
        activeScrollAnimation = requestAnimationFrame(animateFrame);
      } else {
        activeScrollAnimation = null;
      }
    }

    activeScrollAnimation = requestAnimationFrame(animateFrame);
  }

  function focusAndRevealTVTarget(target, direction) {
    cancelTVScroll(); // Cancel any ongoing scroll on new navigation
    _managedFocusTarget = target;
    try {
      try { target.focus({ preventScroll: true }); }
      catch (error) { target.focus(); }
    } finally {
      _managedFocusTarget = null;
    }
    try {
      target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    } catch (error) {
      target.scrollIntoView(direction !== 'up');
    }
  }



  // ─── DETAIL ACTIVATION INTEGRATION ─────────────────────────────────────────
  function armTVDetail(fromRelease) {
    if (typeof window.armTVDetailActivation === 'function') {
      window.armTVDetailActivation(fromRelease);
    }
  }

  function getDetailGuard() {
    return window.detailActivationGuard || {};
  }

  function detailNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  var observedInteractionEpoch = 0;

  function syncTVPageReadiness() {
    var guard = getDetailGuard();
    if (guard.tvInteractionEpoch != null && observedInteractionEpoch !== guard.tvInteractionEpoch) {
      observedInteractionEpoch = guard.tvInteractionEpoch;
      tvPageReady = false;
      tvFirstInteractionTime = 0;
    }
  }

  // ─── BACK HIERARCHY ─────────────────────────────────────────────────────────
  // Order: fullscreen > modal > upcoming detail > collections detail/hub >
  //        TV PWA overlay > normal PWA overlay > search dropdown/results > home
  function handleBackKey(e) {
    // 1. Fullscreen exit first
    var nativeFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    var callbackFullscreen = _callbacks.isFullscreen && _callbacks.isFullscreen();
    if (nativeFullscreen || callbackFullscreen) {
      if (_callbacks.exitFullscreen) {
        _callbacks.exitFullscreen();
      } else {
        try {
          var exitResult = document.exitFullscreen
            ? document.exitFullscreen()
            : (document.webkitExitFullscreen ? document.webkitExitFullscreen() : null);
          if (exitResult && typeof exitResult.catch === 'function') exitResult.catch(function() {});
        } catch (error) {}
      }
      e.preventDefault();
      return;
    }

    // Download options are rendered above the watch modal.
    var downloadOverlay = document.getElementById('dlModal');
    if (downloadOverlay) {
      downloadOverlay.remove();
      e.preventDefault();
      return;
    }

    // 2. Modal overlay
    var modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay && modalOverlay.classList.contains('open')) {
      if (_callbacks.closeModal) {
        _callbacks.closeModal();
      } else if (typeof window.closeModal === 'function') {
        window.closeModal();
      }
      // Restore source focus after modal close
      if (_lastFocusBeforeModal) {
        setTimeout(function() {
          try { _lastFocusBeforeModal.focus(); } catch(err) {}
          _lastFocusBeforeModal = null;
        }, 50);
      }
      e.preventDefault();
      return;
    }

    // 3. Upcoming detail overlay
    var upcomingOverlay = document.getElementById('upcoming-detail-overlay');
    if (upcomingOverlay && upcomingOverlay.classList.contains('open')) {
      if (_callbacks.closeUpcomingDetail) {
        _callbacks.closeUpcomingDetail();
      } else if (typeof window.closeUpcomingDetail === 'function') {
        window.closeUpcomingDetail();
      }
      e.preventDefault();
      return;
    }

    // 4. Collections detail/hub
    var collectionsOverlay = document.getElementById('collections-hub-overlay');
    if (collectionsOverlay && collectionsOverlay.classList.contains('open')) {
      if (_callbacks.handleCollectionsBack) {
        _callbacks.handleCollectionsBack();
      } else if (typeof window.handleCollectionsBack === 'function') {
        window.handleCollectionsBack();
      }
      e.preventDefault();
      return;
    }

    // 5. TV PWA install overlay
    var pwaTvOverlay = document.getElementById('pwa-install-tv-overlay');
    if (pwaTvOverlay && pwaTvOverlay.classList.contains('open')) {
      if (_callbacks.closePwaTvOverlay) {
        _callbacks.closePwaTvOverlay();
      } else {
        pwaTvOverlay.classList.remove('open');
        document.body.style.overflow = '';
      }
      e.preventDefault();
      return;
    }

    // 6. Normal PWA install overlay
    var pwaOverlay = document.getElementById('pwa-install-overlay');
    if (pwaOverlay && pwaOverlay.classList.contains('open')) {
      if (_callbacks.closePwaOverlay) {
        _callbacks.closePwaOverlay();
      } else {
        pwaOverlay.classList.remove('open');
        document.body.style.overflow = '';
      }
      e.preventDefault();
      return;
    }

    // 7. Search dropdown/results
    var dd = document.getElementById('searchDropdown');
    if (dd && dd.classList.contains('open')) {
      if (_callbacks.closeDropdown) {
        _callbacks.closeDropdown();
      } else if (typeof window.closeDropdown === 'function') {
        window.closeDropdown();
      }
      e.preventDefault();
      return;
    }

    // Check search results mode via callbacks
    var inSearchResults = _callbacks.isSearchResultsMode ? _callbacks.isSearchResultsMode() : false;
    var inFullViewMovies = _callbacks.isFullViewMovies ? _callbacks.isFullViewMovies() : false;
    var inFullViewUpcoming = _callbacks.isFullViewUpcoming ? _callbacks.isFullViewUpcoming() : false;

    if (inSearchResults || inFullViewMovies || inFullViewUpcoming) {
      e.preventDefault();
      if (_callbacks.goHome) {
        _callbacks.goHome();
      } else if (typeof window.goHome === 'function') {
        window.goHome();
      }
      var si = document.getElementById('searchInput');
      if (si) si.value = '';
      return;
    }

    // 8. Already on home — let the browser handle back (exit/previous page)
  }



  // ─── MAIN KEYDOWN HANDLER ──────────────────────────────────────────────────
  function handleKeyDown(e) {
    if (!e.isTrusted) return;
    syncTVPageReadiness();

    var key = e.key;
    var keyCode = e.keyCode || e.which;
    var action = normalizeKey(key, keyCode);

    // Dedicated page/channel keys
    if (action === 'pagedown' || action === 'pageup') {
      e.preventDefault();
      tvPageReady = true;
      armTVDetail(false);
      scrollTVPage(action === 'pagedown' ? 1 : -1);
      return;
    }

    // D-Pad Arrow Navigation
    var directionMap = { 'left': 'left', 'right': 'right', 'up': 'up', 'down': 'down' };
    if (action && directionMap[action]) {
      var direction = directionMap[action];
      // Don't intercept when search input focused with dropdown open
      var searchDropdown = document.getElementById('searchDropdown');
      if (document.activeElement && document.activeElement.id === 'searchInput' &&
          searchDropdown && searchDropdown.classList.contains('open') &&
          (direction === 'up' || direction === 'down')) {
        armTVDetail(false);
        return;
      }
      // Native TV select popups need vertical arrows to change options.
      if (document.activeElement && document.activeElement.tagName === 'SELECT' &&
          (direction === 'up' || direction === 'down')) {
        tvPageReady = true;
        armTVDetail(false);
        return;
      }
      e.preventDefault();
      tvPageReady = true; // D-pad movement proves this is a deliberate post-launch interaction
      armTVDetail(false);
      var active = document.activeElement;
      var focusRoot = getActiveFocusRoot();
      var activeOutsideOverlay = focusRoot !== document && active && !focusRoot.contains(active);
      if (!active || active === document.body || activeOutsideOverlay) {
        var visibleFocusables = getVisibleFocusables();
        var safeFocusables = visibleFocusables.filter(function(el) {
          return !el.classList.contains('btn-play') && !el.classList.contains('movie-card');
        });
        var first = safeFocusables[0] || visibleFocusables[0];
        if (first) first.focus();
        return;
      }
      var target = findNearest(active, direction);
      if (target) {
        focusAndRevealTVTarget(target, direction);
      } else if (direction === 'up' || direction === 'down') {
        scrollTVPage(direction === 'down' ? 1 : -1);
      }
      return;
    }

    // Enter/Space: Click focused element
    if (action === 'enter' || action === 'space') {
      if (document.activeElement && document.activeElement.id === 'searchInput') {
        armTVDetail(false);
        return;
      }
      if (document.activeElement && document.activeElement.tagName === 'SELECT') {
        tvPageReady = true;
        armTVDetail(false);
        return;
      }
      var guard = getDetailGuard();
      var activationNow = detailNow();
      if (!e.isTrusted || e.repeat || !tvPageReady ||
          (guard.tvActivationArmed === false) ||
          (guard.tvActivationAllowedAt != null && activationNow < guard.tvActivationAllowedAt)) {
        e.preventDefault();
        return;
      }
      var now = Date.now();
      if (now - tvFirstInteractionTime < 300) {
        e.preventDefault();
        return;
      }
      tvFirstInteractionTime = now;

      if (document.activeElement && document.activeElement !== document.body) {
        // Save focus source before potential modal open
        _lastFocusBeforeModal = document.activeElement;
        document.activeElement.click();
        e.preventDefault();
      }
      return;
    }

    // Back keys
    if (action === 'back') {
      handleBackKey(e);
      return;
    }
    // Backspace as back (only when not in input)
    if (action === 'backspace' && document.activeElement && document.activeElement.tagName !== 'INPUT') {
      handleBackKey(e);
      return;
    }

    // Media keys
    if (action === 'playpause' || action === 'stop' || action === 'fastforward' || action === 'rewind') {
      e.preventDefault();
      if (action === 'playpause') {
        var playBtn = document.querySelector('.play-big') || document.querySelector('.premium-play-btn') || document.querySelector('.btn-play');
        if (playBtn) playBtn.click();
      }
      return;
    }
  }

  // Keyup: arm activation
  function handleKeyUp(e) {
    if (!e.isTrusted) return;
    syncTVPageReadiness();
    var code = e.keyCode || e.which;
    if (e.key === 'Enter' || e.key === ' ' || code === 13 || code === 32) {
      tvPageReady = true;
      armTVDetail(true);
    }
  }

  // Auto-scroll focused element to center
  function handleFocus(e) {
    if (_managedFocusTarget === e.target) return;
    var overlay = document.getElementById('modal-overlay');
    if (e.target && e.target.scrollIntoView && (!overlay || !overlay.classList.contains('open'))) {
      try {
        e.target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      } catch (err) {
        e.target.scrollIntoView(true);
      }
    }
  }

  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);
  document.addEventListener('focus', handleFocus, true);



  // ─── OPTIMIZE HEAVY EFFECTS ─────────────────────────────────────────────────
  function removeHeavyEffects() {
    var particles = document.querySelector('.ambient-particles');
    if (particles) particles.remove();
    var glow = document.getElementById('cursor-glow');
    if (glow) glow.style.display = 'none';
    var ring = document.getElementById('cursor-ring');
    if (ring) ring.style.display = 'none';
    var dot = document.getElementById('cursor-dot');
    if (dot) dot.style.display = 'none';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', removeHeavyEffects);
  } else {
    removeHeavyEffects();
  }

  return api;
});
