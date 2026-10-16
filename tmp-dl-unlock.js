'use strict';
/* Temporary: walks each gated download page the way a viewer would (slide the
   slider / answer the math check / press "Download") and reports what is behind
   the gate: real file links, mirror links, or nothing. Deleted after use. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('undici');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9383;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej));

const CASES = [
  { url: 'https://02moviedownloader.site/api/download/movie/634649', act: 'slide' }
];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzdl2-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--user-agent=' + UA,
    '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) { await sleep(400); try { wsUrl = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')).webSocketDebuggerUrl; } catch (e) {} }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); let mainId = null; const opened = []; const downloads = [];
  const send = (method, params, sessionId) => new Promise((resolve) => {
    const mid = ++id; const t = setTimeout(() => { pending.delete(mid); resolve(null); }, 8000);
    pending.set(mid, (v) => { clearTimeout(t); resolve(v); });
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && mainId && m.params.targetInfo.targetId !== mainId) {
      opened.push(m.params.targetInfo.url || '(blank)');
      setTimeout(() => send('Target.getTargetInfo', { targetId: m.params.targetInfo.targetId }).then((i) => {
        if (i && i.targetInfo) opened.push('  -> ' + i.targetInfo.url);
        send('Target.closeTarget', { targetId: m.params.targetInfo.targetId });
      }), 2500);
    }
    if (m.method === 'Browser.downloadWillBegin') downloads.push(m.params.suggestedFilename + '  <-  ' + m.params.url.slice(0, 140));
  });
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page'); mainId = page.targetId;
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
  const evalJs = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, S); return r && r.result ? r.result.value : null; };
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, S);
  const snapshot = () => evalJs(`(() => ({
    url: location.href, title: document.title,
    text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 900),
    links: Array.from(document.querySelectorAll('a[href]')).map(a => (a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,48) + ' => ' + a.href.slice(0, 120))
      .filter(s => !/discord|telegram|twitter|facebook|instagram|dmca|privacy|about|help|terms|contact|#$/i.test(s)).slice(0, 18)
  }))()`);

  let n = 0;
  for (const c of CASES) {
    opened.length = 0; downloads.length = 0;
    await send('Page.navigate', { url: c.url }, S);
    await sleep(9000);
    if (c.act === 'slide') {
      const g = await evalJs(`(() => { const cands = Array.from(document.querySelectorAll('div, button, span')).map(e => ({ e, r: e.getBoundingClientRect() })).filter(o => o.r.width >= 36 && o.r.width <= 70 && Math.abs(o.r.width - o.r.height) < 6 && o.r.top > 300);`+
        `const t = cands.sort((a, b) => a.r.width - b.r.width)[0]; const track = t && t.e.parentElement.getBoundingClientRect();`+
        `return t ? { x0: t.r.left + t.r.width / 2, x1: track.right - 10, y: t.r.top + t.r.height / 2, w: t.r.width, tw: track.width } : null; })()`);
      console.log('  [slide] thumb ' + JSON.stringify(g));
      await mouse('mouseMoved', g.x0, g.y); await mouse('mousePressed', g.x0, g.y);
      for (let k = 1; k <= 24; k++) { await mouse('mouseMoved', g.x0 + (g.x1 - g.x0) * k / 24, g.y + (k % 3) - 1); await sleep(25); }
      await mouse('mouseReleased', g.x1, g.y);
      await sleep(100000);
    } else if (c.act === 'math') {
      const ok = await evalJs(`(() => { const m = (document.body.innerText || '').match(/(\\d+)\\s*([+\\-x×*])\\s*(\\d+)\\s*=/);
        if (!m) return 'no-question'; const a = +m[1], b = +m[3]; const ans = m[2] === '+' ? a + b : m[2] === '-' ? a - b : a * b;
        const input = document.querySelector('input'); if (!input) return 'no-input';
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, String(ans));
        input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
        return m[0] + ' ' + ans; })()`);
      const b = await evalJs(`(() => { const btn = Array.from(document.querySelectorAll('button')).find(x => /verify|proceed/i.test(x.innerText)); if (!btn) return null; const r = btn.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (b) { await mouse('mouseMoved', b.x, b.y); await mouse('mousePressed', b.x, b.y); await mouse('mouseReleased', b.x, b.y); }
      console.log('  [math] ' + ok + (b ? ' -> clicked Verify' : ' -> no verify button'));
      await sleep(14000);
    } else if (c.act.startsWith('button:')) {
      const label = c.act.slice(7);
      const b = await evalJs(`(() => { const btn = Array.from(document.querySelectorAll('button, a')).find(x => (x.innerText || '').trim() === ${JSON.stringify(label)}); if (!btn) return null; btn.scrollIntoView({block:'center'}); const r = btn.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (b) { await mouse('mouseMoved', b.x, b.y); await mouse('mousePressed', b.x, b.y); await mouse('mouseReleased', b.x, b.y); }
      await sleep(30000);
    }
    const v = (await snapshot()) || {};
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 }, S);
    if (shot && shot.data) fs.writeFileSync('tmp-dlu-' + (n++) + '.jpg', Buffer.from(shot.data, 'base64'));
    console.log('\n=== ' + c.url + '  [' + c.act + ']\n  final: ' + v.url + '\n  title: ' + v.title + '\n  text: ' + (v.text || '').slice(0, 700));
    if (v.links && v.links.length) console.log('  links:\n    ' + v.links.join('\n    '));
    if (opened.length) console.log('  new tabs: ' + opened.join(' | '));
    if (downloads.length) console.log('  DOWNLOAD STARTED: ' + downloads.join(' ; '));
  }
  ws.close(); chrome.kill();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {} process.exit(0); }, 1200);
})().catch((e) => { console.error(e); process.exit(1); });
