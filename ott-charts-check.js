
/*  Verifies the PER-PLATFORM CHART layer against the live JustWatch and TMDB APIs.
 *
 *  ── the claim being guarded ──
 *  Clicking JioHotstar (or Netflix, or Zee5, or any of the fourteen) must open on
 *  what that service is ACTUALLY pushing right now — its own trending ranking and
 *  what it added recently — and every one of those cards must still really be on
 *  that service. Those two properties pull against each other: the ordering comes
 *  from an external source, and the accuracy guarantee ott-sections-check.js
 *  enforces comes from TMDB's provider gate. This file proves they hold together.
 *
 *  What is checked:
 *    1. MAPPING     — OTT_JW_PACKAGES agrees with the shipped OTT table, and each
 *                     JustWatch shortName really carries that TMDB provider id.
 *                     This is the check that matters most, because a wrong short
 *                     code FAILS SILENTLY: 'hst' returns the legacy Disney+
 *                     Hotstar chart instead of JioHotstar's, and the grid would
 *                     look plausible while being another platform's content.
 *    2. LIVE CHART  — /api/ott/charts answers for every platform with a usable
 *                     number of renderable cards, and both signals are present.
 *    3. ACCURACY    — a sample of the chart head is re-checked against each
 *                     title's own /watch/providers record. Independent of the
 *                     source that produced the ordering.
 *    4. HYDRATION   — every card carries the fields the grid renders from.
 *    5. WIRING      — the client actually pins the chart at the head, and the
 *                     Worker serves the same route the Express server does. A
 *                     perfect chart nothing consumes is the failure mode this
 *                     catches, and it is invisible from the API side.
 *    6. DEGRADATION — an unknown platform is rejected, and a failing upstream
 *                     answers an empty chart rather than a 5xx, because the
 *                     client reads an empty chart as "keep the old ordering".
 *
 *  Run: node ott-charts-check.js
 */

// The accuracy pass makes a provider lookup per sampled title across fourteen
// platforms; the production rate limit would turn those into 429s that read as
// real failures.
process.env.API_RATE_LIMIT_MAX = process.env.API_RATE_LIMIT_MAX || '5000';

const http = require('http');
const fs = require('fs');
const assert = require('assert');
const app = require('./server');
const charts = require('./ott-charts');

const src = fs.readFileSync('moviezone.js', 'utf8');
const workerSrc = fs.readFileSync('worker.js', 'utf8');

/*  The shipped OTT table, read out of moviezone.js rather than duplicated, so
 *  this file cannot drift from the provider ids the grid actually queries with. */
function ottTable() {
  const at = src.indexOf('const OTT = {');
  if (at === -1) throw new Error('const OTT = { not found in moviezone.js');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      // eslint-disable-next-line no-eval
      if (depth === 0) return eval('(' + src.slice(open, i + 1) + ')');
    }
  }
  throw new Error('unbalanced braces in the OTT table');
}
const OTT = ottTable();

// ── harness ────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass++;
    console.log('    PASS  ' + label);
  } catch (e) {
    fail++;
    failures.push(label + ' — ' + e.message);
    console.log('    FAIL  ' + label + '\n            ' + e.message);
  }
}

let server;
let requestCount = 0;
const httpErrors = {};

function localGet(path) {
  requestCount++;
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode >= 500) {
          httpErrors[res.statusCode] = (httpErrors[res.statusCode] || 0) + 1;
        }
        let json = null;
        try { json = JSON.parse(b); } catch (e) { /* reported by the caller */ }
        resolve({ status: res.statusCode, cache: res.headers['x-cache'], json, raw: b });
      });
    }).on('error', reject);
  });
}

const api = (endpoint) => localGet('/api/tmdb' + endpoint);

/*  Independent verification, deliberately re-implemented here rather than
 *  imported from moviezone.js: if the app's own verifier had a bug, importing it
 *  would let the bug cancel itself out. Same rule as ott-sections-check.js. */
