/*  mz-extras.js — WhatsApp share button + voice search.
 *
 *  WHY A SEPARATE, DEFERRED FILE
 *  asset-perf-check.js holds the first-paint set to a measured brotli budget,
 *  and neither of these is needed to paint the page: the share button and the
 *  mic only matter once the visitor is looking around. index.html requests this
 *  file at idle after `load`, exactly like universes-rail.js, so it costs the
 *  first paint nothing. Its CSS is injected from here for the same reason — one
 *  request, no second stylesheet to version.
 *
 *  WHAT IT READS FROM moviezone.js
 *  Only `currentModalMovie` (the title whose detail view is open) and the
 *  #searchInput field. Both are read defensively: if either is missing this
 *  file degrades to "share the homepage" and "no mic", never to an error.
 *
 *  1. WHATSAPP SHARE (floating button, bottom-right)
 *     Shares the title that is open in the detail view, as its real SEO page
 *     (/movie/<id>-<slug>), or the homepage when nothing is open. Those pages
 *     are server-rendered with Open Graph tags, so WhatsApp shows the poster
 *     and title as a rich preview. Hidden on TVs (no WhatsApp there) and while
 *     the player is running, so it never sits on top of video controls.
 *
 *  2. VOICE SEARCH (mic button inside the search box)
 *     Built for TV remotes as much as phones: typing a title with a D-pad on
 *     an on-screen keyboard is the slowest thing a TV user does. Uses the
 *     browser's own speech recognition, so there is no audio upload of ours and
 *     no API key. Feature-detected: on a browser without speech recognition
 *     the mic is simply not shown. en-IN is used because it transcribes
 *     Indian titles (Pushpa, Kalki, Bhool Bhulaiyaa) in Latin script, which is
 *     what the search index matches; hi-IN would return Devanagari.
 */
