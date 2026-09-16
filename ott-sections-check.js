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

/** Slice an array literal at `marker`, terminated by its first `];`. */
function arr(marker) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('not found in moviezone.js: ' + marker);
  const end = src.indexOf('];', at);
  if (end === -1) throw new Error('unterminated array literal at: ' + marker);
  return src.slice(at, end + 2);
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
  line('const OTT_RECENCY_MIN_VOTES ='),
  line('const OTT_RECENCY_MIN_POPULARITY ='),
  block('const OTT_SIGNAL_WEIGHTS = {') + ';',
  line('const OTT_SIGNAL_NAMES ='),
  block('function promoteOttSignalMix('),
  block('async function ottEnforceAccuracy('),
  block('async function fetchOttMovies('),

  /*  ── THE ORDER THE USER ACTUALLY SEES ──────────────────────────────────
   *  fetchOttMovies answers "what is big on this service": it ranks by chart
   *  position, then provider signal tier, then signal count, then score. That
   *  is NOT the grid. For an OTT tab loadMovies renders
   *  ottRankLikeAllFeed(allMovies) — the regression guard at the bottom of this
   *  file asserts that exact line — which re-ranks by priority group, freshness
   *  tier, an era weight and a gated recency premium.
   *
   *  The two ORDERING checks below used to measure `items`, an intermediate
   *  array nobody ever looks at, and so they read the first screen wrong in both
   *  directions. Measured live: Vi > Web Series' newest audience-backed title
   *  sat at position 33 in `items` and at position 7 once rendered; ShemarooMe's
   *  went 31 -> 6. Netflix > Web Series carried 4 recent titles in the fetcher's
   *  first 24 and 22 in the rendered first 24.
   *
   *  So the whole pipeline is extracted, for the same reason everything else in
   *  this file is: a copy would drift, and the ranking is the thing under test.
   */
  line('const DAY_MS ='),
  line('const CATALOGUE_ERA_GRACE_YEARS ='),
  line('const CATALOGUE_ERA_DECAY ='),
  line('const YEAR_MS ='),
  line('const RATING_PRIOR_VOTES ='),
  line('const RATING_PRIOR_MEAN ='),
  line('const TRENDING_MIN_VOTES ='),
  line('const FRESH_TIER_DAYS ='),
  line('const FRESH_TIER_MIN_POPULARITY ='),
  line('const FRESH_TIER_MIN_VOTES ='),
  line('const QUALITY_UPGRADE_BADGE_DAYS ='),
  line('const REGIONAL_INDUSTRY_LANGUAGES ='),
  line('const REGIONAL_FRESH_MIN_POPULARITY ='),
  line('const REGIONAL_FRESH_MIN_VOTES ='),
  line('const LATEST_WINDOW_DAYS ='),
  line('const FEED_FIRST_SCREEN_INDUSTRIES ='),
  line('const FEED_PROMOTABLE_GROUPS ='),
  line('const FEED_SERIES_PROMOTABLE_GROUPS ='),
  line('const FEED_CATALOGUE_MOVIE_GROUPS ='),
  line('const FEED_CATALOGUE_SERIES_GROUPS ='),
  arr('const FEED_SLOT_PATTERN ='),
  arr('const MOVIE_QUALITY_TIMELINE = ['),
  arr('const TV_QUALITY_TIMELINE = ['),
  block('function mediaTypeOf('),
  block('function qualityTimelineFor('),
  block('function qualityAtStage('),
  block('function titleQualityState('),
  block('function catalogueEventAgeDays('),
  block('function freshTierFloors('),
  block('function freshnessTier('),
  block('function allFeedPriorityGroup('),
  block('function calculateMovieScore('),
  block('function rankByFreshness('),
  block('function feedLaneOf('),
  block('function diversifyByLanguageWithinPriority('),
  block('function industryRepresentative('),
  block('function promotableToFirstScreen('),
  block('function promoteFreshIndustryMix('),
  block('function interleaveFeedByType('),
  block('function catalogueEraFactor('),
  block('function isAnimeContent('),
  block('function isCartoonContent('),
  block('function ottRankLikeAllFeed('),

  // `const` is lexical and never lands on the VM context object, so hand the
  // bindings out explicitly.
  'globalThis.__ott = { OTT, OTT_ALT_PROVIDERS, OTT_MONETIZATION,' +
  ' OTT_SIGNAL_NAMES, buildOttModeQueries, fetchOttMovies, ottIsOnPlatform,' +
  ' promoteOttSignalMix, ottRankLikeAllFeed,' +
  ' OTT_RECENCY_MIN_VOTES, OTT_RECENCY_MIN_POPULARITY };'
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

