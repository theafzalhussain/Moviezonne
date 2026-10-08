
/*  Measures and guards the WORKER-SIDE TMDB path — the batch endpoint's cache
 *  layers, abandon-safety, the subrequest budget, the OTT charts, and the cost
 *  of a warm request.
 *
 *  ── why this file exists ──
 *  /api/tmdb/batch is the hottest object on the site: it IS the homepage's first
 *  screen, assembled from 12-24 TMDB paths in one round trip. tmdb-e2e.js and
 *  tmdb-stale.js both `require` server.js, which has no /batch route, so nothing
 *  else asserts the Worker's cache layering or what a request costs.
 *
 *  ── the model being guarded (Sep 2026) ──
 *  TMDB data never touches KV any more. KV's free plan allows 100,000 reads and
 *  1,000 writes a DAY, account-wide, and every get() counts - so using it as a
 *  cache exhausted it with ~10 human visitors a day (crawlers and fan-outs did
 *  the spending). The layers are now:
 *      L1 isolate memory  ->  L2 caches.default (per location, unmetered)  ->  TMDB
 *  and every fan-out (a batch plan, an OTT chart) runs inside a per-invocation
 *  SUBREQUEST BUDGET, because on Workers Free fetch() and Cache API calls share
 *  one quota of 50 per invocation.
 *
 *  ── what is asserted, and why each one is a real failure mode ──
 *    1. COLD      a first request assembles once and stores the plan at the edge,
 *                 with ZERO KV operations.
 *    2. WARM      the second identical request is answered by the location cache:
 *                 one cache read, zero upstream, zero KV.
 *    3. REUSE     a fresh isolate whose plan entry is gone re-assembles from the
 *                 per-path edge entries instead of going back to TMDB for them.
 *    4. STALENESS a stale plan is served immediately and rebuilt behind the
 *                 response, and the location copy is rewritten.
 *    5. ABANDON-  a request whose upstream I/O died with its client can stall
 *       SAFE      nobody: it answers 503 by the proxy deadline, and the next
 *                 visitor or batch on the same path gets its own answer. N
 *                 concurrent cold visitors are each answered in full.
 *    6. POISONING a GET to the synthetic plan key must 404.
 *    7. FAILURE   a plan with a failing path is not stored.
 *    8.           the cost of one homepage plan, by cache state, printed.
 *    9. SPLICE    the batch body is the cached bodies concatenated, valid JSON.
 *   10. LONG TAIL search and per-title paths are edge-cached, never in KV.
 *   11. DEADLINE  a slow path cannot hold the batch past its deadline.
 *   12. BUDGET    a cold 16- and 24-path plan both stay inside 50 subrequests.
 *   13. PER-TITLE a per-visitor plan's parts are shared through the edge.
 *   14. OTT       charts: KV-free, memo -> edge -> build, stale refresh cooldown,
 *                 and a cold 24-title chart inside the subrequest limit.
 *
 *  No network: TMDB and JustWatch are stubbed, so this is deterministic and runs
 *  offline. The numbers it prints are operation COUNTS, which is the unit that
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

/*  A KV double that COUNTS every operation. It is bound as TMDB_CACHE in every
 *  environment below precisely so that "the TMDB path never touches KV" is an
 *  observed fact and not an assumption: if any code path regressed to reading
 *  or writing it, these counters would move. */
function countingKV(seed = {}) {
  const data = new Map(Object.entries(seed));
  const meta = new Map();
  const counters = { reads: 0, writes: 0, lists: 0 };
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
    async list() { counters.lists++; return { keys: [], list_complete: true, cursor: '0' }; }
  };
}
const kvOps = (kv) => kv.counters.reads + kv.counters.writes + kv.counters.lists;

/*  A Cache API double.
 *
 *  Keyed on the request URL, which is exactly how the real one keys a GET, and
 *  the reason the Worker builds its synthetic keys on the site origin rather than
 *  an invented hostname: an off-zone key is silently unstorable in production, so
 *  a double that accepted anything would hide that class of bug. */
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
    settle: async () => {
      // Background work can schedule more background work; drain until quiet.
      while (pending.length) await Promise.all(pending.splice(0));
    }
  };
}

const batchReq = (paths) => new Request('https://moviezone.dev/api/tmdb/batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ paths })
});
const BATCH_URL = new URL('https://moviezone.dev/api/tmdb/batch');

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

/** MAX_BATCH_PATHS-sized plan: the largest a client may send. */
const PLAN_24 = Array.from({ length: 24 }, (_, i) =>
  '/discover/movie?language=en-US&page=' + (i + 1) + '&with_genres=28');

const isBatchKey = (k) => k.includes('/api/tmdb/batch/');
const isPathKey = (k) => k.includes('/api/tmdb/') && !isBatchKey(k);

