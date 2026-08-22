
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

const checks = [];
function check(name, fn) {
  try { fn(); checks.push({ name, pass: true, detail: '' }); }
  catch (err) { checks.push({ name, pass: false, detail: err.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function equal(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg + ' (got ' + JSON.stringify(actual) + ')');
}

/*  ── load the real gate ──
 *  The block is identified by the UNITS declaration rather than by position, so
 *  moving it inside <head> does not break the extraction. */
const start = html.indexOf('  var POP_CAP_KEY = ');
assert(start > 0, 'the ad block was not found in index.html');
const end = html.indexOf('</script>', start);
assert(end > start, 'the ad block is not closed');
// Stop before the IIFE's own closing `})();` — the body is re-wrapped below.
const close = html.lastIndexOf('})();', end);
assert(close > start, 'the ad IIFE closing was not found');
const block = html.slice(start, close);

/** A fresh sandbox per run, so no state leaks between branches.
 *  Models just enough DOM to observe what the loader actually does: what it
 *  appended, what it observed, and what class it put on <html>. */
function run(ua, host, tvAttr, store) {
  const appended = [];
  const observed = [];
  const domReady = [];
  const el = { className: '', childElementCount: 0, children: [] };
  const slot = { className: 'mz-ad-slot' };
  const bag = store || {};

  const sandbox = {
    navigator: { userAgent: ua },
    location: { hostname: host },
    localStorage: {
      getItem: (k) => (k in bag ? bag[k] : null),
      setItem: (k, v) => { bag[k] = String(v); },
      removeItem: (k) => { delete bag[k]; }
    },
    document: {
      readyState: 'loading',
      documentElement: {
        className: '',
        getAttribute: () => (tvAttr ? 'true' : null)
      },
      body: { appendChild: (e) => appended.push(e) },
      head: { appendChild: (e) => appended.push(e) },
      createElement: () => ({ setAttribute(k, v) { this[k] = v; } }),
      querySelector: () => slot,
      getElementById: () => el,
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domReady.push(fn); }
    },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout: () => 0
  };

  // Fake observers that hand the trigger back to the test.
  const io = { entries: null, disconnected: false, opts: null, targets: [] };
  sandbox.IntersectionObserver = function (cb, opts) {
    io.opts = opts;
    return {
      observe: (t) => { io.targets.push(t); io.entries = cb; },
      disconnect: () => { io.disconnected = true; }
    };
  };
  const mo = { cb: null };
  sandbox.MutationObserver = function (cb) {
    mo.cb = cb;
    return { observe: () => {}, disconnect: () => {} };
  };
  sandbox.window.IntersectionObserver = sandbox.IntersectionObserver;
  sandbox.window.MutationObserver = sandbox.MutationObserver;

  vm.createContext(sandbox);
  vm.runInContext('(function(){\n' + block + '\n})();', sandbox);

  return {
    ads: sandbox.window.__mzAds,
    appended,
    observed,
    io,
    mo,
    slot,
    container: el,
    store: bag,
    htmlClass: () => sandbox.document.documentElement.className,
    /** Fire DOMContentLoaded, which is when inline slots start being watched. */
    ready() { sandbox.document.readyState = 'interactive'; domReady.forEach((fn) => fn()); return this; },
    /** Scroll the slot into range. */
    intersect() { if (io.entries) io.entries([{ isIntersecting: true }]); return this; },
    /** Let the ad network write into the container. */
    fillContainer() { el.childElementCount = 1; if (mo.cb) mo.cb(); return this; }
  };
}

const ads = run('node', 'example.test', false).ads;

console.log('\nAdsterra ad layer — gate, timing and service-worker bypass');
console.log('-'.repeat(70));

check('the ad layer exports a decidable gate', () => {
  assert(ads, 'window.__mzAds was never assigned');
  assert(typeof ads.decide === 'function', 'decide() is not exported, so no branch is assertable');
  assert(typeof ads.load === 'function', 'load() is not exported');
});

check('all three Adsterra units are configured', () => {
  assert(Array.isArray(ads.state.units), 'the unit list is not exported');
  ['popunder', 'socialbar', 'native'].forEach((n) => {
    assert(ads.state.units.indexOf(n) !== -1, n + ' is not declared — that unit would earn nothing');
  });
});

check('nothing is requested while <head> is still parsing', () => {
  equal(ads.state.injected.length, 0, 'a unit was injected during parsing — that is the critical path');
});

check('the gate decides before first paint, so the reserved slot can collapse', () => {
  assert(ads.state.profile, 'the gate had not run by the end of the block; the ~300px reservation '
    + 'would then be a permanent hole for TV/crawler/dev visitors');
});

/*  ── the branches ── */
const PROD = { units: true, local: false, crawler: false, tv: false };

check('a real visitor gets ads', () => {
  const d = ads.decide(PROD);
  equal(d.enabled, true, 'a normal visitor was gated out — this is lost revenue');
  equal(d.reason, 'ok', 'unexpected reason');
});

check('a dev machine serves no ads', () => {
  const d = ads.decide(Object.assign({}, PROD, { local: true }));
  equal(d.enabled, false, 'localhost would serve live ads — that is invalid traffic');
  equal(d.reason, 'dev', 'unexpected reason');
});

check('a real crawler gets no ads', () => {
  const d = ads.decide(Object.assign({}, PROD, { crawler: true }));
  equal(d.enabled, false, 'a bot would be served ads it can never click');
  equal(d.reason, 'crawler', 'unexpected reason');
});

check('a TV gets no ads', () => {
  const d = ads.decide(Object.assign({}, PROD, { tv: true }));
  equal(d.enabled, false, 'a popunder on a TV cannot be closed with a D-pad');
  equal(d.reason, 'tv', 'unexpected reason');
});

check('an empty unit list is handled, not assumed away', () => {
  const d = ads.decide(Object.assign({}, PROD, { units: false }));
  equal(d.enabled, false, 'the loader would run with nothing to load');
  equal(d.reason, 'no-units', 'unexpected reason');
});

check('dev is checked before crawler and TV, so a dev TV/bot still reports dev', () => {
  equal(ads.decide({ units: true, local: true, crawler: true, tv: true }).reason, 'dev',
    'branch order changed; the dev branch must win so local runs are never ambiguous');
});

/*  ── the env reader: the real UA/host strings, through the real regexes ── */
function envFor(ua, host, tvAttr) {
  const r = run(ua, host, tvAttr);
  r.ads.load();
  return r;
}

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/125.0.0.0 Safari/537.36';
const TIZEN = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.0 TV Safari/537.36';
const LIGHTHOUSE = 'Mozilla/5.0 (Linux; Android 11; moto g power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse';

check('production desktop Chrome: the click-activated units are injected', () => {
  const { ads: a, appended } = envFor(CHROME, 'moviezone.dev', false);
  equal(a.state.profile.reason, 'ok', 'gated out in production');
  assert(a.state.injected.length > 0, 'nothing was injected for a real visitor');
  equal(appended.length, a.state.injected.length, 'the DOM and the bookkeeping disagree');
  appended.forEach((el) => {
    assert(/^https:\/\//.test(el.src), 'a unit was injected over plain http: ' + el.src);
    equal(el.async, true, 'the injected script is not async');
    assert(typeof el.onerror === 'function', 'no onerror on the injected script');
  });
});

check('popunder and Social Bar are both on the idle path', () => {
  const { ads: a } = envFor(CHROME, 'moviezone.dev', false);
  equal(a.state.injected.indexOf('popunder') !== -1, true, 'popunder was not loaded');
  equal(a.state.injected.indexOf('socialbar') !== -1, true, 'Social Bar was not loaded');
});

check('the Native Banner is NOT loaded by the idle path', () => {
  const { ads: a, appended } = envFor(CHROME, 'moviezone.dev', false);
  equal(a.state.injected.indexOf('native'), -1,
    'the inline unit loaded on a timer instead of on approach — an impression 800px below the fold is one nobody saw');
  assert(!appended.some((el) => /invoke\.js/.test(el.src)), 'invoke.js was injected too early');
});

check('the Native Banner loads when its slot comes near the viewport', () => {
  const r = run(CHROME, 'moviezone.dev', false).ready();
  assert(r.io.targets.length === 1, 'the slot is not being observed at all');
  assert(!r.appended.some((el) => /invoke\.js/.test(el.src)),
    'invoke.js was injected on DOMContentLoaded rather than on approach');

  r.intersect();
  const native = r.appended.filter((el) => /invoke\.js/.test(el.src));
  equal(native.length, 1, 'invoke.js was not injected when the slot came into range');
  equal(r.ads.state.injected.indexOf('native') !== -1, true, 'the native unit was not recorded');
  equal(r.io.disconnected, true, 'the observer keeps running after firing');
});

check('the slot is loaded before it is actually seen, not once it is', () => {
  const r = run(CHROME, 'moviezone.dev', false).ready();
  assert(r.io.opts && /^\d+px$/.test(String(r.io.opts.rootMargin)),
    'no rootMargin, so the banner starts loading only once it is already on screen');
  assert(parseInt(r.io.opts.rootMargin, 10) >= 200,
    'rootMargin is only ' + r.io.opts.rootMargin + ' — too late to have rendered by the time it is read');
});

check('invoke.js carries data-cfasync="false", as Adsterra ships it', () => {
  const r = run(CHROME, 'moviezone.dev', false).ready().intersect();
  const native = r.appended.filter((el) => /invoke\.js/.test(el.src))[0];
  assert(native, 'invoke.js was never injected');
  equal(native['data-cfasync'], 'false',
    'without it Cloudflare Rocket Loader may rewrite the tag');
});

check('a TV is not served ads even if it is only recognised later', () => {
  // UA looks like a normal browser; tv-mode.js has set the attribute by now.
  const r = run(CHROME, 'moviezone.dev', true).ready().intersect();
  equal(r.appended.length, 0, 'a unit was injected on a device tv-mode.js had flagged as a TV');
});

check('the "Sponsored" label appears only once the widget has rendered', () => {
  const r = run(CHROME, 'moviezone.dev', false).ready().intersect();
  assert(!/is-filled/.test(r.slot.className),
    'the label is revealed before the ad exists — a label with nothing under it is worse than none');
  r.fillContainer();
  assert(/is-filled/.test(r.slot.className), 'the label never appears, so the ad stays unlabelled');
});

check('an already-filled container is labelled without waiting for a mutation', () => {
  const r = run(CHROME, 'moviezone.dev', false).ready();
  r.container.childElementCount = 1;
  r.intersect();
  assert(/is-filled/.test(r.slot.className), 'a container that filled early is never labelled');
});

check('the reserved slot is collapsed before paint when ads are gated off', () => {
  ['localhost', 'moviezone.dev'].forEach((host) => {
    const tv = host === 'moviezone.dev';
    const r = run(tv ? TIZEN : CHROME, host, false);
    assert(/mz-no-ads/.test(r.htmlClass()),
      'no mz-no-ads class for a gated-off visitor (' + (tv ? 'TV' : 'dev') + '); the 300px reservation would be a permanent hole');
  });
  const ok = run(CHROME, 'moviezone.dev', false);
  assert(!/mz-no-ads/.test(ok.htmlClass()),
    'a real visitor got mz-no-ads, which hides the slot the banner renders into');
});

check('load() is idempotent — a click plus the timer cannot double-inject', () => {
  const { ads: a, appended } = envFor(CHROME, 'moviezone.dev', false);
  const first = appended.length;
  a.load(); a.load();
  equal(appended.length, first, 'the unit was injected more than once');
});

/*  ── the native slot in the page ── */
console.log('');

const NATIVE_CONTAINER = (block.match(/container:\s*'([^']+)'/) || [])[1];

check('the container id in the markup matches the one the unit declares', () => {
  assert(NATIVE_CONTAINER, 'the native unit declares no container');
  assert(html.includes('<div id="' + NATIVE_CONTAINER + '"></div>'),
    'invoke.js looks up #' + NATIVE_CONTAINER + ' and there is no such element — the widget would render nowhere');
});

check('the slot the observer watches exists in the markup', () => {
  const sel = (block.match(/slot:\s*'#([^']+)'/) || [])[1];
  assert(sel, 'the native unit declares no slot');
  assert(html.includes('id="' + sel + '"'), '#' + sel + ' is not in the markup, so nothing is ever observed');
});

check('the slot sits between the movie feed and Upcoming', () => {
  const sep = html.indexOf('<div class="section-sep">');
  const slot = html.indexOf('id="mz-ad-native"');
  const upcoming = html.indexOf('id="upcoming"');
  assert(slot > sep, 'the slot is above the separator, where it reads as part of the movie panel');
  assert(slot < upcoming, 'the slot is inside/below Upcoming instead of in the break before it');
});

check('the slot is not adjacent to the pagination control', () => {
  const pager = html.indexOf('id="feedPager"');
  const slot = html.indexOf('id="mz-ad-native"');
  assert(slot > pager, 'the ad precedes the pager');
  assert(html.slice(pager, slot).includes('<div class="section-sep">'),
    'nothing separates the ad from the pager — an ad against a control harvests misclicks, '
    + 'which reads as revenue for a week and then costs CPM');
});

check('the ad is labelled, and the label is inert until it fills', () => {
  assert(/class="mz-ad-label"/.test(html), 'no "Sponsored" label — a native ad on a content grid must be disclosed');
  assert(/\.mz-ad-label\{[^}]*opacity:0/.test(html), 'the label is visible before the ad renders');
  assert(/\.mz-ad-slot\.is-filled \.mz-ad-label\{opacity:1\}/.test(html), 'the label is never revealed');
});

check('the slot reserves its height before first paint (CLS)', () => {
  const m = html.match(/\.mz-ad-slot\{[^}]*min-height:(\d+)px/);
  assert(m, 'no min-height on .mz-ad-slot — the banner would push Upcoming and the footer down on arrival');
  assert(Number(m[1]) >= 200, 'only ' + m[1] + 'px reserved; the 4:1 widget is taller than that');
  assert(/@media \(max-width:640px\)\{\.mz-ad-slot\{min-height:\d+px/.test(html),
    'no narrow-screen reservation, yet that is where the widget reflows tallest');
});

check('the reservation is collapsed by the pre-paint class, not by a late attribute', () => {
  assert(/html\.mz-no-ads \.mz-ad-slot\{display:none\}/.test(html),
    'no collapse rule for gated-off visitors');
  assert(!/html\[data-mz-tv="true"\] \.mz-ad-slot/.test(html),
    'collapsing on data-mz-tv happens after tv-mode.js runs — that is a mid-scroll shift on TV');
});

check('the label reveal cannot itself shift the page', () => {
  assert(/\.mz-ad-label\{[^}]*height:18px[^}]*\}/.test(html),
    'the label has no fixed height, so revealing it changes the slot height and shifts Upcoming down');
});

check('localhost: nothing is injected', () => {
  const { ads: a, appended } = envFor(CHROME, 'localhost', false);
  equal(a.state.profile.reason, 'dev', 'localhost was not recognised as dev');
  equal(a.state.injected.length, 0, 'a live ad script was injected on localhost');
  equal(appended.length, 0, 'a script element still reached the document on localhost');
});

check('a LAN dev host (192.168.x) is dev too', () => {
  equal(envFor(CHROME, '192.168.1.14', false).ads.state.profile.reason, 'dev',
    'phone-on-the-LAN testing would serve live ads');
});

check('Googlebot: nothing is injected', () => {
  const { ads: a, appended } = envFor(GOOGLEBOT, 'moviezone.dev', false);
  equal(a.state.profile.reason, 'crawler', 'Googlebot was not recognised');
  equal(appended.length, 0, 'an ad script was injected for a crawler');
});

check('Lighthouse is NOT gated out — an audit must see what users see', () => {
  const { ads: a, appended } = envFor(LIGHTHOUSE, 'moviezone.dev', false);
  equal(a.state.profile.reason, 'ok',
    'hiding ads from Lighthouse makes the score a lie; the RUM gate makes the same promise');
  assert(appended.length > 0, 'the audit would measure a page without the ad script');
});

check('a TV user agent is caught before tv-mode.js has even run', () => {
  const { ads: a, appended } = envFor(TIZEN, 'moviezone.dev', false);
  equal(a.state.profile.reason, 'tv', 'the Tizen UA was not recognised as a TV');
  equal(appended.length, 0, 'a popunder was injected on a TV');
});

check('data-mz-tv alone is enough, for a TV whose UA we do not know', () => {
  equal(envFor(CHROME, 'moviezone.dev', true).ads.state.profile.reason, 'tv',
    'the runtime TV flag is ignored, so tv-mode.js detecting a TV would not stop ads');
});

check('a second intersection cannot double-inject the banner', () => {
  const r = run(CHROME, 'moviezone.dev', false).ready();
  r.intersect(); r.intersect();
  equal(r.appended.filter((el) => /invoke\.js/.test(el.src)).length, 1,
    'invoke.js was injected twice — two widgets, one container');
});

/*  ── how it reaches the page ── */
console.log('');

check('no parser-blocking third-party script was introduced', () => {
  const blocking = [...html.matchAll(/<script\s+src="(https?:\/\/[^"]+)"(?![^>]*\b(?:async|defer)\b)/g)]
    .map((m) => m[1]);
  equal(blocking.length, 0, 'parser-blocking cross-origin script(s): ' + blocking.join(', '));
});

check('the ad script is not a <script> tag in the document at all', () => {
  assert(!/<script[^>]+src="https?:\/\/[^"]*profitablerate/i.test(html),
    'the raw Adsterra tag is in the markup; it must be injected at runtime instead');
});

check('the unit is injected async, never synchronously', () => {
  assert(/s\.async = true;/.test(block), 'the injected script is not marked async');
});

check('injection is deferred past the first paint', () => {
  const m = block.match(/setTimeout\(load,\s*(\d+)\)/);
  assert(m, 'no timer schedules the load');
  const delay = Number(m[1]);
  assert(delay >= 2000, 'the ad script loads after only ' + delay + 'ms — that competes with the LCP image');
  assert(/pointerdown/.test(block), 'first interaction does not trigger the load, so an early clicker earns nothing');
});

check('the pwa-install loader and the ad loader do not share a timer', () => {
  const adDelay = Number(block.match(/setTimeout\(load,\s*(\d+)\)/)[1]);
  const pwa = html.match(/setTimeout\(pull,\s*(\d+)\)/);
  assert(pwa, 'the pwa-install timer was not found');
  assert(adDelay !== Number(pwa[1]),
    'both background loads fire at ' + adDelay + 'ms — that is one long task instead of two small ones');
});

check('an ad-blocked request is recorded, never retried', () => {
  assert(/s\.onerror = function/.test(block), 'no onerror handler — a blocked ad would surface as an error');
  assert(!/setTimeout\([^)]*load/.test(block.replace(/setTimeout\(load, \d+\)/, '')),
    'a retry was added; a blocked ad must not be retried');
});

/*  ── consistency with the rest of the deployment ── */
console.log('');

const hosts = [...block.matchAll(/src:\s*'https:\/\/([^/']+)/g)].map((m) => m[1]);

