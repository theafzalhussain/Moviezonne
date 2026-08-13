'use strict';
/*  Reads the LIVE site and reports which of the changes are actually deployed.
 *  Local tests prove the code is correct; only this proves users are getting it.
 *  Run: node deploy-verify-check.js [origin]
 */
const https = require('https');

const HOST = (process.argv[2] || 'moviezone.dev').replace(/^https?:\/\//, '').replace(/\/$/, '');

function get(path) {
  return new Promise((resolve, reject) => {
    https.get({
      host: HOST,
      path: path,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0', 'Cache-Control': 'no-cache' }
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const loc = r.headers.location.replace(/^https?:\/\/[^/]+/, '');
        return get(loc).then(resolve, reject);
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

/*  The bundle versions are read out of the local index.html rather than written
 *  in here. Pinned literals (they said v7.6 and v5.5) turn this check into a
 *  countdown: it passes until the next cache-bust and then reports "not
 *  deployed" on a deploy that is perfectly fine, which is worse than not
 *  checking at all — 33/2 trains you to ignore the summary line.
 *
 *  Derived from the build, the assertion also gets sharper: it now fails when
 *  the live HTML serves a DIFFERENT version from the one this checkout builds,
 *  which is the actual thing worth catching — a CDN still handing out the
 *  previous bundle. Missing tags are covered separately by asset-perf-check.
 */
const localIndexHtml = require('fs').readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
function builtVersionOf(asset) {
  const m = new RegExp(asset.replace(/\./g, '\\.') + '\\?v=([\\d.]+)').exec(localIndexHtml);
  if (!m) {
    console.error('FAILED: ' + asset + ' has no ?v= tag in the local index.html');
    process.exit(1);
  }
  return m[1];
}
const JS_VERSION = builtVersionOf('moviezone.min.js');
const CSS_VERSION = builtVersionOf('moviezone.min.css');

// [label, regex, expectedPresent]
const HTML_MARKS = [
  ['self-hosted fonts preloaded',        /<link rel="preload" href="\/fonts\/outfit-latin-var\.woff2"/, true],
  ['Google Fonts request removed',       /fonts\.googleapis\.com/, false],
  ['nested duplicate <head> removed',    /<head>\s*<head>/, false],
  ['Datadog RUM is async (onReady)',     /DD_RUM\.onReady/, true],
  ['no parser-blocking datadog script',  /<script src="https:\/\/www\.datadoghq-browser-agent\.com/, false],
  ['CLS reservation block present',      /mz-cwv-critical/, true],
  ['#main-content flow-root fix',        /#main-content\{display:flow-root\}/, true],
  ['Continue Watching pre-paint reveal', /html\.mz-has-cw #continue-watching\{display:block\}/, true],
  ['CW inline display:none removed',     /id="continue-watching"[^>]*style="display:none/, false],
  ['hero LCP hint reader',               /localStorage\.getItem\('mz_hero_lcp'\)/, true],
  ['pwa-install off critical path',      /<script src="pwa-install\.min\.js[^>]*defer>/, false],
  ['pwa-install lazy loader present',    /__mzLoadPwaInstall/, true],
  ['moviezone.min.js at the built version (v' + JS_VERSION + ')',
    new RegExp('moviezone\\.min\\.js\\?v=' + JS_VERSION.replace(/\./g, '\\.')), true],
  ['moviezone.min.css at the built version (v' + CSS_VERSION + ')',
    new RegExp('moviezone\\.min\\.css\\?v=' + CSS_VERSION.replace(/\./g, '\\.')), true],
  ['idle lazy->eager hack removed',      /if \(i < 4\) img\.loading = 'eager'/, false]
];

const JS_MARKS = [
  ['request retry layer',                /_mzFetchWithRetry/, true],
  ['concurrency gate',                   /MZ_MAX_CONCURRENT_FETCHES|_mzAcquireSlot/, true],
  ['bounded feed retry budget',          /MZ_FEED_MAX_RETRIES/, true],
  ['benign-failure classification',      /_mzIsBenignFailure/, true],
  ['DD_RUM.addError reporting',          /DD_RUM\.addError/, true],
  ['OLD console.error is gone',          /Network\/Fetch Error/, false],
  // terser writes 3000 as 3e3 and renames the parameter, so match both forms.
  ['OLD infinite 3s retry is gone',       /loadMovies\([\w$]+\), ?3(?:000|e3)\)/, false],
  ['grid event delegation',              /ensureGridDelegation/, true],
  ['hero backdrop as <img>',             /slide-bg-img/, true],
  ['manual retry button',                /mzFeedRetryBtn/, true],
  ['runtime perfStyle injection gone',   /PERFORMANCE BOOST STYLES|perfStyle/, false]
];

const SW_MARKS = [
  ['TMDB image cache',                   /IMAGE_CACHE/, true],
  ['cache-first for versioned assets',   /isVersionedAsset/, true],
  ['fonts precached',                    /fonts\/outfit-latin-var\.woff2/, true],
  ['cache version >= v60',               /moviezone-v(6[0-9]|[7-9][0-9])/, true],
  ['stale 7.2 pin removed',              /moviezone\.min\.js\?v=7\.2/, false]
];

let pass = 0, fail = 0;
function report(section, body, marks) {
  console.log('\n-- ' + section + ' ' + '-'.repeat(Math.max(2, 56 - section.length)));
  marks.forEach(([label, re, want]) => {
    const got = re.test(body);
    const ok = got === want;
    if (ok) pass++; else fail++;
    console.log('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + label +
      (ok ? '' : '   (expected ' + (want ? 'present' : 'absent') + ', found ' + (got ? 'present' : 'absent') + ')'));
  });
}

(async () => {
  console.log('\nProbing https://' + HOST + ' — is the work actually deployed?');

  const html = await get('/');
  console.log('  GET /            -> ' + html.status + ', ' + html.body.length + ' bytes');
  if (html.status !== 200) { console.error('  cannot verify: homepage did not return 200'); process.exit(1); }
  report('index.html', html.body, HTML_MARKS);

  const jsMatch = /moviezone\.min\.js\?v=[\d.]+/.exec(html.body);
  const js = await get('/' + (jsMatch ? jsMatch[0] : 'moviezone.min.js'));
  console.log('\n  GET /' + (jsMatch ? jsMatch[0] : 'moviezone.min.js') + ' -> ' + js.status + ', ' + js.body.length + ' bytes');
  report('moviezone.min.js', js.body, JS_MARKS);

  const sw = await get('/sw.js');
  console.log('\n  GET /sw.js       -> ' + sw.status + ', ' + sw.body.length + ' bytes');
  report('sw.js', sw.body, SW_MARKS);

  // Fonts must actually be reachable, or the preload 404s and text falls back.
  console.log('\n-- self-hosted font files ' + '-'.repeat(33));
  for (const f of ['outfit-latin-var.woff2', 'bebas-neue-latin-400.woff2']) {
    const r = await get('/fonts/' + f);
    const ok = r.status === 200 && r.body.length > 5000;
    if (ok) pass++; else fail++;
    console.log('  ' + (ok ? 'OK  ' : 'MISS') + '  /fonts/' + f + ' -> ' + r.status +
      ', ' + r.body.length + ' bytes, cache-control: ' + (r.headers['cache-control'] || 'none'));
  }

  /*  ── THE CHECK THAT MATTERS MOST ─────────────────────────────────────────
   *  Byte-compare what the CDN serves against what the repo built. The marker
   *  greps above can pass on a stale file if the markers happen to predate the
   *  drift, which is exactly how two rounds of fixes sat undelivered: the ?v=
   *  was unchanged, so the immutable CDN copy and every service-worker cache
   *  kept the older bytes at the same URL. A hash comparison cannot be fooled
   *  that way.
   */
  const fsLocal = require('fs');
  console.log('\n-- deployed bytes vs local build ' + '-'.repeat(26));
  for (const name of ['moviezone.min.js', 'moviezone.min.css']) {
    const v = new RegExp(name.replace(/\./g, '\\.') + '\\?v=([\\d.]+)').exec(html.body);
    const url = '/' + name + (v ? '?v=' + v[1] : '');
    const live = await get(url);
    const local = fsLocal.readFileSync(name);
    const same = live.status === 200 && Buffer.from(live.body, 'utf8').length === local.length;
    if (same) pass++; else fail++;
    console.log('  ' + (same ? 'OK  ' : 'MISS') + '  ' + url +
      ' -> live ' + Buffer.byteLength(live.body) + ' bytes, local ' + local.length + ' bytes' +
      '  (cdn age ' + (live.headers.age || '0') + 's)');
    if (!same) {
      console.log('          the CDN is serving different bytes at this URL. Bump the ?v= in');
      console.log('          index.html AND sw.js, bump CACHE_NAME, run npm run assets:seal, redeploy.');
    }
  }

  console.log('\n' + '='.repeat(62));
  console.log('  deploy-verify: ' + pass + ' deployed, ' + fail + ' NOT deployed');
  if (fail) console.log('  -> the live site is not running this build; nothing local can fix that');
  console.log('='.repeat(62) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
