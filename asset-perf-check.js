'use strict';

/*  Guards the front-end performance decisions that are easy to undo by accident.
 *
 *  Every check here exists because the thing it tests was actually broken:
 *
 *    • index.html requested moviezone.css / moviezone.js while `npm run build`
 *      produced .min versions that vercel.json even deployed. Every visitor
 *      downloaded and parsed the dev files. Measured: 739 KB raw / 178 KB gzip
 *      shipped where 422 KB / 99 KB was already sitting on the server.
 *    • getResponsiveBackdrop() served TMDB `original` to desktops. That is the
 *      hero carousel image, i.e. the LCP element — 885 KB average, 1.7 MB peak,
 *      against 116 KB for w1280.
 *    • The SWR cache wrote to localStorage synchronously inside every response
 *      handler, so a cold load did 15-20 blocking disk writes while rendering.
 *    • sw.js precached its own copy of the asset URLs. If that list and
 *      index.html disagree, an offline phone silently runs different code than
 *      an online one.
 *
 *  Run: node asset-perf-check.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const html = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
const js = fs.readFileSync('moviezone.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

/*  Several checks below scan for markup patterns. Both files document their own
 *  markup in prose, so a naive scan matches the explanation instead of the code.
 *  These stripped copies exist purely so the guards look at what ships.
 */
const htmlCode = html.replace(/<!--[\s\S]*?-->/g, '');
const jsCode = js
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; console.log('  PASS  ' + label); }
  catch (e) {
    fail++; failures.push(label + ' - ' + e.message);
    console.log('  FAIL  ' + label + '\n          ' + e.message);
  }
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const gzipOf = (p) => zlib.gzipSync(fs.readFileSync(p), { level: 9 }).length;

const CORE = ['moviezone', 'tv-mode'];
const SCRIPTS = ['moviezone', 'tv-mode', 'search-engine', 'pwa-install'];
const STYLES = ['moviezone', 'tv-mode'];

console.log('\n-- shipped asset weight ' + '-'.repeat(38));
let rawMin = 0, gzMin = 0, rawSrc = 0, gzSrc = 0;
for (const name of CORE) {
  for (const ext of ['js', 'css']) {
    const src = name + '.' + ext;
    const min = name + '.min.' + ext;
    if (!fs.existsSync(min)) continue;
    const rs = fs.statSync(src).size, rm = fs.statSync(min).size;
    const gs = gzipOf(src), gm = gzipOf(min);
    rawSrc += rs; rawMin += rm; gzSrc += gs; gzMin += gm;
    console.log('  ' + min.padEnd(22) + kb(rm).padStart(10) + ' raw  ' + kb(gm).padStart(10)
      + ' gzip   (source: ' + kb(rs) + ' / ' + kb(gs) + ')');
  }
}
console.log('  ' + 'TOTAL'.padEnd(22) + kb(rawMin).padStart(10) + ' raw  ' + kb(gzMin).padStart(10)
  + ' gzip   (source: ' + kb(rawSrc) + ' / ' + kb(gzSrc) + ')');
console.log('  saving vs shipping sources: ' + kb(rawSrc - rawMin) + ' raw, '
  + kb(gzSrc - gzMin) + ' gzip  ('
  + Math.round((1 - rawMin / rawSrc) * 100) + '% / '
  + Math.round((1 - gzMin / gzSrc) * 100) + '%)');

console.log('\n-- index.html references the built bundles ' + '-'.repeat(19));

for (const name of SCRIPTS) {
  check(name + '.min.js is the script that ships', () => {
    const tag = new RegExp('<script src="' + name + '\\.min\\.js\\?v=[\\d.]+" defer>');
    assert.ok(tag.test(html), name + '.min.js is not the <script> src');
    const bare = new RegExp('<script src="' + name + '\\.js\\?');
    assert.ok(!bare.test(html), 'unminified ' + name + '.js is still requested');
  });
}

for (const name of STYLES) {
  check(name + '.min.css is the stylesheet that ships', () => {
    const tag = new RegExp('<link rel="stylesheet" href="' + name + '\\.min\\.css\\?v=[\\d.]+">');
    assert.ok(tag.test(html), name + '.min.css is not linked');
    const bare = new RegExp('href="' + name + '\\.css\\?');
    assert.ok(!bare.test(html), 'unminified ' + name + '.css is still linked');
  });
}

