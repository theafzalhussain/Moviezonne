'use strict';
/* Temporary in-app check of the Download sheet (desktop, series, phone, TV).
   Deleted after use. ONLY=desktop|phone|tv runs one section. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('undici');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9387;
const ONLY = process.env.ONLY || '';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const DOT = '\u00b7';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej));

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail !== undefined ? '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}

(async () => {
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzdl3-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(300);
    try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + CDP_PORT + '/json/version')).webSocketDebuggerUrl; } catch (e) {}
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  const send = (method, params, sessionId, ms) => new Promise((resolve) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); resolve({ __timeout: method }); }, ms || 15000);
    pending.set(id, (v) => { clearTimeout(t); resolve(v); });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });

  let mainId = null;
  let S = null;
  const popups = [];
  const errors = [];
  const seen = new Set();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m.result || m.error || {}); return; }
    if ((m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') && m.params.targetInfo.type === 'page' &&
        mainId && m.params.targetInfo.targetId !== mainId) {
      const ti = m.params.targetInfo;
      if (ti.url && ti.url !== 'about:blank' && !seen.has(ti.targetId)) {
        seen.add(ti.targetId);
        popups.push(ti.url);
        send('Target.closeTarget', { targetId: ti.targetId });
      }
    }
    if (m.sessionId && m.sessionId === S && m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('exception: ' + String((d.exception && d.exception.description) || d.text).slice(0, 300));
    }
    if (m.sessionId && m.sessionId === S && m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    }
  });

  await send('Target.setDiscoverTargets', { discover: true });
  await send('Browser.setDownloadBehavior', { behavior: 'deny' });
  const { targetInfos } = await send('Target.getTargets');
  mainId = targetInfos.find((t) => t.type === 'page').targetId;
  S = (await send('Target.attachToTarget', { targetId: mainId, flatten: true })).sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('mz_pwa_prompt_dismissed_at', String(Date.now()));localStorage.setItem('mz_pwa_tv_prompt_dismissed_at', String(Date.now()))}catch(e){}"
  }, S);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S, 20000);
    if (r.__timeout) throw new Error('eval timeout');
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  };
  const waitFor = async (expr, ms, label) => {
    const end = Date.now() + (ms || 20000);
    while (Date.now() < end) {
      try { if (await evaluate(expr)) return true; } catch (e) {}
      await sleep(200);
    }
    console.log('  (timed out waiting for ' + (label || expr) + ')');
    return false;
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, S, 20000);
    if (r && r.data) fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  const mouseClick = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, S);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, S);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, S);
  };
  const tap = async (x, y) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, S);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, S);
  };
  const VK = { Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Tab: 9, Enter: 13 };
  const key = async (k, opts) => {
    const o = opts || {};
    const code = o.keyCode || VK[k];
    const base = { key: k, code: o.code !== undefined ? o.code : k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: o.shift ? 8 : 0 };
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base), S);
    if (k === 'Enter') await send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: '\r', unmodifiedText: '\r' }, base), S);
    await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base), S);
    await sleep(120);
  };
  const centre = (sel, scroll) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    ${scroll ? "el.scrollIntoView({ block: 'center', behavior: 'instant' });" : ''}
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const clickSel = async (sel, touch) => {
    await centre(sel, true);
    await sleep(250);
    const c = await centre(sel, false);
    if (!c) throw new Error('no element ' + sel);
    if (touch) await tap(c.x, c.y); else await mouseClick(c.x, c.y);
  };

  const loadHome = async (query) => {
    await send('Page.navigate', { url: BASE + '/' + (query || '') }, S);
    await waitFor("document.readyState === 'complete' && typeof openModal === 'function' && !!document.getElementById('sectionHeading')", 40000, 'home page');
    await sleep(2000);
    await evaluate(`(() => {
      document.addEventListener('click', (e) => {
        const n = window.__mzOpenNext;
        if (!n || !e.target.closest('#sectionHeading')) return;
        window.__mzOpenNext = null;
        e.preventDefault(); e.stopPropagation();
        openModal(n.id, n.type, e);
      }, true);
      return true;
    })()`);
  };
  const openTitle = async (id, type, touch) => {
    await evaluate(`window.__mzOpenNext = { id: ${id}, type: '${type}' }`);
    await clickSel('#sectionHeading', touch);
    const ok = await waitFor(`typeof currentModalMovie !== 'undefined' && !!currentModalMovie && currentModalMovie.id === ${id}`, 30000, 'details of ' + id);
    if (type === 'tv') {
      await waitFor("(() => { const e = document.getElementById('episodeInput'); return !!e && e.options.length > 1 && /^\\d+$/.test(e.value); })()", 30000, 'episode list');
    }
    await sleep(600);
    return ok;
  };
  const state = () => evaluate(`(() => {
    const s = document.getElementById('dlSheet');
    if (!s) return null;
    const card = s.querySelector('.dl-card').getBoundingClientRect();
    const ae = document.activeElement;
    const ov = document.getElementById('modal-overlay');
    return {
      open: !!(window.MZDownloads && MZDownloads.isOpen()), hidden: s.hidden, display: getComputedStyle(s).display,
      rows: Array.from(s.querySelectorAll('.dl-row')).map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel,
        text: a.innerText.replace(/\\s+/g, ' ').trim() })),
      sub: s.querySelector('.dl-sub').textContent,
      ep: s.querySelector('.dl-ep').hidden ? null : s.querySelector('.dl-ep-label').textContent,
      prev: s.querySelector('[data-dl-step="-1"]').getAttribute('aria-disabled'),
      next: s.querySelector('[data-dl-step="1"]').getAttribute('aria-disabled'),
      active: ae ? (String(ae.className || ae.tagName) + (ae.getAttribute && ae.getAttribute('href') ? ' ' + ae.getAttribute('href') : '')) : null,
      inSheet: s.contains(ae),
      expanded: document.querySelector('.btn-download').getAttribute('aria-expanded'),
      lock: document.documentElement.classList.contains('mz-dl-open'),
      overflow: getComputedStyle(ov).overflowY,
      modalOpen: ov.classList.contains('open'),
      card: { x: Math.round(card.left), y: Math.round(card.top), w: Math.round(card.width), h: Math.round(card.height), vw: innerWidth, vh: innerHeight }
    };
  })()`);

  const MOVIE = 299534;  // Avengers: Endgame
  const SHOW = 1399;     // Game of Thrones
  const movieHrefs = [
    'https://02moviedownloader.site/api/download/movie/' + MOVIE,
    'https://nxsha.space/dl/movie/' + MOVIE,
    'https://vidsync.pro/embed/download/movie/' + MOVIE,
    'https://vidvault.to/movie/' + MOVIE
  ];
  const tvHrefs = (s, e) => [
    'https://02moviedownloader.site/api/download/tv/' + SHOW + '/' + s + '/' + e,
    'https://nxsha.space/dl/tv/' + SHOW + '/' + s + '/' + e,
    'https://vidsync.pro/embed/download/tv/' + SHOW + '/' + s + '/' + e,
    'https://vidvault.to/tv/' + SHOW + '/' + s + '/' + e
  ];
  let st;

  try {
    if (!ONLY || ONLY === 'desktop') {
      /* ---------- DESKTOP: script fails to load, then retries ---------- */
      console.log('\n== desktop 1366x900 - downloads.js blocked, then allowed');
      await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }, S);
      await send('Network.enable', {}, S);
      await send('Network.setBlockedURLs', { urls: ['*downloads.js*'] }, S);
      await loadHome();
      check('modal opens (blocked run)', await openTitle(MOVIE, 'movie'));
      await clickSel('.btn-download');
      await waitFor("document.getElementById('toast').classList.contains('show')", 6000, 'failure toast');
      const failure = await evaluate(`({ toast: document.getElementById('toast').textContent, busy: document.querySelector('.btn-download').hasAttribute('aria-busy'),
        sheet: !!document.getElementById('dlSheet'), modal: document.getElementById('modal-overlay').classList.contains('open') })`);
      check('a failed load shows a toast, leaves no sheet and clears aria-busy',
        /could not load/i.test(failure.toast) && !failure.busy && !failure.sheet && failure.modal, failure);
      await send('Network.setBlockedURLs', { urls: [] }, S);
      await clickSel('.btn-download');
      await waitFor('!!(window.MZDownloads && MZDownloads.isOpen())', 8000, 'sheet after retry');
      st = await state();
      check('the next click retries and opens the sheet', !!st && st.open && st.rows.length === 4);
      await key('Escape');
      await evaluate('closeModal()');
      await sleep(300);
      await send('Network.disable', {}, S);

      /* ---------- DESKTOP: MOVIE ---------- */
      console.log('\n== desktop 1366x900 - movie');
      await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }, S);
      await loadHome();
      check('modal opens with details', await openTitle(MOVIE, 'movie'));
      const btnAttrs = await evaluate("(() => { const b = document.querySelector('.btn-download'); return [b.getAttribute('aria-haspopup'), b.getAttribute('aria-expanded'), b.type]; })()");
      check('Download button announces a dialog', btnAttrs[0] === 'dialog' && btnAttrs[1] === 'false' && btnAttrs[2] === 'button', btnAttrs);
      check('downloads.js is not fetched before any intent', !(await evaluate("performance.getEntriesByType('resource').some((e) => e.name.indexOf('/downloads.js') !== -1)")));
      await centre('.btn-download', true);
      await sleep(250);
      const dc = await centre('.btn-download', false);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dc.x, y: dc.y }, S);
      await waitFor("performance.getEntriesByType('resource').some((e) => e.name.indexOf('/downloads.js?v=1') !== -1)", 5000, 'warm on hover');
      check('hovering the button warms downloads.js', await evaluate("performance.getEntriesByType('resource').some((e) => e.name.indexOf('/downloads.js?v=1') !== -1)"));
      await mouseClick(dc.x, dc.y);
      await waitFor('!!(window.MZDownloads && MZDownloads.isOpen())', 8000, 'sheet open');
      await sleep(450);
      st = await state();
      check('sheet is open and shown', st && st.open && !st.hidden && st.display === 'flex', st && { open: st.open, hidden: st.hidden, display: st.display });
      check('four servers in Olly order (D1-D4)', st.rows.length === 4 && st.rows.map((r) => r.text.slice(0, 2)).join() === 'D1,D2,D3,D4', st.rows.map((r) => r.text.slice(0, 16)));
      check('movie links are exact', JSON.stringify(st.rows.map((r) => r.href)) === JSON.stringify(movieHrefs), st.rows.map((r) => r.href));
      check('links open a new tab with noopener', st.rows.every((r) => r.target === '_blank' && /noopener/.test(r.rel)));
      check('header names the title and year', st.sub === 'Avengers: Endgame ' + DOT + ' 2019', st.sub);
      check('no episode bar for a movie', st.ep === null);
      check('focus moved to the first server', st.inSheet && /dl-row/.test(st.active) && st.active.indexOf(movieHrefs[0]) !== -1, st.active);
      check('aria-expanded true + page scroll locked', st.expanded === 'true' && st.lock && st.overflow === 'hidden', [st.expanded, st.lock, st.overflow]);
      check('card is centred on desktop', Math.abs(st.card.x - (st.card.vw - st.card.w) / 2) <= 2 && st.card.w <= 562, st.card);
      await shot('tmp-dlsheet-desktop-movie.jpg');

      // Keyboard: arrows walk the rows and stop at the ends; Tab wraps.
      await key('ArrowDown'); st = await state();
      check('ArrowDown -> D2', st.active.indexOf(movieHrefs[1]) !== -1, st.active);
      await key('ArrowDown'); await key('ArrowDown'); await key('ArrowDown'); st = await state();
      check('ArrowDown stops at D4', st.active.indexOf(movieHrefs[3]) !== -1 && st.inSheet, st.active);
      await key('ArrowUp'); await key('ArrowUp'); await key('ArrowUp'); await key('ArrowUp'); st = await state();
      check('ArrowUp from D1 reaches the close button', /dl-x/.test(st.active), st.active);
      await key('ArrowUp'); st = await state();
      check('ArrowUp stops at the close button', /dl-x/.test(st.active), st.active);
      await key('Tab'); st = await state();
      check('Tab from close -> D1', st.active.indexOf(movieHrefs[0]) !== -1, st.active);
      await key('Tab', { shift: true }); await key('Tab', { shift: true }); st = await state();
      check('Shift+Tab wraps from close to D4', st.active.indexOf(movieHrefs[3]) !== -1, st.active);
      await key('ArrowLeft'); st = await state();
      check('ArrowLeft on a row is consumed (focus stays)', st.active.indexOf(movieHrefs[3]) !== -1 && st.modalOpen, st.active);

      await key('Escape'); st = await state();
      check('Escape closes the sheet, not the watch page', !st.open && st.hidden && st.modalOpen, { open: st.open, modal: st.modalOpen });
      check('focus returns to Download, expanded false, lock released',
        /btn-download/.test(st.active) && st.expanded === 'false' && !st.lock && st.overflow !== 'hidden', [st.active, st.expanded, st.lock, st.overflow]);

      // Backdrop click and the close button.
      await clickSel('.btn-download');
      await waitFor('MZDownloads.isOpen()', 5000, 'reopen');
      await sleep(350);
      await mouseClick(25, 450);
      await sleep(200);
      st = await state();
      check('clicking the backdrop closes the sheet', !st.open && st.modalOpen, { open: st.open, modal: st.modalOpen });
      await clickSel('.btn-download');
      await waitFor('MZDownloads.isOpen()', 5000, 'reopen');
      await sleep(350);
      await clickSel('#dlSheet .dl-x');
      await sleep(200);
      st = await state();
      check('the close button closes the sheet', !st.open && st.modalOpen);

      // Real link clicks open the exact URL in a new tab (no popup blocker involved).
      await clickSel('.btn-download');
      await waitFor('MZDownloads.isOpen()', 5000, 'reopen');
      await sleep(350);
      popups.length = 0;
      await clickSel('#dlSheet .dl-list li:nth-child(4) .dl-row');
      await sleep(1500);
      await clickSel('#dlSheet .dl-list li:nth-child(2) .dl-row');
      await sleep(1500);
      check('clicking D4 and D2 opened exactly those URLs in new tabs',
        popups.indexOf(movieHrefs[3]) !== -1 && popups.indexOf(movieHrefs[1]) !== -1, popups);
      st = await state();
      check('the sheet stays open after a server is picked', st.open && st.modalOpen);

      // Closing the watch page underneath takes the sheet with it.
      await evaluate('closeModal()');
      await sleep(400);
      st = await state();
      check('closing the watch page closes the sheet and releases the lock', !st.open && st.hidden && !st.lock && !st.modalOpen);

      /* ---------- DESKTOP: SERIES ---------- */
      console.log('\n== desktop 1366x900 - series');
      check('series modal opens with its episodes', await openTitle(SHOW, 'tv'));
      const pageSel = await evaluate("[document.getElementById('seasonInput').value, document.getElementById('episodeInput').value]");
      await clickSel('.btn-download');
      await waitFor('MZDownloads.isOpen()', 6000, 'series sheet');
      await sleep(450);
      st = await state();
      check('series links use the picked season/episode', JSON.stringify(st.rows.map((r) => r.href)) === JSON.stringify(tvHrefs(pageSel[0], pageSel[1])),
        { picked: pageSel, hrefs: st.rows.map((r) => r.href) });
      check('episode bar names the episode', st.ep === 'S' + pageSel[0] + ' ' + DOT + ' E' + pageSel[1] + ' ' + DOT + ' Winter Is Coming', st.ep);
      check('prev disabled at E1, next enabled', st.prev === 'true' && st.next === 'false', [st.prev, st.next]);
      check('series header names the show', st.sub === 'Game of Thrones ' + DOT + ' 2011', st.sub);
      await shot('tmp-dlsheet-desktop-series.jpg');

      await clickSel('#dlSheet [data-dl-step="1"]');
      await sleep(200);
      st = await state();
      check('next episode -> E2 links + label', JSON.stringify(st.rows.map((r) => r.href)) === JSON.stringify(tvHrefs(1, 2)) &&
        st.ep === 'S1 ' + DOT + ' E2 ' + DOT + ' The Kingsroad', { ep: st.ep, first: st.rows[0].href });
      const pageSel2 = await evaluate("[document.getElementById('seasonInput').value, document.getElementById('episodeInput').value]");
      check("stepping does not touch the page's own episode picker", JSON.stringify(pageSel2) === JSON.stringify(pageSel), pageSel2);
      await evaluate("document.querySelector('#dlSheet [data-dl-step=\"1\"]').focus()");
      await key('ArrowLeft'); st = await state();
      check('ArrowLeft on the stepper -> previous-episode button', /dl-ep-btn/.test(st.active) &&
        (await evaluate("document.activeElement.getAttribute('data-dl-step')")) === '-1', st.active);
      await key('ArrowRight');
      await key('Enter'); st = await state();
      check('Enter on next -> E3', !!st.ep && st.ep.indexOf('S1 ' + DOT + ' E3') === 0, st.ep);
      for (let i = 0; i < 12; i++) { await key('Enter'); }
      st = await state();
      check('stepper stops at the last episode (E10), next disabled', !!st.ep && st.ep.indexOf('S1 ' + DOT + ' E10') === 0 && st.next === 'true' && st.inSheet,
        [st.ep, st.next, st.active]);
      check('E10 links', st.rows[3].href === tvHrefs(1, 10)[3], st.rows[3].href);
      await key('Escape');
      st = await state();
      check('Escape closes the series sheet only', !st.open && st.modalOpen);
      await evaluate('closeModal()');
      await sleep(300);
    }

    if (!ONLY || ONLY === 'phone') {
      /* ---------- PHONE ---------- */
      console.log('\n== phone 390x844 (touch)');
      await send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'Android' }, S);
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, S);
      await loadHome();
      check('phone modal opens', await openTitle(MOVIE, 'movie', true));
      await clickSel('.btn-download', true);
      await waitFor('MZDownloads.isOpen()', 8000, 'phone sheet');
      await sleep(600);
      st = await state();
      check('phone: bottom sheet, full width, flush with the bottom', st.open && st.card.w === st.card.vw && Math.abs(st.card.y + st.card.h - st.card.vh) <= 1,
        st.card);
      check('phone: sheet fits the screen', st.card.h <= st.card.vh * 0.88 + 1, st.card);
      await shot('tmp-dlsheet-phone-movie.jpg');
      await tap(195, 40);
      await sleep(300);
      st = await state();
      check('phone: tapping above the sheet closes it', !st.open && st.modalOpen);
      await evaluate('closeModal()');
      await sleep(300);
      check('phone series modal opens', await openTitle(SHOW, 'tv', true));
      await clickSel('.btn-download', true);
      await waitFor('MZDownloads.isOpen()', 8000, 'phone series sheet');
      await sleep(600);
      st = await state();
      check('phone series: episode bar shown', !!st.ep && st.ep.indexOf('S1 ' + DOT + ' E1') === 0, st.ep);
      await shot('tmp-dlsheet-phone-series.jpg');
      const overflowRows = await evaluate("Array.from(document.querySelectorAll('#dlSheet .dl-row')).filter((r) => r.scrollWidth > r.clientWidth + 1).length");
      check('phone: no row overflows horizontally', overflowRows === 0, overflowRows);
      await evaluate('closeModal()');
      await sleep(300);
      await send('Emulation.setTouchEmulationEnabled', { enabled: false }, S);
      await send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_UA }, S);
    }

    if (!ONLY || ONLY === 'tv') {
      /* ---------- TV (remote keys) ---------- */
      console.log('\n== TV 1920x1080 (?tv=1, remote keys)');
      await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, S);
      await loadHome('?tv=1');
      check('TV mode is on', (await evaluate("document.documentElement.getAttribute('data-mz-tv')")) === 'true');
      check('TV modal opens', await openTitle(MOVIE, 'movie'));
      await sleep(500);
      await evaluate("document.querySelector('.btn-download').focus()");
      const popupsBeforeOk = popups.length;
      await key('Enter');
      await waitFor('MZDownloads.isOpen()', 8000, 'TV sheet');
      await sleep(400);
      st = await state();
      check('TV: OK on Download opens the sheet on the first server', st.open && st.inSheet && st.active.indexOf(movieHrefs[0]) !== -1, st.active);
      check('TV: the opening OK press does not also open a server tab', popups.length === popupsBeforeOk, popups.slice(popupsBeforeOk));
      // A held OK auto-repeats onto the freshly focused row; repeats must not open tabs.
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, autoRepeat: true }, S);
      await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, autoRepeat: true }, S);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, S);
      await sleep(900);
      check('TV: an auto-repeated OK does not open a tab', popups.length === popupsBeforeOk, popups.slice(popupsBeforeOk));
      // ...but a deliberate OK on a row does.
      await key('Enter');
      await sleep(1200);
      check('TV: a deliberate OK on a row opens that server', popups.slice(popupsBeforeOk).indexOf(movieHrefs[0]) !== -1, popups.slice(popupsBeforeOk));
      st = await state();
      const scrollBefore = await evaluate("document.getElementById('modal-overlay').scrollTop + ',' + (window.pageYOffset || 0)");
      await key('ArrowDown');
      await key('ArrowDown');
      st = await state();
      check('TV: D-pad Down walks the rows inside the sheet', st.inSheet && st.active.indexOf(movieHrefs[2]) !== -1, st.active);
      await key('ArrowRight');
      st = await state();
      check('TV: Right is consumed, focus never reaches the page underneath', st.inSheet && st.active.indexOf(movieHrefs[2]) !== -1, st.active);
      const scrollAfter = await evaluate("document.getElementById('modal-overlay').scrollTop + ',' + (window.pageYOffset || 0)");
      check('TV: the page under the sheet did not scroll', scrollBefore === scrollAfter, [scrollBefore, scrollAfter]);
      await shot('tmp-dlsheet-tv.jpg');
      await key('Unidentified', { keyCode: 10009, code: '' });   // Tizen Back
      st = await state();
      check('TV: Back closes the sheet and keeps the watch page', !st.open && st.modalOpen, { open: st.open, modal: st.modalOpen });
      check('TV: focus is back on Download', /btn-download/.test(st.active), st.active);
      await key('Enter');
      await waitFor('MZDownloads.isOpen()', 5000, 'TV reopen');
      await sleep(300);
      await key('Unidentified', { keyCode: 461, code: '' });     // webOS Back
      st = await state();
      check('TV: webOS Back closes it too', !st.open && st.modalOpen);

      // An install prompt that pops up over the open sheet owns Back first.
      await key('Enter');
      await waitFor('MZDownloads.isOpen()', 5000, 'TV reopen for prompt');
      await sleep(300);
      await evaluate(`(() => {
        let o = document.getElementById('pwa-install-tv-overlay');
        if (!o) { o = document.createElement('div'); o.id = 'pwa-install-tv-overlay'; o.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:120px;z-index:9999;background:#222'; document.body.appendChild(o); }
        let b = document.getElementById('pwaTvDismissBtn');
        if (!b) { b = document.createElement('button'); b.id = 'pwaTvDismissBtn'; b.textContent = 'Not now'; o.appendChild(b); }
        b.addEventListener('click', () => o.classList.remove('open'), { once: true });
        o.classList.add('open');
        b.focus();
        return true;
      })()`);
      await sleep(200);
      const promptFocus = await evaluate("document.activeElement && document.activeElement.id");
      check('TV: a prompt over the sheet may take focus', promptFocus === 'pwaTvDismissBtn', promptFocus);
      await key('Escape');
      st = await state();
      const promptOpen = await evaluate("document.getElementById('pwa-install-tv-overlay').classList.contains('open')");
      check('TV: Back dismisses the prompt first and keeps the sheet', !promptOpen && st.open && st.modalOpen, { prompt: promptOpen, sheet: st.open });
      await key('ArrowDown');
      st = await state();
      check('TV: after the prompt, the D-pad is back inside the sheet', st.inSheet, st.active);
      await key('Escape');
      st = await state();
      check('TV: then Back closes the sheet', !st.open && st.modalOpen);
      const overlaysBefore = await evaluate("Array.from(document.querySelectorAll('.open[id]')).map((e) => e.id)");
      await key('Escape');
      await sleep(500);
      st = await state();
      if (st.modalOpen) {
        console.log('  debug: open before Back', JSON.stringify(overlaysBefore), 'after',
          JSON.stringify(await evaluate("Array.from(document.querySelectorAll('.open[id]')).map((e) => e.id)")), 'active', st.active);
      }
      check('TV: the next Back closes the watch page as before', !st.modalOpen);
    }
  } catch (e) {
    fails++;
    console.log('  FAIL  harness error: ' + e.stack);
  }

  const ours = errors.filter((e) => !/datadog|browser-intake|googletagmanager|favicon/i.test(e));
  check('no page exceptions or console errors', ours.length === 0, ours.slice(0, 8));
  console.log('\n' + (fails ? fails + ' FAILED' : 'ALL PASSED'));

  ws.close();
  chrome.kill();
  server.close();
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }, 1500);
})().catch((e) => { console.error(e); process.exit(1); });
