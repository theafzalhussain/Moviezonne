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
// Scripts that ship as a <script defer> tag in the document.
const SCRIPTS = ['moviezone', 'tv-mode', 'search-engine'];
// Built and deployed, but injected at runtime instead of tagged in the document.
const LAZY_SCRIPTS = ['pwa-install'];
const ALL_SCRIPTS = SCRIPTS.concat(LAZY_SCRIPTS);
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

/*  ── FIRST-PAINT BUDGETS ──
 *  Measured, not assumed: the CDN serves every one of these with
 *  `content-encoding: br` (verified against the live host), so brotli is the
 *  number a real visitor pays, and gzip above only exists for comparison.
 *
 *  Today: index.html 21KB + moviezone.min.css 27KB + moviezone.min.js 50KB =
 *  98KB brotli. At 1.5 Mbps that is ~0.5s of download, which is why "make the
 *  bundle smaller over the wire" is NOT this page's problem and never was.
 *
 *  The second budget is the one that hurts: a browser decompresses and then
 *  PARSES the full 179KB of CSS and 227KB of JS on every cold visit, and does a
 *  style recalculation against every one of those rules. Chrome coverage says a
 *  desktop first load uses 44KB of that CSS (25%) and executes 56KB of that JS
 *  (25%). On a 6x-throttled TV the same work shows up as ~2.4s of style recalc.
 *  So the ceiling here is on parse weight, and it is the number to watch if the
 *  bundles ever start growing again.
 *
 *  Both budgets have deliberate headroom: they are regression alarms, not a
 *  demand to shrink today.
 */
const brotliOf = (p) => zlib.brotliCompressSync(fs.readFileSync(p), {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
}).length;

const CRITICAL_WIRE_BUDGET = 115 * 1024;

/*  Raised 430 -> 435 KB for the hero print-quality badge (Sep 2026).
 *
 *  The feature resolves a title's real print (CAM/TS/HDTS/HD/FHD/4K) from TMDB's
 *  release types instead of counting days since release_date, and costs 4.2 KB
 *  minified: 2.4 KB JS for the resolver and the lazy per-slide refresh, 1.8 KB
 *  CSS for the meta-row chips and the slide-title treatment. It was trimmed first
 *  — the badge palette reuses the .top10-quality declarations rather than
 *  redeclaring them, and the resolver derives its class names instead of carrying
 *  a literal per branch — so what is left is the feature itself.
 *
 *  Why the ceiling moved rather than the feature shrinking: 430 KB was set with
 *  ~2 KB of headroom, which is under half a percent and too tight to absorb any
 *  real change. 435 KB restores roughly the same alarm distance it had before.
 *  This is a regression alarm, not an optimisation target — but if it needs
 *  raising again, that is the signal to go and delete something instead.
 */
/*  Raised again, 435 -> 440 KB, for the carousel category quotas (Sep 2026).
 *
 *  The note below said that if this ever needed raising a second time, that was
 *  the signal to go and delete something instead. That was tried first and it is
 *  worth writing down what came of it, so the next person does not repeat it:
 *
 *    - one genuinely redundant `.low-end-mode *` block was found and deleted
 *      last commit; that bought 135 bytes;
 *    - a scan for exact duplicate selector+body pairs in the minified CSS found
 *      none - cleancss already collapses those;
 *    - terser `passes=2` and `passes=3` were measured and save 244 and 249 bytes,
 *      which is not worth changing the build for;
 *    - trimming the new module itself (array literals instead of {min,max}
 *      objects, shorter property names) was estimated at ~250 bytes, against the
 *      ~1330 needed.
 *
 *  So there is no dead weight of the required size left to remove, and the
 *  feature - web series and anime finally reaching the hero, with per-category
 *  quotas and a rating/demand bar - is not optional decoration.
 *
 *  There ARE two functions that nothing calls: loadSearchCatalog (~1.9k of
 *  source) and togglePlayerLang. They are deliberately left alone. Deleting
 *  someone's unreferenced feature code to win a byte budget is a product
 *  decision, not a perf one, and it needs an owner's yes. If that yes comes,
 *  removing them should pay this raise back and then some.
 *
 *  Also noted while looking: interleaveFeedByType is exercised by
 *  all-feed-ranking.browser.test.html but is never called by the app. Either the
 *  feed lost its interleave step or the function is vestigial - worth a look,
 *  independently of this budget.
 */
