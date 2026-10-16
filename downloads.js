/*  downloads.js — the watch page's Download sheet.
 *
 *  WHAT IT IS
 *  The modal's Download button used to open one server (VidVault) in a new tab.
 *  It now opens this sheet, which lists every download server on the Olly Embed
 *  roster — the same four, in the same order and under the same D1-D4 badges that
 *  ollyembed.pages.dev shows in its own "Download options" (its
 *  /api/download-servers answers with exactly these four). Each row is a real
 *  <a target="_blank"> built for the title — or, for a series, for the season and
 *  episode picked in the episode picker — so it behaves like any link: middle-click,
 *  long-press and "open in new tab" all work, and no popup blocker is involved.
 *  A series also gets an episode stepper, so several episodes can be fetched from
 *  one sheet without touching the page's own picker (which would reload a running
 *  player).
 *
 *  WHAT EACH SERVER DID WHEN MEASURED (Oct 2026, real Chrome, movie and series)
 *    D1 02Downloader  a slide-to-verify + Turnstile check, then it gathers every
 *                     source it knows, which can take up to a minute.
 *    D2 NxSha         a one-line maths check, then HubCloud / Pixeldrain / HubCDN /
 *                     HubDrive links at 480p-1080p, 4K where the title has it, with
 *                     Hindi + English audio.
 *    D3 VidSync       its origin was down (Cloudflare 522). Kept because it is the
 *                     backup Olly lists, and an unused row costs nothing.
 *    D4 VidVault      direct 360p-1080p files with their sizes; the download starts
 *                     straight away. (The old button pointed at vidvault.ru, which
 *                     only 301s to vidvault.to.)
 *  The line under each name says the same thing, so a viewer knows what the next
 *  tab will ask of them before opening it.
 *
 *  WHY IT IS A SEPARATE FILE
 *  Only a click needs it, and asset-perf-check.js holds the first-paint bundles to
 *  a measured brotli budget with about 1 KB of headroom. moviezone.js keeps a small
 *  loader (loadDownloads) that requests this file the first time the button is
 *  hovered, focused, touched or clicked. The CSS travels inside this file, so the
 *  sheet can never paint unstyled and there is one request, not two.
 *
 *  WHY THE SHEET IS A CHILD OF <body>, NOT OF #modal-overlay
 *  On TV, tv-mode.css gives the overlay `contain: layout style paint`, which makes it
 *  the containing block of every position:fixed descendant: a sheet inside it would
 *  scroll away with the overlay's content. So it sits in <body>, above the overlay
 *  (z-index 9500 against 9000).
 *
 *  WHY IT HANDLES THE REMOTE ITSELF
 *  tv-mode.js caches its focus candidates and rebuilds them on a scope change, a
 *  resize or an inserted focusable — not when a sheet is un-hidden — so its D-pad
 *  would keep walking the page under the sheet. While the sheet is open, a
 *  capture-phase key handler on window (which runs before tv-mode's and
 *  moviezone.js's document-level ones) moves focus between the rows itself and
 *  treats Back/Escape as "close the sheet" rather than "close the watch page". The
 *  scroll lock is a class on <html> rather than on #modal-overlay on purpose:
 *  tv-mode.js watches the overlay's class list and re-focuses into it on change.
 */
