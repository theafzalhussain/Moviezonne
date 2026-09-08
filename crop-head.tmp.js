'use strict';
/* Temporary: tight 1:1 crops of the Top 10 wordmark (desktop + phone) so the
   outline weight can be judged from the real render instead of guessed. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const app = require('./server');

const CHROME = path.join(process.env['ProgramFiles'] || '', 'Google\\Chrome\\Application\\chrome.exe');
const PORT = 9412;

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-crop-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--window-size=1500,700', 'about:blank'], { stdio: 'ignore' });
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

  for (const [w, h, name] of [[1500, 700, 'crop-desktop.tmp.png'], [390, 700, 'crop-mobile.tmp.png']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }, S);
    await send('Page.navigate', { url: origin + '/' }, S);
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await evalJs('document.querySelector(".top10-big") ? 1 : 0')) break;
    }
    await new Promise((r) => setTimeout(r, 2500));

    console.log('  ' + w + 'px: ' + await evalJs(`(async()=>{
      const cs=getComputedStyle(document.querySelector('.top10-big'));
      const px=cs.fontSize;
      /*  Measure only AFTER the webfont is really loaded — an unloaded face makes
          canvas silently fall back and report the fallback's metrics for both runs,
          which is exactly how "TOP and 10 are the same size" can be a false pass. */
      const loaded = document.fonts.check(px+' "Bebas Neue"');
      try { await document.fonts.load(px+' "Bebas Neue"'); } catch(e){}
      const c=document.createElement('canvas').getContext('2d');
      c.font='400 '+px+' "Bebas Neue"';
      const ink=(t)=>{const m=c.measureText(t);return Math.round(m.actualBoundingBoxAscent);};
      const numCs=getComputedStyle(document.querySelector('.top10-big-num'));
      return JSON.stringify({ font:px, numFont:numCs.fontSize, stroke:cs.webkitTextStrokeWidth,
               fill:cs.webkitTextFillColor, faceReady:loaded,
               inkTOP:ink('TOP'), ink10:ink('10'), inkO:ink('O'), ink0:ink('0') });
    })()`, S));

    const hb = JSON.parse(await evalJs(`JSON.stringify((()=>{
      const r=document.getElementById('top10Heading').getBoundingClientRect();
      /*  Generous top padding: line-height is 0.8, so the glyph ink overflows the
          line box upward and a tight clip decapitates the letters. */
      return {x:Math.max(0,Math.round(r.left)-16),y:Math.max(0,Math.round(r.top+scrollY)-46),
              w:Math.round(r.width)+32,h:Math.round(r.height)+70};
    })())`, S));
    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: hb.x, y: hb.y, width: hb.w, height: hb.h, scale: 1 }
    }, S);
    fs.writeFileSync(name, Buffer.from(shot.data, 'base64'));
    console.log('  wrote ' + name + '  ' + hb.w + 'x' + hb.h);
  }

  sock.close(); child.kill();
  await new Promise((r) => server.close(r));
  process.exit(0);
})().catch((e) => { console.error('crashed:', e.message); process.exit(1); });