/*  Raised again, 440 -> 442 KB, for the Top 10 Today / This Week toggle (Sep 2026).
 *
 *  The toggle lets a visitor switch the Top 10 rail between TMDB's
 *  /trending/movie/day (Today) and /trending/movie/week (This Week). It costs
 *  ~1.3 KB minified: a premium sliding gold pill in CSS plus the per-window
 *  fetch, cache and delegated switch handler in JS.
 *
 *  Trimmed before raising: the CSS was compacted (dropped flex/letter-spacing
 *  no-ops, merged the font shorthand) and the JS reuses the existing skeleton
 *  markup and openModal wiring rather than adding its own. The prior note said a
 *  further raise is "the signal to go and delete something instead"; the two
 *  standing candidates (loadSearchCatalog, togglePlayerLang, interleaveFeedByType)
 *  are still unowned product code, so deleting them to win ~1 KB remains an
 *  owner's call, not a perf one. Two KB restores the same alarm headroom.
 */
/*  Raised again, 442 -> 443 KB, for the Top 10 section's visible title (Sep 2026).
 *
 *  The section had no on-screen heading at all — its h2 was .visually-hidden —
 *  so a first-time visitor got ten numbered posters with no label saying what
 *  they were ranked by. The title now shares one flex row with the period
 *  toggle: "TOP 10" in Bebas Neue carrying the same poured-gold gradient as the
 *  rank numerals, then "TRENDING MOVIES" in the Outfit UI face, uppercase and
 *  tracked. It costs ~0.55 KB minified, nearly all of it the gradient-text
 *  treatment (background-clip:text needs the gradient plus two clip properties
 *  and the text-fill override on the child span).
 *
 *  Trimmed before raising: the gradient went from five stops to four, the
 *  'Anton' font fallback was dropped, the toggle's own margin shorthand
 *  collapsed to margin-left, and the JS now rewrites only the screen-reader tail
 *  of the h2 instead of the whole string. That recovered ~120 bytes of the ~640
 *  the feature wanted — not enough, because a flat gold heading is precisely the
 *  thing this section was asked to stop looking like.
 *
 *  The honest way to pay this back is still the standing deletion list
 *  (loadSearchCatalog, togglePlayerLang, interleaveFeedByType — ~2 KB of source
 *  nothing calls). That remains an owner's decision, not a perf one, so it has
 *  not been done unilaterally. If the owner says yes, this raise and the
 *  previous one both come back.
 */
/*  Raised again, 443 -> 445 KB, for the mobile hero + Top 10 responsiveness (Sep 2026).
 *
 *  Reported bug: on a phone the hero carousel's title/synopsis/buttons washed
 *  out over a bright backdrop (the base "to top" scrim only darkened the very
 *  bottom), and the Top 10 heading + Today/This Week pill competed for one
 *  cramped line against the 4% gutter. The fix is CSS-only and costs ~1.1 KB
 *  minified: a deepened mobile-only scrim gradient, a phone layout for
 *  .slide-content and its children (type steps + full-width stretched buttons),
 *  and a <=600px Top 10 header block that scales the heading and drops the pill
 *  to its own full-width line. No JS — the toggle indicator was already measured
 *  from live offsetWidth/offsetLeft on resize.
 *
 *  Trimmed before raising: the mobile .slide-desc dropped its redundant
 *  line-clamp:3 (identical to the base rule) and every block reuses existing
 *  tokens rather than adding new ones. The standing deletion list
 *  (loadSearchCatalog, togglePlayerLang, interleaveFeedByType) is still the
 *  honest payback and still an owner's call. Two KB restores the alarm headroom.
 */
/*  Raised again, 445 -> 448 KB, for accurate Continue Watching progress (Sep 2026).
 *
 *  Reported bug: the rail showed a RANDOM "% watched" (saveWatchProgress seeded
 *  Math.random) and never dropped a title after it was finished. The rewrite
 *  makes progress real — a visible-watch-time estimate against the title's TMDB
 *  runtime, since a cross-origin streaming iframe cannot expose currentTime — and
 *  adds a completed-set (mz_watched_done) so a title past ~92% is removed and
 *  never re-offered, with resume on re-open. It costs ~2.4 KB minified: the
 *  session tracker (tick/accrue/persist), the done-set, and the live per-card bar
 *  patch that avoids re-rendering the rail every 5s.
 *
 *  Trimmed before raising: the three near-identical entry objects (session seed,
 *  per-tick persist, saveWatchProgress) were collapsed into one mkEntry() helper,
 *  which recovered ~240 bytes; the live update patches one card instead of
 *  re-rendering. The standing deletion list (loadSearchCatalog, togglePlayerLang,
 *  interleaveFeedByType) is still the honest payback and still an owner's call.
 */
