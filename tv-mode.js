// TV Mode Detection & Remote Navigation for MovieZone
// Sets html[data-mz-tv="true"] for TV-specific CSS/JS behavior

(function () {
  'use strict';

  // TV POST KEYUP DEBOUNCE
  var TV_POST_KEYUP_DEBOUNCE_MS = 400;
  var tvActivationAllowedAt = 0;
  var tvActivationArmed = false;
  // D-pad movement proves intentional navigation

  // ──────────────────────────────────────────────────────────────────────────
  // TV DETECTION
  // ──────────────────────────────────────────────────────────────────────────

  function detectTV() {
    var ua = navigator.userAgent || '';
    var uaData = navigator.userAgentData;

    // Explicit force via URL param (?tv=1) - useful for testing
    var tvParam = new URLSearchParams(window.location.search).get('tv');
    if (tvParam === '1') {
      return true;
    }

    // Primary UA detection for known TV platforms
    var tvUA = /SmartTV|Web0S|WebOS|Tizen|VIDAA|Roku|RokuOS|AppleTV|Apple TV|Android TV|AndroidTV|BRAVIA|AFT[A-Z0-9]+|Fire TV|FireTV|CrKey|Chromecast|GoogleTV|Google TV|PlayStation|PS[45]|Xbox One|XBOX|SmartCast|PHILIPSTV|HbbTV|Opera TV|NETTV|Panasonic.*Viera|Vestel|DuneHD|Eltex|NetCast|MITV|MiTV/i.test(ua);
    if (tvUA) return true;

    // Client Hints API (modern browsers)
    if (uaData) {
      var platform = (uaData.platform || '').toLowerCase();
      if (/smarttv|tizen|webos|android tv|googletv|chromecast|firetv/.test(platform)) return true;

      var brands = (uaData.brands || []).map(function(b) { return (b.brand || '').toLowerCase(); }).join(' ');
      if (/tizen|webos|smarttv|googletv|firetv/.test(brands)) return true;
    }

    // Exclude known non-TV platforms
    var isDesktopOS = /Windows NT|Macintosh|Mac OS X|CrOS|Ubuntu|Fedora|Linux x86_64|Linux i686/i.test(ua);
    var isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    if (isDesktopOS || isMobileDevice) return false;

    return false;
  }

  var isTV = detectTV();

  // ──────────────────────────────────────────────────────────────────────────
  // APPLY TV MODE
  // ──────────────────────────────────────────────────────────────────────────

  if (isTV) {
    document.documentElement.setAttribute('data-mz-tv', 'true');
    document.documentElement.classList.add('mz-tv-mode');
    console.log('[MovieZone TV] TV mode activated');
  }

  // Expose for other modules
  window.MovieZoneTV = window.MovieZoneTV || {};
  window.MovieZoneTV.isTV = function () { return isTV; };

  // ──────────────────────────────────────────────────────────────────────────
  // TV REMOTE NAVIGATION (D-pad, Enter, Back, Page/Channel keys)
  // ──────────────────────────────────────────────────────────────────────────

  if (!isTV) return;

  // Configuration callbacks (set by moviezone.js)
  var config = {
    isSearchResultsMode: function() { return false; },
    isFullViewMovies: function() { return false; },
    isFullViewUpcoming: function() { return false; },
    closeModal: function() {},
    closeDropdown: function() {},
    goHome: function() {},
    closeUpcomingDetail: function() {},
    handleCollectionsBack: function() {},
    isFullscreen: function() { return false; },
    exitFullscreen: function() {}
  };

  window.MovieZoneTV.configure = function (cfg) {
    config = { isSearchResultsMode: config.isSearchResultsMode, isFullViewMovies: config.isFullViewMovies, isFullViewUpcoming: config.isFullViewUpcoming, closeModal: config.closeModal, closeDropdown: config.closeDropdown, goHome: config.goHome, closeUpcomingDetail: config.closeUpcomingDetail, handleCollectionsBack: config.handleCollectionsBack, isFullscreen: config.isFullscreen, exitFullscreen: config.exitFullscreen, ...cfg };
  };

  // Focus management
  var focusedElement = null;
  var FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea, .movie-card, .upcoming-card, .cat-tab, .load-more-btn';

  function getFocusableElements(container) {
    container = container || document;
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(function(el) { return isVisible(el) && !el.hasAttribute('disabled'); });
  }

  function isVisible(el) {
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function setFocus(el, direction) {
    if (!el || !isVisible(el)) return false;
    try {
      el.focus({ preventScroll: true });
      focusedElement = el;
      el.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
      return true;
    } catch (e) {
      return false;
    }
  }

  function moveFocus(direction) {
    var focusables = getFocusableElements();
    if (focusables.length === 0) return;

    var currentIndex = focusedElement ? focusables.indexOf(focusedElement) : -1;
    var nextIndex = currentIndex;

    var cols = estimateColumns(focusables);

    switch (direction) {
      case 'right': nextIndex = currentIndex + 1; break;
      case 'left': nextIndex = currentIndex - 1; break;
      case 'down': nextIndex = currentIndex + cols; break;
      case 'up': nextIndex = currentIndex - cols; break;
    }

    // Clamp
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= focusables.length) nextIndex = focusables.length - 1;

    if (nextIndex !== currentIndex) {
      setFocus(focusables[nextIndex], direction);
    }
  }

  function estimateColumns(elements) {
    if (elements.length === 0) return 4;
    var first = elements[0].getBoundingClientRect();
    if (first.width === 0) return 4;
    var containerWidth = window.innerWidth;
    return Math.max(1, Math.floor(containerWidth / (first.width + 16)));
  }

  // Focus reveal with legacy scrollIntoView support
  function focusAndRevealTVTarget(target, direction) {
    if (!target) return;
    setFocus(target, direction);
    try {
      target.scrollIntoView(direction !== 'up');
    } catch (e) {
      target.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
  }

  // Initial focus on load
  function initializeFocus() {
    var focusables = getFocusableElements();
    if (focusables.length > 0) {
      // Prefer hero/featured content
      var hero = document.querySelector('.hero-content, .featured-movie, #hero .movie-card');
      if (hero && isVisible(hero)) {
        setFocus(hero);
      } else {
        setFocus(focusables[0]);
      }
    }
  }

  // Scroll animation support
  var activeScrollAnimation = null;

  function applyScroll(scroller, targetPosition, duration) {
    if (activeScrollAnimation) cancelAnimationFrame(activeScrollAnimation);

    var startPosition = scroller.scrollTop;
    var distance = targetPosition - startPosition;
    var startTime = null;

    function animateFrame(timestamp) {
      if (!startTime) startTime = timestamp;
      var elapsed = timestamp - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var eased = progress * (2 - progress); // easeOutQuad
      scroller.scrollTop = startPosition + distance * eased;

      if (progress < 1) {
        activeScrollAnimation = requestAnimationFrame(animateFrame);
      } else {
        activeScrollAnimation = null;
      }
    }

    activeScrollAnimation = requestAnimationFrame(animateFrame);
  }

  // Handle D-pad and remote keys
  function handleKeydown(e) {
    // Ignore if typing in input
    if (e.target.isContentEditable || e.target.matches('input, textarea, select')) return;

    // Ignore non-trusted and repeat events
    if (!e.isTrusted) return;
    if (e.repeat) return;

    var key = e.key;
    var code = e.code;
    var keyCode = e.keyCode;

    // D-pad / Arrow keys
    if (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      var dirMap = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
      var direction = dirMap[key];
      // Vertical page-scroll fallback at focus boundary
      if (direction === 'up' || direction === 'down') {
        var focusables = getFocusableElements();
        var currentIndex = focusedElement ? focusables.indexOf(focusedElement) : -1;
        var cols = estimateColumns(focusables);
        var atTopEdge = direction === 'up' && currentIndex < cols;
        var atBottomEdge = direction === 'down' && currentIndex >= focusables.length - cols;
        if (atTopEdge || atBottomEdge) {
          scrollTVPage(direction === 'down' ? 1 : -1);
          return;
        }
      }
      moveFocus(direction);
      return;
    }

    // Enter / Select / OK
    if (key === 'Enter' || key === ' ' || keyCode === 13 || keyCode === 32) {
      if (focusedElement) {
        focusedElement.click();
      }
      return;
    }

    // Back button (Android TV, Fire TV, Tizen, webOS)
    if (key === 'Backspace' || key === 'BrowserBack' || keyCode === 8 || keyCode === 4 || keyCode === 10009 || keyCode === 461) {
      e.preventDefault();
      handleBack();
      return;
    }

    // Page Up/Down, Channel Up/Down
    if (key === 'PageDown' || key === 'PageUp' || key === 'ChannelDown' || key === 'ChannelUp' || keyCode === 34 || keyCode === 33 || keyCode === 428 || keyCode === 427) {
      e.preventDefault();
      var direction = (key === 'PageDown' || key === 'ChannelDown' || keyCode === 34 || keyCode === 428) ? 'down' : 'up';
      scrollTVPage(direction);
      return;
    }

    // Escape
    if (key === 'Escape' || keyCode === 27) {
      handleBack();
      return;
    }
  }

  function handleBack() {
    // Priority: Modal > Dropdown > Fullscreen > Search/FullView > Collections > Home
    if (document.querySelector('.modal-overlay.show, #modal-overlay.show, #upcoming-detail-overlay.show')) {
      config.closeModal();
      return;
    }
    if (document.querySelector('.dropdown-menu.show, .search-results.show')) {
      config.closeDropdown();
      return;
    }
    if (config.isFullscreen()) {
      config.exitFullscreen();
      return;
    }
    if (config.isSearchResultsMode()) {
      config.goHome();
      return;
    }
    if (config.isFullViewMovies() || config.isFullViewUpcoming()) {
      config.goHome();
      return;
    }
    if (typeof window.handleCollectionsBack === 'function') {
      window.handleCollectionsBack();
      return;
    }
    config.goHome();
  }

  function scrollTVPage(direction) {
    var scrollContainer = getTVScrollContainer();
    if (!scrollContainer) return;

    var viewportHeight = window.innerHeight;
    var scrollAmount = viewportHeight * 0.85;
    var scrollTop = 0;

    // Handle numeric direction (1 or -1) from D-pad boundary fallback
    var isDown = (direction === 'down' || direction === 1);

    if (scrollContainer === window || scrollContainer === document.documentElement || scrollContainer === document.body) {
      scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      var target = scrollTop + (isDown ? scrollAmount : -scrollAmount);
      window.scrollTo(0, target);
    } else {
      scrollTop = scrollContainer.scrollTop;
      scrollContainer.scrollTop = scrollTop + (isDown ? scrollAmount : -scrollAmount);
    }
  }

  function getTVScrollContainer() {
    // Check for custom scroll containers
    var chScroll = document.getElementById('chScroll');
    if (chScroll && isVisible(chScroll)) return chScroll;

    var modal = document.querySelector('.modal-overlay.show, #modal-overlay.show, #upcoming-detail-overlay.show');
    if (modal) return modal;

    return window;
  }

  function getScrollContainer() {
    return getTVScrollContainer();
  }

  // Keyup handler for activation debounce
  document.addEventListener('keyup', function(e) {
    if (!e.isTrusted || e.repeat) return;
    tvActivationAllowedAt = Date.now() + TV_POST_KEYUP_DEBOUNCE_MS;
  });

  // Sync focus when page changes (e.g., after navigation)
  function syncTVPageReadiness() {
    setTimeout(initializeFocus, 100);
  }

  window.MovieZoneTV.syncTVPageReadiness = syncTVPageReadiness;

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeFocus);
  } else {
    initializeFocus();
  }

  document.addEventListener('keydown', handleKeydown);

  // Re-focus when new content loads (observer)
  var contentObserver = new MutationObserver(function() {
    if (focusedElement && !document.body.contains(focusedElement)) {
      initializeFocus();
    }
  });
  contentObserver.observe(document.body, { childList: true, subtree: true });

  // Expose focus helpers
  window.MovieZoneTV.setFocus = setFocus;
  window.MovieZoneTV.getFocusableElements = getFocusableElements;
  window.MovieZoneTV.focusAndRevealTVTarget = focusAndRevealTVTarget;
  window.MovieZoneTV.tvActivationAllowedAt = tvActivationAllowedAt;
  window.MovieZoneTV.TV_POST_KEYUP_DEBOUNCE_MS = TV_POST_KEYUP_DEBOUNCE_MS;
  window.MovieZoneTV.tvActivationArmed = tvActivationArmed;
  window.MovieZoneTV.tvPageReady = tvPageReady;
  window.MovieZoneTV.applyScroll = applyScroll;
  window.MovieZoneTV.getScrollContainer = getScrollContainer;
  window.MovieZoneTV.getTVScrollContainer = getTVScrollContainer;

})();