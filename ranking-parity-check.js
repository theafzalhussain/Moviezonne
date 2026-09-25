/*  ═══════════════════════════════════════════════════════════════════════════
 *  RANKING PARITY — the scoring shortcut must not change a single score
 *  ═══════════════════════════════════════════════════════════════════════════
 *
 *  rankByFreshness() now hands calculateMovieScore() the `now` and the
 *  titleQualityState it has just derived, instead of letting the function find
 *  both again. That removed the dominant cost of the gather loop - a second date
 *  parse and a second double walk of the quality timeline, per title, across a
 *  ~200-320 title pool - and it is a pure refactor: the same inputs must produce
 *  the same number, or the feed's ORDER changes and that is a product change
 *  wearing a performance change's clothes.
 *
 *  So this asserts equality against the old behaviour directly: score every
 *  fixture both ways - with the state passed in, and with the function deriving it
 *  itself, which is exactly what the pre-change code did - and require an exact
 *  match. It also covers the reuse guard in renderMovies, because a stale
 *  _qualityState there would show a wrong print-quality badge.
 *
 *  moviezone.js is a browser script with no module boundary, so it is loaded the
 *  way the browser tests load it: evaluated in a VM with the DOM surface it
 *  touches at parse time stubbed out.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + label);
  } catch (err) {
    failures.push(label);
    console.log('  FAIL  ' + label + '\n          ' + err.message);
  }
}

/*  Enough of a browser for the top-level statements to run. Everything the file
 *  does at parse time - reading navigator, matchMedia, localStorage, attaching
 *  listeners, touching documentElement - has to answer without throwing, because
 *  a throw at any top-level line leaves the later function declarations
 *  undefined and the suite would report a missing function rather than a wrong
 *  score.
 */
