'use strict';
/* Temporary: capture the new Top 10 heading (desktop + phone) via a clip so the
   install modal's scroll-lock cannot get in the way. Also dumps the computed
   heading metrics so the "premium but compact" ask is measured, not guessed. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const app = require('./server');

const CHROME = path.join(process.env['ProgramFiles'] || '', 'Google\\Chrome\\Application\\chrome.exe');
const PORT = 9410;

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-head-'));
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
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 200));
    return r.result.value;
  };

  await send('Runtime.enable', {}, S);
  const pageErrors = [];
  sock.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
    }
  });

  for (const [w, h, name] of [[1500, 640, 'head-desktop.tmp.png'], [390, 560, 'head-mobile.tmp.png']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 }, S);
    await send('Page.navigate', { url: origin + '/' }, S);
    // The heading is static markup, so wait on it directly.
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await evalJs('document.querySelector(".top10-big") ? 1 : 0')) break;
    }
    if (!(await evalJs('document.querySelector(".top10-big") ? 1 : 0'))) {
      console.log('  .top10-big NOT in DOM. head html = '
        + await evalJs('JSON.stringify((document.getElementById("top10Heading")||{}).outerHTML||"no #top10Heading")'));
      console.log('  page errors: ' + JSON.stringify(pageErrors.slice(0, 4)));
    }
    await evalJs(`(function(){var b=Array.from(document.querySelectorAll('button')).find(function(x){return /maybe later/i.test(x.textContent||'')}); if(b) b.click(); return 1})()`);
    await new Promise((r) => setTimeout(r, 3000));

    const info = JSON.parse(await evalJs(`JSON.stringify((()=>{
      const big=document.querySelector('.top10-big');
      const suba=document.querySelector('.top10-sub-a');
      const cs=getComputedStyle(big);
      const h2=document.getElementById('top10Heading');
      const houseH2=document.querySelector('#continue-watching .section-title h2');
      const r=h2.getBoundingClientRect();
      return {
        bigFontPx: Math.round(parseFloat(cs.fontSize)),
        bigStroke: cs.webkitTextStrokeWidth + ' ' + cs.webkitTextStrokeColor,
        bigFilled: cs.webkitTextFillColor,
        subFontPx: suba ? Math.round(parseFloat(getComputedStyle(suba).fontSize)) : null,
        headingH: Math.round(r.height),
        ariaLabel: h2.getAttribute('aria-label'),
        houseH2Px: houseH2 ? Math.round(parseFloat(getComputedStyle(houseH2).fontSize)) : 'n/a'
      };
    })())`));
    console.log('  ' + w + 'x' + h + ': ' + JSON.stringify(info));

    const box = JSON.parse(await evalJs(`JSON.stringify((()=>{
      const s=document.getElementById('top10-trending');
      const r=s.getBoundingClientRect();
      return { y: Math.round(r.top+scrollY), w: Math.round(r.width) };
    })())`));
    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: box.y, width: box.w, height: 220, scale: 1 }
    }, S);
    fs.writeFileSync(name, Buffer.from(shot.data, 'base64'));
    console.log('  wrote ' + name);
  }
  sock.close(); child.kill();
  await new Promise((r) => server.close(r));
  process.exit(0);
})().catch((e) => { console.error('crashed:', e.message); process.exit(1); });