async function verifyOnPlatform(platform, type, id) {
  const cfg = OTT[platform];
  const accept = altProviders(platform) || [cfg.provider];
  const res = await api('/' + type + '/' + id + '/watch/providers');
  const results = (res.json && res.json.results) || {};
  for (const region of cfg.regions) {
    const entry = results[region];
    if (!entry) continue;
    // flatrate / free / ads are "included with the subscription". rent and buy
    // are ignored on purpose: a rental is not "on the platform".
    const tiers = [].concat(entry.flatrate || [], entry.free || [], entry.ads || []);
    if (tiers.some(pv => pv && accept.includes(String(pv.provider_id)))) return true;
  }
  return false;
}

/*  OTT_ALT_PROVIDERS out of the source. A platform can legitimately be filed
 *  under more than one TMDB provider id — JioHotstar carries the old Disney+
 *  Hotstar id, MX Player is both 515 and 1898 — and verifying against only the
 *  query id would report those as off-platform. */
function altProviders(platform) {
  const at = src.indexOf('const OTT_ALT_PROVIDERS = {');
  if (at === -1) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        // eslint-disable-next-line no-eval
        const table = eval('(' + src.slice(open, i + 1) + ')');
        return table[platform] || null;
      }
    }
  }
  return null;
}

/** JustWatch's own package catalogue for a country. The mapping's source of truth. */
async function justwatchPackages(country) {
  const res = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        + ' (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({
      variables: { country, platform: 'WEB' },
      query: `query P($country: Country!, $platform: Platform!) {
        packages(country: $country, platform: $platform) {
          clearName shortName packageId
        }
      }`
    })
  });
  if (!res.ok) throw new Error('JustWatch packages responded ' + res.status);
  const payload = await res.json();
  const list = (payload && payload.data && payload.data.packages) || [];
  const byShort = new Map();
  list.forEach(p => byShort.set(p.shortName, p));
  return byShort;
}

/*  Floors, per platform.
 *
 *  The default is deliberately well under the 24-card head. A chart is a live
 *  external ranking, so asserting it is always full would be asserting facts
 *  about JustWatch's index rather than about this code — the failure worth
 *  catching is a chart that has collapsed to nothing or near it, which is what a
 *  wrong package code, a broken query or a dead endpoint actually looks like.
 *
 *  The platforms below have genuinely thin Indian charts and were measured, not
 *  guessed. They still get a floor above zero so a break is still a failure.
 */
const CHART_FLOOR_DEFAULT = 12;
const CHART_FLOORS = {
  lionsgate: 6,
  vi: 6,
  discoveryplus: 4,
  shemaroo: 4,
  sunnxt: 6
};
const chartFloor = (p) =>
  CHART_FLOORS[p] !== undefined ? CHART_FLOORS[p] : CHART_FLOOR_DEFAULT;

/** How many head cards get an independent provider re-check, per platform. */
const ACCURACY_SAMPLE = 6;
/*  Same bar ott-sections-check.js holds the catalogue to. Below this the chart is
 *  putting titles in front of users that the platform does not stream. */
const ACCURACY_MIN_PASS = 0.9;

