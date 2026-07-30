const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');

const tvJs = read('tv-mode.js');
const tvCss = read('tv-mode.css');
const moviezone = read('moviezone.js');
const moviezoneCss = read('moviezone.css');
const pwa = read('pwa-install.js');
const html = read('index.html');
const sw = read('sw.js');
const vercel = JSON.parse(read('vercel.json'));
const pkg = JSON.parse(read('package.json'));

// Import pure helpers from tv-mode.js (CommonJS export)
const TV = require('./tv-mode.js');

// ═══════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — Execute actual detection logic
// ═══════════════════════════════════════════════════════════════════════════════

// ─── DETECTION: Google/Android TV across brands ───────────────────────────────

test('detectTV: Chromecast with Google TV', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 12; Chromecast) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 CrKey/1.56 GoogleTV/4.0'), true);
});

test('detectTV: Sony BRAVIA Android TV', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 9; BRAVIA 4K GB ATV3 Build/PTT1) AppleWebKit/537.36 Chrome/87 Safari/537.36'), true);
});

test('detectTV: TCL Android TV (AndroidTV token)', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 11; TCL 50P635 Build/RKQ1; wv) AppleWebKit/537.36 Chrome/120 AndroidTV Safari/537.36'), true);
});

test('detectTV: Xiaomi Mi TV (MiTV token)', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 9; MiTV-AXSO0 Build/PI) AppleWebKit/537.36 Chrome/85 Mobile Safari/537.36'), true);
});

test('detectTV: Hisense VIDAA Smart TV', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; U; VIDAA U6; en-us) AppleWebKit/537.36 SmartTV/10.0 HbbTV/1.4'), true);
});

test('detectTV: NVIDIA Shield Android TV', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 12; SHIELD Android TV) AppleWebKit/537.36 Chrome/120 Safari/537.36'), true);
});

test('detectTV: Amazon Fire TV Stick (AFT token)', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 7.1.2; AFTMM Build/NS6265) AppleWebKit/537.36 Silk/112 Safari/537.36'), true);
});

test('detectTV: Samsung Tizen Smart TV', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 SamsungBrowser/5.0 TV Safari/537.36'), true);
});

test('detectTV: LG WebOS Smart TV', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/538.2 LG Browser/8.0'), true);
});

test('detectTV: Roku device', () => {
  assert.strictEqual(TV.detectTV('Roku/DVP-12.5 (12.5.0.4178-46)'), true);
});

test('detectTV: Xbox One', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Windows NT 10.0; Xbox; Xbox One) AppleWebKit/537.36 Edge/44'), true);
});

// ─── DETECTION: Must REJECT Android phones/tablets/desktops ──────────────────

test('detectTV: rejects Android phone (Pixel)', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Chrome/138 Mobile Safari/537.36'), false);
});

test('detectTV: rejects Android tablet (Samsung Galaxy Tab)', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130 Safari/537.36 Mobile'), false);
});

test('detectTV: rejects Windows desktop', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36'), false);
});

test('detectTV: rejects macOS desktop', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'), false);
});

test('detectTV: rejects Linux desktop', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36'), false);
});

test('detectTV: rejects iPhone', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'), false);
});

test('detectTV: rejects iPad', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'), false);
});

// ─── DETECTION: ?tv URL override ─────────────────────────────────────────────

test('detectTV: ?tv=1 forces TV even on desktop UA', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/138', null, '1'), true);
});

test('detectTV: ?tv=0 disables TV even on TV UA', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 12; SHIELD Android TV) Chrome/120', null, '0'), false);
});

// ─── DETECTION: userAgentData platform hints ─────────────────────────────────

test('detectTV: Chromium reduced-UA with Android TV platform', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 12) Chrome/120', { platform: 'Android TV', brands: [] }), true);
});

test('detectTV: Chromium reduced-UA with GoogleTV brand', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 12) Chrome/120', { platform: '', brands: [{ brand: 'GoogleTV' }] }), true);
});