check('script preloads point at the same files as the script tags', () => {
  const preloaded = [...html.matchAll(/<link rel="preload" href="([^"]+\.js\?[^"]*)" as="script">/g)]
    .map((m) => m[1]);
  const tagged = [...html.matchAll(/<script src="([^"]+\.js\?[^"]*)" defer>/g)].map((m) => m[1]);
  assert.ok(preloaded.length > 0, 'no script preloads found');
  preloaded.forEach((p) => {
    assert.ok(tagged.includes(p),
      'preload of ' + p + ' matches no <script> tag - that is a wasted download');
  });
});

check('every referenced asset exists on disk', () => {
  const refs = [
    ...[...html.matchAll(/<script src="([^"?]+)/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)].map((m) => m[1])
  ];
  refs.forEach((r) => {
    const p = path.join(__dirname, r.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), r + ' is referenced by index.html but missing on disk');
  });
});

check('no asset is referenced twice', () => {
  ['rel="stylesheet" href="moviezone.min.css', 'preload" href="moviezone.min.js',
   'preconnect" href="https://image.tmdb.org'].forEach((needle) => {
    const n = html.split(needle).length - 1;
    assert.strictEqual(n, 1, needle + ' appears ' + n + ' times — duplicate request');
  });
});

console.log('\n-- how early the network can start ' + '-'.repeat(27));

/*  The preload scanner walks <head> in order, so a tag's byte offset is
 *  effectively its start time. These used to sit behind the SEO meta and a
 *  ~9 KB JSON-LD graph, leaving the network idle for 20 KB of parsing.
 */
const OFFSET_BUDGET = 4096;
[['main stylesheet', '<link rel="stylesheet" href="moviezone.min.css'],
 ['TMDB preconnect', '<link rel="preconnect" href="https://image.tmdb.org"'],
 ['script preloads', '<link rel="preload" href="search-engine.min.js']
].forEach(([label, needle]) => {
  const at = html.indexOf(needle);
  console.log('  ' + label.padEnd(20) + 'discovered at byte ' + String(at).padStart(6));
  check(label + ' is discovered within the first ' + (OFFSET_BUDGET / 1024) + ' KB of head', () => {
    assert.ok(at !== -1, needle + ' not found');
    assert.ok(at < OFFSET_BUDGET,
      'found at byte ' + at + '; the network sits idle while the parser gets there');
  });
});

check('charset stays in the first 1024 bytes', () => {
  const at = html.indexOf('<meta charset=');
  assert.ok(at !== -1 && at < 1024,
    'charset at byte ' + at + ' — browsers may restart the parse');
});

console.log('\n-- build produces everything index.html asks for ' + '-'.repeat(13));

check('npm run build minifies every shipped script', () => {
  SCRIPTS.forEach((name) => {
    assert.ok(pkg.scripts.build.includes(name + '.min.js'),
      name + '.min.js is referenced by index.html but never built');
  });
});
check('npm run build minifies every shipped stylesheet', () => {
  STYLES.forEach((name) => {
    assert.ok(pkg.scripts.build.includes(name + '.min.css'),
      name + '.min.css is referenced by index.html but never built');
  });
});
check('minified output is actually smaller than its source', () => {
  [...SCRIPTS.map((n) => [n + '.js', n + '.min.js']),
   ...STYLES.map((n) => [n + '.css', n + '.min.css'])].forEach(([src, min]) => {
    assert.ok(fs.existsSync(min), min + ' has not been built - run npm run build');
    assert.ok(fs.statSync(min).size < fs.statSync(src).size,
      min + ' is not smaller than ' + src + ' (stale build?)');
  });
});

console.log('\n-- service worker agrees with the page ' + '-'.repeat(23));

