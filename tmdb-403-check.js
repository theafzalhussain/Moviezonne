/* ═══════════════════════════════════════════════════════════════════════════
   tmdb-403-check.js — proves that an intermittent TMDB 403 is handled silently
   without giving up on a genuinely revoked token.

   The bug: 403 was classified with 401 as "the credential is dead". It is not.
   With an active key, TMDB still answers 403 for an endpoint the key cannot
   reach (some watch-provider and certification data) and its edge answers 403
   instead of 429 for a rejected burst — which the homepage's ~25-call fan-out
   can trigger. Every one of those was counted as a network failure and reported
   to Datadog RUM, so a working app produced a constant drip of noise.

   What must hold now:
     • a 403 on one endpoint is silent — no console.error, no DD_RUM.addError,
       and NOT counted in _mzFetchFailureCount (counting it can arm loadMovies'
       feed retry budget, which is what turned this into request storms)
     • cached data is served in preference to an empty rail
     • the refused URL is not asked for again for a short while
     • it is retried exactly once, because a throttled burst clears immediately
     • 403 spreading across unrelated endpoints IS reported, exactly once —
       that is a revoked token, not a per-endpoint gap
     • 401 and 5xx are untouched and still loud

   Rather than regex-matching the source, this loads the real fetch layer out of
   moviezone.js into an isolated sandbox with a stubbed fetch/localStorage and
   drives tmdb() for real, so it tests behaviour and not wording.

   Run: node tmdb-403-check.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const assert = require('assert');

// ── slice the fetch layer out of moviezone.js ───────────────────────────────
// From the request-budget constants through the end of tmdb(). Everything in
// that span is self-contained apart from the handful of globals injected below.
const SRC = fs.readFileSync('moviezone.js', 'utf8');
const START = 'const MZ_FETCH_TIMEOUT_MS';
const END = '// -- INIT -- Priority-based staggered loading';

const startAt = SRC.indexOf(START);
const endAt = SRC.indexOf(END);
assert.ok(startAt !== -1, 'anchor "' + START + '" not found — moviezone.js was restructured');
assert.ok(endAt > startAt, 'anchor "' + END + '" not found after the start anchor');
const LAYER = SRC.slice(startAt, endAt);

/*  A fresh sandbox per test case. Isolation matters here: the negative cache and
 *  the outage counter are module-level state, so sharing one instance would let
 *  case order decide the result.
 */
function loadSandbox() {
  const calls = [];            // every URL fetch() was asked for
  const responses = new Map(); // url substring -> { status } | () => { status }
  const reported = [];         // DD_RUM.addError payloads
  const logs = { error: 0, warn: 0, debug: 0 };
  const store = new Map();     // localStorage

  const fakeFetch = async (urlStr) => {
    calls.push(urlStr);
    let plan = null;
    for (const [needle, value] of responses) {
      if (urlStr.includes(needle)) { plan = value; break; }
    }
    const spec = (typeof plan === 'function' ? plan(calls.length) : plan) || { status: 200, body: { results: [{ id: 1 }] } };
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      headers: { get: () => null },
      json: async () => spec.body || { results: [] }
    };
  };

  const win = {
    DD_RUM: { addError: (err, meta) => reported.push({ err, meta }) },
    addEventListener: () => {}
  };

  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };

  const shim = {
    debug: (...a) => { logs.debug++; },
    warn: (...a) => { logs.warn++; },
    error: (...a) => { logs.error++; },
    log: () => {}
  };

  /*  new Function rather than vm: the layer only needs these names shadowed, and
   *  staying in this realm keeps Promise/AbortController identity intact.
   */
  const factory = new Function(
    'window', 'navigator', 'localStorage', 'fetch', 'console',
    'BASE', 'tmdbCache', 'inFlightRequests', 'abortControllers',
    '_mzQueueCacheWrite', 'watchlist', 'renderContinueWatching',
    LAYER + `
    ;return {
      tmdb,
      failures: () => _mzFetchFailureCount,
      families: () => Array.from(_mzForbiddenFamilies.keys()),
      endpointFamily: _mzEndpointFamily,
      shouldRetryStatus: _mzShouldRetryStatus,
      isForbiddenStatus: _mzIsForbiddenStatus,
      isKnownForbidden: _mzIsKnownForbidden
    };`
  );

  const api = factory(
    win,
    { onLine: true },
    localStorage,
    fakeFetch,
    shim,
    'https://api.test/api/tmdb',
    new Map(),
    new Map(),
    new Map(),
    () => {},              // _mzQueueCacheWrite — writes are not under test
    [],                    // watchlist
    () => {}
  );

  return Object.assign(api, { calls, responses, reported, logs, store, win });
}

// ── runner ─────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const cases = [];
function test(label, fn) { cases.push({ label, fn }); }

// A stale (older than the 12h freshness window) SWR entry for a URL.
function seedStale(box, urlStr, data) {
  box.store.set('mz_cache_' + urlStr, JSON.stringify({
    data,
    timestamp: Date.now() - 24 * 60 * 60 * 1000
  }));
}

