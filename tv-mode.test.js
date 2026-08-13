/* ═══════════════════════════════════════════════════════════════════════════
   tv-mode.test.js — dependency-free tests for MovieZone TV mode.

   tv-mode.js keeps all of its decision logic in pure functions precisely so it
   can be verified here without a browser, jsdom or any other dependency. The
   DOM layer of tv-mode.js is skipped automatically in Node (no `document`), so
   requiring the module is itself part of the test.

   Run: node tv-mode.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const TV = require('./tv-mode.js');

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    return;
  }
  failures.push(label + (detail ? ' — ' + detail : ''));
}

function eq(label, actual, expected) {
  check(label, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function section(name) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 58 - name.length)));
}

/* ═══════════════════════════════════════════════════════════════
   1. MODULE SHAPE — must load cleanly in a DOM-less environment
   ═══════════════════════════════════════════════════════════════ */
section('module shape');

check('module loads in Node without a DOM', typeof TV === 'object' && TV !== null);
['detectTvPlatform', 'mapRemoteKey', 'pickNextFocus', 'computePerfProfile', 'configure', 'isTV', 'getState']
  .forEach(fn => check('exports ' + fn + '()', typeof TV[fn] === 'function'));
eq('isTV() is false without a DOM', TV.isTV(), false);
check('configure() is chainable', TV.configure({ goHome: function () {} }) === TV);
check('configure() tolerates junk input', TV.configure(null) === TV && TV.configure({ nope: 1 }) === TV);
eq('getState().platform defaults to browser', TV.getState().platform, 'browser');

/* ═══════════════════════════════════════════════════════════════
   2. TV DETECTION — real user-agent strings
   ═══════════════════════════════════════════════════════════════ */
section('TV detection');

const TV_AGENTS = [
  ['Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7285.2308N) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/106 Safari/537.36', 'fire-tv', 'Fire TV Stick 4K'],
  ['Mozilla/5.0 (Linux; Android 5.1; AFTB Build/LVY48F) AppleWebKit/537.36 Chrome/47 Safari/537.36', 'fire-tv', 'Fire TV (1st gen)'],
  ['Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1', 'tizen', 'Samsung Tizen'],
  ['Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68 Safari/537.36 WebAppManager', 'webos', 'LG webOS (zero in Web0S)'],
  ['Mozilla/5.0 (Unknown; Linux) AppleWebKit/538.1 (KHTML, like Gecko) Safari/538.1 NetCast', 'webos', 'LG NetCast (legacy)'],
  ['Mozilla/5.0 (Linux; Android 9; BRAVIA 4K GB Build/PTT1.190515) AppleWebKit/537.36 Chrome/76 Safari/537.36', 'bravia', 'Sony BRAVIA Android TV'],
  ['Mozilla/5.0 (Linux; Android 11; Google TV) AppleWebKit/537.36 Chrome/94 Safari/537.36', 'android-tv', 'Google TV'],
  ['Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 Chrome/31 Safari/537.36 CrKey/1.56', 'chromecast', 'Chromecast'],
  ['Mozilla/5.0 (Linux; U;) AppleWebKit/537.36 Chrome/79 VIDAA/3.0 Safari/537.36', 'vidaa', 'Hisense VIDAA'],
  ['HbbTV/1.4.1 (+DRM; Sony; KDL-42W80; 1.0; ) Presto/2.12 Version/12.00', 'hbbtv', 'HbbTV set'],
  ['Mozilla/5.0 (PlayStation; PlayStation 5/5.00) AppleWebKit/605.1.15 Version/13.0 Safari/605.1.15', 'playstation', 'PlayStation 5'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 Edge/44', 'xbox', 'Xbox Series X'],
  ['Mozilla/5.0 (Linux; Tizen 2.3) AppleWebKit/538.1 SamsungBrowser/1.0 TV Safari/538.1', 'tizen', 'Tizen 2.3'],
  ['Mozilla/5.0 (Linux armv7l) AppleWebKit/537.36 Chrome/38 Large Screen Safari/537.36 Vestel', 'vestel', 'Vestel'],
  ['Opera/9.80 (Linux mips; Opera TV Store/6349) Presto/2.12.407 Version/12.51', 'opera-tv', 'Opera TV'],
  ['Mozilla/5.0 (Macintosh; U; Intel Mac OS X; en) AppleTV/11.1', 'apple-tv', 'Apple TV']
];

TV_AGENTS.forEach(([ua, expectedPlatform, label]) => {
  const result = TV.detectTvPlatform({ userAgent: ua, search: '' });
  check('detects TV: ' + label, result.isTv === true, 'isTv=' + result.isTv);
  eq('platform for ' + label, result.platform, expectedPlatform);
  eq('confidence for ' + label, result.confidence, 'confirmed');
});

const NON_TV_AGENTS = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Windows desktop Chrome'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'macOS Safari'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'iPhone'],
  ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'iPad'],
  ['Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'Samsung Galaxy phone'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Linux desktop'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Windows Firefox']
];

