/*  Throwaway diagnostic. Deleted after use.
 *  Same real-Chrome iframe harness as tmp-embed-verify.js, but it prints the
 *  provider's own traffic (status per request, failures, console errors) for the
 *  hosts named in HOST_FILTER, so a "player loads but nothing plays" outage can be
 *  traced to the exact backend call that breaks.
 *
 *  Usage: HOST_FILTER=videasy node tmp-embed-diag.js "<url>"
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('undici');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9353;
const HARNESS_PORT = 9354;
const WAIT_MS = Number(process.env.WAIT_MS || 25000);
const FILTER = new RegExp(process.env.HOST_FILTER || '.', 'i');
const CLICK = process.env.NO_CLICK ? false : true;
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const target = process.argv[2];
if (!target) { console.error('give an embed url'); process.exit(1); }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>harness</title>
<style>html,body{margin:0;background:#000;height:100%}iframe{width:100vw;height:100vh;border:0}</style>
<iframe src="${target.replace(/"/g, '&quot;')}"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        referrerpolicy="${process.env.REFERRER || 'no-referrer'}"
        allowfullscreen></iframe>`);
});
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); })
    .on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(HARNESS_PORT, r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzdiag-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--user-agent=' + REAL_UA,
    '--window-size=1280,720', 'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')).webSocketDebuggerUrl; } catch (e) {}
  }
  if (!wsUrl) { console.error('no debugger'); chrome.kill(); server.close(); process.exit(1); }
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  await new Promise((r) => ws.addEventListener('open', r));
  const sessions = new Map();
  const popups = new Set();
  let harnessReady = false;
  const reqById = new Map();
  const send = (method, params, sessionId) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    // Never let one unanswered command (a popup tearing down, a hung frame)
    // stall the whole trace.
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 6000);
  });
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    if (!m.method) return;
    const p = m.params;
    if (m.sessionId && popups.has(m.sessionId)) return;
    if (m.method === 'Target.attachedToTarget') {
      const sid = p.sessionId;
      sessions.set(sid, p.targetInfo);
      /*  Ad popunders open as new top-level pages. A real viewer closes them; the
       *  harness does too, and keeps their traffic out of the trace. */
      if (p.targetInfo.type === 'page' && harnessReady) {
        popups.add(sid);
        console.log(stamp(), 'POPUP ignored', (p.targetInfo.url || '').slice(0, 100));
        send('Runtime.runIfWaitingForDebugger', {}, sid);
        return;
      }
      if (FILTER.test(p.targetInfo.url || '')) console.log(stamp(), 'ATTACH', p.targetInfo.type, (p.targetInfo.url || '').slice(0, 140));
      send('Network.enable', {}, sid);
      send('Page.enable', {}, sid);
      send('Runtime.enable', {}, sid);
      send('Runtime.runIfWaitingForDebugger', {}, sid);
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
      return;
    }
    if (m.method === 'Target.detachedFromTarget') { sessions.delete(p.sessionId); return; }
    if (m.method === 'Network.requestWillBeSent') {
      reqById.set(p.requestId, p.request.url);
      return;
    }
    if (m.method === 'Network.responseReceived') {
      const u = p.response.url;
      if (FILTER.test(u) || /m3u8|\.mp4|\.ts\b|playlist|master/i.test(u)
          || (process.env.ALL_XHR && /^(Fetch|XHR|EventSource|WebSocket)$/.test(p.type))) {
        console.log(stamp(), String(p.response.status).padEnd(4), p.type.padEnd(10), u.slice(0, 170));
      }
      return;
    }
    if (m.method === 'Network.loadingFailed') {
      const u = reqById.get(p.requestId) || '?';
      if (FILTER.test(u) || /m3u8|\.mp4/i.test(u) || process.env.ALL_XHR) {
        console.log(stamp(), 'FAIL', (p.errorText || '') + (p.blockedReason ? ' blocked=' + p.blockedReason : '')
          + (p.corsErrorStatus ? ' cors=' + JSON.stringify(p.corsErrorStatus) : ''), u.slice(0, 170));
      }
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning' || process.env.ALL_CONSOLE)) {
      const info = sessions.get(m.sessionId);
      if (info && (FILTER.test(info.url || '') || process.env.ALL_CONSOLE)) {
        const text = (p.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
        console.log(stamp(), 'CONSOLE.' + p.type, text.slice(0, 220));
      }
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const info = sessions.get(m.sessionId);
      if (info && (FILTER.test(info.url || '') || process.env.ALL_CONSOLE)) {
        const d = p.exceptionDetails;
        console.log(stamp(), 'EXCEPTION', ((d.exception && d.exception.description) || d.text || '').slice(0, 220));
      }
    }
  });

  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(800);
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  let pageSession = [...sessions.entries()].find(([, info]) => info.type === 'page');
  pageSession = pageSession && pageSession[0];
  if (!pageSession) {
    const r = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    pageSession = r.sessionId;
    await send('Network.enable', {}, pageSession);
    await send('Page.enable', {}, pageSession);
  }
  harnessReady = true;
  await send('Page.navigate', { url: 'http://127.0.0.1:' + HARNESS_PORT + '/?t=' + Date.now() }, pageSession);
  await sleep(7000);
  if (CLICK) {
    for (const at of (process.env.CLICKS || '0,4000,4000').split(',').map(Number)) {
      if (at) await sleep(at);
      console.log(stamp(), '--- click');
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: 640, y: 360, button: 'left', clickCount: 1 }, pageSession);
      }
    }
  }
  await sleep(Math.max(0, WAIT_MS - 12000));

  for (const sid of [...sessions.keys()]) {
    if (popups.has(sid)) continue;
    const info = sessions.get(sid);
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const v = document.querySelector('video');
        return { href: location.href.slice(0, 120), video: v ? { dur: v.duration, cur: v.currentTime, ready: v.readyState, w: v.videoWidth, h: v.videoHeight, src: (v.currentSrc||'').slice(0,140) } : null,
                 text: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 300) }; })()`,
      returnByValue: true
    }, sid);
    const v = r && r.result && r.result.value;
    if (v && (FILTER.test(v.href || '') || v.video)) console.log('\nFRAME', (info && info.type) || '?', JSON.stringify(v));
  }
  ws.close(); chrome.kill(); server.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} process.exit(0); }, 1500);
})().catch((e) => { console.error(e); process.exit(1); });
