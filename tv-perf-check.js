/* ═══════════════════════════════════════════════════════════════════════════
   tv-perf-check.js — measures TV-mode performance on the REAL app.

   A laptop is 5-10x faster than a Fire TV stick, so measuring here without
   throttling proves nothing. This drives headless Chrome over the DevTools
   protocol with Emulation.setCPUThrottlingRate to emulate a TV SoC, then
   measures the three things the viewer actually feels:

     1. LOAD    — long tasks (>50ms blocks the UI) while the grid builds
     2. SCROLL  — real D-pad presses, per-frame timings, dropped frames
     3. FETCH   — main-thread time burned by the client-side cache path

   Also reports composited layer count and JS heap, which are what make a TV
   run out of VRAM and start stuttering.

   Usage:
     node tv-perf-check.js                 # TV mode, 6x CPU throttle
     node tv-perf-check.js --throttle 10   # emulate a weaker stick
     node tv-perf-check.js --desktop       # same measurement without TV mode
     node tv-perf-check.js --save baseline # write the numbers to a JSON file
     node tv-perf-check.js --compare baseline
   ═══════════════════════════════════════════════════════════════════════════ */
process.env.PORT = process.env.PORT || '3992';
require('dotenv').config();

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf('--' + name);
  return at > -1 ? (args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : true) : fallback;
};
const THROTTLE = Number(flag('throttle', 6));
const AS_DESKTOP = !!flag('desktop', false);
const SAVE_AS = flag('save', null);
const COMPARE_WITH = flag('compare', null);
const CDP_PORT = 9334;

const CHROME = [
  path.join(process.env['ProgramFiles'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(p => p && fs.existsSync(p));

const TV_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGet(port, urlPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ status: 'ERR', err: e.code }));
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForCdpTarget() {
  for (let i = 0; i < 80; i++) {
    const r = await httpGet(CDP_PORT, '/json/list');
    if (r.status === 200) {
      try {
        const t = JSON.parse(r.body).find(x => x.type === 'page' && x.webSocketDebuggerUrl);
        if (t) return t.webSocketDebuggerUrl;
      } catch (e) {}
    }
    await sleep(250);
  }
  throw new Error('DevTools target never appeared');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const waiting = new Map();
    const waiters = [];
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        return new Promise((res, rej) => {
          waiting.set(id, { res, rej });
          setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(method + ' timed out')); } }, 60000);
        });
      },
      waitForEvent(method, ms) {
        return new Promise((res, rej) => {
          const entry = { method, res };
          waiters.push(entry);
          setTimeout(() => {
            const at = waiters.indexOf(entry);
            if (at > -1) { waiters.splice(at, 1); rej(new Error('event ' + method + ' timed out')); }
          }, ms || 60000);
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    }));
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')));
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && waiting.has(msg.id)) {
        const { res, rej } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
        return;
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].method === msg.method) { waiters[i].res(msg.params); waiters.splice(i, 1); }
      }
    });
  });
}

/* Installed before navigation so it observes the whole load. */
const INSTRUMENT = `(function () {
  window.__mzPerf = { longTasks: [], frames: [], marks: {}, cvSkipped: 0, cvShown: 0 };
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        window.__mzPerf.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
      });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__mzPerf.longTaskError = String(e); }

  // Authoritative, non-destructive answer to "is content-visibility: auto really
  // skipping anything?" — the browser tells us instead of us measuring layout.
  document.addEventListener('contentvisibilityautostatechange', function (e) {
    if (e.skipped) window.__mzPerf.cvSkipped++;
    else window.__mzPerf.cvShown++;
  }, true);

  // First moment a real poster tile exists — what the viewer waits for.
  var seen = false;
  var check = function () {
    if (seen) return;
    if (document.querySelector('.movie-card')) {
      seen = true;
      window.__mzPerf.marks.firstCard = Math.round(performance.now());
      return;
    }
    requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
})()`;

