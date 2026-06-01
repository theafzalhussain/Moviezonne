const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIwYmVlMmRkZWY4NzExZWU1YmQ4YWYzYzZlNzI1M2RlYiIsIm5iZiI6MTc3OTMwNDU2My41NTAwMDAyLCJzdWIiOiI2YTBlMDg3M2QxOTVhYTNkNmJiODFiZjciLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.vzgUC1CM_C_b5ao824hr9DIO8HP-ibNAlO54BdxhyfI';
const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const IMG_ORIG = 'https://image.tmdb.org/t/p/original';

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

// ── FETCH helper ── uses plain string URLs, caching added for high speed
const tmdbCache = new Map();
async function tmdb(endpoint, params) {
  let qs = '';
  if (params && Object.keys(params).length) {
    qs = '?' + Object.entries(params).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  }
  const urlStr = BASE + endpoint + qs;
  if (tmdbCache.has(urlStr)) return tmdbCache.get(urlStr);
  try {
    const r = await fetch(urlStr, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + TOKEN }
    });
    if (!r.ok) return {};
    const data = await r.json();
    tmdbCache.set(urlStr, data);
    return data;
  } catch (e) {
    console.warn('TMDB fetch error:', e);
    return {};
  }
}

// ── INIT ── sequential to avoid race on carousel DOM
async function init() {
  loadMovies('all');
  loadUpcoming();
  await loadCarousel();
}

