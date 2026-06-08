﻿const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const isTV = /SmartTV|WebOS|Tizen|NetCast|VIDAA|Roku|AppleTV|Android TV|BRAVIA|AFT/i.test(navigator.userAgent);
// Vercel par frontend + backend ek sath deploy ke liye relative path use karein:
const LIVE_BACKEND_URL = '/api/tmdb';
const BASE = isLocalhost ? 'http://localhost:3000/api/tmdb' : LIVE_BACKEND_URL;
const IMG = 'https://image.tmdb.org/t/p/w500';
const IMG_ORIG = 'https://image.tmdb.org/t/p/original';

// ── SERVER PRECONNECT (FAST STREAMING) ──
// Background me sabhi servers se pehle se secure connection bana ke rakho jisse fetching instant ho
(function preconnectServers() {
  const servers = ['https://vidsrc.to', 'https://autoembed.co', 'https://vidlink.pro', 'https://vidsrc.pm'];
  servers.forEach(url => {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = url;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  });
})();

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

// ── FETCH helper ── Ultra-fast caching with Persistent LocalStorage
const tmdbCache = new Map();
const inFlightRequests = new Map(); // Request deduplication
async function tmdb(endpoint, params) {
  params = params || {};
  params.mz_cb = '1'; // Cache-buster to bypass poisoned browser cache from previous errors

  let qs = '';
  if (Object.keys(params).length) {
    qs = '?' + Object.entries(params).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  }
  const urlStr = BASE + endpoint + qs;
  
  if (tmdbCache.has(urlStr)) return tmdbCache.get(urlStr); // Memory cache (instant)
  
  // LocalStorage check for instant loads across sessions (24hr expiry)
  const cacheKey = 'mz_cache_' + urlStr;
  const localDataStr = localStorage.getItem(cacheKey);
  if (localDataStr) {
    try {
      const parsed = JSON.parse(localDataStr);
      if (parsed.timestamp && (Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000)) {
        tmdbCache.set(urlStr, parsed.data);
        return parsed.data; 
      }
    } catch(e) {}
  }

  if (inFlightRequests.has(urlStr)) return inFlightRequests.get(urlStr);

  const fetchPromise = (async () => {
    try {
      const r = await fetch(urlStr); 
      if (!r.ok) {
        console.error(`Backend API Error: ${r.status} for ${urlStr}`);
        return {};
      }
      const data = await r.json();
      tmdbCache.set(urlStr, data);
      
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
      } catch (err) {}
      
      return data;
    } catch (e) {
      console.error('Network/Fetch Error:', e);
      return {};
    }
  })();
  
  inFlightRequests.set(urlStr, fetchPromise);
  fetchPromise.finally(() => inFlightRequests.delete(urlStr));
  return fetchPromise;
}

// ── INIT ── Priority-based staggered loading for ultra-fast startup
async function init() {
  await loadCarousel(); // 1. Priority: Hero section load karo
  await loadMovies('all'); // 2. Priority: Initial grid load karo
  
  // 3. Delay upcoming fetching until browser is idle
  setTimeout(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => loadUpcoming());
    else loadUpcoming();
  }, 800);
}

// ── CAROUSEL
async function loadCarousel() {
  const [t1, t2] = await Promise.all([
    tmdb('/trending/all/week', { language: 'en-US', page: '1' }), // Ab hero banner me Series bhi aayengi
    tmdb('/movie/top_rated',    { language: 'en-US', page: '1' })
  ]);
  const pool = [...(t1.results||[]), ...(t2.results||[])];
  const seen = new Set();
  carouselMovies = pool.filter(m => {
    if (!m.backdrop_path || !m.poster_path || seen.has(m.id)) return false;
    seen.add(m.id); return true;
  }).slice(0, 6);
  if (carouselMovies.length) buildCarousel();
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
    slide.innerHTML =
      '<div class="slide-bg" style="background-image:url(\''+IMG_ORIG+m.backdrop_path+'\')"></div>' +
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

  startAutoSlide();
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
}