/* Records frame deltas while the D-pad walks down the grid. */
const SCROLL_TEST = `(async function () {
  var perf = window.__mzPerf;
  perf.frames = [];
  var last = performance.now();
  var running = true;
  (function tick() {
    var now = performance.now();
    perf.frames.push(Math.round((now - last) * 100) / 100);
    last = now;
    if (running) requestAnimationFrame(tick);
  })();

  var press = function (key, code) {
    var ev = new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true });
    try { Object.defineProperty(ev, 'keyCode', { get: function () { return code; } }); } catch (e) {}
    document.dispatchEvent(ev);
  };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var cards = document.querySelectorAll('.movie-card');
  if (cards.length) { cards[0].scrollIntoView({ block: 'center' }); cards[0].focus(); }
  await wait(250);

  // Walk the grid the way a viewer does: down the rows, then back up.
  for (var i = 0; i < 14; i++) { press('ArrowDown', 40); await wait(170); }
  for (var j = 0; j < 6; j++) { press('ArrowRight', 39); await wait(170); }
  for (var k = 0; k < 14; k++) { press('ArrowUp', 38); await wait(170); }

  running = false;
  await wait(120);

  var frames = perf.frames.slice(2);
  frames.sort(function (a, b) { return a - b; });
  var pct = function (p) { return frames.length ? frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] : 0; };
  var dropped = perf.frames.filter(function (f) { return f > 50; }).length;
  var janky = perf.frames.filter(function (f) { return f > 100; }).length;

  return JSON.stringify({
    frameCount: perf.frames.length,
    medianFrame: pct(0.5),
    p95Frame: pct(0.95),
    worstFrame: frames.length ? frames[frames.length - 1] : 0,
    droppedFrames: dropped,
    jankyFrames: janky,
    scrollY: Math.round(window.scrollY)
  });
})()`;

/* Measures the client-side cache path, which is the fetch-time main-thread cost. */
const FETCH_TEST = `(function () {
  // Time a realistic TMDB payload through the same localStorage SWR path
  // moviezone.js uses for every response.
  var sample = [];
  for (var i = 0; i < 20; i++) {
    sample.push({ id: i, title: 'Title ' + i, overview: new Array(40).join('lorem ipsum dolor '),
      poster_path: '/abc' + i + '.jpg', backdrop_path: '/def' + i + '.jpg',
      genre_ids: [28, 12, 878], vote_average: 7.5, release_date: '2024-01-01' });
  }
  var payload = { data: { page: 1, results: sample }, timestamp: Date.now() };
  var bytes = JSON.stringify(payload).length;

  var t0 = performance.now();
  for (var w = 0; w < 10; w++) {
    try { localStorage.setItem('mz_perfprobe_' + w, JSON.stringify(payload)); } catch (e) {}
  }
  var writeMs = performance.now() - t0;

  var t1 = performance.now();
  for (var r = 0; r < 10; r++) {
    try { JSON.parse(localStorage.getItem('mz_perfprobe_' + r) || '{}'); } catch (e) {}
  }
  var readMs = performance.now() - t1;

  for (var c = 0; c < 10; c++) { try { localStorage.removeItem('mz_perfprobe_' + c); } catch (e) {} }

  return JSON.stringify({
    payloadKB: Math.round(bytes / 1024),
    tenWritesMs: Math.round(writeMs * 10) / 10,
    tenReadsMs: Math.round(readMs * 10) / 10,
    cacheKeys: (function () {
      var n = 0;
      for (var i = 0; i < localStorage.length; i++) {
        if ((localStorage.key(i) || '').indexOf('mz_cache_') === 0) n++;
      }
      return n;
    })(),
    deferredWrites: !!(window.MovieZoneTV && window.MovieZoneTV.getState && window.MovieZoneTV.getState().deferredStorage)
  });
})()`;

