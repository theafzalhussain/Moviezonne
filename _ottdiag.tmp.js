'use strict';
/*  Throwaway diagnostic: compare the FETCHER order (what ott-sections-check.js
 *  currently asserts against) with the RENDERED order (ottRankLikeAllFeed, which
 *  is what loadMovies actually paints) for the pairs that fail the
 *  "latest releases surface in the first screen" check. Deleted after use.
 */
process.env.API_RATE_LIMIT_MAX = process.env.API_RATE_LIMIT_MAX || '5000';

const http = require('http');
const fs = require('fs');
const vm = require('vm');
const app = require('./server');

const src = fs.readFileSync('moviezone.js', 'utf8');

function span(marker, openCh) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('not found: ' + marker);
  const closeCh = openCh === '[' ? ']' : '}';
  const open = src.indexOf(openCh, at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced: ' + marker);
}
const block = (m) => span(m, '{');
const arr = (m) => span(m, '[') + ';';
function line(marker) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('not found: ' + marker);
  return src.slice(at, src.indexOf('\n', at));
}

const extracted = [
  // ── OTT fetcher (same list ott-sections-check.js extracts) ──
  block('const OTT = {') + ';',
  line('const OTT_MONETIZATION ='),
  block('const OTT_ALT_PROVIDERS = {') + ';',
  block('function ottISTDate('),
  block('function buildOttModeQueries('),
  line('const _ottVerifyCache ='),
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

  // ── the render-order ranker and everything it needs ──
  line('const DAY_MS ='),
  arr('const MOVIE_QUALITY_TIMELINE = ['),
  arr('const TV_QUALITY_TIMELINE = ['),
  block('function mediaTypeOf('),
  block('function qualityTimelineFor('),
  block('function qualityAtStage('),
  block('function titleQualityState('),
  block('function catalogueEventAgeDays('),
  line('const FRESH_TIER_DAYS ='),
  line('const FRESH_TIER_MIN_POPULARITY ='),
  line('const FRESH_TIER_MIN_VOTES ='),
  line('const REGIONAL_INDUSTRY_LANGUAGES ='),
  line('const REGIONAL_FRESH_MIN_POPULARITY ='),
  line('const REGIONAL_FRESH_MIN_VOTES ='),
  line('const LATEST_WINDOW_DAYS ='),
  line('const RATING_PRIOR_VOTES ='),
  line('const RATING_PRIOR_MEAN ='),
  line('const TRENDING_MIN_VOTES ='),
  block('function isAnimeContent('),
  block('function freshTierFloors('),
  block('function freshnessTier('),
  block('function allFeedPriorityGroup('),
  block('function calculateMovieScore('),
  block('function rankByFreshness('),
  block('function diversifyByLanguageWithinPriority('),
  block('function feedLaneOf('),
  block('function interleaveFeedByType('),
  block('function catalogueEraFactor('),
  block('function ottRankLikeAllFeed('),

  'globalThis.__ott = { OTT, OTT_SIGNAL_NAMES, OTT_RECENCY_MIN_VOTES,' +
  ' OTT_RECENCY_MIN_POPULARITY, buildOttModeQueries, fetchOttMovies,' +
  ' ottRankLikeAllFeed, promoteOttSignalMix };'
].join('\n\n');

let server;
function api(endpoint, params) {
  const qs = Object.entries(params || {})
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const path = '/api/tmdb' + endpoint + (qs ? '?' + qs : '');
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const sandbox = { tmdb: api, console, Date, Math, Promise, Map, Set, Object, Array, String, Number, JSON, isFinite, isNaN };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(extracted, sandbox);
const O = sandbox.__ott;

const dateOf = (m) => m.first_air_date || m.release_date || '';
const titleOf = (m) => m.name || m.title || ('#' + m.id);

const PAIRS = [
  ['zee5', 'webseries'], ['mxplayer', 'movies'],
  ['vi', 'webseries'], ['vi', 'movies'], ['shemaroo', 'movies'],
  ['netflix', 'webseries'], ['prime', 'movies']
];

(async () => {
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  console.log('cutoff = ' + cutoff);

  for (const [platform, mode] of PAIRS) {
    const raw = await O.fetchOttMovies(platform, mode, 1);
    const items = raw.filter((m) => {
      if (!m.poster_path) return false;
      const d = dateOf(m);
      if (!d) return (m.vote_count || 0) > 50;
      return d <= today;
    });
    const rendered = O.ottRankLikeAllFeed(items.slice());

    const freshOf = (list) => list.filter((m) => dateOf(m) && dateOf(m) >= cutoff);
    const audienced = (m) => (m.vote_count || 0) >= O.OTT_RECENCY_MIN_VOTES
      || (m.popularity || 0) >= O.OTT_RECENCY_MIN_POPULARITY;

    const fresh = freshOf(items);
    const freshAud = fresh.filter(audienced);
    const meanPop = (l) => l.reduce((s, m) => s + (m.popularity || 0), 0) / (l.length || 1);
    const head = Math.min(12, Math.max(2, Math.floor(items.length / 2)));

    console.log('\n=== ' + platform + ' > ' + mode + '  (' + items.length + ' items) ===');
    console.log('  fetcher : fresh in first24 = ' + freshOf(items.slice(0, 24)).length
      + '   freshAud in first24 = ' + freshOf(items.slice(0, 24)).filter(audienced).length
      + '   top-' + head + ' pop ' + meanPop(items.slice(0, head)).toFixed(1)
      + ' vs all ' + meanPop(items).toFixed(1));
    console.log('  rendered: fresh in first24 = ' + freshOf(rendered.slice(0, 24)).length
      + '   freshAud in first24 = ' + freshOf(rendered.slice(0, 24)).filter(audienced).length
      + '   top-' + head + ' pop ' + meanPop(rendered.slice(0, head)).toFixed(1)
      + ' vs all ' + meanPop(rendered).toFixed(1));
    console.log('  fresh total=' + fresh.length + '  with audience=' + freshAud.length);
    fresh.forEach((m) => {
      console.log('     ' + dateOf(m) + '  aud=' + (audienced(m) ? 'Y' : 'n')
        + '  fetch#' + String(items.indexOf(m)).padStart(3)
        + '  rendered#' + String(rendered.indexOf(m)).padStart(3)
        + '  v=' + String(m.vote_count || 0).padStart(5)
        + '  p=' + (m.popularity || 0).toFixed(1).padStart(7)
        + '  ' + titleOf(m));
    });
    console.log('  rendered first 8: ' + rendered.slice(0, 8)
      .map((m) => titleOf(m) + '(' + (dateOf(m) || '?').slice(0, 4) + ')').join(', '));
  }
  process.exit(0);
})();
