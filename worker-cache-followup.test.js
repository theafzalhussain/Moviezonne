'use strict';
// Offline regression coverage. Internal exports exist only in this test import.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');
globalThis.crypto ||= webcrypto;
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
function context() {
  const work = [];
  return { ctx: { waitUntil(p) { work.push(p); } }, async settle() {
    for (let i = 0; i < work.length; i++) await work[i];
  } };
}
(async () => {
  const originalFetch = global.fetch;
  const originalCaches = global.caches;
  const source = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g, (_, file) => "from '" + pathToFileURL(path.join(__dirname, file)).href + "'")
    + '\nexport { runBatchPlan, batchBody, planStoredAt, handleTmdbBatch, tmdbEdgeKey, memoPut, tmdbState, refreshBatch, subrequestBudget };';
  const w = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let reads, writes, upstream, store;
  function reset() {
    reads = []; writes = []; upstream = []; store = new Map();
    global.caches = { default: {
      async match(req) { reads.push(req.url); return store.has(req.url) ? store.get(req.url).clone() : undefined; },
      async put(req, response) { writes.push(req.url); store.set(req.url, response.clone()); }
    } };
    global.fetch = async input => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname !== 'api.themoviedb.org') throw new Error('Unexpected offline fetch: ' + url);
      upstream.push(url.pathname);
      return new Response(JSON.stringify({ results: [{ id: 1 }], path: url.pathname }));
    };
  }
  const a = '/movie/popular?language=en-US&page=1';
  const b = '/tv/popular?language=en-US&page=1';
  const env = () => ({ TMDB_TOKEN: 'offline', BATCH_DEADLINE_MS: '100' });
  const request = paths => new Request('https://moviezonne.com/api/tmdb/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths })
  });
  async function batch(paths, e, c) { const r = request(paths); return w.handleTmdbBatch(r, e, c, new URL(r.url)); }
  try {
    reset();
    let c = context();
    const run = w.runBatchPlan([a, a, b, a], env(), c.ctx, {});
    const parts = await run.all; await c.settle();
    check('duplicate paths perform one edge read per unique path', () => assert.equal(reads.length, 2));
    check('duplicate paths perform one upstream fetch and write per unique path', () => {
      assert.equal(upstream.length, 2); assert.equal(writes.length, 2);
    });
    check('duplicate results retain order and all positions', () => {
      const values = JSON.parse(w.batchBody(parts)).results.map(x => x.value.path);
      assert.deepEqual(values, ['/3/movie/popular', '/3/movie/popular', '/3/tv/popular', '/3/movie/popular']);
      assert.equal(run.parts.length, 4);
    });
    check('batch parts preserve original stored timestamps', () => assert.ok(parts.every(p => p.storedAt > 0)));
    reset(); c = context();
    const e = env(), old = Date.now() - 60000;
    w.memoPut(w.tmdbState(e), a, '{"results":[]}', old);
    const cachedParts = await w.runBatchPlan([a, a], e, c.ctx, {}).all;
    check('fresh memo reuse does not renew assembled freshness', () => assert.equal(w.planStoredAt(cachedParts), old));
    check('fresh memo duplicates do not read or write edge cache', () => { assert.equal(reads.length, 0); assert.equal(writes.length, 0); });
    check('oldest part limits mixed plan freshness', () => assert.equal(w.planStoredAt([{ok:true,storedAt:old}, {ok:true,storedAt:old+1000}]), old));
    check('stale or unknown-age parts cannot create fresh plans', () => {
      assert.ok(Date.now() - w.planStoredAt([{ok:true,storedAt:Date.now(),stale:true}]) >= 10800000);
      assert.ok(Date.now() - w.planStoredAt([{ok:true}]) >= 10800000);
    });
    reset(); c = context();
    await w.refreshBatch([a], 'refresh-test', e, c.ctx, new Request('https://moviezonne.com/api/tmdb/batch/test'), w.subrequestBudget(e, 2));
    await c.settle();
    check('background plan refresh preserves fresh part age', () => {
      const entry = store.get('https://moviezonne.com/api/tmdb/batch/test');
      assert.ok(entry); assert.equal(Number(entry.headers.get('x-mz-stored')), old);
    });
    reset(); c = context();
    const duplicateResponse = await batch(new Array(24).fill(a), env(), c.ctx);
    const duplicateBody = await duplicateResponse.json(); await c.settle();
    check('maximum duplicate plan keeps all positions with unique budget work', () => {
      assert.equal(duplicateBody.results.length, 24);
      assert.ok(duplicateBody.results.every(p => p.status === 'fulfilled'));
      assert.equal(upstream.length, 1); assert.equal(reads.length, 2); assert.equal(writes.length, 2);
    });
    reset();
    const sharedEnv = env(), c1 = context(), c2 = context();
    await Promise.all([w.runBatchPlan([a, a], sharedEnv, c1.ctx, {}).all,
      w.runBatchPlan([a, a], sharedEnv, c2.ctx, {}).all]);
    await c1.settle(); await c2.settle();
    check('concurrent requests never share in-flight I/O promises', () => assert.equal(upstream.length, 2));
    reset(); c = context();
    global.caches.default.match = req => {
      reads.push(req.url);
      return req.url.includes('/batch/') ? new Promise(() => {}) : Promise.resolve(undefined);
    };
    global.fetch = async input => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      assert.equal(url.hostname, 'api.themoviedb.org');
      await new Promise(resolve => setTimeout(resolve, 200));
      return new Response('{"results":[]}');
    };
    const start = Date.now();
    const response = await batch([a], env(), c.ctx);
    const elapsed = Date.now() - start;
    check('hanging assembled cache read stays inside foreground deadline', () => assert.ok(elapsed < 500, 'elapsed ' + elapsed));
    const body = await response.json();
    check('deadline response retains rejected result positions', () => {
      assert.equal(body.results.length, 1); assert.equal(body.results[0].status, 'rejected');
    });
    await c.settle();
    check('late completion stores full plan after deadline', () => assert.ok(writes.some(url => url.includes('/batch/'))));
  } finally { global.fetch = originalFetch; global.caches = originalCaches; }
  console.log(passed + ' checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
