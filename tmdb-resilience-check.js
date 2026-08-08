/* ═══════════════════════════════════════════════════════════════════════════
   tmdb-resilience-check.js — guards the fix for the error Datadog RUM was
   reporting 91 times a day:

       TypeError: Failed to fetch
         at tmdb()       moviezone.min.js:1:18405
         at loadMovies() moviezone.min.js:1:76130

   The error itself was a symptom. The cause was that loadMovies() rescheduled
   itself every 3 seconds, forever, whenever it ended up with an empty list —
   and it could not tell a network failure from a genuinely empty category, so
   both looped. Each pass fans out to up to 15 parallel tmdb() calls, each one
   logging console.error, which is what RUM collects. One user on a dead
   connection produced hundreds of reported errors per minute.

   Two halves:
     • static guards — the infinite loop must not come back, and the pieces that
       replaced it must all still be present
     • a real browser run — breaks fetch() for /api/tmdb only, drives a category
       load, and measures that the app goes quiet, shows an actionable error,
       reports through DD_RUM.addError instead of console.error, and recovers on
       a manual retry

   Skips loudly — never a false pass — when no browser binary is installed.

   Run: node tmdb-resilience-check.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS = 'tmdb-resilience.browser.test.html';
const RESULT_TIMEOUT_MS = 150000;
const APP_PORT = Number(process.env.MZ_CWV_PAGE_PORT) || 3001;

let pass = 0;
let fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log('  PASS  ' + label); }
  catch (e) { fail++; console.log('  FAIL  ' + label + '\n          ' + e.message); }
}

// ── static guards ──────────────────────────────────────────────────────────
const js = fs.readFileSync('moviezone.js', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

console.log('\n-- the infinite retry loop stays gone ' + '-'.repeat(24));

check('loadMovies does not reschedule itself on a flat timer', () => {
  assert.ok(!/setTimeout\(\(\)\s*=>\s*loadMovies\(cat\),\s*3000\)/.test(jsCode),
    'the unbounded 3s self-retry is back; one bad connection becomes ~300 requests/min');
});

check('feed retries are counted against a budget', () => {
  assert.ok(/MZ_FEED_MAX_RETRIES/.test(jsCode), 'no retry ceiling');
  assert.ok(/_mzFeedRetryState\(cat\)/.test(jsCode), 'no per-category attempt tracking');
  assert.ok(/state\.attempts >= MZ_FEED_MAX_RETRIES/.test(jsCode),
    'the budget is never actually checked');
});

check('backoff grows instead of hammering at a fixed interval', () => {
  assert.ok(/MZ_FEED_RETRY_BASE_MS \* Math\.pow\(2, state\.attempts - 1\)/.test(jsCode),
    'feed retry delay is not exponential');
});

check('a network failure is told apart from an empty category', () => {
  assert.ok(/_mzFetchFailureCount > _mzFeedFailureMark/.test(jsCode),
    'loadMovies cannot distinguish the two, so an honest empty result would retry forever');
  assert.ok(/renderFeedEmpty\(cat\)/.test(jsCode), 'no terminal state for an honestly empty feed');
});

check('the user gets an action once the budget is spent', () => {
  assert.ok(/renderFeedError\(cat\)/.test(jsCode), 'no terminal error state');
  assert.ok(/mzFeedRetryBtn/.test(jsCode), 'no manual retry control');
  assert.ok(!/<h3>Loading movies\.\.\.<\/h3>/.test(jsCode),
    'the permanent "Loading movies..." lie is back');
});

console.log('\n-- request-level resilience ' + '-'.repeat(34));

check('requests retry transient failures with jitter', () => {
  assert.ok(/_mzFetchWithRetry/.test(jsCode), 'no request-level retry');
  assert.ok(/MZ_FETCH_MAX_RETRIES/.test(jsCode), 'no per-request retry ceiling');
  assert.ok(/Math\.random\(\) \* 250/.test(jsCode),
    'no jitter — 15 parallel requests would retry in the same millisecond and collide again');
});

check('only healable statuses are retried', () => {
  assert.ok(/_mzIsTransientStatus/.test(jsCode), 'retry decision is not status-aware');
  const fn = jsCode.slice(jsCode.indexOf('function _mzIsTransientStatus'), jsCode.indexOf('function _mzIsBenignFailure'));
  assert.ok(/429/.test(fn) && /status >= 500/.test(fn), '429/5xx are not treated as transient');
});

check('429 honours Retry-After', () => {
  assert.ok(/headers\.get\('Retry-After'\)/.test(jsCode),
    'the server tells us how long to wait and we ignore it');
});

check('every attempt has a hard timeout', () => {
  assert.ok(/MZ_FETCH_TIMEOUT_MS/.test(jsCode), 'no request timeout');
  assert.ok(/timedOut = true; attemptController\.abort\(\)/.test(jsCode),
    'the timeout does not actually abort the attempt');
});

check('a fresh AbortController is used per attempt', () => {
  assert.ok(/const attemptController = new AbortController\(\)/.test(jsCode),
    'reusing the outer controller would make attempt 2 abort instantly, since an AbortController is single-use');
});

console.log('\n-- error reporting is signal, not noise ' + '-'.repeat(22));

check('teardown and offline failures are not reported as errors', () => {
  assert.ok(/_mzIsBenignFailure/.test(jsCode), 'no failure classification');
  assert.ok(/_mzPageHiding/.test(jsCode),
    'requests cancelled by navigation reject with exactly this TypeError and would still be reported');
  assert.ok(/addEventListener\('pagehide', \(\) => \{ _mzPageHiding = true; \}\)/.test(jsCode),
    'the unload flag is never set');
});

check('real failures go to Datadog with context', () => {
  assert.ok(/DD_RUM\.addError/.test(jsCode), 'failures are not reported to RUM');
  const fn = jsCode.slice(jsCode.indexOf('function _mzReportFetchError'), jsCode.indexOf('async function _mzFetchAttempt'));
  assert.ok(/console\.warn/.test(fn) && !/console\.error/.test(fn),
    'console.error is collected by RUM too, so using it here double-reports every failure');
});

check("tmdb() no longer calls console.error at all", () => {
  assert.ok(!/console\.error\('Network\/Fetch Error:'/.test(jsCode),
    'the bare console.error is back — this is the line RUM was counting 91 times a day');
});

check('a failed response is distinguishable by callers', () => {
  assert.ok(/_mzFailed/.test(jsCode), 'the empty fallback is indistinguishable from a real empty result');
  assert.ok(/enumerable: false/.test(jsCode),
    'the marker must not be enumerable or it leaks into the cached JSON');
});

check('stale cache is preferred over an empty list', () => {
  assert.ok(/if \(cachedData\) return cachedData;/.test(jsCode),
    'a failed refresh throws away usable stale data and blanks the rail');
});

console.log('\n-- the carousel recovers too ' + '-'.repeat(33));

check('an empty carousel pool retries, bounded', () => {
  assert.ok(/MZ_CAROUSEL_MAX_RETRIES/.test(jsCode), 'no carousel retry ceiling');
  assert.ok(/_mzFetchFailureCount > _mzCarouselFailureMark/.test(jsCode),
    'the carousel cannot tell a network failure from an honestly empty pool');
});

check('offline waits for the connection instead of burning attempts', () => {
  assert.ok(/_mzWhenOnline/.test(jsCode), 'no online listener');
  assert.ok(/addEventListener\('online', run, \{ once: true \}\)/.test(jsCode),
    'the online handler is not one-shot');
});

console.log('\n-- 404s and impossible ids are not faults ' + '-'.repeat(20));

check('404/410 are classified as missing, not as failures', () => {
  assert.ok(/_mzIsMissingStatus/.test(jsCode), 'no missing-resource classification');
  const fn = jsCode.slice(jsCode.indexOf('function _mzIsMissingStatus'), jsCode.indexOf('const _mzMissingUrls'));
  assert.ok(/status === 404/.test(fn) && /status === 410/.test(fn), '404/410 not covered');
});

check('a 404 is neither counted nor reported', () => {
  const idx = jsCode.indexOf('const missing = e && e.name');
  assert.ok(idx !== -1, 'tmdb() catch has no missing-resource branch');
  const branch = jsCode.slice(idx, idx + 700);
  assert.ok(/if \(missing\)/.test(branch), 'the missing branch is never taken');
  assert.ok(/_mzRememberMissing\(urlStr\)/.test(branch), 'a confirmed 404 is not remembered');
  // The missing branch has to return BEFORE the reporting branch, or a 404 still
  // increments the failure counter and still reaches Datadog.
  assert.ok(branch.indexOf('return cachedData || _mzMissingResult()') <
            branch.indexOf('_mzFetchFailureCount++'),
    'the missing branch does not return before the failure-reporting branch');
});

check('401/403 stay loud — an expired token must be visible', () => {
  const fn = jsCode.slice(jsCode.indexOf('function _mzIsMissingStatus'), jsCode.indexOf('const _mzMissingUrls'));
  assert.ok(!/401|403/.test(fn),
    'auth failures are being swallowed as "missing"; a dead TMDB token would look like an empty catalogue');
});

check('impossible ids are rejected before a request is built', () => {
  assert.ok(/_mzInvalidIdSegment/.test(jsCode), 'no id validation');
  const fn = jsCode.slice(jsCode.indexOf('function _mzInvalidIdSegment'), jsCode.indexOf('async function tmdb'));
  ["'undefined'", "'null'", "'NaN'"].forEach((lit) => {
    assert.ok(fn.includes(lit), 'id validation does not catch ' + lit);
  });
  assert.ok(/Number\(seg\) <= 0/.test(fn), 'non-positive numeric ids are not rejected');
  assert.ok(/season/.test(jsCode), 'sanity: season endpoints exist');
  // The check must run before the URL is assembled, otherwise a request still goes out.
  const t = jsCode.indexOf('async function tmdb');
  const body = jsCode.slice(t, t + 900);
  assert.ok(body.indexOf('_mzInvalidIdSegment(endpoint)') < body.indexOf('const urlStr = BASE'),
    'id validation runs after the URL is built');
});

check('a known-missing URL is not requested twice', () => {
  assert.ok(/_mzIsKnownMissing\(urlStr\)/.test(jsCode), 'no negative cache lookup');
  assert.ok(/MZ_MISSING_TTL_MS/.test(jsCode), 'the negative cache never expires');
});

check('a dead title is pruned from the persisted lists', () => {
  assert.ok(/function _mzForgetDeadTitle/.test(jsCode), 'no pruning helper');
  const fn = jsCode.slice(jsCode.indexOf('function _mzForgetDeadTitle'), jsCode.indexOf('function _mzInvalidIdSegment'));
  assert.ok(/mz_continue_watching/.test(fn), 'Continue Watching is not pruned');
  assert.ok(/mz_watchlist/.test(fn), 'the watchlist is not pruned');
});

check('an opened title that no longer exists closes cleanly', () => {
  assert.ok(/details && details\._mzMissing/.test(jsCode),
    'openModal does not detect a missing title, so it would sit on "Loading..." forever');
  assert.ok(/This title is no longer available/.test(jsCode),
    'the user gets no explanation for a dead tap');
});

console.log('\n-- API shape and version ' + '-'.repeat(37));

check('the client targets TMDB v3 paths through the same-origin proxy', () => {
  assert.ok(/const LIVE_BACKEND_URL = '\/api\/tmdb'/.test(jsCode),
    'the API base is not the same-origin proxy');
  assert.ok(!/api_key=/.test(jsCode),
    'an api_key is being put in a query string; auth belongs in the Authorization header');
  assert.ok(!/api\.themoviedb\.org/.test(jsCode),
    'the client is calling TMDB directly, which would expose the token');
});

check('the server proxies to v3 with a v4 bearer token', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.ok(/const buildBaseUrl = \(host\) => `https:\/\/\$\{host\}\/3`/.test(server),
    'the upstream base URL is not TMDB v3');
  assert.ok(/Authorization.*Bearer \$\{TMDB_TOKEN\}/.test(server),
    'no v4 bearer token; v3 paths with a v4 read token is the supported combination');
  assert.ok(!/api_key=\$\{/.test(server), 'the legacy api_key query param is back');
});

console.log('\n-- cut connections (499) and rate limiting ' + '-'.repeat(19));

check('499 is treated as a cut connection, not a plain 4xx', () => {
  const fn = jsCode.slice(jsCode.indexOf('function _mzIsTransientStatus'),
                          jsCode.indexOf('function _mzIsSelfInflictedStatus'));
  assert.ok(/status === 499/.test(fn),
    '499 is not retryable again. It means the connection was cut, which heals on retry; as a plain 4xx it failed instantly and was reported as an error 511 times in five minutes.');
});

check('a connection we cut ourselves is not reported as an error', () => {
  assert.ok(/_mzIsSelfInflictedStatus/.test(jsCode), 'no self-inflicted classification');
  const fn = jsCode.slice(jsCode.indexOf('function _mzIsSelfInflictedStatus'),
                          jsCode.indexOf('const _mzMissingUrls'));
  assert.ok(/status === 499/.test(fn), '499 is still reported');
  const benign = jsCode.slice(jsCode.indexOf('function _mzIsBenignFailure'),
                              jsCode.indexOf('function _mzMissingResult'));
  assert.ok(/_mzIsSelfInflictedStatus\(err\.status\)/.test(benign),
    'the benign check does not consult the self-inflicted list');
});

check('the client timeout is not shorter than the origin budget', () => {
  const m = /const MZ_FETCH_TIMEOUT_MS = (\d+);/.exec(jsCode);
  assert.ok(m, 'MZ_FETCH_TIMEOUT_MS not found');
  const server = fs.readFileSync('server.js', 'utf8');
  const st = /timeout: (\d+),/.exec(server.slice(server.indexOf('const tmdbClient = axios.create')));
  const clientMs = Number(m[1]);
  const serverMs = st ? Number(st[1]) : 15000;
  assert.ok(clientMs >= serverMs,
    'client aborts at ' + clientMs + 'ms while the origin allows itself ' + serverMs +
    'ms per upstream attempt (plus axiosRetry with shouldResetTimeout). A shorter client budget guarantees we cut the connection mid-flight, and that is exactly what produces a 499.');
});

check("TMDB's rate limit is respected, not just concurrency", () => {
  assert.ok(/MZ_RATE_LIMIT/.test(jsCode), 'no rate limiter — concurrency caps in-flight requests, not requests over time');
  const lim = Number((/const MZ_RATE_LIMIT = (\d+);/.exec(jsCode) || [])[1]);
  const win = Number((/const MZ_RATE_WINDOW_MS = (\d+);/.exec(jsCode) || [])[1]);
  assert.ok(lim > 0 && win > 0, 'rate limiter constants missing');
  // TMDB allows ~40 per 10s per key; stay under it and leave room for the server.
  assert.ok(lim / (win / 10000) <= 40,
    'client budget is ' + lim + ' per ' + (win / 1000) + 's, which exceeds TMDB\'s ~40/10s');
  assert.ok(/_mzRateDelayMs\(\)/.test(jsCode), 'the rate budget is never actually waited on');
});

check('concurrency stays at or below 4 lanes', () => {
  const n = Number((/const MZ_MAX_CONCURRENT_FETCHES = (\d+);/.exec(jsCode) || [])[1]);
  assert.ok(n > 0 && n <= 4, 'concurrency is ' + n + '; the origin holds only 12 upstream sockets, shared across all visitors');
});

check('the rate wait happens before a concurrency lane is taken', () => {
  const fn = jsCode.slice(jsCode.indexOf('async function _mzAcquireSlot'),
                          jsCode.indexOf('function _mzReleaseSlot'));
  assert.ok(fn.indexOf('_mzRateDelayMs()') < fn.indexOf('_mzActiveFetches++'),
    'a lane is taken and then slept in, which throttles the other lanes for no reason');
});

console.log('\n-- renderer detection is a hint, not an accusation ' + '-'.repeat(11));

check('software renderers are no longer reported as bots', () => {
  assert.ok(!/Potential Bot\/Headless Browser Detected/.test(jsCode),
    'the console.error is back. It blocked nothing (no listener existed), Datadog collects console.error, and swiftshader/mesa/llvmpipe are software renderers used by real people on VMs, remote desktops and GPU-blocklisted drivers.');
  assert.ok(!/'bot-detected'/.test(jsCode), 'the bot-detected event name is back');
  assert.ok(/mz:software-renderer/.test(jsCode), 'the renderer hint is gone entirely');
  assert.ok(/!isLocalhost && softwareRenderers/.test(jsCode),
    'the check still runs on localhost, so the repo\'s own headless suites keep tripping it');
});

console.log('\n-- the caching stack, layer by layer ' + '-'.repeat(25));

/*  Five independent layers keep TMDB off the critical path. Each one is invisible
 *  when it works, so each gets a guard — losing any of them silently would show up
 *  only as a slow site under load, which is the hardest kind of regression to
 *  attribute.
 */
