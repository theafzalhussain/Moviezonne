/* ═══════════════════════════════════════════════════════════════════════════
   tv-e2e-check.js — verifies TV mode against the REAL app, not a harness.

   Boots server.js, then drives headless Chrome over the DevTools protocol to
   load the actual index.html twice: once with a Smart TV user agent and once
   with a desktop one. The central assertion is LAYOUT IDENTITY — TV mode is a
   performance layer, so every measured dimension, font size and grid track must
   match the laptop exactly. Only motion and blur are allowed to differ.

   Not part of `npm test`: it needs a browser and live TMDB access.
   Run: npm run verify:tv
   ═══════════════════════════════════════════════════════════════════════════ */
process.env.PORT = process.env.PORT || '3993';
require('dotenv').config();

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CHROME = [
  path.join(process.env['ProgramFiles'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(p => p && fs.existsSync(p));

const TV_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CDP_PORT = 9333;

function httpGet(port, urlPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      let body = '';
      let len = 0;
      res.on('data', c => { len += c.length; body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], len, body }));
    });
    req.on('error', e => resolve({ status: 'ERR', err: e.code }));
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForCdpTarget() {
  for (let i = 0; i < 60; i++) {
    const r = await httpGet(CDP_PORT, '/json/list');
    if (r.status === 200) {
      try {
        const target = JSON.parse(r.body).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) return target.webSocketDebuggerUrl;
      } catch (e) {}
    }
    await sleep(250);
  }
  throw new Error('DevTools target never appeared on port ' + CDP_PORT);
}

// Minimal CDP client over the WebSocket that ships with modern Node.
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const waiting = new Map();
    const eventWaiters = [];

    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        return new Promise((res, rej) => {
          waiting.set(id, { res, rej });
          setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(method + ' timed out')); } }, 30000);
        });
      },
      waitForEvent(method, timeoutMs) {
        return new Promise((res, rej) => {
          const entry = { method, res };
          eventWaiters.push(entry);
          setTimeout(() => {
            const at = eventWaiters.indexOf(entry);
            if (at > -1) { eventWaiters.splice(at, 1); rej(new Error('event ' + method + ' timed out')); }
          }, timeoutMs || 30000);
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));

    ws.addEventListener('error', () => reject(new Error('CDP websocket error')));
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.id && waiting.has(msg.id)) {
        const { res, rej } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
        return;
      }
      for (let i = eventWaiters.length - 1; i >= 0; i--) {
        if (eventWaiters[i].method === msg.method) {
          eventWaiters[i].res(msg.params);
          eventWaiters.splice(i, 1);
        }
      }
    });
  });
}

