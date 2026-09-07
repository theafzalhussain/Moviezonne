'use strict';

/*  Verifies the OTT sub-sections (Web Series / Movies) against the live TMDB API.
 *
 *  The question this answers: when a user opens Netflix > Web Series, is every
 *  card actually a Netflix series? The previous implementation seeded the grid
 *  from /trending/tv/week, which is global and provider-blind, so it was not.
 *
 *  What is checked, per platform, per mode:
 *    1. STRUCTURAL — every query in the plan is provider-gated, and no global
 *       /trending/ endpoint is used as a content source.
 *    2. ACCURACY   — a sample of the rendered titles is re-checked against
 *       each title's own /watch/providers record. This is an independent
 *       source of truth from the discover filter that produced them.
 *    3. PURITY     — Web Series returns only series, Movies only movies.
 *    4. DEPTH      — the first load can fill the 24-card grid.
 *    5. ORDERING   — trending / latest really do land at the top.
 *
 *  The functions under test are extracted from moviezone.js at runtime rather
 *  than copy-pasted, so this file cannot drift away from the shipped code.
 *
 *  Run: node ott-sections-check.js
 */

// The suite makes several hundred small provider lookups; the production
// rate limit would turn those into 429s and they would read as real failures.
process.env.API_RATE_LIMIT_MAX = process.env.API_RATE_LIMIT_MAX || '5000';

const http = require('http');
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');
const app = require('./server');

// ── extract the real implementation out of moviezone.js ────────────────────
const src = fs.readFileSync('moviezone.js', 'utf8');

/** Slice a `{...}` block starting at the first brace after `marker`. */
function block(marker) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('not found in moviezone.js: ' + marker);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced braces after: ' + marker);
}

/** Slice a single-line statement beginning at `marker`. */
function line(marker) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('not found in moviezone.js: ' + marker);
  return src.slice(at, src.indexOf('\n', at));
}

const extracted = [
  block('const OTT = {') + ';',
  line("const OTT_MONETIZATION ="),
  block('const OTT_ALT_PROVIDERS = {') + ';',
  block('function ottISTDate('),
  block('function buildOttModeQueries('),
  line('const _ottVerifyCache ='),
  /*  The batch-priming helpers. They exist purely to collapse the OTT section's
      request waves into one round trip each, and they no-op in this sandbox
      because `typeof tmdbBatch !== 'function'` here — so the functions below are
      exercised on exactly the code path they had before batching existed. They
      are extracted rather than stubbed so a change to them cannot slip past. */
  block('async function _ottPrimeBatch('),
  block('async function _ottPrimeProviders('),
  block('async function ottIsOnPlatform('),
  line('const OTT_SAMPLE_SIZE ='),
  line('const OTT_SAMPLE_MIN_PASS ='),
  line('const OTT_DEEP_VERIFY_CAP ='),
  line('const _ottAudited ='),
  block('async function ottEnforceAccuracy('),
  block('async function fetchOttMovies('),
  // `const` is lexical and never lands on the VM context object, so hand the
  // bindings out explicitly.
  'globalThis.__ott = { OTT, OTT_ALT_PROVIDERS, OTT_MONETIZATION,' +
  ' buildOttModeQueries, fetchOttMovies, ottIsOnPlatform };'
].join('\n\n');

// ── live TMDB access through the app's own proxy ───────────────────────────
let server;
let requestCount = 0;
const httpErrors = {};

