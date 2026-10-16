'use strict';
/* Temporary: why does a CDP click on #sectionHeading not reach the page? Deleted after use. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('undici');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9389;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej));
(async () => {
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzdl4-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) { await sleep(300); try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + CDP_PORT + '/json/version')).webSocketDebuggerUrl; } catch (e) {} }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0; const pending = new Map();
  const send = (method, params, sessionId, ms) => new Promise((resolve) => {
    const id = ++seq; const t = setTimeout(() => { pending.delete(id); resolve({ __timeout: method }); }, ms || 15000);
    pending.set(id, (v) => { clearTimeout(t); resolve(v); });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m.result || m.error || {}); } });
  const { targetInfos } = await send('Target.getTargets');
  const mainId = targetInfos.find((t) => t.type === 'page').targetId;
  const S = (await send('Target.attachToTarget', { targetId: mainId, flatten: true })).sessionId;
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S); return r.result ? r.result.value : r; };
  console.log('metrics', JSON.stringify(await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }, S)));
  await send('Page.navigate', { url: BASE + '/' }, S);
  for (let i = 0; i < 100; i++) { await sleep(300); if (await ev("document.readyState === 'complete' && typeof openModal === 'function'")) break; }
  await sleep(2500);
  await ev(`window.__log = []; ['pointerdown','mousedown','mouseup','click'].forEach((t) => document.addEventListener(t, (e) => window.__log.push(t + ':' + (e.target.id || e.target.className || e.target.tagName) + ':' + e.isTrusted), true)); true`);
  const c = await ev(`(() => { const el = document.getElementById('sectionHeading'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, sy: scrollY }; })()`);
  console.log('heading', JSON.stringify(c));
  await sleep(400);
  const c2 = await ev(`(() => { const r = document.getElementById('sectionHeading').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, sy: scrollY, top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).id }; })()`);
  console.log('heading2', JSON.stringify(c2));
  console.log('move', JSON.stringify(await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c2.x, y: c2.y }, S)));
  console.log('press', JSON.stringify(await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c2.x, y: c2.y, button: 'left', buttons: 1, clickCount: 1 }, S)));
  console.log('release', JSON.stringify(await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c2.x, y: c2.y, button: 'left', buttons: 0, clickCount: 1 }, S)));
  await sleep(500);
  console.log('log', JSON.stringify(await ev('window.__log')));
  ws.close(); chrome.kill(); server.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} process.exit(0); }, 1200);
})().catch((e) => { console.error(e); process.exit(1); });
