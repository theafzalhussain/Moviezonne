/* tv-perf.js — TV / large-screen runtime performance.
 * Extracted from moviezone.js so that file is no longer the only hotspot.
 * Must load AFTER moviezone.js (uses pauseAutoSlide / resumeAutoSlide).
 */

/* ═══════════════════════════════════════════════════════════════════════════
 *  TV PERFORMANCE & RESPONSIVE LAYOUT  (v1.0)
 *  ─────────────────────────────────────────────────────────────────────────
 *  Ye module TV pe lag / hang / scrolling problem theek karta hai. Kuch bhi
 *  naya "design" nahi banaya — moviezone.css me pehle se maujood optimization
 *  classes ko TV pe actually apply kiya gaya hai (wo likhi gayi thi par TV pe
 *  kabhi lagti hi nahi thi), aur ek CSS bug fix kiya gaya hai.
 *
 *  KYA GALAT THA
 *  ─────────────
 *  1. `low-end-mode` class TV pe kabhi nahi lagti thi.
 *     moviezone.js:64  ->  `if (isMobile) ... add('low-end-mode')`
 *     aur isMobile = !isMzTV() && /Mobi|Android|.../  => TV pe hamesha false.
 *     checkPerformance() bhi TV ko explicitly skip karta hai (line ~6725).
 *     Nateeja: TV, jo sabse weak device hai, ko poora heavy-effect version
 *     milta tha — box-shadows, ::before/::after decorations, staggered
 *     entrance animations, will-change layers. Ye CSS already tayaar thi.
 *
 *  2. 🔴 SCROLLING BUG — asli wajah:
 *     moviezone.css me hai:
 *       .large-screen-mode .movie-card { content-visibility: auto; }
 *     par uske saath `contain-intrinsic-size` nahi diya gaya.
 *     content-visibility:auto offscreen element ka rendering skip karta hai,
 *     aur intrinsic size ke bina uski height 0 ho jaati hai. Matlab grid ki
 *     total height scroll karte waqt badalti rehti hai -> scrollbar jump,
 *     scroll position khud se hilti hai, D-pad focus galat jagah jaata hai.
 *     Yahi "scrolling me issue" hai. Fix: measured intrinsic size dena.
 *
 *  3. `large-screen-mode` sirf `innerWidth >= 1920` pe lagti thi. Bahut se TV
 *     720p/1080p pe 1280 CSS px report karte hain, to unhe `contain` aur
 *     `content-visibility` ka fayda hi nahi milta tha.
 *
 *  4. Carousel autoplay (5.5s interval) tab bhi chalta rehta tha jab user
 *     neeche grid dekh raha hota hai. Har 5.5s me ek full-screen backdrop
 *     swap = TV pe scrolling ke dauraan stutter.
 *
 *  5. TV pe cards unbounded badhte the (infinite scroll). tv-mode.js ka
 *     collectFocusables() har D-pad press pe saare cards walk karta hai, to
 *     300 cards = har button press pe 300-element walk = hang.
 *     MAX_CARDS_TV = 24 aur profile.maxCards define the, par use nahi ho rahe.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function initTVPerformance() {
  'use strict';

  const root = document.documentElement;
  const onTV = () => root.getAttribute('data-mz-tv') === 'true';

  /* tv-mode.js `data-mz-tv-tier` set karta hai: low | mid | high
   * low  = Fire TV, webOS, Tizen, Vidaa, HbbTV, Opera TV  (sabse weak)
   * high = PlayStation, Xbox, Apple TV                    (kaafi powerful)
   * High tier ko poori visual polish milti rahegi — sirf weak TVs pe
   * effects kam karte hain. */
  const tvTier = () => root.getAttribute('data-mz-tv-tier') || 'low';

  /* ─────────────────────────────────────────────────────────────────────
   * 1. TV-only CSS: sirf wo cheezein jo moviezone.css me missing ya galat
   *    hain. Baaki sab kaam existing classes karti hain.
   * ───────────────────────────────────────────────────────────────────── */
  function injectTVCss() {
    if (document.getElementById('mz-tv-perf-css')) return;
    const style = document.createElement('style');
    style.id = 'mz-tv-perf-css';
    style.textContent = `
/* ── FIX A (asli scrolling bug): content-visibility ke saath intrinsic size ──
   Bina iske offscreen card ki height 0 ho jaati hai aur grid ki height scroll
   ke dauraan badalti rehti hai. Asli height runtime pe measure hoti hai. */
html[data-mz-tv="true"].large-screen-mode .movie-card,
html[data-mz-tv="true"] .movie-card {
  contain-intrinsic-size: auto 340px;
}
html[data-mz-tv="true"].large-screen-mode .upcoming-card,
html[data-mz-tv="true"] .upcoming-card {
  contain-intrinsic-size: auto 300px;
}

/* ── FIX B: smooth scrolling TV pe hamesha laggy hoti hai (JS already
   behavior:'auto' bhejta hai, par CSS scroll-behavior usko override kar deti
   hai). Har scroll container pe instant scroll. */
html[data-mz-tv="true"],
html[data-mz-tv="true"] body,
html[data-mz-tv="true"] .movie-grid,
html[data-mz-tv="true"] .upcoming-grid,
html[data-mz-tv="true"] .cat-tabs,
html[data-mz-tv="true"] .related-slider,
html[data-mz-tv="true"] .ch-scroll,
html[data-mz-tv="true"] #modal-overlay,
html[data-mz-tv="true"] .upcoming-detail-overlay,
html[data-mz-tv="true"] .collections-hub-overlay {
  scroll-behavior: auto !important;
}

/* ── FIX C: large-screen-mode navbar pe backdrop-filter ko !important se
   FORCE karti hai (moviezone.css). Blur TV GPU pe sabse mehnga effect hai aur
   navbar sticky hai, to har scroll frame pe re-composite hota hai. */
html[data-mz-tv="true"] #navbar,
html[data-mz-tv="true"].large-screen-mode #navbar,
html[data-mz-tv="true"] .search-results-dropdown,
html[data-mz-tv="true"] .cat-group-menu,
html[data-mz-tv="true"] .mobile-nav-overlay,
html[data-mz-tv="true"] #modal-overlay,
html[data-mz-tv="true"] .modal-box,
html[data-mz-tv="true"] .upcoming-detail-overlay,
html[data-mz-tv="true"] .upcoming-detail-box,
html[data-mz-tv="true"] .collections-hub-overlay,
html[data-mz-tv="true"] .ch-topbar,
html[data-mz-tv="true"] .card-overlay,
html[data-mz-tv="true"] #toast {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* ── FIX D: scroll ke dauraan blur filter recompute = frame drop.
   (Poster ka saturate/contrast rehne diya — wo sasta hai aur focus feedback
   ke liye zaroori hai.) */
html[data-mz-tv="true"] .slide-bg,
html[data-mz-tv="true"] #modalBg,
html[data-mz-tv="true"] .ud-backdrop-img,
html[data-mz-tv="true"] .ch-hero-glow,
html[data-mz-tv="true"] .ch-hero-mosaic-veil {
  filter: none !important;
}

/* ── FIX E: ambient firefly layer aur custom cursor ke 3 elements ab site se
   hi hata diye gaye hain (perf). Sirf collection-hero ka particle canvas bacha
   hai, wo TV pe band. */
html[data-mz-tv="true"] .ch-particle-canvas {
  display: none !important;
}

/* ── FIX F: .reveal-up cards ka opacity:0 tabhi hatta hai jab
   IntersectionObserver .in-view lagata hai. TV pe hum wo observer skip karte
   hain, to yahan opacity force karni zaroori hai — warna card invisible. */
html[data-mz-tv="true"] .reveal-up { opacity: 1 !important; }

/* ── FIX G: sticky navbar ko apni compositing layer do, taaki scroll ke waqt
   uske neeche ka content re-paint na kare. */
html[data-mz-tv="true"] #navbar { transform: translateZ(0); }

/* ── FIX H: 4K / 8K TV pe text 3 meter door se padhne layak rahe.
   moviezone.css me 2500px+ pe font-size 125% hai; usse aage kuch nahi tha. */
@media (min-width: 3400px) {
  html[data-mz-tv="true"] { font-size: 150%; }
  html[data-mz-tv="true"] .movie-grid {
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)) !important;
  }
  html[data-mz-tv="true"] .upcoming-grid {
    grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)) !important;
  }
}
@media (min-width: 5000px) {
  html[data-mz-tv="true"] { font-size: 190%; }
  html[data-mz-tv="true"] .movie-grid {
    grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)) !important;
  }
}`;
    document.head.appendChild(style);
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 2. Existing optimization classes TV pe apply karo
   * ───────────────────────────────────────────────────────────────────── */
  function applyTVClasses() {
    // content-visibility + contain: layout style paint — har TV width pe chahiye,
    // sirf >=1920px pe nahi. (Ab FIX A intrinsic size bhi de raha hai.)
    root.classList.add('large-screen-mode');

    // Heavy effects sirf weak TVs pe band. PlayStation/Xbox/Apple TV (high tier)
    // ko poori polish milti rahegi.
    if (tvTier() !== 'high') root.classList.add('low-end-mode');
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 3. Card ki asli height measure karke intrinsic size set karo.
   *    Ye number galat hone se hi scroll jump hota hai, isliye guess nahi
   *    karte — DOM se padhte hain. Column width badalne pe height badalti
   *    hai, to resize pe dobara measure karte hain.
   * ───────────────────────────────────────────────────────────────────── */
  let measureQueued = false;
  let seenCardH = 0;       // ab tak dekhi gayi sabse BADI card height
  let seenUpcomingH = 0;

  /*  Sirf pehla card measure karna kaafi nahi tha: pehle render pe wo 344px
   *  bata raha tha jabki asli height 500px thi (genres row wrap hone aur image
   *  layout settle hone se pehle). Under-estimate = grid ki height badal-badal
   *  kar scroll jump karti hai. Isliye:
   *    - ek saath 12 cards sample karo aur unme se MAX lo
   *    - baad me dobara measure karo (images load hone ke baad)
   *    - value ko sirf badhne do (sticky max); resize pe reset hoti hai
   *  Grid ke rows stretch hote hain, to sabse tall card hi sahi estimate hai. */
  function sampleMax(selector, limit) {
    const nodes = document.querySelectorAll(selector);
    let max = 0;
    for (let i = 0; i < nodes.length && i < limit; i++) {
      const h = nodes[i].getBoundingClientRect().height;
      if (h > max) max = h;
    }
    return Math.round(max);
  }

  function measureCards() {
    measureQueued = false;
    const h = sampleMax('.movie-card', 12);
    const u = sampleMax('.upcoming-card', 8);
    let grew = false;
    if (h > 40 && h > seenCardH) { seenCardH = h; grew = true; }
    if (u > 40 && u > seenUpcomingH) { seenUpcomingH = u; grew = true; }
    if (grew) writeCardSizes();
  }

  /*  The measured heights reach the cards through a rule on the cards, not a
   *  custom property on <html>. Custom properties inherit, so each write on the
   *  root made every element on the page recompute its style - ~0.65 s per write
   *  on a TV-class CPU (6x throttle), and the sticky max is raised several times
   *  per load. A rule keyed on the card classes restyles the cards and nothing
   *  else. It uses FIX A's most specific selector (start() always adds
   *  .large-screen-mode first) and comes later in the cascade, so it wins. */
  let sizeSheet = null;
  function writeCardSizes() {
    if (!sizeSheet) {
      sizeSheet = document.createElement('style');
      sizeSheet.id = 'mz-tv-card-size';
      document.head.appendChild(sizeSheet);
    }
    const rule = (cls, px) => (px ? 'html[data-mz-tv="true"].large-screen-mode .' + cls + '{contain-intrinsic-size:auto ' + px + 'px}' : '');
    sizeSheet.textContent = rule('movie-card', seenCardH) + rule('upcoming-card', seenUpcomingH);
  }
  function scheduleMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(measureCards);
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 4. Card budget: TV pe DOM ko unbounded badhne se roko.
   *    Cards DELETE nahi karte (wo scroll position aur D-pad focus tod deta
   *    hai). Bas auto-infinite-scroll band karke "Load More" button dikha
   *    dete hain — TV pe ye behtar UX bhi hai (remote se deliberate action)
   *    aur DOM bounded rehta hai.
   * ───────────────────────────────────────────────────────────────────── */
  function tvCardBudget() {
    const tier = tvTier();
    return tier === 'high' ? 60 : tier === 'mid' ? 36 : 24;
  }

  function enforceCardBudget() {
    const grid = document.getElementById('movieGrid');
    const trigger = document.getElementById('infiniteScrollTrigger');
    const loadMoreBtn = document.getElementById('loadMoreMoviesBtn');
    if (!grid || !trigger) return;

    // Search results aur watchlist finite hote hain — unka trigger already
    // chhupa hota hai, usme dakhal nahi dena.
    if (trigger.style.display === 'none' && !trigger.dataset.mzTvBudget) return;

    const cards = grid.getElementsByClassName('movie-card').length;
    const overBudget = cards >= tvCardBudget();

    if (overBudget) {
      trigger.dataset.mzTvBudget = '1';
      trigger.style.display = 'none';
      if (loadMoreBtn) {
        /*  Bina shart ke dikhana ZAROORI hai: loadMovies() har render ke baad
         *  is button ko `display:none` kar deta hai ("Always hide button for
         *  infinite scroll"). Agar hum sirf tab dikhate jab wo hidden ho, to
         *  ek race me button chhupa reh jaata aur trigger bhi hidden hota —
         *  matlab user ke paas aur content load karne ka koi rasta hi nahi
         *  bachta (dead end). */
        loadMoreBtn.style.display = '';
        if (!loadMoreBtn.dataset.mzTvHooked) {
          loadMoreBtn.dataset.mzTvHooked = '1';
          loadMoreBtn.addEventListener('click', () => {
            delete trigger.dataset.mzTvBudget;
            // Safety net: agar naya batch nahi aaya (last page), grid mutate
            // nahi hoga aur observer bhi nahi chalega — to khud dobara check.
            setTimeout(enforceCardBudget, 1200);
          }, { passive: true });
        }
      }
    } else if (trigger.dataset.mzTvBudget) {
      delete trigger.dataset.mzTvBudget;
      trigger.style.display = '';
    }
  }

  /* Grid badalne par (render / load more) budget + measurement refresh karo.
   * MutationObserver sirf render pe fire hota hai, scroll pe nahi — to ye
   * sasta hai. */
  function watchGrid() {
    const grid = document.getElementById('movieGrid');
    if (!grid || typeof MutationObserver !== 'function') return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scheduleMeasure();
        enforceCardBudget();
      });
    }).observe(grid, { childList: true });
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 5. Hero carousel: screen pe na ho to autoplay band.
   *    Pehle ye har 5.5 second me full-screen backdrop swap karta rehta tha
   *    chahe user bahut neeche grid dekh raha ho — TV pe scrolling ke dauraan
   *    saaf stutter aata tha. pauseAutoSlide()/resumeAutoSlide() already
   *    progress bar ko bhi handle karte hain, to sync nahi tootega.
   *    (Ye optimization har device ke liye faydemand hai, sirf TV nahi.)
   * ───────────────────────────────────────────────────────────────────── */
  function pauseCarouselWhenHeroHidden() {
    const hero = document.getElementById('hero');
    if (!hero || typeof IntersectionObserver !== 'function') return;
    if (typeof pauseAutoSlide !== 'function' || typeof resumeAutoSlide !== 'function') return;

    new IntersectionObserver((entries) => {
      const visible = entries[0] && entries[0].isIntersecting;
      if (visible) {
        if (!document.hidden) { try { resumeAutoSlide(); } catch (e) {} }
      } else {
        try { pauseAutoSlide(); } catch (e) {}
      }
    }, { threshold: 0.15 }).observe(hero);
  }

  /* ─────────────────────────────────────────────────────────────────────
   * 6. Boot
   * ───────────────────────────────────────────────────────────────────── */
  let started = false;
  function start() {
    if (started || !onTV()) return;
    started = true;
    injectTVCss();
    applyTVClasses();
    scheduleMeasure();
    watchGrid();
    enforceCardBudget();

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(scheduleMeasure, 250);
    }, { passive: true });

    console.log('[MovieZone TV] performance mode on — tier:', tvTier(), '| card budget:', tvCardBudget());
  }

  // Hero carousel optimization har device pe chalti hai.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pauseCarouselWhenHeroHidden, { once: true });
  } else {
    pauseCarouselWhenHeroHidden();
  }

  start();

  /* tv-mode.js `data-mz-tv` aur `data-mz-tv-tier` async set karta hai (aur
   * baad me tier downgrade bhi kar sakta hai). Isliye attribute changes
   * dekhte rehte hain. */
  if (!started && typeof MutationObserver === 'function') {
    const attrObserver = new MutationObserver(() => {
      if (onTV()) { start(); attrObserver.disconnect(); }
    });
    attrObserver.observe(root, { attributes: true, attributeFilter: ['data-mz-tv', 'data-mz-tv-ready'] });
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (!onTV()) return;
      if (tvTier() !== 'high') root.classList.add('low-end-mode');
      else root.classList.remove('low-end-mode');
    }).observe(root, { attributes: true, attributeFilter: ['data-mz-tv-tier', 'data-mz-tv-downgraded'] });
  }
})();