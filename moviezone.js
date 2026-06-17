﻿// ✨ Improved Localhost Detection: Includes local IPs (192.168.x.x) often used in testing
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.');
const isTV = /SmartTV|WebOS|Tizen|NetCast|VIDAA|Roku|AppleTV|Android TV|BRAVIA|AFT/i.test(navigator.userAgent);

// ✨ Balanced Performance: Mobil/Tablet ko low-end manein, par Desktops/Laptops (bhale hi touch ho) ko full features dein
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const isLowEnd = (navigator.deviceMemory && navigator.deviceMemory < 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4);
const isTouchOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(pointer: fine)').matches;

// Vercel par frontend + backend ek sath deploy ke liye relative path use karein:
const LIVE_BACKEND_URL = '/api/tmdb';
const BASE = isLocalhost ? 'http://localhost:3000/api/tmdb' : LIVE_BACKEND_URL;
const IMG = 'https://image.tmdb.org/t/p/w342'; // Optimized: w500 is too heavy for thumbnails

// ✨ NETWORK-AWARE IMAGE LOADING
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

// ── TV MODE (Performance) ──
// Smart TV browsers have weak CPUs/GPUs: heavy blur/animation cause visible lag.
// Tag <html> early so CSS can strip expensive effects (backdrop-filter, film grain, Ken Burns, etc.)
// If it's a weak device, mobile, or TV, we force high-performance rendering (removes lag/hangs completely)
if (isTV || (isMobile && isLowEnd)) document.documentElement.classList.add('tv-mode');
 
// ── PERFORMANCE BOOST STYLES ──
const perfStyle = document.createElement('style');
perfStyle.textContent = `
  .movie-card, .upcoming-card { content-visibility: auto; contain-intrinsic-size: 180px 320px; contain: layout style paint; transform: translateZ(0); backface-visibility: hidden; }
  .carousel-slide { will-change: transform, opacity; transform: translateZ(0); }
  img { content-visibility: auto; }
  #movies-section, #upcoming { content-visibility: auto; contain-intrinsic-size: 1000px; }
  .tv-mode * { box-shadow: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
`;
document.head.appendChild(perfStyle);

// ── PREMIUM CURSOR GLOW ──
// Sirf TV aur pure Touch devices (bin mouse wale) par cursor hide karein
if (!isTV && !isTouchOnly) {
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
      // ✨ Super Fast Cursor Speed (0.45 is 2.5x faster than 0.18)
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

  // ── CLICK SPARKS (3D Particles) ──
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

// ── SERVER PRECONNECT (FAST STREAMING) ──
// Background me sabhi servers se pehle se secure connection bana ke rakho jisse fetching instant ho
(function preconnectServers() {
  const servers = ['https://vidsrc.me', 'https://embed.to', 'https://autoembed.co', 'https://vidlink.pro', 'https://vidsrc.pm', 'https://multiembed.mov',];
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

// ── SCROLL REVEAL ANIMATIONS (Intersection Observer) ──
const scrollObserver = new IntersectionObserver((entries, observer) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in-view');
      observer.unobserve(entry.target);
    }
  });
}, { root: null, rootMargin: '0px 0px -40px 0px', threshold: 0.05 });
 
// ── SECURITY HELPER (XSS Protection) ──
const escapeHTML = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
 
// ── GENRE MAP (defined first so carousel HTML can use it)
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
let currentModalMovie = null;
let watchlist = JSON.parse(localStorage.getItem('mz_watchlist') || '[]');
let isFullViewMovies = false;
let isFullViewUpcoming = false;
let currentMoviePage = 1;
let currentUpcomingPage = 1;
let allUpcoming = [];
let lastFocusedElement = null; // TV remote focus memory
 
// ── FETCH helper ── Optimized with aggressive parallel execution
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
  
  // ✨ ZERO-LATENCY SWR (Stale-While-Revalidate) CACHING
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

  // ✨ Unique Abort Strategy
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
      if (e.name === 'AbortError') return null; // Silently handle cancellations
      console.error('Network/Fetch Error:', e);
      return cachedData || { results: [] }; // Fallback to stale cache or empty array
    } finally {
        if (abortControllers.get(urlStr) === controller) abortControllers.delete(urlStr);
    }
  })(); 
  
  inFlightRequests.set(urlStr, fetchPromise);
  fetchPromise.finally(() => inFlightRequests.delete(urlStr));
  
  // ✨ Makhan Speed: Return instantly if we have stale/fresh cache, otherwise wait for network
  if (cachedData && !isFresh) tmdbCache.set(urlStr, cachedData);
  return cachedData ? cachedData : fetchPromise;
}
 