function startAutoSlide() {
  if (autoSlideTimer) clearInterval(autoSlideTimer);
  autoSlideTimer = setInterval(() => { goToSlide(currentSlide + 1); }, 5500);
}
function resetAutoSlide() { startAutoSlide(); }

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
    tmdb('/movie/popular', { language: 'en-US', page: p1 });
    tmdb('/movie/popular', { language: 'en-US', page: p2 });
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
      const res = await Promise.all([
        tmdb('/trending/movie/week', { language: 'en-US', page: pageStr }),
        tmdb('/movie/popular',      { language: 'en-US', page: pageStr }),
        tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', page: pageStr, language: 'en-US' })
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
        tmdb('/movie/popular', { language: 'en-US', page: p1 }),
        tmdb('/movie/popular', { language: 'en-US', page: p2 })
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
    } else {
      const base = Object.assign({}, CAT_PARAMS[cat] || {}, { language: 'en-US' });
      const res = await Promise.all([
        tmdb('/discover/movie', Object.assign({}, base, { page: p1 })),
        tmdb('/discover/movie', Object.assign({}, base, { page: p2 }))
      ]);
      res.forEach(r => { movies = movies.concat(r.results||[]); });
    }
  } catch(e) { console.warn(e); }

  movies = movies.filter(m => !!m.poster_path);
  
  const existingIds = new Set(allMovies.map(m => m.id));
  const newMovies = movies.filter(m => { if(existingIds.has(m.id)) return false; existingIds.add(m.id); return true; });
  allMovies = allMovies.concat(newMovies);

  renderMovies(isLoadMore ? newMovies : (isFullViewMovies ? allMovies : allMovies.slice(0, 24)), isLoadMore);
  
  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) {
    const h = document.getElementById('sectionHeading');
    if (h && h.textContent === 'MY WATCHLIST') loadMoreBtn.style.display = 'none';
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
    card.style.animationDelay = ((i % 24) * 0.04) + 's';
    card.innerHTML =
      '<div class="card-poster">' +
        '<img src="'+IMG+m.poster_path+'" alt="'+escapeHTML(m.title||'')+'" width="200" height="300" loading="lazy" decoding="async">' +
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

  });
  grid.appendChild(fragment);
}

// CATEGORY FILTER
const CAT_HEADINGS = {
  all:'ALL MOVIES & SHOWS', tv: 'TV SHOWS & WEB SERIES', hollywood:'HOLLYWOOD', bollywood:'BOLLYWOOD',
  south:'SOUTH INDIAN', tollywood:'TOLLYWOOD', action:'ACTION',
  comedy:'COMEDY', thriller:'THRILLER', romance:'ROMANCE',
  scifi:'SCI-FI', animation:'ANIMATION', kids:'🧸 KIDS & CARTOONS', anime:'⚔️ ANIME SERIES & MOVIES'
};
function filterCat(cat) {
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
  if (h && h.textContent === 'MY WATCHLIST') {
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
  if (h) h.textContent = 'MY WATCHLIST';
  const sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: 'smooth' });
  renderMovies(watchlist);
  const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = 'none';
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
    movies = movies.filter(m => m.poster_path && m.backdrop_path && m.release_date && m.release_date >= realToday);
    
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
      const genres = (m.genre_ids||[]).slice(0,2).map(id => GENRE_MAP[id]).filter(Boolean);
      const card = document.createElement('div');
      card.className = 'upcoming-card';
      card.tabIndex = 0;
      card.style.animationDelay = ((i % 12) * 0.08) + 's';
      card.innerHTML =
        '<div class="upcoming-poster">' +
          '<img src="'+IMG+m.backdrop_path+'" alt="'+escapeHTML(m.title||'')+'" width="280" height="157" loading="lazy" decoding="async">' +
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
  const movies = (data.results||[]).filter(m => m.media_type !== 'person').slice(0, 6);
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
  const movies = (data.results||[]).filter(m => !!m.poster_path && m.media_type !== 'person');
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
  if (bgEl) bgEl.src = '';
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
    if (bgEl) bgEl.src = details.backdrop_path ? IMG_ORIG + details.backdrop_path : '';

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
    if (imageWrapper) {
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
    const metaEl  = document.getElementById('modalMeta');
    if (metaEl) metaEl.innerHTML =
      '<div class="card-rating" style="font-size:0.9rem">RATING '+((details.vote_average||0).toFixed(1))+' ('+(details.vote_count||0).toLocaleString()+')</div>' +
      '<div class="card-year" style="font-size:0.85rem">YEAR '+((details.release_date||details.first_air_date||'').slice(0,4))+'</div>' +
      '<div class="card-runtime" style="font-size:0.85rem">RUNTIME '+runtime+'</div>' + genres;
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
        const playBtn = document.querySelector('.premium-play-btn');
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

    movies = movies.filter(m => !!m.poster_path).slice(0, 12); // Top 12 similar items

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
        card.className = 'movie-card';
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
      });
      grid.appendChild(fragment);
    } else {
      section.style.display = 'none';
    }
  } catch(e) { section.style.display = 'none'; }
}