(function () {
  'use strict';

  if (window.__mzExtras) return;
  window.__mzExtras = true;

  var SITE = 'https://moviezone.dev';
  var root = document.documentElement;
  var isTV = root.getAttribute('data-mz-tv') === 'true';

  // Same slug rules as seo-ssr.js slugify(), so the shared URL is the canonical
  // one. A mismatch would still work (the server 301s to the canonical slug),
  // but WhatsApp would then cache the preview of the redirect hop.
  function slugify(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['\u2019\u2018]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '');
  }

  var css = [
    /* ── WhatsApp floating button ── */
    '.mz-wa-fab{position:fixed;right:24px;bottom:24px;z-index:9050;display:flex;align-items:center;gap:0;',
    'height:56px;min-width:56px;padding:0;border-radius:999px;text-decoration:none;color:#fff;',
    'background:radial-gradient(120% 120% at 30% 20%,rgba(255,255,255,.10) 0%,rgba(255,255,255,0) 55%),linear-gradient(180deg,#1b1b2a 0%,#0b0b14 100%);',
    'border:1px solid rgba(255,255,255,.10);box-shadow:0 10px 28px -8px rgba(0,0,0,.75),0 0 0 1px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);',
    'opacity:0;transform:translateY(14px) scale(.92);pointer-events:none;',
    'transition:opacity .35s ease,transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .25s ease,border-color .25s ease,background-color .25s ease;-webkit-tap-highlight-color:transparent}',
    '.mz-wa-fab.is-ready{opacity:1;transform:none;pointer-events:auto}',
    '.mz-wa-fab.is-hidden{opacity:0;transform:translateY(14px) scale(.92);pointer-events:none}',
    '.mz-wa-ico{display:grid;place-items:center;width:56px;height:56px;flex:none}',
    '.mz-wa-ico svg{width:26px;height:26px;fill:currentColor;transition:fill .25s ease,transform .25s ease}',
    '.mz-wa-label{max-width:0;overflow:hidden;white-space:nowrap;font:600 14px/1 Outfit,system-ui,sans-serif;letter-spacing:.01em;',
    'transition:max-width .35s cubic-bezier(.2,.8,.2,1),padding .35s ease;padding:0}',
    '@media (hover:hover){.mz-wa-fab:hover{border-color:rgba(37,211,102,.55);box-shadow:0 14px 34px -10px rgba(0,0,0,.8),0 0 0 1px rgba(37,211,102,.35),0 10px 30px -10px rgba(37,211,102,.55)}',
    '.mz-wa-fab:hover .mz-wa-ico svg{fill:#25D366;transform:scale(1.06)}',
    '.mz-wa-fab:hover .mz-wa-label{max-width:200px;padding-right:20px}}',
    '.mz-wa-fab:focus-visible{outline:2px solid #25D366;outline-offset:3px}',
    '.mz-wa-fab:focus-visible .mz-wa-ico svg{fill:#25D366}',
    '.mz-wa-fab:active{transform:scale(.95)}',
    /* Phones: sit above the bottom tab bar (and the iOS home indicator). */
    '@media (max-width:768px){.mz-wa-fab{right:16px;bottom:calc(78px + env(safe-area-inset-bottom,0px));height:52px;min-width:52px}',
    '.mz-wa-ico{width:52px;height:52px}.mz-wa-ico svg{width:24px;height:24px;fill:#25D366}}',
    '@media (prefers-reduced-motion:reduce){.mz-wa-fab,.mz-wa-label,.mz-wa-ico svg{transition:none}}',

    /* ── Voice search: mic button inside the search box ── */
    /* The field is a block with an absolutely placed icon (left), Ctrl-K hint
       and clear button (right), so the mic takes the right corner and those two
       move inward; the input reserves the extra room on its right only, so the
       per-breakpoint left padding in moviezone.css is untouched. */
    '.nav-search.has-mic input{padding-right:4.7rem}',
    '@media (max-width:1200px){.nav-search.has-mic input{padding-right:4.3rem}}',
    '.nav-search.has-mic .nav-kbd{right:42px}',
    '.nav-search.has-mic .mz-search-clear{right:42px}',
    '.mz-mic{position:absolute;right:7px;top:50%;transform:translateY(-50%);z-index:3;display:grid;place-items:center;width:30px;height:30px;margin:0;padding:0;border:0;border-radius:50%;',
    'background:transparent;color:rgba(226,226,244,.72);cursor:pointer;transition:background-color .2s ease,color .2s ease,box-shadow .2s ease}',
    '.mz-mic svg{width:17px;height:17px}',
    '.mz-mic:hover,.mz-mic:focus-visible{color:#f5c518;background:rgba(245,197,24,.12);outline:none;box-shadow:0 0 0 1px rgba(245,197,24,.35)}',
    '.mz-mic.is-live{color:#0b0b14;background:#f5c518}',

    /* ── Voice search: listening sheet ── */
    '.mz-voice{position:fixed;inset:0;z-index:9100;display:grid;place-items:center;background:rgba(4,4,10,.72);',
    '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);opacity:0;transition:opacity .2s ease}',
    '.mz-voice.is-open{opacity:1}',
    '.mz-voice-card{width:min(92vw,460px);padding:34px 28px 28px;border-radius:24px;text-align:center;color:#fff;',
    'background:radial-gradient(120% 80% at 50% 0%,rgba(245,197,24,.10) 0%,rgba(245,197,24,0) 60%),linear-gradient(180deg,#171726 0%,#0b0b14 100%);',
    'border:1px solid rgba(245,197,24,.22);box-shadow:0 30px 80px -20px rgba(0,0,0,.9)}',
    '.mz-voice-orb{position:relative;width:92px;height:92px;margin:0 auto 22px;border-radius:50%;display:grid;place-items:center;',
    'color:#0b0b14;background:linear-gradient(180deg,#ffd84d,#f5a518);box-shadow:0 0 0 0 rgba(245,197,24,.45)}',
    '.mz-voice-orb svg{width:38px;height:38px}',
    '.mz-voice.is-listening .mz-voice-orb{animation:mzVoicePulse 1.4s ease-out infinite}',
    '@keyframes mzVoicePulse{0%{box-shadow:0 0 0 0 rgba(245,197,24,.5)}100%{box-shadow:0 0 0 26px rgba(245,197,24,0)}}',
    '.mz-voice-title{margin:0 0 8px;font:700 22px/1.25 Outfit,system-ui,sans-serif;letter-spacing:-.01em}',
    '.mz-voice-text{min-height:24px;margin:0 0 20px;font:500 16px/1.45 Outfit,system-ui,sans-serif;color:rgba(226,226,244,.75)}',
    '.mz-voice-text.is-heard{color:#ffe08a}',
    '.mz-voice-cancel{padding:10px 22px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);',
    'color:#fff;font:600 14px/1 Outfit,system-ui,sans-serif;cursor:pointer}',
    '.mz-voice-cancel:hover,.mz-voice-cancel:focus-visible{border-color:#f5c518;color:#f5c518;outline:none}',
    /* TV: bigger targets and type, read from across the room. */
    'html[data-mz-tv="true"] .mz-mic{width:40px;height:40px;right:8px}',
    'html[data-mz-tv="true"] .nav-search.has-mic input{padding-right:5.4rem}',
    'html[data-mz-tv="true"] .nav-search.has-mic .nav-kbd,html[data-mz-tv="true"] .nav-search.has-mic .mz-search-clear{right:54px}',
    'html[data-mz-tv="true"] .mz-mic svg{width:22px;height:22px}',
    'html[data-mz-tv="true"] .mz-mic:focus{color:#0b0b14;background:#f5c518;box-shadow:0 0 0 3px rgba(245,197,24,.45)}',
    'html[data-mz-tv="true"] .mz-voice-card{width:min(70vw,720px);padding:56px 48px 44px}',
    'html[data-mz-tv="true"] .mz-voice-orb{width:140px;height:140px}',
    'html[data-mz-tv="true"] .mz-voice-orb svg{width:58px;height:58px}',
    'html[data-mz-tv="true"] .mz-voice-title{font-size:36px}',
    'html[data-mz-tv="true"] .mz-voice-text{font-size:26px}',
    'html[data-mz-tv="true"] .mz-voice-cancel{font-size:22px;padding:16px 34px}',
    'html[data-mz-tv="true"] .mz-voice-cancel:focus{border-color:#f5c518;color:#f5c518}',
    '@media (prefers-reduced-motion:reduce){.mz-voice.is-listening .mz-voice-orb{animation:none}}',

    /* ── Search clear (×): a real round target, never the 48px pill ── */
    '.nav-search .mz-search-clear{width:26px;height:26px;min-height:0;max-height:26px;padding:0;margin:0;align-self:center;display:none;place-items:center;border-radius:50%;',
    'background:rgba(255,255,255,.08);color:rgba(255,255,255,.78);border:1px solid rgba(255,255,255,.10);box-shadow:none;',
    'transition:background .18s ease,color .18s ease,transform .18s ease,border-color .18s ease;-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    '.nav-search .mz-search-clear.visible{display:grid;animation:mzClearIn .18s cubic-bezier(.2,.8,.2,1)}',
    '.nav-search .mz-search-clear svg{width:12px;height:12px;display:block}',
    '.nav-search .mz-search-clear:hover,.nav-search .mz-search-clear:focus-visible{background:rgba(245,197,24,.18);border-color:rgba(245,197,24,.5);color:#f5c518;outline:none}',
    '.nav-search .mz-search-clear:hover svg{transform:rotate(90deg);transition:transform .25s ease}',
    '.nav-search .mz-search-clear:active{transform:translateY(-50%) scale(.88)}',
    /* separator between × and the mic so they read as two controls */
    '.nav-search.has-mic .mz-search-clear.visible::after{content:"";position:absolute;right:-7px;top:5px;bottom:5px;width:1px;background:rgba(255,255,255,.14)}',
    '.nav-search.has-mic .mz-search-clear{right:44px}',
    /* touch screens: 32px target (the box is only 32px tall on phones) */
    '@media (pointer:coarse){.nav-search .mz-search-clear{width:30px;height:30px;max-height:30px}.nav-search .mz-search-clear svg{width:13px;height:13px}',
    '.nav-search.has-mic .mz-search-clear{right:40px}.nav-search.has-mic input{padding-right:5rem}}',
    'html[data-mz-tv="true"] .nav-search .mz-search-clear{width:38px;height:38px;max-height:38px;right:56px}',
    'html[data-mz-tv="true"] .nav-search .mz-search-clear:focus{background:#f5c518;color:#0b0b14}',
    '@keyframes mzClearIn{from{opacity:0;transform:translateY(-50%) scale(.6)}to{opacity:1;transform:translateY(-50%) scale(1)}}',

    /* ── TOP 10 heading: metallic "10", live "Today" chip ── */
    '.top10-big-num{color:transparent;-webkit-text-stroke:0;background:linear-gradient(100deg,#a86f00 0%,#f5b301 22%,#fff3b8 38%,#ffd54a 48%,#f5b301 62%,#8a5a00 100%);',
    'background-size:220% 100%;background-position:100% 0;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;',
    'animation:mzT10Shine 2.6s cubic-bezier(.4,0,.2,1) .4s 2 both}',
    '@keyframes mzT10Shine{from{background-position:100% 0}to{background-position:0 0}}',
    '.top10-sub{gap:.55em}',
    '.top10-sub-a{background:linear-gradient(90deg,#fff,#e8e2c8);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}',
    '.top10-sub-b{position:relative;display:inline-flex;align-items:center;gap:.5em;width:max-content;padding:.42em .8em .42em .68em;border-radius:999px;',
    'color:#f5c518;-webkit-text-fill-color:#f5c518;background:linear-gradient(180deg,rgba(245,197,24,.16),rgba(245,197,24,.05));border:1px solid rgba(245,197,24,.45);',
    'box-shadow:0 0 18px -6px rgba(245,197,24,.6),inset 0 1px 0 rgba(255,255,255,.08)}',
    '.top10-sub-b::before{content:"";width:.55em;height:.55em;border-radius:50%;background:#ff3b3b;box-shadow:0 0 0 0 rgba(255,59,59,.7);animation:mzLive 1.8s ease-out infinite}',
    '@keyframes mzLive{0%{box-shadow:0 0 0 0 rgba(255,59,59,.65)}70%{box-shadow:0 0 0 .55em rgba(255,59,59,0)}100%{box-shadow:0 0 0 0 rgba(255,59,59,0)}}',
    '@media (prefers-reduced-motion:reduce){.top10-big-num,.top10-sub-b::before{animation:none}.top10-big-num{background-position:30% 0}}',
    'html[data-mz-tv="true"] .top10-sub-b::before{animation:none}',

    /* ── CONTINUE WATCHING ── */
    '#continue-watching .section-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
    '.cw-count{display:inline-grid;place-items:center;min-width:24px;height:24px;padding:0 7px;margin-left:10px;border-radius:999px;font:700 12px/1 Outfit,sans-serif;color:#0b0b14;background:#f5c518;vertical-align:middle}',
    '.cw-tools{display:flex;align-items:center;gap:8px;margin-left:auto}',
    '.cw-tool{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;min-width:34px;padding:0 12px;border-radius:999px;cursor:pointer;',
    'font:600 13px/1 Outfit,sans-serif;color:rgba(255,255,255,.82);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);transition:all .2s ease}',
    '.cw-tool:hover,.cw-tool:focus-visible{color:#f5c518;border-color:rgba(245,197,24,.5);background:rgba(245,197,24,.10);outline:none}',
    '.cw-tool.is-arrow{padding:0;width:34px}.cw-tool svg{width:16px;height:16px}',
    '.cw-tool.is-confirm{color:#0b0b14;background:#ff5a5a;border-color:#ff5a5a}',
    '@media (hover:none){.cw-tool.is-arrow{display:none}}',
    '.continue-watching-grid.mz-cw2{gap:16px;padding:6px 2px 14px;scroll-behavior:smooth}',
    '.mz-cw2 .cw-card{min-width:300px;max-width:300px;border-radius:14px;background:#11111c;border:1px solid rgba(255,255,255,.07);',
    'box-shadow:0 10px 26px -14px rgba(0,0,0,.9);transition:transform .28s cubic-bezier(.2,.8,.2,1),box-shadow .28s ease,border-color .28s ease}',
    '.mz-cw2 .cw-card:hover,.mz-cw2 .cw-card:focus-visible{transform:translateY(-5px);border-color:rgba(245,197,24,.55);box-shadow:0 18px 38px -16px rgba(245,197,24,.45);outline:none}',
    '.mz-cw2 .cw-thumb{position:relative;aspect-ratio:16/9;overflow:hidden;background:#1a1a28}',
    '.mz-cw2 .cw-card-img{width:100%;height:100%;object-fit:cover;transition:transform .5s ease}',
    '.mz-cw2 .cw-card:hover .cw-card-img{transform:scale(1.06)}',
    '.mz-cw2 .cw-thumb::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(5,5,12,.85) 100%);pointer-events:none}',
    '.mz-cw2 .cw-badge{position:absolute;left:10px;top:10px;z-index:2;padding:4px 8px;border-radius:6px;font:700 11px/1 Outfit,sans-serif;letter-spacing:.04em;color:#0b0b14;background:#f5c518}',
    '.mz-cw2 .cw-left{position:absolute;right:10px;bottom:12px;z-index:2;padding:4px 8px;border-radius:6px;font:600 11px/1 Outfit,sans-serif;color:#fff;background:rgba(0,0,0,.6);backdrop-filter:blur(4px)}',
    '.mz-cw2 .cw-play-icon{opacity:1;top:50%;left:50%;transform:translate(-50%,-50%) scale(.9);z-index:2;width:50px;height:50px;background:rgba(245,197,24,.95);box-shadow:0 8px 24px rgba(0,0,0,.5);transition:transform .25s ease}',
    '.mz-cw2 .cw-card:hover .cw-play-icon,.mz-cw2 .cw-card:focus-visible .cw-play-icon{transform:translate(-50%,-50%) scale(1.06)}',
    '@media (hover:hover){.mz-cw2 .cw-play-icon{opacity:0}.mz-cw2 .cw-card:hover .cw-play-icon,.mz-cw2 .cw-card:focus-visible .cw-play-icon{opacity:1}}',
    '.mz-cw2 .cw-progress-bar{position:absolute;left:0;right:0;bottom:0;z-index:3;height:4px;border-radius:0;background:rgba(255,255,255,.18)}',
    '.mz-cw2 .cw-progress-fill{border-radius:0 4px 4px 0;background:linear-gradient(90deg,#f5b301,#ffd54a);box-shadow:0 0 10px rgba(245,197,24,.7)}',
    '.mz-cw2 .cw-card-info{padding:11px 13px 13px}',
    '.mz-cw2 .cw-card-title{font-size:.98rem;margin-bottom:5px}',
    '.mz-cw2 .cw-card-meta{margin:0;font-size:.78rem;color:rgba(255,255,255,.55)}',
    '.mz-cw2 .cw-resume{display:inline-flex;align-items:center;gap:5px;margin-top:9px;font:700 12px/1 Outfit,sans-serif;color:#f5c518;letter-spacing:.02em}',
    '.mz-cw2 .cw-remove-btn{z-index:4;top:8px;right:8px;width:30px;height:30px;border-radius:50%;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);opacity:1;filter:none}',
    '.mz-cw2 .cw-remove-btn:hover{background:#e63946;color:#fff;transform:none}',
    '@media (hover:hover){.mz-cw2 .cw-remove-btn{opacity:0}.mz-cw2 .cw-card:hover .cw-remove-btn,.mz-cw2 .cw-card:focus-within .cw-remove-btn{opacity:1}}',
    '@media (max-width:600px){.mz-cw2 .cw-card{min-width:74vw;max-width:74vw}}',
    'html[data-mz-tv="true"] .mz-cw2 .cw-card:focus{transform:scale(1.05);border-color:#f5c518;box-shadow:0 0 0 3px rgba(245,197,24,.6)}',
    'html[data-mz-tv="true"] .mz-cw2 .cw-play-icon{opacity:1}',
  ].join('');

  var style = document.createElement('style');
  style.id = 'mz-extras-css';
  style.textContent = css;
  document.head.appendChild(style);

  var WA_PATH = 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z';
  var MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3.5"/><path d="M8.5 21.5h7"/></svg>';

  /* ═════════════════════════ 1. WHATSAPP SHARE ═════════════════════════ */

  function openTitle() {
    var overlay = document.getElementById('modal-overlay');
    if (!overlay || !overlay.classList.contains('open')) return null;
    var m = (typeof currentModalMovie !== 'undefined') ? currentModalMovie : null; // eslint-disable-line no-undef
    if (!m || !m.id) return null;
    var id = parseInt(m.id, 10);
    if (!(id > 0)) return null;
    return m;
  }

  function shareTarget() {
    var m = openTitle();
    if (m) {
      var kind = (m.media_type === 'tv' || (!m.title && m.name)) ? 'tv' : 'movie';
      var title = m.title || m.name || '';
      var date = m.release_date || m.first_air_date || '';
      var year = /^\d{4}/.test(date) ? date.slice(0, 4) : '';
      var slug = slugify(title);
      var url = SITE + '/' + kind + '/' + parseInt(m.id, 10) + (slug ? '-' + slug : '');
      var noun = kind === 'tv' ? 'web series' : 'movie';
      return {
        url: url,
        text: '\uD83C\uDFAC ' + title + (year ? ' (' + year + ')' : '') + ' \u2014 dekho yeh ' + noun + ' MovieZone par'
      };
    }
    return {
      url: SITE + '/',
      text: '\uD83C\uDF7F MovieZone \u2014 movies, web series, anime aur cartoons, sab ek jagah'
    };
  }

  function waHref() {
    var t = shareTarget();
    return 'https://wa.me/?text=' + encodeURIComponent(t.text + '\n' + t.url);
  }

  function playerRunning() {
    var embed = document.getElementById('videoEmbed');
    if (!embed) return false;
    if (embed.classList.contains('fullscreen-mode')) return true;
    var frame = embed.querySelector('iframe');
    return !!(frame && embed.offsetParent !== null);
  }

  function mountShare() {
    if (isTV || document.querySelector('.mz-wa-fab')) return;
    var a = document.createElement('a');
    a.className = 'mz-wa-fab';
    a.href = waHref();
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', 'Share on WhatsApp');
    a.innerHTML = '<span class="mz-wa-ico"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + WA_PATH + '"/></svg></span>' +
      '<span class="mz-wa-label">Share on WhatsApp</span>';
    // The href is rebuilt at the moment of the tap, so it always shares what
    // is on screen NOW — the open title, or the homepage once it is closed.
    function refresh() { a.href = waHref(); }
    a.addEventListener('pointerdown', refresh);
    a.addEventListener('focus', refresh);
    a.addEventListener('click', refresh);
    document.body.appendChild(a);

    function sync() { a.classList.toggle('is-hidden', playerRunning()); }
    var overlay = document.getElementById('modal-overlay');
    var embed = document.getElementById('videoEmbed');
    if (typeof MutationObserver === 'function') {
      var mo = new MutationObserver(sync);
      if (overlay) mo.observe(overlay, { attributes: true, attributeFilter: ['class'] });
      if (embed) mo.observe(embed, { childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    }
    sync();
    // Enter after the page has settled, so it never competes with the hero.
    setTimeout(function () { a.classList.add('is-ready'); }, 600);
  }

  /* ═════════════════════════ 2. VOICE SEARCH ═════════════════════════ */

  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function mountVoice() {
    if (!Recognition || !window.isSecureContext) return;
    var input = document.getElementById('searchInput');
    if (!input || document.querySelector('.mz-mic')) return;

    var mic = document.createElement('button');
    mic.type = 'button';
    mic.className = 'mz-mic';
    mic.setAttribute('aria-label', 'Search by voice');
    mic.title = 'Search by voice';
    mic.innerHTML = MIC_SVG;
    input.insertAdjacentElement('afterend', mic);
    if (input.parentNode && input.parentNode.classList) input.parentNode.classList.add('has-mic');

    var rec = null, sheet = null, textEl = null, titleEl = null, closeTimer = 0, gotFinal = false;

    function buildSheet() {
      sheet = document.createElement('div');
      sheet.className = 'mz-voice';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', 'Voice search');
      sheet.innerHTML = '<div class="mz-voice-card">' +
        '<div class="mz-voice-orb">' + MIC_SVG + '</div>' +
        '<h2 class="mz-voice-title">Bolo, kya dekhna hai?</h2>' +
        '<p class="mz-voice-text" aria-live="polite">Movie, web series ya actor ka naam bolo</p>' +
        '<button type="button" class="mz-voice-cancel">Cancel</button></div>';
      textEl = sheet.querySelector('.mz-voice-text');
      titleEl = sheet.querySelector('.mz-voice-title');
      sheet.querySelector('.mz-voice-cancel').addEventListener('click', function () { stop(true); });
      sheet.addEventListener('click', function (e) { if (e.target === sheet) stop(true); });
    }

    // Back / Escape on every remote family that exposes one to the page:
    // Escape, Backspace (Fire TV, Android TV), 10009 (Tizen), 461 (webOS).
    function onKey(e) {
      if (!sheet || !sheet.parentNode) return;
      var k = e.key, c = e.keyCode;
      if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || k === 'Backspace' || c === 10009 || c === 461) {
        e.preventDefault();
        e.stopPropagation();
        stop(true);
      }
    }

    function show(title, text, heard) {
      if (title) titleEl.textContent = title;
      textEl.textContent = text;
      textEl.classList.toggle('is-heard', !!heard);
    }

    function close() {
      clearTimeout(closeTimer);
      document.removeEventListener('keydown', onKey, true);
      mic.classList.remove('is-live');
      if (sheet && sheet.parentNode) {
        sheet.classList.remove('is-open', 'is-listening');
        var s = sheet;
        setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 200);
      }
    }

    function stop(cancelled) {
      if (rec) { try { cancelled ? rec.abort() : rec.stop(); } catch (_) { /* already stopped */ } }
      close();
      if (cancelled) { try { mic.focus({ preventScroll: true }); } catch (_) { mic.focus(); } }
    }

    function fail(msg) {
      if (sheet) sheet.classList.remove('is-listening');
      show('Hmm\u2026', msg, false);
      clearTimeout(closeTimer);
      closeTimer = setTimeout(function () { stop(false); }, 2600);
    }

    function deliver(query) {
      query = String(query || '').replace(/[.?!\u0964]+$/g, '').replace(/\s+/g, ' ').trim();
      if (!query) return;
      input.value = query;
      try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
      // The existing search wiring listens to `input`; going through it keeps
      // the debounce, fuzzy matching and dropdown exactly as if it were typed.
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function start() {
      if (sheet && sheet.parentNode) return;
      if (!sheet) buildSheet();
      gotFinal = false;
      show('Bolo, kya dekhna hai?', 'Movie, web series ya actor ka naam bolo', false);
      document.body.appendChild(sheet);
      // Next frame, so the fade-in transition actually runs.
      requestAnimationFrame(function () { sheet.classList.add('is-open', 'is-listening'); });
      document.addEventListener('keydown', onKey, true);
      mic.classList.add('is-live');
      setTimeout(function () { try { sheet.querySelector('.mz-voice-cancel').focus({ preventScroll: true }); } catch (_) { /* noop */ } }, 60);

      try {
        rec = new Recognition();
        rec.lang = 'en-IN';
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.continuous = false;
      } catch (_) {
        fail('Is browser mein voice search nahi chal sakta.');
        return;
      }

      rec.onresult = function (event) {
        var interim = '', final = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var r = event.results[i];
          if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
        }
        if (final) {
          gotFinal = true;
          show('Search kar rahe hain\u2026', '\u201C' + final.trim() + '\u201D', true);
          deliver(final);
          clearTimeout(closeTimer);
          closeTimer = setTimeout(close, 700);
        } else if (interim) {
          show(null, interim.trim(), true);
        }
      };
      rec.onerror = function (event) {
        var e = event && event.error;
        if (e === 'aborted') return;
        if (e === 'not-allowed' || e === 'service-not-allowed') fail('Mic ki permission chahiye. Browser settings mein mic allow karo.');
        else if (e === 'no-speech') fail('Kuch sunai nahi diya. Mic dabake dobara bolo.');
        else if (e === 'audio-capture') fail('Koi mic nahi mila. Remote ya phone ka mic check karo.');
        else if (e === 'network') fail('Internet slow hai, voice search abhi nahi ho paya.');
        else fail('Voice search abhi nahi ho paya. Dobara try karo.');
      };
      rec.onend = function () {
        if (sheet) sheet.classList.remove('is-listening');
        if (!gotFinal && sheet && sheet.parentNode && !closeTimer) fail('Kuch sunai nahi diya. Mic dabake dobara bolo.');
      };
      closeTimer = 0;
      try { rec.start(); } catch (_) { fail('Mic shuru nahi ho paya. Dobara try karo.'); }
    }

    mic.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      start();
    });
  }


  /* ── 3. SEARCH CLEAR (×) ─────────────────────────────────────────────────
   *  moviezone.js builds the button; this gives it a crisp icon, Escape-to-clear
   *  and a tiny haptic on phones. Behaviour stays in moviezone.js (resetSearchBox). */
  var X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  function mountClear() {
    var btn = document.querySelector('.mz-search-clear');
    var input = document.getElementById('searchInput');
    if (!btn || !input || btn.getAttribute('data-mz2')) return;
    btn.setAttribute('data-mz2', '1');
    btn.setAttribute('title', 'Clear search');
    btn.innerHTML = X_SVG; // static markup only
    btn.addEventListener('pointerdown', function () {
      try { if (navigator.vibrate) navigator.vibrate(8); } catch (_) {}
    }, { passive: true });
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !input.value) return;
      var dd = document.getElementById('searchDropdown');
      if (dd && dd.classList.contains('open')) return; // first Esc closes the list
      e.preventDefault();
      btn.click();
    });
  }

  /* ── 4. CONTINUE WATCHING ────────────────────────────────────────────────
   *  Replaces the rail's markup with a richer card (episode badge, time left,
   *  always-visible play/remove on touch, Resume label) plus a count, Clear all
   *  and scroll arrows. It keeps every class and handler the tracker in
   *  moviezone.js live-patches (.cw-card[data-key], .cw-progress-fill,
   *  .cw-card-meta, openCWMovie, removeCW), so progress ticks keep working. */
  var CW_KEY = 'mz_continue_watching', DONE_KEY = 'mz_watched_done';
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function readJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (_) { return d; } }
  function ago(ts) {
    var m = Math.floor((Date.now() - ts) / 60000);
    if (!(m >= 0)) return '';
    if (m < 1) return 'Just now'; if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); return d < 7 ? d + 'd ago' : Math.floor(d / 7) + 'w ago';
  }
  function metaText(e, pct) {
    var ep = (e.media_type === 'tv' && e.season) ? ' \u2022 S' + e.season + ' E' + e.episode : '';
    return ago(e.timestamp) + ep + ' \u2022 ' + pct + '% watched';
  }
  function leftText(e, pct) {
    var run = Number(e.runtimeSec) || 0;
    if (run < 120) return '';
    var mins = Math.max(1, Math.round(run * (100 - pct) / 100 / 60));
    return mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm left' : mins + ' min left';
  }
  var ARROW = function (d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (d < 0 ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6') + '"/></svg>'; };

  function renderCW2() {
    var section = document.getElementById('continue-watching');
    var grid = document.getElementById('continueWatchingGrid');
    if (!section || !grid) return;
    var done = readJSON(DONE_KEY, []).map(String);
    var list = readJSON(CW_KEY, []).filter(function (e) { return e && done.indexOf(String(e.key || e.id)) === -1; });
    if (!list.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    grid.classList.add('mz-cw2');

    var header = section.querySelector('.section-header');
    if (header) {
      var h2 = header.querySelector('h2');
      if (h2) {
        var c = h2.querySelector('.cw-count');
        if (!c) { c = document.createElement('span'); c.className = 'cw-count'; h2.appendChild(c); }
        c.textContent = String(list.length);
        c.setAttribute('aria-label', list.length + ' titles');
      }
      if (!header.querySelector('.cw-tools')) {
        var tools = document.createElement('div');
        tools.className = 'cw-tools';
        tools.innerHTML = '<button type="button" class="cw-tool is-arrow" data-dir="-1" aria-label="Scroll left">' + ARROW(-1) + '</button>' +
          '<button type="button" class="cw-tool is-arrow" data-dir="1" aria-label="Scroll right">' + ARROW(1) + '</button>' +
          '<button type="button" class="cw-tool" data-act="clear">Clear all</button>';
        header.appendChild(tools);
        tools.addEventListener('click', function (e) {
          var b = e.target.closest('button');
          if (!b) return;
          if (b.getAttribute('data-dir')) {
            grid.scrollBy({ left: Number(b.getAttribute('data-dir')) * grid.clientWidth * 0.85, behavior: 'smooth' });
            return;
          }
          if (!b.classList.contains('is-confirm')) {        // two taps, so a stray tap loses nothing
            b.classList.add('is-confirm'); b.textContent = 'Tap again to clear';
            setTimeout(function () { b.classList.remove('is-confirm'); b.textContent = 'Clear all'; }, 3200);
            return;
          }
          try { localStorage.setItem(CW_KEY, '[]'); } catch (_) {}
          b.classList.remove('is-confirm'); b.textContent = 'Clear all';
          renderCW2();
        });
      }
    }

    grid.innerHTML = list.map(function (e) {
      var img = e.backdrop ? 'https://image.tmdb.org/t/p/w500' + e.backdrop : (e.poster ? 'https://image.tmdb.org/t/p/w342' + e.poster : '');
      var pct = Math.max(0, Math.min(100, Number(e.progress) || 0));
      var key = String(e.key || e.id);
      var type = e.media_type === 'tv' ? 'tv' : 'movie';
      var badge = type === 'tv' && e.season ? 'S' + e.season + ' \u00b7 E' + e.episode : (type === 'tv' ? 'SERIES' : 'MOVIE');
      var left = leftText(e, pct);
      return '<div class="cw-card" data-key="' + esc(key) + '" data-id="' + Number(e.id) + '" tabindex="0" role="button" aria-label="Resume ' + esc(e.title || '') + '"' +
        ' onclick="openCWMovie(' + Number(e.id) + ', \'' + type + '\', event)">' +
        '<div class="cw-thumb">' +
          (img ? '<img class="cw-card-img" src="' + img + '" alt="" width="300" height="169" loading="lazy" decoding="async"' +
            // A dead backdrop falls back to the poster, then to the plain tile.
            ' onerror="' + (e.poster && e.backdrop ? 'this.onerror=function(){this.remove()};this.src=\'https://image.tmdb.org/t/p/w342' + esc(e.poster) + '\'' : 'this.remove()') + '">' : '') +
          '<span class="cw-badge">' + esc(badge) + '</span>' +
          (left ? '<span class="cw-left">' + esc(left) + '</span>' : '') +
          '<div class="cw-play-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="#000"><path d="M8 5v14l11-7z"/></svg></div>' +
          '<div class="cw-progress-bar"><div class="cw-progress-fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button class="cw-remove-btn" onclick="event.stopPropagation(); removeCW(\'' + esc(key) + '\')" aria-label="Remove ' + esc(e.title || '') + ' from Continue Watching"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>' +
        '<div class="cw-card-info">' +
          '<div class="cw-card-title">' + esc(e.title || '') + '</div>' +
          '<div class="cw-card-meta">' + esc(metaText(e, pct)) + '</div>' +
          '<div class="cw-resume">\u25B6 Resume</div>' +
        '</div></div>';
    }).join('');
  }

  function mountCW() {
    if (!document.getElementById('continueWatchingGrid')) return;
    // moviezone.js calls window.renderContinueWatching (global) on every
    // change, including from removeCW and its live-tick fallback.
    window.renderContinueWatching = renderCW2;
    // Enter / Space resume on keyboards and TV remotes.
    document.getElementById('continueWatchingGrid').addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('cw-card')) { e.preventDefault(); e.target.click(); }
    });
    renderCW2();
  }

  function init() {
    mountShare();
    mountVoice();
    mountClear();
    mountCW();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