(async () => {
  console.log('\nWorker TMDB path — cache layers, subrequest budget, abandon-safety, OTT charts');
  console.log('-'.repeat(78));

  /*  Same data:-URL import the other worker suites use, with relative specifiers
   *  made absolute: the real module, unmodified, with real ESM semantics. */
  const source = fs.readFileSync(WORKER_FILE, 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g,
      (_m, file) => "from '" + pathToFileURL(path.join(__dirname, file)).href + "'");
  const worker = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );

  /*  TMDB and JustWatch are stubbed at global fetch. `upstream` counts TMDB
   *  fetches, `jwCalls` JustWatch ones, which is what proves the per-request
   *  sharing and the budget rather than merely suggesting them. */
  const realFetch = global.fetch;
  let upstream = 0;
  let jwCalls = 0;
  let failPath = null;
  let slowPath = null;
  /*  The next upstream call for this path belongs to a request whose client went
   *  away: workerd drops that request's I/O, AbortSignal timer included, so the
   *  call never settles. One call only - whoever asks next gets a real answer. */
  let hangPath = null;
  const STUB_LIST = JSON.stringify({
    page: 1,
    results: [{ id: 1, title: 'Stub', poster_path: '/p.jpg' }]
  });
  global.fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : input.url;
    if (target.startsWith('https://apis.justwatch.com/')) {
      jwCalls++;
      const body = JSON.parse((init && init.body) || '{}');
      const trending = /popularTitles/.test(body.query || '');
      const ids = trending
        ? Array.from({ length: 20 }, (_, i) => 5000 + i)
        : Array.from({ length: 10 }, (_, i) => 6000 + i);
      const edges = ids.map((id) => ({ node: {
        objectType: 'MOVIE',
        content: { title: 'JW ' + id, originalReleaseYear: 2026, externalIds: { tmdbId: String(id) } }
      } }));
      return new Response(JSON.stringify({ data: trending
        ? { popularTitles: { edges } }
        : { newTitles: { edges } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (new URL(target).hostname !== 'api.themoviedb.org') throw new Error('Unexpected offline fetch: ' + target);
    upstream++;
    if (hangPath && target.includes(hangPath)) {
      hangPath = null;
      return new Promise(() => {});
    }
    if (failPath && target.includes(failPath)) {
      return new Response('{"status_message":"nope"}', { status: 500 });
    }
    if (slowPath && target.includes(slowPath)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    const detail = /\/3\/(movie|tv)\/(\d+)\?/.exec(target);
    if (detail) {
      return new Response(JSON.stringify({
        id: Number(detail[2]), title: 'Title ' + detail[2], poster_path: '/p' + detail[2] + '.jpg',
        genres: [{ id: 18, name: 'Drama' }], original_language: 'hi'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(STUB_LIST, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // `caches` is a Worker global; under Node it has to be provided.
  const cacheLayer = fakeCaches();
  global.caches = cacheLayer;
  const resetCounters = () => {
    cacheLayer.counters.matches = 0;
    cacheLayer.counters.puts = 0;
    upstream = 0;
    jwCalls = 0;
  };
  const subrequests = () => cacheLayer.counters.matches + cacheLayer.counters.puts + upstream + jwCalls;

  const newEnv = (extra) => Object.assign({ TMDB_TOKEN: 'stub-token', TMDB_CACHE: countingKV() }, extra || {});
  const env = newEnv();
  const call = (request, ctx, e) => worker.routeApi(request, e || env, ctx, new URL(request.url));

  try {
    // ── 1. COLD ────────────────────────────────────────────────────────────
    console.log('\n1. cold request — assemble once, store at the edge, never touch KV');
    const c1 = makeCtx();
    const cold = await call(batchReq(PLAN), c1.ctx);
    await c1.settle();

    equal('cold batch answers 200', cold.status, 200);
    equal('cold batch reports MISS', cold.headers.get('x-cache'), 'MISS');
    equal('cold batch reports it was stored', cold.headers.get('x-batch-stored'), 'yes');
    equal('every path in the plan was fetched exactly once', upstream, PLAN.length);
    const coldBody = await cold.json();
    equal('the response carries one result per path', coldBody.results.length, PLAN.length);
    check('every result is fulfilled', coldBody.results.every((r) => r.status === 'fulfilled'));

    const coloKeys = [...cacheLayer.store.keys()].filter(isBatchKey);
    equal('the assembled plan was written to the location cache', coloKeys.length, 1);
    check('the plan key is on-zone and derived from the plan hash',
      coloKeys[0].startsWith('https://moviezone.dev/api/tmdb/batch/batch:'), 'got ' + coloKeys[0]);
    equal('a cold homepage plan costs ZERO KV operations', kvOps(env.TMDB_CACHE), 0);
    check('the cold assemble stayed inside the Free plan limit (50)', subrequests() <= 50,
      subrequests() + ' subrequests');

    // ── 2. WARM ────────────────────────────────────────────────────────────
    console.log('\n2. warm request — the location cache answers it');
    resetCounters();
    const c2 = makeCtx();
    const warm = await call(batchReq(PLAN), c2.ctx);
    await c2.settle();

    equal('warm batch answers 200', warm.status, 200);
    equal('warm batch reports EDGE-HIT', warm.headers.get('x-cache'), 'EDGE-HIT');
    equal('a warm homepage costs ONE cache read', cacheLayer.counters.matches, 1);
    equal('and zero upstream fetches', upstream, 0);
    equal('and zero KV operations', kvOps(env.TMDB_CACHE), 0);
    const warmBody = await warm.json();
    check('the warm body is byte-identical to the cold one',
      JSON.stringify(warmBody) === JSON.stringify(coldBody));

    // ── 3. REUSE ───────────────────────────────────────────────────────────
    console.log('\n3. a fresh isolate, plan entry gone — parts come from the edge, not TMDB');
    const pathEntries = [...cacheLayer.store.keys()].filter(isPathKey).length;
    check('the cold assemble also kept per-path copies (budget permitting)', pathEntries > 0,
      pathEntries + ' per-path entries');
    for (const k of [...cacheLayer.store.keys()].filter(isBatchKey)) cacheLayer.store.delete(k);
    resetCounters();
    const reuseEnv = newEnv();
    const c3 = makeCtx();
    const reused = await call(batchReq(PLAN), c3.ctx, reuseEnv);
    await c3.settle();
    equal('the re-assembled plan answers 200', reused.status, 200);
    equal('only the paths without an edge copy went to TMDB', upstream, PLAN.length - pathEntries);
    equal('still no KV', kvOps(reuseEnv.TMDB_CACHE), 0);
    check('the re-assemble stayed inside 50 subrequests', subrequests() <= 50, subrequests() + '');

    // ── 4. STALENESS ───────────────────────────────────────────────────────
    console.log('\n4. a stale plan is served instantly and rebuilt behind the response');
    const staleAt = Date.now() - (4 * 3600 * 1000);
    const coloKey = [...cacheLayer.store.keys()].find(isBatchKey);
    const staleBody = await cacheLayer.store.get(coloKey).text();
    cacheLayer.store.set(coloKey, new Response(staleBody, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-mz-stored': String(staleAt) }
    }));

    resetCounters();
    const c4 = makeCtx();
    const stale = await call(batchReq(PLAN), c4.ctx, reuseEnv);
    equal('a stale location copy is served as EDGE-STALE', stale.headers.get('x-cache'), 'EDGE-STALE');
    check('and it is served before the refresh completes',
      (await stale.json()).results.length === PLAN.length);
    await c4.settle();

    /*  Every part is fresh in this isolate's memory, so the rebuild is a
     *  re-assemble, not a round of TMDB requests. If this ever starts fetching,
     *  every 3h boundary becomes a 16-request burst per location. */
    equal('the rebuild needed no upstream fetch (parts were fresh)', upstream, 0);
    equal('and no KV', kvOps(reuseEnv.TMDB_CACHE), 0);
    const refreshedColo = cacheLayer.store.get(coloKey);
    check('the location copy was rewritten — otherwise it would answer stale forever',
      refreshedColo && Number(refreshedColo.headers.get('x-mz-stored')) > staleAt);

    const c4b = makeCtx();
    const afterRefresh = await call(batchReq(PLAN), c4b.ctx, reuseEnv);
    await c4b.settle();
    equal('the next request sees a fresh copy', afterRefresh.headers.get('x-cache'), 'EDGE-HIT');

    // ── 5. NO REQUEST WAITS ON ANOTHER REQUEST'S I/O ───────────────────────
    /*  In-flight work used to be shared across requests through module-level
     *  maps (one promise per path, plan, chart). On Workers a promise belongs to
     *  the request that created it: when that request's client disconnects, its
     *  I/O - AbortSignal timer included - is dropped and the promise never
     *  settles, so every later request that joined it hung for good. That is what
     *  production did on 27 Sep 2026: the Top 10 rail's page-2 path never
     *  answered, and Datadog RUM booked 15-21 s page loads. The stub below models
     *  the abandoned request exactly - its upstream call never settles and
     *  ignores its signal - so these checks hang-and-fail on the old design. */
    console.log('\n5. an abandoned request cannot stall anyone after it');
    const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
    {
      const HANG = '/trending/movie/day?language=en-US&page=2';
      const proxyUrl = new URL('https://moviezone.dev/api/tmdb' + HANG);
      const proxyReq = () => new Request(proxyUrl.href);
      const hungEnv = newEnv({ TMDB_PROXY_DEADLINE_MS: '300' });
      cacheLayer.store.clear();
      resetCounters();

      hangPath = HANG;
      const t0 = Date.now();
      // Its ctx is never settled on purpose: the I/O behind it is dead by construction.
      const owner = await within(worker.routeApi(proxyReq(), hungEnv, makeCtx().ctx, proxyUrl), 3000);
      const took = Date.now() - t0;
      check('the abandoned request itself answers by the proxy deadline',
        owner !== null && took < 1500, owner === null ? 'no answer within 3s' : 'took ' + took + 'ms');
      equal('that answer is a retryable 503', owner && owner.status, 503);
      equal('which no shared cache may keep', owner && owner.headers.get('cache-control'), 'no-store');

      const cNext = makeCtx();
      const next = await within(worker.routeApi(proxyReq(), hungEnv, cNext.ctx, proxyUrl), 3000);
      check('the next visitor on the same path is answered', next !== null, 'still waiting after 3s');
      equal('with a 200', next && next.status, 200);
      equal('from its own upstream call, not the dead one', upstream, 2);
      await within(cNext.settle(), 2000);

      /*  A batch holding that path must not inherit the dead promise either -
       *  that is how one poisoned path became a first screen answered at
       *  BATCH_DEADLINE_MS with a hole in it. Fresh envs and an empty location
       *  cache, so neither memory nor the edge can answer for it. */
      cacheLayer.store.clear();
      hangPath = HANG;
      const abandoned = worker.routeApi(proxyReq(), newEnv({ TMDB_PROXY_DEADLINE_MS: '300' }),
        makeCtx().ctx, proxyUrl);
      await new Promise((r) => setTimeout(r, 20));   // its upstream call is now in flight
      const cBatch = makeCtx();
      const t1 = Date.now();
      const batchRes = await within(worker.routeApi(
        batchReq(['/trending/movie/day?language=en-US&page=1', HANG]),
        newEnv({ BATCH_DEADLINE_MS: '2000' }), cBatch.ctx, BATCH_URL), 4000);
      const batchTook = Date.now() - t1;
      const batchJson = batchRes ? await batchRes.json() : null;
      check('a batch holding that path is answered whole',
        !!batchJson && batchJson.results.every((r) => r.status === 'fulfilled'),
        batchJson ? JSON.stringify(batchJson.results.map((r) => r.status)) : 'no answer within 4s');
      check('without sitting out its deadline', batchRes !== null && batchTook < 1000,
        'took ' + batchTook + 'ms against a 2000ms deadline');
      await within(cBatch.settle(), 2000);
      await within(abandoned, 1000);

      /*  The location cache is a local read, but it sits in front of every
       *  path, so a read that never answers must degrade to a miss, not a hang. */
      const realMatch = cacheLayer.default.match;
      cacheLayer.default.match = (request) => (String(request.url || request).endsWith('/api/tmdb' + HANG)
        ? new Promise(() => {})
        : realMatch.call(cacheLayer.default, request));
      cacheLayer.store.clear();
      const cEdge = makeCtx();
      const t2 = Date.now();
      const viaTmdb = await within(worker.routeApi(proxyReq(), newEnv(), cEdge.ctx, proxyUrl), 5000);
      const edgeTook = Date.now() - t2;
      cacheLayer.default.match = realMatch;
      equal('a location-cache read that never answers falls through to TMDB',
        viaTmdb && viaTmdb.status, 200);
      check('within the edge read timeout, well inside the proxy deadline', viaTmdb !== null && edgeTook < 3000,
        'took ' + edgeTook + 'ms');
      equal('and says where the answer came from', viaTmdb && viaTmdb.headers.get('x-cache-layer'), 'origin');
      await within(cEdge.settle(), 2000);
    }

    // ── 5b. CONCURRENT COLD VISITORS ───────────────────────────────────────
    /*  The price of never sharing across requests: visitors who arrive on the
     *  same cold plan at the same moment each assemble it. Bounded - at most one
     *  upstream call per path per request - and gone once the first plan lands in
     *  the location cache. What must not change is the answer. */
    console.log('\n5b. concurrent cold visitors are each answered in full');
    const coldEnv = newEnv();
    cacheLayer.store.clear();
    resetCounters();
    const CONCURRENT = 5;
    const ctxs = Array.from({ length: CONCURRENT }, () => makeCtx());
    const responses = await Promise.all(ctxs.map((c) =>
      worker.routeApi(batchReq(PLAN), coldEnv, c.ctx, BATCH_URL)));
    await Promise.all(ctxs.map((c) => c.settle()));

    check('every concurrent caller got a 200', responses.every((r) => r.status === 200));
    check('no request fetched any path upstream more than once',
      upstream <= CONCURRENT * PLAN.length,
      upstream + ' upstream calls for ' + CONCURRENT + ' requests x ' + PLAN.length + ' paths');
    const bodies = await Promise.all(responses.map((r) => r.json()));
    check('every caller got the same assembled result',
      bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0])));

    // ── 6. CACHE-POISONING GUARD ───────────────────────────────────────────
    console.log('\n6. the synthetic plan key is not a reachable endpoint');
    const planKey = coloKey.split('/api/tmdb/batch/')[1];
    const c6 = makeCtx();
    const poke = await worker.routeApi(
      new Request('https://moviezone.dev/api/tmdb/batch/' + planKey, { method: 'GET' }),
      env, c6.ctx, new URL('https://moviezone.dev/api/tmdb/batch/' + planKey));
    await c6.settle();
    equal('a GET to the plan cache key answers 404', poke.status, 404);

    const c6b = makeCtx();
    const del = await worker.routeApi(
      new Request('https://moviezone.dev/api/tmdb/batch', { method: 'DELETE' }),
      env, c6b.ctx, BATCH_URL);
    await c6b.settle();
    equal('DELETE on the batch endpoint is rejected', del.status, 405);

    // ── 7. A BROKEN PLAN IS NOT CACHED ─────────────────────────────────────
    console.log('\n7. a plan with a failing path is not stored');
    const brokenEnv = newEnv();
    cacheLayer.store.clear();
    failPath = 'tv/popular';
    const c7 = makeCtx();
    const broken = await worker.routeApi(batchReq(PLAN), brokenEnv, c7.ctx, BATCH_URL);
    await c7.settle();
    failPath = null;

    equal('a partial failure still answers 200', broken.status, 200);
    equal('and reports that it was NOT stored', broken.headers.get('x-batch-stored'), 'no');
    equal('nothing was written to the location cache for the plan',
      [...cacheLayer.store.keys()].filter(isBatchKey).length, 0);
    equal('nothing was written to KV', kvOps(brokenEnv.TMDB_CACHE), 0);

    // ── 8. THE MEASUREMENT, PRINTED ────────────────────────────────────────
    console.log('\n8. cost of one homepage plan, by cache state (per invocation)');
    const measure = async (label, prepare) => {
      const e = newEnv();
      cacheLayer.store.clear();
      await prepare(e);
      resetCounters();
      const c = makeCtx();
      const res = await worker.routeApi(batchReq(PLAN), e, c.ctx, BATCH_URL);
      await res.text();
      await c.settle();
      const cost = { cache: cacheLayer.counters.matches + cacheLayer.counters.puts, up: upstream, kv: kvOps(e.TMDB_CACHE) };
      console.log('      ' + label.padEnd(28)
        + 'x-cache=' + String(res.headers.get('x-cache')).padEnd(11)
        + 'cacheOps=' + String(cost.cache).padEnd(4)
        + 'upstream=' + String(cost.up).padEnd(4)
        + 'kv=' + cost.kv);
      return cost;
    };
    const warmUp = async (e) => {
      const c = makeCtx();
      const r = await worker.routeApi(batchReq(PLAN), e, c.ctx, BATCH_URL);
      await r.text();
      await c.settle();
    };

    const m1 = await measure('cold (nothing anywhere)', async () => {});
    const m2 = await measure('location warm', warmUp);
    const m3 = await measure('parts warm, plan evicted', async (e) => {
      await warmUp(e);
      for (const k of [...cacheLayer.store.keys()].filter(isBatchKey)) cacheLayer.store.delete(k);
    });

    check('no cache state costs a single KV operation', m1.kv + m2.kv + m3.kv === 0,
      'kv ops: ' + [m1.kv, m2.kv, m3.kv].join(', '));
    check('the steady state is one cache read and nothing else', m2.cache === 1 && m2.up === 0,
      JSON.stringify(m2));
    check('a fully cold plan fits the Free plan limit', m1.cache + m1.up <= 50,
      (m1.cache + m1.up) + ' subrequests');

    // ── 9. THE BATCH BODY IS SPLICED, NOT RE-SERIALISED ────────────────────
    console.log('\n9. the batch body is the cached bodies spliced verbatim');
    {
      const e = newEnv();
      cacheLayer.store.clear();
      const c = makeCtx();
      const res = await worker.routeApi(batchReq(PLAN), e, c.ctx, BATCH_URL);
      await c.settle();
      const raw = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (err) { /* reported below */ }
      check('the spliced body is valid JSON', parsed !== null, raw.slice(0, 160));
      check('with one allSettled entry per path',
        parsed && parsed.results.length === PLAN.length
          && parsed.results.every((r) => r.status === 'fulfilled' && r.value && r.value.results));
      check('and each value is the upstream body byte-for-byte',
        raw.indexOf('"value":' + STUB_LIST) !== -1, 'the stub body does not appear verbatim');
    }

    // ── 10. LONG-TAIL PATHS: EDGE, NEVER KV ────────────────────────────────
    console.log('\n10. search and title paths are edge-cached and never touch KV');
    {
      const e = newEnv();
      cacheLayer.store.clear();
      resetCounters();
      const searchUrl = 'https://moviezone.dev/api/tmdb/search/multi?query=dune&page=1';
      const c1 = makeCtx();
      const first = await worker.routeApi(new Request(searchUrl), e, c1.ctx, new URL(searchUrl));
      await c1.settle();
      equal('a search answers 200', first.status, 200);
      check('it is kept at the edge',
        [...cacheLayer.store.keys()].some((k) => k.includes('/api/tmdb/search/multi')));

      // A fresh isolate in the same location: no memory, same caches.default.
      const e2 = newEnv();
      const c2 = makeCtx();
      const again = await worker.routeApi(new Request(searchUrl), e2, c2.ctx, new URL(searchUrl));
      await c2.settle();
      equal('a repeat in the same location is answered by the edge',
        again.headers.get('x-cache-layer'), 'edge');
      equal('and no second upstream fetch', upstream, 1);

      const detailUrl = 'https://moviezone.dev/api/tmdb/movie/550?language=en-US';
      const c3 = makeCtx();
      await worker.routeApi(new Request(detailUrl), e, c3.ctx, new URL(detailUrl));
      await c3.settle();
      equal('a title record is not written to KV either', kvOps(e.TMDB_CACHE) + kvOps(e2.TMDB_CACHE), 0);
    }

    // ── 11. A SLOW PATH CANNOT HOLD THE BATCH ──────────────────────────────
    console.log('\n11. a slow upstream path cannot hold the batch past its deadline');
    {
      const e = newEnv({ BATCH_DEADLINE_MS: '300' });
      cacheLayer.store.clear();
      slowPath = 'tv/popular';
      const c = makeCtx();
      const started = Date.now();
      const res = await worker.routeApi(batchReq(PLAN), e, c.ctx, BATCH_URL);
      const took = Date.now() - started;
      const body = await res.json();
      check('the batch answered at its deadline, not the slow path\'s pace', took < 750,
        'took ' + took + 'ms against a 300ms deadline and an 800ms path');
      equal('the slow path is reported as rejected', body.results[PLAN.length - 1].status, 'rejected');
      check('every other path is served', body.results.slice(0, -1).every((r) => r.status === 'fulfilled'));
      equal('a partial answer is not stored', res.headers.get('x-batch-stored'), 'no');
      await c.settle();
      slowPath = null;
      check('the whole plan is stored once the slow path lands',
        [...cacheLayer.store.keys()].some(isBatchKey));
    }

    // ── 12. THE SUBREQUEST BUDGET ──────────────────────────────────────────
    /*  On Workers Free one invocation gets 50 subrequests, and Cache API
     *  match/put calls count against the same quota as fetch(). Past it, every
     *  fetch() throws "Too many subrequests". The per-path edge layer costs up to
     *  two cache calls per path, so a plan must spend them only while every
     *  path's TMDB fetch is still covered. */
    console.log('\n12. cold 16- and 24-path plans stay inside the 50-subrequest limit');
    for (const [label, plan] of [['16-path homepage plan', PLAN], ['24-path plan (MAX_BATCH_PATHS)', PLAN_24]]) {
      const e = newEnv();
      cacheLayer.store.clear();
      resetCounters();
      const c = makeCtx();
      const res = await worker.routeApi(batchReq(plan), e, c.ctx, BATCH_URL);
      const body = await res.json();
      await c.settle();
      const total = subrequests();
      console.log('          ' + label + ': cache ' + (cacheLayer.counters.matches + cacheLayer.counters.puts)
        + ' + upstream ' + upstream + ' = ' + total + ' subrequests');
      check('a cold ' + label + ' fits in 50 subrequests', total <= 50, total + ' subrequests');
      check('and every path was still answered', body.results.every((r) => r.status === 'fulfilled'),
        JSON.stringify(body.results.filter((r) => r.status !== 'fulfilled')).slice(0, 200));
      equal('with no KV', kvOps(e.TMDB_CACHE), 0);
    }
    {
      // A tiny limit proves the budget degrades gracefully instead of throwing.
      const e = newEnv({ SUBREQUEST_LIMIT: '12' });
      cacheLayer.store.clear();
      resetCounters();
      const c = makeCtx();
      const res = await worker.routeApi(batchReq(PLAN), e, c.ctx, BATCH_URL);
      const body = await res.json();
      await c.settle();
      check('an exhausted budget never exceeds its limit', subrequests() <= 12, subrequests() + ' used');
      equal('it still answers 200', res.status, 200);
      check('paths it could not cover are rejected, so the client fetches just those',
        body.results.some((r) => r.status === 'rejected') && body.results.some((r) => r.status === 'fulfilled'));
      equal('and a partial plan is not stored', res.headers.get('x-batch-stored'), 'no');
    }

    // ── 13. PER-TITLE PLANS SHARE THEIR PARTS THROUGH THE EDGE ─────────────
    console.log('\n13. a per-title plan is kept at the edge, its parts too');
    {
      const e = newEnv();
      cacheLayer.store.clear();
      resetCounters();
      const subPlan = ['/movie/11/release_dates', '/movie/12/release_dates', '/movie/13/release_dates'];
      const c = makeCtx();
      const res = await worker.routeApi(batchReq(subPlan), e, c.ctx, BATCH_URL);
      await res.text();
      await c.settle();
      const keys = [...cacheLayer.store.keys()];
      check('the plan is kept in the location cache', keys.some(isBatchKey));
      check('each part is kept at the edge', subPlan.every((p) => keys.some((k) => k.endsWith('/api/tmdb' + p))),
        keys.join(', '));

      // Another visitor, another isolate, the same titles in another order.
      const before = upstream;
      const e2 = newEnv();
      const c2 = makeCtx();
      const res2 = await worker.routeApi(batchReq(subPlan.slice().reverse()), e2, c2.ctx, BATCH_URL);
      await res2.text();
      await c2.settle();
      equal('a different plan over the same titles fetches nothing from TMDB', upstream - before, 0);
      equal('and nothing touched KV', kvOps(e.TMDB_CACHE) + kvOps(e2.TMDB_CACHE), 0);
    }

    // ── 14. OTT CHARTS ─────────────────────────────────────────────────────
    /*  /api/ott/charts used to read KV on EVERY request, and a stale chart
     *  re-hydrated 24 titles on every request with no cooldown. */
    console.log('\n14. OTT charts: memory -> edge -> build, no KV, bounded refreshes');
    {
      const chartUrl = 'https://moviezone.dev/api/ott/charts?platform=netflix';
      const get = async (e) => {
        const c = makeCtx();
        const res = await worker.routeApi(new Request(chartUrl), e, c.ctx, new URL(chartUrl));
        const body = await res.json();
        await c.settle();
        return { res, body };
      };

      const e = newEnv();
      cacheLayer.store.clear();
      resetCounters();
      const first = await get(e);
      equal('a cold chart answers 200', first.res.status, 200);
      equal('as a MISS', first.res.headers.get('x-cache'), 'MISS');
      check('hydrated into renderable cards', first.body.items && first.body.items.length === 24,
        'items: ' + (first.body.items && first.body.items.length));
      equal('JustWatch was asked exactly twice (trending + newly)', jwCalls, 2);
      check('a cold 24-title chart fits in 50 subrequests', subrequests() <= 50, subrequests() + '');
      check('the chart is stored at the edge under a synthetic key',
        [...cacheLayer.store.keys()].some((k) => k.includes('/__mz/ott-chart/netflix/IN')));
      equal('and never in KV', kvOps(e.TMDB_CACHE), 0);

      resetCounters();
      const memoHit = await get(e);
      equal('a repeat in the same isolate is a HIT', memoHit.res.headers.get('x-cache'), 'HIT');
      equal('with no subrequest at all', subrequests(), 0);

      resetCounters();
      const e2 = newEnv();
      const edgeHit = await get(e2);
      equal('a fresh isolate in the same location is a HIT from the edge',
        edgeHit.res.headers.get('x-cache'), 'HIT');
      equal('with one cache read and nothing upstream', subrequests(), 1);

      // Age the edge copy past its 2h window, then hit it twice from a new isolate.
      const chartKey = [...cacheLayer.store.keys()].find((k) => k.includes('/__mz/ott-chart/netflix/IN'));
      const chartBody = await cacheLayer.store.get(chartKey).text();
      cacheLayer.store.set(chartKey, new Response(chartBody, {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-mz-stored': String(Date.now() - 3 * 3600 * 1000) }
      }));
      resetCounters();
      const e3 = newEnv();
      const staleChart = await get(e3);
      equal('a stale chart is served at once', staleChart.res.headers.get('x-cache'), 'STALE');
      equal('and rebuilt once behind the response', jwCalls, 2);
      check('the rebuilt copy replaced the stale one',
        Number(cacheLayer.store.get(chartKey).headers.get('x-mz-stored')) > Date.now() - 60000);

      const unknown = await worker.routeApi(new Request('https://moviezone.dev/api/ott/charts?platform=nope'),
        e3, makeCtx().ctx, new URL('https://moviezone.dev/api/ott/charts?platform=nope'));
      equal('an unknown platform is rejected, not proxied', unknown.status, 400);
      equal('none of it touched KV', kvOps(e2.TMDB_CACHE) + kvOps(e3.TMDB_CACHE), 0);
    }
  } finally {
    global.fetch = realFetch;
    delete global.caches;
  }

  /*  ── THE BATCH CAP AND THE CLIENT CHUNK MUST AGREE ──
   *
   *  handleTmdbBatch rejects a plan larger than MAX_BATCH_PATHS with a 400, and
   *  tmdbBatch's catch turns that into a silent fallback to individual requests -
   *  correct, but for an OTT provider-verification wave that means ~20 requests
   *  through the 8-lane gate instead of one POST: three sequential round trips on
   *  mobile, plus the 30-per-10s rate budget, plus a miss on the edge-assembled
   *  batch cache. Strictly worse than the batching it replaced, and the only
   *  symptom is a console.debug nobody reads.
   *
   *  _ottPrimeBatch slices at MZ_BATCH_CHUNK, so that constant is the one that has
   *  to stay within the cap. Read out of the source rather than imported, because
   *  moviezone.js is a browser script with no module boundary.
   */
  const clientSrc = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');
  const chunk = Number((clientSrc.match(/const MZ_BATCH_CHUNK\s*=\s*(\d+)/) || [])[1]);
  /*  Through pushLimits(), not a named export: the runtime refuses to load a
   *  Worker module whose named exports are plain numbers - see the note on
   *  pushLimits() in worker.js. */
  const cap = worker.pushLimits().MAX_BATCH_PATHS;

  check('the client batch chunk is declared as a named constant', Number.isFinite(chunk),
    'MZ_BATCH_CHUNK not found in moviezone.js - a hard-coded CHUNK cannot be '
      + 'checked against the Worker cap');
  check('the client batch chunk fits inside the Worker cap', chunk <= cap,
    'MZ_BATCH_CHUNK is ' + chunk + ' but MAX_BATCH_PATHS is ' + cap
      + ', so every full chunk would 400 and fall back to individual requests');
  check('_ottPrimeBatch slices on that constant, not a literal',
    /const CHUNK = MZ_BATCH_CHUNK;/.test(clientSrc),
    '_ottPrimeBatch has a hard-coded chunk size again, so it can drift from the cap');

  /*  The cap leaves headroom over the 16-path ALL feed. */
  check('the cap leaves headroom over the 16-path ALL feed', cap >= 20,
    'MAX_BATCH_PATHS is ' + cap + '; the ALL feed alone is 16 paths');

  /*  ── THE UPSTREAM TIMEOUT MUST STAY INSIDE THE CLIENT'S OWN BUDGET ──
   *
   *  tmdbUpstream makes TWO attempts of TMDB_TIMEOUT_MS with no backoff, so the
   *  Worker's own ceiling for /api/tmdb/* is 2x that value plus the cache lookups
   *  and the JSON assembly. The browser aborts its attempt at MZ_FETCH_TIMEOUT_MS.
   *  If the Worker's ceiling ever reaches the client's, the edge retry lands after
   *  the client has already hung up - and a client hanging up is exactly what
   *  Cloudflare records as a 499. The comment above MZ_FETCH_TIMEOUT_MS in
   *  moviezone.js documents the incident: a 9000ms client timeout produced 511 of
   *  those in five minutes.
   *
   *  envInt clamps TMDB_TIMEOUT_MS to 1000-20000, so the config alone can push the
   *  ceiling to 40s and nothing in the code would object. This is the check that
   *  objects. Read out of wrangler.jsonc, because that is where the override that
   *  can break it lives - the compiled default is only the fallback.
   */
  const wranglerSrc = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');
  const upstreamMs = Number((wranglerSrc.match(/"TMDB_TIMEOUT_MS"\s*:\s*"(\d+)"/) || [])[1]);
  const clientMs = Number((clientSrc.match(/const MZ_FETCH_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1]);

  check('both timeout values are declared where the guard can read them',
    Number.isFinite(upstreamMs) && Number.isFinite(clientMs),
    'TMDB_TIMEOUT_MS=' + upstreamMs + ' MZ_FETCH_TIMEOUT_MS=' + clientMs);

  check('two upstream attempts still fit inside one client attempt',
    upstreamMs * 2 < clientMs,
    'the Worker can take ' + (upstreamMs * 2) + 'ms but the browser aborts at '
      + clientMs + 'ms, so the edge retry lands after the client gave up (499s)');

  check('and with real slack left for the cache lookups and the JSON assembly',
    clientMs - upstreamMs * 2 >= 4000,
    'only ' + (clientMs - upstreamMs * 2) + 'ms of headroom between the Worker '
      + 'ceiling and the client abort');

  /*  ── NO KV ON THE TMDB PATH, BY CONSTRUCTION ──
   *  The behavioural checks above prove it for the paths they drive; this proves
   *  nothing else in worker.js can reach TMDB_CACHE except the SEO catalogue and
   *  sitemap shard reader (seoStore), which is data the nightly workflow uploads,
   *  not a TMDB cache. */
  const workerSrc = fs.readFileSync(WORKER_FILE, 'utf8');
  const tmdbCacheUses = (workerSrc.match(/env\.TMDB_CACHE/g) || []).length;
  check('worker.js touches TMDB_CACHE only through seoStore()', tmdbCacheUses === 1
    && /function seoStore\(env\)[\s\S]{0,200}env\.TMDB_CACHE/.test(workerSrc),
    tmdbCacheUses + ' references to env.TMDB_CACHE');
  check('no getWithMetadata() call is left in worker.js', !/getWithMetadata\(/.test(workerSrc));

  console.log('\n' + '='.repeat(78));
  console.log('  worker-perf-check: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) failures.forEach((f) => console.log('   x ' + f));
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('crashed:', e);
  process.exit(1);
});
