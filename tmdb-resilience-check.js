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