/*  Raised again, 448 -> 449 KB, for the five extra OTT platform catalogues (Sep 2026).
 *  ...and then brought straight back DOWN to 448 by the deletions listed at the
 *  end of this comment. The feature shipped without a budget increase.
 *
 *  Requested change: the Top Providers rail had five cards (Apple TV+, SonyLIV,
 *  Amazon MX Player, aha, Crunchyroll) that left the site for the platform's own
 *  website. They now open an in-app, TMDB-backed catalogue exactly like the
 *  Netflix / Prime / JioHotstar / Zee5 tabs already did. It costs ~730 bytes
 *  minified: five OTT table entries (provider id, regions, verified network id),
 *  their verification id lists and headings, a per-platform monetization gate so
 *  a free/ad-funded service is not reduced to its flatrate slice, and
 *  ottRankLikeAllFeed() — twelve lines that put the platform tabs through the
 *  same priority ordering as the ALL feed instead of raw platform popularity.
 *
 *  No new network cost: the query plan per page is unchanged (6-7 provider-gated
 *  discover calls, already collapsed into one batch round trip by
 *  _ottPrimeBatch), and the new ranking is pure array work on a list that is
 *  already in memory.
 *
 *  Trimmed before raising: reusing rankByFreshness / diversifyByLanguage /
 *  interleaveFeedByType rather than writing an OTT-specific ranker saved ~1.4 KB
 *  of duplicated scoring code, and the five platforms share the one existing
 *  buildOttModeQueries plan rather than adding per-platform query builders.
 *  Only ~200 bytes of further squeeze was available inside the feature itself
 *  (redundant CAT_HEADINGS / OTT_ALT_PROVIDERS entries that duplicate the
 *  built-in fallbacks) and it was not taken, because those entries are what
 *  document the measured provider ids.
 *
 *  The standing deletion list is now VERIFIED and two of the three were real, so
 *  they are GONE rather than raising this number again:
 *    loadSearchCatalog (1874 source bytes) — a search-catalogue prefetcher left
 *      behind when search moved into search-engine.js. Its only companion state,
 *      `let searchCatalogPromise`, went with it. SEARCH_POSTER_FALLBACK did NOT:
 *      renderSearchResults still uses it.
 *    togglePlayerLang (271) — a hi/en player toggle with no caller. Note this is
 *      NOT togglePlayerFS, which IS built into the player chip row at runtime and
 *      stays.
 *  Each had exactly one reference in the whole tree before removal: its own
 *  definition. That is what paid for the five platforms and the hover warm-up,
 *  and it is why the budget below is back to 448 instead of climbing to 450.
 *
 *  interleaveFeedByType is no longer a deletion candidate: it has three call
 *  sites and is load-bearing for the ALL feed and every platform tab.
 */
/*  Raised, 448 -> 449 KB, for the Top 10 restyle + accurate resume (Sep 2026).
 *
 *  Requested changes, all four in one pass:
 *    1. The Top 10 title stopped being its own thing. It was Bebas Neue carrying the
 *       nine-stop poured-gold gradient clipped to the text; it now uses the site's
 *       own heading language — solid var(--text) beside the SAME .title-line accent
 *       bar CONTINUE WATCHING and ALL MOVIES & SHOWS use — at a smaller size.
 *       Reusing .title-line rather than re-declaring its gradient, and hoisting the
 *       numeral gradient and bevel into --t10-gold / --t10-bevel, made this part a
 *       net SAVING of roughly 0.3 KB.
 *    2. Ranks 4-10 are drawn as an outline and fill in on hover (podium 1-3 keeps
 *       its solid gold). ~0.5 KB of CSS: the stroke variant, the hover restore, and
 *       a (hover: none) branch so touch devices get a brighter outline instead of a
 *       state they can never enter.
 *    3. Numerals scale DOWN on phones instead of up. No new bytes — three existing
 *       --t10-rank-scale values changed.
 *    4. Continue Watching became accurate and resumable, which is the bulk of the
 *       cost at ~2 KB: a postMessage listener for the one provider that publishes
 *       its playhead (vidlink.pro's PLAYER_EVENT), per-episode rows so a series no
 *       longer overwrites its own progress, a real resume offset threaded through
 *       one shared mzResumeSec() so prewarm and load still build identical URLs,
 *       a focus gate beside the visibility gate, and resume-on-click.
 *
 *  Trimmed before raising, and it is worth recording what was tried:
 *    - The redundant MEDIA_DATA branch of the postMessage listener was dropped;
 *      PLAYER_EVENT's periodic 'timeupdate' already carries currentTime/duration.
 *    - The "58m left" label on the Continue Watching card was cut back to the
 *      percentage plus the episode, since the remaining-time figure only existed
 *      for the single provider that reports a duration.
 *    - Three literal copies of the numeral bevel became one custom property.
 *
 *  The standing deletion list is now EMPTY and this is the first raise that could
 *  not be paid for. loadSearchCatalog and togglePlayerLang were both removed in the
 *  previous change, and a fresh sweep for top-level functions whose only occurrence
 *  in the tree is their own definition returns nothing. So the honest options were
 *  a 1 KB raise or dropping one of the four requested changes.
 */