check('sw.js precaches exactly the URLs index.html requests', () => {
  const pageAssets = [
    ...[...html.matchAll(/<script src="([^"]+\.js\?[^"]*)" defer>/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+\.css\?[^"]*)">/g)].map((m) => m[1])
  ];
  assert.ok(pageAssets.length >= 6, 'expected at least 6 versioned assets, found ' + pageAssets.length);
  pageAssets.forEach((a) => {
    assert.ok(sw.includes("'/" + a + "'"),
      a + ' is loaded by index.html but not precached by sw.js - offline clients would run stale code');
  });
});

check('sw.js precaches no unminified bundle', () => {
  [...SCRIPTS.map((n) => n + '.js'), ...STYLES.map((n) => n + '.css')].forEach((f) => {
    assert.ok(!new RegExp("'/" + f.replace('.', '\\.') + "\\?").test(sw),
      'sw.js still precaches the unminified ' + f);
  });
});

check('cache version was bumped past the pre-minification build', () => {
  const m = sw.match(/const CACHE_NAME = 'moviezone-v(\d+)'/);
  assert.ok(m, 'CACHE_NAME not found');
  assert.ok(Number(m[1]) >= 59,
    'CACHE_NAME is v' + m[1] + '; the caching-strategy rewrite needs a bump above v58 or clients keep the old shell');
});

check('TMDB images are cached instead of re-downloaded every visit', () => {
  assert.ok(/image\.tmdb\.org/.test(sw),
    'sw.js has no TMDB image branch. The generic path only stores response.type === "basic", and a TMDB image is cross-origin, so every repeat visit re-downloaded the hero backdrop - the LCP element.');
  assert.ok(/IMAGE_CACHE/.test(sw), 'no dedicated image cache');
  assert.ok(/IMAGE_CACHE_MAX_ENTRIES/.test(sw), 'the image cache is unbounded');
  assert.ok(/key !== IMAGE_CACHE/.test(sw),
    'activate() deletes the image cache on every shell bump, which defeats the point of having it');
});

check('versioned bundles are served cache-first', () => {
  assert.ok(/isVersionedAsset/.test(sw),
    'scripts and styles are network-first again: that is a full round trip in front of two render-blocking resources on every repeat visit, even though ?v= makes each URL immutable');
});

check('self-hosted fonts are precached', () => {
  ['/fonts/outfit-latin-var.woff2', '/fonts/bebas-neue-latin-400.woff2'].forEach((f) => {
    assert.ok(sw.includes("'" + f + "'"),
      f + ' is on the critical render path but not precached - an offline visit would reflow to a system face');
  });
});

console.log('\n-- image weight ' + '-'.repeat(45));

check('backdrops never request TMDB "original"', () => {
  const start = js.indexOf('function getResponsiveBackdrop');
  assert.ok(start !== -1, 'getResponsiveBackdrop not found');
  const fn = js.slice(start, js.indexOf('\n}', start) + 2);
  assert.ok(!/t\/p\/original/.test(fn),
    '"original" is back in getResponsiveBackdrop - 885 KB average on the LCP element');
  assert.ok(/w1280/.test(fn), 'w1280 ceiling missing');
});

check('the hero backdrop is a real high-priority <img>, not a background', () => {
  /*  This used to assert `preload.fetchPriority = 'high'` on a <link> that
   *  buildCarousel injected. That mechanism is gone, and deliberately so: the
   *  link was appended from JS — after the bundle parsed and after the TMDB
   *  response resolved — so it raced nothing. The property it guarded (the LCP
   *  element wins the priority race) is now achieved by rendering slide 0's
   *  backdrop as an <img fetchpriority="high">, which the browser requests at
   *  Highest priority the moment it is inserted.
   */
  const start = jsCode.indexOf('function buildCarousel');
  assert.ok(start !== -1, 'buildCarousel not found');
  const fn = jsCode.slice(start, jsCode.indexOf('\nfunction ensureSlideBg', start));

  assert.ok(/class="slide-bg-img"[\s\S]{0,200}?fetchpriority="high"/.test(fn),
    'slide 0 is not rendered as an <img fetchpriority="high"> - the LCP element is back to being a low-priority CSS background');
  assert.ok(!/style="background-image:url/.test(fn),
    'slide 0 is setting background-image again; a background is not discoverable by the preload scanner');
  assert.ok(/localStorage\.setItem\('mz_hero_lcp'/.test(fn),
    'the hero URL is no longer remembered, so the pre-paint LCP hint in index.html can never fire');
});

check('the pre-paint hint in index.html reads the hero URL back', () => {
  assert.ok(/localStorage\.getItem\('mz_hero_lcp'\)/.test(html),
    'index.html does not consume mz_hero_lcp - returning visitors lose the early LCP request');
  assert.ok(/l\.fetchPriority = 'high'/.test(html),
    'the hero hint is injected without high fetch priority');
});

check('grid posters do not outbid the hero for bandwidth', () => {
  assert.ok(/fetchpriority="low"/.test(js),
    'grid posters are back at default priority; #hero is 95vh so none of them are above the fold, yet six eager ones competed with the LCP image');
});

check('no third-party script blocks the parser', () => {
  const blocking = [...html.matchAll(/<script\s+src="(https?:\/\/[^"]+)"(?![^>]*\b(?:async|defer)\b)/g)]
    .map((m) => m[1]);
  assert.strictEqual(blocking.length, 0,
    'parser-blocking cross-origin script(s): ' + blocking.join(', '));
});

check('there is exactly one <head>', () => {
  // Anchored to the line start: prose inside inline <script> comments also says
  // "<head>", and stripping HTML comments alone does not remove those.
  const n = (htmlCode.match(/^<head>\s*$/gm) || []).length;
  assert.strictEqual(n, 1, 'found ' + n + ' <head> tags - the nested one made every tag inside it invalid');
});

check('fonts are self-hosted, not fetched from Google', () => {
  assert.ok(!/fonts\.googleapis\.com/.test(html),
    'the Google Fonts stylesheet is back: that is DNS+TLS -> CSS -> DNS+TLS -> woff2 before a glyph can paint');
  assert.ok(/<link rel="preload" href="\/fonts\/[\w.-]+\.woff2" as="font" type="font\/woff2" crossorigin>/.test(html),
    'no woff2 preload - the face will not be ready for the first paint and the swap will shift .slide-title');
  ['outfit-latin-var.woff2', 'bebas-neue-latin-400.woff2'].forEach((f) => {
    assert.ok(fs.existsSync(path.join(__dirname, 'fonts', f)), 'fonts/' + f + ' is missing on disk');
  });
});

check('Continue Watching reserves its space before first paint', () => {
  assert.ok(!/id="continue-watching"[^>]*style="display:none/.test(html),
    'the inline display:none is back; it outranks every stylesheet, so the section can only be revealed after first paint - a ~380px shift');
  assert.ok(/html\.mz-has-cw #continue-watching\{display:block\}/.test(html),
    'no class-driven reveal rule');
  assert.ok(/localStorage\.getItem\('mz_continue_watching'\)/.test(html),
    'nothing sets mz-has-cw before paint, so the reservation never applies');
});

check('every TMDB image ships intrinsic dimensions', () => {
  const offenders = [];
  for (const tag of jsCode.match(/<img[^>]*?(?:>|decoding=)/g) || []) {
    // slide-bg-img is sized entirely by its absolutely-positioned parent, so
    // width/height attributes would describe nothing.
    if (/width=/.test(tag) || /slide-bg-img/.test(tag)) continue;
    offenders.push(tag.replace(/\s+/g, ' ').slice(0, 70));
  }
  assert.strictEqual(offenders.length, 0,
    'images without width/height reserve no space: ' + offenders.join(' | '));
});

check('grid posters ship a srcset so the browser can pick a size', () => {
  assert.ok(/srcset="https:\/\/image\.tmdb\.org\/t\/p\/w185/.test(js),
    'no srcset on the grid poster - every device downloads the same w342');
  assert.ok(/sizes="\(max-width: 600px\)/.test(js),
    'srcset present but no sizes attribute to go with it');
});

console.log('\n-- main-thread cost of the data cache ' + '-'.repeat(24));

check('TMDB cache writes are deferred, not synchronous', () => {
  assert.ok(/_mzQueueCacheWrite\(cacheKey, data\)/.test(js),
    'response handler is not using the deferred write queue');
  const inline = /tmdbCache\.set\(urlStr, data\);\s*try\s*\{\s*localStorage\.setItem/.test(js);
  assert.ok(!inline, 'localStorage.setItem is back inline in the response handler');
});

check('a fresh localStorage hit is promoted into the memory cache', () => {
  const idx = js.indexOf('Agar data 12 ghante se naya hai');
  assert.ok(idx !== -1, 'freshness branch not found');
  const branch = js.slice(idx, idx + 900);
  assert.ok(/tmdbCache\.set\(urlStr, cachedData\)/.test(branch),
    'fresh cache hits still re-parse from localStorage on every repeat call');
});

check('cache writes are flushed before the page goes away', () => {
  assert.ok(/addEventListener\('pagehide', _mzFlushCacheWrites\)/.test(js),
    'queued writes would be lost on navigation, costing the next visit its warm cache');
});

check('localStorage quota overflow is handled by eviction', () => {
  assert.ok(/_mzEvictCacheEntries/.test(js),
    'no eviction path - once the quota fills, every write throws forever');
});

console.log('\n-- playback start ' + '-'.repeat(43));

check('the selected provider is warmed before speculative hosts', () => {
  const idx = js.indexOf('warmPlayerConnection(id, type)');
  const spec = js.indexOf('warmRankedFallbacks(id, type');
  assert.ok(idx !== -1 && spec !== -1, 'modal warm-up calls not found');
  assert.ok(idx < spec,
    'speculative preconnects run before the host the user actually streams from');
});
check('speculative preconnects are bounded', () => {
  assert.ok(!/preconnectPlayerHosts\(6\)/.test(js),
    'six speculative TLS handshakes on modal open competes with the detail fetch');
});
check('fallback warming follows the real retry chain, not a fixed list', () => {
  assert.ok(/function warmRankedFallbacks\(/.test(js), 'warmRankedFallbacks missing');
  assert.ok(/rankSourceIdxs\(pool\)/.test(js),
    'fallback warming is not using the ranked candidate pool');
});

console.log('\n-- player server learning ' + '-'.repeat(35));

check('load outcomes are measured and persisted', () => {
  assert.ok(/function recordPlayerLoad\(/.test(js), 'no success/latency recording');
  assert.ok(/function recordPlayerFailure\(/.test(js), 'no failure recording');
  assert.ok(/MZ_PLAYER_HEALTH_KEY/.test(js), 'health stats are not persisted');
});

check('iframe load and error both feed the stats', () => {
  assert.ok(/recordPlayerLoad\(_mzSrcName, Date\.now\(\) - _mzStartedAt\)/.test(js),
    'successful loads are not timed');
  assert.ok(/recordPlayerFailure\(_mzSrcName\);\s*\n\s*autoRetryNextServer/.test(js),
    'iframe.onerror does not record the failure');
});

check('give-up time adapts instead of a flat 5s', () => {
  assert.ok(/function adaptivePlayerTimeout\(/.test(js), 'no adaptive timeout');
  assert.ok(!/const retryAfter = reusable \? 4000 : 5000/.test(js),
    'the flat 4000/5000 ms retry wait is back');
  assert.ok(/adaptivePlayerTimeout\(_mzSrcName\)/.test(js),
    'the retry timer is not using the adaptive value');
});

check('retry order is ranked, not array position', () => {
  const start = js.indexOf('function autoRetryNextServer(');
  assert.ok(start !== -1, 'autoRetryNextServer not found');
  const fn = js.slice(start, start + 2000);
  assert.ok(/rankSourceIdxs\(pool\)/.test(fn), 'retry is not using the ranked pool');
  assert.ok(!/for \(let i = currentIdx \+ 1; i < playerSources\.length; i\+\+\)/.test(fn),
    'the positional forward-scan retry walk is back');
});

check('a server that just failed is not retried in the same chain', () => {
  assert.ok(/_mzTriedSources/.test(js), 'no tried-server tracking');
  assert.ok(/resetTriedSources\(\)/.test(js), 'tried-server set is never reset');
});

check('recovery is possible — failures are partially forgiven', () => {
  assert.ok(/e\.fail = Math\.max\(0, \+\(e\.fail - 0\.5\)/.test(js),
    'a provider that recovers would stay demoted forever');
});

check('unknown servers are explored, not ranked last', () => {
  const start = js.indexOf('function playerCost(');
  const fn = js.slice(start, start + 500);
  assert.ok(/return 4000;/.test(fn),
    'never-tried servers must sit mid-pack so the player keeps exploring');
});

console.log('\n-- per-frame CSS cost ' + '-'.repeat(39));

check('no infinite animation drives a layout property', () => {
  const css = fs.readFileSync('moviezone.css', 'utf8');
  const offenders = [];
  const kf = /@keyframes\s+([\w-]+)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let m;
  while ((m = kf.exec(css)) !== null) {
    const name = m[1];
    if (!/[\s;{](left|top|right|bottom|width|height|margin|padding)\s*:/.test(m[2] || m[0])) continue;
    if (new RegExp(name + '[^;{}]*infinite').test(css)) offenders.push(name);
  }
  assert.strictEqual(offenders.length, 0,
    'these run forever and force layout every frame: ' + offenders.join(', '));
});

check('the weak-hardware fast path is not mobile-only', () => {
  assert.ok(/if \(isMobile \|\| isLowEnd \|\| reduceMotion\)/.test(js),
    'low-end-mode is gated on isMobile alone, so weak laptops get all 76 backdrop-filters');
});

check('the always-on navbar sweep is composited', () => {
  const css = fs.readFileSync('moviezone.css', 'utf8');
  const start = css.indexOf('@keyframes navPremiumSweep');
  const fn = css.slice(start, start + 300);
  assert.ok(!/left\s*:/.test(fn), 'navbar sweep animates `left` again (layout every frame)');
  assert.ok(/translate3d/.test(fn), 'navbar sweep is not using a composited transform');
});

console.log('\n' + '='.repeat(62));
console.log('  asset-perf-check: ' + pass + ' passed, ' + fail + ' failed');
if (fail) failures.forEach((f) => console.log('   x ' + f));
console.log('='.repeat(62) + '\n');
process.exit(fail ? 1 : 0);
