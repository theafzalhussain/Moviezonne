/*  Throwaway. Deleted after use.
 *  Scrolls the whole home page on a phone profile (360x740 DPR2 Android, no
 *  throttling) and records layout shifts while scrolling plus <img> elements
 *  whose box was 0px tall when first measured near the viewport.
 *  VARIANT_CSS (env) is injected at DOMContentLoaded.
 *  Usage: node tmp-shift-probe.js [label]
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzshift-'));
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
    await S('Page.enable'); await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l' });
    const pre = ["try{localStorage.setItem('mz_pwa_prompt_dismissed_at', String(Date.now()))}catch(e){}",
      "window.__ls=[];try{new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(!e.hadRecentInput)__ls.push({v:e.value,t:Math.round(e.startTime),src:(e.sources||[]).map(s=>s.node?((s.node.className&&typeof s.node.className==='string'?'.'+s.node.className.split(' ')[0]:s.node.nodeName)):'?').slice(0,3).join('|')})})).observe({type:'layout-shift',buffered:true})}catch(e){}"];
    if (VARIANT) pre.push("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=" + JSON.stringify(VARIANT) + ";document.head.appendChild(s)});");
    await S('Page.addScriptToEvaluateOnNewDocument', { source: pre.join('\n') });
    await S('Page.navigate', { url: APP });
    for (let i = 0; i < 150; i++) { await sleep(200); if (await ev("document.querySelectorAll('#movieGrid .movie-card img').length >= 12")) break; }
    await sleep(5000);
    const loadShift = await ev('__ls.reduce((a, e) => a + e.v, 0)');
    await ev('__ls.length = 0, true');
    // Scroll the whole page, a viewer's pace; note images that are 0px tall as they approach.
    await ev("window.__zero = new Set(); true");
    for (let s = 0; s < 60; s++) {
      const done = await ev(`(() => { const H = innerHeight;
        for (const img of document.images) { const r = img.getBoundingClientRect();
          if (r.top < H * 1.5 && r.bottom > -H * 0.5 && r.height < 1 && getComputedStyle(img).display !== 'none' && img.offsetParent) {
            __zero.add((img.closest('[id]') ? '#' + img.closest('[id]').id + ' ' : '') + (img.className || img.alt || img.src).toString().slice(0, 40)); } }
        const atEnd = innerHeight + scrollY >= document.scrollingElement.scrollHeight - 4;
        if (!atEnd) scrollBy(0, Math.round(H * 0.7)); return atEnd; })()`);
      await sleep(450);
      if (done) break;
    }
    const r = await ev(`({ scrollShift: +__ls.reduce((a, e) => a + e.v, 0).toFixed(4), shifts: __ls.length,
      top: __ls.sort((a, b) => b.v - a.v).slice(0, 5).map((e) => e.v.toFixed(4) + '@' + e.t + ' ' + e.src),
      zeroImgs: Array.from(__zero).slice(0, 12), zeroCount: __zero.size, pageH: document.scrollingElement.scrollHeight, imgs: document.images.length })`);
    r.loadShift = +Number(loadShift).toFixed(4);
    console.log(LABEL + ': ' + JSON.stringify(r));
  } finally {
    try { ws.close(); } catch (e) {}
    await new Promise((resolve) => { const rm = () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} resolve(); }; if (child.exitCode !== null) return rm(); child.once('exit', rm); setTimeout(rm, 5000); try { child.kill(); } catch (e) { rm(); } });
  }
})().catch((e) => { console.error(e); process.exit(1); });
