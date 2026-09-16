/*  Throwaway. Deleted after use.
 *
 *  A 200 on an embed URL proves nothing — that is exactly how the VidRock outage
 *  hid: vidrock.net/movie/550 answers 200 with a normal SPA shell, and only the
 *  provider's own /api returns every upstream with url:null, so the player paints
 *  "Content unavailable". So this drives real Chrome instead of curl:
 *
 *    - loads a local harness page that puts the candidate in a REAL iframe with no
 *      sandbox attribute, because several providers refuse to run outside an iframe
 *      and refuse to run inside a sandboxed one
 *    - auto-attaches to the out-of-process subframe the provider becomes, and
 *      records network from EVERY session, so the frame's own requests are seen
 *    - reports whether a video manifest or segment was actually requested
 *    - reads the frame's own rendered text, so an error panel is caught
 *
 *  Usage: node tmp-embed-verify.js "<url>" ["<url>" ...]
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('undici');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9343;
const HARNESS_PORT = 9344;
const WAIT_MS = Number(process.env.WAIT_MS || 26000);
/*  Headless Chrome advertises "HeadlessChrome/..." and at least one provider
 *  answers that with a bare Apache 403. Overriding it is not evasion for its own
 *  sake — a real visitor sends this, so anything else measures the wrong thing. */
const REAL_UA = process.env.SPOOF_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const urls = process.argv.slice(2);
if (!urls.length) { console.error('give at least one embed url'); process.exit(1); }