const CRITICAL_PARSE_BUDGET = 449 * 1024;

check('the first-paint transfer stays inside its brotli budget', () => {
  const parts = ['index.html', 'moviezone.min.css', 'moviezone.min.js'];
  const total = parts.reduce((sum, f) => sum + brotliOf(f), 0);
  console.log('          brotli on the wire: '
    + parts.map((f) => f.replace('moviezone.min.', '') + ' ' + kb(brotliOf(f))).join(' + ')
    + ' = ' + kb(total) + ' / ' + kb(CRITICAL_WIRE_BUDGET) + ' budget');
  assert.ok(total <= CRITICAL_WIRE_BUDGET,
    'first paint now transfers ' + kb(total) + ', over the ' + kb(CRITICAL_WIRE_BUDGET) + ' budget');
});

check('the browser is not asked to parse more than it can afford', () => {
  const parse = fs.statSync('moviezone.min.css').size + fs.statSync('moviezone.min.js').size;
  console.log('          parse weight: css ' + kb(fs.statSync('moviezone.min.css').size)
    + ' + js ' + kb(fs.statSync('moviezone.min.js').size)
    + ' = ' + kb(parse) + ' / ' + kb(CRITICAL_PARSE_BUDGET) + ' budget');
  assert.ok(parse <= CRITICAL_PARSE_BUDGET,
    'render-critical parse weight is ' + kb(parse) + ', over the ' + kb(CRITICAL_PARSE_BUDGET)
      + ' budget — this is what costs weak devices their style-recalc time');
});

/*  ── THE MAIN STYLESHEET STAYS RENDER-BLOCKING. THIS WAS MEASURED. ──
 *
 *  "179KB of CSS blocks the first paint, defer it" is the most obvious-looking
 *  optimisation on this page, and it is wrong. It was tried, on the TV profile
 *  that has the most to gain (Tizen UA, 6x CPU throttle, three runs each,
 *  medians):
 *
 *                        blocking (shipped)   deferred (media=print)
 *      first card             3121 ms              4643 ms
 *      style recalc           1.797 s              2.684 s
 *      layout                 2.047 s              3.352 s
 *
 *  Deferring made every number worse, by a lot. The reason is that the CSS was
 *  never the network bottleneck — it is 27KB brotli and arrives in a blink. Take
 *  it off the critical path and the browser lays the whole document out once
 *  UNSTYLED, then throws that away and does it again when the sheet lands. Two
 *  passes on a slow CPU cost more than one.
 *
 *  So the lever for weak devices is not WHEN the CSS loads, it is HOW MANY rules
 *  it contains (coverage: 25% used on a first load). Deleting genuinely dead
 *  rules would help; deferring the file does not.
 *
 *  This check does not forbid a real critical-CSS split — inline the critical
 *  set and defer the rest and it passes. It forbids the naive half of the change,
 *  which is the one that regresses.
 */
/*  Every pattern below tolerates an optional leading slash.
 *  index.html references its bundles root-absolutely ("/moviezone.min.js") so they
 *  resolve on nested SSR routes; the relative form asked for
 *  /movie/moviezone.min.js on a detail page, got the SPA fallback's index.html,
 *  and every bundle failed with "Unexpected token '<'". */