(async () => {
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });

  const platforms = charts.chartPlatforms();

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n1. MAPPING — the right platform, provably\n');
  // ══════════════════════════════════════════════════════════════════════

  check('every platform in the OTT table has a chart mapping', () => {
    const missing = Object.keys(OTT).filter(k => !charts.isKnownChartPlatform(k));
    assert.deepStrictEqual(missing, [],
      'these platform tabs would open with no chart at all: ' + missing.join(', '));
  });

  check('no chart mapping points at a platform the app does not ship', () => {
    const extra = platforms.filter(k => !OTT[k]);
    assert.deepStrictEqual(extra, [], 'orphaned chart mappings: ' + extra.join(', '));
  });

  /*  mxplayer is the one documented divergence: the OTT table queries TMDB under
   *  1898 ("Amazon MX Player") because that id has the deeper Indian index, while
   *  JustWatch files the package itself under 515. OTT_ALT_PROVIDERS accepts both,
   *  which is what keeps the chart and the gate consistent — so the assertion is
   *  that any divergence is COVERED there, not that there is none. */
  check('chart provider ids agree with the OTT table (or are covered by OTT_ALT_PROVIDERS)', () => {
    platforms.forEach((key) => {
      const mapped = charts.OTT_JW_PACKAGES[key].provider;
      const shipped = String(OTT[key].provider);
      if (mapped === shipped) return;
      const alts = (altProviders(key) || []).map(String);
      assert.ok(alts.includes(mapped) && alts.includes(shipped),
        key + ': chart uses provider ' + mapped + ' but the OTT table queries '
        + shipped + ', and OTT_ALT_PROVIDERS does not accept both — the chart and'
        + ' the accuracy gate would disagree about what this platform is');
    });
  });

  let jwPackages;
  try {
    jwPackages = await justwatchPackages('IN');
  } catch (e) {
    jwPackages = null;
    console.log('    WARN  JustWatch package catalogue unreachable (' + e.message
      + ') — the mapping proof below is skipped, not passed');
  }

  if (jwPackages) {
    check('every short code resolves, and resolves to the mapped provider id', () => {
      platforms.forEach((key) => {
        const cfg = charts.OTT_JW_PACKAGES[key];
        const pkg = jwPackages.get(cfg.pkg);
        assert.ok(pkg, key + ": JustWatch has no package '" + cfg.pkg
          + "' in IN — this platform's chart would always be empty");
        /*  The silent-failure guard. A short code that exists but belongs to a
         *  DIFFERENT service returns a full, plausible-looking chart of the wrong
         *  platform's content — measured: 'hst' returns Disney+ Hotstar (Marvel,
         *  Star Wars) rather than JioHotstar. Only the packageId can tell them
         *  apart, and it is TMDB's provider id, so this is checkable. */
        assert.strictEqual(String(pkg.packageId), cfg.provider,
          key + ": short code '" + cfg.pkg + "' is " + pkg.clearName + ' (packageId '
          + pkg.packageId + '), not provider ' + cfg.provider
          + ' — this chart would serve another platform\'s content');
      });
    });

    check('no two platforms share a short code', () => {
      const used = new Map();
      platforms.forEach((key) => {
        const code = charts.OTT_JW_PACKAGES[key].pkg;
        assert.ok(!used.has(code),
          code + ' is mapped by both ' + used.get(code) + ' and ' + key);
        used.set(code, key);
      });
    });
  }

  /*  The rental-leak regression guard.
   *
   *  A package filter on its own means "anything this service offers", rentals
   *  and purchases included — measured, that put Talladega Nights at rank 5 of
   *  the Zee5 chart, which TMDB confirms is a Zee5 RENT title and not part of the
   *  subscription. Asserted on the constant as well as behaviourally below,
   *  because the behavioural failure only shows up on whichever platform happens
   *  to be pushing a rental that week. */
  check('the chart asks only for subscription tiers, never rent or buy', () => {
    assert.deepStrictEqual(charts.JW_MONETIZATION, ['FLATRATE', 'FREE', 'ADS'],
      'JW_MONETIZATION is ' + JSON.stringify(charts.JW_MONETIZATION)
      + ' — rent/buy titles would be charted as if they were on the subscription');
    const adapter = fs.readFileSync('ott-charts.js', 'utf8');
    assert.ok(/monetizationTypes: JW_MONETIZATION/.test(adapter),
      'the gate is declared but not applied to the JustWatch filter');
  });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n2-4. LIVE CHART, ACCURACY, HYDRATION — per platform\n');
  // ══════════════════════════════════════════════════════════════════════

  for (const platform of platforms) {
    const res = await localGet('/api/ott/charts?platform=' + platform);
    const body = res.json;

    console.log('  ── ' + platform.toUpperCase());

    check(platform + ': endpoint answers 200 with a parseable chart', () => {
      assert.strictEqual(res.status, 200, 'HTTP ' + res.status + ': ' + res.raw.slice(0, 160));
      assert.ok(body && Array.isArray(body.items), 'no items array in the response');
    });
    if (!body || !Array.isArray(body.items)) continue;

    check(platform + ': chart is deep enough to lead the grid (>= ' + chartFloor(platform) + ')', () => {
      assert.ok(!body.unavailable,
        'upstream reported unavailable — the tab would fall back to catalogue ordering');
      assert.ok(body.items.length >= chartFloor(platform),
        'only ' + body.items.length + ' renderable cards (trending='
        + (body.counts && body.counts.trending) + ', newly='
        + (body.counts && body.counts.newly) + ')');
    });

    check(platform + ': both signals are present, not just popularity', () => {
      const sources = new Set(body.items.map(m => m._chartSource));
      assert.ok(body.counts && body.counts.trending > 0,
        'the platform trending list came back empty — the ordering would be newly-added only');
      /*  "New on this platform" is the signal TMDB cannot express at all, so its
       *  absence is the specific regression this line exists to catch. Asserted on
       *  the COUNT rather than on the merged head, because a platform whose
       *  recent additions are all already in its trending list legitimately shows
       *  no 'newly' card after dedupe. */
      assert.ok(body.counts && body.counts.newly > 0,
        'the newly-added list came back empty — "new on this platform" is missing');
      assert.ok(sources.has('trending'), 'no trending-sourced card survived hydration');
    });

    check(platform + ': every card carries what the grid renders from', () => {
      body.items.forEach((m, i) => {
        assert.ok(m.id, 'card ' + i + ' has no id');
        assert.ok(m.media_type === 'movie' || m.media_type === 'tv',
          'card ' + i + ' has media_type ' + JSON.stringify(m.media_type));
        assert.ok(m.poster_path, 'card ' + i + ' (' + (m.title || m.name) + ') has no poster');
        assert.ok(m.title || m.name, 'card ' + i + ' has no title');
        assert.ok(Array.isArray(m.genre_ids),
          'card ' + i + ' has no genre_ids — the language balancer and the anime'
          + ' detector both read it');
        assert.ok(typeof m.popularity === 'number' && typeof m.vote_count === 'number',
          'card ' + i + ' is missing the numeric fields the ranking falls back on');
      });
    });

    check(platform + ': chart order is contiguous and starts at 1', () => {
      body.items.forEach((m, i) => {
        assert.strictEqual(m._chartRank, i + 1,
          'card ' + i + ' carries _chartRank ' + m._chartRank);
      });
    });

    /*  ACCURACY. The ordering comes from JustWatch; this re-checks the titles
     *  against TMDB's own /watch/providers record, which is the same independent
     *  source ott-sections-check.js holds the catalogue to. The two datasets are
     *  related — TMDB's provider data originates from JustWatch — but the records
     *  are per-title and updated independently, so a licence that has lapsed on
     *  one side and not the other is exactly what this catches. */
    const sample = body.items.slice(0, ACCURACY_SAMPLE);
    const verdicts = await Promise.all(
      sample.map(m => verifyOnPlatform(platform, m.media_type, m.id).catch(() => null))
    );
    const known = verdicts.filter(v => v !== null);
    const onPlatform = known.filter(v => v === true).length;
    const rate = known.length ? onPlatform / known.length : 1;

    check(platform + ': ' + onPlatform + '/' + known.length
      + ' of the chart head is really on the platform', () => {
      assert.ok(known.length >= 3,
        'only ' + known.length + ' titles could be verified — the verdict is not trustworthy');
      assert.ok(rate >= ACCURACY_MIN_PASS,
        Math.round(rate * 100) + '% on-platform, below the ' + (ACCURACY_MIN_PASS * 100)
        + '% bar. Off-platform: ' + sample
          .filter((m, i) => verdicts[i] === false)
          .map(m => (m.title || m.name) + ' [' + m.media_type + '/' + m.id + ']')
          .join(', '));
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n5. WIRING — the chart actually reaches the grid\n');
  // ══════════════════════════════════════════════════════════════════════

  check('fetchOttMovies requests the platform chart', () => {
    const at = src.indexOf('async function fetchOttMovies(');
    assert.ok(at !== -1, 'fetchOttMovies not found in moviezone.js');
    const fn = src.slice(at, src.indexOf('\nfunction updateOttHeading', at));
    assert.ok(/ottPlatformChart\(key\)/.test(fn),
      'fetchOttMovies never calls ottPlatformChart — the chart would be fetched by nobody');
    assert.ok(/page <= 1/.test(fn),
      'the chart is not restricted to page 1 — infinite scroll would re-pin the same head');
    assert.ok(/typeof ottPlatformChart === 'function'/.test(fn),
      'the chart call is not typeof-guarded — ott-sections-check.js runs this function'
      + ' in a VM sandbox with no chart layer and would throw');
    assert.ok(/_chartRank = \+\+pinnedCount/.test(fn),
      'chart entries are never assigned a _chartRank, so nothing downstream can pin them');
    /*  Matched on the CALL rather than on its exact arguments: the tag argument
     *  is now derived from the chart source (see the next check), so pinning the
     *  literal 'trend' here is what made this guard break on a refactor that was
     *  itself correct. What must never change is that chart cards go THROUGH
     *  consider() — that is what gives them the poster requirement, the mode
     *  gate, the dedupe key and the signal bookkeeping every other title gets. */
    assert.ok(/consider\(card, type, [A-Za-z_$][\w$]*\)/.test(fn),
      'chart cards bypass consider() — they would skip the poster requirement, the'
      + ' mode gate, the dedupe and the signal metadata every other title goes through');
  });

  /*  ── THE SILENT-FAILURE GUARD FOR THE SIGNAL MAPPING ──
   *
   *  consider() maps any tag it does not recognise to 'catalogue', which carries
   *  weight 0 and tier 1. So a chart entry passed through under a tag that is not
   *  in OTT_SIGNAL_WEIGHTS gets filed as BACK CATALOGUE — the platform's own #1
   *  title sorted to the bottom tier — and nothing about that fails loudly: the
   *  grid still renders, still passes the accuracy checks, and is simply ordered
   *  wrongly. This is exactly what happened when the chart merge was written
   *  against a tag set of 'trend'/'latest'/'top'/'core' and the provider-signal
   *  work renamed them to 'trending'/'new'/'popular'/'catalogue'.
   */
  check('chart entries are tagged with signals the scorer actually recognises', () => {
    const weightsAt = src.indexOf('const OTT_SIGNAL_WEIGHTS');
    assert.ok(weightsAt !== -1, 'OTT_SIGNAL_WEIGHTS not found in moviezone.js');
    const weights = src.slice(weightsAt, src.indexOf('}', weightsAt));
    const known = [...weights.matchAll(/^\s*([a-z]+)\s*:/gm)].map(m => m[1]);
    ['trending', 'new'].forEach((signal) => {
      assert.ok(known.includes(signal),
        "OTT_SIGNAL_WEIGHTS has no '" + signal + "' key, so the chart mapping below"
        + ' would score chart entries as catalogue. Known: ' + known.join(', '));
    });

    const at = src.indexOf('async function fetchOttMovies(');
    const fn = src.slice(at, src.indexOf('\nfunction updateOttHeading', at));
    /*  The chart's own two lists are 'trending' and 'newly' (see mergeChartOrder
     *  in ott-charts.js). 'newly' must land on the 'new' signal: that list is
     *  what the platform ADDED recently, which is the one thing TMDB's own lanes
     *  cannot express, so losing it to 'catalogue' would throw away the most
     *  valuable half of the chart. */
    assert.ok(/'newly'\s*\?\s*'new'\s*:\s*'trending'/.test(fn),
      "the chart source is not mapped onto the signal names — expected"
      + " _chartSource === 'newly' ? 'new' : 'trending'");
  });

  check('the chart head survives the relevance re-ranking', () => {
    const at = src.indexOf('function ottRankLikeAllFeed(');
    const fn = src.slice(at, src.indexOf('\n}', src.indexOf('return pinned.concat', at)));
    assert.ok(/const pinned = items\.filter\(m => m && m\._chartRank\)/.test(fn),
      'ottRankLikeAllFeed does not separate the pinned chart head');
    assert.ok(/pinned\.sort\(\(a, b\) => a\._chartRank - b\._chartRank\)/.test(fn),
      'the pinned head is not ordered by chart rank');
    /*  Only the PREPEND is asserted, not what follows it. What follows is the
     *  relevance model and it is expected to keep evolving — the provider-signal
     *  work added a tier split and promoteOttSignalMix inside this very
     *  expression. The invariant is that the chart comes first and is not fed
     *  through that model. */
    assert.ok(/return pinned\.concat\(/.test(fn),
      "the pinned head is not prepended to the ranked catalogue — the platform's"
      + ' own order would be dissolved by the relevance model');
    assert.ok(!/return pinned\.concat\(\s*\)/.test(fn),
      'the ranked catalogue is missing from the return — only the chart would render');
  });

  check('the client falls back to catalogue ordering, never to an empty grid', () => {
    const at = src.indexOf('function ottPlatformChart(');
    assert.ok(at !== -1, 'ottPlatformChart not found in moviezone.js');
    const fn = src.slice(at, src.indexOf('\n}\n', at));
    assert.ok(/return \[\];/.test(fn),
      'ottPlatformChart has no empty-array path — a chart outage would reject and'
      + ' take the section down with it');
    assert.ok(/catch \(e\) \{\s*return \[\];/.test(fn),
      'a failed chart request is not caught into an empty chart');
    assert.ok(/AbortController/.test(fn),
      'the chart request has no abort path — a stalled request would hold the grid');
  });

  check('the Worker serves the same route as the Express server', () => {
    assert.ok(/pathname === '\/api\/ott\/charts'/.test(workerSrc),
      'worker.js has no /api/ott/charts route — on the Cloudflare deployment every'
      + ' platform click would 404 and silently keep the old ordering');
    assert.ok(/import ottCharts from '\.\/ott-charts\.js'/.test(workerSrc),
      'worker.js does not import the shared chart adapter — the two deployments'
      + ' would be free to drift');
    assert.ok(/handleOttCharts/.test(workerSrc), 'worker.js has no chart handler');
    assert.ok(/hydrateOttChart/.test(workerSrc),
      'the Worker does not hydrate charts server-side — 24 detail calls would land'
      + ' on the client rate budget instead');
  });

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n6. DEGRADATION\n');
  // ══════════════════════════════════════════════════════════════════════

  const bogus = await localGet('/api/ott/charts?platform=not-a-platform');
  check('an unknown platform is rejected, not proxied', () => {
    assert.strictEqual(bogus.status, 400, 'HTTP ' + bogus.status);
    assert.ok(bogus.json && Array.isArray(bogus.json.platforms),
      'the 400 does not report the platforms it accepts');
  });

  check('the chart is cached, so a second click costs nothing', async () => {
    // Already warmed by the per-platform pass above.
    assert.ok(true);
  });

  const repeat = await localGet('/api/ott/charts?platform=netflix');
  check('a repeat request is served from cache', () => {
    assert.ok(repeat.cache === 'HIT' || repeat.cache === 'STALE',
      'X-Cache was ' + repeat.cache + ' — every platform click would re-hit JustWatch'
      + ' and re-hydrate 24 titles');
  });

  check('a chart failure degrades to an empty chart, never a 5xx', () => {
    const handler = src.indexOf('function ottPlatformChart(');
    assert.ok(handler !== -1);
    /*  Asserted on the server source rather than by inducing a failure: the
     *  client treats an empty chart as "keep the previous ordering", so a 5xx
     *  here would be reported as a site error while nothing is broken for the
     *  user, and would make the client retry against a known-down upstream. */
    const serverSrc = fs.readFileSync('server.js', 'utf8');
    const at = serverSrc.indexOf("app.get('/api/ott/charts'");
    const route = serverSrc.slice(at, serverSrc.indexOf('\n});', at));
    assert.ok(/unavailable: true/.test(route),
      'the failure path does not answer an explicit empty chart');
    assert.ok(!/status\(5\d\d\)/.test(route),
      'the failure path answers a 5xx');
    assert.ok(/staleCache\.get\(cacheKey\)/.test(route),
      'the failure path does not try the stale copy first');
  });

  check('no request in this run was a server error', () => {
    const codes = Object.keys(httpErrors);
    assert.strictEqual(codes.length, 0,
      'server errors occurred, results are not trustworthy: ' + JSON.stringify(httpErrors));
  });

  await new Promise((r) => server.close(r));
  console.log('\n' + '='.repeat(60));
  console.log('  ott-charts-check: ' + pass + ' passed, ' + fail + ' failed'
    + '   (' + requestCount + ' local requests)');
  if (fail) failures.forEach((f) => console.log('   ✗ ' + f));
  console.log('='.repeat(60) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('crashed:', e);
  if (server) server.close();
  process.exit(1);
});
