'use strict';
/*  Throwaway (deleted after use). Real-Chrome playback audit, one Chrome per run.
 *  Same idea as tmp-embed-probe.js (only a decoding <video> counts), but the
 *  video is sampled BEFORE any click too, so an autoplaying player is not paused
 *  by the probe's own "tap to play" and misreported as dead.
 *  Usage: JOBS=<json file> OUT=<jsonl file> PORT=<n> node tmp-audit-probe.js */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('undici');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.PORT || 9400);
const HARNESS_PORT = PORT + 1;
const WAIT_MS = Number(process.env.WAIT_MS || 26000);
const jobs = JSON.parse(fs.readFileSync(process.env.JOBS, 'utf8'));
const OUT = process.env.OUT;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }).on('error', reject);
});

let currentTarget = '';
const escapeHtmlAttribute = (value) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[char]));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000;height:100%}iframe{width:100vw;height:100vh;border:0}</style>'
    + '<iframe src="' + escapeHtmlAttribute(currentTarget) + '" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="'
    + (/vidrift|vidzee/.test(currentTarget) ? 'origin' : 'no-referrer') + '" allowfullscreen></iframe>');
});

(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HARNESS_PORT, '127.0.0.1', resolve);
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzaudit-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--user-agent=' + UA, '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) { await sleep(500); try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')).webSocketDebuggerUrl; } catch (e) {} }
  if (!wsUrl) { console.error('no debugger'); process.exit(1); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let msgId = 0;
  const pending = new Map();
  const send = (method, params, sessionId) => new Promise((resolve) => {
    const id = ++msgId; pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 8000);
  });
  const sessions = new Map();
  const popups = new Set();
  const popupTargets = new Set();
  let ready = false;
  let failedDocs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    const p = m.params;
    if (m.method === 'Target.attachedToTarget') {
      const sid = p.sessionId;
      sessions.set(sid, p.targetInfo);
      if (p.targetInfo.type === 'page' && ready) { popups.add(sid); popupTargets.add(p.targetInfo.targetId); send('Runtime.runIfWaitingForDebugger', {}, sid); return; }
      send('Network.enable', {}, sid);
      send('Runtime.runIfWaitingForDebugger', {}, sid);
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
      return;
    }
    if (m.method === 'Target.detachedFromTarget') { sessions.delete(p.sessionId); return; }
    if (m.method === 'Network.responseReceived' && p.type === 'Document' && p.response.status >= 400) {
      failedDocs.push(p.response.status + ' ' + p.response.url.slice(0, 80));
    }
  });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(800);
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  let ps = [...sessions.entries()].find(([, i]) => i.type === 'page'); ps = ps && ps[0];
  if (!ps) ps = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, ps);
  ready = true;
  const closePopups = async () => {
    for (const t of [...popupTargets]) { popupTargets.delete(t); await send('Target.closeTarget', { targetId: t }); }
    await send('Page.bringToFront', {}, ps);
  };
  const sample = async () => {
    let best = null; const texts = [];
    for (const sid of [...sessions.keys()]) {
      if (popups.has(sid)) continue;
      const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const found = [];
        const walk = (root, d) => { if (!root || d > 6) return;
          try { root.querySelectorAll('video').forEach(v => found.push(v)); } catch (e) {}
          let all = []; try { all = root.querySelectorAll('*'); } catch (e) {}
          for (const el of all) { if (el.shadowRoot) walk(el.shadowRoot, d + 1);
            if (el.tagName === 'IFRAME') { try { if (el.contentDocument) walk(el.contentDocument, d + 1); } catch (e) {} } } };
        walk(document, 0);
        const v = found.find(x => x.videoWidth > 0) || found.find(x => x.duration > 0) || found[0];
        return { v: v ? { dur: v.duration, cur: v.currentTime, ready: v.readyState, w: v.videoWidth, h: v.videoHeight, paused: v.paused } : null,
          text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) }; })()` }, sid);
      const val = r && r.result && r.result.value;
      if (!val) continue;
      if (val.text) texts.push(val.text);
      const v = val.v;
      if (v && (!best || (v.w > (best.w || 0)) || (v.dur > 0 && !(best.dur > 0)))) best = v;
    }
    return { v: best, text: texts.join(' | ') };
  };
  const isPlaying = (v) => !!(v && ((v.w > 0 && v.h > 0) || (Number.isFinite(v.dur) && v.dur > 0 && v.ready >= 2)));

  for (const job of jobs) {
    currentTarget = job.url;
    failedDocs = [];
    const t0 = Date.now();
    await send('Page.navigate', { url: 'http://127.0.0.1:' + HARNESS_PORT + '/?t=' + Date.now() }, ps);
    let first = null; let firstAt = null;
    // Poll up to 9s for an autoplaying stream before touching anything.
    for (let i = 0; i < 9; i++) {
      await sleep(1000);
      if (popupTargets.size) await closePopups();
      const s = await sample();
      if (isPlaying(s.v)) { first = s; firstAt = Date.now() - t0; break; }
    }
    let clicked = false;
    if (!first) {
      clicked = true;
      for (const gap of [0, 3000, 3000]) {
        if (gap) await sleep(gap);
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: 640, y: 360, button: 'left', clickCount: 1 }, ps);
        await sleep(400);
        await closePopups();
        const s = await sample();
        if (isPlaying(s.v)) break;
      }
    }
    const until = t0 + WAIT_MS;
    while (Date.now() < until) { await sleep(Math.min(3000, Math.max(0, until - Date.now()))); if (popupTargets.size) await closePopups(); }
    const last = await sample();
    const plays = isPlaying(first && first.v) || isPlaying(last.v);
    const v = (last.v && last.v.w > 0) ? last.v : (first ? first.v : last.v);
    const row = {
      server: job.server, title: job.title, plays,
      res: v && v.w ? v.w + 'x' + v.h : '-', dur: v && Number.isFinite(v.dur) ? Math.round(v.dur) : null,
      cur: last.v ? Math.round(last.v.cur || 0) : null, autoplay: !clicked && plays, firstAt,
      failedDocs: failedDocs.slice(0, 2), text: plays ? '' : last.text.slice(0, 160), url: job.url
    };
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
    console.log((plays ? 'PLAYS ' : 'DEAD  ') + job.server.padEnd(15) + job.title.padEnd(26) + row.res + (row.text ? '  "' + row.text.slice(0, 90) + '"' : ''));
  }
  ws.close(); chrome.kill(); server.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {} process.exit(0); }, 1500);
})().catch((e) => { console.error(e); process.exit(1); });
