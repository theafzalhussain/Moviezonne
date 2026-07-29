﻿﻿﻿// Improved Localhost Detection: Includes local IPs (192.168.x.x) often used in testing
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.');
const isTV = (() => {
  const ua = navigator.userAgent;

  // ANTI-FALSE-POSITIVE: If device is clearly a laptop/desktop/mobile, NEVER return true
  // Windows, Mac, Linux desktops, ChromeOS, standard mobile — these are NEVER TVs
  const isDesktopOS = /Windows NT|Macintosh|Mac OS X|CrOS|Ubuntu|Fedora|Linux x86_64|Linux i686/i.test(ua);
  const isMobileDevice = /Mobi|Android(?!.*TV)|iPhone|iPad|iPod/i.test(ua);
  if (isDesktopOS || isMobileDevice) return false;

  // Signal 1: User-Agent detection ONLY for confirmed TV platforms
  // These strings appear ONLY in actual Smart TV browsers, never in laptops
  const tvUA = /SmartTV|Web0S|WebOS|Tizen|VIDAA|Roku|RokuOS|AppleTV|Apple TV|Android TV|AndroidTV|BRAVIA|AFTT|AFTS|AFTM|AFTB|AFTKMST|Fire TV|FireTV|CrKey|Chromecast|GoogleTV|Google TV|PlayStation|PS[45]|Xbox One|XBOX|SmartCast|PHILIPSTV|HbbTV|Opera TV|NETTV|Panasonic.*Viera|Vestel|DuneHD|Eltex|NetCast|MITV|MiTV/i.test(ua);
  if (tvUA) return true;

  // Signal 2: navigator.userAgentData platform hints (Chromium-based TV browsers)
  if (navigator.userAgentData) {
    const platform = (navigator.userAgentData.platform || '').toLowerCase();
    if (/smarttv|tizen|webos|android tv|googletv|chromecast|firetv/.test(platform)) return true;
    const brands = navigator.userAgentData.brands || [];
    const brandStr = brands.map(b => b.brand).join(' ').toLowerCase();
    if (/tizen|webos|smarttv|googletv|firetv/.test(brandStr)) return true;
  }

  // NO screen heuristic fallback — too risky for false positives
  // Only UA-based detection ensures laptop/desktop is NEVER wrongly identified as TV

  return false;
})();

// Balanced Performance: Mobil/Tablet ko low-end manein, par Desktops/Laptops (bhale hi touch ho) ko full features dein
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
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
// Automatically serves High-Quality images on fast networks, and Normal/Low on slow networks (3G/2G)
function getResponsiveBackdrop(path) {
  if (!path) return '';
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const isSlow = conn && (conn.saveData || /^[23]g/.test(conn.effectiveType));
  
  if (isSlow) return `https://image.tmdb.org/t/p/w500${path}`; // Prevents lag on slow networks
  if (isTV || isMobile) return `https://image.tmdb.org/t/p/w780${path}`; // Balanced for mobile/TV
  if (!isLowEnd) return `https://image.tmdb.org/t/p/original${path}`; // Ultra HD for powerful desktops
  return `https://image.tmdb.org/t/p/w1280${path}`; // Normal HD fallback
}

// -- TV MODE (Performance) --
// Smart TV browsers have weak CPUs/GPUs: heavy blur/animation cause visible lag.
// Tag <html> early so CSS can strip expensive effects (backdrop-filter, film grain, Ken Burns, etc.)
// Apply to ALL mobiles and TVs - even mid-range phones lag with these effects
if (isTV) document.documentElement.classList.add('tv-mode');

// Allow manual TV mode via URL parameter (?tv=1) for Cast/HDMI scenarios
if (new URLSearchParams(window.location.search).get('tv') === '1') {
  document.documentElement.classList.add('tv-mode');
  console.log('[MovieZone] TV mode forced via URL parameter');
}

console.log('[MovieZone] TV Detection:', isTV, '| UA:', navigator.userAgent.substring(0, 80));
if (isMobile) document.documentElement.classList.add('low-end-mode');

// -- TV SCREEN PERFORMANCE: Large screen optimizations (even without TV UA detection) --
// When screen is 1920px+ and NOT a desktop OS with mouse pointer, likely a TV via Cast/HDMI
(function tvScreenPerf() {
  if (isTV) return; // Already handled above
  const isLargeScreen = window.innerWidth >= 1920;
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  const noFinePointer = !window.matchMedia('(pointer: fine)').matches;
  
  // If large screen + touch-only (no mouse) = likely TV via Cast
  if (isLargeScreen && isTouch && noFinePointer) {
    document.documentElement.classList.add('tv-mode');
    console.log('[MovieZone] TV mode activated via screen heuristic (large + touch-only)');
  }
  
  // Xiaomi/Android TV fallback: Large screen + Android UA (not phone) + high resolution
  if (isLargeScreen && /Android/i.test(navigator.userAgent) && window.screen.height >= 900) {
    const isPhone = /Mobile|Phone/i.test(navigator.userAgent);
    if (!isPhone) {
      document.documentElement.classList.add('tv-mode');
      console.log('[MovieZone] TV mode activated via Android large-screen heuristic');
    }
  }
  
  // For all large screens (1920px+): reduce GPU-heavy effects for smoother rendering
  if (isLargeScreen) {
    document.documentElement.classList.add('large-screen-mode');
  }
})();
 
// -- PERFORMANCE BOOST STYLES --
const perfStyle = document.createElement('style');
perfStyle.textContent = `
  /* === UNIVERSAL DEVICE PERFORMANCE === */
  
  /* GPU-accelerated cards for all devices */
  .movie-card, .upcoming-card { content-visibility: auto; contain-intrinsic-size: 180px 320px; contain: layout style paint; }
  .carousel-slide { will-change: transform, opacity; }
  img { content-visibility: auto; }
  #movies-section, #upcoming { content-visibility: auto; contain-intrinsic-size: 1000px; }
  
  /* === MOBILE / SMALL SCREEN OPTIMIZATION (< 768px) === */
  @media (max-width: 768px) {
    /* Kill ALL animations on mobile — biggest performance gain */
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.2s !important;
    }
    /* Exceptions: only allow essential transitions */
    #mzMobilePanel, .mobile-nav-overlay, .hamburger-btn span {
      transition-duration: 0.3s !important;
    }
    #mzMobilePanel .mz-mp-link {
      transition-duration: 0.25s !important;
    }
    
    /* Remove ALL hover effects on mobile */
    .movie-card:hover, .upcoming-card:hover { transform: none !important; box-shadow: none !important; }
    
    /* Kill GPU-heavy effects entirely */
    .ambient-particles { display: none !important; }
    #hero::before, #hero::after { display: none !important; }
    .click-spark { display: none !important; }
    
    /* Remove ALL backdrop-filters on mobile (main lag cause) */
    * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
    /* Only re-enable on mobile panel */
    #mzMobilePanel { backdrop-filter: blur(20px) !important; -webkit-backdrop-filter: blur(20px) !important; }
    
    /* Simplify box-shadows (major GPU cost) */
    .movie-card, .upcoming-card, .player-chip, .player-chip--source, .cat-tab { 
      box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
    }
    #navbar {
      box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      background: rgba(5,5,12,0.95) !important;
    }
    
    /* Disable 3D tilt on touch */
    .movie-card { perspective: none !important; transform-style: flat !important; }
    
    /* Reduce grid reflow */
    .movie-grid { gap: 10px !important; }
    
    /* Remove pseudo-element decorations */
    .movie-card::before, .movie-card::after, .upcoming-card::before, .upcoming-card::after,
    .nav-search::before, #navbar::before { display: none !important; }
    
    /* Reduce paint complexity */
    .slide-gradient { background: linear-gradient(to top, rgba(3,3,10,0.95) 0%, transparent 60%) !important; }
  }
  
  /* === TABLET (768px - 1024px) === */
  @media (min-width: 769px) and (max-width: 1024px) {
    .movie-card:hover { transform: translateY(-4px) !important; }
    .ambient-particles .particle:nth-child(n+12) { display: none !important; }
    .movie-card::before, .upcoming-card::before { display: none !important; }
    #navbar { backdrop-filter: blur(20px) !important; -webkit-backdrop-filter: blur(20px) !important; }
  }
  
  /* === TV / LARGE SCREEN OPTIMIZATION === */
  @media (min-width: 1920px), (hover: none) and (min-width: 960px) {
    .movie-grid { contain: layout style paint; }
    .ambient-particles .particle:nth-child(n+15) { display: none !important; }
    .movie-card, .upcoming-card, .cat-tab, button { min-height: 48px; }
    /* Reduce repaints on large screens */
    .movie-card, .upcoming-card { will-change: auto; transform: translateZ(0); }
    .carousel-slide { will-change: transform; }
    /* Smoother scrolling */
    html { scroll-behavior: smooth; }
    * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  }
  
  /* === TV MODE: Strip heavy effects but KEEP smooth focus transitions === */
  .tv-mode *, .tv-mode *::before, .tv-mode *::after {
    box-shadow: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    text-shadow: none !important;
    filter: none !important;
    animation: none !important;
    transition: transform 0.15s ease, outline 0.1s ease, outline-offset 0.1s ease, opacity 0.15s ease !important;
  }
  .tv-mode .movie-card:focus, .tv-mode .upcoming-card:focus,
  .tv-mode .cat-tab:focus, .tv-mode .btn-play:focus,
  .tv-mode .btn-info:focus, .tv-mode .player-chip:focus,
  .tv-mode .nav-links a:focus {
    outline: 3px solid gold !important;
    outline-offset: 3px !important;
    transform: scale(1.05) !important;
    will-change: transform !important;
    z-index: 50 !important;
  }
  .tv-mode .movie-card, .tv-mode .upcoming-card, .tv-mode .cat-tab,
  .tv-mode .btn-play, .tv-mode .btn-info, .tv-mode .player-chip,
  .tv-mode .nav-links a {
    cursor: pointer;
    min-height: 48px;
  }
  /* === LOW-END / MOBILE MODE: Strip effects but KEEP short transitions for smooth UI === */
  .low-end-mode *, .low-end-mode *::before, .low-end-mode *::after {
    box-shadow: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    text-shadow: none !important;
    filter: none !important;
    animation: none !important;
    transition-duration: 0.2s !important;
    transition-timing-function: ease !important;
  }
  /* Allow mobile panel to animate smoothly */
  .low-end-mode #mzMobilePanel,
  .low-end-mode .mobile-nav-overlay,
  .low-end-mode .hamburger-btn span,
  .low-end-mode #mzMobilePanel .mz-mp-link {
    transition-duration: 0.3s !important;
  }
  .tv-mode .ambient-particles, .low-end-mode .ambient-particles { display: none !important; }
  .tv-mode #hero::before, .tv-mode #hero::after,
  .low-end-mode #hero::before, .low-end-mode #hero::after { display: none !important; }
  .tv-mode .click-spark, .low-end-mode .click-spark { display: none !important; }
  .tv-mode .movie-card::before, .tv-mode .movie-card::after,
  .low-end-mode .movie-card::before, .low-end-mode .movie-card::after { display: none !important; }
  .tv-mode #navbar, .low-end-mode #navbar { 
    background: rgba(5,5,12,0.97) !important; 
    border: 1px solid rgba(255,255,255,0.05) !important;
  }
  .tv-mode .slide-gradient, .low-end-mode .slide-gradient { 
    background: linear-gradient(to top, rgba(3,3,10,0.98) 0%, transparent 50%) !important; 
  }
  
  /* === REDUCED MOTION (accessibility + performance) === */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition-duration: 0.01ms !important;
    }
    .ambient-particles { display: none !important; }
  }
`;
document.head.appendChild(perfStyle);

