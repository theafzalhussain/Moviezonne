/*  Throwaway. Deleted after use.
 *  What a weak phone downloads for posters on the home page: TMDB requests by
 *  width token, bytes on the wire (CDP encodedDataLength, which works
 *  cross-origin), and the decoded bitmap size of every loaded image.
 *  Phone profile: Android UA, touch, DPR as given, navigator.deviceMemory forced
 *  (Chrome Android's own low-memory signal) — no CPU/network throttling, so the
 *  numbers are deterministic.
 *  Usage: node tmp-poster-bytes.js <label> [W=360] [H=740] [DPR=2] [deviceMemory=2]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP || 'http://localhost:3101/';
const [, , LABEL = 'run', W = '360', H = '740', DPR = '2', MEM = '2'] = process.argv;
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzbytes-'));
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=0', '--hide-scrollbars',
    '--user-agent=' + UA, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let endpoint = null;
  for (let i = 0; i < 150 && !endpoint; i++) {
    await sleep(100);
    try { const [port, p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n'); if (port && p) endpoint = 'ws://127.0.0.1:' + port.trim() + p.trim(); } catch (e) {}
  }
  const ws = new WebSocket(endpoint);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pending = new Map();
  const reqs = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result || m.error); return; }
    if (m.method === 'Network.requestWillBeSent' && /image\.tmdb\.org|\/api\/img\//.test(m.params.request.url)) {
      reqs.set(m.params.requestId, { url: m.params.request.url, bytes: 0 });
    }
    if (m.method === 'Network.loadingFinished' && reqs.has(m.params.requestId)) reqs.get(m.params.requestId).bytes = m.params.encodedDataLength;
  });
  const send = (method, params, sessionId) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId })); setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); resolve(null); } }, 30000); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };
  try {
    await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');
    await S('Network.setCacheDisabled', { cacheDisabled: true });
    await S('Network.setBypassServiceWorker', { bypass: true });
    await S('Emulation.setDeviceMetricsOverride', { width: Number(W), height: Number(H), deviceScaleFactor: Number(DPR), mobile: true });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l' });
    await S('Network.setBlockedURLs', { urls: ['*datadoghq*', '*browser-intake*', '*effectivegate*', '*highperformanceformat*', '*profitablecpmrate*'] });
    await S('Page.addScriptToEvaluateOnNewDocument', { source:
      "try{localStorage.setItem('mz_pwa_prompt_dismissed_at', String(Date.now()))}catch(e){}\n"
      + "try{Object.defineProperty(Navigator.prototype,'deviceMemory',{configurable:true,get:()=>" + Number(MEM) + "})}catch(e){}" });
    await S('Page.navigate', { url: APP });
    for (let i = 0; i < 150; i++) { await sleep(200); if (await ev("document.querySelectorAll('#movieGrid .movie-card img').length >= 12")) break; }
    await sleep(3000);
    // The first eight screens at a reading pace — roughly hero, rails, the grid's first rows.
    for (let s = 0; s < 8; s++) { await ev('scrollBy(0, innerHeight), true'); await sleep(900); }
    await sleep(2000);
    const decoded = await ev(`(() => { const out = { px: 0, imgs: 0, byTok: {} };
      for (const img of document.images) {
        const u = img.currentSrc || img.src; const m = /\\/(w\\d+|original)\\//.exec(u);
        if (!m || !(img.complete && img.naturalWidth > 0)) continue;
        const w = m[1] === 'original' ? img.naturalWidth : Number(m[1].slice(1));
        const px = Math.round(w * w * img.naturalHeight / img.naturalWidth);
        out.px += px; out.imgs++;
        const area = (img.closest('.top10-card') ? 'top10' : img.closest('#movieGrid') ? 'grid' : img.closest('.uv-card') ? 'universes' : img.closest('#hero') ? 'hero' : 'other');
        const k = area + ':' + m[1]; out.byTok[k] = (out.byTok[k] || 0) + 1;
      }
      return out; })()`);
    const byWidth = {};
    let bytes = 0;
    for (const r of reqs.values()) {
      const m = /\/(w\d+|original)\//.exec(r.url); const k = m ? m[1] : '?';
      byWidth[k] = byWidth[k] || { n: 0, kb: 0 };
      byWidth[k].n++; byWidth[k].kb += r.bytes / 1024;
      bytes += r.bytes;
    }
    Object.values(byWidth).forEach((v) => { v.kb = Math.round(v.kb); });
    console.log(LABEL + ' (' + W + 'x' + H + ' @' + DPR + ', deviceMemory ' + MEM + '): requests ' + reqs.size + ', wire ' + Math.round(bytes / 1024) + ' KB '
      + JSON.stringify(byWidth) + '\n   loaded ' + decoded.imgs + ' images, decoded ' + (decoded.px * 4 / 1048576).toFixed(1) + ' MB  ' + JSON.stringify(decoded.byTok));
  } finally {
    try { ws.close(); } catch (e) {}
    await new Promise((resolve) => { const rm = () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} resolve(); }; if (child.exitCode !== null) return rm(); child.once('exit', rm); setTimeout(rm, 5000); try { child.kill(); } catch (e) { rm(); } });
  }
})().catch((e) => { console.error(e); process.exit(1); });
