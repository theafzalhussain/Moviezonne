/*  Throwaway. Deleted after use.
 *  How far below the fold is a grid card when its poster request starts?
 *  Scrolls the home page slowly on a phone profile and samples every card's
 *  distance below the viewport; joins that with each poster's resource
 *  startTime. VARIANT_CSS (env) is injected at DOMContentLoaded.
 *  Usage: node tmp-lead-probe.js [label]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP || 'http://localhost:3001/';
const LABEL = process.argv[2] || 'current';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VARIANT = process.env.VARIANT_CSS || '';

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzlead-'));
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
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result || m.error); } });
  const send = (method, params, sessionId) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId })); setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); resolve(null); } }, 30000); });
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
    const pre = ["try{localStorage.setItem('mz_pwa_prompt_dismissed_at', String(Date.now()))}catch(e){}",
      // sample every card's distance below the fold, every 50 ms
      "window.__pos=[];setInterval(()=>{const H=innerHeight;const t=performance.now();const g=document.querySelectorAll('#movieGrid .movie-card img');const row=[];g.forEach((img,i)=>{const r=img.getBoundingClientRect();row.push(Math.round(r.top-H))});if(row.length)__pos.push([t,row])},50);"];
    if (VARIANT) pre.push("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=" + JSON.stringify(VARIANT) + ";document.head.appendChild(s)});");
    await S('Page.addScriptToEvaluateOnNewDocument', { source: pre.join('\n') });
    await S('Page.navigate', { url: APP });
    for (let i = 0; i < 150; i++) { await sleep(200); if (await ev("document.querySelectorAll('#movieGrid .movie-card img').length >= 12")) break; }
    await sleep(4000);
    const atTop = await ev(`(() => { const imgs = Array.from(document.querySelectorAll('#movieGrid .movie-card img'));
      const started = new Set(performance.getEntriesByType('resource').map((r) => r.name));
      const H = innerHeight; const first = imgs[0].getBoundingClientRect().top - H;
      return { cards: imgs.length, firstCardBelowFold: Math.round(first), requested: imgs.filter((i) => started.has(i.currentSrc) || (i.complete && i.naturalWidth > 0)).length }; })()`);
    // Slow scroll: 120 px every 250 ms down to the end of the grid.
    for (let s = 0; s < 200; s++) {
      const end = await ev("(() => { const g = document.getElementById('movieGrid').getBoundingClientRect(); if (g.bottom < innerHeight * 0.5) return true; scrollBy(0, 120); return false; })()");
      await sleep(250);
      if (end) break;
    }
    await sleep(1000);
    const lead = await ev(`(() => {
      const imgs = Array.from(document.querySelectorAll('#movieGrid .movie-card img'));
      const res = performance.getEntriesByType('resource');
      const out = [];
      imgs.forEach((img, i) => {
        const src = img.currentSrc; const e = res.find((r) => r.name === src);
        if (!e) { out.push(null); return; }
        let best = null;
        for (const [t, row] of __pos) { if (t <= e.startTime && row[i] !== undefined) best = row[i]; else if (t > e.startTime) break; }
        out.push(best);
      });
      const known = out.filter((x) => x !== null);
      known.sort((a, b) => a - b);
      const med = known.length ? known[Math.floor(known.length / 2)] : null;
      return { leads: out, minLead: known.length ? known[0] : null, medianLead: med, missing: out.filter((x) => x === null).length, conn: (navigator.connection || {}).effectiveType };
    })()`);
    console.log(LABEL + ': atTop=' + JSON.stringify(atTop) + ' lead(px below fold when requested)=' + JSON.stringify(lead));
  } finally {
    try { ws.close(); } catch (e) {}
    await new Promise((resolve) => { const rm = () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} resolve(); }; if (child.exitCode !== null) return rm(); child.once('exit', rm); setTimeout(rm, 5000); try { child.kill(); } catch (e) { rm(); } });
  }
})().catch((e) => { console.error(e); process.exit(1); });