// Weak device detect karke class lagana
// -- PREMIUM CURSOR GLOW & CLICK SPARKS --
// Disable on TV, Touch, and Mobile to save CPU/battery and ensure smooth performance
if (!isTV && !isTouchOnly && !isMobile) {
  const cursorGlow = document.getElementById('cursor-glow');
  const cursorRing = document.getElementById('cursor-ring');
  const cursorDot = document.getElementById('cursor-dot');
  
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let ringX = mouseX;
  let ringY = mouseY;
  
  let cursorIdleTimer;
  let isCursorMoving = true;

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    isCursorMoving = true;
    clearTimeout(cursorIdleTimer);
    cursorIdleTimer = setTimeout(() => isCursorMoving = false, 150);
    
    if (cursorGlow) {
      cursorGlow.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0) translate(-50%, -50%)`;
    }
    if (cursorDot) {
      cursorDot.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0) translate(-50%, -50%)`;
    }
  });

  // Smooth 3D Trailing Animation for the Ring
  function animateCursorRing() {
    if (isCursorMoving || Math.abs(mouseX - ringX) > 0.1 || Math.abs(mouseY - ringY) > 0.1) {
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
    requestAnimationFrame(animateCursorRing);
  }
  animateCursorRing();

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

// -- SERVER PRECONNECT (FAST STREAMING) --
// Background me sabhi servers se pehle se secure connection bana ke rakho jisse fetching instant ho
(function preconnectServers() {
  const servers = ['https://www.viduki.net', 'https://cinextream.net', 'https://www.2embed.stream', 'https://vidnest.fun', 'https://vidsrc.sbs', 'https://vidcore.org', 'https://multiembed.mov', 'https://autoembed.co'];
  servers.forEach(url => {
    const dns = document.createElement('link');
    dns.rel = 'dns-prefetch';
    dns.href = url;
    document.head.appendChild(dns);

    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = url;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  });
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
let currentModalMovie = null;
let watchlist = JSON.parse(localStorage.getItem('mz_watchlist') || '[]');
let isFullViewMovies = false;
let isFullViewUpcoming = false;
let currentMoviePage = 1;
let currentUpcomingPage = 1;
let activeTrailerStopper = null; // Function to stop the currently playing trailer
let allUpcoming = [];
let lastFocusedElement = null; // TV remote focus memory
 
// -- FETCH helper -- Optimized with aggressive parallel execution
const tmdbCache = new Map();
const inFlightRequests = new Map(); 
let abortControllers = new Map(); // Track controllers to cancel stale requests

async function tmdb(endpoint, params) {
  params = params || {};
 
  let qs = '';
  if (Object.keys(params).length) {
    qs = '?' + Object.entries(params).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  }
  const urlStr = BASE + endpoint + qs;

  
  if (tmdbCache.has(urlStr)) return tmdbCache.get(urlStr); // Memory cache (instant)
  
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
        return cachedData; // Immediate return if cache is fresh
      }
    } catch(e) {}
  }
 
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
      const r = await fetch(urlStr, { signal: controller.signal }); 
      if (!r.ok) return cachedData || {};
      const data = await r.json();
      tmdbCache.set(urlStr, data);
      
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
      } catch (err) {}
      
      return data;
    } catch (e) { 
      if (e.name === 'AbortError') return cachedData || { results: [] }; // Return safe fallback on cancellation
      console.error('Network/Fetch Error:', e);
      return cachedData || { results: [] }; // Fallback to stale cache or empty array
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
  // Inject Multi-Language UI styles
  if (!document.getElementById('mz-multilang-css')) {
    const _s = document.createElement('style');
    _s.id = 'mz-multilang-css';
    _s.textContent = `.mz-lang-btn{display:inline-flex!important;align-items:center;gap:5px;background:rgba(255,255,255,0.05)!important;border:1px solid rgba(255,255,255,0.1)!important;color:rgba(255,255,255,0.65)!important;font-size:0.78rem!important;font-weight:600!important;padding:7px 13px!important;border-radius:999px!important;cursor:pointer!important;transition:all .2s ease!important;letter-spacing:.2px!important;position:relative!important}.mz-lang-btn:hover{background:rgba(245,197,24,.12)!important;border-color:rgba(245,197,24,.35)!important;color:#fff!important;transform:translateY(-1px)!important}.mz-lang-btn.active{background:linear-gradient(135deg,#f5c518,#e6a817)!important;border-color:#f5c518!important;color:#000!important;font-weight:800!important;box-shadow:0 4px 18px rgba(245,197,24,.35)!important;transform:translateY(-1px)!important}.mz-lang-btn.mz-lang-avail{border-color:rgba(16,185,129,.3)!important}.mz-lang-btn.mz-lang-avail.active{border-color:#f5c518!important}.mz-avail-dot{display:inline-block;width:6px;height:6px;background:#10b981;border-radius:50%;margin-left:3px;flex-shrink:0;box-shadow:0 0 5px rgba(16,185,129,.5)}.mz-lang-btn.active .mz-avail-dot{background:rgba(0,0,0,.4);box-shadow:none}`;
    document.head.appendChild(_s);
  }
  try {
    // Load carousel and movies in parallel (Promise.allSettled ensures one failure doesn't block other)
    await Promise.allSettled([
      loadCarousel(),
      loadMovies('all')
    ]);

    // 3. Delay upcoming fetching until browser is idle
    setTimeout(() => {
      if ('requestIdleCallback' in window) requestIdleCallback(() => loadUpcoming());
      else loadUpcoming();
    }, 800);

    // 4. Hide Cinematic Loader as soon as the basic structure is ready
    setTimeout(() => {
      const loader = document.getElementById('mz-loader');
      if (loader) loader.classList.add('loader-hidden');
    }, 400);

  } catch (err) {
    console.error("Init Error:", err);
    const loader = document.getElementById('mz-loader');
    if (loader) loader.classList.add('loader-hidden');
  }

  // Luxury Ambient Particles (Jugnu)
  // Only create on desktop - mobile/TV gets zero particles for performance
  if (!isTV && !isMobile && !document.querySelector('.ambient-particles')) {
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
            const activeTab = document.querySelector('.cat-tab.active');
            if (activeTab) {
                const onclickAttr = activeTab.getAttribute('onclick') || '';
                if (onclickAttr.includes("showWatchlist")) {
                    return; // Don't infinite scroll on watchlist
                }
            }
            
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
 
// -- CAROUSEL (PROFESSIONAL DISCOVERY ALGORITHM)
// Netflix/Hotstar-grade weighted scoring: fetches from ALL categories and ranks by composite score
// Score = (rating_weight) + (popularity_weight) + (recency_boost) + (trending_velocity) + (vote_confidence) + (quality_upgrade_boost)

function calculateMovieScore(movie) {
  const now = Date.now();
  const releaseDate = new Date(movie.release_date || movie.first_air_date || '2020-01-01');
  const daysSinceRelease = Math.max(0, (now - releaseDate) / (1000 * 60 * 60 * 24));
  
  // 1. Rating Weight (0-10 scale, boosted): High-quality movies get exponential boost
  const rating = movie.vote_average || 0;
  const ratingScore = Math.pow(rating, 1.8) * 2; // Exponential: 8.0 → 98, 7.0 → 76, 6.0 → 56
  
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
  
  // 4. Trending Velocity: If popularity is high relative to vote count, it's trending fast
  const voteCount = movie.vote_count || 1;
  const trendingVelocity = Math.min((popularity / Math.max(voteCount, 1)) * 5, 40);
  
  // 5. Vote Confidence: More votes = more reliable score (logarithmic scale)
  const voteConfidence = Math.min(Math.log10(voteCount + 1) * 8, 30);
  
  // 6. Now Playing / In Theaters bonus
  const nowPlayingBonus = (daysSinceRelease <= 45 && daysSinceRelease >= 0) ? 25 : 0;
  
  // 7. QUALITY UPGRADE BOOST (Netflix-style "Newly Available in HD/4K")
  // Jab movie theater se OTT/digital par aati hai (75-130 days), usko massive re-boost milta hai
  // Isse purani movies wapas top par aa jaati hain jab unki HD/FHD/4K quality available hoti hai
  let qualityUpgradeBoost = 0;
  const mediaType = movie.media_type || (movie.name && !movie.title ? 'tv' : 'movie');
  if (mediaType === 'movie') {
    if (daysSinceRelease > 75 && daysSinceRelease <= 100) {
      // JUST hit digital/OTT release (HD available) — treat as "newly available"
      qualityUpgradeBoost = 70; // Almost as strong as a new release!
    } else if (daysSinceRelease > 100 && daysSinceRelease <= 130) {
      // FHD window — still fresh on digital platforms
      qualityUpgradeBoost = 55;
    } else if (daysSinceRelease > 130 && daysSinceRelease <= 160) {
      // Late FHD / early 4K window — fading but still relevant
      qualityUpgradeBoost = 35;
    } else if (daysSinceRelease > 200 && daysSinceRelease <= 230) {
      // 4K/Blu-ray just dropped — another small re-boost
      qualityUpgradeBoost = 25;
    }
    // Extra boost for high-rated movies in quality upgrade window (blockbusters get more visibility)
    if (qualityUpgradeBoost > 0 && rating >= 7.0) {
      qualityUpgradeBoost += 15;
    }
    if (qualityUpgradeBoost > 0 && popularity >= 100) {
      qualityUpgradeBoost += 10;
    }
  }
  
  return ratingScore + popularityScore + recencyBoost + trendingVelocity + voteConfidence + nowPlayingBonus + qualityUpgradeBoost;
}

async function loadCarousel() {
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

  // If no data came at all, fallback silently
  if (masterPool.length === 0) { buildCarousel(); return; }

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
    
    // Preload the very first Large Image for blazing fast Initial Render (LCP Optimization)
    if (i === 0) {
      const preload = document.createElement('link');
      preload.rel = 'preload';
      preload.as = 'image';
      preload.href = bgUrl;
      document.head.appendChild(preload);
    }

    // Performance: only load the FIRST slide's background eagerly.
    // Remaining slides are lazy-loaded just-in-time (current + next) via ensureSlideBg()
    // so the page doesn't have to download 6 large images on first paint.
    slide.innerHTML =
      '<div class="slide-bg" data-bg="'+bgUrl+'"'+(i === 0 ? ' style="background-image:url(\''+bgUrl+'\')"' : '')+'></div>' +
      '<div class="slide-gradient"></div>' +
      '<div class="slide-content">' +
        '<div class="slide-badge">'+(m._badge || '🔥 TRENDING NOW')+'</div>' +
        '<h1 class="slide-title">'+escapeHTML(m.title||m.name||'')+'</h1>' +
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
        btn.addEventListener('click', () => { openUpcomingDetail(parseInt(btn.dataset.id), btn.dataset.type); });
      } else {
        btn.addEventListener('click', () => { openModal(parseInt(btn.dataset.id), btn.dataset.type); });
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
    thumb.innerHTML = '<img src="'+IMG+m.poster_path+'" alt="" width="60" height="84" loading="lazy" decoding="async">';
    thumb.addEventListener('click', () => { goToSlide(i); resetAutoSlide(); });
    thumbsFrag.appendChild(thumb);
  });
 
  track.appendChild(trackFrag);
  dots.appendChild(dotsFrag);
  thumbs.appendChild(thumbsFrag);
 
  // Preload the next slide's background while the user is still looking at slide 0
  if (carouselMovies.length > 1) ensureSlideBg(1 % carouselMovies.length);
 
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
 
function startAutoSlide() {
  if (autoSlideTimer) clearInterval(autoSlideTimer);
  restartProgressBar();
  autoSlideTimer = setInterval(() => { goToSlide(currentSlide + 1); }, 5500);
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
  bar.style.animation = 'carouselProgressFill 5.5s linear forwards';
}
function pauseAutoSlide() {
  if (autoSlideTimer) { clearInterval(autoSlideTimer); autoSlideTimer = null; }
  const bar = document.getElementById('carouselProgress');
  if (bar) bar.style.animationPlayState = 'paused';
}
function resumeAutoSlide() {
  if (autoSlideTimer) return;
  const bar = document.getElementById('carouselProgress');
  if (bar) bar.style.animationPlayState = 'running';
  autoSlideTimer = setInterval(() => { goToSlide(currentSlide + 1); }, 5500);
}
 
// -- HERO INTERACTIONS — pause-on-hover, swipe, arrow nav (premium UX) --
(function initHeroInteractions() {
  const hero = document.getElementById('hero');
  if (!hero) return;
 
  // Pause autoplay while the user is looking closely (desktop hover)
  if (!isTV) {
    hero.addEventListener('mouseenter', pauseAutoSlide);
    hero.addEventListener('mouseleave', resumeAutoSlide);
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
  } else if (cat === 'hollywood') {
    tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p1 });
    tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p2 });
  } else if (cat === 'tv') {
    const STREAMING_NETWORKS = '213|1024|122|3295|3009|193|2583|2600|2212|2552|453|49|3353|4330|2694|3321|3328'; // Netflix, Prime, Hotstar, Jio, MX, SonyLIV, ZEE5, AppleTV+, Hulu, HBO, aha, Hoichoi etc.
    const TV_CHANNELS_TO_EXCLUDE = '71|105|70|118|194|2584|3294'; // Star Plus, Colors, Zee TV, Sony TV, SAB, &TV, Star Bharat
    tmdb('/discover/tv', { with_networks: STREAMING_NETWORKS, without_networks: TV_CHANNELS_TO_EXCLUDE, with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/tv', { with_networks: STREAMING_NETWORKS, without_networks: TV_CHANNELS_TO_EXCLUDE, with_original_language: 'en', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/tv', { with_networks: STREAMING_NETWORKS, without_networks: TV_CHANNELS_TO_EXCLUDE, with_original_language: 'ko', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/tv', { with_networks: STREAMING_NETWORKS, without_networks: TV_CHANNELS_TO_EXCLUDE, sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
  } else if (cat === 'kids') {
    tmdb('/discover/tv', { with_genres: '10762', with_original_language: 'hi', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/tv', { with_genres: '10762', with_original_language: 'ja', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/tv', { with_genres: '10762', with_original_language: 'en', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { with_genres: '16,10751', without_genres: '27,53,18', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
  } else if (cat === 'anime') {
    tmdb('/discover/tv', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
    tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: p1, language: 'en-US' });
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
  animation: { with_genres: '16',  sort_by: 'popularity.desc', page: '1' },
  kids:      { with_genres: '16,10751', without_genres: '27,53,18', sort_by: 'popularity.desc', page: '1' }
};
 
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
  
  try {
    if (cat === 'all') {
      // NETFLIX-STYLE DISCOVERY: Fetch diverse sources for maximum content freshness
      const res = await Promise.allSettled([
        tmdb('/movie/now_playing', { language: 'en-US', page: pageStr }),
        tmdb('/trending/movie/week', { language: 'en-US', page: pageStr }),
        tmdb('/trending/movie/day', { language: 'en-US', page: pageStr }),
        tmdb('/movie/popular', { language: 'en-US', page: pageStr }),
        tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' }),
        tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' })
      ]);
      
      const combinedMovies = [];
      res.forEach(r => {
        if (r.status === 'fulfilled' && r.value && r.value.results) {
          combinedMovies.push(...r.value.results);
        }
      });
      
      // INTELLIGENT DEDUPLICATION: Keep the highest-popularity version
      const movieMap = new Map();
      for (const movie of combinedMovies) {
        if (!movie || !movie.id) continue;
        const existing = movieMap.get(movie.id);
        if (!existing || (movie.popularity || 0) > (existing.popularity || 0)) {
          movieMap.set(movie.id, movie);
        }
      }
      const uniqueMovies = Array.from(movieMap.values());
      
      // NETFLIX-STYLE COMPOSITE RANKING: Score each movie
      uniqueMovies.forEach(m => { m._rankScore = calculateMovieScore(m); });
      
      // Sort by composite score (highest first)
      uniqueMovies.sort((a, b) => b._rankScore - a._rankScore);
      
      // SIMPLE DIVERSITY: Just ensure not too many same-language in a row
      const diverseGrid = [];
      const skipped = [];
      
      for (const m of uniqueMovies) {
        const lang = m.original_language || 'en';
        const lastThree = diverseGrid.slice(-3);
        
        // If last 3 are all same language, skip this one for now
        if (lastThree.length >= 3 && lastThree.every(x => (x.original_language || 'en') === lang)) {
          skipped.push(m);
        } else {
          diverseGrid.push(m);
        }
      }
      
      // Add back any skipped movies at the end
      diverseGrid.push(...skipped);

      movies.push(...diverseGrid);
    } else if (cat === 'tv') {
      // EXPANDED OTT LIST: Now includes JioCinema, MX Player, HBO, aha, Hoichoi and more major platforms.
      const STREAMING_NETWORKS = '213|1024|122|3295|3009|193|2583|2600|2212|2552|453|49|3353|4330|2694|3321|3328'; // Netflix, Prime, Hotstar, Jio, MX, SonyLIV, ZEE5, AppleTV+, Hulu, HBO, aha, Hoichoi etc.
      // EXCLUSION LIST: Traditional Indian TV channels to strictly remove from Web Series section
      const TV_CHANNELS_TO_EXCLUDE = '71|105|70|118|194|2584|3294'; // Star Plus, Colors, Zee TV, Sony TV, SAB, &TV, Star Bharat

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
      const res = await Promise.all([
        tmdb('/discover/tv', { with_genres: '10762', with_original_language: 'hi', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Indian (Motu Patlu, Chhota Bheem)
        tmdb('/discover/tv', { with_genres: '10762', with_original_language: 'ja', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Japanese (Doraemon, Shinchan, Pokemon)
        tmdb('/discover/tv', { with_genres: '10762', with_original_language: 'en', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // English (Ben 10, Tom & Jerry)
        tmdb('/discover/movie', { with_genres: '16,10751', without_genres: '27,53,18', sort_by: 'popularity.desc', page: p1, language: 'en-US' }) // Animation Movies
      ]);
      let maxLength = 0;
      res.forEach(r => { if (r.results && r.results.length > maxLength) maxLength = r.results.length; });
      for (let i = 0; i < maxLength; i++) {
        res.forEach((r, idx) => {
          if (r.results && i < r.results.length) {
            const item = r.results[i];
            item.media_type = idx === 3 ? 'movie' : 'tv'; // Fix: Cartoon series ab 'tv' show hongi
            movies.push(item);
          }
        });
      }
    } else if (cat === 'anime') {
      const res = await Promise.all([
        tmdb('/discover/tv', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Anime Series (Naruto, DBZ, etc.)
        tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: p1, language: 'en-US' }), // Anime Movies (Your Name, Demon Slayer Movie)
        tmdb('/discover/tv', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: p2, language: 'en-US' }), // Series Page 2
        tmdb('/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', page: p2, language: 'en-US' }) // Movies Page 2
      ]);
      let maxLength = 0;
      res.forEach(r => { if (r.results && r.results.length > maxLength) maxLength = r.results.length; });
      for (let i = 0; i < maxLength; i++) {
        res.forEach((r, idx) => {
          if (r.results && i < r.results.length) {
            const item = r.results[i];
            item.media_type = (idx === 0 || idx === 2) ? 'tv' : 'movie'; // Anime series ke liye seasons support activate hoga
            movies.push(item);
          }
        });
      }
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
    if (!rDate) return (m.vote_count > 50);
    // Agar date future ki hai, toh isko normal list se strict block kar do
    if (rDate > realToday) return false;
    return true;
  });

  if (!movies.length && !isLoadMore) {
    const grid = document.getElementById('movieGrid');
    if (grid) grid.innerHTML = '<div class="no-results"><h3>Loading movies...</h3><p>Retrying in a moment...</p></div>';
    // Auto-retry after 3 seconds
    setTimeout(() => loadMovies(cat), 3000);
    return;
  }
  
  const existingIds = new Set(allMovies.map(m => m.id));
  const newMovies = movies.filter(m => { if(existingIds.has(m.id)) return false; existingIds.add(m.id); return true; });
  allMovies = allMovies.concat(newMovies);
 
  renderMovies(isLoadMore ? newMovies : (isFullViewMovies ? allMovies : allMovies.slice(0, 24)), isLoadMore);
  
  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = 'none'; // Always hide button for infinite scroll
 
  // Har load ke baad agle page ko chupke se fetch karke ready rakho
  if (!isTV) {
    setTimeout(() => prefetchMoviesPage(cat, currentMoviePage + 1), 800);
  }

  if (isLoadMore) {
    isLoadingMore = false;
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) indicator.style.display = 'none';
  }
}
 
function renderMovies(movies, append = false) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;
  if (!append) {
    if (!movies.length) {
      grid.innerHTML = '<div class="no-results"><h3>No movies found</h3><p>Try a different search or category.</p></div>';
      return;
    }
    grid.innerHTML = '';
  }
  
  const fragment = document.createDocumentFragment();
  const startIndex = append ? (allMovies.length - movies.length) : 0;
  
  movies.forEach((m, i) => {
    const type   = m.media_type || (m.name && !m.title ? 'tv' : 'movie');
    const rating = m.vote_average ? m.vote_average.toFixed(1) : 'N/A';
    const year   = (m.release_date || m.first_air_date || '').slice(0, 4);
    const votes  = m.vote_count > 999 ? (m.vote_count/1000).toFixed(1)+'K' : (m.vote_count||0);
    const genres = (m.genre_ids||[]).slice(0,2).map(id => GENRE_MAP[id]).filter(Boolean);
    const rDateStr = m.release_date || m.first_air_date;
    const isHot  = m.popularity > 100 && ((m.vote_count || 0) > 50 || (new Date() - new Date(rDateStr || '2000-01-01')) / (1000*60*60*24) < 60);
    
    // -- PROFESSIONAL QUALITY BADGE DETECTION ALGORITHM --
    // Mimics how real platforms detect quality: Release window + vote patterns + popularity signals
    let qual = 'HD';
    let qualClass = '';
    if (rDateStr) {
      const rDate = new Date(rDateStr);
      const daysOld = (new Date() - rDate) / (1000 * 60 * 60 * 24);
      
      if (type === 'movie') {
        if (daysOld >= 0 && daysOld <= 21) {
          // 0-21 days: Movie just hit theaters, only CAM available
          qual = 'CAM';
          qualClass = 'qual-cam';
        } else if (daysOld > 21 && daysOld <= 45) {
          // 21-45 days: Better quality CAM/TS available (TeleSync)
          qual = 'TS';
          qualClass = 'qual-ts';
        } else if (daysOld > 45 && daysOld <= 75) {
          // 45-75 days: Pre-release HDTS/HDCAM or early digital leaks
          qual = 'HDTS';
          qualClass = 'qual-hdts';
        } else if (daysOld > 75 && daysOld <= 120) {
          // 75-120 days: Digital release window (OTT release likely)
          qual = 'HD';
          qualClass = 'qual-hd';
        } else if (daysOld > 120 && daysOld <= 200) {
          // 120-200 days: Full HD available on streaming platforms
          qual = 'FHD';
          qualClass = 'qual-fhd';
        } else if (daysOld > 200) {
          // 200+ days: 4K/Blu-ray release window
          if (m.vote_average >= 7.0 && m.popularity >= 50) {
            qual = '4K';
            qualClass = 'qual-4k';
          } else {
            qual = 'FHD';
            qualClass = 'qual-fhd';
          }
        }
      } else {
        // TV Shows / Web Series: Usually direct-to-digital (HD from day 1)
        if (daysOld <= 7) {
          qual = 'NEW';
          qualClass = 'qual-new';
        } else if (m.vote_average >= 8.0 && m.popularity >= 100) {
          qual = '4K';
          qualClass = 'qual-4k';
        } else if (m.vote_average >= 6.5) {
          qual = 'FHD';
          qualClass = 'qual-fhd';
        } else {
          qual = 'HD';
          qualClass = 'qual-hd';
        }
      }
    }
    
    // -- SMART RELEASE FRESHNESS BADGE --
    let freshBadge = '';
    if (rDateStr) {
      const daysOld = (new Date() - new Date(rDateStr)) / (1000 * 60 * 60 * 24);
      if (daysOld >= 0 && daysOld <= 3) freshBadge = '<div class="card-fresh card-fresh-today">TODAY</div>';
      else if (daysOld <= 7) freshBadge = '<div class="card-fresh card-fresh-new">NEW</div>';
      else if (daysOld <= 14) freshBadge = '<div class="card-fresh card-fresh-recent">THIS WEEK</div>';
      // Quality Upgrade: Movie just hit digital/OTT — show as "NEW" again (Netflix-style)
      else if (type === 'movie' && daysOld > 75 && daysOld <= 100) freshBadge = '<div class="card-fresh card-fresh-new">NEW</div>';
    }
    // -- HINDI DUBBED BADGE: Show on Hollywood/Japanese/Korean movies (likely dubbed)
    const dubbedLangs = ['en', 'ja', 'ko', 'fr', 'es', 'de']; // Languages that are commonly dubbed to Hindi
    const isDubbedLikely = dubbedLangs.includes(m.original_language) && m.popularity > 50;
    
    const card   = document.createElement('div');
    card.className = 'movie-card';
    card.tabIndex = 0;
    // Optimized will-change usage
    card.style.willChange = 'auto'; 
    card.style.animationDelay = ((i % 24) * 0.04) + 's';
    card.innerHTML =
      '<div class="card-poster">' +
        `<img src="${IMG}${m.poster_path}" alt="${escapeHTML(m.title||'')}" width="171" height="256" loading="lazy" decoding="async">` +
        '<div class="card-quality '+(qualClass||'')+'">'+qual+'</div>' +
        (isHot ? '<div class="card-hot">HOT</div>' : '') +
        freshBadge +
        (isDubbedLikely ? '<div class="card-dubbed"> HINDI</div>' : '') +
        '<div class="card-overlay"><button class="card-play-btn">&#9654;</button></div>' +
      '</div>' +
      '<div class="card-info">' +
        '<div class="card-title">'+escapeHTML(m.title||m.name||'')+'</div>' +
        '<div class="card-meta">' +
          '<div class="card-rating">RATING '+rating+'</div>' +
          '<div class="card-year">YEAR '+year+'</div>' +
        '</div>' +
        '<div class="card-meta"><div class="card-runtime">LANG '+(m.original_language||'EN').toUpperCase()+'</div></div>' +
        '<div class="card-genres">'+genres.map(g => '<span class="card-genre">'+escapeHTML(g)+'</span>').join('')+'</div>' +
      '</div>';
    card.addEventListener('click', () => { openModal(m.id, type); });
    fragment.appendChild(card);
  scrollObserver.observe(card);

    // Premium 3D Tilt Effect on Hover (Desktop only - causes lag on mobile/TV)
    if (!isTV && !isMobile) {
      let tiltRAF;
      let cachedRect = null; // Cache to stop Layout Thrashing
      card.addEventListener('mouseenter', () => { 
        card.style.transition = 'transform 0.1s ease-out'; 
        card.style.willChange = 'transform'; 
        cachedRect = card.getBoundingClientRect();
      });
      card.addEventListener('mousemove', (e) => {
        if (tiltRAF) cancelAnimationFrame(tiltRAF);
        tiltRAF = requestAnimationFrame(() => {
          if (!cachedRect) cachedRect = card.getBoundingClientRect();
          const rect = cachedRect;
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const centerX = rect.width / 2;
          const centerY = rect.height / 2;
          // ENHANCED 3D TILT: More responsive and attractive values
          const rotateX = ((y - centerY) / centerY) * -12; 
          const rotateY = ((x - centerX) / centerX) * 12;
          const shadowX = (x - centerX) * -0.2;
          const shadowY = (y - centerY) * -0.2;
          
          card.style.transform = `perspective(1000px) translateY(-15px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.05, 1.05, 1.05)`;
          card.style.boxShadow = `${shadowX}px ${shadowY + 40}px 80px rgba(0,0,0,0.7), 0 0 20px rgba(245,197,24,0.1)`;
        });
      });
      card.addEventListener('mouseleave', () => {
        if (tiltRAF) cancelAnimationFrame(tiltRAF);
        card.style.transition = 'transform 0.3s ease, box-shadow 0.3s ease';
        card.style.willChange = 'auto';
        card.style.transform = '';
        card.style.boxShadow = '';
        cachedRect = null; // Clear cache
      });
      // Update cache on scroll if hovering
      card.addEventListener('wheel', () => cachedRect = null, {passive: true});
    }
 
  });
  grid.appendChild(fragment);
}
 
// CATEGORY FILTER
const CAT_HEADINGS = {
  all:'ALL MOVIES & SHOWS', tv: 'WEB SERIES', hollywood:'HOLLYWOOD', bollywood:'BOLLYWOOD',
  south:'SOUTH INDIAN', tollywood:'TOLLYWOOD', action:'ACTION',
  comedy:'COMEDY', horror:'HORROR', thriller:'THRILLER', romance:'ROMANCE',
  scifi:'SCI-FI', animation:'ANIMATION', kids:'KIDS & CARTOONS', anime:'ANIME SERIES & MOVIES',
  dubbed:'HINDI DUBBED MOVIES', // <-- YE LINE ADD KI HAI
  adult:'18+ ADULT MOVIES & WEB SERIES'
};
function filterCat(cat, e) {
  if (e) e.preventDefault();
  isSearchResultsMode = false;
  const scrollTrigger = document.getElementById('infiniteScrollTrigger');
  if (scrollTrigger) scrollTrigger.style.display = '';
  document.querySelectorAll('.cat-tab').forEach(t => { t.classList.remove('active'); });
  const tabs = document.querySelectorAll('.cat-tab');
  tabs.forEach(t => { if ((t.getAttribute('onclick')||'').indexOf("'"+cat+"'") !== -1) t.classList.add('active'); });
  const h = document.getElementById('sectionHeading');
  if (h) h.textContent = CAT_HEADINGS[cat] || 'MOVIES';
  const sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: 'smooth' });
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
  const scrollTrigger = document.getElementById('infiniteScrollTrigger');
  if (scrollTrigger) scrollTrigger.style.display = '';
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  const tabs = document.querySelectorAll('.cat-tab');
  tabs.forEach(t => { if ((t.getAttribute('onclick')||'').includes('showWatchlist')) t.classList.add('active'); });
  const h = document.getElementById('sectionHeading');
  if (h) {
    h.innerHTML = 'MY WATCHLIST' + (watchlist.length > 0 ? ' <button onclick="clearWatchlist()" class="clear-watchlist-btn"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Clear All</button>' : '');
  }
  const sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: 'smooth' });
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
      const posterImg = m.backdrop_path ? (isTV ? 'https://image.tmdb.org/t/p/w780' : 'https://image.tmdb.org/t/p/w500') + m.backdrop_path : IMG + m.poster_path;
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
          '<img src="'+posterImg+'" alt="'+escapeHTML(m.title||'')+'" width="280" height="157" loading="lazy" decoding="async">' +
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
      card.addEventListener('click', () => { openUpcomingDetail(m.id); });
      fragment.appendChild(card);
      scrollObserver.observe(card);
    });
    grid.appendChild(fragment);
    
    const loadMoreBtn = document.getElementById('loadMoreUpcomingBtn');
    if (loadMoreBtn) {
      loadMoreBtn.style.display = 'none';
      loadMoreBtn.innerHTML = 'Load More Upcoming';
    }
  } catch(e) { console.warn(e); }
 
  // Har load ke baad agle upcoming page ko chupke se fetch karke ready rakho
  if (!isTV) {
    setTimeout(() => prefetchUpcomingPage(currentUpcomingPage + 1), 800);
  }
}

