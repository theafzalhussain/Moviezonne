
/*  Measures and guards the WORKER-SIDE TMDB path — the batch endpoint's cache
 *  layers, its single-flight, and the cost of a warm request.
 *
 *  ── why this file had to exist ──
 *  /api/tmdb/batch is the hottest object on the site: it IS the homepage's first
 *  screen, assembled from 16-40 TMDB paths in one round trip. And until now it
 *  had no measurement at all. tmdb-e2e.js and tmdb-stale.js both `require`
 *  server.js, which has no /batch route, so they exercise the Express fan-out
 *  path — the one that only runs on localhost. Nothing anywhere asserted the
 *  Worker's KV hit behaviour, its cache-layer ordering, or how many KV reads a
 *  warm homepage costs. An optimisation there was unverifiable by construction.
 *
 *  ── what is asserted, and why each one is a real failure mode ──
 *    1. COLD      a first request assembles once and stores in BOTH layers.
 *                 Storing in only one gives every Cloudflare colo its own cold
 *                 start (colo-only) or throws away the free layer (KV-only).
 *    2. WARM      the second identical request is answered by the colo cache
 *                 with ZERO KV reads. This is the entire point of the layer: KV
 *                 reads are metered, and the homepage plan is identical for
 *                 every visitor on a given day, so a KV read per visitor is the
 *                 site spending quota to re-answer one question.
 *    3. PROMOTION a colo miss with a fresh KV entry answers from KV and copies
 *                 it into the colo, so the NEXT request in that colo skips KV.
 *                 Without this the colo layer only ever fills on a hard miss.
 *    4. STALENESS a stale copy is served immediately and refreshed behind the
 *                 response, in BOTH layers. Refreshing only KV would leave the
 *                 stale colo entry answering every request in that colo until
 *                 its retention expired — the refresh would run forever and be
 *                 observed by nobody.
 *    5. SINGLE-   N concurrent cold requests for the same plan must assemble
 *       FLIGHT    ONCE. Per-path single-flight already shared the upstream
 *                 fetches, which is why this was invisible in TMDB request
 *                 counts while still burning N x the parse, re-serialise and KV
 *                 write on every cold start.
 *    6. POISONING a GET to the synthetic colo cache key must 404. The generic
 *                 edge layer in fetch() stores any 200 it sees under /api/tmdb/,
 *                 so if that path resolved to anything, one GET to a guessed
 *                 plan key could overwrite a plan's cached first screen.
 *    7. FAILURE   a plan with a failing path is not stored in either layer.
 *                 Caching a half-empty first screen turns one bad moment into a
 *                 lasting one.
 *
 *  No network: TMDB is stubbed, so this is deterministic and runs offline. The
 *  numbers it prints are KV/colo operation COUNTS, which is the unit that
 *  matters here — wall-clock latency against a stub would measure nothing.
 *
 *  Run: node worker-perf-check.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const WORKER_FILE = path.join(__dirname, 'worker.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log('    PASS  ' + label);
  } else {
    fail++;
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('    FAIL  ' + label + (detail ? '\n            ' + detail : ''));
  }
}

function equal(label, actual, expected) {
  check(label, actual === expected,
    'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/*  A KV double that COUNTS reads and writes.
 *
 *  The counters are the measurement: "how many KV reads does a warm homepage
 *  cost" is the question this file exists to answer, and it is not observable
 *  from a response body. */
function countingKV(seed = {}) {
  const data = new Map(Object.entries(seed));
  const meta = new Map();
  const counters = { reads: 0, writes: 0 };
  return {
    data,
    meta,
    counters,
    async get(key) { counters.reads++; return data.has(key) ? data.get(key) : null; },
    async getWithMetadata(key) {
      counters.reads++;
      if (!data.has(key)) return { value: null, metadata: null };
      return { value: data.get(key), metadata: meta.has(key) ? meta.get(key) : null };
    },
    async put(key, value, options) {
      counters.writes++;
      data.set(key, String(value));
      if (options && options.metadata) meta.set(key, options.metadata);
    },
    async delete(key) { data.delete(key); meta.delete(key); },
    async list() { return { keys: [], list_complete: true, cursor: '0' }; }
  };
}