// ── CAROUSEL
async function loadCarousel() {
  const [t1, t2] = await Promise.all([
    tmdb('/trending/movie/week', { language: 'en-US', page: '1' }),
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

  carouselMovies.forEach(function(m, i) {
    const genres = (m.genre_ids||[]).slice(0,3).map(function(id){ return '<span class="genre-tag">'+(GENRE_MAP[id]||'Movie')+'</span>'; }).join('');
    const slide = document.createElement('div');
    slide.className = 'carousel-slide' + (i === 0 ? ' active' : '');
    slide.innerHTML =
      '<div class="slide-bg" style="background-image:url(\''+IMG_ORIG+m.backdrop_path+'\')"></div>' +
      '<div class="slide-gradient"></div>' +
      '<div class="slide-content">' +
        '<div class="slide-badge">TRENDING NOW</div>' +
        '<h1 class="slide-title">'+(m.title||m.name||'')+'</h1>' +
        '<div class="slide-meta">' +
          '<div class="slide-rating">RATING '+((m.vote_average||0).toFixed(1))+'</div>' +
          '<span class="slide-year">'+((m.release_date||'').slice(0,4))+'</span>' +
          '<span class="slide-runtime">RUNTIME 2h 15m</span>' +
        '</div>' +
        '<div class="slide-genres">'+genres+'</div>' +
        '<p class="slide-desc">'+(m.overview||'')+'</p>' +
        '<div class="slide-actions">' +
          '<button class="btn-play" data-id="'+m.id+'">Watch Now</button>' +
          '<button class="btn-info" data-id="'+m.id+'">More Info</button>' +
        '</div>' +
      '</div>';
    slide.querySelectorAll('[data-id]').forEach(function(btn){
      btn.addEventListener('click', function(){ openModal(parseInt(btn.dataset.id)); });
    });
    track.appendChild(slide);

    const dot = document.createElement('div');
    dot.className = 'dot' + (i === 0 ? ' active' : '');
    (function(idx){ dot.addEventListener('click', function(){ goToSlide(idx); resetAutoSlide(); }); })(i);
    dots.appendChild(dot);

    const thumb = document.createElement('div');
    thumb.className = 'thumb' + (i === 0 ? ' active' : '');
    thumb.innerHTML = '<img src="'+IMG+m.poster_path+'" alt="">';
    (function(idx){ thumb.addEventListener('click', function(){ goToSlide(idx); resetAutoSlide(); }); })(i);
    thumbs.appendChild(thumb);
  });

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
  autoSlideTimer = setInterval(function(){ goToSlide(currentSlide + 1); }, 5500);
}
function resetAutoSlide() { startAutoSlide(); }

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

async function loadMovies(cat) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;
  grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');

  let movies = [];
  try {
    if (cat === 'all') {
      const res = await Promise.all([
        tmdb('/trending/movie/week', { language: 'en-US', page: '1' }),
        tmdb('/movie/popular',      { language: 'en-US', page: '1' }),
        tmdb('/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', page: '1', language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', page: '1', language: 'en-US' }),
        tmdb('/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', page: '1', language: 'en-US' }),
        tmdb('/movie/now_playing',  { language: 'en-US', page: '1' })
      ]);
      
      let maxLength = 0;
      res.forEach(function(r) { if (r.results && r.results.length > maxLength) maxLength = r.results.length; });
      for (let i = 0; i < maxLength; i++) {
        res.forEach(function(r) {
          if (r.results && i < r.results.length) {
            movies.push(r.results[i]);
          }
        });
      }
      
      var seen = new Set();
      movies = movies.filter(function(m){ if(seen.has(m.id)) return false; seen.add(m.id); return true; });
    } else if (cat === 'hollywood') {
      const res = await Promise.all([
        tmdb('/movie/popular', { language: 'en-US', page: '1' }),
        tmdb('/movie/popular', { language: 'en-US', page: '2' })
      ]);
      res.forEach(function(r){ movies = movies.concat(r.results||[]); });
    } else {
      var base = Object.assign({}, CAT_PARAMS[cat] || {}, { language: 'en-US' });
      var p1 = Object.assign({}, base, { page: '1' });
      var p2 = Object.assign({}, base, { page: '2' });
      const res = await Promise.all([
        tmdb('/discover/movie', p1),
        tmdb('/discover/movie', p2)
      ]);
      res.forEach(function(r){ movies = movies.concat(r.results||[]); });
    }
  } catch(e) { console.warn(e); }

  allMovies = movies.filter(function(m){ return !!m.poster_path; });
  renderMovies(allMovies.slice(0, 24));
}

function renderMovies(movies) {
  const grid = document.getElementById('movieGrid');
  if (!grid) return;
  if (!movies.length) {
    grid.innerHTML = '<div class="no-results"><h3>No movies found</h3><p>Try a different search or category.</p></div>';
    return;
  }
  grid.innerHTML = '';
  movies.forEach(function(m, i) {
    var rating = m.vote_average ? m.vote_average.toFixed(1) : 'N/A';
    var year   = (m.release_date || '').slice(0, 4);
    var votes  = m.vote_count > 999 ? (m.vote_count/1000).toFixed(1)+'K' : (m.vote_count||0);
    var genres = (m.genre_ids||[]).slice(0,2).map(function(id){ return GENRE_MAP[id]; }).filter(Boolean);
    var isHot  = m.popularity > 100;
    var qual   = m.vote_average >= 7.5 ? '4K' : m.vote_average >= 6 ? 'FHD' : 'HD';
    var card   = document.createElement('div');
    card.className = 'movie-card';
    card.style.animationDelay = (i * 0.04) + 's';
    card.innerHTML =
      '<div class="card-poster">' +
        '<img src="'+IMG+m.poster_path+'" alt="'+(m.title||'')+'" loading="lazy">' +
        '<div class="card-quality">'+qual+'</div>' +
        (isHot ? '<div class="card-hot">HOT</div>' : '') +
        '<div class="card-overlay"><button class="card-play-btn">&#9654;</button></div>' +
      '</div>' +
      '<div class="card-info">' +
        '<div class="card-title">'+(m.title||m.name||'')+'</div>' +
        '<div class="card-meta">' +
          '<div class="card-rating">RATING '+votes+'</div>' +
          '<div class="card-year">YEAR '+year+'</div>' +
        '</div>' +
        '<div class="card-meta"><div class="card-runtime">RUNTIME 2h 15m</div></div>' +
        '<div class="card-genres">'+genres.map(function(g){ return '<span class="card-genre">'+g+'</span>'; }).join('')+'</div>' +
      '</div>';
    card.addEventListener('click', (function(mid){ return function(){ openModal(mid); }; })(m.id));
    grid.appendChild(card);
  });
}

// CATEGORY FILTER
var CAT_HEADINGS = {
  all:'ALL MOVIES & SHOWS', hollywood:'HOLLYWOOD', bollywood:'BOLLYWOOD',
  south:'SOUTH INDIAN', tollywood:'TOLLYWOOD', action:'ACTION',
  comedy:'COMEDY', thriller:'THRILLER', romance:'ROMANCE',
  scifi:'SCI-FI', animation:'ANIMATION'
};
function filterCat(cat) {
  document.querySelectorAll('.cat-tab').forEach(function(t){ t.classList.remove('active'); });
  var tabs = document.querySelectorAll('.cat-tab');
  tabs.forEach(function(t){ if ((t.getAttribute('onclick')||'').indexOf("'"+cat+"'") !== -1) t.classList.add('active'); });
  var h = document.getElementById('sectionHeading');
  if (h) h.textContent = CAT_HEADINGS[cat] || 'MOVIES';
  var sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: 'smooth' });
  loadMovies(cat);
}