function makeSandbox() {
  const noop = () => {};
  const el = () => ({
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild: noop, insertBefore: noop, remove: noop, addEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    children: [], childNodes: [], dataset: {}, cloneNode: () => el(),
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    offsetHeight: 0, offsetWidth: 0, textContent: '', innerHTML: ''
  });
  const store = new Map();
  const win = {
    location: { hostname: 'moviezone.dev', href: 'https://moviezone.dev/', search: '', hash: '', pathname: '/' },
    navigator: { userAgent: 'node-parity-harness', onLine: true, hardwareConcurrency: 8, languages: ['en'] },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop, removeEventListener: noop }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] || null,
      get length() { return store.size; }
    },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    performance: { now: () => Date.now() },
    fetch: () => Promise.reject(new Error('no network in the parity harness')),
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() {} },
    console: { log: noop, warn: noop, error: noop, debug: noop, info: noop }
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.document = {
    documentElement: el(),
    body: el(),
    head: el(),
    createElement: el,
    createDocumentFragment: el,
    createTextNode: () => ({ textContent: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    getElementsByName: () => [],
    addEventListener: noop, removeEventListener: noop,
    readyState: 'loading', visibilityState: 'visible', cookie: '',
    hidden: false, referrer: '', title: ''
  };
  return win;
}

function loadClient() {
  const src = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  // Not `new vm.Script(...).runInContext` with a throw-on-error wrapper: a parse
  // error here must be loud, because it means the file itself is broken.
  vm.runInContext(src, context, { filename: 'moviezone.js' });
  return context;
}

/** Fixtures spanning every branch calculateMovieScore and the timeline can take. */
const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
const ahead = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const FIXTURES = [
  { id: 1, title: 'released 3 days ago, huge', release_date: ago(3), vote_average: 8.4, vote_count: 21000, popularity: 3100, genre_ids: [28] },
  { id: 2, title: 'released 10 days ago, thin votes', release_date: ago(10), vote_average: 9.1, vote_count: 3, popularity: 40, genre_ids: [18] },
  { id: 3, title: 'released 20 days ago', release_date: ago(20), vote_average: 7.2, vote_count: 900, popularity: 260, genre_ids: [35] },
  { id: 4, title: 'released 40 days ago', release_date: ago(40), vote_average: 6.4, vote_count: 120, popularity: 55, genre_ids: [27] },
  { id: 5, title: 'released 75 days ago', release_date: ago(75), vote_average: 7.9, vote_count: 5400, popularity: 480, genre_ids: [878] },
  { id: 6, title: 'released 120 days ago', release_date: ago(120), vote_average: 8.8, vote_count: 33000, popularity: 900, genre_ids: [18] },
  { id: 7, title: 'released 300 days ago', release_date: ago(300), vote_average: 5.1, vote_count: 70, popularity: 12, genre_ids: [28] },
  { id: 8, title: 'catalogue, 6 years old', release_date: ago(2200), vote_average: 8.2, vote_count: 99000, popularity: 150, genre_ids: [12] },
  { id: 9, title: 'unreleased', release_date: ahead(30), vote_average: 0, vote_count: 0, popularity: 700, genre_ids: [28] },
  { id: 10, title: 'no date at all', vote_average: 7.0, vote_count: 500, popularity: 90, genre_ids: [16] },
  { id: 11, name: 'series, aired 12 days ago', first_air_date: ago(12), vote_average: 8.6, vote_count: 4200, popularity: 620, genre_ids: [10765], media_type: 'tv' },
  { id: 12, name: 'anime series, aired 50 days ago', first_air_date: ago(50), vote_average: 8.9, vote_count: 800, popularity: 300, genre_ids: [16], original_language: 'ja', media_type: 'tv' },
  { id: 13, name: 'series, aired 200 days ago', first_air_date: ago(200), vote_average: 7.4, vote_count: 15000, popularity: 210, genre_ids: [18], media_type: 'tv' },
  { id: 14, title: 'zero popularity edge', release_date: ago(5), vote_average: 0, vote_count: 0, popularity: 0, genre_ids: [] },
  { id: 15, title: 'popularity at the 5000 cap', release_date: ago(1), vote_average: 7.7, vote_count: 8000, popularity: 99999, genre_ids: [28] }
];

const clone = (o) => JSON.parse(JSON.stringify(o));

(async () => {
  console.log('\nRanking parity - the scoring shortcut changes cost, not order');
  console.log('-'.repeat(74));

  let ctx;
  try {
    ctx = loadClient();
  } catch (err) {
    console.error('  could not evaluate moviezone.js in the harness: ' + err.message);
    process.exit(1);
  }

  const { calculateMovieScore, titleQualityState, rankByFreshness } = ctx;

  check('the functions under test are reachable', () => {
    assert.strictEqual(typeof calculateMovieScore, 'function', 'calculateMovieScore missing');
    assert.strictEqual(typeof titleQualityState, 'function', 'titleQualityState missing');
    assert.strictEqual(typeof rankByFreshness, 'function', 'rankByFreshness missing');
  });

  const now = Date.now();

  check('every fixture scores identically with and without the passed-in state', () => {
    const diffs = [];
    for (const f of FIXTURES) {
      // OLD behaviour: no now, no state - the function derives both itself.
      const before = calculateMovieScore(clone(f));
      // NEW behaviour: both supplied by rankByFreshness.
      const state = titleQualityState(clone(f), now);
      const after = calculateMovieScore(clone(f), now, state);
      if (before !== after) {
        diffs.push((f.title || f.name) + ': ' + before + ' -> ' + after);
      }
    }
    assert.deepStrictEqual(diffs, [],
      'scores moved, so the feed order moved:\n          ' + diffs.join('\n          '));
  });

  check('passing only `now` is also identical (partial-argument callers)', () => {
    /*  carouselHeroScore and the Top-10 path still call with one argument. The
     *  defaults have to keep those exactly where they were. */
    const diffs = [];
    for (const f of FIXTURES) {
      const a = calculateMovieScore(clone(f));
      const b = calculateMovieScore(clone(f), now);
      if (a !== b) diffs.push((f.title || f.name) + ': ' + a + ' vs ' + b);
    }
    assert.deepStrictEqual(diffs, [], diffs.join('; '));
  });

  check('rankByFreshness produces the same order as scoring each title alone', () => {
    const pool = FIXTURES.map(clone);
    rankByFreshness(pool, now);
    const got = pool.map((m) => m.id);

    // Independent reference ordering, built from the documented comparator using
    // scores derived the OLD way - so this is a genuine cross-check, not a
    // restatement of the implementation.
    const ref = FIXTURES.map(clone).map((m) => {
      const state = titleQualityState(m, now);
      m._qualityState = state;
      m._eventAgeDays = ctx.catalogueEventAgeDays(m, now, state);
      m._freshTier = ctx.freshnessTier(m, m._eventAgeDays);
      m._priorityGroup = ctx.allFeedPriorityGroup(m, state, m._freshTier);
      m._rankScore = calculateMovieScore(m);   // no state passed = pre-change path
      return m;
    }).sort((a, b) =>
      (a._priorityGroup - b._priorityGroup)
      || (a._freshTier - b._freshTier)
      || (b._rankScore - a._rankScore)
      || (a._eventAgeDays - b._eventAgeDays)).map((m) => m.id);

    assert.deepStrictEqual(got, ref,
      'order changed\n          now: ' + got.join(',') + '\n          was: ' + ref.join(','));
  });

  check('rankByFreshness stamps _qualityAt so the render reuse can be bounded', () => {
    const pool = FIXTURES.map(clone);
    rankByFreshness(pool, now);
    for (const m of pool) {
      assert.strictEqual(m._qualityAt, now,
        (m.title || m.name) + ' carries no _qualityAt, so renderMovies would '
          + 'recompute every badge and the reuse is dead code');
      assert.ok(m._qualityState, 'no _qualityState stored');
    }
  });

  check('the render reuse window is short enough to be provably equivalent', () => {
    /*  titleQualityState moves on DAY boundaries (upgradedDaysAgo against
     *  25/55/85). Any window under a day is equivalent to recomputing; a window
     *  over one is a stale badge. */
    const src = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');
    const ms = Number((src.match(/const MZ_QUALITY_REUSE_MS\s*=\s*([^;]+);/) || [])[1]
      ? eval((src.match(/const MZ_QUALITY_REUSE_MS\s*=\s*([^;]+);/) || [])[1])
      : NaN);
    assert.ok(Number.isFinite(ms), 'MZ_QUALITY_REUSE_MS not found');
    assert.ok(ms < DAY, 'the reuse window is ' + ms + 'ms, a day or more - a badge '
      + 'derived that long ago can legitimately differ from one derived now');
    assert.ok(ms >= 15 * 60 * 1000, 'the window is shorter than the 15-minute pool '
      + 'cache, so a cached pool would recompute every badge anyway');
  });

  check('renderMovies guards the reuse on that stamp, not on presence alone', () => {
    const src = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');
    assert.ok(/_qualityAt\s*&&\s*mzNow\s*-\s*m\._qualityAt\s*<\s*MZ_QUALITY_REUSE_MS/.test(src),
      'the badge reuse is not age-checked. _qualityState reaches localStorage via '
        + 'the idle cache flush and the self-ranked feeds (toprated/kids/anime) never '
        + 'run rankByFreshness, so an unguarded reuse paints a previous session\u2019s badge');
  });

  console.log('-'.repeat(74));
  console.log('  ranking-parity-check: ' + passed + ' passed, ' + failures.length + ' failed\n');
  if (failures.length) process.exit(1);
})().catch((err) => {
  console.error('\nharness error:', err && err.stack);
  process.exit(1);
});
