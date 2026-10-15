/*  Throwaway. Deleted after use.
 *  Drives the REAL app (local server) in Chrome: injects a card for a given TMDB
 *  id into the grid, opens it with a trusted click, presses Play with a trusted
 *  click, then reports which server the app chose, the frame URL over time, and
 *  whether a <video> is decoding inside the provider frame.
 *  Usage: node tmp-e2e-player.js <tmdbId> <movie|tv> [waitMs]
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('undici');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.PORT || 9503);
const APP = process.env.APP || 'http://localhost:3001/';
const [, , TMDB_ID, KIND = 'movie', WAIT = '30000'] = process.argv;
const W = Number(process.env.VW || 1280), H = Number(process.env.VH || 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }).on('error', reject);
});

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mze2e-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--window-size=' + W + ',' + H,
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) { await sleep(500); try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')).webSocketDebuggerUrl; } catch (e) {} }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const sessions = new Map(); const popups = new Set(); let ready = false;
  const send = (method, params, sessionId) => new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); resolve(null); } }, 10000);
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId; sessions.set(sid, m.params.targetInfo);
      if (m.params.targetInfo.type === 'page' && ready) { popups.add(m.params.targetInfo.targetId); }
      send('Runtime.runIfWaitingForDebugger', {}, sid);
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
    }
    if (m.method === 'Target.detachedFromTarget') sessions.delete(m.params.sessionId);
  });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(600);
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  let ps = [...sessions.entries()].find(([, i]) => i.type === 'page'); ps = ps && ps[0];
  if (!ps) ps = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, ps); await send('Runtime.enable', {}, ps);
  ready = true;
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ps); return r && r.result ? r.result.value : null; };
  const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, ps); };
  const closePopups = async () => { for (const t of [...popups]) { popups.delete(t); await send('Target.closeTarget', { targetId: t }); } await send('Page.bringToFront', {}, ps); };

  await send('Page.navigate', { url: APP }, ps);
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev("!!document.querySelector('#movieGrid .movie-card')")) break; }
  if (process.env.SRC_NAME) {
    console.log('forcing server:', await ev(`(() => { const i = playerSources.findIndex(s => s.name === ${JSON.stringify(process.env.SRC_NAME)}); localStorage.setItem('moviezone.playerSourceIdx', String(i)); return i + ' ' + (playerSources[i] || {}).name; })()`));
  }
  // Inject a card for the requested title and open it with a trusted click.
  const rect = await ev(`(() => { const g = document.getElementById('movieGrid');
    const c = document.createElement('div'); c.className = 'movie-card'; c.tabIndex = 0;
    c.setAttribute('data-id', '${TMDB_ID}'); c.setAttribute('data-type', '${KIND}');
    c.style.cssText = 'width:160px;height:240px;background:#333';
    g.prepend(c); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 40 }; })()`);
  await sleep(1200);
  const rect2 = await ev(`(() => { const c = document.querySelector('#movieGrid .movie-card[data-id="${TMDB_ID}"]'); const r = c.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 40 }; })()`);
  rect.x = rect2.x; rect.y = rect2.y;
  await sleep(300);
  console.log('page:', JSON.stringify(await ev(`({ href: location.href, w: innerWidth, h: innerHeight, cards: document.querySelectorAll('#movieGrid .movie-card').length })`)), 'rect:', JSON.stringify(rect));
  console.log('element at click point:', await ev(`(() => { const el = document.elementFromPoint(${'${rect.x}'}, ${'${rect.y}'}); return el ? (el.tagName + '#' + el.id + '.' + el.className).slice(0, 120) : null; })()`.replace('${rect.x}', rect.x).replace('${rect.y}', rect.y)));
  await click(rect.x, rect.y);
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev("document.getElementById('modal-overlay').classList.contains('open')")) break; }
  console.log('modal open:', await ev("document.getElementById('modal-overlay').classList.contains('open')"));
  await sleep(2500);
  const playRect = await ev(`(() => { const b = document.querySelector('.modal-actions .btn-play'); if (!b) return null; b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  console.log('modal title:', await ev("(document.getElementById('modalTitle')||{}).textContent"));
  if (!playRect) { console.log('no play button'); process.exit(1); }
  await sleep(400);
  // The app's own PWA install prompt can open over the modal; a viewer would
  // dismiss it, so the harness does too.
  const dismissPwa = () => ev(`(() => { const o = document.getElementById('pwa-install-overlay'); if (o && o.classList.contains('open')) { const b = o.querySelector('.pwa-btn-later, .pwa-close'); if (b) b.click(); o.classList.remove('open'); return true; } return false; })()`);
  await dismissPwa();
  await sleep(300);
  const pr = await ev(`(() => { const b = document.querySelector('.modal-actions .btn-play'); const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return { x: r.left + r.width/2, y: r.top + r.height/2, hit: el ? (el.tagName + '.' + el.className).slice(0, 80) : null }; })()`);
  console.log('play button:', JSON.stringify(pr));
  if (process.env.SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' }, ps);
    if (shot && shot.data) fs.writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  }
  await click(pr.x, pr.y);
  const t0 = Date.now();
  let lastSrc = '';
  let playerClicks = 0;
  while (Date.now() - t0 < Number(WAIT)) {
    await sleep(1000);
    if (popups.size) await closePopups();
    await dismissPwa();
    // A viewer taps the player to start it (providers without autoplay).
    if (process.env.CLICK_PLAYER && playerClicks < 2 && Date.now() - t0 > 6000 + playerClicks * 5000) {
      playerClicks++;
      const vr = await ev(`(() => { const v = document.getElementById('videoEmbed'); const r = v.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
      if (vr) { await click(vr.x, vr.y); await sleep(500); if (popups.size) await closePopups(); }
    }
    const st = await ev(`(() => { const f = document.getElementById('playerFrame'); const a = document.querySelector('.player-chip--source.active');
      const t = document.getElementById('toast'); return { src: f ? f.src : null, active: a ? a.textContent.replace(/\\s+/g,' ').trim() : null, toast: t ? t.textContent.trim() : '' }; })()`);
    if (st && st.src !== lastSrc) { console.log(((Date.now() - t0) / 1000).toFixed(1) + 's  frame -> ' + st.src + '   [active chip: ' + st.active + ']'); lastSrc = st.src; }
    if (st && st.toast && /doesn't have|failed|Trying/.test(st.toast)) console.log(((Date.now() - t0) / 1000).toFixed(1) + 's  toast: ' + st.toast);
  }
  // Is a video decoding in any provider frame?
  let best = null;
  for (const sid of [...sessions.keys()]) {
    const r = await send('Runtime.evaluate', { expression: `(() => { const v = [...document.querySelectorAll('video')].find(x => x.duration > 0) || document.querySelector('video'); return v ? { href: location.host, dur: v.duration, cur: v.currentTime, w: v.videoWidth, h: v.videoHeight } : null; })()`, returnByValue: true }, sid);
    const v = r && r.result && r.result.value; if (v && v.dur > 0) { best = v; break; }
  }
  console.log('video:', best ? JSON.stringify(best) : 'none');
  console.log('saved server idx:', await ev("localStorage.getItem('moviezone.playerSourceIdx')"));
  ws.close(); chrome.kill();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {} process.exit(0); }, 1500);
})().catch((e) => { console.error(e); process.exit(1); });