// ── UPCOMING MOVIE DETAIL PAGE (Premium Info Modal) ──
let currentUpcomingMovie = null;
let upcomingTrailerKey = null;

let _udAbortController = null;

async function openUpcomingDetail(id, type) {
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
  document.body.style.overflow = 'hidden';
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
          '<img src="' + imgSrc + '" alt="' + escapeHTML(person.name) + '" loading="lazy" decoding="async">' +
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
  section.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

// INTELLIGENT FUZZY SEARCH
let searchTimer = null;
let searchRequestId = 0;
let searchActiveIndex = -1;
let searchCatalogPromise = null;
const intelligentSearchCache = new Map();
const searchInput = document.getElementById('searchInput');

if (searchInput) {
  searchInput.setAttribute('role', 'combobox');
  searchInput.setAttribute('aria-autocomplete', 'list');
  searchInput.setAttribute('aria-controls', 'searchDropdown');
  searchInput.setAttribute('aria-expanded', 'false');

  searchInput.addEventListener('input', event => {
    clearTimeout(searchTimer);
    searchActiveIndex = -1;
    const query = event.target.value.trim();
    if (!query) {
      searchRequestId++;
      closeDropdown();
      return;
    }
    showSearchLoading(query.length < 2 ? 'Type at least 2 letters' : 'Finding the best matches...');
    if (query.length < 2) return;
    searchTimer = setTimeout(() => searchDropdownFill(query), 260);
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
      closeDropdown();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (searchActiveIndex >= 0 && items[searchActiveIndex]) {
        items[searchActiveIndex].click();
      } else {
        const query = event.target.value.trim();
        if (query) searchAndDisplay(query);
        closeDropdown();
      }
    }
  });
}

