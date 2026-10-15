/*  Throwaway. Deleted after use.
 *  Deterministic comparison of a CSS variant against the current page on a phone
 *  profile (360x740 DPR2 Android, no throttling): composited layer count with the
 *  grid on screen, and a pixel diff of identical grid screenshots.
 *  Usage: VARIANT_CSS="..." node tmp-layer-probe.js [width]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP || 'http://localhost:3001/';
const W = Number(process.argv[2] || 360);
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VARIANT = process.env.VARIANT_CSS || '';

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzlayer-'));
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
  let id = 0; const pending = new Map(); let layers = null;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result || m.error); return; }
    if (m.method === 'LayerTree.layerTreeDidChange' && m.params.layers) layers = m.params.layers;
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
    await S('Page.enable'); await S('Runtime.enable'); await S('DOM.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: W, height: 740, deviceScaleFactor: 2, mobile: true });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l' });
    await S('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('mz_pwa_prompt_dismissed_at', String(Date.now()))}catch(e){}" });
    await S('Page.navigate', { url: APP });
    for (let i = 0; i < 150; i++) { await sleep(200); if (await ev("document.querySelectorAll('#movieGrid .movie-card img').length >= 12 && Array.from(document.querySelectorAll('#movieGrid .movie-card img')).slice(0, 8).every((i) => i.complete && i.naturalWidth > 0)")) break; }
    // Freeze anything that moves so the two screenshots are comparable.
    await sleep(3000);
    await ev(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}'; document.head.appendChild(s); return true; })()`);
    for (let i = 0; i < 10; i++) {
      if (process.env.CLIP === 'hero') { await ev('window.scrollTo(0, 0), true'); await sleep(500); break; }
      await ev("(() => { const g = document.getElementById('movieGrid'); window.scrollTo(0, g.getBoundingClientRect().top + window.scrollY - 70); return true; })()");
      await sleep(700);
      if (await ev("Math.abs(document.getElementById('movieGrid').getBoundingClientRect().top - 70) < 2")) break;
    }
    await sleep(process.env.CLIP === 'hero' ? 300 : 2500);
    const clip = process.env.CLIP === 'hero'
      ? await ev("(() => { const h = document.getElementById('hero').getBoundingClientRect(); return { x: 0, y: 0, width: innerWidth, height: Math.round(Math.min(h.bottom, innerHeight)), scale: 1 }; })()")
      : await ev("(() => { const g = document.getElementById('movieGrid').getBoundingClientRect(); return { x: 0, y: Math.max(0, Math.round(g.top)), width: innerWidth, height: Math.min(innerHeight - Math.max(0, Math.round(g.top)), 640), scale: 1 }; })()");
    const activeSlide = () => ev("(() => { const s = Array.from(document.querySelectorAll('#carouselTrack .carousel-slide')); return s.findIndex((x) => x.classList.contains('active')); })()");
    console.log('clip: ' + JSON.stringify(clip) + ' scrollY ' + (await ev('Math.round(scrollY)')) + ' active slide ' + (await activeSlide()));
    const measure = async (tag) => {
      layers = null;
      await S('LayerTree.enable');
      await ev('window.scrollBy(0, 1), new Promise((r) => requestAnimationFrame(() => { window.scrollBy(0, -1); requestAnimationFrame(() => r(true)); }))');
      for (let i = 0; i < 40 && !layers; i++) await sleep(100);
      const all = layers || [];
      const drawn = all.filter((l) => l.drawsContent);
      // Which DOM nodes own the layers?
      const owners = {};
      for (const l of drawn) {
        let name = '(no node)';
        if (l.backendNodeId) {
          const d = await S('DOM.describeNode', { backendNodeId: l.backendNodeId });
          const n = d && d.node;
          if (n) {
            const attrs = n.attributes || [];
            const cls = attrs[attrs.indexOf('class') + 1];
            name = n.nodeName.toLowerCase() + (attrs.includes('class') && cls ? '.' + cls.split(' ')[0] : '');
          }
        }
        owners[name] = (owners[name] || 0) + 1;
      }
      await S('LayerTree.disable');
      const shot = await S('Page.captureScreenshot', { format: 'png', clip });
      const file = path.join(os.tmpdir(), 'mzlayer-' + W + '-' + tag + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const top = Object.entries(owners).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' x' + v).join(', ');
      console.log(tag + ': layers ' + all.length + ' (drawing ' + drawn.length + ')  by owner: ' + top);
      return file;
    };
    const a = await measure('current');
    console.log('pseudo suspects: ' + JSON.stringify(await ev(`(() => { const out = {}; for (const el of document.querySelectorAll('body *')) { for (const p of ['::before', '::after']) { const cs = getComputedStyle(el, p); if (cs.content === 'none' || cs.display === 'none') continue; const why = []; if (cs.willChange !== 'auto') why.push('wc:' + cs.willChange); if (cs.transform !== 'none') why.push('tf:' + cs.transform.slice(0, 30)); if (cs.animationName !== 'none') why.push('anim:' + cs.animationName); if (cs.backdropFilter && cs.backdropFilter !== 'none') why.push('bdf'); if (cs.mixBlendMode !== 'normal') why.push('blend:' + cs.mixBlendMode); if (!why.length) continue; const k = (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : el.tagName) + p + ' ' + why.join(','); out[k] = (out[k] || 0) + 1; } } return out; })()`)));
    await ev('(() => { const s = document.createElement("style"); s.id = "variant"; s.textContent = ' + JSON.stringify(VARIANT) + '; document.head.appendChild(s); return true; })()');
    await sleep(process.env.CLIP === 'hero' ? 250 : 1500);
    const b = await measure('variant');
    console.log('active slide after both shots: ' + (await activeSlide()));
    const [ra, rb] = await Promise.all([sharp(a).raw().toBuffer({ resolveWithObject: true }), sharp(b).raw().toBuffer({ resolveWithObject: true })]);
    let diff = 0, maxd = 0;
    for (let i = 0; i < ra.data.length; i += ra.info.channels) {
      const d = Math.max(Math.abs(ra.data[i] - rb.data[i]), Math.abs(ra.data[i + 1] - rb.data[i + 1]), Math.abs(ra.data[i + 2] - rb.data[i + 2]));
      if (d > 24) diff++;
      if (d > maxd) maxd = d;
    }
    const total = ra.info.width * ra.info.height;
    console.log('pixel diff: ' + diff + ' of ' + total + ' px differ by >24 (' + (100 * diff / total).toFixed(3) + '%), max channel delta ' + maxd);
  } finally {
    try { ws.close(); } catch (e) {}
    await new Promise((resolve) => { const rm = () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} resolve(); }; if (child.exitCode !== null) return rm(); child.once('exit', rm); setTimeout(rm, 5000); try { child.kill(); } catch (e) { rm(); } });
  }
})().catch((e) => { console.error(e); process.exit(1); });
