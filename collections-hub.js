/* collections-hub.js — extracted from moviezone.js. Load after moviezone.min.js. */
/*  There is NO picker/landing page any more. The old #collections grid — 18 cards,
 *  hero mosaic and category tabs — was a dead stop between the homepage rail and
 *  the franchise the visitor already chose, so it was removed along with the
 *  navbar entry that was its only other door. The overlay below now has exactly
 *  one state: a single universe's page at #collections-<slug>, and Back/Escape
 *  leaves it for the page underneath instead of stepping to a grid. */
(function initCollectionsHub() {
  const _b = window.__mzBridge || {};
  const IMG = _b.IMG;
  const escapeHTML = _b.escapeHTML;
  const isMzTV = _b.isMzTV;
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
  let chHeroObserver = null; // topbar title reveal, one per rendered page

  /*  The page's own styles live in universes.css, which index.html loads
   *  deferred (media="print" flipped to "all" on load). A tap on a rail tile
   *  cannot beat it — the tile is styled by that same file — but a cold deep
   *  link to /#collections-<slug> can, so rendering waits for the sheet. It
   *  never waits more than 4s: an unstyled page beats no page. */
  function whenChStyles() {
    const link = document.querySelector('link[href*="universes.css"]');
    if (!link || (link.sheet && link.media !== 'print')) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { link.media = 'all'; resolve(); };
      if (link.sheet) { done(); return; }
      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 4000);
    });
  }

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

    const SVG_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    const SVG_CLOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

    function buildCards(items) {
      return items.map((item, idx) => {
        const title = item.title || item.name || '';
        const year = (item.release_date || item.first_air_date || '').slice(0, 4) || 'TBA';
        const voteRaw = Number(item.vote_average || 0);
        const rating = voteRaw.toFixed(1);
        const isTVItem = item._type === 'tv';
        const soon = isUpcoming(item);
        const delay = Math.min(idx, 16) * 45;
        // Release order is the franchise's own reading order, so it is printed
        // as a numeral ("01") and survives re-sorting by rating or title.
        const order = item._releaseOrder < 9 ? '0' + (item._releaseOrder + 1) : String(item._releaseOrder + 1);
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
              '<span class="ch-movie-order" aria-hidden="true">' + order + '</span>' +
              (isTVItem ? '<span class="ch-movie-type-badge ch-type-tv">SERIES</span>' : '<span class="ch-movie-type-badge ch-type-movie">MOVIE</span>') +
              // A rating on an unreleased film is noise at best and misleading at worst.
              (soon ? '<div class="ch-movie-soon-chip">UPCOMING</div>'
                    : (voteRaw > 0 ? '<div class="ch-movie-rating">★ ' + rating + '</div>' : '')) +
              '<div class="ch-movie-shine"></div>' +
              '<div class="ch-movie-hover-overlay">' +
                '<div class="ch-movie-hover-play">' + (soon ? SVG_CLOCK : SVG_PLAY) + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="ch-movie-info"><h4>' + escapeHTML(title) + '</h4><span>' + year + ' · ' + (isTVItem ? 'Series' : 'Movie') + '</span></div>' +
          '</div>'
        );
      }).join('');
    }

    // Swap grid contents without re-binding per-card listeners (delegation handles clicks)
    function paintGrid(items, sortLabel) {
      const gridEl = document.getElementById('chMovieGrid');
      if (!gridEl) return;
      gridEl.innerHTML = buildCards(items);
      const meta = document.getElementById('chGridMeta');
      if (meta) meta.innerHTML = '<b>' + items.length + '</b> title' + (items.length !== 1 ? 's' : '') + ' · ' + (sortLabel || 'Release order');
      attachImageReveal(gridEl);
      if (enableTilt) gridEl.querySelectorAll('.ch-movie-card').forEach(bindTilt);
    }

    allItems.forEach((item, i) => { item._releaseOrder = i; });
    /*  The hero's one action: start the franchise where it starts — the first
     *  title in release order that is actually out. */
    const firstUp = allItems.find(i => !isUpcoming(i));

    detail.innerHTML =
      '<div class="ch-detail-hero ch-accent-' + universe.accent + '">' +
        (heroItem.backdrop_path ? '<img src="https://image.tmdb.org/t/p/w1280' + heroItem.backdrop_path + '"' +
          ' srcset="https://image.tmdb.org/t/p/w780' + heroItem.backdrop_path + ' 780w, https://image.tmdb.org/t/p/w1280' + heroItem.backdrop_path + ' 1280w"' +
          ' sizes="100vw" alt="" width="1280" height="720" fetchpriority="high" decoding="async" class="ch-detail-hero-img">' : '') +
        '<div class="ch-detail-hero-gradient"></div>' +
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
          '<div class="ch-hero-actions">' +
            (firstUp ? '<button type="button" class="ch-hero-cta" data-id="' + firstUp.id + '" data-type="' + firstUp._type + '">' + SVG_PLAY +
              '<span>Start with <b>' + escapeHTML(firstUp.title || firstUp.name || '') + '</b></span></button>' : '') +
            '<button type="button" class="ch-hero-ghost" data-ch-browse>' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>' +
              'All ' + allItems.length + ' titles</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ch-toolbar">' +
        '<div class="ch-detail-tabs" role="group" aria-label="Show">' +
          '<button class="ch-dtab active" data-filter="all">All <b>' + allItems.length + '</b></button>' +
          '<button class="ch-dtab" data-filter="movies">Movies <b>' + totalMovies + '</b></button>' +
          (totalTV > 0 ? '<button class="ch-dtab" data-filter="tv">TV Series <b>' + totalTV + '</b></button>' : '') +
          (upcomingItems.length ? '<button class="ch-dtab" data-filter="upcoming">Upcoming <b>' + upcomingItems.length + '</b></button>' : '') +
        '</div>' +
        '<div class="ch-detail-sort" role="group" aria-label="Sort by">' +
          '<button class="ch-sort-btn active" data-sort="release">Release Order</button>' +
          '<button class="ch-sort-btn" data-sort="rating">Top Rated</button>' +
          '<button class="ch-sort-btn" data-sort="title">A – Z</button>' +
        '</div>' +
      '</div>' +
      '<div class="ch-grid-meta" id="chGridMeta" aria-live="polite"></div>' +
      '<div class="ch-movie-grid" id="chMovieGrid"></div>';

    paintGrid(allItems);

    // Cinematic slow zoom on the hero backdrop
    const heroEl = detail.querySelector('.ch-detail-hero');
    if (heroEl && !prefersReducedMotion) requestAnimationFrame(() => heroEl.classList.add('ch-kenburns'));

    /*  The top bar repeats the franchise name only once the hero's own title has
     *  scrolled out of view — with both on screen it is the same words twice.
     *  Without IntersectionObserver the bar simply keeps its title. */
    const overlayEl = document.getElementById('collections-hub-overlay');
    const stats = document.getElementById('chTopbarStats');
    if (stats) stats.textContent = totalMovies + ' movie' + (totalMovies !== 1 ? 's' : '') + (totalTV ? ' · ' + totalTV + ' series' : '');
    if (chHeroObserver) { chHeroObserver.disconnect(); chHeroObserver = null; }
    if (overlayEl) overlayEl.classList.remove('ch-scrolled');
    if (overlayEl && heroEl && window.IntersectionObserver) {
      overlayEl.classList.add('ch-io');
      chHeroObserver = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1];
        overlayEl.classList.toggle('ch-scrolled', !(e.isIntersecting && e.intersectionRatio > 0.18));
      }, { root: document.getElementById('chScroll'), threshold: [0, 0.18, 0.5] });
      chHeroObserver.observe(heroEl);
    }

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
      const sort = sortBtn ? sortBtn.dataset.sort : 'release';
      paintGrid(applySort(
        applyFilter(allItems, tab ? tab.dataset.filter : 'all'),
        sort
      ), { rating: 'Top rated first', title: 'A – Z' }[sort]);
    }

    function wireGroup(selector) {
      detail.querySelectorAll(selector).forEach(btn => {
        btn.setAttribute('aria-pressed', btn.classList.contains('active') ? 'true' : 'false');
        btn.addEventListener('click', () => {
          detail.querySelectorAll(selector).forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
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
      if (!e.target.closest) return;
      // The hero's primary action opens its title exactly as a poster would.
      const card = e.target.closest('.ch-movie-card, .ch-hero-cta');
      if (card) { open(card, e); return; }
      if (e.target.closest('[data-ch-browse]')) {
        const bar = detail.querySelector('.ch-toolbar');
        const scroller = document.getElementById('chScroll');
        if (bar && scroller) scroller.scrollTo({ top: bar.offsetTop, behavior: prefersReducedMotion || isMzTV() ? 'auto' : 'smooth' });
      }
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
    // The previous page's title-reveal state must not leak into this one.
    if (chHeroObserver) { chHeroObserver.disconnect(); chHeroObserver = null; }
    overlay.classList.remove('ch-io', 'ch-scrolled');
    const topStats = document.getElementById('chTopbarStats');
    if (topStats) topStats.textContent = '';

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
        fetchUniverseTV(universe),
        whenChStyles()
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