// ── UPCOMING
async function loadUpcoming() {
  const grid = document.getElementById('upcomingGrid');
  if (!grid) return;
  try {
    var d = new Date();
    d.setDate(d.getDate() - 1);
    var today = d.toISOString().split('T')[0];
    d.setMonth(d.getMonth() + 3);
    var future = d.toISOString().split('T')[0];

    const res = await Promise.all([
      tmdb('/discover/movie', { language: 'en-US', page: '1', sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'en' }),
      tmdb('/discover/movie', { language: 'en-US', page: '2', sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'en' }),
      tmdb('/discover/movie', { language: 'en-US', page: '1', sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'hi', region: 'IN' }),
      tmdb('/discover/movie', { language: 'en-US', page: '2', sort_by: 'popularity.desc', 'primary_release_date.gte': today, 'primary_release_date.lte': future, with_original_language: 'hi', region: 'IN' })
    ]);
    var movies = [];
    res.forEach(function(r){ movies = movies.concat(r.results||[]); });
    
    var realToday = new Date().toISOString().split('T')[0];
    movies = movies.filter(function(m){ return m.poster_path && m.backdrop_path && m.release_date && m.release_date >= realToday; });
    
    var seen = new Set();
    movies = movies.filter(function(m) {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    movies.sort(function(a, b){ return a.release_date.localeCompare(b.release_date); });
    
    grid.innerHTML = '';
    movies.slice(0, 12).forEach(function(m) {
      var dateStr = 'Coming Soon';
      if (m.release_date) {
        try { dateStr = new Date(m.release_date).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }); } catch(e){}
      }
      var genres = (m.genre_ids||[]).slice(0,2).map(function(id){ return GENRE_MAP[id]; }).filter(Boolean);
      var card = document.createElement('div');
      card.className = 'upcoming-card';
      card.style.animationDelay = (movies.indexOf(m) * 0.08) + 's';
      card.innerHTML =
        '<div class="upcoming-poster">' +
          '<img src="'+IMG+m.backdrop_path+'" alt="'+(m.title||'')+'" loading="lazy">' +
          '<div class="upcoming-poster-overlay"></div>' +
          '<div class="upcoming-release-badge">RELEASE '+dateStr+'</div>' +
        '</div>' +
        '<div class="upcoming-info">' +
          '<div class="upcoming-title">'+(m.title||'')+'</div>' +
          '<div class="upcoming-meta">' +
            '<div class="card-rating" style="font-size:0.73rem">RATING '+((m.vote_average||0).toFixed(1))+'</div>' +
            '<div class="card-year" style="font-size:0.71rem">YEAR '+((m.release_date||'').slice(0,4))+'</div>' +
            genres.map(function(g){ return '<span class="card-genre">'+g+'</span>'; }).join('') +
          '</div>' +
          '<p class="upcoming-desc">'+(m.overview||'')+'</p>' +
        '</div>';
      card.addEventListener('click', (function(mid){ return function(){ openModal(mid); }; })(m.id));
      grid.appendChild(card);
    });
  } catch(e) { console.warn(e); }
}

// SEARCH
var searchTimer = null;
var searchInput = document.getElementById('searchInput');
if (searchInput) {
  searchInput.addEventListener('input', function(e) {
    clearTimeout(searchTimer);
    var q = e.target.value.trim();
    if (!q) { closeDropdown(); return; }
    searchTimer = setTimeout(function(){ searchDropdownFill(q); }, 380);
  });
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      var q = e.target.value.trim();
      if (q) searchAndDisplay(q);
      closeDropdown();
    }
  });
}
document.addEventListener('click', function(e) {
  if (!e.target.closest('.nav-search')) closeDropdown();
});