check('every ad unit declares an https host', () => {
  assert(hosts.length > 0, 'no unit src was parsed out of UNITS');
  hosts.forEach((h) => assert(/^[\w.-]+$/.test(h), 'suspicious host: ' + h));
});

check('sw.js sends every ad host straight to the network', () => {
  assert(/if \(url\.origin !== self\.location\.origin\) return;/.test(sw),
    'no cross-origin bypass in the fetch handler; a blocked or 403 ad request would run three dead '
    + 'cache lookups and then throw, on every navigation');
  hosts.forEach((h) => {
    assert(!new RegExp(h.replace(/\./g, '\\.')).test(sw),
      h + ' is named in sw.js; the bypass is meant to be general — an ad script pulls from further '
      + 'domains of its own, so a host list can never be complete');
  });
});

check('the bypass runs before the caching branches', () => {
  const fetchStart = sw.indexOf("addEventListener('fetch'");
  const bypass = sw.indexOf('url.origin !== self.location.origin', fetchStart);
  const networkFirst = sw.indexOf('const networkFirst', fetchStart);
  assert(bypass > fetchStart, 'the fetch handler never checks the origin');
  assert(bypass < networkFirst, 'the bypass sits after the network-first branch, so it never runs');
});

check('TMDB images are still cached — the bypass must not catch them', () => {
  const fetchStart = sw.indexOf("addEventListener('fetch'");
  const tmdb = sw.indexOf('isTmdbImage(url)', fetchStart);
  const bypass = sw.indexOf('url.origin !== self.location.origin', fetchStart);
  assert(tmdb > 0 && tmdb < bypass,
    'the cross-origin bypass now swallows image.tmdb.org, so every poster and the LCP backdrop '
    + 'would be re-downloaded on every visit');
});

