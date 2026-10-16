'use strict';
/* Temporary: opens each download URL as a real top-level tab in headless Chrome
   (that is how the site opens them: window.open in a new tab) and reports what a
   viewer actually gets: final URL, title, visible text, and download-looking links.
   Saves a screenshot per URL. Deleted after use. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('undici');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9373;
const WAIT = Number(process.env.WAIT_MS || 15000);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const urls = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzdl-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--user-agent=' + UA,
    '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) { await sleep(400); try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')).webSocketDebuggerUrl; } catch (e) {} }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); let mainId = null;
  const send = (method, params, sessionId) => new Promise((resolve) => {
    const mid = ++id; const t = setTimeout(() => { pending.delete(mid); resolve(null); }, 8000);
    pending.set(mid, (v) => { clearTimeout(t); resolve(v); });
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });
  const downloads = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && mainId && m.params.targetInfo.targetId !== mainId) {
      send('Target.closeTarget', { targetId: m.params.targetInfo.targetId });
    }
    if (m.method === 'Browser.downloadWillBegin') downloads.push(m.params.url + ' -> ' + m.params.suggestedFilename);
  });
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page'); mainId = page.targetId;
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
  let n = 0;
  for (const u of urls) {
    downloads.length = 0;
    await send('Page.navigate', { url: u }, S);
    await sleep(WAIT);
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => ({
      url: location.href, title: document.title,
      text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 700),
      links: Array.from(document.querySelectorAll('a[href]')).map(a => (a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40) + ' => ' + a.href)
        .filter(s => /download|\\.mkv|\\.mp4|drive|pixel|hub|gofile|mega|file|1080|720|480|dl/i.test(s)).slice(0, 14),
      buttons: Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0, 16)
    }))()` }, S);
    const v = (r && r.result && r.result.value) || {};
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 }, S);
    if (shot && shot.data) fs.writeFileSync('tmp-dl-' + (n++) + '.jpg', Buffer.from(shot.data, 'base64'));
    console.log('\n=== ' + u + '\n  final: ' + v.url + '\n  title: ' + v.title + '\n  text: ' + (v.text || '').slice(0, 520));
    if (v.buttons && v.buttons.length) console.log('  buttons: ' + v.buttons.join(' | '));
    if (v.links && v.links.length) console.log('  links:\n    ' + v.links.join('\n    '));
    if (downloads.length) console.log('  download started: ' + downloads.join(' ; '));
  }
  ws.close(); chrome.kill();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} process.exit(0); }, 1200);
})().catch((e) => { console.error(e); process.exit(1); });
