/*  universes-rail.js — builds the homepage "Cinematic Universe" rail.
 *
 *  WHAT THIS IS FOR
 *  This rail is now the ONLY door to the franchise pages. There used to be two
 *  others — a "Cinematic Universe" item in the navbar and the #collections picker
 *  grid it opened — and both are gone: the grid made every visitor choose a
 *  franchise twice, and the navbar item existed only to reach the grid. A tap
 *  here goes straight to that universe's page (#collections-<slug>).
 *
 *  WHY IT IS A SEPARATE FILE INSTEAD OF LIVING IN moviezone.js
 *  asset-perf-check.js holds moviezone.min.css + moviezone.min.js to a measured
 *  449 KB parse budget and there are roughly 240 bytes of headroom left. A
 *  below-the-fold rail has no claim on that budget, so this file is requested
 *  only after `load` (see the loader at the bottom of index.html).
 *
 *  WHERE THE DATA COMES FROM — AND WHY NONE OF IT IS DUPLICATED HERE
 *  moviezone.js already publishes a read-only handle:
 *
 *      window.__moviezoneCollections = { universeCount, loadCatalog, getUniverse }
 *
 *  loadCatalog() resolves collections-catalog.json (the same force-cached request
 *  the franchise pages make, so this rail adds ZERO network calls beyond its own
 *  tiles' artwork), and getUniverse(slug) returns that universe's real
 *  presentation record — name, badge, tagline, accent, category.
 *
 *  So the ROSTER is read from the catalog and the METADATA from getUniverse():
 *  add a universe to moviezone.js and the catalog, and it appears here on its
 *  own; drop one from both and it disappears from here too. This file cannot
 *  drift out of step, because it does not hold a second copy of the list.
 *
 *  The one thing it does hold is LOCKUPS below — how each franchise's wordmark
 *  is TYPESET. That is presentation local to this rail (the franchise pages show
 *  a small ALL-CAPS badge over key art instead, and reusing those badges here
 *  would put the same studio name on more than one tile).
 *  A slug missing from that table is not a failure: it falls back to the
 *  universe's own name in the neutral gold-white treatment.
 */