test('detectTV: Chromium reduced-UA with normal Android platform rejected', () => {
  assert.strictEqual(TV.detectTV('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/138 Mobile', { platform: 'Android', brands: [{ brand: 'Chromium' }] }), false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — Key normalization
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizeKey: arrow keys', () => {
  assert.strictEqual(TV.normalizeKey('ArrowLeft', 37), 'left');
  assert.strictEqual(TV.normalizeKey('ArrowRight', 39), 'right');
  assert.strictEqual(TV.normalizeKey('ArrowUp', 38), 'up');
  assert.strictEqual(TV.normalizeKey('ArrowDown', 40), 'down');
});

test('normalizeKey: back keys across platforms', () => {
  assert.strictEqual(TV.normalizeKey('Escape', 27), 'back');
  assert.strictEqual(TV.normalizeKey('BrowserBack', 0), 'back');
  assert.strictEqual(TV.normalizeKey('GoBack', 0), 'back');
  assert.strictEqual(TV.normalizeKey('', 4), 'back');     // Android
  assert.strictEqual(TV.normalizeKey('', 10009), 'back'); // Tizen
  assert.strictEqual(TV.normalizeKey('', 461), 'back');   // WebOS
});

test('normalizeKey: page/channel keys', () => {
  assert.strictEqual(TV.normalizeKey('PageDown', 34), 'pagedown');
  assert.strictEqual(TV.normalizeKey('PageUp', 33), 'pageup');
  assert.strictEqual(TV.normalizeKey('ChannelDown', 428), 'pagedown');
  assert.strictEqual(TV.normalizeKey('ChannelUp', 427), 'pageup');
});

test('normalizeKey: enter/space', () => {
  assert.strictEqual(TV.normalizeKey('Enter', 13), 'enter');
  assert.strictEqual(TV.normalizeKey(' ', 32), 'space');
});

test('normalizeKey: Android TV keyCode-only D-pad and select events', () => {
  assert.strictEqual(TV.normalizeKey('', 37), 'left');
  assert.strictEqual(TV.normalizeKey('', 38), 'up');
  assert.strictEqual(TV.normalizeKey('', 39), 'right');
  assert.strictEqual(TV.normalizeKey('', 40), 'down');
  assert.strictEqual(TV.normalizeKey('', 23), 'enter'); // DPAD_CENTER
  assert.strictEqual(TV.normalizeKey('', 66), 'enter'); // Android Enter
});

test('normalizeKey: unknown key returns null', () => {
  assert.strictEqual(TV.normalizeKey('q', 81), null);
  assert.strictEqual(TV.normalizeKey('Tab', 9), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — Spatial navigation scoring
// ═══════════════════════════════════════════════════════════════════════════════

test('scoreCandidate: element to the right scores finite', () => {
  var current = { left: 100, top: 100, width: 50, height: 50 };
  var candidate = { left: 200, top: 100, width: 50, height: 50 };
  var score = TV.scoreCandidate(current, candidate, 'right');
  assert.ok(score < Infinity, 'should be reachable');
  assert.ok(score > 0, 'should have positive distance');
});

test('scoreCandidate: element to the left returns Infinity for right direction', () => {
  var current = { left: 200, top: 100, width: 50, height: 50 };
  var candidate = { left: 50, top: 100, width: 50, height: 50 };
  assert.strictEqual(TV.scoreCandidate(current, candidate, 'right'), Infinity);
});

test('scoreCandidate: cross-axis penalty increases score', () => {
  var current = { left: 100, top: 100, width: 50, height: 50 };
  var aligned = { left: 200, top: 100, width: 50, height: 50 };
  var offset = { left: 200, top: 200, width: 50, height: 50 };
  var scoreAligned = TV.scoreCandidate(current, aligned, 'right');
  var scoreOffset = TV.scoreCandidate(current, offset, 'right');
  assert.ok(scoreOffset > scoreAligned, 'cross-axis offset should increase score');
});

test('scoreCandidate: closer element scores lower', () => {
  var current = { left: 100, top: 100, width: 50, height: 50 };
  var near = { left: 200, top: 100, width: 50, height: 50 };
  var far = { left: 400, top: 100, width: 50, height: 50 };
  assert.ok(TV.scoreCandidate(current, near, 'right') < TV.scoreCandidate(current, far, 'right'));
});

test('scoreCandidate: vertical navigation', () => {
  var current = { left: 100, top: 100, width: 50, height: 50 };
  var below = { left: 100, top: 250, width: 50, height: 50 };
  var above = { left: 100, top: 10, width: 50, height: 50 };
  assert.ok(TV.scoreCandidate(current, below, 'down') < Infinity);
  assert.strictEqual(TV.scoreCandidate(current, below, 'up'), Infinity);
  assert.ok(TV.scoreCandidate(current, above, 'up') < Infinity);
  assert.strictEqual(TV.scoreCandidate(current, above, 'down'), Infinity);
});

// ═══════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — Scroll calculation
// ═══════════════════════════════════════════════════════════════════════════════

test('computeScrollTarget: scrolls down by ~78% of viewport', () => {
  var result = TV.computeScrollTarget(0, 1000, 1, 5000);
  assert.strictEqual(result.target, 780);
  assert.strictEqual(result.clamped, 780);
});

test('computeScrollTarget: scrolls up by ~78% of viewport', () => {
  var result = TV.computeScrollTarget(1000, 1000, -1, 5000);
  assert.strictEqual(result.target, 220);
  assert.strictEqual(result.clamped, 220);
});

test('computeScrollTarget: clamps to 0 when scrolling up past top', () => {
  var result = TV.computeScrollTarget(100, 1000, -1, 5000);
  assert.strictEqual(result.clamped, 0);
  assert.ok(result.target < 0);
});

test('computeScrollTarget: clamps to maxScroll when scrolling down past bottom', () => {
  var result = TV.computeScrollTarget(4800, 1000, 1, 5000);
  assert.strictEqual(result.clamped, 5000);
});

test('computeScrollTarget: uses minimum 240px for small viewports', () => {
  var result = TV.computeScrollTarget(0, 200, 1, 5000);
  assert.strictEqual(result.target, 240);
  assert.strictEqual(result.clamped, 240);
});

// ═══════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — Scroll interpolation
// ═══════════════════════════════════════════════════════════════════════════════

test('interpolateScroll: t=0 returns start', () => {
  assert.strictEqual(TV.interpolateScroll(100, 500, 0), 100);
});

test('interpolateScroll: t=1 returns end', () => {
  assert.strictEqual(TV.interpolateScroll(100, 500, 1), 500);
});

test('interpolateScroll: t=0.5 is past midpoint (easeOutCubic)', () => {
  var mid = TV.interpolateScroll(0, 1000, 0.5);
  assert.ok(mid > 500, 'easeOutCubic at 0.5 should be past linear midpoint, got ' + mid);
});

test('interpolateScroll: clamps t values outside [0,1]', () => {
  assert.strictEqual(TV.interpolateScroll(0, 100, -1), 0);
  assert.strictEqual(TV.interpolateScroll(0, 100, 2), 100);
});

test('interpolateScroll: monotonically increasing for positive direction', () => {
  var prev = 0;
  for (var t = 0; t <= 1; t += 0.1) {
    var val = TV.interpolateScroll(0, 1000, t);
    assert.ok(val >= prev, 'should be monotonically increasing');
    prev = val;
  }
});



// ═══════════════════════════════════════════════════════════════════════════════
// CSS CASCADE TESTS — Parse and verify overlay hidden/open rules
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: extract all rule blocks for a given selector pattern
function extractRules(css, selectorPattern) {
  var results = [];
  var lines = css.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].match(selectorPattern)) {
      var block = '';
      var braceCount = 0;
      for (var j = i; j < lines.length; j++) {
        block += lines[j] + '\n';
        braceCount += (lines[j].match(/\{/g) || []).length;
        braceCount -= (lines[j].match(/\}/g) || []).length;
        if (braceCount <= 0 && block.includes('{')) break;
      }
      results.push({ selector: lines[i].trim(), block: block });
    }
  }
  return results;
}

test('tv-mode.css: #modal-overlay closed has NO display:block', () => {
  // Find rules that target #modal-overlay WITHOUT .open
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+#modal-overlay\s*\{/);
  for (var r of rules) {
    if (!r.selector.includes('.open')) {
      assert.ok(!r.block.includes('display: block') && !r.block.includes('display:block'),
        'Closed modal-overlay must NOT have display:block. Found: ' + r.block);
    }
  }
});

test('tv-mode.css: #modal-overlay.open has display:block', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+#modal-overlay\.open/);
  assert.ok(rules.length > 0, 'should have .open rule');
  var hasDisplay = rules.some(r => r.block.includes('display: block') || r.block.includes('display:block'));
  assert.ok(hasDisplay, '#modal-overlay.open should have display:block');
});