(function () {
  'use strict';

  if (window.MZDownloads) return;

  /*  Olly Embed's roster. {id} is the TMDB id, {s}/{e} the season and episode.
   *  a/b are the badge gradient — Olly's own colour for each server. */
  var SERVERS = [
    {
      tag: 'D1', name: '02Downloader', a: '#a855f7', b: '#6366f1',
      note: 'Searches every source it knows \u2014 can take up to a minute',
      chips: ['Many sources', 'Human check'],
      movie: 'https://02moviedownloader.site/api/download/movie/{id}',
      tv: 'https://02moviedownloader.site/api/download/tv/{id}/{s}/{e}'
    },
    {
      tag: 'D2', name: 'NxSha', a: '#f97316', b: '#e11d48', flag: 'Best quality',
      note: 'HubCloud, Pixeldrain and HubDrive mirrors',
      chips: ['480p\u20134K', 'Hindi + English'],
      movie: 'https://nxsha.space/dl/movie/{id}',
      tv: 'https://nxsha.space/dl/tv/{id}/{s}/{e}'
    },
    {
      tag: 'D3', name: 'VidSync', a: '#22c55e', b: '#059669',
      note: 'Backup mirror \u2014 for when the others are busy',
      chips: ['Backup'],
      movie: 'https://vidsync.pro/embed/download/movie/{id}',
      tv: 'https://vidsync.pro/embed/download/tv/{id}/{s}/{e}'
    },
    {
      tag: 'D4', name: 'VidVault', a: '#0ea5e9', b: '#2563eb', flag: 'Fastest',
      note: 'Direct file \u2014 the download starts straight away',
      chips: ['360p\u20131080p', 'File sizes shown'],
      movie: 'https://vidvault.to/movie/{id}',
      tv: 'https://vidvault.to/tv/{id}/{s}/{e}'
    }
  ];

  /*  Spacing is margins rather than flex `gap` (Chromium 84+), centring is flex
   *  rather than `place-items`, and offsets are spelled out rather than `inset`:
   *  the TV engines this site supports predate all three. Sizes are rem so the TV
   *  root scale (108-190%) carries the sheet like the rest of the page. */
  var CSS = [
    '.dl-sheet{position:fixed;top:0;right:0;bottom:0;left:0;z-index:9500;display:flex;align-items:center;justify-content:center;padding:1rem}',
    '.dl-sheet[hidden]{display:none}',
    'html.mz-dl-open #modal-overlay{overflow:hidden}',
    '.dl-scrim{position:absolute;top:0;right:0;bottom:0;left:0;background:rgba(3,3,10,.76);animation:dlFade .2s ease both}',
    '.dl-card{position:relative;box-sizing:border-box;width:100%;max-width:35rem;max-height:100%;overflow-y:auto;overscroll-behavior:contain;',
    'padding:1.375rem 1.375rem 1.125rem;border-radius:1.375rem;color:#fff;background:linear-gradient(180deg,#161628 0%,#0b0b16 100%);',
    'border:1px solid rgba(255,255,255,.1);box-shadow:0 2rem 5rem rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.06);',
    'animation:dlRise .28s cubic-bezier(.16,1,.3,1) both}',
    '.dl-head{display:flex;align-items:center;margin-bottom:1rem}',
    '.dl-icon{flex:none;display:flex;align-items:center;justify-content:center;width:2.875rem;height:2.875rem;margin-right:.875rem;',
    'border-radius:.875rem;color:#10b981;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.34)}',
    '.dl-titles{flex:1;min-width:0}',
    '.dl-title{margin:0;font-size:1.25rem;font-weight:700;line-height:1.2;letter-spacing:.01em}',
    '.dl-sub{margin:.2rem 0 0;font-size:.85rem;color:rgba(255,255,255,.64);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dl-x,.dl-ep-btn{flex:none;display:flex;align-items:center;justify-content:center;padding:0;color:#fff;cursor:pointer;font:inherit;',
    'border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);transition:background .2s,border-color .2s,opacity .2s}',
    '.dl-x{width:2.5rem;height:2.5rem;margin-left:.75rem;border-radius:.75rem}',
    '.dl-x:hover,.dl-ep-btn:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.26)}',
    '.dl-ep{display:flex;align-items:center;margin:0 0 .875rem;padding:.375rem;border-radius:.875rem;',
    'background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}',
    '.dl-ep[hidden],.dl-ep-btn[hidden]{display:none}',
    '.dl-ep-btn{width:2.25rem;height:2.25rem;border-radius:.625rem}',
    '.dl-ep-btn[aria-disabled=true]{opacity:.32;cursor:default}',
    '.dl-ep-label{flex:1;min-width:0;padding:0 .625rem;text-align:center;font-size:.875rem;color:rgba(255,255,255,.78);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dl-ep-label b{color:var(--gold,#ffc107);font-weight:700}',
    '.dl-list{list-style:none;margin:0;padding:0}',
    '.dl-list li+li{margin-top:.625rem}',
    '.dl-row{display:flex;align-items:center;padding:.75rem .875rem;border-radius:1rem;color:#fff;text-decoration:none;',
    'background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);transition:transform .2s,background .2s,border-color .2s}',
    '.dl-row:hover{background:rgba(255,255,255,.07);border-color:var(--dl-a);transform:translateY(-1px)}',
    '.dl-row:focus-visible{background:rgba(255,255,255,.07)}',
    '.dl-badge{flex:none;display:flex;align-items:center;justify-content:center;width:2.875rem;height:2.875rem;margin-right:.875rem;',
    'border-radius:.8rem;font-weight:800;font-size:.95rem;letter-spacing:.04em;',
    'background:linear-gradient(135deg,var(--dl-a),var(--dl-b));box-shadow:0 .4rem 1.1rem -.4rem var(--dl-a)}',
    '.dl-main{flex:1;min-width:0}',
    '.dl-name{display:flex;align-items:center;flex-wrap:wrap;font-weight:700;font-size:1rem;line-height:1.25}',
    '.dl-flag{margin-left:.5rem;padding:.12rem .5rem;border-radius:999px;font-size:.62rem;font-weight:800;letter-spacing:.05em;',
    'text-transform:uppercase;color:#120d00;background:var(--gold,#ffc107)}',
    '.dl-note{display:block;margin-top:.15rem;font-size:.8rem;line-height:1.35;color:rgba(255,255,255,.64)}',
    '.dl-chips{display:flex;flex-wrap:wrap;margin-top:.15rem}',
    '.dl-chips span{margin:.2rem .35rem 0 0;padding:.1rem .5rem;border-radius:999px;font-size:.7rem;font-weight:600;',
    'color:rgba(255,255,255,.86);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}',
    '.dl-go{flex:none;display:flex;align-items:center;justify-content:center;width:2.125rem;height:2.125rem;margin-left:.75rem;',
    'border-radius:50%;color:rgba(255,255,255,.72);background:rgba(255,255,255,.05);transition:transform .2s,background .2s,color .2s}',
    '.dl-row:hover .dl-go,.dl-row:focus-visible .dl-go{color:#fff;background:var(--dl-a);transform:translateX(2px)}',
    '.dl-foot{margin:.875rem .125rem 0;font-size:.75rem;line-height:1.5;color:rgba(255,255,255,.52)}',
    '@keyframes dlFade{from{opacity:0}}',
    '@keyframes dlRise{from{opacity:0;transform:translateY(.875rem) scale(.98)}}',
    '@keyframes dlUp{from{transform:translateY(100%)}}',
    /*  Phones: a bottom sheet with a grab handle, full width, inside the safe area. */
    '@media (max-width:640px){',
    '.dl-sheet{align-items:flex-end;padding:0}',
    '.dl-card{max-width:none;max-height:88vh;max-height:88dvh;padding:.625rem 1rem 1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom));',
    'border-radius:1.375rem 1.375rem 0 0;border-bottom:0;animation-name:dlUp}',
    '.dl-card:before{content:"";display:block;width:2.6rem;height:.25rem;margin:0 auto .75rem;border-radius:.125rem;background:rgba(255,255,255,.22)}',
    '.dl-row{padding:.6875rem .75rem}',
    '.dl-badge{width:2.625rem;height:2.625rem;margin-right:.75rem}',
    '.dl-go{width:1.875rem;height:1.875rem;margin-left:.5rem}',
    '}',
    '@media (prefers-reduced-motion:reduce){.dl-scrim,.dl-card{animation:none}.dl-row,.dl-go{transition:none}}',
    /*  TV: no entrance motion (tv-mode.css drops it for the modal too), and the
     *  focused row is lit, because a remote has no hover state to lean on. The radii
     *  are restated because tv-mode.css's `:focus` rule sets border-radius:inherit,
     *  which would square off whatever is focused here. */
    'html[data-mz-tv=true] .dl-scrim,html[data-mz-tv=true] .dl-card{animation:none}',
    'html[data-mz-tv=true] .dl-row:focus{border-radius:1rem;background:rgba(255,193,7,.1);border-color:var(--gold,#ffc107)}',
    'html[data-mz-tv=true] .dl-x:focus{border-radius:.75rem}',
    'html[data-mz-tv=true] .dl-ep-btn:focus{border-radius:.625rem}'
  ].join('');

  var SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ';
  var ICON_DL = SVG + 'width="22" height="22" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';
  var ICON_X = SVG + 'width="18" height="18" stroke-width="2.2"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_GO = SVG + 'width="16" height="16" stroke-width="2.2"><path d="M7 17 17 7M8 7h9v9"/></svg>';
  var ICON_PREV = SVG + 'width="18" height="18" stroke-width="2.4"><path d="m15 18-6-6 6-6"/></svg>';
  var ICON_NEXT = SVG + 'width="18" height="18" stroke-width="2.4"><path d="m9 18 6-6-6-6"/></svg>';

  // Used only when tv-mode.js (which owns the full remote key table) is absent.
  var FALLBACK_KEYS = {
    Escape: 'back', Esc: 'back', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Up: 'up', Down: 'down', Left: 'left', Right: 'right'
  };

  /*  Actions that keep their normal handling while the sheet is open: OK/Enter
   *  activates the focused row natively, the media keys still drive a player that
   *  is running underneath, and Exit still leaves the app. Every other mapped key
   *  (arrows, Back, Page/Channel, Home, Search, the colour keys) is consumed here,
   *  because tv-mode.js would otherwise act on the page under the sheet. */
  var PASS_THROUGH = {
    ok: 1, play: 1, pause: 1, playPause: 1, stop: 1, forward: 1, rewind: 1, next: 1, previous: 1, exit: 1
  };

  var sheet = null;    // the .dl-sheet root, built on first open
  var state = null;    // { id, type, title, year, s, e, episodes: [{ n, name }] }
  var opener = null;   // the button that opened the sheet; focus returns to it
  var shown = false;

  function int(v) {
    var n = parseInt(v, 10);
    return n > 0 ? n : 1;
  }

  function q(sel) { return sheet.querySelector(sel); }

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (err) { try { el.focus(); } catch (e) {} }
  }

  function linkFor(server) {
    var tpl = state.type === 'tv' ? server.tv : server.movie;
    return tpl.replace('{id}', encodeURIComponent(state.id)).replace('{s}', state.s).replace('{e}', state.e);
  }

  function rowHTML(server) {
    return '<li><a class="dl-row" href="#" target="_blank" rel="noopener" style="--dl-a:' + server.a + ';--dl-b:' + server.b + '">' +
      '<span class="dl-badge">' + server.tag + '</span>' +
      '<span class="dl-main">' +
        '<span class="dl-name">' + server.name + (server.flag ? '<span class="dl-flag">' + server.flag + '</span>' : '') + '</span>' +
        '<span class="dl-note">' + server.note + '</span>' +
        '<span class="dl-chips">' + server.chips.map(function (c) { return '<span>' + c + '</span>'; }).join('') + '</span>' +
      '</span>' +
      '<span class="dl-go" aria-hidden="true">' + ICON_GO + '</span>' +
      '<span class="visually-hidden"> (opens in a new tab)</span>' +
    '</a></li>';
  }

  function build() {
    var style = document.createElement('style');
    style.id = 'mzDownloadsCss';
    style.textContent = CSS;
    document.head.appendChild(style);

    sheet = document.createElement('div');
    sheet.className = 'dl-sheet';
    sheet.id = 'dlSheet';
    sheet.hidden = true;
    sheet.innerHTML =
      '<div class="dl-scrim" data-dl-close></div>' +
      '<div class="dl-card" role="dialog" aria-modal="true" aria-labelledby="dlTitle" aria-describedby="dlSub">' +
        '<div class="dl-head">' +
          '<span class="dl-icon">' + ICON_DL + '</span>' +
          '<div class="dl-titles"><h2 class="dl-title" id="dlTitle">Download</h2><p class="dl-sub" id="dlSub"></p></div>' +
          '<button type="button" class="dl-x" data-dl-close aria-label="Close downloads">' + ICON_X + '</button>' +
        '</div>' +
        '<div class="dl-ep" hidden>' +
          '<button type="button" class="dl-ep-btn" data-dl-step="-1" aria-label="Previous episode">' + ICON_PREV + '</button>' +
          '<span class="dl-ep-label" aria-live="polite"></span>' +
          '<button type="button" class="dl-ep-btn" data-dl-step="1" aria-label="Next episode">' + ICON_NEXT + '</button>' +
        '</div>' +
        '<ul class="dl-list">' + SERVERS.map(rowHTML).join('') + '</ul>' +
        '<p class="dl-foot">Each server opens in a new tab. Some ask for a quick human check first \u2014 ' +
          'if one is slow or busy, try the next.</p>' +
      '</div>';
    document.body.appendChild(sheet);

    sheet.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-dl-close]')) { close(); return; }
      var stepBtn = t.closest('[data-dl-step]');
      if (stepBtn) step(Number(stepBtn.getAttribute('data-dl-step')));
    });

    // Ahead of tv-mode.js and moviezone.js: both listen on document, capture phase.
    window.addEventListener('keydown', onKey, true);

    // Nothing behind an aria-modal sheet may hold focus (a mouse click on the page,
    // tv-mode re-focusing an overlay, a script); hand it back to the first row.
    // An install prompt on top is the exception: it is allowed to take focus.
    document.addEventListener('focusin', function (ev) {
      if (shown && !sheet.contains(ev.target) && !promptOnTop()) focusEl(q('.dl-row'));
    }, true);

    /*  Whatever closes the watch page — the Back key, a history pop, a bfcache
     *  restore resetting the surface — takes the sheet with it, so it can never
     *  reappear over the next title. */
    var overlay = document.getElementById('modal-overlay');
    if (overlay && typeof MutationObserver === 'function') {
      new MutationObserver(function () {
        if (shown && !overlay.classList.contains('open')) close(true);
      }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }
  }

  function episodeIndex() {
    for (var i = 0; i < state.episodes.length; i++) {
      if (state.episodes[i].n === state.e) return i;
    }
    return -1;
  }

  function setStepper(btn, enabled, visible) {
    btn.hidden = !visible;
    // aria-disabled rather than disabled: a disabled button drops the focus it holds,
    // which would strand a remote at the first or last episode.
    btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  function render() {
    var rows = sheet.querySelectorAll('.dl-row');
    for (var i = 0; i < rows.length; i++) rows[i].setAttribute('href', linkFor(SERVERS[i]));

    var tv = state.type === 'tv';
    q('.dl-sub').textContent = (state.title || 'This title') + (state.year ? ' \u00b7 ' + state.year : '');

    var bar = q('.dl-ep');
    bar.hidden = !tv;
    if (!tv) return;
    var at = episodeIndex();
    var name = at >= 0 ? state.episodes[at].name : '';
    var label = q('.dl-ep-label');
    label.textContent = name ? ' \u00b7 ' + name : '';
    var se = document.createElement('b');
    se.textContent = 'S' + state.s + ' \u00b7 E' + state.e;
    label.insertBefore(se, label.firstChild);
    var stepping = state.episodes.length > 1;
    setStepper(bar.firstChild, at > 0, stepping);
    setStepper(bar.lastChild, at >= 0 && at < state.episodes.length - 1, stepping);
  }

  function step(delta) {
    var at = episodeIndex();
    var next = at >= 0 ? state.episodes[at + delta] : null;
    if (!next) return;
    state.e = next.n;
    render();
  }

  function focusables() {
    var nodes = sheet.querySelectorAll('button, a[href]');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].hidden && !nodes[i].closest('[hidden]')) out.push(nodes[i]);
    }
    return out;
  }

  function swallow(ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }

  /*  The install prompts (pwa-install.js) can open over anything on a timer and sit
   *  above this sheet (z-index 9999). While one is up it owns the keys and the focus:
   *  Back dismisses the prompt first, exactly as tv-mode.js orders it, and the sheet
   *  takes over again once the prompt is gone. */
  function promptOnTop() {
    return !!document.querySelector('#pwa-install-tv-overlay.open, #pwa-install-overlay.open');
  }

  function onKey(ev) {
    if (!shown || ev.altKey || ev.ctrlKey || ev.metaKey || promptOnTop()) return;
    var action;
    if (ev.key === 'Tab') {
      action = ev.shiftKey ? 'prev' : 'next';
    } else {
      var tv = window.MovieZoneTV;
      action = tv && typeof tv.mapRemoteKey === 'function' ? tv.mapRemoteKey(ev) : FALLBACK_KEYS[ev.key];
    }
    if (!action) return;
    /*  A held OK/Enter auto-repeats, and the press that opened the sheet lands focus
     *  on the first row while the key may still be down. Current Chromium ignores
     *  repeats on a link, but the TV engines this site supports are not all current
     *  Chromium, so a row is only ever opened by a deliberate press. */
    if (action === 'ok' && ev.repeat) { swallow(ev); return; }
    if (PASS_THROUGH[action]) return;
    swallow(ev);
    if (action === 'back') { close(); return; }

    var list = focusables();
    var cur = document.activeElement;
    var at = list.indexOf(cur);
    var to = null;
    if (action === 'up' || action === 'down' || action === 'prev' || action === 'next') {
      var dir = (action === 'up' || action === 'prev') ? -1 : 1;
      if (at < 0) to = list[0];
      else if (action === 'prev' || action === 'next') to = list[(at + dir + list.length) % list.length]; // Tab wraps
      else to = list[at + dir] || null;                                                                     // the D-pad stops at the ends
    } else if ((action === 'left' || action === 'right') && cur && cur.classList && cur.classList.contains('dl-ep-btn')) {
      // Sideways only means something on the episode stepper: it hops between its
      // two buttons. Anywhere else the press is simply consumed.
      var sib = action === 'left' ? cur.previousElementSibling : cur.nextElementSibling;
      while (sib && !(sib.classList.contains('dl-ep-btn') && !sib.hidden)) {
        sib = action === 'left' ? sib.previousElementSibling : sib.nextElementSibling;
      }
      to = sib;
    }
    if (to) focusEl(to);
  }

  /*  ctx: { id, type: 'movie'|'tv', title, year, s, e, episodes: [{ n, name }], opener } */
  function open(ctx) {
    if (!ctx || !ctx.id) return;
    if (!sheet) build();
    var episodes = [];
    var list = ctx.episodes || [];
    for (var i = 0; i < list.length; i++) {
      var n = parseInt(list[i] && list[i].n, 10);
      if (n > 0) episodes.push({ n: n, name: String(list[i].name || '') });
    }
    state = {
      id: ctx.id,
      type: ctx.type === 'tv' ? 'tv' : 'movie',
      title: String(ctx.title || ''),
      year: String(ctx.year || ''),
      s: int(ctx.s),
      e: int(ctx.e),
      episodes: episodes
    };
    render();

    if (opener && opener !== ctx.opener) opener.setAttribute('aria-expanded', 'false');
    opener = ctx.opener || null;
    if (opener) opener.setAttribute('aria-expanded', 'true');
    sheet.hidden = false;
    shown = true;
    document.documentElement.classList.add('mz-dl-open');
    focusEl(q('.dl-row'));
  }

  /*  quiet: the watch page itself is closing, so focus must not be pulled back to a
   *  button that is about to disappear. */
  function close(quiet) {
    if (!shown) return;
    shown = false;
    sheet.hidden = true;
    document.documentElement.classList.remove('mz-dl-open');
    if (opener) {
      opener.setAttribute('aria-expanded', 'false');
      if (!quiet && document.documentElement.contains(opener)) focusEl(opener);
    }
    opener = null;
  }

  window.MZDownloads = {
    open: open,
    close: close,
    isOpen: function () { return shown; }
  };
})();
