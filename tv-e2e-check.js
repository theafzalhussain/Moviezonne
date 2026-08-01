/* Ad-hoc end-to-end check: boot the real server, load the real index.html in
   headless Chrome over the DevTools protocol with a Smart TV user agent, and
   confirm TV mode engages on the actual app (not a harness page).
   Not part of `npm test` — it needs both a browser and live TMDB access. */
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
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft\\Edge\\Application\\msedge.exe')
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

// Runs inside the page; returns everything we want to assert in one round trip.
const PROBE = `(function () {
  var root = document.documentElement;
  return JSON.stringify({
    ua: navigator.userAgent,
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
    tvCssApplied: (function () {
      // A custom property is the cleanest TV-only signal: moviezone.css already
      // uses content-visibility on cards for every device, so that proves nothing.
      return getComputedStyle(document.documentElement).getPropertyValue('--mz-tv-safe-x').trim() || null;
    })(),
    cardContentVisibility: (function () {
      var card = document.querySelector('.movie-card');
      return card ? getComputedStyle(card).contentVisibility || 'unsupported' : null;
    })(),
    gridColumns: (function () {
      var grid = document.getElementById('movieGrid');
      return grid ? getComputedStyle(grid).gridTemplateColumns : null;
    })(),
    cssDiag: (function () {
      var out = { sheets: [], outlineRules: [], cardMatches: null };
      var card = document.querySelector('.movie-card');
      if (card) { card.scrollIntoView({ block: 'center' }); card.focus(); }
      for (var i = 0; i < document.styleSheets.length; i++) {
        var sheet = document.styleSheets[i];
        var info = { href: sheet.href ? sheet.href.split('/').pop() : '(inline)', rules: null, error: null };
        try { info.rules = sheet.cssRules.length; } catch (e) { info.error = e.name; }
        out.sheets.push(info);

        if (!info.rules || !card) continue;
        for (var j = 0; j < sheet.cssRules.length; j++) {
          var rule = sheet.cssRules[j];
          if (!rule.selectorText || !rule.style || !rule.style.outline && !rule.style.outlineStyle) continue;
          if (rule.selectorText.indexOf('movie-card') === -1 && rule.selectorText.indexOf(':focus') === -1) continue;
          var matches = false;
          try { matches = card.matches(rule.selectorText); } catch (e) {}
          out.outlineRules.push({
            sheet: info.href,
            selector: rule.selectorText.slice(0, 120),
            outline: rule.style.outline || rule.style.outlineStyle,
            important: rule.style.getPropertyPriority('outline') || rule.style.getPropertyPriority('outline-style'),
            matchesFocusedCard: matches
          });
        }
      }
      if (card) {
        try { out.cardMatches = card.matches('html[data-mz-tv="true"] .movie-card:focus'); } catch (e) { out.cardMatches = 'error'; }
      }
      return out;
    })(),
    focusRing: (function () {
      var card = document.querySelector('.movie-card');
      if (!card) return null;
      // The grid sits below the fold and cards use content-visibility:auto, so
      // bring it on screen before measuring or the style is still skipped.
      card.scrollIntoView({ block: 'center' });
      card.focus();
      var cs = getComputedStyle(card);
      return {
        active: document.activeElement === card,
        outlineWidth: cs.outlineWidth,
        outlineStyle: cs.outlineStyle,
        outlineColor: cs.outlineColor,
        varWidth: cs.getPropertyValue('--mz-tv-focus-width').trim()
      };
    })(),
    dpad: (function () {
      var cards = document.querySelectorAll('.movie-card');
      if (cards.length < 2) return 'too-few-cards';
      cards[0].focus();
      var before = document.activeElement;
      var ev = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
      try { Object.defineProperty(ev, 'keyCode', { get: function () { return 39; } }); } catch (e) {}
      document.dispatchEvent(ev);
      return { moved: document.activeElement !== before, consumed: ev.defaultPrevented };
    })()
  });
})()`;

async function probe(cdp, userAgent, url) {
  await cdp.send('Emulation.setUserAgentOverride', { userAgent });
  // Headless windows have no system focus, so :focus / :focus-visible never match
  // and every focus-ring assertion would be meaningless without this.
  try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  await cdp.send('Page.enable');
  const loaded = cdp.waitForEvent('Page.loadEventFired', 45000);
  await cdp.send('Page.navigate', { url });
  await loaded;
  await sleep(4000); // let TMDB data land and the grid render
  const result = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: false });
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
    say(tv.tvModeIsTv === true, 'MovieZoneTV.isTV() is true');
    say(tv.isMzTvAgrees === true, 'the attribute and the API agree');
    say(tv.movieCards > 0, 'real movie cards rendered: ' + tv.movieCards);
    say(tv.movieCards <= 30, 'card count respects the TV memory cap (<=30)');
    say(tv.cardsWithTabIndex === tv.movieCards, 'every card is reachable by the D-pad (' + tv.cardsWithTabIndex + '/' + tv.movieCards + ')');
    say(tv.tvCssApplied === '2.5vw', 'tv-mode.css is active (--mz-tv-safe-x=' + tv.tvCssApplied + ')');
    say(tv.cardContentVisibility === 'auto', 'cards skip offscreen rendering (content-visibility=' + tv.cardContentVisibility + ')');
    say(/260px|300px|210px|400px/.test(String(tv.gridColumns)) || String(tv.gridColumns).split(' ').length <= 7,
      'grid uses the wider TV columns: ' + tv.gridColumns);
    say(tv.focusRing && tv.focusRing.active === true, 'a card can take focus');
    say(tv.focusRing && parseFloat(tv.focusRing.outlineWidth) >= 4,
      'TV focus ring is >=4px (width=' + (tv.focusRing && tv.focusRing.outlineWidth) +
      ' style=' + (tv.focusRing && tv.focusRing.outlineStyle) +
      ' color=' + (tv.focusRing && tv.focusRing.outlineColor) +
      ' var=' + (tv.focusRing && tv.focusRing.varWidth) + ')');
    if (!(tv.focusRing && parseFloat(tv.focusRing.outlineWidth) >= 4)) {
      console.log('      diag: selector matches focused card = ' + JSON.stringify(tv.cssDiag.cardMatches));
      console.log('      diag: stylesheets = ' + JSON.stringify(tv.cssDiag.sheets));
      tv.cssDiag.outlineRules.slice(0, 12).forEach(r => console.log('      diag: ' + JSON.stringify(r)));
    }
    say(tv.dpad && tv.dpad.moved === true, 'ArrowRight moves focus in the real grid');
    say(tv.dpad && tv.dpad.consumed === true, 'ArrowRight is consumed by tv-mode.js');

    console.log('\n--- same page, desktop Chrome user agent ---');
    const desk = await probe(cdp, DESKTOP_UA, url);
    say(desk.mzTv === null, 'TV mode does NOT engage on desktop');
    say(desk.tier === null, 'no tier attribute on desktop');
    say(desk.tvModeIsTv === false, 'MovieZoneTV.isTV() is false on desktop');
    say(desk.movieCards > 0, 'desktop cards rendered: ' + desk.movieCards);
    say(desk.dpad && desk.dpad.moved === false, 'ArrowRight does not hijack focus on desktop');
    say(desk.dpad && desk.dpad.consumed === false, 'ArrowRight is not consumed on desktop');
    say(desk.tvCssApplied === null, 'tv-mode.css stays inert on desktop (--mz-tv-safe-x=' + desk.tvCssApplied + ')');
    say(desk.gridColumns !== tv.gridColumns, 'desktop keeps its own grid columns: ' + desk.gridColumns);
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