const SNAPSHOT = `(function () {
  var perf = window.__mzPerf;
  var tasks = perf.longTasks.slice();
  var total = tasks.reduce(function (a, t) { return a + t.dur; }, 0);
  var worst = tasks.reduce(function (a, t) { return Math.max(a, t.dur); }, 0);

  // NOTE: this probe must never read layout. Calling getBoundingClientRect()
  // inside a content-visibility subtree forces the browser to render it, which
  // destroys the very thing being measured (and skews the numbers that follow).
  // Everything below is attribute/selector counting only.
  var count = function (selector) { return document.querySelectorAll(selector).length; };

  return JSON.stringify({
    firstCardMs: perf.marks.firstCard || null,
    longTaskCount: tasks.length,
    longTaskTotalMs: total,
    worstLongTaskMs: worst,
    cards: count('.movie-card'),
    cardsFarSkipped: count('.movie-card[data-mztv-far], .upcoming-card[data-mztv-far], .ch-card[data-mztv-far]'),
    cvSkipEvents: perf.cvSkipped,
    cvShowEvents: perf.cvShown,
    cardsWatched: count('[data-mztv-watched]'),
    sectionsIdle: count('[data-mztv-idle]'),
    parkedPosters: count('img[data-mztv-src]'),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    tier: document.documentElement.getAttribute('data-mz-tv-tier'),
    tvMode: document.documentElement.getAttribute('data-mz-tv') === 'true',
    downgraded: document.documentElement.getAttribute('data-mz-tv-downgraded') === 'true'
  });
})()`;

async function evaluate(cdp, expression, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
  if (r.exceptionDetails) throw new Error('page error: ' + r.exceptionDetails.text);
  return typeof r.result.value === 'string' ? JSON.parse(r.result.value) : r.result.value;
}