test('tv-mode.css: .upcoming-detail-overlay closed has NO visibility override', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+\.upcoming-detail-overlay\s*\{/);
  for (var r of rules) {
    if (!r.selector.includes('.open')) {
      assert.ok(!r.block.includes('visibility: visible'), 'Closed upcoming-detail must not force visible');
      assert.ok(!r.block.includes('opacity: 1'), 'Closed upcoming-detail must not force opacity:1');
    }
  }
});

test('tv-mode.css: .upcoming-detail-overlay.open has visibility:visible', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+\.upcoming-detail-overlay\.open/);
  assert.ok(rules.length > 0, 'should have .open rule');
  assert.ok(rules.some(r => r.block.includes('visibility: visible')));
});

test('tv-mode.css: .collections-hub-overlay closed has NO display override', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+\.collections-hub-overlay\s*\{/);
  for (var r of rules) {
    if (!r.selector.includes('.open')) {
      assert.ok(!r.block.includes('display: flex') && !r.block.includes('display: block'),
        'Closed collections-hub must not force display');
    }
  }
});

test('tv-mode.css: .collections-hub-overlay.open has display:flex', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+\.collections-hub-overlay\.open/);
  assert.ok(rules.length > 0, 'should have .open rule');
  assert.ok(rules.some(r => r.block.includes('display: flex')));
});

test('tv-mode.css: #pwa-install-overlay closed has NO display override', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+#pwa-install-overlay\s*\{/);
  for (var r of rules) {
    if (!r.selector.includes('.open')) {
      assert.ok(!r.block.includes('display: flex') && !r.block.includes('display: block'),
        'Closed pwa-install must not force display');
    }
  }
});

test('tv-mode.css: #pwa-install-overlay.open has display:flex', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+#pwa-install-overlay\.open/);
  assert.ok(rules.length > 0, 'should have .open rule');
  assert.ok(rules.some(r => r.block.includes('display: flex')));
});

test('tv-mode.css: #pwa-install-tv-overlay closed has NO display override', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+#pwa-install-tv-overlay\s*\{/);
  for (var r of rules) {
    if (!r.selector.includes('.open')) {
      assert.ok(!r.block.includes('display: flex') && !r.block.includes('display: block'),
        'Closed pwa-install-tv must not force display');
    }
  }
});

test('tv-mode.css: #pwa-install-tv-overlay.open has display:flex', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+#pwa-install-tv-overlay\.open/);
  assert.ok(rules.length > 0, 'should have .open rule');
  assert.ok(rules.some(r => r.block.includes('display: flex')));
});

