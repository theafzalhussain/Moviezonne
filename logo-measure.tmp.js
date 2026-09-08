'use strict';
/* Temporary: report the PAINTED artwork size of every provider logo.
   The <img> box is not the answer — every wide logo gets the same 172x68 box and
   `object-fit: contain` then letterboxes the art inside it, so a 5:1 lockup ends
   up half the height of a 1.2:1 one. This prints the contained size so the two
   new lockups can be compared against the rail's actual norm. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const app = require('./server');

const CHROME = path.join(process.env['ProgramFiles'] || '', 'Google\\Chrome\\Application\\chrome.exe');
const PORT = 9421;

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-meas-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--window-size=1500,900', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  for (let i = 0; i < 80 && !ws; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      ws = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b).webSocketDebuggerUrl); } catch (e) { rej(e); } });
      }).on('error', rej));
    } catch (e) { /* booting */ }
  }
  const sock = new WebSocket(ws, { perMessageDeflate: false });
  await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
  let id = 0; const pending = new Map();
  sock.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    sock.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  for (const [vw, vh, label] of [[1500, 900, 'DESKTOP 1500'], [390, 844, 'MOBILE 390']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: vw < 600 }, S);
    await send('Page.navigate', { url: origin + '/' }, S);
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await evalJs('document.querySelector(\'[data-provider-cat="shemaroo"]\') ? 1 : 0')) break;
    }

    const rows = JSON.parse(await evalJs(`(async()=>{
      const rail=document.getElementById('providersRail');
      // Force every lazy image to load: an unloaded img reports naturalWidth 0
      // and the contain maths would silently produce NaN for it.
      rail.querySelectorAll('img').forEach(i=>{i.loading='eager';});
      rail.scrollLeft=rail.scrollWidth; await new Promise(r=>setTimeout(r,400));
      rail.scrollLeft=0; await new Promise(r=>setTimeout(r,400));
      const imgs=[...rail.querySelectorAll('img')];
      await Promise.all(imgs.map(i=>i.complete?Promise.resolve():new Promise(r=>{i.onload=i.onerror=r})));
      const card=rail.querySelector('.provider-card').getBoundingClientRect();
      return JSON.stringify({card:{w:Math.round(card.width),h:Math.round(card.height)}, logos: imgs.map(i=>{
        const r=i.getBoundingClientRect();
        const ar=i.naturalWidth/i.naturalHeight;
        // object-fit: contain — the art scales to whichever axis binds first.
        const scale=Math.min(r.width/i.naturalWidth, r.height/i.naturalHeight);
        return {cat:i.closest('.provider-card').dataset.providerCat,
                ar:+ar.toFixed(2),
                box:Math.round(r.width)+'x'+Math.round(r.height),
                paintW:Math.round(i.naturalWidth*scale),
                paintH:Math.round(i.naturalHeight*scale)};
      })});
    })()`, S));

    console.log('\n' + label + '   card ' + rows.card.w + 'x' + rows.card.h);
    console.log('  ' + 'provider'.padEnd(15) + 'aspect'.padEnd(8) + 'img box'.padEnd(11)
      + 'PAINTED'.padEnd(11) + '% of card w');
    rows.logos
      .slice()
      .sort((a, b) => b.paintH - a.paintH)
      .forEach((l) => {
        console.log('  ' + l.cat.padEnd(15) + String(l.ar).padEnd(8) + l.box.padEnd(11)
          + (l.paintW + 'x' + l.paintH).padEnd(11)
          + Math.round((l.paintW / rows.card.w) * 100) + '%');
      });
  }

  sock.close(); child.kill();
  await new Promise((r) => server.close(r));
  process.exit(0);
})().catch((e) => { console.error('crashed:', e.message); process.exit(1); });