NON_TV_AGENTS.forEach(([ua, label]) => {
  const result = TV.detectTvPlatform({ userAgent: ua, search: '', hasFinePointer: true, hasAnyPointer: true });
  check('NOT a TV: ' + label, result.isTv === false, 'got platform=' + result.platform + ' reason=' + result.reason);
});

// A 4K desktop monitor must never be mistaken for a TV.
check('4K desktop monitor is not a TV',
  TV.detectTvPlatform({ userAgent: NON_TV_AGENTS[0][0], search: '', screenWidth: 3840, hasFinePointer: true, hasAnyPointer: true }).isTv === false);

/* ── Explicit overrides ── */
const forcedOn = TV.detectTvPlatform({ userAgent: NON_TV_AGENTS[0][0], search: '?tv=1' });
check('?tv=1 forces TV mode on a desktop', forcedOn.isTv === true);
eq('?tv=1 confidence', forcedOn.confidence, 'forced-on');

['?tv=1', '?tv=true', '?tv', '?foo=bar&tv=on'].forEach(q => {
  check('override on via "' + q + '"', TV.detectTvPlatform({ userAgent: '', search: q }).isTv === true);
});
['?tv=0', '?tv=false', '?tv=off', '?tv=no'].forEach(q => {
  const r = TV.detectTvPlatform({ userAgent: TV_AGENTS[2][0], search: q });
  check('override off via "' + q + '" beats a TV user-agent', r.isTv === false, 'platform=' + r.platform);
});
eq('readTvOverride returns null without the parameter', TV.readTvOverride('?lang=hi'), null);

/* ── Pointer-less devices (remote-only boxes with anonymous UAs) ── */
const remoteOnly = TV.detectTvPlatform({ userAgent: 'Mozilla/5.0 (Linux) AppleWebKit/537.36 Chrome/90', search: '', hasFinePointer: false, hasAnyPointer: false });
check('no pointing device is treated as a TV', remoteOnly.isTv === true);
eq('pointer-less platform label', remoteOnly.platform, 'remote-only');
eq('pointer-less confidence', remoteOnly.confidence, 'probable');

check('unknown UA with a pointer stays non-TV',
  TV.detectTvPlatform({ userAgent: 'Mozilla/5.0 (Linux) Chrome/90', search: '', hasFinePointer: true, hasAnyPointer: true }).isTv === false);
check('missing matchMedia data does not enable TV mode',
  TV.detectTvPlatform({ userAgent: 'Mozilla/5.0 (Linux) Chrome/90', search: '', hasFinePointer: null, hasAnyPointer: null }).isTv === false);
check('empty environment is safe', TV.detectTvPlatform().isTv === false);

/*  ── Automated clients ──────────────────────────────────────────────────
 *  A crawler runs headless in a container, so it reports no pointing device at
 *  all and used to fall straight into the remote-only rule above — Googlebot
 *  was being handed a TV layout. These lock the guard in place, including the
 *  two directions it must NOT change: a real TV user-agent still wins (a bot
 *  token is not proof the device is not a TV), and ?tv=1 still overrides
 *  everything, which is the escape hatch if a real device is ever caught.
 */