const U = (endpoint, qs) => 'https://api.test/api/tmdb' + endpoint + (qs || '');

// ═══ pure classification ═══════════════════════════════════════════════════

test('403 is classified as forbidden, not as a dead credential', () => {
  const box = loadSandbox();
  assert.strictEqual(box.isForbiddenStatus(403), true);
  assert.strictEqual(box.isForbiddenStatus(401), false, '401 must stay in the loud path');
  assert.strictEqual(box.isForbiddenStatus(404), false);
});

test('403 is retried once and only once', () => {
  const box = loadSandbox();
  assert.strictEqual(box.shouldRetryStatus(403, 0), true, 'a throttled burst clears immediately — one retry is worth it');
  assert.strictEqual(box.shouldRetryStatus(403, 1), false, 'a permission gap will never clear, so do not spend the budget');
  assert.strictEqual(box.shouldRetryStatus(500, 1), true, '5xx retry behaviour must be unchanged');
  assert.strictEqual(box.shouldRetryStatus(404, 0), false, '404 must not become retryable');
});

test('endpoint families collapse ids so one dead endpoint is not mistaken for many', () => {
  const box = loadSandbox();
  assert.strictEqual(box.endpointFamily('/movie/550/watch/providers'), box.endpointFamily('/movie/680/watch/providers'));
  assert.notStrictEqual(box.endpointFamily('/movie/550'), box.endpointFamily('/tv/1399'));
  assert.notStrictEqual(box.endpointFamily('/discover/movie'), box.endpointFamily('/trending/all/week'));
});

// ═══ the silent path ═══════════════════════════════════════════════════════

test('a 403 on one endpoint is completely silent', async () => {
  const box = loadSandbox();
  box.responses.set('/movie/550/watch/providers', { status: 403 });

  const res = await box.tmdb('/movie/550/watch/providers');

  assert.deepStrictEqual(res.results, [], 'callers spread r.results — it must be an empty array');
  assert.strictEqual(res._mzMissing, true, 'the result should carry the missing marker for direct callers');
  assert.strictEqual(box.reported.length, 0, 'a single-endpoint 403 was reported to Datadog RUM');
  assert.strictEqual(box.logs.error, 0, 'console.error is collected by RUM too — it must not be used here');
  assert.strictEqual(box.logs.warn, 0, 'even a warn line per request is a drip; this case is debug-only');
  assert.strictEqual(box.failures(), 0,
    'counting a 403 as a network failure is what lets one refused endpoint arm the feed retry budget');
});

test('a 403 costs exactly two attempts', async () => {
  const box = loadSandbox();
  box.responses.set('/movie/550', { status: 403 });

  await box.tmdb('/movie/550');

  assert.strictEqual(box.calls.length, 2,
    'expected the initial attempt plus one retry, got ' + box.calls.length + ' attempts');
});

test('a 403 that clears on the retry returns real data', async () => {
  const box = loadSandbox();
  // Refused first, fine on the retry — exactly what edge throttling looks like.
  box.responses.set('/discover/movie', (n) => (n === 1 ? { status: 403 } : { status: 200, body: { results: [{ id: 42 }] } }));

  const res = await box.tmdb('/discover/movie');

  assert.strictEqual(res.results[0].id, 42, 'the retry succeeded but its data was thrown away');
  assert.strictEqual(box.reported.length, 0);
  assert.strictEqual(box.failures(), 0);
});

test('a refused URL is not asked for again', async () => {
  const box = loadSandbox();
  box.responses.set('/tv/1399/season/9', { status: 403 });

  await box.tmdb('/tv/1399/season/9');
  const afterFirst = box.calls.length;
  assert.strictEqual(box.isKnownForbidden(U('/tv/1399/season/9')), true, 'the refused URL was not remembered');

  const second = await box.tmdb('/tv/1399/season/9');

  assert.strictEqual(box.calls.length, afterFirst,
    'the same refused URL was requested again — six rails sharing it would each pay a request');
  assert.deepStrictEqual(second.results, []);
  assert.strictEqual(box.reported.length, 0);
});

test('cached data wins over an empty rail on 403', async () => {
  const box = loadSandbox();
  const url = U('/movie/popular', '?page=1');
  seedStale(box, url, { results: [{ id: 99, title: 'From cache' }] });
  box.responses.set('/movie/popular', { status: 403 });

  const res = await box.tmdb('/movie/popular', { page: 1 });
  assert.strictEqual(res.results[0].id, 99, 'stale cache should be served instead of an empty list');

  // Let the background refresh land and confirm it stayed quiet.
  await new Promise(r => setTimeout(r, 1200));
  assert.strictEqual(box.reported.length, 0, 'the background 403 was reported');
  assert.strictEqual(box.logs.error, 0);

  // And the second call is served from cache without another refused request.
  const before = box.calls.length;
  const again = await box.tmdb('/movie/popular', { page: 1 });
  assert.strictEqual(again.results[0].id, 99);
  assert.strictEqual(box.calls.length, before, 'a second refused request went out');
});