check('the main stylesheet is not deferred without inlined critical CSS', () => {
  const linkTag = /<link rel="stylesheet" href="\/?moviezone\.min\.css\?v=[\d.]+"([^>]*)>/.exec(htmlCode);
  assert.ok(linkTag, 'moviezone.min.css is not linked as a stylesheet at all');
  const deferred = /media\s*=\s*"print"/.test(linkTag[1]);
  if (!deferred) return;
  const headEnd = htmlCode.indexOf('</head>');
  const head = headEnd === -1 ? htmlCode : htmlCode.slice(0, headEnd);
  const inlineCss = (head.match(/<style[^>]*>[\s\S]*?<\/style>/g) || [])
    .reduce((sum, block) => sum + block.length, 0);
  assert.ok(inlineCss > 8 * 1024,
    'moviezone.min.css is deferred but only ' + kb(inlineCss) + ' of CSS is inlined. Measured on the '
      + 'TV profile: deferring without a critical set moved first card 3121ms -> 4643ms and style '
      + 'recalc 1.80s -> 2.68s, because the document is laid out unstyled and then again.');
});

console.log('\n-- index.html references the built bundles ' + '-'.repeat(19));

for (const name of SCRIPTS) {
  check(name + '.min.js is the script that ships', () => {
    const tag = new RegExp('<script src="/?' + name + '\\.min\\.js\\?v=[\\d.]+" defer>');
    assert.ok(tag.test(html), name + '.min.js is not the <script> src');
    const bare = new RegExp('<script src="/?' + name + '\\.js\\?');
    assert.ok(!bare.test(html), 'unminified ' + name + '.js is still requested');
  });
}

for (const name of LAZY_SCRIPTS) {
  check(name + '.min.js stays OFF the critical path', () => {
    /*  pwa-install.min.js is 30 KB of install popup plus a bundled QR code
     *  generator. As a fourth `defer` tag its parse and execution landed inside
     *  the load window alongside the three scripts that actually render the page.
     *  It is now injected on idle / on demand — see the loader at the end of
     *  index.html. The one thing that could not wait, capturing the one-shot
     *  beforeinstallprompt event, is done by the bootstrap in <head>.
     */
    const tag = new RegExp('<script src="/?' + name + '\\.min\\.js\\?v=[\\d.]+" defer>');
    assert.ok(!tag.test(html), name + '.min.js is back as a blocking <script defer> tag');
    assert.ok(new RegExp("s\\.src = '/?" + name + "\\.min\\.js\\?v=[\\d.]+'").test(html),
      'no runtime loader for ' + name + '.min.js — it would never load at all');
    assert.ok(/__mzLoadPwaInstall/.test(js),
      'installPWA() cannot pull the controller in on demand, so an early click is dropped');
    assert.ok(fs.existsSync(path.join(__dirname, name + '.min.js')), name + '.min.js missing on disk');
  });
}