check('the shell cache was bumped, so installed clients get the new HTML', () => {
  const m = sw.match(/const CACHE_NAME = 'moviezone-v(\d+)'/);
  assert(m, 'CACHE_NAME not found');
  assert(Number(m[1]) >= 89,
    'CACHE_NAME is v' + m[1] + '; the precached /index.html fallback is older than the ad layer');
});

check('the crawler and TV regexes have not drifted from the RUM gate', () => {
  const crawler = [...html.matchAll(/\/googlebot\|bingbot\|[^\n]*?\/i/g)].map((m) => m[0]);
  assert(crawler.length === 2, 'expected the crawler regex twice (RUM + ads), found ' + crawler.length);
  equal(crawler[0], crawler[1], 'the ad gate and the RUM gate no longer agree on what a crawler is');

  const tv = [...html.matchAll(/\/\\b\(\?:smart-\?tv\|[^\n]*?\/i/g)].map((m) => m[0]);
  assert(tv.length === 2, 'expected the TV regex twice (RUM + ads), found ' + tv.length);
  equal(tv[0], tv[1], 'the ad gate and the RUM gate no longer agree on what a TV is');
});

/*  ── the popunder cap: the one thing standing between "monetised" and "hostile" ── */
console.log('');

check('the popunder is capped, and the cap is a shared key', () => {
  assert(/cap:\s*POP_CAP_KEY/.test(block), 'the popunder unit declares no cap');
  const key = (block.match(/var POP_CAP_KEY = '([^']+)'/) || [])[1];
  assert(key, 'no cap key is defined');
  equal(key, 'mz_ad_pop_at', 'the cap key changed; the watch page reads this exact key');
});

check('only the popunder is capped — the inline units are not', () => {
  const caps = (block.match(/cap:\s*POP_CAP_KEY/g) || []).length;
  equal(caps, 1, 'more than one unit is capped; only the popunder costs the visitor a tab');
});

check('a fresh visitor gets the popunder', () => {
  const r = run(CHROME, 'moviezone.dev', false, {});
  r.ads.load();
  assert(r.ads.state.injected.indexOf('popunder') !== -1, 'the first popunder was suppressed — that is the one that earns');
  assert(r.store['mz_ad_pop_at'], 'the cap was never recorded, so the next page would pop again');
});

check('a visitor who just had one does NOT get a second', () => {
  const store = { mz_ad_pop_at: String(Date.now() - 60 * 1000) };
  const r = run(CHROME, 'moviezone.dev', false, store);
  r.ads.load();
  equal(r.ads.state.injected.indexOf('popunder'), -1,
    'a second popunder inside the window — this is exactly what makes people install an ad blocker');
  assert(r.ads.state.capped.indexOf('popunder') !== -1, 'the suppression was not recorded');
});

check('the cap expires, so a later visit can earn again', () => {
  const store = { mz_ad_pop_at: String(Date.now() - 60 * 60 * 1000) };
  const r = run(CHROME, 'moviezone.dev', false, store);
  r.ads.load();
  assert(r.ads.state.injected.indexOf('popunder') !== -1, 'the cap never expires, so a returning visitor never earns again');
});

check('the cap never suppresses Social Bar or the banner', () => {
  const store = { mz_ad_pop_at: String(Date.now()) };
  const r = run(CHROME, 'moviezone.dev', false, store);
  r.ads.load();
  assert(r.ads.state.injected.indexOf('socialbar') !== -1, 'Social Bar was caught by the popunder cap');
  r.ready().intersect();
  assert(r.appended.some((el) => /invoke\.js/.test(el.src)), 'the banner was caught by the popunder cap');
});

/*  ══ THE SERVER-RENDERED WATCH PAGE ══
 *  Same questions again, against the real rendered HTML this time. */
console.log('');

const seo = require('./seo-ssr.js');
const watchHtml = seo.renderWatchPage(
  { id: 550, title: 'Fight Club', release_date: '1999-10-15', poster_path: '/x.jpg' }, 'movie', {});

const SSR_OPEN = '<script data-mz-ads="1">';
const ssrStart = watchHtml.indexOf(SSR_OPEN);
const ssrBlock = ssrStart < 0 ? '' : watchHtml.slice(ssrStart + SSR_OPEN.length, watchHtml.indexOf('</script>', ssrStart));

/** Run the SSR loader exactly as the browser would. */
function runSsr(ua, host, store) {
  const appended = [];
  const domReady = [];
  const el = { childElementCount: 0 };
  const slot = { className: 'ad-slot' };
  const bag = store || {};
  const io = { cb: null, opts: null, targets: [], disconnected: false };
  const timers = [];

  const sandbox = {
    navigator: { userAgent: ua },
    location: { hostname: host },
    localStorage: {
      getItem: (k) => (k in bag ? bag[k] : null),
      setItem: (k, v) => { bag[k] = String(v); }
    },
    document: {
      readyState: 'loading',
      documentElement: { className: '' },
      body: { appendChild: (e) => appended.push(e) },
      head: { appendChild: (e) => appended.push(e) },
      createElement: () => ({ setAttribute(k, v) { this[k] = v; } }),
      querySelector: () => slot,
      getElementById: () => el,
      addEventListener: (t, fn) => { if (t === 'DOMContentLoaded') domReady.push(fn); }
    },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout: (fn) => { timers.push(fn); return 0; }
  };
  sandbox.IntersectionObserver = function (cb, opts) {
    io.opts = opts;
    return { observe: (t) => { io.targets.push(t); io.cb = cb; }, disconnect: () => { io.disconnected = true; } };
  };
  sandbox.MutationObserver = function () { return { observe: () => {}, disconnect: () => {} }; };
  sandbox.window.IntersectionObserver = sandbox.IntersectionObserver;
  sandbox.window.MutationObserver = sandbox.MutationObserver;

  vm.createContext(sandbox);
  vm.runInContext(ssrBlock, sandbox);

  return {
    ads: sandbox.window.__mzAds,
    appended, io, slot, store: bag,
    htmlClass: () => sandbox.document.documentElement.className,
    ready() { domReady.forEach((fn) => fn()); return this; },
    /** Fire the deferred popunder timer. */
    tick() { timers.forEach((fn) => fn()); return this; },
    intersect() { if (io.cb) io.cb([{ isIntersecting: true }]); return this; }
  };
}

check('the watch page carries the ad loader', () => {
  assert(ssrStart > 0, 'no data-mz-ads script on the watch page');
  assert(ssrBlock.length > 200, 'the loader body looks truncated');
});

check('the watch page renders the native slot', () => {
  assert(watchHtml.includes('<aside class="ad-slot"'), 'no ad slot in the watch page markup');
  assert(watchHtml.includes('<div id="' + seo.AD_NATIVE_CONTAINER + '"></div>'),
    'the container invoke.js looks up is missing, so the widget would render nowhere');
});

check('the slot is below the player AND below the server switcher', () => {
  const player = watchHtml.indexOf('<div class="player-shell">');
  const servers = watchHtml.indexOf('class="srv"');
  const slot = watchHtml.indexOf('<aside class="ad-slot"');
  assert(slot > player, 'the ad is above the player — that delays the one thing the visitor came for');
  assert(slot > servers, 'the ad sits between the player and the server pills, where it would catch '
    + 'the taps of everyone whose stream did not start');
});

check('Social Bar is deliberately NOT on the watch page', () => {
  assert(!/cf\/b1\/0b/.test(watchHtml),
    'the Social Bar unit reached the watch page; a floating widget over a video is the irritation we are avoiding');
});

check('the watch page gate matches the SPA gate byte-for-byte', () => {
  const spaCrawler = (block.match(/\/googlebot\|bingbot\|[^\n]*?\/i/) || [])[0];
  const ssrCrawler = (ssrBlock.match(/\/googlebot\|bingbot\|[^\n]*?\/i/) || [])[0];
  equal(ssrCrawler, spaCrawler, 'the watch page and the SPA disagree on what a crawler is');

  const spaTv = (block.match(/\/\\b\(\?:smart-\?tv\|[^\n]*?\/i/) || [])[0];
  const ssrTv = (ssrBlock.match(/\/\\b\(\?:smart-\?tv\|[^\n]*?\/i/) || [])[0];
  equal(ssrTv, spaTv, 'the watch page and the SPA disagree on what a TV is');
});

check('the watch page shares the SPA popunder cap key', () => {
  assert(ssrBlock.includes("'mz_ad_pop_at'"),
    'the watch page uses a different cap key, so a visitor would get one popunder per surface');
});

check('a real visitor on the watch page gets the banner on approach', () => {
  const r = runSsr(CHROME, 'moviezone.dev', {}).ready();
  equal(r.ads.enabled, true, 'gated out in production');
  assert(!r.appended.some((el) => /invoke\.js/.test(el.src)), 'invoke.js loaded before the slot was near');
  r.intersect();
  const native = r.appended.filter((el) => /invoke\.js/.test(el.src));
  equal(native.length, 1, 'the banner never loaded');
  equal(native[0]['data-cfasync'], 'false', 'data-cfasync="false" is missing behind Cloudflare');
});

check('the watch page popunder respects a cap already spent on the SPA', () => {
  const r = runSsr(CHROME, 'moviezone.dev', { mz_ad_pop_at: String(Date.now() - 5000) }).tick();
  assert(r.ads.capped.indexOf('popunder') !== -1,
    'someone who already got a popunder while browsing gets a second one on pressing play');
  assert(!r.appended.some((el) => /c72eb8605ed50b20e9de4938ed2680fe/.test(el.src)), 'the popunder was injected anyway');
});

check('the watch page popunder still fires for a visitor who landed directly', () => {
  const r = runSsr(CHROME, 'moviezone.dev', {}).tick();
  assert(r.appended.some((el) => /c72eb8605ed50b20e9de4938ed2680fe/.test(el.src)),
    'a visitor arriving straight from Google earns nothing');
});

check('the watch page serves no ads on dev, crawlers or TV', () => {
  [[CHROME, 'localhost'], [GOOGLEBOT, 'moviezone.dev'], [TIZEN, 'moviezone.dev']].forEach(([ua, host]) => {
    const r = runSsr(ua, host, {}).ready();
    equal(r.ads.enabled, false, 'ads were enabled for ' + host + ' / ' + ua.slice(0, 30));
    equal(r.appended.length, 0, 'a script was injected anyway');
    assert(/mz-no-ads/.test(r.htmlClass()), 'the reserved slot was not collapsed, leaving a permanent hole');
  });
});

check('the watch page slot reserves its height too', () => {
  const ssr = fs.readFileSync(path.join(__dirname, 'seo-ssr.js'), 'utf8');
  assert(/\.ad-slot\{[^}]*min-height:\d+px/.test(ssr), 'no reservation — the banner would shove the footer down');
  assert(/html\.mz-no-ads \.ad-slot\{display:none\}/.test(ssr), 'no collapse rule for gated-off visitors');
  assert(/\.ad-slot\{margin:30px 0 0/.test(ssr), 'no separation from the controls above it');
});

check('every SSR ad host reaches the network unimpeded', () => {
  assert(/if \(url\.origin !== self\.location\.origin\) return;/.test(sw),
    'the cross-origin bypass is gone, so the watch page ad requests would go through the '
    + 'service worker cache branches for no benefit');
  const ssrHosts = [...ssrBlock.matchAll(/https:\/\/([^/'"]+)/g)].map((m) => m[1]);
  assert(ssrHosts.length > 0, 'no ad hosts parsed out of the watch page loader');
  ssrHosts.forEach((h) => {
    assert(h !== 'moviezone.dev' && !h.startsWith('/'), 'unexpected host in the loader: ' + h);
  });
});

check('ads stay opt-in, and only on the two agreed pages', () => {
  /*  Watch and detail pages opt in. Category/browse pages do NOT: they are thin
   *  index surfaces, and an ad on a page that is only a grid of links is the worst
   *  ratio of irritation to revenue on the site. */
  const ssr = fs.readFileSync(path.join(__dirname, 'seo-ssr.js'), 'utf8');
  assert(/ads = false/.test(ssr), 'the ad layer is no longer opt-in; every SSR page would carry it');
  equal((ssr.match(/^\s*ads: true,$/gm) || []).length, 2,
    'the number of SSR pages opting into ads changed; watch + detail were agreed');
});

const detailHtml = seo.renderDetailPage({
  id: 550, title: 'Fight Club', release_date: '1999-10-15', poster_path: '/p.jpg',
  backdrop_path: '/b.jpg', overview: 'A man starts a club.', vote_average: 8.4, vote_count: 200,
  genres: [{ id: 18, name: 'Drama' }], runtime: 139,
  credits: { cast: [{ name: 'Edward Norton', character: 'Narrator' }], crew: [] },
  videos: { results: [] }
}, 'movie');

check('the detail page carries the ad layer and a slot', () => {
  assert(detailHtml.includes('<script data-mz-ads="1">'), 'no ad loader on the detail page');
  assert(detailHtml.includes('<aside class="ad-slot"'), 'no ad slot on the detail page');
  equal((detailHtml.match(/<aside class="ad-slot"/g) || []).length, 1,
    'more than one slot on the page — invoke.js writes into one container id');
});

check('the detail slot sits after the content and before "More like"', () => {
  const slot = detailHtml.indexOf('<aside class="ad-slot"');
  const h1 = detailHtml.indexOf('<h1');
  const related = detailHtml.indexOf('<h2>More like');
  assert(slot > h1, 'the ad is above the title — the visitor came for that first');
  if (related > 0) {
    assert(slot < related, 'the ad is below the related grid, where fewer people reach it');
  }
});

check('category and browse pages stay ad-free', () => {
  /*  Read from source rather than rendering: the category renderer takes a
   *  paginated TMDB payload and this only needs to know whether it opts in. */
  const ssr = fs.readFileSync(path.join(__dirname, 'seo-ssr.js'), 'utf8');
  ['renderCategoryPage', 'renderBrowseIndex', 'renderBrowseLetter'].forEach((fn) => {
    const at = ssr.indexOf('function ' + fn + '(');
    if (at < 0) return;                       // renderer does not exist in this build
    const next = ssr.indexOf('\nfunction ', at + 1);
    const bodySrc = ssr.slice(at, next > 0 ? next : ssr.length);
    assert(!/ads:\s*true/.test(bodySrc),
      fn + ' opts into ads; a page that is only a grid of links is the worst irritation-to-revenue '
      + 'ratio on the site');
  });
});

console.log('-'.repeat(70));
let failed = 0;
checks.forEach((c) => {
  if (c.pass) console.log('  PASS  ' + c.name);
  else { failed++; console.log('  FAIL  ' + c.name + '\n          ' + c.detail); }
});
console.log('-'.repeat(70));
console.log('  ad-gate-check: ' + (checks.length - failed) + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