const AUTOMATED_AGENTS = [
  ['Googlebot', 'Mozilla/5.0 (Linux; Android 6.0.1;) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ['Googlebot desktop', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/125.0.0.0 Safari/537.36'],
  ['bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
  ['Lighthouse', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36 Chrome-Lighthouse'],
  ['headless Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/125.0.0.0 Safari/537.36'],
  ['Google inspection tool', 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)'],
  ['facebook link preview', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
  ['AhrefsBot', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)']
];
AUTOMATED_AGENTS.forEach(([label, ua]) => {
  const r = TV.detectTvPlatform({ userAgent: ua, search: '', hasFinePointer: false, hasAnyPointer: false });
  check(label + ' with no pointer is not treated as a TV', r.isTv === false, 'platform=' + r.platform + ' reason=' + r.reason);
  eq(label + ' reason', r.reason, 'automated client');
});

check('a TV user-agent still wins over the bot guard',
  TV.detectTvPlatform({ userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) crawler', search: '', hasFinePointer: false, hasAnyPointer: false }).isTv === true);
check('?tv=1 still forces TV mode for an automated client',
  TV.detectTvPlatform({ userAgent: AUTOMATED_AGENTS[0][1], search: '?tv=1', hasFinePointer: false, hasAnyPointer: false }).isTv === true);
check('an anonymous pointer-less box is still a TV after the guard',
  TV.detectTvPlatform({ userAgent: 'Mozilla/5.0 (Linux) AppleWebKit/537.36 Chrome/90', search: '', hasFinePointer: false, hasAnyPointer: false }).isTv === true);
check('a real desktop UA is not mistaken for automation',
  TV.detectTvPlatform({ userAgent: NON_TV_AGENTS[0][0], search: '', hasFinePointer: true, hasAnyPointer: true }).platform === 'browser');

/* ═══════════════════════════════════════════════════════════════
   3. REMOTE KEY MAPPING
   ═══════════════════════════════════════════════════════════════ */
section('remote key mapping');

// KeyboardEvent.key names (modern Android TV / webOS / Tizen browsers)
[['ArrowLeft', 'left'], ['ArrowRight', 'right'], ['ArrowUp', 'up'], ['ArrowDown', 'down'],
 ['Left', 'left'], ['Right', 'right'], ['Up', 'up'], ['Down', 'down'],
 ['Enter', 'ok'], [' ', 'ok'], ['Escape', 'back'], ['Backspace', 'back'],
 ['BrowserBack', 'back'], ['GoBack', 'back'], ['XF86Back', 'back'],
 ['Home', 'home'], ['PageUp', 'pageUp'], ['PageDown', 'pageDown'],
 ['ChannelUp', 'pageUp'], ['ChannelDown', 'pageDown'],
 ['MediaPlayPause', 'playPause'], ['MediaStop', 'stop'], ['MediaFastForward', 'forward'],
 ['MediaTrackNext', 'next'], ['ColorF0Red', 'red'], ['ColorF1Green', 'green']
].forEach(([key, action]) => eq('key "' + key + '"', TV.mapRemoteKey({ key: key }), action));

// Legacy keyCodes — the only signal some TV firmwares send.
[[37, 'left'], [39, 'right'], [38, 'up'], [40, 'down'], [13, 'ok'],
 [27, 'back'], [8, 'back'], [461, 'back'], [10009, 'back'], [166, 'back'],
 [415, 'play'], [19, 'pause'], [413, 'stop'], [417, 'forward'], [412, 'rewind'],
 [427, 'pageUp'], [428, 'pageDown'], [403, 'red'], [406, 'blue'], [10182, 'exit']
].forEach(([code, action]) => eq('keyCode ' + code, TV.mapRemoteKey({ keyCode: code }), action));

eq('webOS Back (461) maps to back', TV.mapRemoteKey({ key: 'Unidentified', keyCode: 461 }), 'back');
eq('Tizen Back (10009) maps to back', TV.mapRemoteKey({ key: '', keyCode: 10009 }), 'back');
eq('legacy `which` is honoured', TV.mapRemoteKey({ which: 40 }), 'down');
eq('unmapped letter key is ignored', TV.mapRemoteKey({ key: 'a', keyCode: 65 }), null);
eq('null event is ignored', TV.mapRemoteKey(null), null);
eq('empty event is ignored', TV.mapRemoteKey({}), null);

['left', 'right', 'up', 'down'].forEach(d => check('isDirection("' + d + '")', TV.isDirection(d) === true));
['ok', 'back', 'play', 'red', 'toString'].forEach(a => check('isDirection("' + a + '") is false', TV.isDirection(a) === false));

/* ═══════════════════════════════════════════════════════════════
   4. SPATIAL NAVIGATION
   ═══════════════════════════════════════════════════════════════ */
section('spatial navigation');

// A 4-column x 2-row poster grid: 200x300 tiles, 20px gap, starting at (0,0).
function tile(col, row) {
  const left = col * 220;
  const top = row * 320;
  return { left: left, top: top, right: left + 200, bottom: top + 300 };
}
const grid = [];
const gridIndex = {};
for (let row = 0; row < 2; row++) {
  for (let col = 0; col < 4; col++) {
    gridIndex['r' + row + 'c' + col] = grid.length;
    grid.push(tile(col, row));
  }
}
// Helper: candidates array with the origin slot blanked out, mirroring how
// tv-mode.js excludes the currently focused element.
function candidatesExcluding(key) {
  return grid.map((rect, i) => (i === gridIndex[key] ? null : rect));
}

eq('right moves to the next column', TV.pickNextFocus('right', grid[gridIndex.r0c0], candidatesExcluding('r0c0')), gridIndex.r0c1);
eq('left moves to the previous column', TV.pickNextFocus('left', grid[gridIndex.r0c2], candidatesExcluding('r0c2')), gridIndex.r0c1);
eq('down moves within the same column', TV.pickNextFocus('down', grid[gridIndex.r0c2], candidatesExcluding('r0c2')), gridIndex.r1c2);
eq('up moves within the same column', TV.pickNextFocus('up', grid[gridIndex.r1c3], candidatesExcluding('r1c3')), gridIndex.r0c3);

eq('right at the row edge finds nothing', TV.pickNextFocus('right', grid[gridIndex.r0c3], candidatesExcluding('r0c3')), -1);
eq('left at the row start finds nothing', TV.pickNextFocus('left', grid[gridIndex.r0c0], candidatesExcluding('r0c0')), -1);
eq('up on the first row finds nothing', TV.pickNextFocus('up', grid[gridIndex.r0c1], candidatesExcluding('r0c1')), -1);
eq('down on the last row finds nothing', TV.pickNextFocus('down', grid[gridIndex.r1c1], candidatesExcluding('r1c1')), -1);

// Column alignment must beat raw proximity, otherwise pressing Down in a grid
// slides diagonally and the highlight feels broken.
const origin = tile(1, 0);
const alignedBelowFar = { left: 220, top: 900, right: 420, bottom: 1200 };   // same column, far
const misalignedBelowNear = { left: 700, top: 320, right: 900, bottom: 620 }; // other column, near
eq('aligned-but-far beats misaligned-but-near',
  TV.pickNextFocus('down', origin, [misalignedBelowNear, alignedBelowFar]), 1);

// With nothing aligned, the nearest misaligned candidate is still reachable.
eq('falls back to a misaligned candidate when nothing is aligned',
  TV.pickNextFocus('down', origin, [misalignedBelowNear]), 0);

// Partially overlapping rows (mixed tile heights) still count as aligned.
eq('partial overlap counts as the same row',
  TV.pickNextFocus('right', { left: 0, top: 0, right: 200, bottom: 300 },
    [{ left: 220, top: 150, right: 420, bottom: 500 }]), 0);

// Robustness
eq('unknown direction is rejected', TV.pickNextFocus('sideways', grid[0], grid), -1);
eq('empty candidate list', TV.pickNextFocus('right', grid[0], []), -1);
eq('missing origin', TV.pickNextFocus('right', null, grid), -1);
eq('all-null candidates', TV.pickNextFocus('right', grid[0], [null, null]), -1);
eq('overlap1D computes shared extent', TV.overlap1D(0, 100, 50, 200), 50);
eq('overlap1D is zero when disjoint', TV.overlap1D(0, 10, 20, 30), 0);

/* ═══════════════════════════════════════════════════════════════
   5. PERFORMANCE PROFILE
   ═══════════════════════════════════════════════════════════════ */
section('performance profile');

const lowPlatforms = ['fire-tv', 'webos', 'tizen', 'vidaa', 'hbbtv', 'opera-tv', 'generic-tv', 'smart-tv', 'chromecast'];
lowPlatforms.forEach(p => eq('tier for ' + p, TV.computePerfProfile({ platform: p }).tier, 'low'));

['playstation', 'xbox', 'apple-tv'].forEach(p =>
  eq('tier for ' + p, TV.computePerfProfile({ platform: p, deviceMemory: 8, hardwareConcurrency: 8 }).tier, 'high'));

eq('unknown platform defaults to mid', TV.computePerfProfile({ platform: 'forced-tv' }).tier, 'mid');
eq('1GB RAM forces the low tier', TV.computePerfProfile({ platform: 'playstation', deviceMemory: 1 }).tier, 'low');
eq('dual-core forces the low tier', TV.computePerfProfile({ platform: 'apple-tv', hardwareConcurrency: 2 }).tier, 'low');
eq('4K panels never claim the high tier',
  TV.computePerfProfile({ platform: 'playstation', deviceMemory: 8, hardwareConcurrency: 8, screenWidth: 3840 }).tier, 'mid');
eq('a strong Android TV can reach high',
  TV.computePerfProfile({ platform: 'android-tv', deviceMemory: 8, hardwareConcurrency: 8 }).tier, 'high');

const lowProfile = TV.computePerfProfile({ platform: 'fire-tv' });
eq('low tier caps cards at 24', lowProfile.maxCards, 24);
check('low tier disables animations', lowProfile.animations === false);
check('low tier disables blur', lowProfile.blur === false);
check('low tier defers offscreen images', lowProfile.deferOffscreenImages === true);
eq('low tier prefetches at most one title', lowProfile.prefetch, 1);
check('higher tiers prefetch more aggressively',
  TV.computePerfProfile({ platform: 'xbox', deviceMemory: 8, hardwareConcurrency: 8 }).prefetch > lowProfile.prefetch);
check('no tier ever enables particles',
  ['low', 'mid', 'high'].every(t => TV.computePerfProfile({ platform: t === 'high' ? 'xbox' : 'fire-tv' }).particles === false));

const midProfile = TV.computePerfProfile({ platform: 'android-tv' });
check('mid tier still keeps a card cap below desktop', midProfile.maxCards < 80 && midProfile.maxCards >= 24);
check('every tier reports a focus scroll block',
  ['fire-tv', 'android-tv', 'xbox'].every(p => typeof TV.computePerfProfile({ platform: p }).focusScrollBlock === 'string'));

/* ═══════════════════════════════════════════════════════════════
   6. WIRING — the module is useless if the page never loads it
   ═══════════════════════════════════════════════════════════════ */
section('wiring');

function readFile(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

const indexHtml = readFile('index.html');
const moviezoneJs = readFile('moviezone.js');
const tvModeCss = readFile('tv-mode.css');
const swJs = readFile('sw.js');

// These match the .min bundles as well as the plain names. index.html ships the
// minified builds (see asset-perf-check.js) but the assertion is about WIRING —
// that the TV stylesheet is linked and the TV script is loaded before the app
// script — which holds either way. Pinning the exact filename here would make
// this suite fail every time the build output changes, which is not what it is
// meant to guard.
check('index.html loads tv-mode.css', /<link[^>]+rel=["']stylesheet["'][^>]+tv-mode(\.min)?\.css/.test(indexHtml));
check('index.html loads tv-mode.js', /<script[^>]+src=["']tv-mode(\.min)?\.js/.test(indexHtml));

const tvScriptAt = indexHtml.search(/src="tv-mode(\.min)?\.js/);
const appScriptAt = indexHtml.search(/src="moviezone(\.min)?\.js/);
check('tv-mode.js is loaded before moviezone.js', tvScriptAt > -1 && appScriptAt > -1 && tvScriptAt < appScriptAt,
  'tv-mode at ' + tvScriptAt + ', moviezone at ' + appScriptAt);

check('moviezone.js reads the data-mz-tv attribute',
  /const isMzTV = \(\) => document\.documentElement\.getAttribute\('data-mz-tv'\) === 'true';/.test(moviezoneJs));
check('moviezone.js no longer hard-codes isMzTV to false', !/const isMzTV = \(\) => false/.test(moviezoneJs));
check('isMzTVMode() follows isMzTV()', /function isMzTVMode\(\)\s*\{[\s\S]{0,320}?return isMzTV\(\);/.test(moviezoneJs));
check('the strict launch guard is a separate, documented switch',
  /function isMzTVStrictActivation\(\)/.test(moviezoneJs));
check('moviezone.js hands the Back key to tv-mode.js', /if \(isMzTV\(\)\) return;/.test(moviezoneJs));
check('moviezone.js registers its TV callbacks', /window\.MovieZoneTV\.configure\(/.test(moviezoneJs));

// Every callback moviezone.js registers must be one tv-mode.js actually calls.
const tvModeJs = readFile('tv-mode.js');
['isSearchResultsMode', 'isFullViewMovies', 'isFullViewUpcoming', 'closeModal', 'closeDropdown',
 'goHome', 'closeUpcomingDetail', 'handleCollectionsBack', 'isFullscreen', 'exitFullscreen']
  .forEach(hook => {
    check('moviezone.js provides hook ' + hook, moviezoneJs.indexOf(hook + ':') > -1);
    check('tv-mode.js consumes hook ' + hook, tvModeJs.indexOf("'" + hook + "'") > -1);
  });

check('tv-mode.css targets the TV attribute', tvModeCss.indexOf('html[data-mz-tv="true"]') > -1);
check('tv-mode.css has a low-tier block', tvModeCss.indexOf('data-mz-tv-tier="low"') > -1);
check('tv-mode.css forces instant scrolling', /scroll-behavior:\s*auto\s*!important/.test(tvModeCss));
check('tv-mode.css strips backdrop-filter', /backdrop-filter:\s*none\s*!important/.test(tvModeCss));
check('tv-mode.css disables card entrance animations', /animation:\s*none\s*!important/.test(tvModeCss));
check('tv-mode.css exposes the --mz-tv-active marker', tvModeCss.indexOf('--mz-tv-active') > -1);

/* ── DESIGN RULE: the TV must look exactly like the laptop ──
   tv-mode.css is a performance sheet, not a re-skin. These guards fail the build
   if a sizing/typography/spacing override ever creeps back in, which is what
   made cards render huge and the whole UI look different on TV. */
function declarationsIn(css, property) {
  // Matches "property:" only where it starts a declaration, ignoring comments.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = new RegExp('(^|[;{]\\s*)' + property + '\\s*:', 'g');
  return (withoutComments.match(pattern) || []).length;
}

const FORBIDDEN_IN_TV_CSS = [
  'font-size',              // scaled the entire type system up
  'grid-template-columns',  // made the movie cards huge
  'width',
  'min-width',
  'max-width',
  'height',
  'gap',
  'letter-spacing',
  'line-height'
];
FORBIDDEN_IN_TV_CSS.forEach(property => {
  const count = declarationsIn(tvModeCss, property);
  check('tv-mode.css never overrides ' + property + ' (design must match laptop)', count === 0,
    count + ' declaration(s) found');
});

// Padding/margin are allowed only as scroll-* properties, which move nothing.
['padding', 'margin'].forEach(property => {
  const count = declarationsIn(tvModeCss, property);
  check('tv-mode.css never overrides ' + property, count === 0, count + ' declaration(s) found');
});

check('tv-mode.css does not rescale the root font', !/html\[data-mz-tv="true"\]\s*\{[^}]*font-size/.test(tvModeCss));
check('tv-mode.css keeps the laptop focus ring width (2px)', /outline:\s*2px solid var\(--gold\)/.test(tvModeCss));
check('tv-mode.css mirrors laptop focus styling onto :focus', /\.movie-card:focus\s*\{/.test(tvModeCss));

check('service worker precaches tv-mode.css', /tv-mode(\.min)?\.css/.test(swJs));
check('service worker precaches tv-mode.js', /tv-mode(\.min)?\.js/.test(swJs));

const pkg = JSON.parse(readFile('package.json'));
check('build script minifies tv-mode.css', pkg.scripts.build.indexOf('tv-mode.css') > -1);
check('build script minifies tv-mode.js', pkg.scripts.build.indexOf('tv-mode.js') > -1);
check('test script runs this file', pkg.scripts.test.indexOf('tv-mode.test.js') > -1);
check('test script only references files that exist',
  pkg.scripts.test.split('&&')
    .map(part => (part.trim().match(/^node\s+([\w./-]+)/) || [])[1])
    .filter(Boolean)
    .every(file => fs.existsSync(path.join(__dirname, file))),
  pkg.scripts.test);

/* ═══════════════════════════════════════════════════════════════
   REPORT
   ═══════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(62));
if (failures.length === 0) {
  console.log('ALL ' + passed + ' TV MODE CHECKS PASSED');
} else {
  console.log(passed + ' passed, ' + failures.length + ' FAILED:');
  failures.forEach(f => console.log('  FAIL  ' + f));
}
console.log('═'.repeat(62));
process.exit(failures.length === 0 ? 0 : 1);
