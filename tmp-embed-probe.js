/*  Throwaway. Deleted after use.
 *
 *  Real-Chrome playback probe for embed providers, built on the same idea as
 *  tmp-embed-verify.js (a 200 proves nothing, only a <video> with a duration
 *  does), plus the two things a server swap here has to be judged on:
 *
 *    - AUDIO LANGUAGES: every HLS manifest the provider fetches is read through
 *      Network.getResponseBody and its #EXT-X-MEDIA:TYPE=AUDIO tracks listed, so
 *      "Hindi dub" is a measured fact, not a landing-page claim.
 *    - IN-PLAYER SERVERS: the frame's own text is searched for "Hindi", which is
 *      how players that list per-language servers expose them.
 *
 *  Usage: node tmp-embed-probe.js "<url>" ["<url>" ...]
 *  Env:   PORT (debugger, default 9363), WAIT_MS (default 30000),
 *         REFERRER (iframe referrerpolicy, default no-referrer — what the app uses)
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('undici');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.PORT || 9363);
const HARNESS_PORT = PORT + 1;
const WAIT_MS = Number(process.env.WAIT_MS || 30000);
const REFERRER = process.env.REFERRER || 'no-referrer';
const REAL_UA = process.env.SPOOF_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const urls = process.argv.slice(2);
if (!urls.length) { console.error('give at least one embed url'); process.exit(1); }

let currentTarget = '';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>harness</title>
<style>html,body{margin:0;background:#000;height:100%}iframe{width:100vw;height:100vh;border:0}</style>
<script>window.__msgs=[];window.addEventListener('message',function(e){var d=e.data;var t=(d&&typeof d==='object'&&d.type)||(typeof d==='string'?d.slice(0,40):typeof d);window.__msgs.push({o:e.origin,t:t,at:Math.round(performance.now())});});</script>
<iframe src="${currentTarget.replace(/"/g, '&quot;')}"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        referrerpolicy="${REFERRER}" allowfullscreen></iframe>`);
});
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); })
    .on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(HARNESS_PORT, r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzprobe-'));
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
  const send = (method, params, sessionId) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 8000);
  });

  const sessions = new Map();
  const popups = new Set();
  /*  Popunder tabs must be closed, not just ignored: one left open sits in front
   *  of the harness, the harness becomes a background tab, and every later player
   *  defers media until it is visible — which reads as "no stream" for servers
   *  that work fine. Closed outside the event handler, then the harness is
   *  brought back to front. */
  const popupTargets = new Set();
  const closePopups = async () => {
    for (const tid of [...popupTargets]) {
      popupTargets.delete(tid);
      await send('Target.closeTarget', { targetId: tid });
    }
  };
  let harnessReady = false;
  let state = null;
  const resetState = () => {
    state = { reqs: 0, hosts: new Set(), xhr: [], manifests: [], audio: new Set(), popupCount: 0, failedDocs: [] };
  };
  resetState();

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    if (!m.method) return;
    const p = m.params;
    if (m.sessionId && popups.has(m.sessionId)) return;
    if (m.method === 'Target.attachedToTarget') {
      const sid = p.sessionId;
      sessions.set(sid, p.targetInfo);
      if (p.targetInfo.type === 'page' && harnessReady) {
        popups.add(sid); state.popupCount++;
        popupTargets.add(p.targetInfo.targetId);
        send('Runtime.runIfWaitingForDebugger', {}, sid);
        return;
      }
      send('Network.enable', {}, sid);
      send('Page.enable', {}, sid);
      send('Runtime.runIfWaitingForDebugger', {}, sid);
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
      return;
    }
    if (m.method === 'Target.detachedFromTarget') { sessions.delete(p.sessionId); return; }
    if (m.method === 'Network.requestWillBeSent') {
      state.reqs++;
      try { state.hosts.add(new URL(p.request.url).host); } catch (e) {}
      return;
    }
    if (m.method === 'Network.responseReceived') {
      const r = p.response;
      const looksHls = /mpegurl/i.test(r.mimeType || '') || /\.m3u8(\?|$)/i.test(r.url);
      /*  Any XHR/Fetch, whatever its declared type: several providers disguise
       *  playlists as .png/.txt/.json, so a mime filter misses exactly the
       *  manifests worth reading. Bodies are checked for #EXTM3U afterwards. */
      if (looksHls || p.type === 'XHR' || p.type === 'Fetch') {
        if (state.xhr.length < 160) state.xhr.push({ sid: m.sessionId, id: p.requestId, url: r.url, hls: looksHls });
      }
      if (p.type === 'Document' && r.status >= 400) state.failedDocs.push(r.status + ' ' + r.url.slice(0, 90));
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

  const summary = [];
  for (const target of urls) {
    currentTarget = target;
    resetState();
    const t0 = Date.now();
    await send('Page.navigate', { url: 'http://127.0.0.1:' + HARNESS_PORT + '/?t=' + Date.now() }, pageSession);
    await sleep(6500);
    // A real viewer taps play (and dismisses the first-tap popunder), so the probe does too.
    for (const gap of (process.env.NO_CLICK ? [] : [0, 3500, 3500])) {
      if (gap) await sleep(gap);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: 640, y: 360, button: 'left', clickCount: 1 }, pageSession);
      }
      await sleep(400);
      await closePopups();
      await send('Page.bringToFront', {}, pageSession);
    }
    // Keep the harness the visible tab for the whole wait.
    const until = Date.now() + Math.max(0, WAIT_MS - 14700);
    while (Date.now() < until) {
      await sleep(Math.min(4000, Math.max(0, until - Date.now())));
      if (popupTargets.size) { await closePopups(); await send('Page.bringToFront', {}, pageSession); }
    }

    // Read manifests (and anything that turns out to be one) for audio renditions.
    for (const x of state.xhr) {
      const body = await send('Network.getResponseBody', { requestId: x.id }, x.sid);
      if (!body || typeof body.body !== 'string') continue;
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      if (!/^\s*#EXTM3U/.test(text)) continue;
      state.manifests.push(x.url);
      text.split(/\r?\n/).forEach((line) => {
        const rs = /^#EXT-X-STREAM-INF:.*RESOLUTION=(\d+)x(\d+)/.exec(line);
        if (rs) state.maxH = Math.max(state.maxH || 0, Number(rs[2]));
        if (!/^#EXT-X-MEDIA:/.test(line) || !/TYPE=AUDIO/.test(line)) return;
        const name = (line.match(/NAME="([^"]*)"/) || [])[1] || '';
        const lang = (line.match(/LANGUAGE="([^"]*)"/) || [])[1] || '';
        state.audio.add((lang || '?') + ':' + name);
      });
    }

    let playback = null;
    let hindiDom = false;
    let texts = [];
    for (const sid of [...sessions.keys()]) {
      if (popups.has(sid)) continue;
      const r = await send('Runtime.evaluate', {
        expression: `(() => {
          /*  Deep search: players built on web components keep <video> inside a
           *  shadow root, and some nest a same-origin iframe; a flat
           *  querySelector misses both and reports a playing server as dead. */
          const found = [];
          const walk = (root, depth) => {
            if (!root || depth > 6) return;
            try { root.querySelectorAll('video').forEach(v => found.push(v)); } catch (e) {}
            let all = [];
            try { all = root.querySelectorAll('*'); } catch (e) {}
            for (const el of all) {
              if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
              if (el.tagName === 'IFRAME') { try { if (el.contentDocument) walk(el.contentDocument, depth + 1); } catch (e) {} }
            }
          };
          walk(document, 0);
          const v = found.find(x => x.duration > 0) || found[0];
          return { video: v ? { dur: v.duration, cur: v.currentTime, ready: v.readyState, w: v.videoWidth, h: v.videoHeight } : null,
                   hindiDom: /hindi/i.test(document.documentElement ? document.documentElement.textContent || '' : ''),
                   text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1500) }; })()`,
        returnByValue: true
      }, sid);
      const v = r && r.result && r.result.value;
      if (!v) continue;
      if (v.video && Number.isFinite(v.video.dur) && v.video.dur > 0 && (!playback || !(playback.dur > 0))) playback = v.video;
      else if (v.video && !playback) playback = v.video;
      if (v.text && v.text.trim()) texts.push(v.text);
      if (v.hindiDom) hindiDom = true;
    }
    const allText = texts.join(' | ');
    {
      const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__msgs||[])', returnByValue: true }, pageSession);
      let msgs = [];
      try { msgs = JSON.parse((r && r.result && r.result.value) || '[]'); } catch (e) {}
      const byType = {};
      msgs.forEach((x) => { const k = (x.o || '').replace(/^https?:\/\//, '') + ' ' + x.t; if (!byType[k]) byType[k] = { n: 0, first: x.at }; byType[k].n++; });
      console.log('   messages: ' + (Object.keys(byType).map((k) => k + ' x' + byType[k].n + ' @' + byType[k].first + 'ms').join(' ; ') || 'none'));
    }
    const plays = !!(playback && ((playback.w > 0 && playback.h > 0) || (Number.isFinite(playback.dur) && playback.dur > 0 && playback.ready >= 2)));
    const errorish = /couldn.?t find|content unavailable|no sources|not available|unavailable|unable to|sandbox|unsupported|refused to connect|something went wrong|failed to load|forbidden|blocked|not found|404|error/i;
    const errMatch = (allText.match(new RegExp('.{0,40}(' + errorish.source + ').{0,60}', 'i')) || [])[0] || '';
    const hindiInUi = /hindi/i.test(allText) || hindiDom;
    const row = {
      target,
      plays,
      res: playback && playback.w ? playback.w + 'x' + playback.h : '-',
      dur: playback && Number.isFinite(playback.dur) ? Math.round(playback.dur) + 's' : '-',
      audio: [...state.audio].join(', '),
      hindiInUi,
      manifests: state.manifests.length,
      popups: state.popupCount,
      reqs: state.reqs,
      hosts: state.hosts.size,
      err: plays ? '' : errMatch.trim().slice(0, 110),
      failedDocs: state.failedDocs.slice(0, 2).join(' ; '),
      secs: Math.round((Date.now() - t0) / 1000)
    };
    summary.push(row);
    console.log((plays ? 'PLAYS    ' : 'NO STREAM') + '  ' + target);
    console.log('   video=' + row.res + ' dur=' + row.dur + ' manifests=' + row.manifests + ' maxVariant=' + (state.maxH ? state.maxH + 'p' : '-') + ' audio=[' + row.audio + ']'
      + ' hindiInUI=' + hindiInUi + ' popups=' + row.popups + ' reqs=' + row.reqs + ' hosts=' + row.hosts);
    if (row.err) console.log('   on-screen: "' + row.err + '"');
    if (row.failedDocs) console.log('   failed docs: ' + row.failedDocs);
    if (!plays && !row.err) console.log('   text: "' + allText.slice(0, 160) + '"');
  }

  console.log('\n' + '#'.repeat(90));
  summary.forEach((r) => console.log((r.plays ? 'PLAYS     ' : 'NO STREAM ') + r.res.padEnd(10)
    + (r.audio ? '[' + r.audio.slice(0, 60) + '] ' : '') + (r.hindiInUi ? '(Hindi in UI) ' : '') + r.target.slice(0, 90)));

  ws.close(); chrome.kill(); server.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {} process.exit(0); }, 1500);
})().catch((e) => { console.error(e); process.exit(1); });