/*  A Cache API double.
 *
 *  Keyed on the request URL, which is exactly how the real one keys a GET, and
 *  the reason the Worker builds its synthetic key on `url.origin` rather than an
 *  invented hostname: an off-zone key is silently unstorable in production, so a
 *  double that accepted anything would hide that class of bug. */
function fakeCaches() {
  const store = new Map();
  const counters = { matches: 0, puts: 0 };
  return {
    store,
    counters,
    default: {
      async match(request) {
        counters.matches++;
        const key = typeof request === 'string' ? request : request.url;
        const hit = store.get(key);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        counters.puts++;
        const key = typeof request === 'string' ? request : request.url;
        store.set(key, response.clone());
      }
    }
  };
}

/** Waits for the promises a handler handed to ctx.waitUntil. */
function makeCtx() {
  const pending = [];
  return {
    ctx: { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } },
    settle: () => Promise.all(pending.splice(0))
  };
}

const batchReq = (paths) => new Request('https://moviezone.dev/api/tmdb/batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ paths })
});

/*  The homepage-shaped plan. 16 paths, matching _mzCatPlan('all') in
 *  moviezone.js, so the counts printed below are the real homepage's counts and
 *  not a toy two-path plan's. */
const PLAN = [
  '/movie/now_playing?language=en-US&page=1',
  '/trending/movie/week?language=en-US&page=1',
  '/trending/movie/day?language=en-US&page=1',
  '/movie/popular?language=en-US&page=1',
  '/discover/movie?language=en-US&page=1&with_original_language=ko',
  '/discover/movie?language=en-US&page=1&with_genres=16',
  '/discover/movie?language=en-US&page=2',
  '/discover/movie?language=en-US&page=3',
  '/discover/movie?language=en-US&page=4',
  '/discover/movie?language=en-US&page=5',
  '/discover/movie?language=en-US&page=6',
  '/discover/movie?language=en-US&page=7',
  '/discover/tv?language=en-US&page=1',
  '/discover/tv?language=en-US&page=2',
  '/trending/tv?language=en-US&page=1',
  '/tv/popular?language=en-US&page=1'
];