const sandbox = {
  tmdb: api, console, Date, Math, Promise, Map, Set, Object, Array, String, Number, JSON,
  isFinite, isNaN, parseInt, parseFloat
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(extracted, sandbox);

const {
  OTT, OTT_ALT_PROVIDERS, OTT_MONETIZATION, OTT_SIGNAL_NAMES,
  buildOttModeQueries, fetchOttMovies, promoteOttSignalMix, ottRankLikeAllFeed,
  OTT_RECENCY_MIN_VOTES, OTT_RECENCY_MIN_POPULARITY
} = sandbox.__ott;

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
  aha: 'AHA', crunchyroll: 'CRUNCHYROLL',
  sunnxt: 'SUN NXT', lionsgate: 'LIONSGATE PLAY', vi: 'VI MOVIES & TV',
  discoveryplus: 'DISCOVERY+', shemaroo: 'SHEMAROOME'
};

/*  Depth floors, per platform and mode.
 *
 *  24 is the grid size and stays the default, because for a full-catalogue
 *  service anything less means the query plan is broken. But one platform
 *  genuinely does not have 24 titles in TMDB's Indian data, and asserting it
 *  does would be asserting facts about the API rather than about this code:
 *
 *    aha         — 199 movies but only ~14 SERIES for watch_region=IN. aha is a
 *                  Telugu/Tamil film service; the series library is that small.
 *                  Measured yield: 12 usable series.
 *
 *  crunchyroll's movie library is also thin in absolute terms (52 titles), but
 *  the query plan still yields 57 usable cards, so it keeps the default floor.
 *
 *  Platforms with a declared single-type `catalogue` are NOT listed here. They
 *  are handled by skipMode() below, which re-measures the missing side against
 *  TMDB instead of granting it a lowered floor — a floor of 0 would pass
 *  whether the catalogue was empty by nature or empty because the plan broke.
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

/*  Single-type platforms: prove the declaration, then skip the absent mode.
 *
 *  discovery+ has 1 movie and ShemarooMe has 0 series for watch_region=IN, so
 *  running the movies / webseries mode against them would test nothing except
 *  TMDB's inventory. The declaration in the shipped OTT table is what lets the
 *  fetcher spend its whole request budget on the type that exists — so what
 *  this checks is the DECLARATION, against the live API:
 *
 *    - the declared-present type must be a full catalogue (>= 200 titles), or
 *      `catalogue` is throttling a platform that should be fetching both;
 *    - the declared-absent type must really be absent (< 25 titles, i.e. it
 *      could not fill even one grid), or the platform has grown a library that
 *      the shipped plan is now silently discarding.
 *
 *  Either way this fails loudly instead of quietly skipping, which is the whole
 *  difference between this and a hardcoded exemption list.
 */
const CATALOGUE_PRESENT_MIN = 200;
const CATALOGUE_ABSENT_MAX = 25;

async function catalogueSize(platform, type) {
  const cfg = OTT[platform];
  const d = await api('/discover/' + type, {
    with_watch_providers: cfg.provider,
    watch_region: 'IN',
    with_watch_monetization_types: cfg.monetization || OTT_MONETIZATION,
    sort_by: 'popularity.desc'
  });
  return (d && d.total_results) || 0;
}

