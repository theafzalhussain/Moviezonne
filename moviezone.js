﻿const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
// Vercel par frontend + backend ek sath deploy ke liye relative path use karein:
const LIVE_BACKEND_URL = '/api/tmdb';
const BASE = isLocalhost ? 'http://localhost:3000/api/tmdb' : LIVE_BACKEND_URL;
const IMG = 'https://image.tmdb.org/t/p/w500';
const IMG_ORIG = 'https://image.tmdb.org/t/p/original';

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
          '<button class="btn-play" data-id="'+m.id+'" data-type="'+(m.media_type||(m.title?'movie':'tv'))+'">Watch Now</button>' +
          '<button class="btn-info" data-id="'+m.id+'" data-type="'+(m.media_type||(m.title?'movie':'tv'))+'">More Info</button>' +
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
  animation: { with_genres: '16',  sort_by: 'popularity.desc', page: '1' }
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
  if (isFullViewMovies) {
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
    const qual   = m.vote_average >= 7.5 ? '4K' : m.vote_average >= 6 ? 'FHD' : 'HD';
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
  scifi:'SCI-FI', animation:'ANIMATION'
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
  if (isFullViewUpcoming) {
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
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  try {
    const details = await tmdb('/'+type+'/'+id, { language: 'en-US' });
    details.media_type = type;
    currentModalMovie = details;
    const bgEl = document.getElementById('modalBg');
    if (bgEl) bgEl.src = details.backdrop_path ? IMG_ORIG + details.backdrop_path : '';
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
    overlay.classList.add('open');
    try { setSelectedLang(getSelectedLang()); } catch(e) {}
    try { setSelectedQuality(getSelectedQuality()); } catch(e) {}
    
    const ls = document.getElementById('langSelect');
    if (ls) ls.onchange = () => { if(embedEl.querySelector('iframe')) playMovie(); };
    
    const qs = document.getElementById('qualitySelect');
    if (qs) qs.onchange = () => { if(embedEl.querySelector('iframe')) playMovie(); };
    
    const tvGroup = document.getElementById('tvSelectGroup');
    if (tvGroup) tvGroup.style.display = type === 'tv' ? 'flex' : 'none';
    const sInput = document.getElementById('seasonInput');
    if (sInput) { sInput.value = '1'; sInput.oninput = () => { if(embedEl.querySelector('iframe')) playMovie(); }; }
    const eInput = document.getElementById('episodeInput');
    if (eInput) { eInput.value = '1'; eInput.oninput = () => { if(embedEl.querySelector('iframe')) playMovie(); }; }
    
    document.body.style.overflow = 'hidden';
    
    updateModalWatchlistBtn(id);
  } catch(e) { console.warn('Modal error', e); }
}

function closeModal() {
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
}

// 2026 के सबसे ज्यादा चलने वाले और एक्टिव सर्वर्स की लिस्ट
const playerSources = [
  { name: 'Server 1 (VidSrc To - Ultra Stable)', url: (id, lang) => {
    // यह पूरे इंटरनेट पर सबसे ज्यादा इस्तेमाल होने वाला और फास्ट सर्ver है
    return 'https://vidsrc.to/embed/movie/' + id;
  }},
  { name: 'Server 2 (AutoEmbed - Direct Stream)', url: (id, lang) => {
    // इसमें इंडिया के नेटवर्क्स पर ब्लॉकेज की समस्या सबसे कम आती है
    return 'https://autoembed.co/movie/tmdb/' + id;
  }},
  { name: 'Server 3 (VidLink Premium UI)', url: (id, lang) => {
    // इसका इंटरफ़ेस बहुत साफ़ है और इसमें प्लेयर के अंदर सेटिंग्स मिलती है
    return 'https://vidlink.pro/movie/' + id;
  }},
  { name: 'Server 4 (VidSrc Pro - 4K/FHD)', url: (id, lang) => {
    // Embed.su ब्लॉक होने पर यह नया सर्वर इस्तेमाल करें, इसमें भी हाई क्वालिटी (1080p/4K) सपोर्ट है
    return 'https://vidsrc.pro/embed/movie/' + id;
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

  embedEl.innerHTML =
    '<iframe ' +
      'id="playerFrame" ' +
      'src="' + src + '" ' +
      'style="width: 100%; height: 100%; border: none; overflow: hidden !important;" ' +
      'frameborder="0" marginwidth="0" marginheight="0" vspace="0" hspace="0" ' +
      'scrolling="no" ' +
      'allowfullscreen="true" ' +
      'allow="fullscreen;autoplay;encrypted-media;picture-in-picture" ' +
      'loading="lazy"' +
    '></iframe>';

  let controlsHtml = '<div id="playerControls" class="player-controls">';
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

  let noticeEl = document.getElementById('adBlockNotice');
  if (!noticeEl) {
    noticeEl = document.createElement('div');
    noticeEl.id = 'adBlockNotice';
    noticeEl.style.cssText = 'text-align: center; margin-top: 15px; font-size: 0.85rem; color: var(--text3);';
    const ext = document.getElementById('externalSources');
    if (ext) ext.parentNode.insertBefore(noticeEl, ext.nextSibling);
  }

  noticeEl.innerHTML = '💡 Tip: Use <strong style="color:var(--red2)">Brave Browser</strong> or <strong style="color:var(--red2)">uBlock Origin</strong> to block ads.';
  noticeEl.style.display = 'block';

  showToast('PLAY ' + buildSourceLabel(srcIdx) + ' | ' + (lang==='hi' ? 'Hindi' : 'English') + ' | ' + quality.toUpperCase() + (type === 'tv' ? ` | S${s} E${e}` : ''));
}

function togglePlayerLang() {
  if (!currentModalMovie) return;
  const nextLang = getSelectedLang() === 'hi' ? 'en' : 'hi';
  setSelectedLang(nextLang);
  loadPlayer(currentModalMovie.id, currentSourceIdx, nextLang, getSelectedQuality(), currentModalMovie.media_type);
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
  if (langSel) langSel.addEventListener('change', (e) => { setSelectedLang(e.target.value); });
  const qualSel = document.getElementById('qualitySelect');
  if (qualSel) qualSel.addEventListener('change', (e) => { setSelectedQuality(e.target.value); });
  
  // Make HTML static category tabs focusable for TV
  document.querySelectorAll('.cat-tab').forEach(t => { t.tabIndex = 0; });
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