function api(endpoint, params) {
  requestCount++;
  const qs = Object.entries(params || {})
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const path = '/api/tmdb' + endpoint + (qs ? '?' + qs : '');
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        // A 429 or 5xx must never be mistaken for "no results" — that is how
        // throttling silently turns into a false accuracy verdict.
        if (res.statusCode !== 200) {
          httpErrors[res.statusCode] = (httpErrors[res.statusCode] || 0) + 1;
          return reject(new Error('HTTP ' + res.statusCode + ' on ' + endpoint));
        }
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error('bad JSON from ' + endpoint + ': ' + b.slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

const sandbox = { tmdb: api, console, Date, Math, Promise, Map, Set, Object, Array, String, Number, JSON };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(extracted, sandbox);

const { OTT, OTT_ALT_PROVIDERS, OTT_MONETIZATION, buildOttModeQueries, fetchOttMovies } = sandbox.__ott;

// ── independent verification: does this title really stream on the platform? ──
async function verifyOnPlatform(platform, type, id) {
  const accept = OTT_ALT_PROVIDERS[platform] || [OTT[platform].provider];
  const data = await api('/' + type + '/' + id + '/watch/providers', {});
  const results = (data && data.results) || {};
  for (const region of OTT[platform].regions) {
    const entry = results[region];
    if (!entry) continue;
    const tiers = [].concat(entry.flatrate || [], entry.free || [], entry.ads || []);
    if (tiers.some((pv) => pv && accept.includes(String(pv.provider_id)))) return true;
  }
  return false;
}

// ── tiny test harness ─────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; console.log('    PASS  ' + label); }
  catch (e) {
    fail++; failures.push(label + ' — ' + e.message);
    console.log('    FAIL  ' + label + '\n            ' + e.message);
  }
}

const titleOf = (m) => m.name || m.title || ('#' + m.id);
const dateOf = (m) => m.first_air_date || m.release_date || '';

const MODES = ['webseries', 'movies'];
const PLATFORM_LABEL = {
  netflix: 'NETFLIX', prime: 'PRIME VIDEO', jiohotstar: 'JIOHOTSTAR', zee5: 'ZEE5',
  apple: 'APPLE TV+', sonyliv: 'SONYLIV', mxplayer: 'AMAZON MX PLAYER',
  aha: 'AHA', crunchyroll: 'CRUNCHYROLL'
};

/*  Depth floors, per platform and mode.
 *
 *  24 is the grid size and stays the default, because for a full-catalogue
 *  service anything less means the query plan is broken. But two platforms
 *  genuinely do not have 24 titles in TMDB's Indian data, and asserting they do
 *  would be asserting facts about the API rather than about this code:
 *
 *    aha         — 199 movies but only ~14 SERIES for watch_region=IN. aha is a
 *                  Telugu/Tamil film service; the series library is that small.
 *                  Measured yield: 12 usable series.
 *
 *  crunchyroll's movie library is also thin in absolute terms (52 titles), but
 *  the query plan still yields 57 usable cards, so it keeps the default floor.
 *
 *  The floor below is set under the measured number so normal TMDB churn does
 *  not flip the suite, while still catching a plan that returns nothing. Raise
 *  the default, never this, if the grid grows.
 */
const DEPTH_FLOOR_DEFAULT = 24;
const DEPTH_FLOORS = {
  'aha:webseries': 8
};
const depthFloor = (platform, mode) =>
  DEPTH_FLOORS[platform + ':' + mode] !== undefined
    ? DEPTH_FLOORS[platform + ':' + mode]
    : DEPTH_FLOOR_DEFAULT;

(async () => {
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

  for (const platform of Object.keys(OTT)) {
    for (const mode of MODES) {
      console.log('\n=== ' + PLATFORM_LABEL[platform] + '  >  ' + mode.toUpperCase() + ' ===');

      // 1. STRUCTURAL: the plan itself must be provider-gated end to end.
      const plan = buildOttModeQueries(platform, mode, 1);
      check('every query is provider-gated (no provider-blind source)', () => {
        assert.ok(plan.length >= 4, 'plan has only ' + plan.length + ' queries');
        plan.forEach((q) => {
          assert.ok(q.params.with_watch_providers,
            q.endpoint + ' has no with_watch_providers: ' + JSON.stringify(q.params));
          assert.ok(q.params.watch_region,
            q.endpoint + ' has no watch_region');
        });
      });
      check('no global /trending/ endpoint used as a content source', () => {
        const bad = plan.filter((q) => q.endpoint.indexOf('/trending/') === 0);
        assert.strictEqual(bad.length, 0,
          'provider-blind trending source present: ' + bad.map((b) => b.endpoint).join(', '));
      });
      /*  The gate is per-platform now (free/ad-funded services need a wider one
       *  or most of their library is invisible), so this asserts against the
       *  platform's OWN configured value rather than the global default. The
       *  guarantee being enforced is unchanged and just as strict: every query
       *  in the plan carries the gate, and rent/buy is never in it. */
      const wantGate = OTT[platform].monetization || OTT_MONETIZATION;
      check('rent/buy titles excluded (monetization = ' + wantGate + ')', () => {
        assert.ok(!/\b(rent|buy)\b/.test(wantGate),
          platform + ' admits rent/buy titles: ' + wantGate);
        plan.forEach((q) => {
          assert.strictEqual(q.params.with_watch_monetization_types, wantGate,
            q.endpoint + ' missing the monetization gate');
        });
      });

      // 2. Run the real fetcher, then apply the same post-filter loadMovies uses.
      const raw = await fetchOttMovies(platform, mode, 1);
      const items = raw.filter((m) => {
        if (!m.poster_path) return false;
        const d = dateOf(m);
        if (!d) return (m.vote_count || 0) > 50;
        return d <= today;
      });

      console.log('  returned ' + items.length + ' usable titles');
      console.log('  top 8: ' + items.slice(0, 8)
        .map((m) => titleOf(m) + ' (' + (dateOf(m) || '?').slice(0, 4) + ')').join(', '));

      // 3. PURITY
      check('mode purity — ' + (mode === 'webseries' ? 'series only' : 'movies only'), () => {
        const want = mode === 'webseries' ? 'tv' : 'movie';
        const wrong = items.filter((m) => m.media_type !== want);
        assert.strictEqual(wrong.length, 0,
          wrong.length + ' wrong-type items, e.g. ' + wrong.slice(0, 3).map(titleOf).join(', '));
      });

      // 4. DEPTH
      const floor = depthFloor(platform, mode);
      check('first load fills the grid (>=' + floor + ')', () => {
        assert.ok(items.length >= floor,
          'only ' + items.length + ' cards available, floor is ' + floor);
      });

      // 5. ACCURACY — re-check a sample against each title's own provider record.
      const sample = items.slice(0, 14);
      const verdicts = await Promise.all(
        sample.map((m) => verifyOnPlatform(platform, m.media_type, m.id).catch(() => null))
      );
      const known = verdicts.filter((v) => v !== null);
      const onPlatform = verdicts.filter((v) => v === true).length;
      const offPlatform = sample.filter((m, i) => verdicts[i] === false);
      const rate = known.length ? Math.round((onPlatform / known.length) * 100) : 0;
      console.log('  provider re-check: ' + onPlatform + '/' + known.length
        + ' confirmed on ' + PLATFORM_LABEL[platform] + ' (' + rate + '%)');
      if (offPlatform.length) {
        console.log('  NOT on platform: ' + offPlatform.map(titleOf).join(', '));
      }
      check('sampled titles are genuinely on ' + PLATFORM_LABEL[platform] + ' (>=90%)', () => {
        assert.ok(known.length >= 8, 'only ' + known.length + ' titles could be verified');
        assert.ok(rate >= 90, rate + '% verified; off-platform: '
          + (offPlatform.map(titleOf).join(', ') || 'n/a'));
      });

      // 6. ORDERING — trending/latest must actually be at the top.
      const meanPop = (list) => list.reduce((s, m) => s + (m.popularity || 0), 0) / (list.length || 1);
      /*  The head must be a STRICT subset or the comparison is vacuous: aha has
       *  12 series in TMDB's Indian data, so slice(0, 12) was the entire list and
       *  "head mean > overall mean" could never hold no matter how well the
       *  ranking worked. Full catalogues still use 12, exactly as before. */
      const headSize = Math.min(12, Math.max(2, Math.floor(items.length / 2)));
      const topPop = meanPop(items.slice(0, headSize));
      const allPop = meanPop(items);
      console.log('  mean popularity: top-' + headSize + ' ' + topPop.toFixed(1)
        + ' vs overall ' + allPop.toFixed(1));
      check('trending sits at the top (top-' + headSize + ' more popular than average)', () => {
        assert.ok(items.length >= 4, 'only ' + items.length + ' items — nothing to order');
        assert.ok(topPop > allPop,
          'top-' + headSize + ' mean ' + topPop.toFixed(1) + ' is not above overall ' + allPop.toFixed(1));
      });
      /*  Asserting "there is always something from the last 13 months" asserts a
       *  fact about TMDB, not about this code — aha's 12 series are all older
       *  than that. What this code is actually responsible for is: WHEN the pool
       *  contains recent titles, the ranking must put one on the first screen.
       *  That is the stronger claim, and it is what is checked. */
      const cutoff = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      const freshInPool = items.filter((m) => dateOf(m) && dateOf(m) >= cutoff);
      check('latest releases surface in the first screen', () => {
        if (!freshInPool.length) {
          console.log('    (no title newer than ' + cutoff + ' exists in this catalogue at all)');
          return;
        }
        const freshUpTop = items.slice(0, 24).filter((m) => dateOf(m) && dateOf(m) >= cutoff);
        assert.ok(freshUpTop.length >= 1,
          freshInPool.length + ' title(s) from the last ~13 months exist but none reached the first 24');
      });
    }
  }

  // ── regression guard on the shipped source ───────────────────────────────
  console.log('\n=== regression: source-level guarantees ===');
  check('buildOttModeQueries never references a global trending endpoint', () => {
    const fn = block('function buildOttModeQueries(');
    assert.ok(!/\/trending\//.test(fn), 'global trending endpoint present in the query builder');
  });
  check('loadMovies routes OTT tabs through fetchOttMovies', () => {
    assert.ok(/fetchOttMovies\(cat,\s*currentOttMode,\s*currentMoviePage\)/.test(src),
      'loadMovies is not calling fetchOttMovies with the active mode');
  });
  /*  The OTT prefetch was removed deliberately: it spent ~7 requests on a page the
   *  user may never scroll to, against a 30-per-10s client cap, and that is what
   *  made the next platform click queue. Assert it stays removed. */
  check('platform pages are not speculatively prefetched', () => {
    assert.ok(!/buildOttModeQueries\(cat,\s*currentOttMode,\s*pageNum\)/.test(src),
      'the OTT prefetch is back — it competes with the click for the rate budget');
    assert.ok(/goToFeedPage/.test(src), 'the pager is missing, so paging really would break');
  });
  check('the accuracy audit is detached and runs once per platform', () => {
    assert.ok(/const _ottAudited = new Set\(\);/.test(src), '_ottAudited is missing');
    const fn = block('async function fetchOttMovies(');
    assert.ok(/if \(!_ottAudited\.has\(key\)\)/.test(fn),
      'fetchOttMovies audits on every call instead of once per platform');
    assert.ok(!/return ottEnforceAccuracy\(/.test(fn),
      'fetchOttMovies still awaits the accuracy sample — that blocks the grid');
    assert.ok(/return ranked;/.test(fn), 'fetchOttMovies does not return the ranked pool');
  });
  check('every platform exposes the catalogue heading', () => {
    assert.ok(/if \(OTT\[cat\]\) updateOttHeading\(cat\);/.test(src),
      'filterCat does not set the platform heading');
    ['netflix', 'prime', 'jiohotstar', 'zee5',
      'apple', 'sonyliv', 'mxplayer', 'aha', 'crunchyroll'].forEach((p) => {
      assert.ok(new RegExp(p + ':\\s*\\{').test(src), p + ' missing from the OTT table');
    });
  });

  /*  The OTT sub-filter bar and the OTT Platform dropdown were removed: a provider
   *  card opens the platform's whole catalogue directly. Guard that they do not
   *  creep back, and that the single remaining mode is not mutable. */
  check('the OTT sub-mode UI is gone and the mode is fixed to "all"', () => {
    assert.ok(/const currentOttMode = 'all';/.test(src),
      'currentOttMode is not a fixed const — a sub-mode toggle has come back');
    ['renderOttFilterBar', 'setOttMode', 'OTT_MODES'].forEach((n) => {
      assert.ok(!new RegExp('function ' + n + '\\b|const ' + n + '\\s*=').test(src),
        n + ' is back in moviezone.js');
    });
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(!/catGroupOttMenu|catGroupOttBtn/.test(html),
      'the OTT Platform dropdown is back in index.html');
    assert.ok(!/ottFilterBar/.test(html), 'the OTT chip bar is back in index.html');
  });

  /*  No provider-blind source may return: the global-trending overlay was removed
   *  precisely because it was the only one, and it cost ~44 of the ~50 requests a
   *  cold click used to make against a 30-per-10s client rate cap. */
  check('fetchOttMovies reads no global /trending/ list', () => {
    const fn = block('async function fetchOttMovies(');
    assert.ok(!/tmdb\(\s*['"]\/trending\//.test(fn) && !/ottVerifiedTrending\(/.test(fn.replace(/\/\*[\s\S]*?\*\//g, '')),
      'a global trending source is back in the blocking path');
    assert.ok(!/function ottVerifiedTrending\(/.test(src),
      'ottVerifiedTrending is back in moviezone.js');
  });

  check('every platform has a catalogue heading and a verification id list', () => {
    Object.keys(OTT).forEach((p) => {
      assert.ok(new RegExp('\\b' + p + ":\\s*'").test(src), p + ' missing from CAT_HEADINGS');
      assert.ok(OTT_ALT_PROVIDERS[p] && OTT_ALT_PROVIDERS[p].length,
        p + ' missing from OTT_ALT_PROVIDERS — verification would fall back to one id');
      assert.ok(Array.isArray(OTT[p].regions) && OTT[p].regions.length,
        p + ' has no regions array — buildOttModeQueries would throw in movies mode');
    });
  });

  /*  The rail is now the ONLY route into a platform, so the card is the contract.
   *  A platform also must NOT have a .cat-tab any more, or the dropdown is back. */
  check('every platform is reachable from the provider rail only', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    Object.keys(OTT).forEach((p) => {
      assert.ok(new RegExp('data-provider-cat="' + p + '"').test(html),
        p + ' has no provider card in index.html');
      assert.ok(!new RegExp("filterCat\\('" + p + "'\\)").test(html),
        p + ' still has a cat-tab entry — it should only be reachable from the rail');
    });
  });

  /*  With no .cat-tab for a platform, anything that recovered the category by
   *  scraping the DOM would silently drop the user back into the 'all' feed. */
  check('paging and refresh read the category from state, not from a tab', () => {
    assert.ok(/function currentFeedCategory\(\)/.test(src),
      'currentFeedCategory() is missing');
    assert.ok(/if \(mzFeedPagerCategory\) return mzFeedPagerCategory;/.test(src),
      'currentFeedCategory does not prefer the loader state');
    assert.ok(/function loadMoreMoviesAction\(\) \{\s*loadMovies\(currentFeedCategory\(\), true\);/.test(src),
      'loadMoreMoviesAction still derives the category some other way');
  });

  /*  The final on-screen order is NOT fetchOttMovies' order. The fetcher ranks by
   *  platform relevance; loadMovies then re-ranks with the ALL feed's product
   *  priority so newest releases lead. The ORDERING checks above therefore
   *  measure the fetcher, and this guards the step they cannot see. */
  check('platform tabs are re-ranked with the ALL-feed priority', () => {
    assert.ok(/ottRankLikeAllFeed\(await fetchOttMovies\(cat,\s*currentOttMode,\s*currentMoviePage\)\)/.test(src),
      'loadMovies does not pass the OTT result through ottRankLikeAllFeed');
    const fn = block('function ottRankLikeAllFeed(');
    assert.ok(/rankByFreshness\(items\)/.test(fn),
      'ottRankLikeAllFeed does not use the shared freshness ranking');
    assert.ok(/interleaveFeedByType\(diversifyByLanguageWithinPriority\(items\)\)/.test(fn),
      'ottRankLikeAllFeed skips language balancing or type interleave');
    assert.ok(/_priorityGroup - b\._priorityGroup/.test(fn),
      'ottRankLikeAllFeed does not sort by priority group first — recency would lose to popularity');
  });

  check('every platform has a catalogue heading and a verification id list', () => {
    Object.keys(OTT).forEach((p) => {
      assert.ok(new RegExp('\\b' + p + ":\\s*'").test(src), p + ' missing from CAT_HEADINGS');
      assert.ok(OTT_ALT_PROVIDERS[p] && OTT_ALT_PROVIDERS[p].length,
        p + ' missing from OTT_ALT_PROVIDERS — verification would fall back to one id');
      assert.ok(Array.isArray(OTT[p].regions) && OTT[p].regions.length,
        p + ' has no regions array — buildOttModeQueries would throw in movies mode');
    });
  });

  check('verification fails OPEN, never silently dropping valid titles', () => {
    const fn = block('async function ottIsOnPlatform(');
    assert.ok(/return null;/.test(fn),
      'ottIsOnPlatform never returns null — a failed request would read as "not on platform"');
    assert.ok(!/catch \(e\) \{ return false; \}/.test(fn),
      'ottIsOnPlatform still returns false on request failure (fail-closed)');
  });
  check('no request in this run was throttled or errored', () => {
    const codes = Object.keys(httpErrors);
    assert.strictEqual(codes.length, 0,
      'HTTP errors occurred, results are not trustworthy: ' + JSON.stringify(httpErrors));
  });

  await new Promise((r) => server.close(r));
  console.log('\n' + '='.repeat(60));
  console.log('  ott-sections-check: ' + pass + ' passed, ' + fail + ' failed'
    + '   (' + requestCount + ' TMDB requests)');
  if (fail) failures.forEach((f) => console.log('   ✗ ' + f));
  console.log('='.repeat(60) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('crashed:', e);
  if (server) server.close();
  process.exit(1);
});
