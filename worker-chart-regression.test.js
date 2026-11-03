'use strict';
// Offline: real Worker and ott-charts module, mocked origin + Cache API only.
// Counts every fetch/match/put, including retries and waitUntil work.
// Run: node worker-chart-regression.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');
globalThis.crypto ||= webcrypto;
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
function context() {
  const work = [];
  return { ctx: { waitUntil(p) { work.push(Promise.resolve(p)); } }, async settle() {
    for (let n = 0; n < work.length; n++) await work[n];
  } };
}
async function loadWorker(concurrency = 6) {
  let source = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g, (_, file) => "from '" + pathToFileURL(path.join(__dirname, file)).href + "'");
  // The serial control changes only concurrency, to prove it cannot bound totals.
  if (concurrency !== 6) source = source.replace('const CONCURRENCY = 6;', 'const CONCURRENCY = ' + concurrency + ';');
  source += '\nexport { hydrateOttChart, buildOttChart, buildOttChartOnce, handleOttCharts, subrequestBudget, budgetRequire, budgetOptional, budgetRelease, fetchTmdbJson, tmdbState, memoPut, tmdbEdgeKey };';
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const order = (length = 24) => Array.from({ length }, (_, n) => ({ id: n + 1, media_type: n % 2 ? 'tv' : 'movie', chartSource: n % 2 ? 'newly' : 'trending' }));
function installIO(options = {}) {
  const counts = { fetch: 0, jw: 0, tmdb: 0, match: 0, put: 0, active: 0, peak: 0 };
  const attempts = new Map(), writes = [], store = new Map(), starts = [];
  global.caches = { default: {
    async match(request) { counts.match++; if (options.edgeFails) throw new Error('offline cache read failure'); const value = store.get(request.url); return value && value.clone(); },
    async put(request, response) { counts.put++; writes.push(request.url); if (options.edgeFails) throw new Error('offline cache write failure'); store.set(request.url, response.clone()); }
  } };
  global.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url); counts.fetch++;
    if (url.hostname === 'apis.justwatch.com') {
      counts.jw++;
      const body = JSON.parse(init.body); const trending = /popularTitles/.test(body.query || '');
      if (options.jwFails || (options.oneJwFails && trending)) throw new Error('offline JustWatch failure');
      const ids = trending ? Array.from({ length: 20 }, (_, n) => n + 1) : Array.from({ length: 10 }, (_, n) => n + 21);
      const edges = ids.map(id => ({ node: { objectType: 'MOVIE', content: { title: 'JW ' + id, externalIds: { tmdbId: String(id) } } } }));
      return new Response(JSON.stringify({ data: trending ? { popularTitles: { edges } } : { newTitles: { edges } } }));
    }
    assert.equal(url.hostname, 'api.themoviedb.org', 'No real network is allowed');
    counts.tmdb++; counts.active++; counts.peak = Math.max(counts.peak, counts.active);
    const id = Number(url.pathname.match(/\/(\d+)$/)[1]); starts.push(id); const nth = (attempts.get(id) || 0) + 1; attempts.set(id, nth);
    try {
      await new Promise(r => setTimeout(r, (7 - id % 7) * 2));
      if (options.allFail || (options.retryFirst && nth === 1)) return new Response('{"error":"offline retry"}', { status: 503 });
      if (options.partial && id === 4) return new Response('{}', { status: 404 });
      if (options.partial && id === 8) return new Response('{broken-json}');
      if (options.partial && id === 12) throw new Error('offline detail failure');
      return new Response(JSON.stringify({ id, title: 'Title ' + id, poster_path: options.partial && id === 9 ? null : '/p.jpg', genres: [{ id: 1 }] }));
    } finally { counts.active--; }
  };
  return { counts, attempts, writes, store, starts, total() { return counts.fetch + counts.match + counts.put; } };
}
const environment = extra => ({ TMDB_TOKEN: 'offline-test-token', ...extra });
function chartRequest(w, e, c) {
  const req = new Request('https://moviezone.dev/api/ott/charts?platform=netflix&region=IN');
  return w.handleOttCharts(req, e, c, new URL(req.url));
}
(async () => {
  const realFetch = global.fetch, realCaches = global.caches;
  const w = await loadWorker();
  try {
    await check('Worker pool preserves order, source, and compact rank with errors, bad JSON, and missing posters', async () => {
      const io = installIO({ partial: true }), c = context(), e = environment();
      const b = w.subrequestBudget(e, 24);
      const cards = await w.hydrateOttChart(order(), e, c.ctx, b); await c.settle();
      assert.equal(io.counts.peak, 6);
      assert.deepEqual(cards.map(x => x.id), order().filter(x => ![4, 8, 9, 12].includes(x.id)).map(x => x.id));
      cards.forEach((card, n) => { assert.equal(card._chartRank, n + 1); assert.equal(card._chartSource, order()[card.id - 1].chartSource); });
      assert(io.total() <= 45); assert.equal(b.left, 45 - io.total());
      const before = io.total(); assert.deepEqual(await w.hydrateOttChart([], e, c.ctx, b), []); assert.equal(io.total(), before);
    });
    await check('pool reserves every detail and final chart write before optional cache operations or retries', async () => {
      const io = installIO(), c = context(), e = environment(); const b = { left: 25, reserve: 25 };
      const cards = await w.hydrateOttChart(order(), e, c.ctx, b); await c.settle();
      assert.equal(cards.length, 24); assert.equal(io.counts.tmdb, 24); assert.equal(io.counts.match, 0); assert.equal(io.counts.put, 0);
      assert.equal(b.left, 1); assert.equal(b.reserve, 1); assert.equal(w.budgetOptional(b), false); assert.equal(w.budgetRequire(b), true); assert.equal(b.left, 0);
    });
    await check('retry pressure cannot consume a later title or final-write reservation', async () => {
      const io = installIO({ retryFirst: true }), c = context(), e = environment(); const b = { left: 25, reserve: 25 };
      assert.deepEqual(await w.hydrateOttChart(order(), e, c.ctx, b), []); await c.settle();
      assert.equal(io.counts.tmdb, 24); assert.equal(new Set(io.starts).size, 24); assert.equal(io.counts.match + io.counts.put, 0);
      assert.equal(b.left, 1); assert.equal(b.reserve, 1);
    });
    for (const options of [{}, { retryFirst: true }, { edgeFails: true }]) {
      await check('cold chart invocation counts all subrequests within 45 including background work: ' + JSON.stringify(options), async () => {
        const io = installIO(options), c = context(), e = environment();
        const response = await chartRequest(w, e, c.ctx); const payload = await response.json(); await c.settle();
        assert.equal(response.status, 200); assert(payload.items.length > 0); assert.equal(io.counts.jw, 2);
        assert.equal(new Set(io.starts).size, 24); assert(io.counts.peak <= 6);
        assert(io.total() <= 45, 'all fetch/match/put counted: ' + io.total());
        assert(io.writes.some(url => url.includes('/__mz/ott-chart/netflix/IN')), 'final chart write reservation survives');
        console.log('  OBSERVED ' + io.total() + ' total = ' + io.counts.fetch + ' fetch + ' + io.counts.match + ' match + ' + io.counts.put + ' put; peak ' + io.counts.peak);
      });
    }
    await check('reducing concurrency alone does not reduce total subrequests', async () => {
      const serial = await loadWorker(1); const runs = [];
      for (const worker of [w, serial]) {
        const io = installIO(), c = context(), e = environment({ SUBREQUEST_LIMIT: '1000' });
        const res = await chartRequest(worker, e, c.ctx); assert.equal((await res.json()).items.length, 24); await c.settle();
        runs.push({ total: io.total(), peak: io.counts.peak });
      }
      assert.equal(runs[0].peak, 6); assert.equal(runs[1].peak, 1);
      assert.equal(runs[0].total, 76); assert.equal(runs[1].total, 76);
      console.log('  OBSERVED concurrency 6 vs 1: ' + JSON.stringify(runs));
    });
    await check('fresh memo titles release their reservation without spending a subrequest', async () => {
      const io = installIO(), c = context(), e = environment(); const b = { left: 1, reserve: 25 };
      for (const entry of order()) w.memoPut(w.tmdbState(e), '/' + entry.media_type + '/' + entry.id + '?language=en-US', JSON.stringify({ id: entry.id, poster_path: '/p.jpg' }), Date.now());
      assert.equal((await w.hydrateOttChart(order(), e, c.ctx, b)).length, 24); await c.settle();
      assert.equal(io.total(), 0); assert.equal(b.left, 1); assert.equal(b.reserve, 1);
    });
    await check('same-request duplicate detail calls coalesce and release unused reservations', async () => {
      const io = installIO(), c = context(), e = environment(); const b = { left: 3, reserve: 3 };
      const [a, bResult] = await Promise.all([1, 2].map(() => w.fetchTmdbJson('/movie/7?language=en-US', e, c.ctx, { budget: b, edge: false })));
      await c.settle(); assert.equal(a.status, 200); assert.equal(bResult.status, 200); assert.equal(io.counts.tmdb, 1); assert.equal(b.reserve, 1); assert(b.left >= 1);
    });
    await check('separate invocations do not share a budget or in-flight origin promise', async () => {
      const io = installIO(), e = environment(); const a = context(), b = context();
      const ba = { left: 1, reserve: 1 }, bb = { left: 1, reserve: 1 };
      await Promise.all([w.fetchTmdbJson('/movie/7?language=en-US', e, a.ctx, { budget: ba, edge: false }), w.fetchTmdbJson('/movie/7?language=en-US', e, b.ctx, { budget: bb, edge: false })]);
      await a.settle(); await b.settle(); assert.equal(io.counts.tmdb, 2); assert.equal(ba.left, 0); assert.equal(bb.left, 0);
    });
    await check('exhausted or insufficient shared budget never starts unaccounted JustWatch calls', async () => {
      for (const left of [0, 1]) {
        const io = installIO(), c = context(), e = environment(); const b = { left, reserve: 0 };
        await assert.rejects(w.buildOttChart('netflix', 'IN', e, c.ctx, b)); await c.settle();
        assert.equal(io.counts.jw, 0, 'JustWatch fetches with starting budget ' + left); assert.equal(io.total(), 0);
      }
    });
    await check('small configured invocation budget degrades to partial chart without exceeding its headroom', async () => {
      const io = installIO(), c = context(), e = environment({ SUBREQUEST_LIMIT: '10' });
      const response = await chartRequest(w, e, c.ctx); const payload = await response.json(); await c.settle();
      assert.equal(response.status, 200); assert(Array.isArray(payload.items)); assert(io.total() <= 5, 'total counted ' + io.total());
    });
    await check('both JustWatch feeds failing returns unavailable, and cooldown prevents another build', async () => {
      const io = installIO({ jwFails: true }), e = environment();
      const a = context(); const first = await chartRequest(w, e, a.ctx); const payload = await first.json(); await a.settle();
      assert.equal(first.status, 200); assert.equal(payload.unavailable, true); assert.deepEqual(payload.items, []); assert.equal(io.counts.jw, 2); assert.equal(io.counts.tmdb, 0);
      const b = context(); await chartRequest(w, e, b.ctx); await b.settle(); assert.equal(io.counts.jw, 2);
      assert(!io.writes.some(url => url.includes('/__mz/ott-chart/')));
    });
    await check('one JustWatch feed failing still returns usable cards', async () => {
      const io = installIO({ oneJwFails: true }), c = context(), e = environment();
      const response = await chartRequest(w, e, c.ctx); const payload = await response.json(); await c.settle();
      assert.equal(response.status, 200); assert.equal(payload.items.length, 10); assert.equal(payload.counts.trending, 0); assert.equal(payload.counts.newly, 10); assert(io.total() <= 45);
    });
    await check('all detail failures never cache an empty chart as a success', async () => {
      const io = installIO({ allFail: true }), c = context(), e = environment();
      const response = await chartRequest(w, e, c.ctx); const payload = await response.json(); await c.settle();
      assert.equal(response.status, 200); assert.equal(payload.unavailable, true); assert.deepEqual(payload.items, []); assert(io.total() <= 45);
      assert(!io.writes.some(url => url.includes('/__mz/ott-chart/')));
    });
    await check('failed background chart refresh preserves stale payload and timestamp within the same invocation budget', async () => {
      const io = installIO({ jwFails: true }), c = context(), e = environment();
      const stamp = Date.now() - 3 * 60 * 60 * 1000, key = 'ott-chart:netflix:IN';
      const body = JSON.stringify({ items: [{ id: 55 }], source: 'justwatch' }); w.memoPut(w.tmdbState(e), key, body, stamp);
      const response = await chartRequest(w, e, c.ctx); assert.equal(response.headers.get('x-cache'), 'STALE'); assert.equal(await response.text(), body); await c.settle();
      assert.equal(w.tmdbState(e).memo.get(key).t, stamp); assert.equal(io.counts.jw, 2); assert(io.total() <= 45);
      const next = context(); await chartRequest(w, e, next.ctx); await next.settle(); assert.equal(io.counts.jw, 2);
    });
  } finally { global.fetch = realFetch; global.caches = realCaches; }
  console.log('\nworker-chart-regression: ' + passed + ' passed, ' + failed + ' failed'); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