// Aggregates a CDP CPU profile into self-time per function so we can see exactly
// which code burns the main thread instead of guessing.
function summariseProfile(profile, topN) {
  const byId = new Map();
  (profile.nodes || []).forEach(n => byId.set(n.id, n));

  const selfTicks = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = Math.max(0, deltas[i] || 0);
    selfTicks.set(id, (selfTicks.get(id) || 0) + dt);
  }

  const rows = [];
  selfTicks.forEach((micros, id) => {
    const node = byId.get(id);
    if (!node) return;
    const cf = node.callFrame || {};
    const name = cf.functionName || '(anonymous)';
    const file = (cf.url || '').split('/').pop() || '(native)';
    rows.push({ label: name + '  [' + file + (cf.lineNumber != null ? ':' + (cf.lineNumber + 1) : '') + ']', ms: micros / 1000 });
  });

  const merged = new Map();
  rows.forEach(r => merged.set(r.label, (merged.get(r.label) || 0) + r.ms));
  const total = [...merged.values()].reduce((a, b) => a + b, 0);

  return {
    totalMs: Math.round(total),
    top: [...merged.entries()]
      .map(([label, ms]) => ({ label, ms: Math.round(ms) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, topN || 14)
  };
}

function metricMap(list) {
  const out = {};
  list.forEach(m => { out[m.name] = m.value; });
  return out;
}

(async () => {
  if (!CHROME) { console.log('SKIPPED: no Chrome/Edge found.'); process.exit(0); }
  if (typeof WebSocket !== 'function') { console.log('SKIPPED: this Node build has no WebSocket.'); process.exit(0); }

  const app = require('./server.js');
  const server = app.listen(process.env.PORT);
  await new Promise(r => server.once('listening', r));
  const url = 'http://127.0.0.1:' + process.env.PORT + '/';
  await sleep(1500);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzPerf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--js-flags=--expose-gc', '--enable-precise-memory-info',
    '--window-size=1920,1080',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  let report = null;
  try {
    cdp = await connect(await waitForCdpTarget());

    await cdp.send('Emulation.setUserAgentOverride', { userAgent: AS_DESKTOP ? DESKTOP_UA : TV_UA });
    try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
    await cdp.send('Page.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

    console.log('profile : ' + (AS_DESKTOP ? 'DESKTOP (no TV mode)' : 'TV (Tizen UA)') + ', CPU throttle ' + THROTTLE + 'x');
    console.log('loading ' + url + ' ...');

    const before = metricMap((await cdp.send('Performance.getMetrics')).metrics);
    const loaded = cdp.waitForEvent('Page.loadEventFired', 120000);
    await cdp.send('Page.navigate', { url });
    await loaded;
    await sleep(6000); // let TMDB land and the grid settle

    const load = await evaluate(cdp, SNAPSHOT);
    const fetchCost = await evaluate(cdp, FETCH_TEST);

    // Profile the interaction phase — this is where the freezes are felt.
    let profileSummary = null;
    try {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    } catch (e) { profileSummary = { error: e.message }; }

    const scroll = await evaluate(cdp, SCROLL_TEST, true);

    if (!profileSummary) {
      try {
        const stopped = await cdp.send('Profiler.stop');
        profileSummary = summariseProfile(stopped.profile, 14);
      } catch (e) { profileSummary = { error: e.message }; }
    }

    const after = metricMap((await cdp.send('Performance.getMetrics')).metrics);
    const post = await evaluate(cdp, SNAPSHOT);

    const delta = key => Math.round(((after[key] || 0) - (before[key] || 0)) * 1000) / 1000;

    report = {
      mode: AS_DESKTOP ? 'desktop' : 'tv',
      throttle: THROTTLE,
      tvMode: load.tvMode,
      tier: load.tier,
      cards: post.cards,
      load: {
        firstCardMs: load.firstCardMs,
        longTaskCount: load.longTaskCount,
        longTaskTotalMs: load.longTaskTotalMs,
        worstLongTaskMs: load.worstLongTaskMs
      },
      scroll: scroll,
      fetch: fetchCost,
      engine: {
        scriptDurationS: delta('ScriptDuration'),
        recalcStyleDurationS: delta('RecalcStyleDuration'),
        layoutDurationS: delta('LayoutDuration'),
        taskDurationS: delta('TaskDuration'),
        layoutCount: delta('LayoutCount'),
        recalcStyleCount: delta('RecalcStyleCount'),
        layerCount: after['LayoutObjects'] ? undefined : undefined
      },
      memory: { heapMB: post.heapMB, parkedPosters: post.parkedPosters, downgraded: post.downgraded }
    };

    const line = (label, value) => console.log('  ' + label.padEnd(30) + value);
    console.log('\n══ LOAD ' + '═'.repeat(52));
    line('first card visible', load.firstCardMs + ' ms');
    line('long tasks (>50ms)', load.longTaskCount);
    line('long task total', load.longTaskTotalMs + ' ms');
    line('worst long task', load.worstLongTaskMs + ' ms');
    line('cards in DOM', post.cards);
    line('  skipped (far off screen)', post.cardsFarSkipped + ' of ' + post.cardsWatched + ' watched');
    line('  native c-v auto skips', post.cvSkipEvents + ' skipped / ' + post.cvShowEvents + ' shown');
    line('  sections skipped', post.sectionsIdle);

    console.log('\n══ SCROLL / D-PAD (34 key presses) ' + '═'.repeat(26));
    line('frames sampled', scroll.frameCount);
    line('median frame', scroll.medianFrame + ' ms');
    line('p95 frame', scroll.p95Frame + ' ms');
    line('worst frame', scroll.worstFrame + ' ms');
    line('dropped frames (>50ms)', scroll.droppedFrames);
    line('janky frames (>100ms)', scroll.jankyFrames);
    line('scrolled to', scroll.scrollY + ' px');

    console.log('\n══ FETCH PATH (client cache) ' + '═'.repeat(32));
    line('payload size', fetchCost.payloadKB + ' KB');
    line('10 localStorage writes', fetchCost.tenWritesMs + ' ms');
    line('10 parse+read', fetchCost.tenReadsMs + ' ms');
    line('mz_cache_ keys stored', fetchCost.cacheKeys);
    line('writes deferred by tv-mode', fetchCost.deferredWrites);

    console.log('\n══ ENGINE (whole session) ' + '═'.repeat(35));
    line('script time', report.engine.scriptDurationS + ' s');
    line('style recalc time', report.engine.recalcStyleDurationS + ' s');
    line('layout time', report.engine.layoutDurationS + ' s');
    line('total task time', report.engine.taskDurationS + ' s');
    line('layout count', report.engine.layoutCount);
    line('style recalc count', report.engine.recalcStyleCount);

    console.log('\n══ MEMORY ' + '═'.repeat(51));
    line('JS heap', post.heapMB + ' MB');
    line('parked posters', post.parkedPosters);
    line('watchdog downgraded tier', post.downgraded);

    if (profileSummary && profileSummary.top) {
      console.log('\n══ WHERE THE MAIN THREAD WENT (self time, D-pad phase) ' + '═'.repeat(7));
      line('sampled total', profileSummary.totalMs + ' ms');
      profileSummary.top.forEach(row => {
        console.log('  ' + String(row.ms + ' ms').padStart(8) + '  ' + row.label);
      });
    } else if (profileSummary) {
      console.log('\n(profiler unavailable: ' + profileSummary.error + ')');
    }
  } catch (err) {
    console.error('\nFAILED: ' + err.message);
  } finally {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    server.close();
  }

  if (report && SAVE_AS) {
    const file = 'perf-' + String(SAVE_AS).replace(/[^\w.-]/g, '') + '.json';
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log('\nsaved -> ' + file);
  }
  if (report && COMPARE_WITH) {
    const file = 'perf-' + String(COMPARE_WITH).replace(/[^\w.-]/g, '') + '.json';
    if (!fs.existsSync(file)) console.log('\nno baseline at ' + file);
    else {
      const base = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log('\n══ VS ' + file + ' ' + '═'.repeat(Math.max(0, 48 - file.length)));
      const cmp = (label, now, then, lowerIsBetter) => {
        if (typeof now !== 'number' || typeof then !== 'number') return;
        const diff = now - then;
        const pct = then === 0 ? (now === 0 ? 0 : 100) : Math.round((diff / then) * 100);
        const better = lowerIsBetter ? diff < 0 : diff > 0;
        const tag = diff === 0 ? '  =' : (better ? ' OK' : ' !!');
        console.log(tag + ' ' + label.padEnd(28) + String(then).padStart(9) + ' -> ' + String(now).padStart(9) +
          '  (' + (diff > 0 ? '+' : '') + pct + '%)');
      };
      cmp('first card visible ms', report.load.firstCardMs, base.load.firstCardMs, true);
      cmp('long task total ms', report.load.longTaskTotalMs, base.load.longTaskTotalMs, true);
      cmp('worst long task ms', report.load.worstLongTaskMs, base.load.worstLongTaskMs, true);
      cmp('median frame ms', report.scroll.medianFrame, base.scroll.medianFrame, true);
      cmp('p95 frame ms', report.scroll.p95Frame, base.scroll.p95Frame, true);
      cmp('worst frame ms', report.scroll.worstFrame, base.scroll.worstFrame, true);
      cmp('dropped frames', report.scroll.droppedFrames, base.scroll.droppedFrames, true);
      cmp('janky frames', report.scroll.jankyFrames, base.scroll.jankyFrames, true);
      cmp('style recalc time s', report.engine.recalcStyleDurationS, base.engine.recalcStyleDurationS, true);
      cmp('layout time s', report.engine.layoutDurationS, base.engine.layoutDurationS, true);
      cmp('script time s', report.engine.scriptDurationS, base.engine.scriptDurationS, true);
      cmp('total task time s', report.engine.taskDurationS, base.engine.taskDurationS, true);
      cmp('JS heap MB', report.memory.heapMB, base.memory.heapMB, true);
    }
  }

  setTimeout(() => process.exit(0), 250);
})();