(function () {
  'use strict';

  if (window.__mzUniverseRailBuilt) return;
  window.__mzUniverseRailBuilt = true;

  var section = document.getElementById('cinematic-universes');
  var rail = document.getElementById('uvRail');
  if (!section || !rail) return;

  /*  Per-franchise wordmark text. `mark` is the logo line, `sub` the small
   *  tracked line under it — omitted where the franchise name IS the logo
   *  (Terminator, Predator), because a redundant second line just shrinks the mark.
   *  Where a franchise is known by its lead character rather than its universe
   *  name, that character leads and the universe becomes the sub — Singham over
   *  "Cop Universe", Stree over "Maddock Horror".
   *  Keyed by slug; see the header note on why this is not read from `badge`.
   *  Listed in rail order so this table and the catalog read the same way. */
  var LOCKUPS = {
    'mcu':                { mark: 'MARVEL',       sub: 'Cinematic Universe' },
    'dceu':               { mark: 'DC',           sub: 'Universe' },
    'x-men':              { mark: 'X-Men',        sub: 'Mutant Saga' },
    'yrf-spy':            { mark: 'YRF Spy',      sub: 'Universe' },
    'jurassic-park':      { mark: 'Jurassic',     sub: 'Park & World' },
    'cop-universe':       { mark: 'Singham',      sub: 'Cop Universe' },
    'star-wars':          { mark: 'Star Wars',    sub: 'Skywalker Saga' },
    'transformers':       { mark: 'Transformers' },
    'conjuring':          { mark: 'Conjuring',    sub: 'The Universe' },
    'fast-furious':       { mark: 'Fast',         sub: '& Furious' },
    'james-bond':         { mark: '007',          sub: 'James Bond' },
    'terminator':         { mark: 'Terminator' },
    'wizarding-world':    { mark: 'Wizarding',    sub: 'World' },
    'middle-earth':       { mark: 'Middle-earth', sub: 'Rings & Hobbit' },
    'mission-impossible': { mark: 'Impossible',   sub: 'Mission:' },
    'predator':           { mark: 'Predator' },
    'maddock':            { mark: 'Stree',        sub: 'Maddock Horror' }
  };

  var IMG_BASE = 'https://image.tmdb.org/t/p/w300';
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /*  moviezone.js is a `defer` script, so it has always executed by the time the
   *  loader in index.html pulls this file in (load event / IntersectionObserver
   *  callback, both strictly later). The poll is belt-and-braces for the one case
   *  that is not ordered — a manual __mzLoadUniverseRail() from the console or a
   *  future eager loader — and it gives up rather than spinning forever. */
  function whenReady(callback) {
    var api = window.__moviezoneCollections;
    if (api && api.loadCatalog && api.getUniverse) return callback(api);
    var waited = 0;
    var timer = setInterval(function () {
      var ready = window.__moviezoneCollections;
      waited += 120;
      if (ready && ready.loadCatalog && ready.getUniverse) {
        clearInterval(timer);
        callback(ready);
      } else if (waited >= 6000) {
        clearInterval(timer);
        /*  moviezone.js never arrived, which means the whole app is broken and
         *  this row is the least of it. Remove the reserved 168px rather than
         *  leaving a titled, permanently empty section on the page. */
        section.remove();
      }
    }, 120);
  }

  function titleCount(entry) {
    var movies = (entry && entry.movies && entry.movies.length) || 0;
    var series = (entry && entry.tv && entry.tv.length) || 0;
    return movies + series;
  }

  /*  Key art for a tile: the first backdrop in the universe, preferring films
   *  because a franchise's identity image is almost always a film still. Falls
   *  back to a series backdrop, then to no image at all (the tile is still a
   *  complete, readable logo lockup — the art is texture, not content). */
  function keyArt(entry) {
    var lists = [entry.movies || [], entry.tv || []];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        if (lists[i][j] && lists[i][j].backdrop_path) return lists[i][j].backdrop_path;
      }
    }
    return null;
  }

  function buildTile(universe, entry) {
    var lockup = LOCKUPS[universe.slug] || { mark: universe.name };
    var total = titleCount(entry);
    var art = keyArt(entry);
    var label = universe.name + (total ? ' — ' + total + ' titles' : '') + ', open collection';

    var li = document.createElement('li');
    li.innerHTML =
      '<a class="uv-card uv-b-' + esc(universe.accent) + '" href="#collections-' + esc(universe.slug) + '"' +
        ' data-uv-slug="' + esc(universe.slug) + '" aria-label="' + esc(label) + '">' +
        (art ? '<img class="uv-art" src="' + IMG_BASE + art + '" alt="" width="300" height="169"' +
               ' loading="lazy" decoding="async">' : '') +
        '<span class="uv-veil" aria-hidden="true"></span>' +
        '<span class="uv-lockup">' +
          '<span class="uv-mark">' + esc(lockup.mark) + '</span>' +
          (lockup.sub ? '<span class="uv-sub">' + esc(lockup.sub) + '</span>' : '') +
        '</span>' +
      '</a>';

    /*  Fade the art in only once it has decoded. Cached images can complete
     *  before the listener attaches, and a cached FAILURE completes too, so both
     *  events resolve to the same handler and `complete` is checked up front. */
    var img = li.querySelector('.uv-art');
    if (img) {
      var card = li.querySelector('.uv-card');
      var reveal = function () { card.classList.add('uv-art-in'); };
      if (img.complete) reveal();
      else {
        img.addEventListener('load', reveal, { once: true });
        img.addEventListener('error', function () { img.remove(); }, { once: true });
      }
    }
    return li;
  }

  /*  Same behaviour contract as the provider rail: hide the arrows when there is
   *  nothing to scroll, disable the one you cannot use, and publish the overflow
   *  state as an attribute because CSS cannot measure scrollWidth — universes.css
   *  maps [data-edge] to the trailing mask.
   *
   *  The buttons are built HERE rather than shipped in index.html: they are inert
   *  until the tiles exist, and index.html is inside the measured first-paint
   *  transfer budget in asset-perf-check.js, which two 18px SVGs have no business
   *  spending. */
  var ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="';

  function buildArrows() {
    var header = section.querySelector('.uv-header');
    if (!header) return null;
    var controls = document.createElement('div');
    controls.className = 'uv-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Universe carousel');
    controls.hidden = true;
    controls.innerHTML =
      '<button class="uv-arrow" type="button" data-uv-scroll="-1" aria-label="Previous universes"' +
        ' aria-controls="uvRail" disabled>' + ARROW + '15 18 9 12 15 6"></polyline></svg></button>' +
      '<button class="uv-arrow" type="button" data-uv-scroll="1" aria-label="Next universes"' +
        ' aria-controls="uvRail">' + ARROW + '9 18 15 12 9 6"></polyline></svg></button>';
    header.appendChild(controls);
    return controls;
  }

  function initCarousel() {
    var controls = buildArrows();
    var previous = section.querySelector('[data-uv-scroll="-1"]');
    var next = section.querySelector('[data-uv-scroll="1"]');
    var cards = Array.prototype.slice.call(rail.querySelectorAll('.uv-card'));
    var frame = 0;

    function update() {
      frame = 0;
      var maximum = rail.scrollWidth - rail.clientWidth;
      var overflows = maximum > 2;
      var atStart = rail.scrollLeft <= 2;
      var atEnd = rail.scrollLeft >= maximum - 2;
      if (controls) controls.hidden = !overflows;
      if (previous) previous.disabled = atStart;
      if (next) next.disabled = atEnd;
      rail.dataset.edge = !overflows ? 'none' : atStart ? 'end' : atEnd ? 'start' : 'both';
    }

    section.addEventListener('click', function (event) {
      var button = event.target.closest('[data-uv-scroll]');
      if (button && !button.disabled) {
        rail.scrollBy({
          left: Number(button.dataset.uvScroll) * rail.clientWidth * 0.85,
          behavior: reducedMotion ? 'instant' : 'smooth'
        });
        return;
      }
      var card = event.target.closest('[data-uv-slug]');
      if (!card) return;
      /*  Modified clicks and middle clicks are left alone deliberately: the href
       *  is a real deep link, so "open in new tab" has to keep working. */
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      /*  openCollectionsHub(event, slug) opens that universe's page and pushes a
       *  single #collections-<slug> entry, so Back returns to the homepage. It
       *  used to push #collections first so Back landed on the picker grid; the
       *  grid is gone, and so is that second entry. */
      if (typeof window.openCollectionsHub === 'function') {
        window.openCollectionsHub(event, card.dataset.uvSlug);
      } else {
        window.location.hash = 'collections-' + card.dataset.uvSlug;
      }
    });

    /*  Roving arrow keys inside the rail. Without this, tabbing to a tile and
     *  pressing ArrowRight scrolls the PAGE while focus stays put, which on a
     *  horizontally-scrolling row is disorienting. */
    rail.addEventListener('keydown', function (event) {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      var index = cards.indexOf(event.target.closest('.uv-card'));
      if (index < 0) return;
      var target = index;
      if (event.key === 'ArrowRight') target = Math.min(index + 1, cards.length - 1);
      else if (event.key === 'ArrowLeft') target = Math.max(index - 1, 0);
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = cards.length - 1;
      else return;
      event.preventDefault();
      cards[target].focus({ preventScroll: true });
      cards[target].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion ? 'instant' : 'smooth' });
    });

    rail.addEventListener('scroll', function () {
      if (!frame) frame = requestAnimationFrame(update);
    }, { passive: true });

    if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(rail);
    else window.addEventListener('resize', update, { passive: true });
    update();
  }

  whenReady(function (api) {
    api.loadCatalog().then(function (catalog) {
      var slugs = Object.keys(catalog || {});
      var fragment = document.createDocumentFragment();
      var built = 0;
      var titles = 0;

      slugs.forEach(function (slug) {
        var universe = api.getUniverse(slug);
        /*  A catalog entry with no presentation record is a data error, not
         *  something to render as a blank tile — without a record there is no
         *  name, accent or tagline, and its franchise page could not render
         *  either, since openUniverse() resolves the same UNIVERSES array. */
        if (!universe) return;
        fragment.appendChild(buildTile(universe, catalog[slug]));
        titles += titleCount(catalog[slug]);
        built++;
      });

      if (!built) { section.remove(); return; }
      rail.innerHTML = '';
      rail.appendChild(fragment);

      /*  Scale, stated rather than implied. The row shows five or six tiles at a
       *  time out of seventeen, so without a number the visitor has no idea whether
       *  scrolling right is worth it. Both figures are counted from what actually
       *  rendered — never hardcoded — so they cannot go stale when a franchise is
       *  added or retired. */
      var subtitle = section.querySelector('.uv-subtitle');
      if (subtitle && built > 1) {
        subtitle.textContent = built + ' universes · ' + titles.toLocaleString('en-US') +
          ' titles — jump straight in.';
      }

      initCarousel();
    }).catch(function (error) {
      /*  The catalog is one static file behind the same CDN as the page, so this
       *  is close to unreachable — but an empty titled section with 168px of
       *  reserved height is worse than no section, so the row removes itself. */
      console.warn('[MovieZone] Cinematic Universe rail unavailable:', error && error.message);
      section.remove();
    });
  });
})();