// ─── CSS SCOPING: Every selector must be under html[data-mz-tv="true"] ────────

test('tv-mode.css: all selectors scoped to html[data-mz-tv="true"] (except media/comments)', () => {
  var lines = tvCss.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    // Skip empty, comments, closing braces, media queries, @-rules
    if (!line || line.startsWith('/*') || line.startsWith('*') || line === '}' ||
        line.startsWith('@media') || line.startsWith('@keyframes') || line.startsWith('//')) continue;
    // If it looks like a selector (has { at end or next line)
    if (line.match(/^[a-zA-Z#.:[\s]/) && line.includes('{')) {
      // Must start with html[data-mz-tv
      assert.ok(line.startsWith('html[data-mz-tv="true"]'),
        'Unscoped selector at line ' + (i+1) + ': ' + line);
    }
  }
});

// ─── CSS CASCADE: moviezone.css loads before tv-mode.css ──────────────────────

test('index.html: moviezone.css loads BEFORE tv-mode.css (cascade order)', () => {
  var mzCssIdx = html.indexOf('href="moviezone.css');
  var tvCssIdx = html.indexOf('href="tv-mode.css');
  // Only check stylesheet links, not preloads
  var mzStylesheet = html.indexOf('<link rel="stylesheet" href="moviezone.css');
  var tvStylesheet = html.indexOf('<link rel="stylesheet" href="tv-mode.css');
  assert.ok(mzStylesheet > -1, 'moviezone.css stylesheet found');
  assert.ok(tvStylesheet > -1, 'tv-mode.css stylesheet found');
  assert.ok(mzStylesheet < tvStylesheet, 'moviezone.css must load before tv-mode.css');
});

// ═══════════════════════════════════════════════════════════════════════════════
// TV LOGO ASSET TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test('index.html: TV navbar logo uses existing moviezone-logo.png with explicit dimensions', () => {
  assert.ok(html.includes('class="nav-logo-tv"'), 'nav-logo-tv class present');
  assert.ok(html.includes('src="/moviezone-logo.png"'), 'uses existing MZ logo asset');
  assert.ok(html.includes('width="40"') && html.includes('height="40"'), 'explicit width/height on nav logo');
});

test('index.html: TV loader logo uses existing moviezone-logo.png with explicit dimensions', () => {
  assert.ok(html.includes('class="loader-logo-tv"'), 'loader-logo-tv class present');
  assert.ok(html.includes('width="80"') && html.includes('height="80"'), 'explicit width/height on loader logo');
});

test('tv-mode.css: shows nav-logo-tv on TV', () => {
  assert.ok(tvCss.includes('.nav-logo-tv'), 'nav-logo-tv styled in tv-mode.css');
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+\.nav-logo-tv/);
  assert.ok(rules.some(r => r.block.includes('display: inline-block') || r.block.includes('display:inline-block')),
    'nav-logo-tv displayed on TV');
});

test('tv-mode.css: shows loader-logo-tv on TV', () => {
  assert.ok(tvCss.includes('.loader-logo-tv'), 'loader-logo-tv styled in tv-mode.css');
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+\.loader-logo-tv/);
  assert.ok(rules.some(r => r.block.includes('display: block') || r.block.includes('display:block')),
    'loader-logo-tv displayed on TV');
});

test('tv-mode.css: hides legacy loader icon on TV', () => {
  var rules = extractRules(tvCss, /html\[data-mz-tv="true"\]\s+\.mz-loader-brand\s+\.loader-icon/);
  assert.ok(rules.some(r => r.block.includes('display: none') || r.block.includes('display:none')),
    'legacy loader icon hidden');
});

test('moviezone.css: TV logo images hidden by default (non-TV)', () => {
  assert.ok(moviezoneCss.includes('.nav-logo-tv'), 'nav-logo-tv in base CSS');
  assert.ok(moviezoneCss.includes('.loader-logo-tv'), 'loader-logo-tv in base CSS');
  assert.ok(moviezoneCss.includes('display: none'), 'hidden by default');
});



// ═══════════════════════════════════════════════════════════════════════════════
// API STRUCTURE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test('MovieZoneTV CommonJS exports all required pure helpers', () => {
  assert.strictEqual(typeof TV.detectTV, 'function', 'detectTV');
  assert.strictEqual(typeof TV.normalizeKey, 'function', 'normalizeKey');
  assert.strictEqual(typeof TV.scoreCandidate, 'function', 'scoreCandidate');
  assert.strictEqual(typeof TV.computeScrollTarget, 'function', 'computeScrollTarget');
  assert.strictEqual(typeof TV.interpolateScroll, 'function', 'interpolateScroll');
});

test('tv-mode.js exposes window.MovieZoneTV API in browser', () => {
  assert.ok(tvJs.includes('root.MovieZoneTV = api'), 'assigns to window.MovieZoneTV');
});

test('tv-mode.js API has isActive method', () => {
  assert.ok(tvJs.includes('isActive: function()'), 'isActive method');
});