for (const name of STYLES) {
  check(name + '.min.css is the stylesheet that ships', () => {
    /*  Trailing attributes are allowed on purpose. tv-mode.min.css ships as
     *  `media="print" onload="this.media='all'"` — the deferred-stylesheet
     *  pattern — because it styles a mode most visits never enter, so making it
     *  render-blocking to satisfy an exact-match regex would be a real
     *  regression. What this check is actually for is unchanged: the minified
     *  file must be the one linked, with a version query, and the unminified
     *  source must not be linked at all. */
    const tag = new RegExp('<link rel="stylesheet" href="/?' + name + '\\.min\\.css\\?v=[\\d.]+"[^>]*>');
    assert.ok(tag.test(html), name + '.min.css is not linked');
    const bare = new RegExp('href="/?' + name + '\\.css\\?');
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
  ['rel="stylesheet" href="/moviezone.min.css', 'preload" href="/moviezone.min.js',
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
[['main stylesheet', '<link rel="stylesheet" href="/moviezone.min.css'],
 ['TMDB preconnect', '<link rel="preconnect" href="https://image.tmdb.org"']
].forEach(([label, needle]) => {
  const at = html.indexOf(needle);
  console.log('  ' + label.padEnd(20) + 'discovered at byte ' + String(at).padStart(6));
  check(label + ' is discovered within the first ' + (OFFSET_BUDGET / 1024) + ' KB of head', () => {
    assert.ok(at !== -1, needle + ' not found');
    assert.ok(at < OFFSET_BUDGET,
      'found at byte ' + at + '; the network sits idle while the parser gets there');
  });
});

/*  This used to hunt for one hard-coded needle, a preload of search-engine.min.js
 *  that no longer exists — that bundle is a deferred <script> and preloading it
 *  would put it in the same priority lane as the LCP image for no gain. A missing
 *  file cannot be "late", so the check was reporting byte -1 forever instead of
 *  guarding anything.
 *
 *  Whatever IS preloaded as a script is what the preload scanner has to reach
 *  early, so the assertion now derives its subjects from the markup. It covers
 *  every script preload rather than one name, and it fails if a preload is added
 *  below the 4 KB mark, which is the failure the original was written for.
 */
{
  const scriptPreloads = [...html.matchAll(/<link rel="preload" href="([^"]+\.js\?[^"]*)" as="script">/g)]
    .map((m) => ({ url: m[1], at: m.index }));
  scriptPreloads.forEach((p) => {
    console.log('  ' + ('preload ' + p.url).padEnd(20) + ' discovered at byte ' + String(p.at).padStart(6));
  });
  check('every script preload is discovered within the first ' + (OFFSET_BUDGET / 1024) + ' KB of head', () => {
    assert.ok(scriptPreloads.length > 0, 'no script preloads found at all');
    scriptPreloads.forEach((p) => {
      assert.ok(p.at < OFFSET_BUDGET,
        p.url + ' is preloaded at byte ' + p.at + '; the network sits idle while the parser gets there');
    });
  });
}

check('charset stays in the first 1024 bytes', () => {
  const at = html.indexOf('<meta charset=');
  assert.ok(at !== -1 && at < 1024,
    'charset at byte ' + at + ' — browsers may restart the parse');
});

/*  ── DATADOG RUM PROFILE GATE ──
 *  rum-gate.browser.test.js proves the gate's runtime decisions, but it can only
 *  see the development branch: it is served from 127.0.0.1. These guards cover
 *  what that test cannot reach — that the production branch still exists, that
 *  the agent is never requested before the gate has run, and that the noise
 *  filter has not quietly grown into a way to hide real errors.
 */
console.log('\n-- Datadog RUM profile gate ' + '-'.repeat(34));

check('RUM env is derived, never hardcoded to production', () => {
  assert.ok(!/env:\s*'production'/.test(htmlCode),
    "env is pinned to 'production'; a localhost session would report as production again");
  assert.ok(/env:\s*window\.__mzRumProfile\.env/.test(htmlCode),
    'RUM init does not read its env from the profile gate');
  assert.ok(/isLocal\s*\?\s*'development'\s*:\s*'production'/.test(htmlCode),
    'the development/production branch is gone — dev and prod data would merge again');
});

check('a dev host samples no RUM sessions', () => {
  assert.ok(/sessionSampleRate:\s*isLocal\s*\?\s*0\s*:\s*100/.test(htmlCode),
    'localhost still samples sessions, so dev traffic reaches the production dashboard');
});

check('real crawlers are gated out before the agent is requested', () => {
  const gateAt = htmlCode.indexOf('__mzRumProfile');
  const agentAt = htmlCode.indexOf('datadoghq-browser-agent.com');
  assert.ok(gateAt !== -1 && agentAt !== -1, 'the gate or the agent loader is missing');
  assert.ok(gateAt < agentAt,
    'the agent is requested before the gate runs, so a crawler would still download it');
  assert.ok(/if\s*\(isCrawler\)\s*return;/.test(htmlCode),
    'the crawler branch no longer stops the agent from loading');
  ['googlebot', 'bingbot', 'applebot', 'ahrefsbot', 'semrushbot'].forEach((bot) => {
    assert.ok(new RegExp(bot, 'i').test(htmlCode), bot + ' is not in the crawler list');
  });
});

check('audits are never gated out — Lighthouse must see what users see', () => {
  const gate = /var isCrawler = [\s\S]*?;/.exec(htmlCode);
  assert.ok(gate, 'the crawler pattern could not be located');
  ['lighthouse', 'pagespeed', 'headlesschrome', 'gtmetrix'].forEach((tool) => {
    assert.ok(!new RegExp(tool, 'i').test(gate[0]),
      tool + ' is in the crawler list; the audit would measure a page without RUM, '
        + 'which reports a score no real user gets');
  });
});

check('Session Replay is switched off on weak devices only', () => {
  assert.ok(/sessionReplaySampleRate:\s*isWeak\s*\?\s*0\s*:\s*10/.test(htmlCode),
    'the replay budget is not tied to the weak-device verdict');
  assert.ok(/navigator\.hardwareConcurrency\s*<\s*4/.test(htmlCode)
    && /navigator\.deviceMemory\s*<\s*4/.test(htmlCode),
    'the weak-device thresholds no longer match isLowEnd in moviezone.js');
  assert.ok(/tizen/i.test(htmlCode) && /smart-?tv/i.test(htmlCode),
    'TVs are not detected, so the most affected device keeps paying for replay');
});

check('errors and metrics still reach Datadog on every device', () => {
  assert.ok(!/trackLongTasks:\s*false/.test(htmlCode) && /trackLongTasks:\s*true/.test(htmlCode),
    'long-task collection was turned off — the TV data we act on comes from it');
  assert.ok(/trackResources:\s*true/.test(htmlCode) && /trackUserInteractions:\s*true/.test(htmlCode),
    'resource or interaction tracking was turned off');
});

check('the RUM noise filter drops only third-party, non-actionable errors', () => {
  const filter = /beforeSend:\s*function[\s\S]*?\n\s{6}\}/.exec(htmlCode);
  assert.ok(filter, 'beforeSend is missing, so third-party noise is back in the error feed');
  const body = filter[0];
  assert.ok(/event\.type !== 'error'/.test(body),
    'the filter inspects non-error events too, so it can drop real telemetry');
  assert.ok(/ResizeObserver loop/i.test(body), 'the ResizeObserver noise is no longer filtered');
  assert.ok(/extension:/i.test(body), 'browser-extension errors are no longer filtered');

  /*  Budget raised from 3 to 4 when the "Script error." and ".at is not a
   *  function" rules were added. The count was the only thing guarding this
   *  filter at the time; it is now the weaker of two guards, because
   *  rum-filter.test.js executes the real beforeSend and asserts, per rule,
   *  what it drops AND what it must still keep. Raise this number again only
   *  alongside a case there, plus evidence the class is not ours. */
  const returnsFalse = (body.match(/return false/g) || []).length;
  assert.ok(returnsFalse <= 4,
    returnsFalse + ' discard branches in beforeSend; each one hides a class of error');

  /*  The CORS-mask rule must stay anchored. Unanchored, /Script error/ would
   *  also swallow a real message that merely contains those words. */
  if (/Script error/.test(body)) {
    assert.ok(/\^Script error\\\.\?\$/.test(body),
      'the "Script error." rule is not anchored, so it can drop real messages '
        + 'that merely contain that phrase');
  }

  assert.ok(/return true;\s*\}/.test(body),
    'the filter does not end by keeping everything else');
});

check('every beforeSend discard rule is verified by rum-filter.test.js', () => {
  assert.ok(fs.existsSync('rum-filter.test.js'),
    'nothing executes the shipped beforeSend, so its rules are unverified');
  assert.ok(pkg.scripts.test.includes('rum-filter.test.js'),
    'rum-filter.test.js is never run by npm test');
  const filterTest = fs.readFileSync('rum-filter.test.js', 'utf8');
  /*  The ".at is not a function" rule is only safe while this site ships no
   *  .at( call of its own. That invariant must be enforced, not assumed. */
  assert.ok(/\.at\\\(/.test(filterTest) || /\\\.at\\\(/.test(filterTest),
    'the .at invariant is not checked, so the filter could hide our own bug');
});

check('the RUM gate is exercised by a browser test', () => {
  assert.ok(fs.existsSync('rum-gate.browser.test.js') && fs.existsSync('rum-gate.browser.test.html'),
    'the gate has no browser test, so its runtime decisions are unverified');
  assert.ok(pkg.scripts.test.includes('rum-gate.browser.test.js'),
    'rum-gate.browser.test.js is never run by npm test');
});

console.log('\n-- build produces everything index.html asks for ' + '-'.repeat(13));

check('npm run build minifies every shipped script', () => {
  ALL_SCRIPTS.forEach((name) => {
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
  [...ALL_SCRIPTS.map((n) => [n + '.js', n + '.min.js']),
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
    // Same reason as the .min.css check above: tv-mode.min.css carries
    // media/onload attributes because it is deferred, and it still has to be in
    // the precache list — an offline TV client would otherwise render unstyled.
    ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+\.css\?[^"]*)"[^>]*>/g)].map((m) => m[1])
  ];
  // 3 scripts + 2 stylesheets. pwa-install used to be a fourth script tag here;
  // it is injected at runtime now and is asserted separately.
  assert.ok(pageAssets.length >= 5, 'expected at least 5 versioned assets, found ' + pageAssets.length);
  pageAssets.forEach((a) => {
    /*  index.html now references these root-absolutely ("/moviezone.min.js"), so
     *  the leading slash is stripped before rebuilding the precache form — without
     *  this the comparison looks for '//moviezone.min.js' and never matches. */
    const rel = a.replace(/^\//, '');
    assert.ok(sw.includes("'/" + rel + "'"),
      a + ' is loaded by index.html but not precached by sw.js - offline clients would run stale code');
  });
});

check('sw.js precaches no unminified bundle', () => {
  [...ALL_SCRIPTS.map((n) => n + '.js'), ...STYLES.map((n) => n + '.css')].forEach((f) => {
    assert.ok(!new RegExp("'/" + f.replace('.', '\\.') + "\\?").test(sw),
      'sw.js still precaches the unminified ' + f);
  });
});

check('cache version was bumped past the pre-minification build', () => {
  const m = sw.match(/const CACHE_NAME = 'moviezone-v(\d+)'/);
  assert.ok(m, 'CACHE_NAME not found');
  assert.ok(Number(m[1]) >= 60,
    'CACHE_NAME is v' + m[1] + '; moving pwa-install off the critical path needs a bump above v59 or clients keep the old shell');
});

check('the lazily-loaded bundle is still available offline', () => {
  assert.ok(/'\/pwa-install\.min\.js\?v=[\d.]+'/.test(sw),
    'pwa-install.min.js is not precached at all, so the install UI would be unavailable offline');
  const optional = sw.slice(sw.indexOf('OPTIONAL_ASSETS'), sw.indexOf('self.addEventListener'));
  assert.ok(/pwa-install\.min\.js/.test(optional),
    'pwa-install.min.js is a core-shell entry; it is no longer on the load path, so a 404 there must not be able to fail the whole SW install');
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
  /*  Anchored on CODE, not on a comment. This used to search for the Hinglish
   *  note that sat above the branch, and it broke the moment that note was
   *  rewritten — a green-to-red flip with no behaviour change behind it. The
   *  getItem line is the actual start of the SWR read and cannot be reworded. */
  const idx = js.indexOf('const localDataStr = localStorage.getItem(cacheKey);');
  assert.ok(idx !== -1, 'the SWR read of the localStorage copy was not found');
  const branch = js.slice(idx, idx + 1200);
  assert.ok(/_mzTmdbFreshMs\(urlStr\)/.test(branch),
    'the freshness window is no longer resolved per endpoint — a discovery list '
    + 'held for 12h means new releases do not reach the hero until tomorrow');
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

/*  The "Cinematic Universe" navbar pill and its always-on sweep were removed with
 *  the #collections picker they opened, so there is normally nothing to measure
 *  here. The check is kept rather than deleted because the sweep is exactly the
 *  kind of decoration that gets reintroduced, and the bug it caught — animating
 *  `left` on an always-visible navbar element, forcing layout every frame — is
 *  invisible until someone profiles. If the pill comes back, so do the
 *  assertions; if it is absent, the stylesheet and the markup must agree that it
 *  is gone, so a half-removal cannot pass quietly either. */
check('the always-on navbar sweep is composited', () => {
  const css = fs.readFileSync('moviezone.css', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');
  const start = css.indexOf('@keyframes navPremiumSweep');

  if (start === -1) {
    assert.ok(!/nav-premium/.test(css),
      '.nav-premium styling survived without its @keyframes navPremiumSweep');
    assert.ok(!/nav-premium/.test(html),
      'the navbar still ships the .nav-premium pill but its stylesheet is gone');
    return;
  }

  const fn = css.slice(start, start + 300);
  assert.ok(!/left\s*:/.test(fn), 'navbar sweep animates `left` again (layout every frame)');
  assert.ok(/translate3d/.test(fn), 'navbar sweep is not using a composited transform');
});

console.log('\n' + '='.repeat(62));
console.log('  asset-perf-check: ' + pass + ' passed, ' + fail + ' failed');
if (fail) failures.forEach((f) => console.log('   x ' + f));
console.log('='.repeat(62) + '\n');
process.exit(fail ? 1 : 0);