check('L1 client memory cache dedupes within a page view', () => {
  assert.ok(/tmdbCache\.has\(urlStr\)/.test(jsCode), 'no in-memory cache lookup');
  assert.ok(/inFlightRequests\.has\(urlStr\)/.test(jsCode),
    'no in-flight coalescing: two callers asking for the same URL in the same tick would each send a request');
});

check('L2 client SWR cache survives reloads', () => {
  assert.ok(/mz_cache_/.test(jsCode), 'no localStorage cache');
  assert.ok(/12 \* 60 \* 60 \* 1000/.test(jsCode), 'the 12h freshness window is gone');
  assert.ok(/_mzQueueCacheWrite/.test(jsCode), 'cache writes are no longer deferred off the render path');
});

check('L3 service worker caches the shell and TMDB images', () => {
  assert.ok(/IMAGE_CACHE/.test(sw), 'no TMDB image cache');
  assert.ok(/isVersionedAsset/.test(sw), 'versioned assets are not cache-first');
  assert.ok(/key !== IMAGE_CACHE/.test(sw), 'the image cache is wiped on every shell bump');
});

check('L4 origin caches TMDB responses and coalesces upstream calls', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.ok(/new NodeCache\(\{ stdTTL: \d+ \}\)/.test(server), 'no server-side response cache');
  assert.ok(/function fetchTmdbOnce/.test(server),
    'no upstream coalescing: N concurrent users asking for the same URL would each hit TMDB');
  assert.ok(/staleCache/.test(server), 'no stale copy to serve when TMDB is down');
});