test('tv-mode.js API has configure method', () => {
  assert.ok(tvJs.includes('configure: function(opts)'), 'configure method');
});

test('tv-mode.js API has cleanup and init methods', () => {
  assert.ok(tvJs.includes('cleanup: function()'), 'cleanup method');
  assert.ok(tvJs.includes('init: function()'), 'init method');
});

test('tv-mode.js registers named listeners that cleanup removes', () => {
  for (const handler of ['handleKeyDown', 'handleKeyUp', 'handleFocus']) {
    assert.ok(tvJs.includes(`function ${handler}`), `${handler} is named`);
  }
  assert.strictEqual((tvJs.match(/addEventListener\('keydown', handleKeyDown\)/g) || []).length, 1, 'keydown registered once');
  assert.strictEqual((tvJs.match(/addEventListener\('keyup', handleKeyUp\)/g) || []).length, 1, 'keyup registered once');
  assert.strictEqual((tvJs.match(/addEventListener\('focus', handleFocus, true\)/g) || []).length, 1, 'focus registered once');
  assert.ok(tvJs.includes("removeEventListener('keydown', handleKeyDown)"), 'keydown removed');
  assert.ok(tvJs.includes("removeEventListener('keyup', handleKeyUp)"), 'keyup removed');
  assert.ok(tvJs.includes("removeEventListener('focus', handleFocus, true)"), 'focus removed');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCROLLING IMPLEMENTATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test('tv-mode.js: activeScrollAnimation is assigned during RAF scrolling', () => {
  assert.ok(tvJs.includes('activeScrollAnimation = requestAnimationFrame(animateFrame)'), 'assigns RAF id');
});

test('tv-mode.js: cancel on new navigation', () => {
  // cancelTVScroll is called in focusAndRevealTVTarget
  assert.ok(tvJs.includes('function focusAndRevealTVTarget'));
  var focusFnStart = tvJs.indexOf('function focusAndRevealTVTarget');
  var focusFnSlice = tvJs.substring(focusFnStart, focusFnStart + 300);
  assert.ok(focusFnSlice.includes('cancelTVScroll()'), 'cancels scroll on new navigation');
});

test('tv-mode.js: uses instant fallback for reduced-motion/low-power', () => {
  assert.ok(tvJs.includes('prefers-reduced-motion: reduce'), 'checks reduced motion');
  assert.ok(tvJs.includes('navigator.deviceMemory'), 'checks device memory');
  assert.ok(tvJs.includes('shouldUseInstantScroll'), 'instant fallback function');
});

test('tv-mode.js: supports document and overlay scroll owners', () => {
  assert.ok(tvJs.includes('function getTVScrollContainer'), 'getTVScrollContainer');
  assert.ok(tvJs.includes("getElementById('chScroll')"), 'chScroll container');
  assert.ok(tvJs.includes('scrollingElement'), 'document fallback');
  assert.ok(tvJs.includes('function getScrollOwnerInfo'), 'getScrollOwnerInfo helper');
});

test('tv-mode.js: interpolates/clamps vertical scroll', () => {
  assert.ok(tvJs.includes('interpolateScroll(startPos, endPos, t)'), 'uses interpolateScroll');
  assert.ok(tvJs.includes('computeScrollTarget'), 'uses computeScrollTarget');
});

// ═══════════════════════════════════════════════════════════════════════════════
// BACK HIERARCHY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test('tv-mode.js: back hierarchy checks fullscreen first', () => {
  var backFn = tvJs.substring(tvJs.indexOf('function handleBackKey'));
  var fullscreenIdx = backFn.indexOf('isFullscreen');
  var modalIdx = backFn.indexOf('modal-overlay');
  assert.ok(fullscreenIdx < modalIdx, 'fullscreen checked before modal');
});

test('tv-mode.js: back hierarchy order is fullscreen > modal > upcoming > collections > pwaTv > pwa > search > home', () => {
  var backFn = tvJs.substring(tvJs.indexOf('function handleBackKey'));
  var order = [
    'isFullscreen',
    'modal-overlay',
    'upcoming-detail-overlay',
    'collections-hub-overlay',
    'pwa-install-tv-overlay',
    'pwa-install-overlay',
    'searchDropdown',
    'isSearchResultsMode'
  ];
  var prevIdx = -1;
  for (var item of order) {
    var idx = backFn.indexOf(item);
    assert.ok(idx > prevIdx, item + ' should come after previous in back hierarchy');
    prevIdx = idx;
  }
});

test('tv-mode.js: uses configure callbacks instead of window state properties', () => {
  assert.ok(tvJs.includes('_callbacks.isSearchResultsMode'), 'uses callback for search results');
  assert.ok(tvJs.includes('_callbacks.isFullViewMovies'), 'uses callback for full view movies');
  assert.ok(tvJs.includes('_callbacks.closeModal'), 'uses callback for closeModal');
  assert.ok(tvJs.includes('_callbacks.goHome'), 'uses callback for goHome');
});

test('tv-mode.js: restores source focus after modal close', () => {
  assert.ok(tvJs.includes('_lastFocusBeforeModal'), 'tracks last focus before modal');
  assert.ok(tvJs.includes('_lastFocusBeforeModal.focus()'), 'restores focus');
});