document.addEventListener('click', event => {
  if (!event.target.closest('.nav-search')) closeDropdown();
});

function setActiveSearchItem(index, items) {
  searchActiveIndex = index;
  items.forEach((item, itemIndex) => {
    const active = itemIndex === index;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  items[index]?.scrollIntoView({ block: 'nearest' });
}

function showSearchLoading(message) {
  const dropdown = document.getElementById('searchDropdown');
  if (!dropdown) return;
  dropdown.innerHTML = '<div class="search-state"><span class="search-state-spinner"></span><span>' + escapeHTML(message) + '</span></div>';
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

async function intelligentMovieSearch(query, limit = 20) {
  const engine = window.MovieZoneSearch;
  const cacheKey = engine?.normalizeSearchText(query) || query.toLowerCase();
  const cached = intelligentSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 5 * 60 * 1000) return cached.value;

  const aliasQuery = engine?.applyAliases(query) || query;
  const searchPromises = [
    tmdb('/search/multi', { query, language: 'en-US', page: '1', include_adult: 'false' }),
    loadSearchCatalog()
  ];
  if (aliasQuery !== (engine?.normalizeSearchText(query) || query.toLowerCase())) {
    searchPromises.push(tmdb('/search/multi', { query: aliasQuery, language: 'en-US', page: '1', include_adult: 'false' }));
  }

  const settled = await Promise.allSettled(searchPromises);
  const directResults = settled[0].status === 'fulfilled' ? settled[0].value?.results || [] : [];
  const catalog = settled[1].status === 'fulfilled' ? settled[1].value : { media: [], people: [] };
  const aliasResults = settled[2]?.status === 'fulfilled' ? settled[2].value?.results || [] : [];
  const allDirect = directResults.concat(aliasResults);
  const directPeople = allDirect.filter(item => item.media_type === 'person');
  const directMedia = allDirect.filter(item => item.media_type !== 'person');
  const localMedia = [...allMovies, ...carouselMovies, ...allUpcoming].map(item => ({
    ...item,
    media_type: item.media_type || (item.name ? 'tv' : 'movie')
  }));

  if (!engine) {
    const fallback = directMedia.slice(0, limit);
    return { results: fallback, correction: null };
  }

  const rankedPeople = engine.rankSearchCandidates(query, directPeople.concat(catalog.people), 5);
  const personMedia = expandPersonResults(rankedPeople);
  let pool = directMedia.concat(catalog.media, localMedia, personMedia);
  let ranked = engine.rankSearchCandidates(query, pool, Math.max(limit * 3, 30));
  let correction = engine.getCorrection(query, ranked);

  const bestPerson = rankedPeople[0];
  if (bestPerson && bestPerson._searchScore >= 700) {
    correction = bestPerson.name;
  }

  if (correction && engine.normalizeSearchText(correction) !== engine.normalizeSearchText(query)) {
    try {
      const corrected = await tmdb('/search/multi', { query: correction, language: 'en-US', page: '1', include_adult: 'false' });
      const correctedPeople = (corrected.results || []).filter(item => item.media_type === 'person');
      const correctedMedia = (corrected.results || []).filter(item => item.media_type !== 'person');
      pool = pool.concat(correctedMedia, expandPersonResults(correctedPeople));
      ranked = engine.rankSearchCandidates(query, pool, Math.max(limit * 3, 30));
    } catch (error) {
      console.warn('[MovieZone] Corrected search failed:', error);
    }
  }

  ranked.forEach(item => {
    if (item._matchedPerson) item._matchQuality = 'With ' + item._matchedPerson;
  });
  const value = { results: ranked.slice(0, limit), correction };
  intelligentSearchCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

function openSearchResult(item) {
  const type = getSearchMediaType(item);
  const releaseDate = item.release_date || item.first_air_date || '';
  const isUpcomingMovie = type === 'movie' && releaseDate && releaseDate > new Date().toISOString().slice(0, 10);
  if (isUpcomingMovie && typeof openUpcomingDetail === 'function') openUpcomingDetail(item.id);
  else openModal(item.id, type);
  closeDropdown();
}

async function searchDropdownFill(query) {
  const requestId = ++searchRequestId;
  try {
    const search = await intelligentMovieSearch(query, 8);
    if (requestId !== searchRequestId || searchInput?.value.trim() !== query) return;
    renderSearchDropdown(query, search);
  } catch (error) {
    if (requestId !== searchRequestId) return;
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

  if (search.correction) {
    const suggestion = document.createElement('button');
    suggestion.type = 'button';
    suggestion.className = 'search-correction';
    suggestion.innerHTML = '<span>Best match</span><strong>' + escapeHTML(search.correction) + '</strong><small>Typo-tolerant result</small>';
    suggestion.addEventListener('click', () => {
      searchInput.value = search.correction;
      searchAndDisplay(search.correction);
      closeDropdown();
    });
    dropdown.appendChild(suggestion);
  }

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.innerHTML = '<strong>No close match found</strong><span>Try another title, actor name, or a longer part of the movie name.</span>';
    dropdown.appendChild(empty);
  } else {
    const heading = document.createElement('div');
    heading.className = 'search-dropdown-heading';
    heading.innerHTML = '<span>Top intelligent matches</span><small>' + results.length + ' results</small>';
    dropdown.appendChild(heading);

    results.forEach((item, index) => {
      const type = getSearchMediaType(item);
      const releaseDate = item.release_date || item.first_air_date || '';
      const upcoming = releaseDate && releaseDate > new Date().toISOString().slice(0, 10);
      const resultItem = document.createElement('div');
      resultItem.className = 'search-result-item';
      resultItem.tabIndex = -1;
      resultItem.dataset.searchResult = String(index);
      resultItem.setAttribute('role', 'option');
      resultItem.setAttribute('aria-selected', 'false');
      const poster = item.poster_path
        ? IMG + item.poster_path
        : 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2242%22 height=%2260%22><rect width=%2242%22 height=%2260%22 rx=%228%22 fill=%22%23181828%22/><text x=%2221%22 y=%2234%22 text-anchor=%22middle%22 fill=%22%23f5c518%22 font-size=%2214%22>MZ</text></svg>';
      const quality = item._matchQuality || 'Related';
      resultItem.innerHTML =
        '<img src="' + poster + '" alt="" width="42" height="60" loading="lazy" decoding="async">' +
        '<div class="search-result-info"><div class="search-result-title-row"><h4>' + escapeHTML(item.title || item.name || '') + '</h4><span class="search-type-badge">' + (type === 'tv' ? 'SERIES' : 'MOVIE') + '</span></div>' +
        '<p><span>' + escapeHTML((releaseDate || '----').slice(0, 4)) + '</span><span>★ ' + Number(item.vote_average || 0).toFixed(1) + '</span>' + (upcoming ? '<span class="search-upcoming">UPCOMING</span>' : '') + '</p>' +
        '<small class="search-match-reason">' + escapeHTML(quality) + '</small></div>' +
        '<span class="search-result-arrow">›</span>';
      resultItem.addEventListener('mouseenter', () => setActiveSearchItem(index, Array.from(dropdown.querySelectorAll('[data-search-result]'))));
      resultItem.addEventListener('click', () => openSearchResult(item));
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
  dropdown.classList.add('open');
  searchInput?.setAttribute('aria-expanded', 'true');
}

async function searchAndDisplay(query) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;
  isSearchResultsMode = true;
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  const scrollTrigger = document.getElementById('infiniteScrollTrigger');
  if (scrollTrigger) scrollTrigger.style.display = 'none';
  grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  const heading = document.getElementById('sectionHeading');
  if (heading) heading.textContent = 'SEARCHING FOR "' + query.toUpperCase() + '"...';
  const section = document.getElementById('movies-section');
  if (section) section.scrollIntoView({ behavior: 'smooth' });

  try {
    const search = await intelligentMovieSearch(query, 40);
    const movies = search.results.filter(item => item.poster_path && item.media_type !== 'person');
    allMovies = movies;
    if (heading) {
      heading.textContent = search.correction
        ? 'BEST RESULTS FOR "' + query.toUpperCase() + '" · DID YOU MEAN "' + search.correction.toUpperCase() + '"?'
        : 'RESULTS FOR "' + query.toUpperCase() + '"';
    }
    if (movies.length) renderMovies(movies);
    else grid.innerHTML = '<div class="search-grid-empty"><strong>No close matches found</strong><span>Try a title fragment, actor name, or check the spelling.</span></div>';
  } catch (error) {
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
  searchActiveIndex = -1;
}
 
// MODAL
async function openModal(id, type = 'movie') {
  // Add hash to URL to behave like a separate page
  window.history.pushState({ watchPage: true }, '', '#watch-' + type + '-' + id);
  if (isTV) lastFocusedElement = document.activeElement;
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
 
  // 1. INSTANT UI OPEN (Bina backend wait kiye instantly page open karo)
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
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
 
  try {
    const details = await tmdb('/'+type+'/'+id, { language: 'en-US', append_to_response: 'videos,credits' });
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

      if (bestVids.length > 0 && !isTV) {
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
            '<img src="'+imgSrc+'" alt="'+escapeHTML(person.name)+'" loading="lazy" decoding="async">' +
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
            metaHTML += '<div class="modal-prod-chip"><img src="https://image.tmdb.org/t/p/w92'+company.logo_path+'" alt="'+escapeHTML(company.name)+'" title="'+escapeHTML(company.name)+'"></div>';
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
                  <img src="${imgSrc}" style="width:160px; height:90px; object-fit:cover; flex-shrink:0; border-right:1px solid rgba(255,255,255,0.1);" alt="Ep Thumbnail" loading="lazy">
                  <div style="padding:10px 14px; display:flex; flex-direction:column; justify-content:center;">
                    <strong style="font-size:0.95rem; color:var(--gold); display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; text-shadow: 0 2px 4px rgba(0,0,0,0.5);">Ep ${ep.episode_number}: ${escapeHTML(ep.name)}</strong>
                    <span style="font-size:0.8rem; color:rgba(255,255,255,0.7); margin-top:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; line-height:1.4;">${escapeHTML(ep.overview || 'No description available.')}</span>
                    </div>
                  `;
                }
              };
 
              eInput.onchange = () => { 
                updatePreview();
                if(embedEl.querySelector('iframe')) playMovie(); 
              };
              updatePreview();
 
              if(embedEl.querySelector('iframe')) playMovie(); 
            } catch(err) { eInput.innerHTML = '<option value="1">Episode 1</option>'; }
          };
          
          sInput.onchange = (e) => fetchEpisodes(e.target.value, 1); // Season change   Episode 1
          
          fetchEpisodes(lastS, lastE); // Load last saved or first episode
        }
      }
    }
    
    updateModalWatchlistBtn(id);
 
    // Page khulte hi chupke se background me related movies nikal lo
    loadRelatedMovies(id, type);
 
    // TV ke liye Auto-Focus on Play button
    if (isTV) {
      setTimeout(() => {
        const playBtn = document.querySelector('.play-big') || document.querySelector('.premium-play-btn');
        if (playBtn) playBtn.focus();
      }, 300);
    }
  } catch(e) { console.warn('Modal error', e); }
}
 
function closeModal() {
  if (window.location.hash.startsWith('#watch-')) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
  const embedEl = document.getElementById('videoEmbed');
  if (embedEl) {
    embedEl.innerHTML = '';
    embedEl.classList.remove('fullscreen-mode');
  }
  isPlayerFullscreen = false;
  currentModalMovie = null;
  activeTrailerStopper = null; // Unregister trailer stopper on close
  const relSec = document.getElementById('relatedMoviesSection');
  if (relSec) relSec.style.display = 'none';
  
  if (isTV && lastFocusedElement) {
    setTimeout(() => lastFocusedElement.focus(), 100);
  }
}
 
// TV / Phone Back Button Navigation for Watch Page
window.addEventListener('popstate', (e) => {
  const overlay = document.getElementById('modal-overlay');
  if (window.location.hash.startsWith('#watch-')) {
    const parts = window.location.hash.split('-');
    if (parts.length === 3) openModal(parts[2], parts[1]);
  } else if (overlay && overlay.classList.contains('open')) {
    closeModal();
  }
  
  // SHIFT + N for quick Next Episode in Fullscreen
  if (e.shiftKey && e.key.toLowerCase() === 'n') {
    const overlay = document.getElementById('modal-overlay');
    if (overlay && overlay.classList.contains('open') && currentModalMovie && currentModalMovie.media_type === 'tv') {
      playNextEpisode();
      e.preventDefault();
    }
  }
});
 
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
            '<img src="'+IMG+m.poster_path+'" alt="'+escapeHTML(m.title||m.name||'')+'" width="170" height="255" loading="lazy" decoding="async">' +
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
        card.addEventListener('click', () => { openModal(m.id, rType); });
        fragment.appendChild(card);
        scrollObserver.observe(card);
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

      if (prevBtn) prevBtn.onclick = () => { grid.scrollBy({ left: -scrollAmount, behavior: 'smooth' }); };
      if (nextBtn) nextBtn.onclick = () => { grid.scrollBy({ left: scrollAmount, behavior: 'smooth' }); };

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
 
// -- PLAYER SOURCES — FINAL (July 2026) --
// All tested & working. Includes 2 PREMIUM all-in-one servers.
const playerSources = [
  { name: '4K Ultra HD', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    // #1: Viduki.net API 2 — 4K AI Upscaling + Multi-Language + 5.1 Surround
    return type === 'tv'
      ? `https://www.viduki.net/2/tv/${id}/${s}/${e}`
      : `https://www.viduki.net/2/movie/${id}`;
  }},
  { name: 'Cinextream', dubbed: true, is4K: true, url: (id, lang, type, s, e) => {
    // #2 ULTIMATE ALL-ROUNDER: Cinextream.net
    // 115K Movies + 79K Shows + 9K Anime (SUB & DUB)
    // Hindi Dubbed anime, Auto-next, Fast servers, 1080p, Customizable
    // No heavy ads, server fallback built-in, error recovery
    return type === 'tv'
      ? `https://cinextream.net/api/embed/tv/${id}/${s}/${e}?color=E6B800&autoplay=true`
      : `https://cinextream.net/api/embed/movie/${id}?color=E6B800&autoplay=true`;
  }},
  { name: 'VidPhantom Pro', dubbed: true, url: (id, lang, type, s, e) => {
    // #3 PREMIUM: VidPhantom — AD-FREE, 115K Movies + 79K Episodes + 5.3K Anime
    // Multi-provider failover, customizable player, watch progress, next episode hook
    return type === 'tv'
      ? `https://vidphantom.com/tv/${id}/${s}/${e}?autoplay=true&sub_lang=${lang}`
      : `https://vidphantom.com/movie/${id}?autoplay=true&sub_lang=${lang}`;
  }},
  { name: 'Pro Stream', dubbed: true, url: (id, lang, type, s, e) => {
    // #4: VidLink Pro — Clean interface with settings
    return (type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : 'https://vidlink.pro/movie/' + id) + `?lang=${lang}`;
  }},
  { name: 'VidNest', dubbed: true, url: (id, lang, type, s, e) => {
    // #5: VidNest — 9 servers, Audio switcher, ad-free plays
    return type === 'tv'
      ? `https://vidnest.fun/tv/${id}/${s}/${e}`
      : `https://vidnest.fun/movie/${id}`;
  }},
  { name: 'Ultra HD', dubbed: true, url: (id, lang, type, s, e) => {
    // #6: AutoEmbed — India ke networks par blockage kam aati hai
    return (type === 'tv' ? `https://autoembed.co/tv/tmdb/${id}-${s}-${e}` : 'https://autoembed.co/movie/tmdb/' + id) + `?lang=${lang}`;
  }},
  { name: 'VidCore', dubbed: true, url: (id, lang, type, s, e) => {
    // #7: VidCore — 14 servers, subtitle support
    return type === 'tv'
      ? `https://vidcore.org/embed/tv/${id}/${s}/${e}`
      : `https://vidcore.org/embed/movie/${id}`;
  }},
  { name: 'Flicky Stream', dubbed: true, url: (id, lang, type, s, e) => {
    // #8: Flicky — Working embed, multiple servers
    return type === 'tv'
      ? `https://flicky.host/embed/tv/?id=${id}&s=${s}&e=${e}`
      : `https://flicky.host/embed/movie/?id=${id}`;
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
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
      <span style="font-size:0.7rem;font-weight:800;letter-spacing:1.8px;color:rgba(255,255,255,0.35);text-transform:uppercase;"> Audio Language</span>
      <span style="font-size:0.68rem;color:#10b981;background:rgba(16,185,129,0.1);padding:2px 9px;border-radius:999px;border:1px solid rgba(16,185,129,0.2);"> = Dubbed available</span>
    </div>
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

  const serverBtnsHtml = playerSources.map((s, i) =>
    '<button class="player-chip player-chip--source'+(s.dubbed ? ' player-chip--dubbed' : '')+(s.is4K ? ' player-chip--4k' : '')+'" data-srcidx="'+i+'" title="'+(s.is4K ? '4K AI Upscaling + Multi-Language + Spatial Audio' : (s.dubbed ? 'Hindi Dubbed Supported' : 'Mostly English Audio'))+'">'+escapeHTML(s.name)+(s.dubbed ? '<span class="dubbed-dot"></span>' : '')+(s.is4K ? '<span class="fourk-badge">4K</span>' : '')+'</button>'
  ).join('');
  ext.innerHTML =
    '<div style="font-size:0.7rem;font-weight:800;letter-spacing:1.8px;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:8px;"> Playback Server</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:7px;">' + serverBtnsHtml + '</div>';

  const srcButtons = ext.querySelectorAll('.player-chip--source');
  srcButtons.forEach(btn => {
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
 
function getSelectedSourceIdx() {
  const saved = parseInt(localStorage.getItem('moviezone.playerSourceIdx') || '0', 10);
  return isNaN(saved) ? 0 : Math.max(0, Math.min(saved, playerSources.length - 1));
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
 
  // AUTO-SAVE TV PROGRESS (Continue Watching)
  if (type === 'tv') {
    localStorage.setItem('mz_progress_' + id, JSON.stringify({ season: parseInt(s), episode: parseInt(e) }));
  }

  // Clear previous player instantly to prevent background audio/lag
  embedEl.innerHTML = '';
  
  // Cancel any running auto-retry timer
  if (window._mzRetryTimer) { clearTimeout(window._mzRetryTimer); window._mzRetryTimer = null; }
 
  // Add Optimized Loading Spinner with server info
  const loader = document.createElement('div');
  loader.className = 'player-loader';
  loader.id = 'mzPlayerLoader';
  const isDubServer = playerSources[srcIdx].dubbed;
  loader.innerHTML = `
    <div class="player-spinner"></div>
    <div style="color:var(--gold); margin-top:15px; font-weight:600; font-size:0.9rem;">
      ${isDubServer ? 'Loading Hindi Dubbed Stream...' : 'Loading Stream...'}
    </div>
    <div style="color:rgba(255,255,255,0.4); margin-top:6px; font-size:0.75rem;">
      Server: ${escapeHTML(playerSources[srcIdx].name)} ${isDubServer ? '• Dubbed ?' : ''}
    </div>
  `;
  embedEl.appendChild(loader);
 
  const iframe = document.createElement('iframe');
  iframe.id = 'playerFrame';
  iframe.src = src;
  iframe.style.cssText = 'width: 100%; height: 100%; border: none; background: transparent; position: relative; z-index: 1; transform: translateZ(0);';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allow', 'fullscreen;autoplay;encrypted-media;picture-in-picture');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('fetchpriority', 'high'); 
  iframe.setAttribute('loading', 'eager'); 
  
  embedEl.appendChild(iframe);

  // -- AUTO-RETRY SYSTEM: If server doesn't load in 12s, try next dubbed server --
  let hasLoaded = false;
  
  iframe.onload = () => {
    hasLoaded = true;
    if (loader && loader.parentNode) { 
      loader.style.opacity = '0';
      setTimeout(() => { if (loader && loader.parentNode) loader.remove(); }, 400);
    }
  };
  
  iframe.onerror = () => {
    // Server refused connection - auto try next
    autoRetryNextServer(id, srcIdx, lang, quality, type);
  };

  // Timeout-based auto-retry (if iframe stuck loading for 12 seconds)
  window._mzRetryTimer = setTimeout(() => {
    if (!hasLoaded) {
      const loaderEl = document.getElementById('mzPlayerLoader');
      if (loaderEl) {
        loaderEl.innerHTML = `
          <div style="color:#e63946; font-size:0.9rem; font-weight:600;"> Server slow/blocked</div>
          <div style="color:rgba(255,255,255,0.5); margin-top:6px; font-size:0.78rem;">Auto-trying next dubbed server...</div>
          <div class="player-spinner" style="width:28px; height:28px; border-width:2px; margin-top:10px;"></div>
        `;
      }
      setTimeout(() => autoRetryNextServer(id, srcIdx, lang, quality, type), 1500);
    }
  }, 12000);

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
  setTimeout(() => embedEl.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  
}

function autoRetryNextServer(id, currentIdx, lang, quality, type) {
  const DUBBED_LANG_LIST = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'];
  const isDubbedLang = DUBBED_LANG_LIST.includes(lang);
  
  // Find next server to try (prefer dubbed servers for dubbed languages)
  let nextIdx = -1;
  for (let i = currentIdx + 1; i < playerSources.length; i++) {
    if (isDubbedLang && playerSources[i].dubbed) { nextIdx = i; break; }
  }
  // If no more dubbed servers, try any server
  if (nextIdx === -1) {
    for (let i = currentIdx + 1; i < playerSources.length; i++) {
      nextIdx = i; break;
    }
  }
  // Wrap around to first server if we've exhausted all
  if (nextIdx === -1 && currentIdx > 0) {
    nextIdx = 0;
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
  const title = currentModalMovie.title || currentModalMovie.name || '';
  const year = (currentModalMovie.release_date || currentModalMovie.first_air_date || '').slice(0, 4);
  const isTV = currentModalMovie.media_type === 'tv';
  const lang = currentModalMovie.original_language || 'en';
  
  // Get download button reference
  const dlBtn = document.querySelector('.btn-download');
  let originalBtnHtml = '';
  if (dlBtn) {
    originalBtnHtml = dlBtn.innerHTML;
    dlBtn.innerHTML = '<div class="player-spinner" style="width:18px; height:18px; border-width:2px; border-color:rgba(16,185,129,0.2); border-left-color:#10b981;"></div><span style="color:#10b981;">Searching...</span>';
    dlBtn.style.pointerEvents = 'none';
    dlBtn.style.borderColor = '#10b981';
  }
 
  // Remove existing modal if any
  const existingModal = document.getElementById('dlModal');
  if (existingModal) existingModal.remove();

  // ── BUILD DOWNLOAD LINKS ──
  
  // 1. DIRECT DOWNLOAD SITES (Multiple options for Movies, TV, Anime)
  const encodedTitle = encodeURIComponent(title);
  const encodedTitleYear = encodeURIComponent(`${title} ${year}`);
  
  let directLinksHtml = '';
  
  if (isTV) {
    // TV SHOWS / WEB SERIES download links
    directLinksHtml = `
      <a href="https://www.google.com/search?q=${encodedTitleYear}+download+hindi+dubbed+web+series" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid #10b981; margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Google - Hindi Dubbed</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">Search</span>
      </a>
      <a href="https://1337x.to/search/${encodedTitle}+${year}/1/" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid #e63946; margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">1337x Torrents</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">All Seasons</span>
      </a>
      <a href="https://www.google.com/search?q=${encodedTitleYear}+index+of+mkv+480p+720p+1080p" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--accent); margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Index of (Direct Files)</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">MKV/MP4</span>
      </a>
      <a href="https://www.google.com/search?q=${encodedTitle}+vegamovies+OR+moviesflix+OR+filmyzilla+download" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--gold); margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Hindi Dubbed Sites</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">480p-4K</span>
      </a>
    `;
  } else {
    // MOVIES download links
    directLinksHtml = `
      <a href="https://www.google.com/search?q=${encodedTitleYear}+download+hindi+dubbed+480p+720p+1080p+4k" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid #10b981; margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Google - Hindi Dubbed</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">All Quality</span>
      </a>
      <a href="https://1337x.to/search/${encodedTitle}+${year}/1/" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid #e63946; margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">1337x Torrents</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">HD/4K</span>
      </a>
      <a href="https://www.google.com/search?q=${encodedTitleYear}+index+of+mkv+1080p+OR+2160p+OR+4k" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--accent); margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Index of (Direct Files)</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">MKV/MP4</span>
      </a>
      <a href="https://www.google.com/search?q=${encodedTitle}+${year}+vegamovies+OR+moviesflix+OR+filmyzilla+OR+mp4moviez+download+hindi" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--gold); margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Hindi Dubbed Sites</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">Dual Audio</span>
      </a>
    `;
  }

  // 2. TORRENT SECTION (YTS for movies, 1337x for all)
  let torrentsHtml = '';
  try {
    if (!isTV) {
      const query = currentModalMovie.imdb_id || title;
      let ytsData = null;
      let fetchSuccess = false;
      
      const mirrors = ['https://yts.mx', 'https://yts.rs', 'https://yts.do', 'https://yify.is'];
      
      for (const mirror of mirrors) {
        try {
          const ytsRes = await fetch(mirror + '/api/v2/list_movies.json?query_term=' + encodeURIComponent(query));
          if (ytsRes.ok) {
            ytsData = await ytsRes.json();
            fetchSuccess = true;
            break;
          }
        } catch(e) {}
      }
      
      if (fetchSuccess && ytsData && ytsData.data && ytsData.data.movies && ytsData.data.movies.length > 0) {
        const movie = ytsData.data.movies[0];
        if (movie.torrents && movie.torrents.length > 0) {
          torrentsHtml = movie.torrents.map(t => {
            const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.opentrackr.org:1337/announce`;
            return `
              <a href="${magnet}" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--gold); margin-bottom:8px;">
                <span style="display:flex; align-items:center; gap:10px;">
                  <strong style="color:#fff; font-size:0.95rem;">${t.quality} ${t.type.toUpperCase()}</strong>
                </span>
                <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">${t.size}</span>
              </a>
            `;
          }).join('');
        }
      }
    }
    
    // Fallback for TV shows and if YTS fails
    if (!torrentsHtml) {
      torrentsHtml = `
        <a href="https://1337x.to/search/${encodedTitle}+${year}/1/" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--gold); margin-bottom:8px;">
          <span style="display:flex; align-items:center; gap:10px;">
            <strong style="color:#fff; font-size:0.95rem;">Search on 1337x</strong>
          </span>
          <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">Torrent</span>
        </a>
        <a href="https://torrentgalaxy.to/torrents.php?search=${encodedTitle}+${year}" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--accent); margin-bottom:8px;">
          <span style="display:flex; align-items:center; gap:10px;">
            <strong style="color:#fff; font-size:0.95rem;">TorrentGalaxy</strong>
          </span>
          <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">All Quality</span>
        </a>
      `;
    }
  } catch(err) {
    torrentsHtml = `
      <a href="https://1337x.to/search/${encodedTitle}+${year}/1/" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--gold); margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Search on 1337x</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">Manual Search</span>
      </a>
    `;
  }

  // 3. ANIME DOWNLOAD (if anime/cartoon detected)
  let animeHtml = '';
  const isAnime = (currentModalMovie.genre_ids || []).includes(16) || lang === 'ja';
  if (isAnime || isTV) {
    animeHtml = `
      <h4 style="font-size:0.7rem; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--text2); margin-top:1.2rem; margin-bottom:0.8rem; padding-bottom:0.4rem; border-bottom: 1px solid rgba(255,255,255,0.1);">ANIME / CARTOON DOWNLOAD</h4>
      <a href="https://www.google.com/search?q=${encodedTitle}+hindi+dubbed+anime+download+480p+720p+1080p" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid #06b6d4; margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Anime Hindi Dubbed</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">Google</span>
      </a>
      <a href="https://nyaa.si/?f=0&c=0_0&q=${encodedTitle}" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid #7c3aed; margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Nyaa.si (Anime Torrents)</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">Sub/Dub</span>
      </a>
      <a href="https://www.google.com/search?q=${encodedTitle}+animedubhindi+OR+toonsplus+OR+toonworld4all+download" target="_blank" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid #f59e0b; margin-bottom:8px;">
        <span style="display:flex; align-items:center; gap:10px;">
          <strong style="color:#fff; font-size:0.95rem;">Cartoon/Anime Hindi Sites</strong>
        </span>
        <span style="font-size:0.8rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">Multi Quality</span>
      </a>
    `;
  }
 
  // Restore button state
  if (dlBtn) {
    dlBtn.innerHTML = originalBtnHtml;
    dlBtn.style.pointerEvents = 'auto';
    dlBtn.style.borderColor = '';
  }
 
  // 3. Update Modal UI with fetched Links
  const dlModalHtml = `
    <div id="dlModal" style="position:fixed; inset:0; z-index:999999; background:rgba(5,5,8,0.85); backdrop-filter:blur(12px); display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity 0.3s ease;">
      <div style="background:var(--card); padding:2.5rem; border-radius:20px; border:1px solid rgba(255,255,255,0.1); width:90%; max-width:420px; text-align:center; box-shadow:0 25px 50px rgba(0,0,0,0.6); transform:scale(0.95); transition:transform 0.3s ease;" id="dlModalBox">
        <h3 style="margin-bottom:0.5rem; font-family:'Bebas Neue', sans-serif; font-size:2.2rem; color:#fff; letter-spacing:1px;">Download Options</h3>
        <p style="font-size:0.85rem; color:var(--text2); margin-bottom:1.5rem; line-height:1.5;">Apna pasandeeda download method chunein.</p>
        <div style="display:flex; flex-direction:column; max-height:350px; overflow-y:auto; padding-right:5px; text-align:left;">
          
          <h4 style="font-size:0.7rem; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--text2); margin-bottom:0.8rem; padding-bottom:0.4rem; border-bottom: 1px solid rgba(255,255,255,0.1);">DIRECT DOWNLOAD</h4>
          ${directLinksHtml}

          <h4 style="font-size:0.7rem; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:var(--text2); margin-top:1.2rem; margin-bottom:0.8rem; padding-bottom:0.4rem; border-bottom: 1px solid rgba(255,255,255,0.1);">TORRENT DOWNLOAD</h4>
          ${torrentsHtml}
          ${animeHtml}
        </div>
        <button onclick="const m=document.getElementById('dlModal'); m.style.opacity='0'; setTimeout(()=>m.remove(),300);" style="margin-top:1.5rem; width:100%; background:transparent; border:1px solid rgba(255,255,255,0.2); color:var(--text); padding:0.8rem; border-radius:12px; cursor:pointer; font-weight:600; transition:all 0.2s;">Close</button>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', dlModalHtml);
  
  setTimeout(() => {
    const dlModal = document.getElementById('dlModal');
    const dlModalBox = document.getElementById('dlModalBox');
    if (dlModal && dlModalBox) {
      dlModal.style.opacity = '1';
      dlModalBox.style.transform = 'scale(1)';
    }
  }, 10);
}
 
function togglePlayerFS() {
  const embedEl = document.getElementById('videoEmbed');
  const btn = document.getElementById('fsBtn');
  if (!embedEl) return;
 
  if (!document.fullscreenElement && !document.webkitFullscreenElement && !isPlayerFullscreen) {
    const target = embedEl;
    try {
      let fsResult = null;
      if (target.requestFullscreen) fsResult = target.requestFullscreen();
      else if (target.webkitRequestFullscreen) fsResult = target.webkitRequestFullscreen();
      
      Promise.resolve(fsResult).then(() => {
        if (screen.orientation && screen.orientation.lock) {
          return screen.orientation.lock('landscape').catch(() => {});
        }
      }).catch(() => {});
    } catch (err) {
      isPlayerFullscreen = true;
      embedEl.classList.add('fullscreen-mode');
      if (btn) btn.textContent = 'Exit';
      document.addEventListener('keydown', exitFSOnEsc);
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
 
// Direct link URL load handle karo (agar kisi ne URL bheji ho toh direct khul jaye)
window.addEventListener('DOMContentLoaded', () => {
  if (window.location.hash.startsWith('#watch-')) {
    const parts = window.location.hash.split('-');
    if (parts.length === 3) {
      setTimeout(() => { openModal(parts[2], parts[1]); }, 500);
    }
  }
});
 
function exitFSOnEsc(e) {
  if (e.key === 'Escape') togglePlayerFS();
}
 
const modalOverlay = document.getElementById('modal-overlay');
if (modalOverlay) {
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });
}
 
// -- ANTI-REDIRECT (FRAME-BUSTING BLOCKER) WITHOUT SANDBOX --
// Anti-redirect blocker for mobile (prevents third-party server auto-redirects)
// TVs par ye block issue create karta hai video iframes ke liye, isliye !isTV par lagaya
if (!isTV) {
  window.addEventListener('beforeunload', (e) => {
    if (currentModalMovie) {
      e.preventDefault();
      e.returnValue = 'Ads are trying to redirect you. Stay on this page to continue watching.';
      return e.returnValue;
    }
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

  // -- DYNAMICALLY ADD KIDS TAB --
  const catTabs = document.querySelector('.cat-tabs');
  if (catTabs && !document.querySelector('.cat-tab[onclick*="kids"]')) {
    const kidsTab = document.createElement('button');
    kidsTab.className = 'cat-tab';
    kidsTab.tabIndex = 0;
    kidsTab.setAttribute('onclick', "filterCat('kids')");
    kidsTab.innerHTML = 'Cartoons';
    catTabs.appendChild(kidsTab);
  }
  if (catTabs && !document.querySelector('.cat-tab[onclick*="anime"]')) {
    const animeTab = document.createElement('button');
    animeTab.className = 'cat-tab';
    animeTab.tabIndex = 0;
    animeTab.setAttribute('onclick', "filterCat('anime')");
    animeTab.innerHTML = ' Anime';
    catTabs.appendChild(animeTab);
  }
      
      // -- DYNAMICALLY ADD 18+ ADULT TAB --
      if (catTabs && !document.querySelector('.cat-tab[onclick*="adult"]')) {
        const adultTab = document.createElement('button');
        adultTab.className = 'cat-tab';
        adultTab.tabIndex = 0;
        adultTab.setAttribute('onclick', "filterCat('adult')");
        adultTab.innerHTML = '18+';
        catTabs.appendChild(adultTab);
      }

            // -- DYNAMICALLY ADD HINDI DUBBED TAB --
      if (catTabs && !document.querySelector('.cat-tab[onclick*="dubbed"]')) {
        const dubbedTab = document.createElement('button');
        dubbedTab.className = 'cat-tab';
        dubbedTab.tabIndex = 0;
        dubbedTab.setAttribute('onclick', "filterCat('dubbed')");
        dubbedTab.innerHTML = 'Hindi Dubbed';
        catTabs.appendChild(dubbedTab);
      }

  // Fluid Ripple Effect for buttons
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-play, .btn-info, .btn-watchlist, .btn-download, .load-more-btn, .premium-play-btn, .cat-tab, .carousel-arrow, .nav-btn');
    if (btn && !isTV) {
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
          `<a href="${a.getAttribute('href') || '#'}" class="mz-mp-link${a.classList.contains('active') ? ' active' : ''}" data-idx="${i}" style="--i:${i}">${a.textContent}</a>`
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
 
// -- TV REMOTE NAVIGATION: Full D-Pad Spatial Navigation System --
(function initTVNavigation() {
  const TV_FOCUSABLE_SELECTORS = '.movie-card, .upcoming-card, .cat-tab, .btn-play, .btn-info, .player-chip, .nav-links a, .carousel-arrow, button[tabindex]';

  // 1. Add tabindex=0 to all focusable TV elements
  function markFocusable() {
    if (!isTV) return;
    document.querySelectorAll(TV_FOCUSABLE_SELECTORS).forEach(el => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
  }

  // Run on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markFocusable);
  } else {
    markFocusable();
  }

  // Re-run when new cards are rendered (MutationObserver)
  if (isTV) {
    const observer = new MutationObserver((mutations) => {
      let hasNewNodes = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) { hasNewNodes = true; break; }
      }
      if (hasNewNodes) markFocusable();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // 2. Spatial navigation: find nearest element in direction
  function getVisibleFocusables() {
    const els = document.querySelectorAll(TV_FOCUSABLE_SELECTORS);
    return Array.from(els).filter(el => {
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function findNearest(current, direction) {
    const focusables = getVisibleFocusables();
    const currentRect = current.getBoundingClientRect();
    const cx = currentRect.left + currentRect.width / 2;
    const cy = currentRect.top + currentRect.height / 2;

    let best = null;
    let bestDist = Infinity;

    for (const el of focusables) {
      if (el === current) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;

      // Filter by direction
      let inDirection = false;
      switch (direction) {
        case 'left':  inDirection = dx < -10; break;
        case 'right': inDirection = dx > 10; break;
        case 'up':    inDirection = dy < -10; break;
        case 'down':  inDirection = dy > 10; break;
      }
      if (!inDirection) continue;

      // Weighted distance: heavily penalize perpendicular offset
      let primaryDist, crossDist;
      if (direction === 'left' || direction === 'right') {
        primaryDist = Math.abs(dx);
        crossDist = Math.abs(dy);
      } else {
        primaryDist = Math.abs(dy);
        crossDist = Math.abs(dx);
      }
      const dist = primaryDist + crossDist * 3;

      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }
    return best;
  }

  // 3. Main keydown handler for TV
  document.addEventListener('keydown', (e) => {
    if (!isTV) {
      // Non-TV: basic Enter/Space click for custom focusable elements
      if ((e.key === 'Enter' || e.key === ' ') && document.activeElement) {
        const tag = document.activeElement.tagName;
        if (tag !== 'BUTTON' && tag !== 'A' && tag !== 'INPUT') {
          document.activeElement.click();
          e.preventDefault();
        }
      }
      return;
    }

    const key = e.key;
    const keyCode = e.keyCode || e.which;

    // D-Pad Arrow Navigation
    const directionMap = {
      'ArrowLeft': 'left', 'ArrowRight': 'right',
      'ArrowUp': 'up', 'ArrowDown': 'down'
    };
    if (directionMap[key]) {
      e.preventDefault();
      const active = document.activeElement;
      if (!active || active === document.body) {
        // No focus yet — focus first visible element
        const first = getVisibleFocusables()[0];
        if (first) first.focus();
        return;
      }
      const target = findNearest(active, directionMap[key]);
      if (target) {
        target.focus();
        // Smooth scroll to center
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
      return;
    }

    // Enter/Space: Click focused element
    if (key === 'Enter' || key === ' ' || keyCode === 13 || keyCode === 32) {
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.click();
        e.preventDefault();
      }
      return;
    }

    // Back keys: Escape, Tizen (10009), WebOS (461), Backspace
    const isBackKey = key === 'Escape' || keyCode === 27 || keyCode === 10009 || keyCode === 461 ||
      (key === 'Backspace' && document.activeElement && document.activeElement.tagName !== 'INPUT');
    if (isBackKey) {
      const overlay = document.getElementById('modal-overlay');
      const collectionsOverlay = document.getElementById('collections-hub-overlay');
      if (overlay && overlay.classList.contains('open')) {
        if (typeof closeModal === 'function') closeModal();
        e.preventDefault();
      } else if (collectionsOverlay && collectionsOverlay.classList.contains('open')) {
        if (typeof handleCollectionsBack === 'function') handleCollectionsBack();
        e.preventDefault();
      } else {
        const dd = document.getElementById('searchDropdown');
        if (dd && dd.classList.contains('open')) {
          if (typeof closeDropdown === 'function') closeDropdown();
          e.preventDefault();
        }
      }
      return;
    }

    // Media keys: Play/Pause, Stop, FastForward, Rewind
    const mediaKeys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
                       'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious'];
    const mediaKeyCodes = [179, 415, 19, 413, 417, 412, 176, 177];
    if (mediaKeys.includes(key) || mediaKeyCodes.includes(keyCode)) {
      e.preventDefault();
      if (key === 'MediaPlayPause' || key === 'MediaPlay' || key === 'MediaPause' || keyCode === 179 || keyCode === 415 || keyCode === 19) {
        const playBtn = document.querySelector('.play-big') || document.querySelector('.premium-play-btn') || document.querySelector('.btn-play');
        if (playBtn) playBtn.click();
      }
      return;
    }
  });

  // 6. Auto-scroll focused element to center (for focus via Tab or programmatic focus)
  if (isTV) {
    document.addEventListener('focus', (e) => {
      const overlay = document.getElementById('modal-overlay');
      if (e.target && e.target.scrollIntoView && (!overlay || !overlay.classList.contains('open'))) {
        e.target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    }, true);
  }
})();
 
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
  if (h && h.textContent === 'MY WATCHLIST') {
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
  
  if (!isHash) window.scrollTo({ top: 0, behavior: 'smooth' });
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

        const botIndicators = ['swiftshader', 'mesa', 'llvmpipe', 'headless'];
        if (botIndicators.some(indicator => renderer.includes(indicator))) {
          console.error('Potential Bot/Headless Browser Detected!', { vendor, renderer });
          window.dispatchEvent(new CustomEvent('bot-detected', { detail: { vendor, renderer } }));
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
    if (isTV) return MAX_CARDS_TV;
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
  
  // 4. Detect if page becomes unresponsive and lighten load
  let lastFrameTime = performance.now();
  let lowFPSCount = 0;
  
  function checkPerformance() {
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;
    
    // If frame took > 100ms (less than 10 FPS), device is struggling
    if (delta > 100) {
      lowFPSCount++;
      if (lowFPSCount > 3 && !document.documentElement.classList.contains('tv-mode')) {
        // Only auto-enable tv-mode on devices that are NOT desktop/laptop
        // Desktop/laptop must ALWAYS keep premium look — only strip particles for perf
        const isDesktopDevice = /Windows NT|Macintosh|Mac OS X|CrOS|Linux x86_64/i.test(navigator.userAgent);
        if (!isDesktopDevice) {
          document.documentElement.classList.add('tv-mode');
          console.warn('Performance: Auto-enabled tv-mode due to low FPS');
        }
        // On ALL devices: remove heavy particles to recover FPS
        const particles = document.querySelector('.ambient-particles');
        if (particles) particles.remove();
      }
    } else {
      lowFPSCount = Math.max(0, lowFPSCount - 1);
    }
    requestAnimationFrame(checkPerformance);
  }
  // Run FPS monitor on all devices to auto-detect lag
  requestAnimationFrame(checkPerformance);
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
        <div class="cw-card" onclick="openCWMovie(${item.id}, '${item.media_type}')" tabindex="0">
          <img class="cw-card-img" src="${img}" alt="${item.title}" loading="lazy">
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
  window.openCWMovie = function(id, mediaType) {
    // Reuse existing openModal function
    if (typeof openModal === 'function') openModal(id, mediaType);
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

  // 2. PWA Install Prompt — Handled by pwa-install.js (luxury popup)
  // Navbar install button shows only when the native prompt is available or after
  // a grace period (so manual install flow remains accessible).
  const navInstallBtn = document.getElementById('navInstallBtn');
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

  if (!isInstalled && navInstallBtn) {
    // Show immediately if native prompt already captured
    if (window.deferredPrompt) {
      navInstallBtn.style.display = 'flex';
      navInstallBtn.classList.add('mz-install-native-ready');
    } else {
      // Show when native prompt arrives (with a visual pulse)
      window.addEventListener('mz:installready', function () {
        navInstallBtn.style.display = 'flex';
        navInstallBtn.classList.add('mz-install-native-ready');
      });
      // Fallback: show after 35s regardless (for manual install access)
      setTimeout(function () {
        if (!isInstalled) navInstallBtn.style.display = 'flex';
      }, 35000);
    }
  }

  // Global install function — called from navbar button and banner.
  // pwa-install.js owns the ONLY native prompt path, preserving direct-click semantics.
  window.installPWA = function() {
    if (typeof window.__mzTriggerInstall === 'function') {
      if (!window.deferredPrompt && window.__mzOpenInstallPopup) window.__mzOpenInstallPopup();
      return window.__mzTriggerInstall();
    }

    // Defensive UI fallback if the dedicated install controller failed to load.
    if (window.__mzOpenInstallPopup) {
      window.__mzOpenInstallPopup();
      return;
    }
    const overlay = document.getElementById('pwa-install-overlay');
    if (overlay) {
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
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
    if (!('Notification' in window)) {
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




// === COLLECTIONS HUB (Accurate per-universe data + premium routing) ===
(function initCollectionsHub() {
  // Each universe uses whichever TMDB data source actually returns the correct, complete movie list.
  // "keyword" = shared-universe movies scattered across many TMDB collections (MCU, DCEU).
  // "collection" = a single reliable TMDB collection id (franchises that aren't multi-studio shared universes).
  const UNIVERSES = [
    { slug: 'mcu', name: 'Marvel Cinematic Universe', badge: 'MARVEL', tagline: 'Every Avenger. Every Infinity Stone. One universe.', source: 'keyword', id: 180547, accent: 'marvel' },
    { slug: 'dceu', name: 'DC Extended Universe', badge: 'DC', tagline: 'Superman, Batman and the Justice League, together.', source: 'keyword', id: 229266, accent: 'dc' },
    { slug: 'wizarding-world', name: 'Harry Potter Collection', badge: 'WIZARDING WORLD', tagline: 'The complete journey through Hogwarts.', source: 'collection', id: 1241, accent: 'wizard' },
    { slug: 'fast-furious', name: 'Fast & Furious', badge: 'FAMILY', tagline: 'High-octane heists and family loyalty.', source: 'collection', id: 9485, accent: 'fast' },
    { slug: 'star-wars', name: 'Star Wars', badge: 'STAR WARS', tagline: 'A galaxy far, far away.', source: 'collection', id: 10, accent: 'starwars' },
    { slug: 'middle-earth', name: 'The Lord of the Rings', badge: 'MIDDLE-EARTH', tagline: 'One ring. One legendary trilogy.', source: 'collection', id: 119, accent: 'lotr' },
    { slug: 'james-bond', name: 'James Bond', badge: '007', tagline: 'License to thrill, six decades strong.', source: 'collection', id: 645, accent: 'bond' },
    { slug: 'jurassic-park', name: 'Jurassic Park', badge: 'JURASSIC', tagline: 'Life finds a way.', source: 'collection', id: 328, accent: 'jurassic' },
    { slug: 'mission-impossible', name: 'Mission: Impossible', badge: 'M:I', tagline: 'Impossible missions, unstoppable agent.', source: 'collection', id: 87359, accent: 'mi' },
    { slug: 'john-wick', name: 'John Wick', badge: 'ACTION', tagline: 'An unrelenting legend of vengeance.', source: 'collection', id: 404609, accent: 'wick' },
    { slug: 'conjuring', name: 'The Conjuring Universe', badge: 'HORROR', tagline: 'The most terrifying true-case horror universe.', source: 'collection', id: 313086, accent: 'horror' },
    { slug: 'httyd', name: 'How to Train Your Dragon', badge: 'ANIMATION', tagline: 'Hiccup, Toothless and the Viking skies.', source: 'collection', id: 89137, accent: 'dragon' },
    { slug: 'despicable-me', name: 'Despicable Me & Minions', badge: 'ANIMATION', tagline: 'Gru, his Minions and every villain in between.', source: 'collection', id: 86066, accent: 'minions' }
  ];

  const hubCache = new Map();
  let activeUniverseSlug = null;

  function getUniverse(slug) {
    return UNIVERSES.find(universe => universe.slug === slug);
  }

  async function fetchUniverseMovies(universe) {
    if (hubCache.has(universe.slug)) return hubCache.get(universe.slug);

    const promise = (async () => {
      let movies = [];
      if (universe.source === 'keyword') {
        const pages = await Promise.allSettled([
          tmdb('/discover/movie', { with_keywords: String(universe.id), sort_by: 'primary_release_date.asc', language: 'en-US', page: '1' }),
          tmdb('/discover/movie', { with_keywords: String(universe.id), sort_by: 'primary_release_date.asc', language: 'en-US', page: '2' })
        ]);
        pages.forEach(page => { if (page.status === 'fulfilled') movies.push(...(page.value.results || [])); });
        // Shared-universe keyword sets include a few promo shorts/specials/documentaries — filter those out.
        movies = movies.filter(movie => {
          if (!movie.poster_path || (movie.vote_count || 0) < 10) return false;
          const title = (movie.title || '').toLowerCase();
          if (/\bspecial\b|behind the scenes|making of|disney\+ day/.test(title)) return false;
          return true;
        });
      } else {
        const data = await tmdb('/collection/' + universe.id, { language: 'en-US' }).catch(() => ({ parts: [] }));
        movies = (data.parts || []).filter(movie => movie.poster_path);
      }

      const seen = new Set();
      const unique = movies.filter(movie => {
        if (seen.has(movie.id)) return false;
        seen.add(movie.id);
        return true;
      });
      unique.sort((a, b) => (a.release_date || '9999').localeCompare(b.release_date || '9999'));
      return unique;
    })();

    hubCache.set(universe.slug, promise);
    return promise;
  }

  function buildHubCard(universe) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ch-card ch-accent-' + universe.accent;
    card.setAttribute('data-slug', universe.slug);
    card.innerHTML =
      '<div class="ch-card-posters" id="chPosters-' + universe.slug + '"><div class="ch-card-skeleton"></div></div>' +
      '<div class="ch-card-overlay"></div>' +
      '<div class="ch-card-body">' +
        '<span class="ch-card-badge">' + escapeHTML(universe.badge) + '</span>' +
        '<h3>' + escapeHTML(universe.name) + '</h3>' +
        '<p>' + escapeHTML(universe.tagline) + '</p>' +
        '<span class="ch-card-count" id="chCount-' + universe.slug + '">Loading…</span>' +
      '</div>';
    card.addEventListener('click', () => openUniverse(universe.slug));
    return card;
  }

  function renderHubGrid() {
    const grid = document.getElementById('chGrid');
    if (!grid || grid.dataset.built) return;
    grid.dataset.built = '1';
    const fragment = document.createDocumentFragment();
    UNIVERSES.forEach(universe => fragment.appendChild(buildHubCard(universe)));
    grid.appendChild(fragment);

    UNIVERSES.forEach(async universe => {
      try {
        const movies = await fetchUniverseMovies(universe);
        const postersEl = document.getElementById('chPosters-' + universe.slug);
        const countEl = document.getElementById('chCount-' + universe.slug);
        if (countEl) countEl.textContent = movies.length + (movies.length === 1 ? ' Movie' : ' Movies');
        if (postersEl) {
          postersEl.innerHTML = movies.slice(0, 4).map(movie =>
            '<img src="' + IMG + movie.poster_path + '" alt="" loading="lazy">'
          ).join('') || '<div class="ch-card-empty">Coming soon</div>';
        }
      } catch (error) {
        console.warn('[MovieZone] Collections hub failed for', universe.slug, error);
        const countEl = document.getElementById('chCount-' + universe.slug);
        if (countEl) countEl.textContent = 'Unavailable';
      }
    });
  }

  function renderUniverseDetail(universe, movies) {
    const detail = document.getElementById('chDetailView');
    if (!detail) return;

    if (!movies.length) {
      detail.innerHTML = '<div class="ch-detail-empty"><strong>No movies found for this universe yet.</strong><span>Please check back soon.</span></div>';
      return;
    }

    const heroMovie = movies.find(movie => movie.backdrop_path) || movies[0];
    const cards = movies.map((movie, index) => {
      const year = (movie.release_date || '').slice(0, 4) || 'TBA';
      return (
        '<div class="ch-movie-card" data-movie-id="' + movie.id + '" tabindex="0">' +
          '<span class="ch-movie-order">' + (index + 1) + '</span>' +
          '<img src="' + IMG + movie.poster_path + '" alt="' + escapeHTML(movie.title || '') + '" loading="lazy">' +
          '<div class="ch-movie-rating">★ ' + Number(movie.vote_average || 0).toFixed(1) + '</div>' +
          '<div class="ch-movie-info"><h4>' + escapeHTML(movie.title || '') + '</h4><span>' + year + '</span></div>' +
        '</div>'
      );
    }).join('');

    detail.innerHTML =
      '<div class="ch-detail-hero ch-accent-' + universe.accent + '">' +
        (heroMovie.backdrop_path ? '<img src="https://image.tmdb.org/t/p/w1280' + heroMovie.backdrop_path + '" alt="" class="ch-detail-hero-img">' : '') +
        '<div class="ch-detail-hero-gradient"></div>' +
        '<div class="ch-detail-hero-content">' +
          '<span class="ch-card-badge">' + escapeHTML(universe.badge) + '</span>' +
          '<h1>' + escapeHTML(universe.name) + '</h1>' +
          '<p>' + escapeHTML(universe.tagline) + '</p>' +
          '<span class="ch-detail-count">' + movies.length + (movies.length === 1 ? ' Movie · Chronological order' : ' Movies · Chronological order') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="ch-movie-grid">' + cards + '</div>';

    detail.querySelectorAll('.ch-movie-card').forEach(card => {
      card.addEventListener('click', () => openModal(Number(card.dataset.movieId), 'movie'));
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openModal(Number(card.dataset.movieId), 'movie');
        }
      });
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
    if (detail) detail.innerHTML = '<div class="ch-detail-loading"><div class="player-spinner" style="width:46px;height:46px;border-left-color:var(--gold);"></div><p>Loading ' + escapeHTML(universe.name) + '…</p></div>';

    const scroller = document.getElementById('chScroll');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'instant' in Object.getPrototypeOf(scroller.scrollTo || {}) ? 'instant' : 'auto' });

    try {
      const movies = await fetchUniverseMovies(universe);
      if (activeUniverseSlug === slug) renderUniverseDetail(universe, movies);
    } catch (error) {
      console.warn('[MovieZone] Failed to open universe', slug, error);
      if (detail) detail.innerHTML = '<div class="ch-detail-empty"><strong>Could not load this universe.</strong><span>Please try again in a moment.</span></div>';
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

  window.openCollectionsHub = function(event, initialSlug) {
    if (event) event.preventDefault();
    openCollectionsHubOverlay({});
    if (initialSlug) openUniverse(initialSlug);
  };

  function openCollectionsHubOverlay(options) {
    const overlay = document.getElementById('collections-hub-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    renderHubGrid();
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
    if (!(options && options.skipHistory) && window.location.hash.startsWith('#collections')) {
      window.history.back();
    }
  };

  window.handleCollectionsBack = function() {
    const overlay = document.getElementById('collections-hub-overlay');
    if (overlay && overlay.classList.contains('detail-mode')) closeUniverseDetail();
    else window.closeCollectionsHub();
  };

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
    }
  });

  // Deep-link support: opening the site directly on #collections or #collections-<slug>
  if (window.location.hash.startsWith('#collections')) {
    document.addEventListener('DOMContentLoaded', () => {
      const hash = window.location.hash;
      if (hash === '#collections') openCollectionsHubOverlay({ skipHistory: true });
      else {
        const slug = hash.replace('#collections-', '');
        if (getUniverse(slug)) {
          openCollectionsHubOverlay({ skipHistory: true });
          openUniverse(slug, { skipHistory: true });
        }
      }
    });
  }
})();