check('L5 the CDN caches API responses for everyone', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.ok(/s-maxage=86400/.test(server),
    'no s-maxage on API responses. This is the layer that actually helps at 100 concurrent users: without it every serverless instance re-fetches, because in-memory cache is per-instance.');
  assert.ok(/stale-while-revalidate=86400/.test(server), 'no stale-while-revalidate for the CDN');
});

check('immutable headers cover every versioned asset type', () => {
  const netlify = fs.readFileSync('netlify.toml', 'utf8');
  const vercel = fs.readFileSync('vercel.json', 'utf8');
  ['/*.min.js', '/*.min.css', '/fonts/*', '/*.webp', '/*.png'].forEach((t) => {
    assert.ok(netlify.includes('for = "' + t + '"'), 'netlify.toml does not cache ' + t);
  });
  assert.ok(/webp\|png\|svg/.test(vercel), 'vercel.json does not cache versioned images');
  // The two files that must NEVER be immutable, or a deploy can never reach anyone.
  assert.ok(/for = "\/sw\.js"[\s\S]{0,200}no-cache/.test(netlify), 'sw.js is not no-cache');
  assert.ok(/for = "\/index\.html"[\s\S]{0,200}max-age=0/.test(netlify), 'index.html is not revalidated');
});

check('the first paint renders a small batch, not the whole page', () => {
  assert.ok(/FIRST_PAINT_CARDS/.test(jsCode), 'the first render is not capped');
  const n = Number((/const FIRST_PAINT_CARDS = (\d+);/.exec(jsCode) || [])[1]);
  assert.ok(n > 0 && n <= 10, 'first paint renders ' + n + ' cards');
  assert.ok(/requestIdleCallback\(paintTail/.test(jsCode),
    'the remaining cards are not deferred to idle, so the whole batch still lands during load');
});

// ── browser run ────────────────────────────────────────────────────────────
const BROWSER_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

function findBrowser() {
  for (const c of BROWSER_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function finishUp() {
  console.log('\n' + '='.repeat(62));
  console.log('  tmdb-resilience-check: ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(62) + '\n');
  process.exit(fail ? 1 : 0);
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('\nSKIPPED the browser half: no Chrome/Edge binary found.');
    return finishUp();
  }

  let deliver = null;
  const collector = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(204).end();
      try { if (deliver) deliver(JSON.parse(body)); } catch (e) { if (deliver) deliver(null); }
    });
  });
  await new Promise((r) => collector.listen(0, '127.0.0.1', r));
  const collectorPort = collector.address().port;

  // moviezone.js hard-codes localhost:3001 as its dev API base, so the page has
  // to be served from there. Reuse a dev server if one is already up.
  let ownServer = null;
  if (await portInUse(APP_PORT)) {
    console.log('\nReusing the dev server already listening on ' + APP_PORT + '.');
  } else {
    const app = require('./server');
    ownServer = await new Promise((resolve, reject) => {
      const s = app.listen(APP_PORT, () => resolve(s));
      s.on('error', reject);
    }).catch((err) => {
      console.error('FAILED: could not serve the page on ' + APP_PORT + ': ' + err.message);
      process.exit(1);
    });
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzres-'));
  let child = null;

  console.log('\n-- measured against a broken network, real browser ' + '-'.repeat(11));
  console.log('   (injects TypeError: Failed to fetch on /api/tmdb, then waits ~45s)');

  const results = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(
      'the harness did not report within ' + (RESULT_TIMEOUT_MS / 1000) + 's')), RESULT_TIMEOUT_MS);
    let settled = false;
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) { try { child.kill(); } catch (e) {} }
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
      if (err) reject(err); else resolve(value);
    }
    deliver = (body) => {
      if (!Array.isArray(body) || !body.length) return finish(new Error('the harness reported no checks'));
      finish(null, body);
    };
    child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-extensions', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--window-size=460,1000',
      '--user-data-dir=' + profileDir,
      'http://localhost:' + APP_PORT + '/' + HARNESS + '?collector=' + collectorPort
    ], { stdio: 'ignore' });
    child.on('error', (err) => finish(new Error('could not launch the browser: ' + err.message)));
  }).catch((err) => {
    console.error('  FAIL  browser run: ' + err.message);
    fail++;
    collector.close();
    if (ownServer) ownServer.close();
    finishUp();
  });

  collector.close();
  if (ownServer) ownServer.close();

  (results || []).forEach((c) => {
    if (c.pass) { pass++; console.log('  PASS  ' + c.name + (c.detail ? '\n          ' + c.detail : '')); }
    else { fail++; console.log('  FAIL  ' + c.name + (c.detail ? '\n          ' + c.detail : '')); }
  });

  finishUp();
}

main().catch((err) => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