test('moviezone.js: registers MovieZoneTV.configure callbacks', () => {
  assert.ok(moviezone.includes('MovieZoneTV.configure'), 'calls configure');
  assert.ok(moviezone.includes('isSearchResultsMode: function()'), 'passes isSearchResultsMode');
  assert.ok(moviezone.includes('isFullViewMovies: function()'), 'passes isFullViewMovies');
  assert.ok(moviezone.includes('isFullViewUpcoming: function()'), 'passes isFullViewUpcoming');
  assert.ok(moviezone.includes('closeModal: function()'), 'passes closeModal');
  assert.ok(moviezone.includes('closeDropdown: function()'), 'passes closeDropdown');
  assert.ok(moviezone.includes('goHome: function()'), 'passes goHome');
  assert.ok(moviezone.includes('handleCollectionsBack: function()'), 'passes collections Back handler');
  assert.ok(moviezone.includes('isFullscreen: function()'), 'passes fullscreen state');
  assert.ok(moviezone.includes('exitFullscreen: function()'), 'passes fullscreen exit');
});

test('tv-mode.js: Back has native fullscreen and direct PWA close fallbacks', () => {
  assert.ok(tvJs.includes('document.exitFullscreen()'), 'native fullscreen exit fallback');
  assert.ok(tvJs.includes('document.webkitExitFullscreen()'), 'WebKit fullscreen exit fallback');
  assert.ok(tvJs.includes("pwaTvOverlay.classList.remove('open')"), 'TV PWA closes directly');
  assert.ok(tvJs.includes("pwaOverlay.classList.remove('open')"), 'standard PWA closes directly');
  assert.ok(tvJs.includes("document.body.style.overflow = ''"), 'body scrolling restored');
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXISTING STATIC ASSERTIONS (retained, no-legacy checks)
// ═══════════════════════════════════════════════════════════════════════════════

test('tv-mode.js sets data-mz-tv attribute', () => {
  assert.ok(tvJs.includes("setAttribute('data-mz-tv', 'true')"), 'should set data-mz-tv');
});

test('tv-mode.js detects Google TV UA', () => {
  assert.ok(tvJs.includes('GoogleTV'), 'GoogleTV pattern present');
  assert.ok(tvJs.includes('Google TV'), 'Google TV pattern present');
});

test('tv-mode.js detects Android TV UA', () => {
  assert.ok(tvJs.includes('Android TV'), 'Android TV pattern present');
  assert.ok(tvJs.includes('AndroidTV'), 'AndroidTV pattern present');
});

test('tv-mode.js supports full UA matrix (Fire/Tizen/WebOS/Roku/BRAVIA/Xbox/Chromecast)', () => {
  const patterns = ['AFT', 'Fire TV', 'Tizen', 'WebOS', 'Web0S', 'Roku', 'BRAVIA', 'Xbox', 'CrKey', 'Chromecast'];
  for (const p of patterns) {
    assert.ok(tvJs.includes(p), `${p} pattern present`);
  }
});

test('tv-mode.js supports ?tv=1 and ?tv=0 overrides', () => {
  assert.ok(tvJs.includes("tvParam === '1'") || tvJs.includes("urlTvParam === '1'"), '?tv=1 support');
  assert.ok(tvJs.includes("tvParam === '0'") || tvJs.includes("urlTvParam === '0'"), '?tv=0 support');
});

test('tv-mode.js implements D-pad navigation', () => {
  assert.ok(tvJs.includes('ArrowLeft'), 'ArrowLeft');
  assert.ok(tvJs.includes('ArrowRight'), 'ArrowRight');
  assert.ok(tvJs.includes('ArrowUp'), 'ArrowUp');
  assert.ok(tvJs.includes('ArrowDown'), 'ArrowDown');
});

test('tv-mode.js implements Page/Channel keys', () => {
  assert.ok(tvJs.includes('PageDown'), 'PageDown');
  assert.ok(tvJs.includes('PageUp'), 'PageUp');
  assert.ok(tvJs.includes('ChannelDown'), 'ChannelDown');
  assert.ok(tvJs.includes('ChannelUp'), 'ChannelUp');
  assert.ok(tvJs.includes('428'), 'ChannelDown keyCode');
  assert.ok(tvJs.includes('427'), 'ChannelUp keyCode');
});

test('tv-mode.js implements Back key support for all TV platforms', () => {
  assert.ok(tvJs.includes("'BrowserBack'"), 'BrowserBack');
  assert.ok(tvJs.includes('4'), 'Android back keycode');
  assert.ok(tvJs.includes('10009'), 'Tizen back');
  assert.ok(tvJs.includes('461'), 'WebOS back');
  assert.ok(tvJs.includes("'Escape'"), 'Escape');
});

test('tv-mode.js implements cancellable scrolling', () => {
  assert.ok(tvJs.includes('cancelTVScroll'), 'cancelTVScroll function');
  assert.ok(tvJs.includes('cancelAnimationFrame'), 'uses cancelAnimationFrame');
  assert.ok(tvJs.includes('activeScrollAnimation'), 'tracks active animation');
});

test('tv-mode.js removes Hollywood/South from DOM/focus order', () => {
  assert.ok(tvJs.includes('[data-tv-hide]'), 'targets data-tv-hide elements');
  assert.ok(tvJs.includes("tabindex', '-1'"), 'sets tabindex -1');
  assert.ok(tvJs.includes("aria-hidden', 'true'"), 'sets aria-hidden');
});

test('tv-mode.js supports spatial navigation with findNearest', () => {
  assert.ok(tvJs.includes('function findNearest'), 'findNearest function');
  assert.ok(tvJs.includes('primaryDist'), 'weighted distance algorithm');
  assert.ok(tvJs.includes('crossDist'), 'cross axis penalty');
});

test('tv-mode.js supports focus reveal with legacy scrollIntoView', () => {
  assert.ok(tvJs.includes('function focusAndRevealTVTarget'), 'focusAndRevealTVTarget');
  assert.ok(tvJs.includes("target.scrollIntoView(direction !== 'up')"), 'legacy boolean signature');
});

test('tv-mode.js integrates with detailActivationGuard', () => {
  assert.ok(tvJs.includes('window.armTVDetailActivation'), 'accesses global armTVDetailActivation');
  assert.ok(tvJs.includes('window.detailActivationGuard'), 'accesses global detailActivationGuard');
});

test('tv-mode.js removes heavy effects on TV', () => {
  assert.ok(tvJs.includes('ambient-particles'), 'removes particles');
  assert.ok(tvJs.includes('cursor-glow'), 'hides cursor glow');
});

test('tv-mode.css has 720p responsive styles', () => {
  assert.ok(tvCss.includes('max-width: 1280px'), '720p breakpoint');
});

test('tv-mode.css has 4K responsive styles', () => {
  assert.ok(tvCss.includes('min-width: 2500px'), '4K breakpoint');
});

test('tv-mode.css hides data-tv-hide elements', () => {
  assert.ok(tvCss.includes('[data-tv-hide]'), 'hides TV-hidden items');
  assert.ok(tvCss.includes('display: none !important'), 'with display:none');
});

test('tv-mode.css disables heavy effects', () => {
  assert.ok(tvCss.includes('animation: none !important'), 'disables animations');
  assert.ok(tvCss.includes('backdrop-filter: none !important'), 'disables backdrop-filter');
  assert.ok(tvCss.includes('box-shadow: none !important'), 'disables shadows');
});

test('tv-mode.css has D-pad focus outline styles', () => {
  assert.ok(tvCss.includes('outline: 1px solid rgba(255, 193, 7'), 'gold outline');
  assert.ok(tvCss.includes('outline-offset: 1px'), 'outline offset');
});

test('tv-mode.css forces instant scrolling', () => {
  assert.ok(tvCss.includes('scroll-behavior: auto !important'), 'auto scroll behavior');
});

// ─── MOVIEZONE.JS NO LEGACY TV SIGNATURES ─────────────────────────────────────

test('moviezone.js has no standalone or ambiguous isTV variable', () => {
  assert.ok(!moviezone.includes('const isTV = (() =>'), 'no const isTV IIFE');
  assert.ok(!moviezone.includes("const isTV = (function"), 'no const isTV function');
  assert.ok(!/\b(?:const|let|var)\s+isTV\b/.test(moviezone), 'no isTV device/content variable');
  assert.ok(moviezone.includes("const isSeries = currentModalMovie.media_type === 'tv'"), 'series media flag is explicit');
});

test('moviezone.js has no initTVNavigation', () => {
  assert.ok(!moviezone.includes('initTVNavigation'), 'no initTVNavigation');
});

test('moviezone.js has no .tv-mode class references', () => {
  const lines = moviezone.split('\n');
  for (const line of lines) {
    if (line.includes('.tv-mode') || line.includes("classList.contains('tv-mode')")) {
      if (!line.trim().startsWith('//') && !line.includes('tv-mode.js') && !line.includes('tv-mode.css')) {
        assert.fail(`Found .tv-mode reference in moviezone.js: ${line.trim()}`);
      }
    }
  }
});

test('moviezone.js has no isTVNavigationMode', () => {
  assert.ok(!moviezone.includes('isTVNavigationMode'), 'no isTVNavigationMode');
});

test('moviezone.js uses isMzTVMode() for scroll behavior', () => {
  assert.ok(moviezone.includes("behavior: isMzTVMode() ? 'auto' : 'smooth'"), 'conditional scroll');
});

test('moviezone.js isMzTVMode checks data-mz-tv', () => {
  assert.ok(moviezone.includes("getAttribute('data-mz-tv') === 'true'"), 'data attribute check');
});

test('moviezone.js exposes detailActivationGuard globally for tv-mode.js', () => {
  assert.ok(moviezone.includes('window.detailActivationGuard = detailActivationGuard'), 'exposed globally');
  assert.ok(moviezone.includes('window.armTVDetailActivation = armTVDetailActivation'), 'arm exposed');
});

test('moviezone.js still has isMzTVMode for MAX_CARDS_TV', () => {
  assert.ok(moviezone.includes('if (isMzTVMode()) return MAX_CARDS_TV;'), 'MAX_CARDS_TV guard');
});

test('moviezone.js preserves data-tv-hide in mobile panel clone', () => {
  assert.ok(moviezone.includes("a.closest('[data-tv-hide]') ? ' data-tv-hide' : ''"), 'tv-hide in mobile clone');
});

test('moviezone.css has no .tv-mode selectors', () => {
  assert.ok(!moviezoneCss.includes('.tv-mode'), 'no .tv-mode in moviezone.css');
});

test('pwa-install.js uses isMzTV shared state helper (no duplicate detector)', () => {
  assert.ok(pwa.includes('function isMzTV()'), 'explicit shared-state helper');
  assert.ok(pwa.includes("getAttribute('data-mz-tv') === 'true'"), 'reads data attribute');
  assert.ok(!pwa.includes('function isTV('), 'no legacy isTV helper');
  assert.ok(!pwa.includes('smart-tv|smarttv'), 'no duplicate UA regex');
});

// ─── INDEX.HTML INTEGRATION ───────────────────────────────────────────────────

test('index.html loads tv-mode.css', () => {
  assert.ok(html.includes('tv-mode.css?v=1.0'), 'tv-mode.css loaded');
});

test('index.html loads tv-mode.js before moviezone.js', () => {
  const tvJsIdx = html.indexOf('tv-mode.js?v=1.0');
  const mzJsIdx = html.indexOf('moviezone.js?v=5.0');
  assert.ok(tvJsIdx > -1, 'tv-mode.js referenced');
  assert.ok(tvJsIdx < mzJsIdx, 'tv-mode.js loads before moviezone.js');
});

test('index.html has data-tv-hide on Hollywood and South nav items', () => {
  assert.ok(html.includes("data-tv-hide><a href=\"#\" onclick=\"filterCat('hollywood'"), 'Hollywood marked');
  assert.ok(html.includes("data-tv-hide><a href=\"#\" onclick=\"filterCat('south'"), 'South marked');
});

// ─── SW CACHE INTEGRATION ─────────────────────────────────────────────────────

test('sw.js caches tv-mode.css', () => {
  assert.ok(sw.includes("'/tv-mode.css?v=1.0'"), 'tv-mode.css in cache');
});

test('sw.js caches tv-mode.js', () => {
  assert.ok(sw.includes("'/tv-mode.js?v=1.0'"), 'tv-mode.js in cache');
});

// ─── VERCEL INTEGRATION ───────────────────────────────────────────────────────

test('vercel.json includes tv-mode in static JS builds', () => {
  const jsStatic = vercel.builds.find(b => b.use === '@vercel/static' && b.src.includes('tv-mode'));
  assert.ok(jsStatic, 'tv-mode in vercel static builds');
});

// ─── PACKAGE.JSON BUILD INTEGRATION ───────────────────────────────────────────

test('package.json build includes tv-mode minification', () => {
  assert.ok(pkg.scripts.build.includes('tv-mode.css'), 'CSS minification');
  assert.ok(pkg.scripts.build.includes('tv-mode.js'), 'JS minification');
});

test('package.json test script runs tv-mode tests', () => {
  assert.ok(pkg.scripts.test.includes('tv-mode.test.js'), 'test script included');
});

// ─── PLAYER SOURCES / LOADPLAYER BOUNDARY ─────────────────────────────────────

test('playerSources block is unchanged (no TV code interference)', () => {
  assert.ok(moviezone.includes("{ name: '4K Ultra HD', dubbed: true, is4K: true"), 'first source intact');
  assert.ok(moviezone.includes("{ name: 'Cinextream', dubbed: true, is4K: true"), 'second source intact');
  assert.ok(moviezone.includes("{ name: 'VidPhantom Pro', dubbed: true"), 'third source intact');
  assert.ok(moviezone.includes("{ name: 'Pro Stream', dubbed: true"), 'fourth source intact');
  assert.ok(moviezone.includes("{ name: 'VidNest', dubbed: true"), 'fifth source intact');
  assert.ok(moviezone.includes("{ name: 'Ultra HD', dubbed: true"), 'sixth source intact');
  assert.ok(moviezone.includes("{ name: 'Flicky Stream', dubbed: true"), 'seventh source intact');
  assert.ok(moviezone.includes("{ name: 'Premium Mirror', dubbed: true"), 'eighth source intact');
});

test('loadPlayer function signature unchanged', () => {
  assert.ok(moviezone.includes("function loadPlayer(id, srcIdx, lang, quality, type = 'movie')"), 'signature intact');
});

test('iframe sandbox line unchanged', () => {
  assert.ok(moviezone.includes("iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation')"), 'sandbox intact');
});

test('loadPlayer fallback behavior preserved', () => {
  assert.ok(moviezone.includes('const bestDubIdx = playerSources.findIndex(s => s.dubbed === true)'), 'dubbed fallback');
  assert.ok(moviezone.includes('if (DUBBED_LANG_LIST.includes(lang) && playerSources[srcIdx] && !playerSources[srcIdx].dubbed)'), 'lang switch logic');
});