(async () => {
  console.log('\nWorker TMDB path — batch cache layers, single-flight and warm cost');
  console.log('-'.repeat(74));

  /*  Same data:-URL import the other worker suites use, with relative specifiers
   *  made absolute: the real module, unmodified, with real ESM semantics. */
  const source = fs.readFileSync(WORKER_FILE, 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g,
      (_m, file) => "from '" + pathToFileURL(path.join(__dirname, file)).href + "'");
  const worker = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );

  /*  TMDB is stubbed at global fetch. `upstream` counts how many times a path was
   *  actually fetched, which is what proves single-flight rather than merely
   *  suggesting it. */
  const realFetch = global.fetch;
  let upstream = 0;
  let failPath = null;
  global.fetch = async (input) => {
    const target = typeof input === 'string' ? input : input.url;
    if (!/api\.themoviedb\.org/.test(target)) return realFetch(input);
    upstream++;
    if (failPath && target.includes(failPath)) {
      return new Response('{"status_message":"nope"}', { status: 500 });
    }
    return new Response(JSON.stringify({
      page: 1,
      results: [{ id: 1, title: 'Stub', poster_path: '/p.jpg' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // `caches` is a Worker global; under Node it has to be provided.
  const cacheLayer = fakeCaches();
  global.caches = cacheLayer;

  const env = { TMDB_TOKEN: 'stub-token', TMDB_CACHE: countingKV() };
  const call = (request, ctx) =>
    worker.routeApi(request, env, ctx, new URL(request.url));

  try {
    // ── 1. COLD ────────────────────────────────────────────────────────────
    console.log('\n1. cold request — assemble once, store in both layers');
    let kv = env.TMDB_CACHE.counters;
    let c1 = makeCtx();
    const cold = await call(batchReq(PLAN), c1.ctx);
    await c1.settle();

    equal('cold batch answers 200', cold.status, 200);
    equal('cold batch reports MISS', cold.headers.get('x-cache'), 'MISS');
    equal('cold batch reports it was stored', cold.headers.get('x-batch-stored'), 'yes');
    equal('every path in the plan was fetched exactly once', upstream, PLAN.length);
    const coldBody = await cold.json();
    equal('the response carries one result per path', coldBody.results.length, PLAN.length);
    check('every result is fulfilled',
      coldBody.results.every(r => r.status === 'fulfilled'));

    const planKeys = [...env.TMDB_CACHE.data.keys()].filter(k => k.startsWith('batch:'));
    equal('the assembled plan was written to KV once', planKeys.length, 1);
    const coloKeys = [...cacheLayer.store.keys()].filter(k => k.includes('/api/tmdb/batch/'));
    equal('the assembled plan was written to the colo cache', coloKeys.length, 1);
    check('the colo key is on-zone and derived from the plan hash',
      coloKeys[0].startsWith('https://moviezone.dev/api/tmdb/batch/batch:'),
      'got ' + coloKeys[0]);

    // ── 2. WARM ────────────────────────────────────────────────────────────
    console.log('\n2. warm request — colo answers it, KV is not touched');
    const kvReadsBefore = kv.reads;
    const upstreamBefore = upstream;
    const c2 = makeCtx();
    const warm = await call(batchReq(PLAN), c2.ctx);
    await c2.settle();

    equal('warm batch answers 200', warm.status, 200);
    equal('warm batch reports EDGE-HIT', warm.headers.get('x-cache'), 'EDGE-HIT');
    equal('a warm homepage costs ZERO KV reads', kv.reads - kvReadsBefore, 0);
    equal('a warm homepage costs ZERO upstream fetches', upstream - upstreamBefore, 0);
    const warmBody = await warm.json();
    check('the warm body is byte-identical to the cold one',
      JSON.stringify(warmBody) === JSON.stringify(coldBody));

    // ── 3. PROMOTION ───────────────────────────────────────────────────────
    console.log('\n3. colo miss with a fresh KV entry — answered from KV, then promoted');
    cacheLayer.store.clear();
    const kvReadsBeforePromo = kv.reads;
    const c3 = makeCtx();
    const fromKv = await call(batchReq(PLAN), c3.ctx);
    await c3.settle();

    equal('a colo miss falls through to KV', fromKv.headers.get('x-cache'), 'HIT');
    check('it cost exactly one KV read', kv.reads - kvReadsBeforePromo === 1,
      'took ' + (kv.reads - kvReadsBeforePromo));
    equal('no upstream fetch was needed', upstream, upstreamBefore);
    equal('the KV hit was promoted into the colo cache',
      [...cacheLayer.store.keys()].filter(k => k.includes('/api/tmdb/batch/')).length, 1);

    const c3b = makeCtx();
    const afterPromo = await call(batchReq(PLAN), c3b.ctx);
    await c3b.settle();
    equal('so the next request skips KV entirely',
      afterPromo.headers.get('x-cache'), 'EDGE-HIT');

    // ── 4. STALENESS ───────────────────────────────────────────────────────
    console.log('\n4. stale copies are served instantly and refreshed in both layers');
    // Age both layers past BATCH_CACHE_TTL (3h) by rewriting their timestamps.
    const staleAt = Date.now() - (4 * 3600 * 1000);
    const planKey = planKeys[0];
    env.TMDB_CACHE.meta.set(planKey, { t: staleAt });
    const coloKey = [...cacheLayer.store.keys()].find(k => k.includes('/api/tmdb/batch/'));
    const staleBody = await cacheLayer.store.get(coloKey).text();
    cacheLayer.store.set(coloKey, new Response(staleBody, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-mz-stored': String(staleAt) }
    }));

    const upstreamBeforeStale = upstream;
    const kvReadsBeforeStale = kv.reads;
    const c4 = makeCtx();
    const stale = await call(batchReq(PLAN), c4.ctx);
    equal('a stale colo copy is served as EDGE-STALE',
      stale.headers.get('x-cache'), 'EDGE-STALE');
    check('and it is served before the refresh completes',
      (await stale.json()).results.length === PLAN.length);
    await c4.settle();

    /*  The refresh must have re-read the per-path entries — that is what "cheap
     *  by construction" means here — and must NOT have gone upstream: every path
     *  inside the plan is itself SWR-cached, so a plan-key expiry is a
     *  re-assemble from KV, not a fresh round of TMDB requests. Asserting the
     *  absence of upstream traffic is the point: if this ever starts fetching,
     *  every 3h boundary becomes a 16-request burst against TMDB. */
    check('the refresh re-read the plan\'s paths from KV', kv.reads > kvReadsBeforeStale,
      'no KV read happened, so nothing was re-assembled');
    equal('and needed no upstream fetch at all', upstream, upstreamBeforeStale);
    const refreshedMeta = env.TMDB_CACHE.meta.get(planKey);
    check('KV was rewritten with a fresh timestamp',
      refreshedMeta && refreshedMeta.t > staleAt);
    const refreshedColo = cacheLayer.store.get(coloKey);
    check('the colo copy was rewritten too — otherwise it would answer stale forever',
      refreshedColo && Number(refreshedColo.headers.get('x-mz-stored')) > staleAt);

    const c4b = makeCtx();
    const afterRefresh = await call(batchReq(PLAN), c4b.ctx);
    await c4b.settle();
    equal('the next request sees a fresh colo copy',
      afterRefresh.headers.get('x-cache'), 'EDGE-HIT');

    // ── 5. PLAN-LEVEL SINGLE-FLIGHT ────────────────────────────────────────
    console.log('\n5. concurrent cold visitors assemble the plan once, not N times');
    const coldEnv = { TMDB_TOKEN: 'stub-token', TMDB_CACHE: countingKV() };
    cacheLayer.store.clear();
    upstream = 0;
    const CONCURRENT = 5;
    const ctxs = Array.from({ length: CONCURRENT }, () => makeCtx());
    const responses = await Promise.all(ctxs.map(c =>
      worker.routeApi(batchReq(PLAN), coldEnv, c.ctx,
        new URL('https://moviezone.dev/api/tmdb/batch'))));
    await Promise.all(ctxs.map(c => c.settle()));

    check('every concurrent caller got a 200',
      responses.every(r => r.status === 200));
    equal('the plan was fetched upstream exactly once, not ' + CONCURRENT + ' times',
      upstream, PLAN.length);
    const bodies = await Promise.all(responses.map(r => r.json()));
    check('every caller got the same assembled result',
      bodies.every(b => JSON.stringify(b) === JSON.stringify(bodies[0])));

    // ── 6. CACHE-POISONING GUARD ───────────────────────────────────────────
    console.log('\n6. the synthetic colo key is not a reachable endpoint');
    const c6 = makeCtx();
    const poke = await worker.routeApi(
      new Request('https://moviezone.dev/api/tmdb/batch/' + planKey, { method: 'GET' }),
      env, c6.ctx, new URL('https://moviezone.dev/api/tmdb/batch/' + planKey));
    await c6.settle();
    equal('a GET to the plan cache key answers 404', poke.status, 404);
    check('a 404 is never stored by the generic edge layer, so a plan cannot be'
      + ' overwritten', poke.status !== 200);

    const c6b = makeCtx();
    const del = await worker.routeApi(
      new Request('https://moviezone.dev/api/tmdb/batch', { method: 'DELETE' }),
      env, c6b.ctx, new URL('https://moviezone.dev/api/tmdb/batch'));
    await c6b.settle();
    equal('DELETE on the batch endpoint is rejected', del.status, 405);

    // ── 7. A BROKEN PLAN IS NOT CACHED ─────────────────────────────────────
    console.log('\n7. a plan with a failing path is not stored in either layer');
    const brokenEnv = { TMDB_TOKEN: 'stub-token', TMDB_CACHE: countingKV() };
    cacheLayer.store.clear();
    failPath = 'tv/popular';
    const c7 = makeCtx();
    const broken = await worker.routeApi(batchReq(PLAN), brokenEnv, c7.ctx,
      new URL('https://moviezone.dev/api/tmdb/batch'));
    await c7.settle();
    failPath = null;

    equal('a partial failure still answers 200', broken.status, 200);
    equal('and reports that it was NOT stored',
      broken.headers.get('x-batch-stored'), 'no');
    equal('nothing was written to KV',
      [...brokenEnv.TMDB_CACHE.data.keys()].filter(k => k.startsWith('batch:')).length, 0);
    equal('nothing was written to the colo cache',
      [...cacheLayer.store.keys()].filter(k => k.includes('/api/tmdb/batch/')).length, 0);

    // ── 8. THE MEASUREMENT, PRINTED ────────────────────────────────────────
    console.log('\n8. cost of one homepage plan, by cache state');
    const measure = async (label, prepare) => {
      const e = { TMDB_TOKEN: 'stub-token', TMDB_CACHE: countingKV() };
      cacheLayer.store.clear();
      cacheLayer.counters.matches = 0;
      cacheLayer.counters.puts = 0;
      upstream = 0;
      await prepare(e);
      const before = { kv: e.TMDB_CACHE.counters.reads, up: upstream };
      const c = makeCtx();
      const res = await worker.routeApi(batchReq(PLAN), e, c.ctx,
        new URL('https://moviezone.dev/api/tmdb/batch'));
      await c.settle();
      console.log('      ' + label.padEnd(22)
        + 'x-cache=' + String(res.headers.get('x-cache')).padEnd(10)
        + 'kvReads=' + (e.TMDB_CACHE.counters.reads - before.kv)
        + '  upstream=' + (upstream - before.up));
      return { res, kvReads: e.TMDB_CACHE.counters.reads - before.kv };
    };

    const m1 = await measure('cold (nothing warm)', async () => {});
    const m2 = await measure('KV warm, colo cold', async (e) => {
      const c = makeCtx();
      await worker.routeApi(batchReq(PLAN), e, c.ctx,
        new URL('https://moviezone.dev/api/tmdb/batch'));
      await c.settle();
      cacheLayer.store.clear();
    });
    const m3 = await measure('colo warm', async (e) => {
      const c = makeCtx();
      await worker.routeApi(batchReq(PLAN), e, c.ctx,
        new URL('https://moviezone.dev/api/tmdb/batch'));
      await c.settle();
    });

    check('the steady state (colo warm) costs no KV reads at all', m3.kvReads === 0,
      'cost ' + m3.kvReads + ' KV reads');
    check('a colo-cold / KV-warm plan costs exactly one KV read', m2.kvReads === 1,
      'cost ' + m2.kvReads + ' KV reads');
    check('a fully cold plan reads KV per path plus the plan key',
      m1.kvReads === PLAN.length + 1,
      'expected ' + (PLAN.length + 1) + ', got ' + m1.kvReads);
  } finally {
    global.fetch = realFetch;
    delete global.caches;
  }

  console.log('\n' + '='.repeat(74));
  console.log('  worker-perf-check: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) failures.forEach(f => console.log('   x ' + f));
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('crashed:', e);
  process.exit(1);
});