// Runs inside the page; one round trip returns everything we assert on.
const PROBE = `(function () {
  var root = document.documentElement;

  // Normalise before measuring: an install prompt or modal locks body scroll,
  // which removes the scrollbar and shifts every width by a few pixels. Without
  // this the two runs are not comparable.
  Array.prototype.forEach.call(document.querySelectorAll('.open'), function (el) {
    el.classList.remove('open');
  });
  document.body.style.overflow = '';
  root.style.overflowY = 'scroll';

  var card = document.querySelector('.movie-card');
  var grid = document.getElementById('movieGrid');
  var title = document.querySelector('.card-title');
  var heading = document.getElementById('sectionHeading');
  var style = function (el, prop) { return el ? getComputedStyle(el)[prop] : null; };
  var round = function (n) { return Math.round(n * 100) / 100; };
  var boxWidth = function (el) { return el ? round(el.getBoundingClientRect().width) : null; };

  // Layout fingerprint, captured BEFORE anything is focused or scrolled.
  var layout = {
    rootFontSize: getComputedStyle(root).fontSize,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    gridColumns: style(grid, 'gridTemplateColumns'),
    gridGap: style(grid, 'gap'),
    cardWidth: boxWidth(card),
    cardHeight: card ? round(card.getBoundingClientRect().height) : null,
    cardRadius: style(card, 'borderRadius'),
    cardTitleFontSize: style(title, 'fontSize'),
    headingFontSize: style(heading, 'fontSize'),
    navbarWidth: boxWidth(document.getElementById('navbar')),
    sectionPaddingLeft: style(document.getElementById('movies-section'), 'paddingLeft')
  };

  var viewport = {
    innerWidth: window.innerWidth,
    clientWidth: root.clientWidth,
    scrollbar: window.innerWidth - root.clientWidth,
    docHeight: Math.round(root.scrollHeight),
    dpr: window.devicePixelRatio
  };

  return JSON.stringify({
    mzTv: root.getAttribute('data-mz-tv'),
    platform: root.getAttribute('data-mz-tv-platform'),
    tier: root.getAttribute('data-mz-tv-tier'),
    ready: root.getAttribute('data-mz-tv-ready'),
    movieCards: document.querySelectorAll('.movie-card').length,
    cardsWithTabIndex: document.querySelectorAll('.movie-card[tabindex]').length,
    tvModeLoaded: typeof window.MovieZoneTV === 'object',
    tvModeIsTv: window.MovieZoneTV ? window.MovieZoneTV.isTV() : null,
    isMzTvAgrees: typeof window.MovieZoneTV === 'object'
      ? window.MovieZoneTV.isTV() === (root.getAttribute('data-mz-tv') === 'true') : null,
    layout: layout,
    viewport: viewport,
    lowEndMode: root.classList.contains('low-end-mode'),
    tvSheetActive: getComputedStyle(root).getPropertyValue('--mz-tv-active').trim() || null,
    cardTransitionDuration: style(card, 'transitionDuration'),
    cardAnimationName: style(card, 'animationName'),
    navbarBackdrop: (function () {
      var nav = document.getElementById('navbar');
      if (!nav) return null;
      var cs = getComputedStyle(nav);
      // getPropertyValue is the reliable read; the camelCase alias is missing in
      // some engines and silently yields undefined.
      return cs.getPropertyValue('backdrop-filter') ||
             cs.getPropertyValue('-webkit-backdrop-filter') || 'none';
    })(),

    // D-pad, driven exactly the way a remote drives it.
    dpad: (function () {
      var cards = document.querySelectorAll('.movie-card');
      if (cards.length < 2) return 'too-few-cards';
      cards[0].scrollIntoView({ block: 'center' });
      cards[0].focus();
      var before = document.activeElement;
      var ev = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
      try { Object.defineProperty(ev, 'keyCode', { get: function () { return 39; } }); } catch (e) {}
      document.dispatchEvent(ev);
      var focused = document.activeElement;
      var cs = getComputedStyle(focused);
      return {
        moved: focused !== before,
        consumed: ev.defaultPrevented,
        outlineWidth: cs.outlineWidth,
        outlineStyle: cs.outlineStyle,
        outlineColor: cs.outlineColor,
        matchesFocus: focused.matches(':focus'),
        matchesFocusVisible: (function () {
          try { return focused.matches(':focus-visible'); } catch (e) { return 'unsupported'; }
        })(),
        widthWhileFocused: boxWidth(focused)
      };
    })()
  });
})()`;

async function probe(cdp, userAgent, url) {
  await cdp.send('Emulation.setUserAgentOverride', { userAgent });
  // Headless windows have no system focus, so :focus / :focus-visible would
  // never match and every focus assertion would be meaningless.
  try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  await cdp.send('Page.enable');
  const loaded = cdp.waitForEvent('Page.loadEventFired', 45000);
  await cdp.send('Page.navigate', { url });
  await loaded;
  await sleep(4500); // let TMDB data land and the grid render
  const result = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  if (result.exceptionDetails) throw new Error('probe threw: ' + JSON.stringify(result.exceptionDetails.text));
  return JSON.parse(result.result.value);
}