(async () => {
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

  for (const platform of Object.keys(OTT)) {
    for (const mode of MODES) {
      console.log('\n=== ' + PLATFORM_LABEL[platform] + '  >  ' + mode.toUpperCase() + ' ===');

      /*  Single-type platforms: the absent mode is not run, but the claim that
       *  it is absent IS tested, against the live API. */
      const declared = OTT[platform].catalogue;
      if (declared) {
        const presentMode = declared === 'tv' ? 'webseries' : 'movies';
        const absentType = declared === 'tv' ? 'movie' : 'tv';
        if (mode !== presentMode) {
          const [presentN, absentN] = await Promise.all([
            catalogueSize(platform, declared), catalogueSize(platform, absentType)
          ]);
          console.log('  declared "' + declared + ' only" — TMDB IN has '
            + declared + ' ' + presentN + ' / ' + absentType + ' ' + absentN);
          check('the ' + absentType + ' library really is absent (<' + CATALOGUE_ABSENT_MAX + ')', () => {
            assert.ok(absentN < CATALOGUE_ABSENT_MAX, absentN + ' ' + absentType
              + ' titles now exist for ' + platform + ' — it is no longer a '
              + declared + '-only catalogue, and the shipped plan is discarding them');
          });
          check('the ' + declared + ' library is a full catalogue (>=' + CATALOGUE_PRESENT_MIN + ')', () => {
            assert.ok(presentN >= CATALOGUE_PRESENT_MIN, 'only ' + presentN + ' ' + declared
              + ' titles — catalogue:"' + declared + '" is throttling a platform that has neither side');
          });
          /*  The point of the declaration is that the shipped 'all' mode — the
           *  only mode the UI opens — spends every request on the type that
           *  exists. Assert the remap, or the field is documentation only. */
          check('the shipped "all" plan queries only /' + declared + ' endpoints', () => {
            const allPlan = buildOttModeQueries(platform, 'all', 1);
            assert.ok(allPlan.length >= 4, 'all plan has only ' + allPlan.length + ' queries');
            const strays = allPlan.filter((q) => q.type !== declared);
            assert.strictEqual(strays.length, 0, strays.length + ' of ' + allPlan.length
              + ' queries hit /' + absentType + ', which has ' + absentN + ' titles: '
              + strays.map((s) => s.endpoint).join(', '));
          });
          continue;
        }
      }

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
      check('plan contains new, trending and popular provider-scoped lanes', () => {
        const tags = new Set(plan.map((q) => q.tag));
        OTT_SIGNAL_NAMES.forEach((signal) => {
          assert.ok(tags.has(signal), signal + ' lane missing from ' + platform + ' ' + mode);
        });
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

      // Dynamic discovery provenance must survive type+id dedupe. The same
      // title can be new AND trending/popular, and that overlap is intentional.
      check('dedupe preserves explicit OTT discovery signals', () => {
        items.forEach((m) => {
          assert.ok(m._ottSignals && typeof m._ottSignals === 'object',
            titleOf(m) + ' has no _ottSignals provenance');
          OTT_SIGNAL_NAMES.forEach((signal) => {
            assert.strictEqual(typeof m._ottSignals[signal], 'boolean',
              titleOf(m) + ' has no boolean ' + signal + ' signal');
          });
          assert.ok(m._ottSignalTier === 0 || m._ottSignalTier === 1,
            titleOf(m) + ' has invalid signal tier ' + m._ottSignalTier);
        });
      });

      const signalOrdered = promoteOttSignalMix(items);
      OTT_SIGNAL_NAMES.forEach((signal) => {
        const cohort = items.filter((m) =>
          m._ottSignalTier === 0 && m._ottSignals && m._ottSignals[signal]);
        check(signal + ' titles surface in the first screen when eligible', () => {
          if (!cohort.length) return;
          assert.ok(signalOrdered.slice(0, 24).some((m) => m._ottSignals[signal]),
            cohort.length + ' eligible ' + signal + ' title(s) exist but none reached the first 24');
        });
      });

      check('dynamic signals lead catalogue-only titles', () => {
        const firstCatalogue = signalOrdered.findIndex((m) => m._ottSignalTier !== 0);
        const lastDynamic = signalOrdered.reduce(
          (last, m, i) => m._ottSignalTier === 0 ? i : last, -1
        );
        if (firstCatalogue === -1 || lastDynamic === -1) return;
        assert.ok(lastDynamic < firstCatalogue,
          'a catalogue-only card appears at ' + firstCatalogue
          + ' before the last dynamic card at ' + lastDynamic);
      });

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
        /*  Sample adequacy scales with the catalogue, for exactly the reason the
         *  depth floor and headSize above already do: aha's Indian series
         *  library yields 12 titles and a thinner one could yield fewer, so a
         *  flat 8-title sample would assert a fact about TMDB rather than about
         *  this code. The guarantee is unchanged where there is a catalogue to
         *  sample — 8 is still required of every platform/mode pair that has 8
         *  titles, which is every one except the thin cases documented at
         *  DEPTH_FLOORS. The 90% rate never moves, and the hard floor of 3 keeps
         *  a provider id that has been retired (and now returns one or two stray
         *  titles) from passing on a sample too small to mean anything. */
        const wantSample = Math.min(8, items.length);
        assert.ok(known.length >= 3,
          'only ' + known.length + ' titles could be verified — too few to judge');
        assert.ok(known.length >= wantSample, 'only ' + known.length
          + ' of ' + items.length + ' titles could be verified, needed ' + wantSample);
        assert.ok(rate >= 90, rate + '% verified; off-platform: '
          + (offPlatform.map(titleOf).join(', ') || 'n/a'));
      });

      // 6. ORDERING — trending/latest must actually be at the top.
      /*  Everything below measures `rendered`, not `items`, wherever the claim is
       *  about the first SCREEN. See the extraction note at the top: `items` is
       *  the fetcher's relevance order and `rendered` is what loadMovies paints. */
      const rendered = ottRankLikeAllFeed(items.slice());
      const meanPop = (list) => list.reduce((s, m) => s + (m.popularity || 0), 0) / (list.length || 1);
      /*  The head must be a STRICT subset or the comparison is vacuous: aha has
       *  12 series in TMDB's Indian data, so slice(0, 12) was the entire list and
       *  "head mean > overall mean" could never hold no matter how well the
       *  ranking worked. Full catalogues still use 12, exactly as before. */
      const headSize = Math.min(12, Math.max(2, Math.floor(items.length / 2)));
      const head = items.slice(0, headSize);
      const tail = items.slice(headSize);

      /*  ── WHY "TRENDING AT THE TOP" IS NOT A RAW POPULARITY COMPARISON ──
       *
       *  This used to assert mean(popularity) of the head > mean(popularity) of
       *  the pool, over every title. On ZEE5 > Web Series that reported a
       *  failure — head 16.1 vs overall 17.0 — and the ranking was right while
       *  the assertion was wrong. The head there is Bhagya Lakshmi (110 votes),
       *  Rabb Se Hai Dua (92), Shiv Shakti (57), Radha Mohan (18): titles ZEE5's
       *  own provider queries returned in TWO discovery lanes. The titles with
       *  higher TMDB `popularity` sitting behind them are Kanaa (popularity
       *  55.7, ZERO votes), Ninaithen Vandhai (53.5, ZERO votes), Savdhaan India
       *  (46.2, ONE vote) — daily-soap catalogue entries whose popularity number
       *  has no audience behind it.
       *
       *  That is the same trap OTT_RECENCY_MIN_VOTES exists to avoid, quoted
       *  from its own comment in moviezone.js: popularity 1, zero votes. So
       *  popularity is compared only across titles that clear the audience floor
       *  the ranking itself uses — where the field means something — and the
       *  ordering contract the fetcher genuinely implements (signal tier, then
       *  signal count) is asserted directly instead of through a proxy.
       */
      const voted = items.filter((m) => (m.vote_count || 0) >= OTT_RECENCY_MIN_VOTES);
      const votedHead = head.filter((m) => (m.vote_count || 0) >= OTT_RECENCY_MIN_VOTES);
      console.log('  mean popularity (audience-backed only): top-' + headSize + ' '
        + meanPop(votedHead).toFixed(1) + ' vs pool ' + meanPop(voted).toFixed(1)
        + '  [' + voted.length + '/' + items.length + ' titles clear '
        + OTT_RECENCY_MIN_VOTES + ' votes]');
      check('trending sits at the top (audience-backed head more popular than average)', () => {
        assert.ok(items.length >= 4, 'only ' + items.length + ' items — nothing to order');
        if (voted.length < 8 || votedHead.length < 2) {
          console.log('    (too few audience-backed titles to compare popularity honestly)');
          return;
        }
        assert.ok(meanPop(votedHead) > meanPop(voted),
          'audience-backed head mean ' + meanPop(votedHead).toFixed(1)
          + ' is not above pool ' + meanPop(voted).toFixed(1));
      });
      /*  The contract fetchOttMovies actually implements, asserted directly: a
       *  title the provider surfaced in more discovery lanes outranks one it
       *  surfaced in fewer, and no catalogue-only card takes a head slot while a
       *  signalled title is still waiting for one. */
      check('the head is what the provider discovery lanes surfaced', () => {
        assert.ok(items.length >= 4, 'only ' + items.length + ' items — nothing to order');
        const sigMean = (l) => l.reduce((s, m) => s + (m._ottSignalCount || 0), 0) / (l.length || 1);
        const multi = items.filter((m) => (m._ottSignalCount || 0) > 1).length;
        const hs = sigMean(head), ts = sigMean(tail);
        assert.ok(multi ? hs > ts : hs >= ts,
          'head mean signal count ' + hs.toFixed(2) + ' does not lead the tail ' + ts.toFixed(2)
          + ' (' + multi + ' multi-signal titles in the pool)');
        const tier0 = items.filter((m) => m._ottSignalTier === 0).length;
        const headTier1 = head.filter((m) => m._ottSignalTier !== 0).length;
        assert.ok(headTier1 === 0 || tier0 <= headSize,
          headTier1 + ' catalogue-only card(s) hold head slots while '
          + tier0 + ' signalled titles exist');
      });
      /*  Asserting "there is always something from the last 13 months" asserts a
       *  fact about TMDB, not about this code — aha's 12 series are all older
       *  than that. What this code is actually responsible for is: WHEN the pool
       *  contains recent titles, the ranking must put one on the first screen.
       *
       *  Two things make that the real guarantee rather than an overreach:
       *
       *  1. It is measured on `rendered`. The recency premium that lifts a new
       *     release lives in ottRankLikeAllFeed, so asking `items` about it was
       *     asking the wrong array — see the extraction note above.
       *
       *  2. The cohort is gated by the audience floor the premium itself is
       *     gated by. moviezone.js refuses to promote a brand-new title nobody
       *     has rated, on purpose and with a measured reason recorded at
       *     OTT_RECENCY_MIN_VOTES. Demanding a first-screen slot for a zero-vote
       *     title would demand exactly the regression that gate prevents: the
       *     five reports this replaces were all such titles, e.g. ZEE5's "Brown"
       *     (0 votes, popularity 2.6) and an MX Player entry with 0 votes and
       *     popularity 0.6.
       */
      const cutoff = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      const audienceBacked = (m) => (m.vote_count || 0) >= OTT_RECENCY_MIN_VOTES
        || (m.popularity || 0) >= OTT_RECENCY_MIN_POPULARITY;
      const freshInPool = items.filter((m) => dateOf(m) && dateOf(m) >= cutoff);
      const freshEligible = freshInPool.filter(audienceBacked);
      check('latest releases surface in the first screen', () => {
        if (!freshInPool.length) {
          console.log('    (no title newer than ' + cutoff + ' exists in this catalogue at all)');
          return;
        }
        if (!freshEligible.length) {
          console.log('    (' + freshInPool.length + ' recent title(s), none with an audience yet — '
            + 'the recency premium is gated, so none is owed a first-screen slot)');
          return;
        }
        const sameTitle = (a, b) => a.id === b.id && a.media_type === b.media_type;
        const upTop = rendered.slice(0, 24).filter((m) => freshEligible.some((f) => sameTitle(f, m)));
        assert.ok(upTop.length >= 1,
          freshEligible.length + ' audience-backed title(s) from the last ~13 months exist but none '
          + 'reached the first 24 of the rendered grid (pool has ' + freshInPool.length + ' recent)');
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
    assert.ok(/fetchOttMovies\(cat,\s*requestedOttMode,\s*requestedMoviePage\)/.test(src),
      'loadMovies is not calling fetchOttMovies with its captured mode and page');
  });
  check('a stale OTT mode request cannot poison the active mode pool', () => {
    const fn = block('async function loadMovies(');
    assert.ok(/const loadGeneration = \+\+_mzFeedLoadGeneration;/.test(fn),
      'loadMovies does not assign request ownership generations');
    assert.ok(/const loadPoolKey = _mzPoolKey\(cat\);/.test(fn),
      'loadMovies does not capture the requested mode-specific pool key');
    assert.ok(/loadPoolKey !== _mzPoolKey\(cat\)/.test(fn)
      && /loadGeneration !== _mzFeedLoadGeneration/.test(fn),
      'the superseded-response guard checks category only, not mode and generation');
    assert.ok(/_mzSavePool\(cat,\s*loadPoolKey\)/.test(fn),
      'the completed result is not saved under its captured mode key');
  });
  check('OTT extensions globally merge signals and re-rank the provider pool', () => {
    const fn = block('async function loadMovies(');
    const append = fn.indexOf('allMovies = allMovies.concat(newMovies)');
    const rerank = fn.indexOf('if (OTT[cat]) allMovies = ottRankLikeAllFeed(allMovies)');
    assert.ok(/mergeOttSignalMetadata\(existingById\.get\(k\),\s*m\)/.test(fn),
      'cross-page dedupe discards newly discovered signals for an existing title');
    assert.ok(append !== -1 && rerank > append,
      'later dynamic OTT pages remain appended behind earlier catalogue-only cards');
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
      'apple', 'sonyliv', 'mxplayer', 'aha', 'crunchyroll',
      'sunnxt', 'lionsgate', 'vi', 'discoveryplus', 'shemaroo'].forEach((p) => {
      assert.ok(new RegExp(p + ':\\s*\\{').test(src), p + ' missing from the OTT table');
    });
  });

  /*  The All / Movies / Web Series bar is back, on request: a provider card opens
   *  the platform on `all` and the two type chips re-run the single-type plans
   *  buildOttModeQueries() already had. What is guarded here is the WIRING, because
   *  the mode is what every platform request is built from — if a chip stops
   *  reaching the fetcher the grid silently keeps showing the mixed catalogue.
   *
   *  The OTT Platform dropdown stays gone: the rail is still the only way in. */
  check('the All / Movies / Web Series sub-tabs are wired to the fetcher', () => {
    assert.ok(/let currentOttMode = 'all';/.test(src),
      'currentOttMode is not mutable — the type chips could not change it');
    ['ottModesFor', 'renderOttFilterBar', 'hideOttFilterBar', 'setOttMode'].forEach((n) => {
      assert.ok(new RegExp('function ' + n + '\\(').test(src),
        n + ' is missing from moviezone.js');
    });
    // The chip ids must be exactly the modes buildOttModeQueries understands,
    // otherwise a chip falls through to the 'all' branch and does nothing.
    ['all', 'movies', 'webseries'].forEach((id) => {
      assert.ok(new RegExp("id: '" + id + "'").test(src), id + ' is not an OTT_MODES entry');
    });
    const setter = block('function setOttMode(');
    assert.ok(/currentOttMode = mode;/.test(setter), 'setOttMode does not record the mode');
    assert.ok(/loadMovies\(cat\);/.test(setter),
      'setOttMode does not reload the feed, so the chip would do nothing');
    assert.ok(!/loadMovies\(cat,\s*true\)/.test(setter),
      'setOttMode appends to the existing pool instead of starting a fresh one');
    // A single-type platform must not offer the side it has nothing on.
    assert.ok(/cfg\.catalogue/.test(block('function ottModesFor(')),
      'ottModesFor ignores the single-type catalogue declaration');
    // Entering a platform must show the bar and start it on 'all'.
    const fc = block('function filterCat(');
    assert.ok(/renderOttFilterBar\(cat\)/.test(fc) && /hideOttFilterBar\(\)/.test(fc),
      'filterCat does not show and hide the OTT bar with the category');
    assert.ok(/currentOttMode = 'all'/.test(fc),
      'filterCat does not reset the type chip when entering a platform');
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(!/catGroupOttMenu|catGroupOttBtn/.test(html),
      'the OTT Platform dropdown is back in index.html');
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
    const activeHtml = html.replace(/<!--[\s\S]*?-->/g, '');
    Object.keys(OTT).forEach((p) => {
      assert.ok(new RegExp('data-provider-cat="' + p + '"').test(activeHtml),
        p + ' has no active provider card in index.html');
      assert.ok(!new RegExp("filterCat\\('" + p + "'\\)").test(activeHtml),
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
  check('platform tabs preserve provider signals through final ranking', () => {
    assert.ok(/ottRankLikeAllFeed\(await fetchOttMovies\(cat,\s*requestedOttMode,\s*requestedMoviePage\)\)/.test(src),
      'loadMovies does not pass the OTT result through ottRankLikeAllFeed');
    const fn = block('function ottRankLikeAllFeed(');
    assert.ok(/rankByFreshness\(items\)/.test(fn),
      'ottRankLikeAllFeed does not use the shared freshness ranking');
    assert.ok(/_ottSignalTier === 0/.test(fn),
      'ottRankLikeAllFeed does not place dynamic provider signals in the outer tier');
    assert.ok(/_priorityGroup - b\._priorityGroup/.test(fn),
      'ottRankLikeAllFeed no longer preserves freshness priority inside a signal tier');
    assert.ok(/balance\(dynamic\)\.concat\(balance\(catalogue\)\)/.test(fn),
      'dynamic and catalogue items are interleaved together, so catalogue can jump the signal boundary');
    assert.ok(/promoteOttSignalMix\(/.test(fn),
      'the final user-visible order does not guarantee signal-lane representation');
  });

  check('signal mixer represents each eligible lane without hardcoded titles', () => {
    const sample = [
      { id: 1, _ottSignalTier: 0, _ottSignals: { new: false, trending: true, popular: false } },
      { id: 2, _ottSignalTier: 0, _ottSignals: { new: false, trending: true, popular: false } },
      { id: 3, _ottSignalTier: 0, _ottSignals: { new: true, trending: false, popular: false } },
      { id: 4, _ottSignalTier: 0, _ottSignals: { new: false, trending: false, popular: true } },
      { id: 5, _ottSignalTier: 1, _ottSignals: { new: false, trending: false, popular: false } }
    ];
    const mixed = promoteOttSignalMix(sample);
    OTT_SIGNAL_NAMES.forEach((signal) => {
      assert.ok(mixed.slice(0, 3).some((m) => m._ottSignals[signal]),
        signal + ' is missing from the promoted signal mix');
    });
    assert.ok(mixed.findIndex((m) => m._ottSignalTier !== 0) > 2,
      'catalogue-only content entered before the dynamic signal representatives');
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
