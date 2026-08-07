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
  block('async function ottIsOnPlatform('),
  block('async function ottVerifiedTrending('),
  line('const OTT_SAMPLE_SIZE ='),
  line('const OTT_SAMPLE_MIN_PASS ='),
  line('const OTT_DEEP_VERIFY_CAP ='),
  block('async function ottEnforceAccuracy('),
  block('async function fetchOttMovies('),
  // `const` is lexical and never lands on the VM context object, so hand the
  // bindings out explicitly.
  'globalThis.__ott = { OTT, OTT_ALT_PROVIDERS, OTT_MONETIZATION,' +
  ' buildOttModeQueries, fetchOttMovies, ottVerifiedTrending, ottIsOnPlatform };'
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
  netflix: 'NETFLIX', prime: 'PRIME VIDEO', jiohotstar: 'JIOHOTSTAR', zee5: 'ZEE5'
};

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
      check('rent/buy titles excluded (monetization = ' + OTT_MONETIZATION + ')', () => {
        plan.forEach((q) => {
          assert.strictEqual(q.params.with_watch_monetization_types, OTT_MONETIZATION,
            q.endpoint + ' missing the flatrate gate');
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
      check('first load fills the 24-card grid', () => {
        assert.ok(items.length >= 24, 'only ' + items.length + ' cards available');
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
      const topPop = meanPop(items.slice(0, 12));
      const allPop = meanPop(items);
      console.log('  mean popularity: top-12 ' + topPop.toFixed(1) + ' vs overall ' + allPop.toFixed(1));
      check('trending sits at the top (top-12 more popular than average)', () => {
        assert.ok(topPop > allPop,
          'top-12 mean ' + topPop.toFixed(1) + ' is not above overall ' + allPop.toFixed(1));
      });
      check('latest releases surface in the first screen', () => {
        const cutoff = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
        const fresh = items.slice(0, 24).filter((m) => dateOf(m) && dateOf(m) >= cutoff);
        assert.ok(fresh.length >= 1,
          'no title from the last ~13 months in the first 24 cards');
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
  check('OTT prefetch follows the active mode', () => {
    assert.ok(/buildOttModeQueries\(cat,\s*currentOttMode,\s*pageNum\)/.test(src),
      'prefetch is not mode-aware');
  });
  check('all four platforms expose the sub-filter bar', () => {
    assert.ok(/if \(OTT\[cat\]\) \{ renderOttFilterBar\(\); updateOttHeading\(cat\); \}/.test(src),
      'filterCat does not render the OTT sub-filter bar');
    ['netflix', 'prime', 'jiohotstar', 'zee5'].forEach((p) => {
      assert.ok(new RegExp(p + ':\\s*\\{').test(src), p + ' missing from the OTT table');
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