// ═══ a revoked token is still visible ══════════════════════════════════════

test('403 spreading across unrelated endpoints is reported exactly once', async () => {
  const box = loadSandbox();
  for (const ep of ['/movie/550', '/tv/1399', '/discover/movie', '/trending/all/week', '/genre/movie/list', '/person/287']) {
    box.responses.set(ep, { status: 403 });
  }

  for (const ep of ['/movie/550', '/tv/1399', '/discover/movie', '/trending/all/week', '/genre/movie/list', '/person/287']) {
    await box.tmdb(ep);
  }

  assert.strictEqual(box.reported.length, 1,
    'a revoked token must be reported once — got ' + box.reported.length + ' reports');
  const meta = box.reported[0].meta;
  assert.strictEqual(meta.status, 403);
  assert.strictEqual(meta.reason, 'tmdb_token_forbidden_across_endpoints');
  assert.ok(meta.families && meta.families.split(',').length >= 4,
    'the report should name the endpoint families involved, for triage');
  assert.strictEqual(meta.source === undefined || meta.source === 'tmdb', true);
});

test('one dead endpoint hit many times never looks like an outage', async () => {
  const box = loadSandbox();
  box.responses.set('/watch/providers', { status: 403 });

  // Same family, different ids — the pattern a stale watchlist produces.
  for (const id of [550, 680, 13, 27205, 155, 496243, 238]) {
    await box.tmdb('/movie/' + id + '/watch/providers');
  }

  assert.strictEqual(box.reported.length, 0,
    'ids were not collapsed, so one refused endpoint was misread as a credential outage');
  assert.strictEqual(box.families().length, 1, 'expected a single endpoint family, got ' + box.families().join(','));
});

// ═══ nothing else moved ════════════════════════════════════════════════════

test('401 is still loud', async () => {
  const box = loadSandbox();
  box.responses.set('/movie/550', { status: 401 });

  await box.tmdb('/movie/550');

  assert.strictEqual(box.reported.length, 1, '401 means the token is gone and must be reported immediately');
  assert.strictEqual(box.reported[0].meta.status, 401);
  assert.strictEqual(box.failures(), 1, '401 must still count as a failure');
  assert.strictEqual(box.calls.length, 1, '401 must not be retried');
});

test('5xx is still retried to the full budget and reported', async () => {
  const box = loadSandbox();
  box.responses.set('/movie/top_rated', { status: 503 });

  await box.tmdb('/movie/top_rated');

  assert.strictEqual(box.calls.length, 3, 'expected 3 attempts (MZ_FETCH_MAX_RETRIES = 2), got ' + box.calls.length);
  assert.strictEqual(box.reported.length, 1, 'a persistent 5xx is a real outage and must be reported');
  assert.strictEqual(box.failures(), 1);
});

test('404 stays silent and keeps its own longer negative cache', async () => {
  const box = loadSandbox();
  box.responses.set('/movie/999999999', { status: 404 });

  const res = await box.tmdb('/movie/999999999');

  assert.strictEqual(res._mzMissing, true);
  assert.strictEqual(box.reported.length, 0);
  assert.strictEqual(box.failures(), 0);
  assert.strictEqual(box.calls.length, 1, '404 must not be retried');
  assert.strictEqual(box.isKnownForbidden(U('/movie/999999999')), false,
    'a 404 must not land in the 403 cache — their TTLs differ on purpose');
});

// ── server-side log volume ─────────────────────────────────────────────────

test('the proxy does not log an error line per upstream 403', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const code = server.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  assert.ok(/upstreamStatus === 403/.test(code), 'the proxy still treats 403 like any other upstream error');
  assert.ok(/shouldLogForbidden\(endpoint\)/.test(code), '403 logging is not throttled per endpoint family');
  const block = code.slice(code.indexOf('if (upstreamStatus === 403)'), code.indexOf('const stale = staleCache.get(url)'));
  assert.ok(!/console\.error/.test(block), 'a refused endpoint still buries genuine 5xx at error level');
  assert.ok(/const stale = staleCache\.get\(url\)/.test(code), 'the stale fallback must still run for a 403');
});

test('the upstream client still refuses to retry a 403', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const cond = server.slice(server.indexOf('retryCondition:'), server.indexOf('onRetry:'));
  assert.ok(!/403/.test(cond), 'retrying 403 six times upstream would turn edge throttling into a hammer');
});

// ── go ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n══ TMDB 403 handling ' + '═'.repeat(45));
  for (const c of cases) {
    try {
      await c.fn();
      pass++;
      console.log('  PASS  ' + c.label);
    } catch (e) {
      fail++;
      console.log('  FAIL  ' + c.label + '\n          ' + e.message);
    }
  }
  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
