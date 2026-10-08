'use strict';
// OFFLINE: fetch and Cache API are replaced; no production requests.
// Run with: node worker-refresh-cooldown.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');
globalThis.crypto ||= webcrypto;
function context() {
  const work = [];
  return { ctx: { waitUntil(p) { work.push(p); } }, async settle() {
    for (let i = 0; i < work.length; i++) await work[i];
  } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
(async () => {
  const saved = { fetch: global.fetch, caches: global.caches, now: Date.now };
  let now = 1800000000000, calls = 0, writes = [], mode = 'ok', gate = null;
  Date.now = () => now;
  global.caches = { default: {
    async match() { return undefined; },
    async put(req) { writes.push(req.url); }
  } };
  global.fetch = async input => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.hostname, 'api.themoviedb.org', 'unexpected network destination');
    calls++;
    if (gate) await gate.promise;
    if (mode === 'throw') throw new Error('offline upstream failure');
    return new Response('{"results":[{"id":2}]}', { status: mode === '503' ? 503 : 200 });
  };
  const source = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g, (_, f) => "from '" + pathToFileURL(path.join(__dirname, f)).href + "'")
    + '\nexport { fetchTmdbJson, memoPut, tmdbState, subrequestBudget, refreshBatch, runBatchPlan, TMDB_REFRESH_COOLDOWN_MS, BATCH_RETRY_AFTER_FAIL_MS, BATCH_REFRESH_COOLDOWN_MS };';
  const w = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const p = '/movie/popular?language=en-US&page=1';
  const oldText = '{"results":[{"id":1}]}';
  const env = () => ({ TMDB_TOKEN: 'offline', TMDB_CACHE_TTL: '60', TMDB_VOLATILE_CACHE_TTL: '60' });
  function seed(e) { const t = now - 120000; w.memoPut(w.tmdbState(e), p, oldText, t); return t; }
  function budget() { return w.subrequestBudget({}, 1); }
  function opts(b, revalidate = true) { return { edge: false, budget: b, revalidate }; }
  function stale(r, t) { assert.deepEqual(r, { status: 200, text: oldText, cache: 'STALE', layer: 'memo', storedAt: t }); }
  let passed = 0;
  async function test(name, fn) {
    let timer;
    try {
      await Promise.race([fn(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out: ' + name)), 3000);
      })]);
      passed++; console.log('PASS ' + name);
    } finally { clearTimeout(timer); }
  }
  try {
    await test('concurrent distinct contexts share cooldown, not promises; denial releases budget', async () => {
      const e = env(), t = seed(e), c1 = context(), b1 = budget();
      gate = deferred(); const before = calls;
      const first = w.fetchTmdbJson(p, e, c1.ctx, opts(b1));
      assert.equal(calls, before + 1);
      const denied = await Promise.all(Array.from({ length: 12 }, async () => {
        const b = budget(), left = b.left;
        const r = await w.fetchTmdbJson(p, e, context().ctx, opts(b));
        stale(r, t); assert.equal(b.reserve, 0); assert.equal(b.left, left);
        return r;
      }));
      assert.equal(denied.length, 12); assert.equal(calls, before + 1);
      // All denied promises resolved while the first origin is still blocked.
      gate.resolve(); gate = null;
      assert.equal((await first).cache, 'MISS'); await c1.settle();
      assert.equal(b1.reserve, 0);
    });
    for (const backgroundFirst of [true, false]) {
      await test('scheduled/awaited refresh share cooldown, backgroundFirst=' + backgroundFirst, async () => {
        const e = env(), t = seed(e), c = context(), before = calls;
        gate = deferred();
        const first = w.fetchTmdbJson(p, e, c.ctx, opts(budget(), !backgroundFirst));
        const b = budget(), left = b.left;
        stale(await w.fetchTmdbJson(p, e, context().ctx, opts(b, backgroundFirst)), t);
        assert.equal(calls, before + 1); assert.equal(b.reserve, 0); assert.equal(b.left, left);
        gate.resolve(); gate = null; await first; await c.settle();
      });
    }
    await test('edge stale denial retains body/stamp and only spends edge lookup', async () => {
      const e = env(), t = now - 120000, b = budget(), left = b.left;
      w.tmdbState(e).refreshedAt.set(p, now);
      const originalMatch = global.caches.default.match;
      global.caches.default.match = async () => new Response(oldText, {
        headers: { 'x-mz-stored': String(t) }
      });
      try {
        const before = calls;
        const r = await w.fetchTmdbJson(p, e, context().ctx, { revalidate: true, budget: b });
        assert.equal(r.cache, 'STALE'); assert.equal(r.layer, 'edge');
        assert.equal(r.text, oldText); assert.equal(r.storedAt, t);
        assert.equal(calls, before); assert.equal(b.reserve, 0); assert.equal(b.left, left - 1);
      } finally { global.caches.default.match = originalMatch; }
    });
    await test('cooldown does not suppress another stale path', async () => {
      const e = env(); seed(e); w.tmdbState(e).refreshedAt.set(p, now);
      const other = '/tv/popular?language=en-US&page=1', before = calls;
      w.memoPut(w.tmdbState(e), other, oldText, now - 120000);
      const c = context();
      assert.equal((await w.fetchTmdbJson(other, e, c.ctx, opts(budget()))).cache, 'MISS');
      assert.equal(calls, before + 1); await c.settle();
    });
    for (const failure of ['503', 'throw']) {
      await test(failure + ' preserves stale stamp and permits retry only after cooldown', async () => {
        const e = env(), t = seed(e), before = calls;
        mode = failure;
        stale(await w.fetchTmdbJson(p, e, context().ctx, opts(budget())), t);
        // Existing 5xx/transport handling makes one immediate retry.
        assert.equal(calls, before + 2);
        now += w.TMDB_REFRESH_COOLDOWN_MS - 1;
        const b = budget(), left = b.left;
        stale(await w.fetchTmdbJson(p, e, context().ctx, opts(b)), t);
        assert.equal(b.reserve, 0); assert.equal(b.left, left); assert.equal(calls, before + 2);
        now++; mode = 'ok'; const c = context();
        const r = await w.fetchTmdbJson(p, e, c.ctx, opts(budget()));
        assert.equal(r.cache, 'MISS'); assert.equal(r.storedAt, now);
        assert.equal(calls, before + 3); await c.settle();
      });
    }
    await test('overlapping different batch plans never fresh-stamp denied stale parts', async () => {
      const e = env(), t = seed(e), before = calls;
      const a = context(), b = context();
      const keyA = new Request('https://offline.invalid/plan-a');
      const keyB = new Request('https://offline.invalid/plan-b');
      gate = deferred(); writes = [];
      const first = w.refreshBatch([p, p], 'plan-a', e, a.ctx, keyA, budget());
      const bBudget = budget();
      await w.refreshBatch([p], 'plan-b', e, b.ctx, keyB, bBudget);
      assert.equal(calls, before + 1); assert.equal(bBudget.reserve, 0);
      assert.ok(!writes.includes(keyB.url));
      assert.equal(w.tmdbState(e).memo.get(p).t, t);
      assert.equal(w.tmdbState(e).batchRefreshedAt.get('plan-b'),
        now + w.BATCH_RETRY_AFTER_FAIL_MS - w.BATCH_REFRESH_COOLDOWN_MS);
      gate.resolve(); gate = null; await first; await a.settle(); await b.settle();
      assert.ok(writes.includes(keyA.url)); assert.ok(!writes.includes(keyB.url));
      assert.equal(calls, before + 1);
      const parts = await w.runBatchPlan([p, p], e, context().ctx, { edge: false }).all;
      assert.equal(parts.length, 2); assert.ok(parts.every(x => x.ok && !x.stale));
    });
    console.log('PASS ' + passed + ' offline refresh cooldown tests');
  } finally {
    if (gate) gate.resolve();
    global.fetch = saved.fetch; global.caches = saved.caches; Date.now = saved.now;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
