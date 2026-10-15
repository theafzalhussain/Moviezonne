/*  Throwaway. Deleted after use.
 *  Weak-phone probe of the REAL home page (local dev server): 360x740 DPR2 Android,
 *  CPU throttled x6, Lighthouse "Slow 4G" network. Measures how many posters are
 *  blank on screen while a viewer flick-scrolls the grid, frame drops during the
 *  scroll, long tasks, and the composited layer count.
 *  EXTRA_CSS (env) is injected to compare variants on identical conditions.
 *  Usage: node tmp-weak-perf.js [label] [runs=1]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP || 'http://localhost:3001/';
const LABEL = process.argv[2] || 'baseline';
const RUNS = Number(process.argv[3] || 1);
const EXTRA_CSS = process.env.EXTRA_CSS || '';
const CPU = Number(process.env.CPU || 6);
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzweak-'));
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
  let id = 0; const pending = new Map(); let layerCount = null;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result || m.error); return; }
    if (m.method === 'LayerTree.layerTreeDidChange' && m.params.layers) layerCount = m.params.layers.length;
  });
  const send = (method, params, sessionId) => new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); resolve(null); } }, 30000);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };
  try {
    await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');
    await S('Network.setCacheDisabled', { cacheDisabled: true });
    await S('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l' });
    await S('Network.setBlockedURLs', { urls: ['*datadoghq*', '*browser-intake*', '*effectivegate*', '*highperformanceformat*', '*profitablecpmrate*'] });
    await S('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
    await S('Emulation.setCPUThrottlingRate', { rate: CPU });
    const pre = ["try{localStorage.setItem('mz_pwa_prompt_dismissed_at', String(Date.now()))}catch(e){}",
      "window.__lt=[];try{new PerformanceObserver(l=>l.getEntries().forEach(e=>__lt.push(e.duration))).observe({type:'longtask',buffered:true})}catch(e){}"];
    if (EXTRA_CSS) pre.push("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=" + JSON.stringify(EXTRA_CSS) + ";document.head.appendChild(s)});");
    await S('Page.addScriptToEvaluateOnNewDocument', { source: pre.join('\n') });
    const t0 = Date.now();
    await S('Page.navigate', { url: APP });
    let gridAt = null;
    for (let i = 0; i < 300; i++) { await sleep(200); if (await ev("document.querySelectorAll('#movieGrid .movie-card img').length >= 12")) { gridAt = Date.now() - t0; break; } }
    if (!gridAt) return { error: 'grid never rendered' };
    await sleep(4000);
    // Flick through the grid: 0.85 viewport per step, a pause like a viewer reading.
    await ev("document.getElementById('movies-section').scrollIntoView({ block: 'start' }), true");
    await ev(`window.__fr = []; (function loop(t0) { requestAnimationFrame((t) => { __fr.push(t - t0); if (__fr.length < 4000 && !window.__stopFr) loop(t); }); })(performance.now()); true`);
    const blanks = [];
    const STEPS = 14;
    for (let s = 0; s < STEPS; s++) {
      await sleep(900);
      const b = await ev(`(() => { const H = innerHeight; let vis = 0, blank = 0;
        for (const img of document.querySelectorAll('#movieGrid .movie-card img')) {
          const r = img.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= H || r.height < 10) continue;
          vis++; if (!(img.complete && img.naturalWidth > 0)) blank++;
        } return [vis, blank]; })()`);
      blanks.push(b);
      await ev('scrollBy(0, Math.round(innerHeight * 0.85)), true');
    }
    await sleep(900);
    const tail = await ev(`(() => { const H = innerHeight; let vis = 0, blank = 0;
        for (const img of document.querySelectorAll('#movieGrid .movie-card img')) {
          const r = img.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= H || r.height < 10) continue;
          vis++; if (!(img.complete && img.naturalWidth > 0)) blank++;
        } return [vis, blank]; })()`);
    blanks.push(tail);
    const stats = await ev(`(() => { window.__stopFr = 1;
      const fr = __fr.slice(1); const long = fr.filter((d) => d > 50).length; const worst = Math.round(Math.max(0, ...fr));
      const imgs = performance.getEntriesByType('resource').filter((r) => /image\\.tmdb\\.org|\\/api\\/img\\//.test(r.name));
      const cards = document.querySelectorAll('#movieGrid .movie-card').length;
      const loaded = Array.from(document.querySelectorAll('#movieGrid .movie-card img')).filter((i) => i.complete && i.naturalWidth > 0).length;
      const widths = {}; imgs.forEach((r) => { const m = /\\/(w\\d+|original)\\//.exec(r.name); const k = m ? m[1] : '?'; widths[k] = (widths[k] || 0) + 1; });
      return { frames: fr.length, over50: long, worst, longTasks: __lt.length, longTaskMs: Math.round(__lt.reduce((a, b) => a + b, 0)), imgReq: imgs.length, imgKB: Math.round(imgs.reduce((a, r) => a + (r.encodedBodySize || r.transferSize || 0), 0) / 1024), widths, cards, loaded,
        lowEnd: document.documentElement.classList.contains('low-end-mode') }; })()`);
    await S('LayerTree.enable');
    for (let i = 0; i < 20 && layerCount === null; i++) await sleep(150);
    await sleep(500);
    stats.layers = layerCount;
    stats.gridAt = gridAt;
    stats.blankSteps = blanks.map((b) => b[1] + '/' + b[0]).join(' ');
    stats.blankTotal = blanks.reduce((a, b) => a + b[1], 0);
    stats.visTotal = blanks.reduce((a, b) => a + b[0], 0);
    return stats;
  } finally {
    try { ws.close(); } catch (e) {}
    await new Promise((resolve) => { const rm = () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} resolve(); }; if (child.exitCode !== null) return rm(); child.once('exit', rm); setTimeout(rm, 5000); try { child.kill(); } catch (e) { rm(); } });
  }
}

(async () => {
  for (let i = 0; i < RUNS; i++) {
    const r = await run();
    console.log(LABEL + ' #' + (i + 1) + ': ' + JSON.stringify(r));
  }
})().catch((e) => { console.error(e); process.exit(1); });