async function searchDropdownFill(q) {
  var data = await tmdb('/search/movie', { query: q, language: 'en-US', page: '1' });
  var movies = (data.results||[]).slice(0, 6);
  var dd = document.getElementById('searchDropdown');
  if (!dd) return;
  if (!movies.length) {
    dd.innerHTML = '<div class="search-result-item"><div class="search-result-info"><h4>No results</h4></div></div>';
    dd.classList.add('open'); return;
  }
  dd.innerHTML = '';
  movies.forEach(function(m) {
    var item = document.createElement('div');
    item.className = 'search-result-item';
    item.innerHTML =
      '<img src="'+(m.poster_path ? IMG+m.poster_path : 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2242%22 height=%2260%22><rect width=%2242%22 height=%2260%22 fill=%22%23222%22/></svg>')+'" alt="" loading="lazy">' +
      '<div class="search-result-info"><h4>'+(m.title||'')+'</h4><p>'+((m.release_date||'').slice(0,4))+' | RATING '+((m.vote_average||0).toFixed(1))+'</p></div>';
    item.addEventListener('click', (function(mid){ return function(){ openModal(mid); closeDropdown(); }; })(m.id));
    dd.appendChild(item);
  });
  dd.classList.add('open');
}

async function searchAndDisplay(q) {
  var grid = document.getElementById('movieGrid');
  if (!grid) return;
  grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  var h = document.getElementById('sectionHeading');
  if (h) h.textContent = 'RESULTS FOR "' + q.toUpperCase() + '"';
  var sec = document.getElementById('movies-section');
  if (sec) sec.scrollIntoView({ behavior: 'smooth' });
  var data = await tmdb('/search/movie', { query: q, language: 'en-US', page: '1', include_adult: 'false' });
  var movies = (data.results||[]).filter(function(m){ return !!m.poster_path; });
  allMovies = movies;
  renderMovies(movies);
}

function closeDropdown() {
  var dd = document.getElementById('searchDropdown');
  if (dd) dd.classList.remove('open');
}

// MODAL
async function openModal(id) {
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  try {
    var details = await tmdb('/movie/'+id, { language: 'en-US' });
    currentModalMovie = details;
    var bgEl = document.getElementById('modalBg');
    if (bgEl) bgEl.src = details.backdrop_path ? IMG_ORIG + details.backdrop_path : '';
    var titleEl = document.getElementById('modalTitle');
    if (titleEl) titleEl.textContent = details.title || details.name || '';
    var descEl = document.getElementById('modalDesc');
    if (descEl) descEl.textContent = details.overview || '';
    var runtime = details.runtime ? (Math.floor(details.runtime/60)+'h '+(details.runtime%60)+'m') : '2h 15m';
    var genres  = (details.genres||[]).slice(0,3).map(function(g){ return '<span class="genre-tag">'+g.name+'</span>'; }).join('');
    var metaEl  = document.getElementById('modalMeta');
    if (metaEl) metaEl.innerHTML =
      '<div class="card-rating" style="font-size:0.9rem">RATING '+((details.vote_average||0).toFixed(1))+' ('+(details.vote_count||0).toLocaleString()+')</div>' +
      '<div class="card-year" style="font-size:0.85rem">YEAR '+((details.release_date||'').slice(0,4))+'</div>' +
      '<div class="card-runtime" style="font-size:0.85rem">RUNTIME '+runtime+'</div>' + genres;
    var embedEl = document.getElementById('videoEmbed');
    if (embedEl) embedEl.innerHTML =
      '<div class="video-placeholder">' +
        '<button class="play-big" id="playBigBtn" aria-label="Play" title="Play">' +
          '<svg viewBox="0 0 24 24" width="44" height="44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<path d="M5 3v18l15-9L5 3z" fill="white" />' +
          '</svg>' +
        '</button>' +
        '<p>Select language & quality, then press play</p>' +
      '</div>';
    var pb = document.getElementById('playBigBtn');
    if (pb) pb.addEventListener('click', playMovie);
    overlay.classList.add('open');
    try { setSelectedLang(getSelectedLang()); } catch(e) {}
    try { setSelectedQuality(getSelectedQuality()); } catch(e) {}
    
    var ls = document.getElementById('langSelect');
    if (ls) ls.onchange = function() { if(embedEl.querySelector('iframe')) playMovie(); };
    
    document.body.style.overflow = 'hidden';
  } catch(e) { console.warn('Modal error', e); }
}

function closeModal() {
  var overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
  var embedEl = document.getElementById('videoEmbed');
  if (embedEl) {
    embedEl.innerHTML = '';
    embedEl.classList.remove('fullscreen-mode');
  }
  isPlayerFullscreen = false;
  currentModalMovie = null;
}

// 2026 के सबसे ज्यादा चलने वाले और एक्टिव सर्वर्स की लिस्ट
var playerSources = [
  { name: 'Server 1 (VidSrc To - Ultra Stable)', url: function(id, lang) {
    // यह पूरे इंटरनेट पर सबसे ज्यादा इस्तेमाल होने वाला और फास्ट सर्ver है
    return 'https://vidsrc.to/embed/movie/' + id;
  }},
  { name: 'Server 2 (AutoEmbed - Direct Stream)', url: function(id, lang) {
    // इसमें इंडिया के नेटवर्क्स पर ब्लॉकेज की समस्या सबसे कम आती है
    return 'https://autoembed.co/movie/tmdb/' + id;
  }},
  { name: 'Server 3 (VidLink Premium UI)', url: function(id, lang) {
    // इसका इंटरफ़ेस बहुत साफ़ है और इसमें प्लेयर के अंदर सेटिंग्स मिलती है
    return 'https://vidlink.pro/movie/' + id;
  }},
   { name: 'Server 4 (VidSrc CC - Working Backup)', url: function(id, lang) {
    // MultiEmbed की जगह यह नया 100% वर्किंग सर्वर (VidSrc CC) लगाया गया है
    return 'https://vidsrc.cc/v2/embed/movie/' + id;
  }}
];
var currentSourceIdx = 0;
var isPlayerFullscreen = false;

function renderExternalSources(id, srcIdx, lang) {
  var ext = document.getElementById('externalSources');
  if (!ext) return;
  var html = playerSources.map(function(s, i){
    return '<button class="player-chip player-chip--source" data-srcidx="'+i+'">'+s.name+'</button>';
  }).join('');
  ext.innerHTML = html;
  var srcButtons = ext.querySelectorAll('.player-chip--source');
  srcButtons.forEach(function(btn){
    btn.addEventListener('click', function(){
      var idx = parseInt(btn.getAttribute('data-srcidx')||'0', 10);
      loadPlayer(id, idx, lang);
      srcButtons.forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
  if (typeof srcIdx === 'number') {
    srcButtons.forEach(function(b){ b.classList.remove('active'); });
    var activeBtn = ext.querySelector('.player-chip--source[data-srcidx="'+srcIdx+'"]');
    if (activeBtn) activeBtn.classList.add('active');
  }
}

function getSelectedLang() {
  var select = document.getElementById('langSelect');
  return select ? select.value : (localStorage.getItem('moviezone.playerLang') || 'en');
}

function setSelectedLang(lang) {
  var select = document.getElementById('langSelect');
  if (select) select.value = lang;
  localStorage.setItem('moviezone.playerLang', lang);
}

function getSelectedQuality() {
  var select = document.getElementById('qualitySelect');
  return select ? select.value : (localStorage.getItem('moviezone.playerQuality') || 'fhd');
}

function setSelectedQuality(quality) {
  var select = document.getElementById('qualitySelect');
  if (select) select.value = quality;
  localStorage.setItem('moviezone.playerQuality', quality);
}

function getSelectedSourceIdx() {
  var saved = parseInt(localStorage.getItem('moviezone.playerSourceIdx') || '0', 10);
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
  var lang = getSelectedLang();
  var quality = getSelectedQuality();
  loadPlayer(currentModalMovie.id, currentSourceIdx, lang, quality);
}

function loadPlayer(id, srcIdx, lang, quality) {
  var embedEl = document.getElementById('videoEmbed');
  if (!embedEl) return;
  currentSourceIdx = srcIdx;
  setSelectedSourceIdx(srcIdx);
  lang = lang || getSelectedLang();
  setSelectedLang(lang);
  quality = quality || getSelectedQuality();
  setSelectedQuality(quality);
  var src = playerSources[srcIdx].url(id, lang);

  embedEl.innerHTML =
    '<iframe ' +
      'id="playerFrame" ' +
      'src="' + src + '" ' +
      'width="100%" height="100%" ' +
      'frameborder="0" ' +
      'allow="fullscreen;autoplay;encrypted-media;picture-in-picture" ' +
      'loading="lazy"' +
    '></iframe>';

  var controlsHtml = '<div id="playerControls" class="player-controls">';
  controlsHtml += '<button onclick="togglePlayerFS()" class="player-chip player-chip--fs" id="fsBtn">' +
        '<svg class="player-chip__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
          '<path d="M7 3H3v4h2V5h2V3zm10 0v2h2v2h2V3h-4zM5 17H3v4h4v-2H5v-2zm16 0h-2v2h-2v2h4v-4z"></path>' +
        '</svg>' +
        '<span>Fullscreen</span>' +
      '</button>' +
    '</div>';

  var existingControls = document.getElementById('playerControls');
  if (existingControls) {
    existingControls.outerHTML = controlsHtml;
  } else {
    embedEl.insertAdjacentHTML('afterend', controlsHtml);
  }

  try { renderExternalSources(id, srcIdx, lang); } catch(e){}

  showToast('PLAY ' + buildSourceLabel(srcIdx) + ' | ' + (lang==='hi' ? 'Hindi' : 'English') + ' | ' + quality.toUpperCase());
}

function togglePlayerLang() {
  if (!currentModalMovie) return;
  var nextLang = getSelectedLang() === 'hi' ? 'en' : 'hi';
  setSelectedLang(nextLang);
  loadPlayer(currentModalMovie.id, currentSourceIdx, nextLang, getSelectedQuality());
}

function togglePlayerFS() {
  var embedEl = document.getElementById('videoEmbed');
  var btn = document.getElementById('fsBtn');
  if (!embedEl) return;

  if (!document.fullscreenElement && !document.webkitFullscreenElement && !isPlayerFullscreen) {
    var target = embedEl;
    try {
      var fsResult = null;
      if (target.requestFullscreen) fsResult = target.requestFullscreen();
      else if (target.webkitRequestFullscreen) fsResult = target.webkitRequestFullscreen();
      
      Promise.resolve(fsResult).then(function() {
        if (screen.orientation && screen.orientation.lock) {
          return screen.orientation.lock('landscape').catch(function(){});
        }
      }).catch(function(){});
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

document.addEventListener('fullscreenchange', function() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch(e){}
    }
  }
});

function exitFSOnEsc(e) {
  if (e.key === 'Escape') togglePlayerFS();
}

var modalOverlay = document.getElementById('modal-overlay');
if (modalOverlay) {
  modalOverlay.addEventListener('click', function(e) {
    if (e.target === modalOverlay) closeModal();
  });
}

document.addEventListener('DOMContentLoaded', function() {
  var langSel = document.getElementById('langSelect');
  if (langSel) langSel.addEventListener('change', function(e){ setSelectedLang(e.target.value); });
  var qualSel = document.getElementById('qualitySelect');
  if (qualSel) qualSel.addEventListener('change', function(e){ setSelectedQuality(e.target.value); });
});

window.addEventListener('scroll', function() {
  var nb = document.getElementById('navbar');
  if (nb) nb.classList.toggle('scrolled', window.scrollY > 60);
});

var hamburgerBtn = document.getElementById('hamburgerBtn');
if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', function() {
    var navLinks = document.querySelector('.nav-links');
    navLinks.classList.toggle('open');
    hamburgerBtn.classList.toggle('open');
    hamburgerBtn.setAttribute('aria-expanded', navLinks.classList.contains('open') ? 'true' : 'false');
    document.body.style.overflow = navLinks.classList.contains('open') ? 'hidden' : '';
  });
}
document.querySelectorAll('.nav-links a').forEach(function(link) {
  link.addEventListener('click', function() {
    var navLinks = document.querySelector('.nav-links');
    navLinks.classList.remove('open');
    if (hamburgerBtn) {
      hamburgerBtn.classList.remove('open');
      hamburgerBtn.setAttribute('aria-expanded', 'false');
    }
    document.body.style.overflow = '';
  });
});

function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 3000);
}

init();