(async () => {
  if (!CHROME) { console.log('SKIPPED: no Chrome/Edge found.'); process.exit(0); }
  if (typeof WebSocket !== 'function') { console.log('SKIPPED: this Node build has no WebSocket.'); process.exit(0); }

  const app = require('./server.js');
  const server = app.listen(process.env.PORT);
  await new Promise(r => server.once('listening', r));
  const port = process.env.PORT;
  const url = 'http://127.0.0.1:' + port + '/';
  await sleep(1500);

  let bad = 0;
  const say = (ok, msg) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) bad++; };

  console.log('--- assets served by server.js ---');
  for (const asset of ['/index.html', '/tv-mode.css?v=1.1', '/tv-mode.js?v=1.1', '/moviezone.js?v=5.5', '/sw.js', '/manifest.json']) {
    const r = await httpGet(port, asset);
    say(r.status === 200, asset + ' -> ' + r.status + ' ' + r.type + ' ' + r.len + 'B');
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzE2E-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1920,1080',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    cdp = await connect(await waitForCdpTarget());

    console.log('\n--- real index.html, Tizen Smart TV user agent ---');
    const tv = await probe(cdp, TV_UA, url);
    say(tv.mzTv === 'true', 'html[data-mz-tv="true"] is set');
    say(tv.platform === 'tizen', 'platform detected as tizen (got ' + tv.platform + ')');
    say(tv.tier === 'low', 'render tier is low (got ' + tv.tier + ')');
    say(tv.ready === 'true', 'tv-mode.js finished booting');
    say(tv.tvModeLoaded === true, 'window.MovieZoneTV is available to moviezone.js');
    say(tv.tvModeIsTv === true && tv.isMzTvAgrees === true, 'MovieZoneTV.isTV() agrees with the attribute');
    say(tv.tvSheetActive === '1', 'tv-mode.css matched (--mz-tv-active=' + tv.tvSheetActive + ')');
    say(tv.movieCards > 0, 'real movie cards rendered: ' + tv.movieCards);
    say(tv.movieCards <= 30, 'card count respects the TV memory cap (<=30)');
    say(tv.cardsWithTabIndex === tv.movieCards, 'every card is D-pad reachable (' + tv.cardsWithTabIndex + '/' + tv.movieCards + ')');

    console.log('\n--- performance layer engaged ---');
    say(tv.navbarBackdrop === 'none', 'navbar backdrop blur removed (got ' + tv.navbarBackdrop + ')');
    say(tv.cardTransitionDuration === '0s', 'card hover transitions removed (got ' + tv.cardTransitionDuration + ')');
    say(tv.cardAnimationName === 'none', 'card entrance animation removed (got ' + tv.cardAnimationName + ')');

    console.log('\n--- D-pad on the real grid ---');
    say(tv.dpad && tv.dpad.moved === true, 'ArrowRight moves focus');
    say(tv.dpad && tv.dpad.consumed === true, 'ArrowRight is consumed by tv-mode.js');
    say(tv.dpad && tv.dpad.matchesFocus === true, 'the focused card matches :focus');
    say(tv.dpad && tv.dpad.outlineStyle === 'solid', 'focus ring is drawn (style=' + (tv.dpad && tv.dpad.outlineStyle) + ')');
    say(tv.dpad && parseFloat(tv.dpad.outlineWidth) === 2,
      'focus ring is the laptop 2px (got ' + (tv.dpad && tv.dpad.outlineWidth) + ')');
    say(tv.dpad && tv.dpad.outlineColor === 'rgb(255, 193, 7)',
      'focus ring is the brand gold (got ' + (tv.dpad && tv.dpad.outlineColor) + ')');

    console.log('\n--- same page, desktop Chrome user agent ---');
    const desk = await probe(cdp, DESKTOP_UA, url);
    say(desk.mzTv === null, 'TV mode does NOT engage on desktop');
    say(desk.tier === null, 'no tier attribute on desktop');
    say(desk.tvModeIsTv === false, 'MovieZoneTV.isTV() is false on desktop');
    say(desk.tvSheetActive === null, 'tv-mode.css stays inert on desktop');
    say(desk.movieCards > 0, 'desktop cards rendered: ' + desk.movieCards);
    say(desk.dpad && desk.dpad.moved === false, 'ArrowRight does not hijack focus on desktop');
    say(desk.dpad && desk.dpad.consumed === false, 'ArrowRight is not consumed on desktop');
    // In headless the app's own frame sampler often drops the desktop run into
    // low-end-mode, which strips the blur itself — only demand the blur when it did not.
    say(desk.lowEndMode === true || desk.navbarBackdrop !== 'none',
      'desktop navbar blur intact unless the app self-downgraded (blur=' + desk.navbarBackdrop +
      ', low-end-mode=' + desk.lowEndMode + ')');

    console.log('\n--- LAYOUT IDENTITY: TV must look exactly like the laptop ---');
    console.log('      viewport TV     : ' + JSON.stringify(tv.viewport));
    console.log('      viewport laptop : ' + JSON.stringify(desk.viewport));
    say(tv.viewport.clientWidth === desk.viewport.clientWidth,
      'both runs measured the same viewport width (' + tv.viewport.clientWidth + ' vs ' + desk.viewport.clientWidth + ')');
    const KEYS = [
      ['rootFontSize', 'root font size'],
      ['bodyFontSize', 'body font size'],
      ['gridColumns', 'movie grid columns'],
      ['gridGap', 'movie grid gap'],
      ['cardWidth', 'movie card width'],
      ['cardHeight', 'movie card height'],
      ['cardRadius', 'movie card corner radius'],
      ['cardTitleFontSize', 'card title font size'],
      ['headingFontSize', 'section heading font size'],
      ['navbarWidth', 'navbar width'],
      ['sectionPaddingLeft', 'content left padding']
    ];
    KEYS.forEach(([key, label]) => {
      say(tv.layout[key] === desk.layout[key],
        label + ' identical: ' + JSON.stringify(tv.layout[key]) +
        (tv.layout[key] === desk.layout[key] ? '' : ' (TV) vs ' + JSON.stringify(desk.layout[key]) + ' (laptop)'));
    });
    say(tv.dpad.widthWhileFocused === desk.dpad.widthWhileFocused,
      'a focused card is the same size on both (' + tv.dpad.widthWhileFocused + ' vs ' + desk.dpad.widthWhileFocused + ')');
  } catch (err) {
    say(false, 'harness error: ' + err.message);
  } finally {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    server.close();
  }

  console.log('\n' + (bad === 0 ? 'ALL E2E CHECKS PASSED' : bad + ' E2E CHECK(S) FAILED'));
  setTimeout(() => process.exit(bad === 0 ? 0 : 1), 300);
})();