// ── INIT ── Priority-based staggered loading for ultra-fast startup
async function init() {
  // Inject Multi-Language UI styles
  if (!document.getElementById('mz-multilang-css')) {
    const _s = document.createElement('style');
    _s.id = 'mz-multilang-css';
    _s.textContent = `.mz-lang-btn{display:inline-flex!important;align-items:center;gap:5px;background:rgba(255,255,255,0.05)!important;border:1px solid rgba(255,255,255,0.1)!important;color:rgba(255,255,255,0.65)!important;font-size:0.78rem!important;font-weight:600!important;padding:7px 13px!important;border-radius:999px!important;cursor:pointer!important;transition:all .2s ease!important;letter-spacing:.2px!important;position:relative!important}.mz-lang-btn:hover{background:rgba(245,197,24,.12)!important;border-color:rgba(245,197,24,.35)!important;color:#fff!important;transform:translateY(-1px)!important}.mz-lang-btn.active{background:linear-gradient(135deg,#f5c518,#e6a817)!important;border-color:#f5c518!important;color:#000!important;font-weight:800!important;box-shadow:0 4px 18px rgba(245,197,24,.35)!important;transform:translateY(-1px)!important}.mz-lang-btn.mz-lang-avail{border-color:rgba(16,185,129,.3)!important}.mz-lang-btn.mz-lang-avail.active{border-color:#f5c518!important}.mz-avail-dot{display:inline-block;width:6px;height:6px;background:#10b981;border-radius:50%;margin-left:3px;flex-shrink:0;box-shadow:0 0 5px rgba(16,185,129,.5)}.mz-lang-btn.active .mz-avail-dot{background:rgba(0,0,0,.4);box-shadow:none}`;
    document.head.appendChild(_s);
  }
  try {
    // ⚡ Execute everything in parallel for maximum startup speed
    const tasks = [
      loadCarousel(),
      loadMovies('all')
    ];

    await Promise.allSettled(tasks);

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

  // Luxury Ambient Particles (Disabled on mobile/low-end to save battery & stop lag)
  // Jugnu effects ab har Desktop/Laptop aur high-end tablets par chalenge
  if (!isTV && !isLowEnd && !document.querySelector('.ambient-particles')) {
    const pContainer = document.createElement('div');
    pContainer.className = 'ambient-particles';
    document.body.appendChild(pContainer);

    // ✨ Optimized to 20 Fireflies to eliminate lag on mid-tier devices
    for (let i = 0; i < 20; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const size = Math.random() * 3.5 + 1.5; // Size between 1.5px to 5px
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 100 + 'vw';
      p.style.setProperty('--duration', (Math.random() * 18 + 12) + 's'); // Float speed (12s to 30s)
      p.style.setProperty('--drift', (Math.random() * 160 - 80) + 'px'); // Left/Right sway (-80px to 80px)
      p.style.animationDelay = '-' + (Math.random() * 25) + 's'; // Start instantly at different heights

      // Randomly assign gold or accent colors
      if (Math.random() > 0.5) {
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
      pContainer.appendChild(p);
    }
  }
}
 
// ── CAROUSEL
async function loadCarousel() {
  // ✨ Fetch Hollywood + Top Bollywood for a mixed premium carousel
  const [tTrending, tPopular, tBolly] = await Promise.all([
    tmdb('/trending/movie/week', { language: 'en-US', page: '1' }),
    tmdb('/movie/popular', { language: 'en-US', page: '1' }),
    tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', 'vote_average.gte': '6.5', language: 'en-US', page: '1' })
  ]);

  const trending = tTrending.results || [];
  const popular = tPopular.results || [];
  const bolly = (tBolly.results || []).slice(0, 2); // Take top 2 Bollywood movies
  
  const pool = [];
  const maxLen = Math.max(trending.length, popular.length);
  for (let i = 0; i < maxLen; i++) {
    if (trending[i]) pool.push(trending[i]);
    if (popular[i]) pool.push(popular[i]);
  }

  // Inject Bollywood movies at premium positions (2nd and 4th slot)
  if (bolly[0]) pool.splice(1, 0, bolly[0]);
  if (bolly[1]) pool.splice(3, 0, bolly[1]);

  const seen = new Set();
  const realToday = new Date().toISOString().split('T')[0];
  carouselMovies = pool.filter(m => {
    if (!m.backdrop_path || !m.poster_path || seen.has(m.id)) return false;
    // ✨ Block unreleased future movies from Hero Carousel
    const rDate = m.release_date || m.first_air_date;
    if (rDate && rDate > realToday) return false;
    // ✨ Require good rating (>=6.5) AND high popularity (>=150), allow English and Hindi
    if (!['en', 'hi'].includes(m.original_language) || m.vote_average < 6.5 || m.popularity < 150) return false;
    seen.add(m.id); return true;
  }).slice(0, 6);
  buildCarousel(); // Force build even with limited data
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
    const bgUrl = getResponsiveBackdrop(m.backdrop_path);
    
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
        '<div class="slide-badge">TRENDING NOW</div>' +
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
      btn.addEventListener('click', () => { openModal(parseInt(btn.dataset.id), btn.dataset.type); });
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
 
// ── PREMIUM AUTOPLAY PROGRESS BAR ──
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
 
// ── HERO INTERACTIONS — pause-on-hover, swipe, arrow nav (premium UX) ──
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
 
// ── BACKGROUND PREFETCH HELPERS (For Instant "Load More") ──
function prefetchMoviesPage(cat, pageNum) {
  const pageStr = String(pageNum);
  const p1 = String(pageNum * 2 - 1);
  const p2 = String(pageNum * 2);
  if (cat === 'all') {
    tmdb('/trending/movie/week', { language: 'en-US', page: pageStr });
    tmdb('/movie/popular', { language: 'en-US', page: pageStr });
    tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
    tmdb('/movie/now_playing', { language: 'en-US', page: pageStr });
  } else if (cat === 'hollywood') {
    tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p1 });
    tmdb('/discover/movie', { with_original_language: 'en', sort_by: 'popularity.desc', language: 'en-US', page: p2 });
  } else if (cat === 'tv') {
    tmdb('/trending/tv/week', { language: 'en-US', page: pageStr });
    tmdb('/discover/tv', { language: 'en-US', sort_by: 'popularity.desc', page: pageStr });
    tmdb('/discover/tv', { with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' });
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
  } else {
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
 
// ── LOAD MOVIES
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
  
  if (!isLoadMore) {
    currentMoviePage = 1;
    grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
    allMovies = [];
  } else {
    currentMoviePage++;
    const btn = document.getElementById('loadMoreMoviesBtn');
    if (btn) btn.innerHTML = 'Loading...';
  }
 
  let movies = [];
  const pageStr = String(currentMoviePage);
  const p1 = String(currentMoviePage * 2 - 1);
  const p2 = String(currentMoviePage * 2);
  
  try {
    if (cat === 'all') {
      const res = await Promise.allSettled([
        tmdb('/trending/movie/week', { language: 'en-US', page: pageStr }),
        tmdb('/movie/popular',      { language: 'en-US', page: pageStr }),
        tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' })
      ]);
      
      let maxLength = 0;
      res.forEach(r => { if (r.status === 'fulfilled' && r.value.results && r.value.results.length > maxLength) maxLength = r.value.results.length; });
      for (let i = 0; i < maxLength; i++) {
        res.forEach(r => {
          if (r.status === 'fulfilled' && r.value.results && i < r.value.results.length) {
            movies.push(r.value.results[i]);
          }
        });
      }
    } else if (cat === 'tv') {
      const res = await Promise.all([
        tmdb('/trending/tv/week', { language: 'en-US', page: pageStr }),
        tmdb('/discover/tv',      { language: 'en-US', sort_by: 'popularity.desc', page: pageStr }),
        tmdb('/discover/tv', { with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' })
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
 
  const realToday = new Date().toISOString().split('T')[0];
  // ✨ LATEST MOVIES ONLY & BLOCK UPCOMING GLOBALLY
  movies = movies.filter(m => {
    if (!m.poster_path) return false;
    const rDate = m.release_date || m.first_air_date;
    // Agar date future ki hai, toh isko normal list se strict block kar do
    if (rDate && rDate > realToday) return false;
    return true;
  });

  if (!movies.length && !isLoadMore) return;
  
  const existingIds = new Set(allMovies.map(m => m.id));
  const newMovies = movies.filter(m => { if(existingIds.has(m.id)) return false; existingIds.add(m.id); return true; });
  allMovies = allMovies.concat(newMovies);
 
  renderMovies(isLoadMore ? newMovies : (isFullViewMovies ? allMovies : allMovies.slice(0, 24)), isLoadMore);
  
  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) {
    const h = document.getElementById('sectionHeading');
    if (h && h.textContent.includes('MY WATCHLIST')) loadMoreBtn.style.display = 'none';
    else {
      loadMoreBtn.style.display = (isFullViewMovies && newMovies.length > 0) ? 'inline-block' : 'none';
      loadMoreBtn.innerHTML = 'Load More Movies';
    }
  }
 
  // Har load ke baad agle page ko chupke se fetch karke ready rakho
  if (isFullViewMovies && !isTV) {
    setTimeout(() => prefetchMoviesPage(cat, currentMoviePage + 1), 800);
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
    const isHot  = m.popularity > 100;
    
    // ── DYNAMIC QUALITY BADGE LOGIC ──
    let qual = 'HD';
    const rDateStr = m.release_date || m.first_air_date;
    if (rDateStr) {
      const rDate = new Date(rDateStr);
      const daysOld = (new Date() - rDate) / (1000 * 60 * 60 * 24);
      if (type === 'movie' && daysOld >= 0 && daysOld <= 45) {
        qual = 'CAM'; // Recently released movies in theaters are usually CAM/TS
      } else if (m.vote_average >= 7.5) {
        qual = '4K';
      } else if (m.vote_average >= 6.5) {
        qual = 'FHD';
      }
    }
    const card   = document.createElement('div');
    card.className = 'movie-card';
    card.tabIndex = 0;
    // Optimized will-change usage
    card.style.willChange = 'auto'; 
    card.style.animationDelay = ((i % 24) * 0.04) + 's';
    card.innerHTML =
      '<div class="card-poster">' +
        `<img src="${IMG}${m.poster_path}" alt="${escapeHTML(m.title||'')}" width="171" height="256" loading="lazy" decoding="async">` +
        '<div class="card-quality">'+qual+'</div>' +
        (isHot ? '<div class="card-hot">HOT</div>' : '') +
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

    // Premium 3D Tilt Effect on Hover
    if (!isTV) {
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
          // ✨ ENHANCED 3D TILT: More responsive and attractive values
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
  all:'ALL MOVIES & SHOWS', tv: 'TV SHOWS & WEB SERIES', hollywood:'HOLLYWOOD', bollywood:'BOLLYWOOD',
  south:'SOUTH INDIAN', tollywood:'TOLLYWOOD', action:'ACTION',
  comedy:'COMEDY', horror:'HORROR', thriller:'THRILLER', romance:'ROMANCE',
  scifi:'SCI-FI', animation:'ANIMATION', kids:'🧸 KIDS & CARTOONS', anime:'⚔️ ANIME SERIES & MOVIES',
  adult:'🔞 18+ ADULT MOVIES & WEB SERIES'
};
function filterCat(cat, e) {
  if (e) e.preventDefault();
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
 
// ── WATCHLIST LOGIC ──
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
    showToast('🗑️ Watchlist cleared successfully');
    renderMovies(watchlist);
    const h = document.getElementById('sectionHeading');
    if (h) h.innerHTML = 'MY WATCHLIST';
  }
}
 
// ── UPCOMING
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
      const card = document.createElement('div');
      card.className = 'upcoming-card reveal-up';
      card.tabIndex = 0;
        card.style.willChange = 'transform, opacity';
      card.style.animationDelay = ((i % 12) * 0.08) + 's';
      card.innerHTML =
        '<div class="upcoming-poster">' +
            '<img src="'+posterImg+'" alt="'+escapeHTML(m.title||'')+'" width="280" height="157" loading="lazy" decoding="async">' +
          '<div class="upcoming-poster-overlay"></div>' +
          '<div class="upcoming-release-badge">RELEASE '+dateStr+'</div>' +
        '</div>' +
        '<div class="upcoming-info">' +
          '<div class="upcoming-title">'+escapeHTML(m.title||'')+'</div>' +
          '<div class="upcoming-meta">' +
            '<div class="card-rating" style="font-size:0.73rem">RATING '+((m.vote_average||0).toFixed(1))+'</div>' +
            '<div class="card-year" style="font-size:0.71rem">YEAR '+((m.release_date||'').slice(0,4))+'</div>' +
            genres.map(g => '<span class="card-genre">'+escapeHTML(g)+'</span>').join('') +
          '</div>' +
          '<p class="upcoming-desc">'+escapeHTML(m.overview||'')+'</p>' +
        '</div>';
      card.addEventListener('click', () => { openModal(m.id); });
      fragment.appendChild(card);
      scrollObserver.observe(card);

      // Premium 3D Tilt Effect for Upcoming Cards
      if (!isTV) {
        let tiltRAF;
        let cachedRect = null;
        card.addEventListener('mouseenter', () => { 
          card.style.transition = 'transform 0.15s ease-out'; 
          cachedRect = card.getBoundingClientRect();
        });
        card.addEventListener('mousemove', (e) => {
          if (tiltRAF) cancelAnimationFrame(tiltRAF);
          tiltRAF = requestAnimationFrame(() => {
            if (!cachedRect) cachedRect = card.getBoundingClientRect();
            const rect = cachedRect;
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const rotateX = ((y - (rect.height / 2)) / (rect.height / 2)) * -8;
            const rotateY = ((x - (rect.width / 2)) / (rect.width / 2)) * 8;
            card.style.transform = `perspective(1000px) translateY(-6px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
          });
        });
        card.addEventListener('mouseleave', () => {
          if (tiltRAF) cancelAnimationFrame(tiltRAF);
          card.style.transition = 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
          card.style.transform = '';
          cachedRect = null;
        });
        card.addEventListener('wheel', () => cachedRect = null, {passive: true});
      }
    });
    grid.appendChild(fragment);
    
    const loadMoreBtn = document.getElementById('loadMoreUpcomingBtn');
    if (loadMoreBtn) {
      loadMoreBtn.style.display = (isFullViewUpcoming && newMovies.length > 0) ? 'inline-block' : 'none';
      loadMoreBtn.innerHTML = 'Load More Upcoming';
    }
  } catch(e) { console.warn(e); }
 
  // Har load ke baad agle upcoming page ko chupke se fetch karke ready rakho
  if (isFullViewUpcoming && !isTV) {
    setTimeout(() => prefetchUpcomingPage(currentUpcomingPage + 1), 800);
  }
}
 
// SEARCH
let searchTimer = null;
const searchInput = document.getElementById('searchInput');
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (!q) { closeDropdown(); return; }
    searchTimer = setTimeout(() => { searchDropdownFill(q); }, 380);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (q) searchAndDisplay(q);
      closeDropdown();
    }
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.nav-search')) closeDropdown();
});
 
async function searchDropdownFill(q) {
  const data = await tmdb('/search/multi', { query: q, language: 'en-US', page: '1' });
  const realToday = new Date().toISOString().split('T')[0];
  const movies = (data.results||[]).filter(m => {
    if (m.media_type === 'person') return false;
    const rDate = m.release_date || m.first_air_date;
    if (rDate && rDate > realToday) return false; // Block upcoming from search dropdown
    return true;
  }).slice(0, 6);
  const dd = document.getElementById('searchDropdown');
  if (!dd) return;
  if (!movies.length) {
    dd.innerHTML = '<div class="search-result-item"><div class="search-result-info"><h4>No results</h4></div></div>';
    dd.classList.add('open'); return;
  }
  dd.innerHTML = '';
  movies.forEach(m => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.tabIndex = 0;
    item.innerHTML =
      '<img src="'+(m.poster_path ? IMG+m.poster_path : 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2242%22 height=%2260%22><rect width=%2242%22 height=%2260%22 fill=%22%23222%22/></svg>')+'" alt="" width="42" height="60" loading="lazy" decoding="async">' +
      '<div class="search-result-info"><h4>'+escapeHTML(m.title||m.name||'')+'</h4><p>'+((m.release_date||m.first_air_date||'').slice(0,4))+' | RATING '+((m.vote_average||0).toFixed(1))+'</p></div>';
    item.addEventListener('click', () => { openModal(m.id, m.media_type || (m.name ? 'tv' : 'movie')); closeDropdown(); });
    dd.appendChild(item);
  });
  dd.classList.add('open');
}
 
async function searchAndDisplay(q) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;
  grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  const h = document.getElementById('sectionHeading');
  if (h) h.textContent = 'RESULTS FOR "' + escapeHTML(q.toUpperCase()) + '"';
  const sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: 'smooth' });
  const data = await tmdb('/search/multi', { query: q, language: 'en-US', page: '1', include_adult: 'false' });
  const realToday = new Date().toISOString().split('T')[0];
  const movies = (data.results||[]).filter(m => {
    if (!m.poster_path || m.media_type === 'person') return false;
    const rDate = m.release_date || m.first_air_date;
    if (rDate && rDate > realToday) return false; // Block upcoming from search results
    return true;
  });
  allMovies = movies;
  renderMovies(movies);
  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = 'none';
}
 
function closeDropdown() {
  const dd = document.getElementById('searchDropdown');
  if (dd) dd.classList.remove('open');
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
    const details = await tmdb('/'+type+'/'+id, { language: 'en-US', append_to_response: 'videos' });
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
    if (imageWrapper && !isTV) {
      let tc = document.getElementById('trailerContainer');
      if (tc) tc.remove();
      if (bestVids.length > 0) {
        let currentVidIdx = 0;
        let trailerKey = bestVids[currentVidIdx].key;
 
        tc = document.createElement('div');
        tc.id = 'trailerContainer';
        tc.style.cssText = 'position:absolute; inset:0; z-index:2; display:none; background:#000; transition:opacity 0.4s ease; opacity:0; overflow:hidden;';
        imageWrapper.appendChild(tc);
 
        let trailerTimeout;
        let ytErrHandler = null;
        imageWrapper.onmouseenter = () => {
          trailerTimeout = setTimeout(() => {
            tc.style.display = 'block';
            setTimeout(() => { tc.style.opacity = '1'; }, 50);
 
            // Helper function to build bulletproof YouTube URLs
            const getYTUrl = (key) => `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&loop=1&playlist=${key}&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`;
 
            // enablejsapi=1 joda gaya hai taaki postMessage se mute/unmute control ho sake
            tc.innerHTML = `
              <div id="trailerLoader" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; z-index:5; background:rgba(0,0,0,0.6); transition:opacity 0.4s ease; backdrop-filter:blur(4px);">
                <div class="player-spinner" style="width:36px; height:36px; border-width:3px;"></div>
              </div>
              <iframe id="ytHoverPlayer" src="${getYTUrl(trailerKey)}" style="width:100%; height:100%; border:none; transform:scale(1.3); pointer-events:none; opacity:0; transition:opacity 0.5s ease;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
              <button id="trailerMuteBtn" style="position:absolute; bottom:20px; right:20px; z-index:10; background:rgba(0,0,0,0.6); color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:50%; width:44px; height:44px; cursor:pointer; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px); transition:all 0.3s ease; box-shadow: 0 4px 12px rgba(0,0,0,0.4);">
                <svg id="iconMuted" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                <svg id="iconUnmuted" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" style="display:none;"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
              </button>
            `;
 
            const ytFrame = tc.querySelector('#ytHoverPlayer');
            const ytLoader = tc.querySelector('#trailerLoader');
 
            // Iframe load hone par backup loader hide logic (kyunki API hamesha message nahi bhejti)
            if (ytFrame) {
              ytFrame.onload = () => {
                setTimeout(() => {
                  if (ytLoader) { ytLoader.style.opacity = '0'; setTimeout(() => { if (ytLoader.parentNode) ytLoader.remove(); }, 400); }
                  if (ytFrame) ytFrame.style.opacity = '1';
                }, 800); // Thoda delay taaki buffer hoke autoplay shuru ho jaye
              };
            }
 
            // Multi-Trailer Fallback: Agar ek video block ho jaye (Error 150/153), to agla video automatically chalaye
            ytErrHandler = (e) => {
              try {
                if (e.origin && !e.origin.includes('youtube')) return;
                let d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
                if (!d) return;
 
                // Success! Video started playing (info === 1 means playing)
                if ((d.event === 'onStateChange' && d.info === 1) || (d.event === 'infoDelivery' && d.info && d.info.playerState === 1)) {
                  if (ytLoader) { ytLoader.style.opacity = '0'; setTimeout(() => { if (ytLoader.parentNode) ytLoader.remove(); }, 400); }
                  if (ytFrame) ytFrame.style.opacity = '1';
                }
 
                // Error! Blocked by owner (150, 153, 101)
                if (d.event === 'onError' || d.event === 'error' || d.info === 150 || d.info === 153 || d.info === 101 || (d.info && d.info.playerState === -1 && d.info.videoData && d.info.videoData.errorCode)) {
                  currentVidIdx++;
                  if (currentVidIdx < bestVids.length) {
                    if (ytFrame) {
                      ytFrame.style.opacity = '0'; // Puraana error wala frame chhipa do
                      ytFrame.src = getYTUrl(bestVids[currentVidIdx].key);
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
              e.stopPropagation(); // Background clicks ko prevent karne ke liye
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
          }, 600); // 600ms hover delay so it doesn't accidentally trigger while moving mouse
        };
        imageWrapper.onmouseleave = () => {
          clearTimeout(trailerTimeout);
          if (ytErrHandler) window.removeEventListener('message', ytErrHandler);
          tc.style.opacity = '0';
          setTimeout(() => { tc.style.display = 'none'; tc.innerHTML = ''; }, 400);
        };
      } else {
        imageWrapper.onmouseenter = null;
        imageWrapper.onmouseleave = null;
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
      ? '<div class="card-year" style="font-size:0.85rem; background: linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05)); border-color: rgba(16,185,129,0.3); color: #10b981;" title="Available in Hindi/Regional Languages">🎤 DUBBED AVAILABLE</div>'
      : '<div class="card-year" style="font-size:0.85rem; background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02)); border-color: rgba(255,255,255,0.15); color: #bbb;" title="Only Original Audio Available">🎤 ORIGINAL AUDIO</div>';

    const metaEl  = document.getElementById('modalMeta');
    if (metaEl) metaEl.innerHTML =
      '<div class="card-rating" style="font-size:0.9rem">RATING '+((details.vote_average||0).toFixed(1))+' ('+(details.vote_count||0).toLocaleString()+')</div>' +
      '<div class="card-year" style="font-size:0.85rem">YEAR '+((details.release_date||details.first_air_date||'').slice(0,4))+'</div>' +
      '<div class="card-runtime" style="font-size:0.85rem">RUNTIME '+runtime+'</div>' + audioBadge + genres;
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
          // ── CONTINUE WATCHING LOGIC ──
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
          
          sInput.onchange = (e) => fetchEpisodes(e.target.value, 1); // Season change होने पर Episode 1
          
          fetchEpisodes(lastS, lastE); // लास्ट सेव किया हुआ या पहला एपिसोड लोड करें
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
 
// ── RELATED MOVIES LOGIC ──
async function loadRelatedMovies(id, type) {
  const section = document.getElementById('relatedMoviesSection');
  const grid = document.getElementById('relatedMoviesGrid');
  if (!section || !grid) return;
 
  section.style.display = 'block';
  grid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
 
  try {
    // Pehle advance recommendations check karenge, varna similar movies
    const res = await tmdb('/' + type + '/' + id + '/recommendations', { language: 'en-US', page: '1' });
    let movies = res.results || [];
    if (movies.length === 0) {
      const fallback = await tmdb('/' + type + '/' + id + '/similar', { language: 'en-US', page: '1' });
      movies = fallback.results || [];
    }
 
    const realToday = new Date().toISOString().split('T')[0];
    movies = movies.filter(m => {
      if (!m.poster_path) return false;
      const rDate = m.release_date || m.first_air_date;
      if (rDate && rDate > realToday) return false; // Block upcoming from related movies
      return true;
    }).slice(0, 12); // Top 12 similar items
 
    if (movies.length > 0) {
      grid.innerHTML = '';
      const fragment = document.createDocumentFragment();
      movies.forEach((m, i) => {
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
            '<img src="'+IMG+m.poster_path+'" alt="'+escapeHTML(m.title||m.name||'')+'" width="200" height="300" loading="lazy" decoding="async">' +
            '<div class="card-quality">'+qual+'</div>' +
            (isHot ? '<div class="card-hot">HOT</div>' : '') +
            '<div class="card-overlay"><button class="card-play-btn">&#9654;</button></div>' +
          '</div>' +
          '<div class="card-info">' +
            '<div class="card-title">'+escapeHTML(m.title||m.name||'')+'</div>' +
            '<div class="card-meta"><div class="card-rating">RATING '+rating+'</div><div class="card-year">YEAR '+year+'</div></div>' +
            '<div class="card-meta"><div class="card-runtime">LANG '+(m.original_language||'EN').toUpperCase()+'</div></div>' +
            '<div class="card-genres">'+genres.map(g => '<span class="card-genre">'+escapeHTML(g)+'</span>').join('')+'</div>' +
          '</div>';
        card.addEventListener('click', () => { openModal(m.id, rType); });
        fragment.appendChild(card);
        scrollObserver.observe(card);
      });
      grid.appendChild(fragment);
    } else {
      section.style.display = 'none';
    }
  } catch(e) { section.style.display = 'none'; }
}
 
// ── PLAYER SOURCES — Multi-Language Audio Supported ──
// Server 0 (Multi-Audio) genuinely supports Hindi/Tamil/Telugu dubbed audio tracks
const playerSources = [
  { name: '🌐 Multi-Audio', url: (id, lang, type, s, e) => {
    // BEST FOR DUBBED: multiembed.mov genuinely serves Hindi/Tamil/Telugu dubbed audio
    const base = type === 'tv'
      ? `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`
      : `https://multiembed.mov/?video_id=${id}&tmdb=1`;
    
    const audioMap = { hi: 'hindi', ta: 'tamil', te: 'telugu', ml: 'malayalam', kn: 'kannada', mr: 'marathi', bn: 'bengali' };
    const prefAudio = audioMap[lang] || lang;
    return base + (lang && lang !== 'en' ? `&preferred_audio=${prefAudio}&lang=${lang}` : '');
  }},
  { name: '⚡ Ultra HD', url: (id, lang, type, s, e) => {
    // India ke networks par blockage kam aati hai
    return (type === 'tv' ? `https://autoembed.co/tv/tmdb/${id}-${s}-${e}` : 'https://autoembed.co/movie/tmdb/' + id) + `?lang=${lang}`;
  }},
  { name: '🔥 Pro Stream', url: (id, lang, type, s, e) => {
    // Interface bahut saaf hai aur player ke andar settings
    return (type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : 'https://vidlink.pro/movie/' + id) + `?lang=${lang}`;
  }},
 { name: '👑 Vidsrc VIP', url: (id, lang, type, s, e) => {
    // Vidsrc primary root network (me) using direct TMDB mapping to fix 'Unavailable' database error
    return (type === 'tv' ? `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc.me/embed/movie?tmdb=${id}`) + `&lang=${lang}`;
  }},
  { name: '💎 Premium Mirror', url: (id, lang, type, s, e) => {
    // Official proxy mirror to fix 'refused to connect' / iframe block issue
    return (type === 'tv' ? `https://vidsrc.pm/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc.pm/embed/movie?tmdb=${id}`) + `&lang=${lang}`;
  }},
  // { name: '🇮🇳 Hindi MAX', url: (id, lang, type, s, e) => {
  //   // Switched to embed.su (Highly stable, no blank screen issues, fast loading)
  //   return type === 'tv' ? `https://embed.cc/embed/tv/${id}/${s}/${e}` : `https://embed.cc/embed/movie/${id}`;
  // }},


];
let currentSourceIdx = 0;
let isPlayerFullscreen = false;
 
// ── LANGUAGE CONFIG (for quick-buttons) ──
const LANG_CONFIG = {
  hi: { flag: '🇮🇳', name: 'Hindi',      code: 'hi' },
  en: { flag: '🇬🇧', name: 'English',    code: 'en' },
  ta: { flag: '🎬',  name: 'Tamil',      code: 'ta' },
  te: { flag: '🎭',  name: 'Telugu',     code: 'te' },
  ml: { flag: '🌴',  name: 'Malayalam',  code: 'ml' },
  kn: { flag: '🟣',  name: 'Kannada',    code: 'kn' },
  mr: { flag: '🟠',  name: 'Marathi',    code: 'mr' },
  bn: { flag: '🟡',  name: 'Bengali',    code: 'bn' },
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
    return `<button class="player-chip mz-lang-btn${isActive?' active':''}${isAvail?' mz-lang-avail':''}" data-lang="${code}" title="${isAvail?'✅ Dubbed available on TMDB':'Subtitles if dub unavailable'}"><span>${cfg.flag}</span> ${cfg.name}${isAvail?'<span class="mz-avail-dot"></span>':''}</button>`;
  }).join('');

  const section = document.createElement('div');
  section.id = 'mz-lang-section';
  section.style.cssText = 'margin-top:14px; border-top:1px solid rgba(255,255,255,0.08); padding-top:12px;';
  section.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
      <span style="font-size:0.7rem;font-weight:800;letter-spacing:1.8px;color:rgba(255,255,255,0.35);text-transform:uppercase;">🎵 Audio Language</span>
      <span style="font-size:0.68rem;color:#10b981;background:rgba(16,185,129,0.1);padding:2px 9px;border-radius:999px;border:1px solid rgba(16,185,129,0.2);">🟢 = Dubbed available</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:7px;">${btnsHtml}</div>
    <div style="margin-top:10px;font-size:0.7rem;color:rgba(255,255,255,0.3);line-height:1.5;">💡 Hindi/Tamil/Telugu select karne par <b style="color:rgba(255,255,255,0.45);">🌐 Multi-Audio server auto-switch</b> hoga — yahi best dubbed support deta hai.</div>
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
      showToast(`🎵 ${cfg.flag||''} ${cfg.name||lang} Audio${DUBBED_LANGS.includes(lang)?' | 🌐 Multi-Audio activated':''}`);
    });
  });
}

function renderExternalSources(id, srcIdx, lang) {
  const ext = document.getElementById('externalSources');
  if (!ext) return;

  const serverBtnsHtml = playerSources.map((s, i) =>
    '<button class="player-chip player-chip--source" data-srcidx="'+i+'">'+escapeHTML(s.name)+'</button>'
  ).join('');
  ext.innerHTML =
    '<div style="font-size:0.7rem;font-weight:800;letter-spacing:1.8px;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:8px;">📡 Playback Server</div>' +
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
  return select ? select.value : (localStorage.getItem('moviezone.playerLang') || 'en');
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
    showToast(`⏭️ Playing Season ${currentS} Episode ${currentE + 1}`);
  } else {
    const seasons = (currentModalMovie.seasons || []).filter(s => s.season_number > 0);
    const nextSeason = seasons.find(s => s.season_number === currentS + 1);
    if (nextSeason) {
      sInput.value = currentS + 1;
      sInput.dispatchEvent(new Event('change'));
      showToast(`⏭️ Playing Season ${currentS + 1} Episode 1`);
    } else {
      showToast("🏆 You have reached the latest episode!");
    }
  }
}
 
function loadPlayer(id, srcIdx, lang, quality, type = 'movie') {
  const embedEl = document.getElementById('videoEmbed');
  if (!embedEl) return;
  currentSourceIdx = srcIdx;
  setSelectedSourceIdx(srcIdx);
  lang = lang || getSelectedLang();
  setSelectedLang(lang);
  quality = quality || getSelectedQuality();
  setSelectedQuality(quality);
  
  const sInput = document.getElementById('seasonInput');
  const eInput = document.getElementById('episodeInput');
  const s = sInput ? sInput.value : '1';
  const e = eInput ? eInput.value : '1';
  const src = playerSources[srcIdx].url(id, lang, type, s, e);
 
  // ── AUTO-SAVE TV PROGRESS (Continue Watching) ──
  if (type === 'tv') {
    localStorage.setItem('mz_progress_' + id, JSON.stringify({ season: parseInt(s), episode: parseInt(e) }));
  }

  embedEl.innerHTML = '';
 
  // Custom Loading Spinner add karo
  const loader = document.createElement('div');
  loader.className = 'player-loader';
  loader.innerHTML = '<div class="player-spinner"></div><div style="color:var(--gold); margin-top:15px; font-weight:600; font-size:0.9rem; text-shadow:0 2px 4px rgba(0,0,0,0.5);">Optimizing stream & buffering...</div>';
  embedEl.appendChild(loader);
 
  const iframe = document.createElement('iframe');
  iframe.id = 'playerFrame';
  iframe.src = src;
  iframe.style.cssText = 'width: 100%; height: 100%; border: none; overflow: hidden !important; background: transparent; position: relative; z-index: 1; transform: translateZ(0); will-change: transform;';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allow', 'fullscreen;autoplay;encrypted-media;picture-in-picture');
  
  // Master Server Bypass: Apply specific rules for Multi-Audio to prevent Vercel block / Refused to connect
  if (playerSources[srcIdx].name.includes('Multi-Audio')) {
    iframe.setAttribute('referrerpolicy', 'no-referrer');
  } else {
    iframe.setAttribute('referrerpolicy', 'origin'); // Defaults for other servers
  }

  iframe.setAttribute('fetchpriority', 'high'); // 🚀 Browser ko strict command for maximum loading speed
  iframe.setAttribute('loading', 'eager'); // ⚡ Instant fetch (no lazy loading)
  // Iframe load hone ke baad spinner hide kar do
  iframe.onload = () => {
    loader.style.opacity = '0';
    setTimeout(() => { if (loader && loader.parentNode) loader.remove(); }, 400);
  };
 
  embedEl.appendChild(iframe);
 
  let controlsHtml = '<div id="playerControls" class="player-controls">';
  if (type === 'tv') {
    controlsHtml += '<button onclick="playNextEpisode()" class="player-chip premium-play-btn" style="padding:0 14px; border-radius:999px; min-height:42px; border:none; display:inline-flex; align-items:center; gap:6px;">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>' +
        '<span style="font-size:13px; font-weight:800; letter-spacing:0.3px;">Next Ep</span>' +
      '</button>';
  }
  controlsHtml += '<button onclick="togglePlayerFS()" class="player-chip player-chip--fs" id="fsBtn">' +
        '<svg class="player-chip__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
          '<path d="M7 3H3v4h2V5h2V3zm10 0v2h2v2h2V3h-4zM5 17H3v4h4v-2H5v-2zm16 0h-2v2h-2v2h4v-4z"></path>' +
        '</svg>' +
        '<span>Fullscreen</span>' +
      '</button>' +
    '</div>';
 
  const existingControls = document.getElementById('playerControls');
  if (existingControls) {
    existingControls.outerHTML = controlsHtml;
  } else {
    embedEl.insertAdjacentHTML('afterend', controlsHtml);
  }
 
  try { renderExternalSources(id, srcIdx, lang); } catch(e){}
 
  const _toastLangName = (LANG_CONFIG[lang] && LANG_CONFIG[lang].name) || lang.toUpperCase();
  showToast('▶ ' + buildSourceLabel(srcIdx) + ' | 🎵 ' + _toastLangName + ' | ' + quality.toUpperCase() + (type === 'tv' ? ` | S${s} E${e}` : ''));
 
  // Server/Play par click karne pe smooth scroll karke video player area me chala jayega
  setTimeout(() => {
    embedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 300);
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
  const isTV = currentModalMovie.media_type === 'tv';
  
  // Get download button reference
  const dlBtn = document.querySelector('.btn-download');
  let originalBtnHtml = '';
  if (dlBtn) {
    originalBtnHtml = dlBtn.innerHTML;
    // Button me same spinner aur "Searching..." text show karo
    dlBtn.innerHTML = '<div class="player-spinner" style="width:18px; height:18px; border-width:2px; border-color:rgba(16,185,129,0.2); border-left-color:#10b981;"></div><span style="color:#10b981;">Searching...</span>';
    dlBtn.style.pointerEvents = 'none';
    dlBtn.style.borderColor = '#10b981';
  }
 
  // Remove existing modal if any
  const existingModal = document.getElementById('dlModal');
  if (existingModal) existingModal.remove();
 
  // 2. Fetch Torrents directly from YTS API
  let torrentsHtml = '';
  try {
    if (!isTV) {
      // Agar IMDB id hai to usse search karein, warna movie ke title se
      const query = currentModalMovie.imdb_id || title;
      let ytsData = null;
      let fetchSuccess = false;
      
      // ISP Block Bypass: Multiple YTS Mirrors check karega
      const mirrors = ['https://yts.mx', 'https://yts.rs', 'https://yts.do', 'https://yify.is'];
      
      for (const mirror of mirrors) {
        try {
          const ytsRes = await fetch(mirror + '/api/v2/list_movies.json?query_term=' + encodeURIComponent(query));
          if (ytsRes.ok) {
            ytsData = await ytsRes.json();
            fetchSuccess = true;
            break; // Success milte hi loop rok do
          }
        } catch(e) { console.warn("Mirror blocked or failed:", mirror); }
      }
      
      if (!fetchSuccess) throw new Error("All Torrent mirrors blocked by ISP.");
      
      if (ytsData && ytsData.data && ytsData.data.movies && ytsData.data.movies.length > 0) {
        const movie = ytsData.data.movies[0];
        if (movie.torrents && movie.torrents.length > 0) {
          torrentsHtml = movie.torrents.map(t => {
            // Create Magnet URI
            const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80`;
            return `
              <a href="${magnet}" class="premium-play-btn" style="text-decoration:none; justify-content:space-between; background:linear-gradient(135deg, rgba(30,30,42,0.8), rgba(15,15,20,0.9)); border:1px solid rgba(255,255,255,0.1); border-left:4px solid var(--gold); margin-bottom:8px;">
                <span style="display:flex; align-items:center; gap:10px;">
                  <span style="font-size:1.2rem;">🧲</span>
                  <strong style="color:#fff; font-size:1rem;">${t.quality} ${t.type.toUpperCase()}</strong>
                </span>
                <span style="font-size:0.85rem; color:var(--text2); background:rgba(0,0,0,0.5); padding:3px 8px; border-radius:6px;">${t.size}</span>
              </a>
            `;
          }).join('');
        }
      }
    }
 
    if (!torrentsHtml) {
      torrentsHtml = `
        <div style="padding:15px; background:rgba(230,57,70,0.1); border:1px solid rgba(230,57,70,0.2); border-radius:10px; color:var(--text); font-size:0.9rem;">
          No direct torrents found for <strong>${escapeHTML(title)}</strong>.<br>
          <span style="font-size:0.8rem; color:var(--text3); display:block; margin-top:5px;">(TV Shows, Regional movies, or newly released CAM prints might not have open magnet links available).</span>
        </div>
      `;
    }
  } catch(err) {
    torrentsHtml = `
      <div style="padding:15px; background:rgba(230,57,70,0.1); border:1px solid rgba(230,57,70,0.2); border-radius:10px; color:var(--text); font-size:0.9rem;">
        Error connecting to Torrent network. Your ISP might be blocking it.<br>
        <a href="https://1337x.to/search/${encodeURIComponent(title)}/1/" target="_blank" style="color:var(--gold); font-weight:bold; display:inline-block; margin-top:8px; text-decoration:none;">👉 Click here to search manually</a>
      </div>
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
        <h3 style="margin-bottom:0.5rem; font-family:'Bebas Neue', sans-serif; font-size:2.2rem; color:#fff; letter-spacing:1px;">Available Torrents</h3>
        <p style="font-size:0.85rem; color:var(--text2); margin-bottom:1.5rem; line-height:1.5;">Make sure you have a Torrent client installed (e.g., uTorrent, BitTorrent, Flud) before clicking.</p>
        <div style="display:flex; flex-direction:column; max-height:280px; overflow-y:auto; padding-right:5px; text-align:left;">
          ${torrentsHtml}
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
 
// ── ANTI-REDIRECT (FRAME-BUSTING BLOCKER) WITHOUT SANDBOX ──
// यह कोड मोबाइल या छोटी स्क्रीन पर थर्ड-पार्टी सर्वर्स के ऑटो-रीडायरेक्ट को रोकेगा
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
  
  // ── DYNAMICALLY ADD KIDS TAB ──
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
      
      // ── DYNAMICALLY ADD 18+ ADULT TAB ──
      if (catTabs && !document.querySelector('.cat-tab[onclick*="adult"]')) {
        const adultTab = document.createElement('button');
        adultTab.className = 'cat-tab';
        adultTab.tabIndex = 0;
        adultTab.setAttribute('onclick', "filterCat('adult')");
        adultTab.innerHTML = '🔞 18+';
        catTabs.appendChild(adultTab);
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
 
const hamburgerBtn = document.getElementById('hamburgerBtn');
const mobileNavOverlay = document.getElementById('mobileNavOverlay');
if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', () => {
    const navLinks = document.querySelector('.nav-links');
    navLinks.classList.toggle('open');
    hamburgerBtn.classList.toggle('open');
    if (mobileNavOverlay) mobileNavOverlay.classList.toggle('open');
    hamburgerBtn.setAttribute('aria-expanded', navLinks.classList.contains('open') ? 'true' : 'false');
    document.body.style.overflow = navLinks.classList.contains('open') ? 'hidden' : '';
  });
}
document.querySelectorAll('.nav-links a').forEach(link => {
  link.addEventListener('click', () => {
    const navLinks = document.querySelector('.nav-links');
    navLinks.classList.remove('open');
    if (hamburgerBtn) {
      hamburgerBtn.classList.remove('open');
      hamburgerBtn.setAttribute('aria-expanded', 'false');
    }
    if (mobileNavOverlay) mobileNavOverlay.classList.remove('open');
    document.body.style.overflow = '';
  });
});

if (mobileNavOverlay) {
  mobileNavOverlay.addEventListener('click', () => {
    const navLinks = document.querySelector('.nav-links');
    navLinks.classList.remove('open');
    if (hamburgerBtn) {
      hamburgerBtn.classList.remove('open');
      hamburgerBtn.setAttribute('aria-expanded', 'false');
    }
    mobileNavOverlay.classList.remove('open');
    document.body.style.overflow = '';
  });
}
 
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); }, 3000);
}
 
// ── TV REMOTE NAVIGATION ──
document.addEventListener('keydown', (e) => {
  // TV Enter/OK key: Simulate click on custom focusable elements (cards, tabs, etc.)
  if ((e.key === 'Enter' || e.key === ' ') && document.activeElement) {
    const tag = document.activeElement.tagName;
    if (tag !== 'BUTTON' && tag !== 'A' && tag !== 'INPUT') {
      document.activeElement.click();
      e.preventDefault();
    }
  }
  
  // Smart TV dedicated Hardware Play/Pause remote button
  if (e.key === 'MediaPlayPause' || e.key === 'MediaPlay' || e.keyCode === 179 || e.keyCode === 415) {
    const playBtn = document.querySelector('.play-big') || document.querySelector('.premium-play-btn');
    if (playBtn) { playBtn.click(); e.preventDefault(); }
  }

  // TV Back keys: Android (Escape/Backspace), WebOS (461), Tizen (10009)
  const isBackKey = e.key === 'Escape' || e.keyCode === 27 || e.keyCode === 10009 || e.keyCode === 461 || (e.key === 'Backspace' && document.activeElement.tagName !== 'INPUT');
  
  if (isBackKey) {
    const overlay = document.getElementById('modal-overlay');
    if (overlay && overlay.classList.contains('open')) {
      closeModal();
      e.preventDefault();
    } else {
      const dd = document.getElementById('searchDropdown');
      if (dd && dd.classList.contains('open')) { closeDropdown(); e.preventDefault(); }
    }
  }
});

// Auto-Scroll into center for TV spatial navigation (Prevents focus moving off-screen)
if (isTV) {
  document.addEventListener('focus', (e) => {
    const overlay = document.getElementById('modal-overlay');
    // Sirf main page items ke liye auto-center karein (modal me default theek rehta hai)
    if (e.target && e.target.scrollIntoView && (!overlay || !overlay.classList.contains('open'))) {
      e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, true);
}
 
// ── PAGE NAVIGATION (SPA) ──
function viewAllMovies(e) {
  if (e) e.preventDefault();
  isFullViewMovies = true;
  const hero = document.getElementById('hero');
  const upcoming = document.getElementById('upcoming');
  const sep = document.querySelector('.section-sep');
  if (hero) hero.style.display = 'none';
  if (upcoming) upcoming.style.display = 'none';
  if (sep) sep.style.display = 'none';
  
  const btn = document.querySelector('#movies-section .see-all');
  if (btn) {
    btn.innerHTML = '&lt;- Back Home';
    btn.onclick = goHome;
  }
  
  const h = document.getElementById('sectionHeading');
  if (h && h.textContent.includes('MY WATCHLIST')) {
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
 
function viewAllUpcoming(e) {
  if (e) e.preventDefault();
  isFullViewUpcoming = true;
  const hero = document.getElementById('hero');
  const moviesSec = document.getElementById('movies-section');
  const sep = document.querySelector('.section-sep');
  if (hero) hero.style.display = 'none';
  if (moviesSec) moviesSec.style.display = 'none';
  if (sep) sep.style.display = 'none';
  
  const btn = document.querySelector('#upcoming .see-all');
  if (btn) {
    btn.innerHTML = '&lt;- Back Home';
    btn.onclick = goHome;
  }
  
  loadUpcoming();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  
  const hero = document.getElementById('hero');
  const moviesSec = document.getElementById('movies-section');
  const upcoming = document.getElementById('upcoming');
  const sep = document.querySelector('.section-sep');
  if (hero) hero.style.display = 'block';
  if (moviesSec) moviesSec.style.display = 'block';
  if (upcoming) upcoming.style.display = 'block';
  if (sep) sep.style.display = 'block';
  
  const mBtn = document.querySelector('#movies-section .see-all');
  if (mBtn) { mBtn.innerHTML = 'Browse All -&gt;'; mBtn.onclick = viewAllMovies; }
  
  const uBtn = document.querySelector('#upcoming .see-all');
  if (uBtn) { uBtn.innerHTML = 'View Calendar -&gt;'; uBtn.onclick = viewAllUpcoming; }
  
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
 

// ── ADVANCED SECURITY (Block View Source & Shortcuts) ──
(function secureWebsite() {
  // 1. Disable Right Click (Context Menu)
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showToast('Right-click is disabled for security.');
  });

  // 2. Disable Keyboard Shortcuts (F12, Ctrl+U, Ctrl+Shift+I, etc.)
  document.addEventListener('keydown', (e) => {
    // Block F12
    if (e.key === 'F12' || e.keyCode === 123) {
      e.preventDefault();
      return false;
    }
    
    if (e.ctrlKey) {
      // Block Ctrl+U (View Source), Ctrl+S (Save), Ctrl+P (Print)
      if (e.key.toLowerCase() === 'u' || e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'p') {
        e.preventDefault();
        return false;
      }
      // Block Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
      if (e.shiftKey && (e.key.toLowerCase() === 'i' || e.key.toLowerCase() === 'j' || e.key.toLowerCase() === 'c')) {
        e.preventDefault();
        return false;
      }
    }
  });
  
  // 3. Disable Dragging of Images/Links
  document.addEventListener('dragstart', (e) => {
    if (e.target.tagName === 'IMG' || e.target.tagName === 'A') e.preventDefault();
  });
})();


// ── AD-BLOCKER DETECTION ──
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


// ── TOP KEYWORDS EXTRACTOR ──
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

// ── BOT DETECTION (WebGL Renderer Check) ──
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

init();