let currentTarget = '';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  /*  Frame attributes are copied from loadPlayer() in moviezone.js on purpose —
   *  same `allow` list, same referrerpolicy, and no sandbox — so what this measures
   *  is what the app itself would get, not what a generic test page would. */
  res.end(`<!doctype html><meta charset="utf-8"><title>harness</title>
<style>html,body{margin:0;background:#000;height:100%}iframe{width:100vw;height:100vh;border:0}</style>
<iframe src="${currentTarget.replace(/"/g, '&quot;')}"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        referrerpolicy="no-referrer"
        allowfullscreen></iframe>`);
});

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); })
    .on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(HARNESS_PORT, r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzverify-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--user-agent=' + REAL_UA,
    '--window-size=1280,720',
    'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')).webSocketDebuggerUrl; } catch (e) {}
  }
  if (!wsUrl) { console.error('chrome did not expose a debugger'); chrome.kill(); server.close(); process.exit(1); }

  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  await new Promise((r) => ws.addEventListener('open', r));

  let reqs = [];
  let frameTexts = [];
  const sessions = new Map(); // sessionId -> targetInfo

  const send = (method, params, sessionId) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    if (!m.method) return;
    if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId;
      sessions.set(sid, m.params.targetInfo);
      // Every new frame/worker gets instrumented the moment it appears.
      send('Network.enable', {}, sid);
      send('Page.enable', {}, sid);
      send('Runtime.runIfWaitingForDebugger', {}, sid);
      send('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
      return;
    }
    /*  Without this the map fills with dead sessions from earlier navigations, and
     *  the page session is picked from one of them — which is how this silently
     *  reported zero requests for every candidate. */
    if (m.method === 'Target.detachedFromTarget') { sessions.delete(m.params.sessionId); return; }
    if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
    if (m.method === 'Network.responseReceived') reqs.push('resp:' + m.params.response.url);
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

  const results = [];
  for (const target of urls) {
    currentTarget = target;
    reqs = [];
    frameTexts = [];
    await send('Page.navigate', { url: 'http://127.0.0.1:' + HARNESS_PORT + '/?t=' + Date.now() }, pageSession);
    /*  Some players paint a "continue"/resume overlay and resolve nothing until it
     *  is clicked. A real viewer clicks, so the harness does too — twice, spaced
     *  out, because the overlay often only appears after the shell has booted. */
    await sleep(7000);
    for (const at of [0, 5000]) {
      if (at) await sleep(at);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent',
          { type, x: 640, y: 360, button: 'left', clickCount: 1 }, pageSession);
      }
    }
    await sleep(Math.max(0, WAIT_MS - 12000));

    /*  URL sniffing is not a reliable signal: vidsrc.buzz proxies its segments
     *  through paths with no .m3u8/.ts in them, and vidrock requests a placeholder
     *  demo-video.mp4 while showing an error. So the verdict is taken from the
     *  <video> element itself — a duration and a moving currentTime is playback,
     *  and nothing else is. */
    let playback = null;
    for (const sid of [...sessions.keys()]) {
      const r = await send('Runtime.evaluate', {
        expression: `(() => {
          const v = document.querySelector('video');
          if (!v) return null;
          return { dur: v.duration, cur: v.currentTime, ready: v.readyState,
                   net: v.networkState, w: v.videoWidth, h: v.videoHeight,
                   src: (v.currentSrc || '').slice(0, 120) };
        })()`,
        returnByValue: true
      }, sid);
      const v = r && r.result && r.result.value;
      if (v && Number.isFinite(v.dur) && v.dur > 0) { playback = v; break; }
      if (v && !playback) playback = v;
    }

    // Ask every attached session for its own document text — the provider frame is
    // its own session, so this reaches inside the cross-origin frame legitimately.
    for (const sid of [...sessions.keys()]) {
      const r = await send('Runtime.evaluate', {
        expression: '(document.body && document.body.innerText || "").slice(0, 600)',
        returnByValue: true
      }, sid);
      const v = r && r.result && r.result.value;
      if (v && v.trim()) frameTexts.push(v.replace(/\s+/g, ' ').trim());
    }

    const hosts = new Set();
    reqs.forEach((u) => { try { hosts.add(new URL(u.replace(/^resp:/, '')).host); } catch (e) {} });
    const errorish = /content unavailable|no sources|unable to|not available|sandbox is not allowed|unsupported browser|refused to connect|something went wrong|failed to load|forbidden|don't have permission/i;
    const bad = frameTexts.find((t) => errorish.test(t)) || '';

    /*  A real decode is the strongest evidence: frames have been produced. A
     *  duration with readyState >= 2 means the stream resolved and metadata
     *  loaded even if autoplay was held back by policy. */
    const decoding = !!(playback && playback.w > 0 && playback.h > 0);
    const hasStream = !!(playback && Number.isFinite(playback.dur) && playback.dur > 0
      && playback.ready >= 2);
    const plays = decoding || hasStream;

    results.push({ target, plays, bad, playback });
    console.log('\n' + '='.repeat(78));
    console.log(target);
    console.log('  requests: ' + reqs.length + '  hosts: ' + hosts.size);
    if (playback) {
      console.log('  <video>: duration=' + (Number.isFinite(playback.dur) ? playback.dur.toFixed(1) + 's' : 'none')
        + '  currentTime=' + (playback.cur || 0).toFixed(1) + 's'
        + '  readyState=' + playback.ready
        + '  frame=' + playback.w + 'x' + playback.h);
    } else {
      console.log('  <video>: no element found in any frame');
    }
    console.log('  verdict: ' + (plays
      ? 'PLAYS' + (decoding ? ' — decoding real frames at ' + playback.w + 'x' + playback.h : ' — stream resolved, metadata loaded')
      : 'NO STREAM'));
    if (bad) console.log('  on-screen ERROR: "' + bad.slice(0, 200) + '"');
    else if (frameTexts.length) console.log('  on-screen: "' + frameTexts.join(' | ').slice(0, 160) + '"');
  }

  console.log('\n' + '#'.repeat(78));
  results.forEach((r) => console.log(
    (r.plays ? '  PLAYS      ' : '  NO STREAM  ') + r.target.slice(0, 68)
      + (r.plays && r.playback ? '   ' + r.playback.w + 'x' + r.playback.h : '')
      + (r.bad ? '   <- ' + r.bad.slice(0, 55) : '')
  ));

  ws.close(); chrome.kill(); server.close();
  setTimeout(() => process.exit(0), 500);
})().catch((e) => { console.error(e); process.exit(1); });
