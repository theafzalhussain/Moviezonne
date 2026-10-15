/*  Throwaway. Deleted after use.
 *  Small-phone layout audit of the REAL app on the local dev server:
 *  home (top + grid), the first-visit PWA popup, the detail modal, the in-app
 *  player, and the SSR watch/detail pages, at phone widths, with an Android UA
 *  (so isMobile / low-end-mode are on) and touch emulation.
 *  Reports elements that stick out of the viewport (not clipped by an in-view
 *  ancestor), labels clipped by their own box, and small tap targets, and saves
 *  screenshots to %TEMP%\mzaudit.
 *  Usage: node tmp-mobile-audit.js [widths=280,320,360,412] [scenarios=home,pwa,modal,player,watch,detail]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP || 'http://localhost:3001';
const SIZES = (process.argv[2] || '280,320,360,412').split(',').map((v) => v.split('x').map(Number));
const WIDTHS = SIZES.map((s) => s[0]);
const HOVERRIDE = Object.fromEntries(SIZES.filter((s) => s[1]).map((s) => [s[0], s[1]]));
const SCEN = new Set((process.argv[3] || 'home,pwa,modal,player,watch,detail').split(','));
const HEIGHT = { 280: 653, 320: 568, 360: 740, 412: 915 };
const OUT = path.join(os.tmpdir(), 'mzaudit');
fs.mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXTRA_CSS = process.env.EXTRA_CSS || '';

const AUDIT = `(() => {
  const W = document.documentElement.clientWidth, H = innerHeight;
  const se = document.scrollingElement;
  const res = { W, H, scrollW: se.scrollWidth, offenders: [], clipped: [], small: [], cut: [] };
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.classList.length) s += '.' + Array.from(el.classList).slice(0, 3).join('.');
    return s;
  };
  const clipsX = (cs) => cs.overflowX !== 'visible' || /paint|strict|content/.test(cs.contain);
  const visible = (el, cs) => cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01;
  const reported = new Set();
  const root = window.__auditRoot ? document.querySelector(window.__auditRoot) : document.body;
  const all = root ? root.querySelectorAll('*') : [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const inY = r.bottom > 0 && r.top < H;
    // 1. sticks out horizontally and is not clipped by an in-view ancestor
    if (r.right > W + 0.5 || r.left < -0.5) {
      let p = el.parentElement, clipped = false;
      while (p && p !== document.documentElement) {
        if (p !== document.body) {
          const pcs = getComputedStyle(p);
          if (clipsX(pcs)) { const pr = p.getBoundingClientRect(); if (pr.right <= W + 0.5 && pr.left >= -0.5) { clipped = true; break; } }
          if (pcs.display === 'none' || !visible(p, pcs)) { clipped = true; break; }
        }
        p = p.parentElement;
      }
      let dup = false;
      for (let a = el.parentElement; a; a = a.parentElement) if (reported.has(a)) { dup = true; break; }
      if (!clipped && !dup && res.offenders.length < 25) {
        reported.add(el);
        res.offenders.push({ el: desc(el), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), y: Math.round(r.top + se.scrollTop), out: r.left >= W || r.right <= 0, pos: cs.position });
      }
    }
    // 1b. content CUT by a clipping ancestor (overflow hidden/clip): the element
    //     straddles the ancestor's edge, so part of it is simply not drawn.
    if (el.childNodes.length && Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim())
        && res.cut.length < 15) {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (!/hidden|clip/.test(pcs.overflowX)) continue;
        const pr = p.getBoundingClientRect();
        const straddles = (r.right > pr.right + 2 && r.left < pr.right - 2) || (r.left < pr.left - 2 && r.right > pr.left + 2);
        if (straddles && pr.width > 40 && pcs.position !== 'fixed') {
          res.cut.push({ el: desc(el), by: desc(p), r: Math.round(r.right), pr: Math.round(pr.right), l: Math.round(r.left), pl: Math.round(pr.left), text: el.textContent.trim().slice(0, 30) });
        }
        break;
      }
    }
    // 2. interactive labels clipped by their own box
    const interactive = el.matches('button, a, [role=button], .player-chip, .cat-tab, input, select, label');
    if (interactive && inY && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible'
        && cs.textOverflow !== 'ellipsis' && !/auto|scroll/.test(cs.overflowX) && res.clipped.length < 15) {
      res.clipped.push({ el: desc(el), sw: el.scrollWidth, cw: el.clientWidth, text: (el.textContent || '').trim().slice(0, 40) });
    }
    // 3. small tap targets that are in view
    if (interactive && inY && r.left >= 0 && r.right <= W && (r.width < 30 || r.height < 30) && res.small.length < 15
        && !el.closest('footer, .site-footer, .mz-ssr-index, .crumbs, .foot, .link-cols')) {
      res.small.push({ el: desc(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24) });
    }
  }
  return res;
})()`;

async function openBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzaudit-'));
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=0', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--user-agent=' + UA, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let endpoint = null;
  for (let i = 0; i < 150 && !endpoint; i++) {
    await sleep(100);
    try {
      const [port, p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      if (port && p) endpoint = 'ws://127.0.0.1:' + port.trim() + p.trim();
    } catch (e) {}
  }
  const ws = new WebSocket(endpoint);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    listeners.forEach((fn) => fn(m));
  });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); resolve(null); } }, 20000);
  });
  const close = () => new Promise((resolve) => {
    try { ws.close(); } catch (e) {}
    const rm = () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} resolve(); };
    if (child.exitCode !== null) return rm();
    child.once('exit', rm); setTimeout(rm, 5000); try { child.kill(); } catch (e) { rm(); }
  });
  return { send, on: (fn) => listeners.push(fn), close };
}

async function page(b, W, opts) {
  const H = HOVERRIDE[W] || HEIGHT[W] || Math.round(W * 2.05);
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => b.send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await S('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l' });
  // Third-party players are not under test here; keep them (and their popups) out.
  await S('Network.setBlockedURLs', { urls: ['*vidrift.net*', '*moviesapi.vip*', '*ollyembed*', '*vidnest.fun*', '*vidfast.vc*', '*vidlove.cc*', '*viduki*', '*vidzee*', '*vidlink*', '*vidsrc*', '*datadoghq*', '*browser-intake*', '*effectivegate*', '*highperformanceformat*', '*profitablecpmrate*'] });
  const pre = [];
  if (opts && opts.dismissPwa) pre.push("try{localStorage.setItem('mz_pwa_prompt_dismissed_at', String(Date.now()))}catch(e){}");
  if (EXTRA_CSS) pre.push("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=" + JSON.stringify(EXTRA_CSS) + ";document.head.appendChild(s)});");
  if (pre.length) await S('Page.addScriptToEvaluateOnNewDocument', { source: pre.join('\n') });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };
  const waitFor = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (e) {} await sleep(150); } return false; };
  const shot = async (name) => {
    const r = await S('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) fs.writeFileSync(path.join(OUT, W + '-' + name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const tap = async (x, y) => {
    x = Math.round(x); y = Math.round(y);
    await ev("window.__clicks = 0; if (!window.__clickHook) { window.__clickHook = 1; document.addEventListener('click', () => { window.__clicks++; }, true); } true");
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(350);
    if (!(await ev('window.__clicks'))) {
      console.log('      (touch produced no click at ' + x + ',' + y + ' — using a mouse click)');
      for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  };
  return { S, ev, waitFor, shot, tap, W, H, close: () => b.send('Target.closeTarget', { targetId }) };
}

function report(W, name, a) {
  if (!a) { console.log('  [' + W + '] ' + name + ': audit failed'); return; }
  const off = a.offenders.filter((o) => !o.out);
  const outs = a.offenders.filter((o) => o.out);
  console.log('  [' + W + '] ' + name + ': docScrollW=' + a.scrollW + ' (vw ' + a.W + ')'
    + (off.length ? '' : '  no overflow') + (outs.length ? '  [' + outs.length + ' fully off-screen: ' + outs.map((o) => o.el).slice(0, 4).join(', ') + ']' : ''));
  off.forEach((o) => console.log('      OVERFLOW ' + o.el + '  x ' + o.l + '..' + o.r + ' (w ' + o.w + ') y ' + o.y + ' ' + o.pos));
  a.clipped.forEach((c) => console.log('      CLIPPED  ' + c.el + '  ' + c.sw + '>' + c.cw + '  "' + c.text + '"'));
  (a.cut || []).forEach((c) => console.log('      CUT      ' + c.el + ' by ' + c.by + '  el ' + c.l + '..' + c.r + ' clip ' + c.pl + '..' + c.pr + '  "' + c.text + '"'));
  a.small.forEach((s) => console.log('      SMALL    ' + s.el + '  ' + s.w + 'x' + s.h + '  "' + s.text + '"'));
}

(async () => {
  const b = await openBrowser();
  try {
    for (const W of WIDTHS) {
      if (SCEN.has('home') || SCEN.has('modal') || SCEN.has('player')) {
        const p = await page(b, W, { dismissPwa: true });
        await p.S('Page.navigate', { url: APP + '/' });
        const ok = await p.waitFor("document.querySelectorAll('#movieGrid .movie-card').length >= 6", 30000);
        if (!ok) { console.log('  [' + W + '] home: grid never rendered'); await p.close(); continue; }
        await sleep(2500);
        const meta = await p.ev("({ lowEnd: document.documentElement.classList.contains('low-end-mode'), coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, dpr: devicePixelRatio })");
        if (W === WIDTHS[0]) console.log('  env: ' + JSON.stringify(meta));
        if (SCEN.has('home')) {
          report(W, 'home/top', await p.ev(AUDIT));
          await p.shot('home-top');
          await p.ev("document.getElementById('movies-section') && document.getElementById('movies-section').scrollIntoView({block:'start'}), true");
          await sleep(1500);
          report(W, 'home/grid', await p.ev(AUDIT));
          await p.shot('home-grid');
          // the navbar itself: which controls are visible, and where
          const nav = await p.ev("(() => { const n = document.getElementById('navbar'); const out = []; for (const c of n.querySelectorAll(':scope > *, .nav-actions > *, .nav-right > *')) { const cs = getComputedStyle(c); const r = c.getBoundingClientRect(); out.push((c.id ? '#' + c.id : '.' + (c.className || c.tagName).toString().split(' ')[0]) + ' ' + (cs.display === 'none' ? 'NONE' : Math.round(r.left) + '..' + Math.round(r.right) + 'x' + Math.round(r.height))); } return out.join(' | '); })()");
          console.log('  [' + W + '] navbar: ' + nav);
          // the mobile nav panel
          const ham = await p.ev("(() => { const b = document.getElementById('hamburgerBtn'); if (!b || getComputedStyle(b).display === 'none') return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
          if (ham) {
            await p.ev('scrollTo(0,0), true'); await sleep(400);
            const ham2 = await p.ev("(() => { const b = document.getElementById('hamburgerBtn'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
            await p.tap(ham2.x, ham2.y); await sleep(900);
            await p.ev("window.__auditRoot = '#mzMobilePanel', true");
            report(W, 'nav panel', await p.ev(AUDIT));
            await p.ev('window.__auditRoot = null, true');
            await p.shot('nav-panel');
            await p.tap(ham2.x, ham2.y); await sleep(600);
          }
        }
        if (SCEN.has('modal') || SCEN.has('player')) {
          const r = await p.ev("(() => { const c = document.querySelector('#movieGrid .movie-card'); c.scrollIntoView({ block: 'center' }); return true; })()");
          await sleep(900);
          const cr = await p.ev("(() => { const c = document.querySelector('#movieGrid .movie-card'); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; })()");
          await p.ev("window.__ev = []; ['pointerdown','touchstart','touchend','pointerup','click'].forEach((t) => document.addEventListener(t, (e) => __ev.push(t + ':' + e.isTrusted + ':' + String(e.target.className || e.target.tagName).slice(0, 24)), true)); true");
          const hit = await p.ev("(() => { const el = document.elementFromPoint(" + Math.round(cr.x) + ", " + Math.round(cr.y) + "); return el ? (el.tagName + '.' + String(el.className).slice(0, 40)) : null; })()");
          await p.tap(cr.x, cr.y);
          await sleep(400);
          console.log('  [' + W + '] card tap at ' + Math.round(cr.x) + ',' + Math.round(cr.y) + ' hit ' + hit + ' events: ' + JSON.stringify(await p.ev('__ev')));
          const opened = await p.waitFor("(() => { const o = document.getElementById('modal-overlay') || document.querySelector('.modal-overlay'); return !!o && getComputedStyle(o).display !== 'none' && (o.classList.contains('active') || o.classList.contains('open') || o.getAttribute('aria-hidden') === 'false'); })()", 8000);
          await sleep(1800);
          if (!opened) console.log('  [' + W + '] modal: did not open');
          else {
            await p.ev("window.__auditRoot = '#modal-overlay', true"); report(W, 'modal/top', await p.ev(AUDIT));
            await p.shot('modal-top');
            await p.ev("(() => { const o = document.getElementById('modal-overlay') || document.querySelector('.modal-overlay'); const s = [o, ...o.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (s) s.scrollTop = s.scrollHeight; return !!s; })()");
            await sleep(900);
            report(W, 'modal/bottom', await p.ev(AUDIT));
            await p.shot('modal-bottom');
            if (SCEN.has('player')) {
              await p.ev("(() => { const b = document.querySelector('.modal-actions .btn-play'); if (b) b.scrollIntoView({ block: 'center' }); return !!b; })()");
              await sleep(600);
              const pb = await p.ev("(() => { const b = document.querySelector('.modal-actions .btn-play'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
              if (pb) {
                await p.tap(pb.x, pb.y);
                const playing = await p.waitFor("!!document.querySelector('#videoEmbed iframe')", 8000);
                await sleep(1500);
                if (!playing) console.log('  [' + W + '] player: no iframe');
                else {
                  await p.ev("(() => { const v = document.getElementById('videoEmbed'); v.scrollIntoView({ block: 'start' }); return true; })()");
                  await sleep(700);
                  const geo = await p.ev("(() => { const v = document.getElementById('videoEmbed'); const f = v.querySelector('iframe'); const r = v.getBoundingClientRect(); const fr = f.getBoundingClientRect(); return { embed: [Math.round(r.left), Math.round(r.width), Math.round(r.height)], frame: [Math.round(fr.left), Math.round(fr.width), Math.round(fr.height)], ratio: +(fr.width / fr.height).toFixed(3) }; })()");
                  console.log('  [' + W + '] player geometry: ' + JSON.stringify(geo));
                  report(W, 'player', await p.ev(AUDIT));
                  await p.shot('player');
                  await p.ev("(() => { const c = document.querySelector('.player-chip--source'); if (c) c.scrollIntoView({ block: 'center' }); return true; })()");
                  await sleep(500);
                  report(W, 'player/chips', await p.ev(AUDIT));
                  await p.shot('player-chips');
                }
              }
            }
          }
        }
        await p.close();
      }
      if (SCEN.has('pwa')) {
        const p = await page(b, W, {});
        await p.S('Page.navigate', { url: APP + '/' });
        let shown = await p.waitFor("(() => { const o = document.getElementById('pwa-install-overlay'); return !!o && o.classList.contains('open'); })()", 9000);
        if (!shown) {
          // Headless never reaches the auto-open path; the navbar Install button uses this hook.
          await p.waitFor("typeof window.__mzOpenInstallPopup === 'function'", 12000);
          await p.ev('window.__mzOpenInstallPopup && window.__mzOpenInstallPopup(), true');
          shown = await p.waitFor("(() => { const o = document.getElementById('pwa-install-overlay'); return !!o && o.classList.contains('open'); })()", 4000);
        }
        await sleep(900);
        if (!shown) console.log('  [' + W + '] pwa popup: did not open');
        else {
          await p.ev("window.__auditRoot = '#pwa-install-overlay', true");
          report(W, 'pwa popup', await p.ev(AUDIT));
          const box = await p.ev("(() => { const o = document.getElementById('pwa-install-overlay'); const box = o.firstElementChild; const r = box.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: innerHeight, scrollable: box.scrollHeight > box.clientHeight }; })()");
          console.log('  [' + W + '] pwa popup box: ' + JSON.stringify(box));
          await p.shot('pwa');
        }
        await p.close();
      }
      for (const [scen, url] of [['watch', '/movie/550-fight-club/watch'], ['watch', '/tv/1396-breaking-bad/watch'], ['detail', '/movie/550-fight-club']]) {
        if (!SCEN.has(scen)) continue;
        const p = await page(b, W, { dismissPwa: true });
        await p.S('Page.navigate', { url: APP + url });
        await p.waitFor("document.readyState === 'complete'", 20000);
        await sleep(1200);
        const tag = scen + (url.startsWith('/tv') ? '-tv' : '');
        if (scen === 'watch') {
          const geo = await p.ev("(() => { const f = document.querySelector('.player-frame'); if (!f) return null; const r = f.getBoundingClientRect(); return { left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; })()");
          console.log('  [' + W + '] ' + tag + ' player-frame: ' + JSON.stringify(geo));
        }
        report(W, tag, await p.ev(AUDIT));
        await p.shot(tag);
        await p.close();
      }
    }
  } finally {
    await b.close();
  }
  console.log('screenshots: ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