// 2026 के सबसे ज्यादा चलने वाले और एक्टिव सर्वर्स की लिस्ट
const playerSources = [
  { name: 'Server 1', url: (id, lang, type, s, e) => {
    // इंडिया के नेटवर्क्स पर ब्लॉकेज कम आती है
    return type === 'tv' ? `https://autoembed.co/tv/tmdb/${id}-${s}-${e}` : 'https://autoembed.co/movie/tmdb/' + id;
  }},
  { name: 'Server 2', url: (id, lang, type, s, e) => {
    // इंटरफ़ेस बहुत साफ़ है और प्लेयर के अंदर सेटिंग्स
    return type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : 'https://vidlink.pro/movie/' + id;
  }},
  { name: 'Server 3', url: (id, lang, type, s, e) => {
    // TV aur Movie dono properly support karega
    return type === 'tv' ? `https://vidsrc.to/embed/tv/${id}/${s}/${e}` : 'https://vidsrc.to/embed/movie/' + id;
  }},
  { name: 'Server 4 ', url: (id, lang, type, s, e) => {
    // Official proxy mirror to fix 'refused to connect' / iframe block issue
    return type === 'tv' ? `https://vidsrc.pm/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc.pm/embed/movie?tmdb=${id}`;
  }}
];
let currentSourceIdx = 0;
let isPlayerFullscreen = false;

function renderExternalSources(id, srcIdx, lang) {
  const ext = document.getElementById('externalSources');
  if (!ext) return;
  const html = playerSources.map((s, i) => 
    '<button class="player-chip player-chip--source" data-srcidx="'+i+'">'+escapeHTML(s.name)+'</button>'
  ).join('');
  ext.innerHTML = html;
  const srcButtons = ext.querySelectorAll('.player-chip--source');
  srcButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-srcidx')||'0', 10);
      loadPlayer(id, idx, lang);
      srcButtons.forEach(b => { b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
  if (typeof srcIdx === 'number') {
    srcButtons.forEach(b => { b.classList.remove('active'); });
    const activeBtn = ext.querySelector('.player-chip--source[data-srcidx="'+srcIdx+'"]');
    if (activeBtn) activeBtn.classList.add('active');
  }
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
    // अगले एपिसोड पर जाएं
    eInput.value = currentE + 1;
    eInput.dispatchEvent(new Event('change'));
  } else {
    // अगर सीज़न खत्म हो गया है, तो अगला सीज़न प्ले करें
    const seasons = (currentModalMovie.seasons || []).filter(s => s.season_number > 0);
    const nextSeason = seasons.find(s => s.season_number === currentS + 1);
    if (nextSeason) {
      sInput.value = currentS + 1;
      sInput.dispatchEvent(new Event('change'));
    } else {
      showToast("You have reached the latest episode!");
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

  embedEl.innerHTML = '';

  // Custom Loading Spinner add karo
  const loader = document.createElement('div');
  loader.className = 'player-loader';
  loader.innerHTML = '<div class="player-spinner"></div>';
  embedEl.appendChild(loader);

  const iframe = document.createElement('iframe');
  iframe.id = 'playerFrame';
  iframe.src = src;
  iframe.style.cssText = 'width: 100%; height: 100%; border: none; overflow: hidden !important; background: transparent; position: relative; z-index: 1;';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('webkitallowfullscreen', 'true');
  iframe.setAttribute('mozallowfullscreen', 'true');
  iframe.setAttribute('allow', 'fullscreen;autoplay;encrypted-media;picture-in-picture');
  iframe.setAttribute('fetchpriority', 'high'); // 🚀 Browser ko strict command for maximum loading speed
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

  showToast('PLAY ' + buildSourceLabel(srcIdx) + ' | ' + (lang==='hi' ? 'Hindi' : 'English') + ' | ' + quality.toUpperCase() + (type === 'tv' ? ` | S${s} E${e}` : ''));

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

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch(e){}
    }
  }
});

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
  if (langSel) langSel.addEventListener('change', (e) => { setSelectedLang(e.target.value); });
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
});

window.addEventListener('scroll', () => {
  const nb = document.getElementById('navbar');
  if (nb) nb.classList.toggle('scrolled', window.scrollY > 60);
});

const hamburgerBtn = document.getElementById('hamburgerBtn');
if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', () => {
    const navLinks = document.querySelector('.nav-links');
    navLinks.classList.toggle('open');
    hamburgerBtn.classList.toggle('open');
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
    document.body.style.overflow = '';
  });
});

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
  if (e.key === 'Enter' && document.activeElement) {
    const tag = document.activeElement.tagName;
    if (tag !== 'BUTTON' && tag !== 'A' && tag !== 'INPUT') {
      document.activeElement.click();
      e.preventDefault();
    }
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

init();