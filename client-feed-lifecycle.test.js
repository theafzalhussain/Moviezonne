'use strict';
// Offline behavioral regressions. Runs actual declarations from the client,
// not copies of their logic; no browser, TMDB requests or production traffic.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const acorn = require('acorn'); // pinned transitively by the existing terser build
const source = fs.readFileSync(process.env.MZ_CLIENT_SOURCE || 'moviezone.js', 'utf8');
const functions = new Map(acorn.parse(source, { ecmaVersion: 'latest' }).body
  .filter(n => n.type === 'FunctionDeclaration').map(n => [n.id.name, source.slice(n.start, n.end)]));
function load(names, ctx) {
  vm.createContext(ctx);
  vm.runInContext(names.filter(n => functions.has(n)).map(n => functions.get(n)).join('\n'), ctx);
  return ctx;
}
const noop = () => {};
const typeOf = m => m.media_type || (m.name && !m.title ? 'tv' : 'movie');
function pending() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setupFeed() {
  const batch = pending(), grid = {innerHTML: ''}, calls = {ranked: 0, cartoon: [], anime: [], ott: []};
  const ctx = {
    console, Date, Set, Map, navigator: {onLine: true},
    document: {getElementById: id => id === 'movieGrid' ? grid : null},
    mzFeedPagerCategory: 'all', mzFeedPage: 1, mzFeedPoolExhausted: false,
    isLoadingMore: false, _mzFeedLoadGeneration: 0, _mzFeedChainBudget: 0,
    currentMoviePage: 1, currentOttMode: 'all', currentCartoonMode: 'all', currentAnimeMode: 'all',
    OTT: {netflix: {}}, _mzFetchFailureCount: 0, allMovies: [],
    _mzPoolKey: cat => cat + ':' + (cat === 'kids' ? ctx.currentCartoonMode : cat === 'anime' ? ctx.currentAnimeMode : ctx.currentOttMode),
    _mzReadPool: () => null, _mzCatPlan: () => [['/fixture']], tmdbBatch: () => batch.promise,
    mediaTypeOf: typeOf, rankByFreshness: rows => { calls.ranked += rows.length; },
    diversifyByLanguageWithinPriority: rows => rows, interleaveFeedByType: rows => rows,
    isNonDramaTvRow: row => (row.genre_ids || []).includes(10767),
    fetchCartoonMovies: async (mode, page) => { calls.cartoon.push([mode, page]); return []; },
    fetchAnimeMovies: async (mode, page) => { calls.anime.push([mode, page]); return []; },
    fetchOttMovies: async (cat, mode, page) => { calls.ott.push([cat, mode, page]); return []; },
    ottRankLikeAllFeed: rows => rows,
    isFeedBlocked: () => false, isPreMillenniumMovie: () => false,
    FEED_LADDER: {}, FEED_SELF_RANKED: new Set(['all', 'kids', 'anime']), FEED_LEAD_LANGUAGE_BY_CATEGORY: {},
    rankCategoryFeed: rows => rows, _mzFeedRetryState: () => ({attempts: 0}),
    renderFeedEmpty: noop, renderFeedPager: noop, renderFeedError: noop,
    MZ_FEED_PAGED: true, isFullViewMovies: false, mzLowTier: false,
    renderCurrentFeedPage: () => 1, _mzSavePool: noop,
    setTimeout: noop, clearTimeout: noop
  };
  load(['mzInterleave', 'mzDedupeById', 'collectFeedMovies', 'loadMovies'], ctx);
  return {ctx, calls, batch};
}
let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); pass++; console.log('PASS ' + label); }
  catch (e) { fail++; console.error('FAIL ' + label + ': ' + e.message); }
}
(async () => {
  await test('superseded ALL gather performs zero ranking work on 320 unused rows', async () => {
    const {ctx, calls, batch} = setupFeed();
    const task = ctx.loadMovies('all');
    ctx.mzFeedPagerCategory = 'horror'; ctx._mzFeedLoadGeneration++;
    const responses = Array.from({length: 16}, (_, i) => ({status: 'fulfilled', value: {results:
      Array.from({length: 20}, (_, j) => ({id: i * 20 + j + 1, title: 'Fixture', popularity: 1}))}}));
    batch.resolve(responses); await task;
    assert.equal(calls.ranked, 0, 'obsolete rows must not enter ranking');
    assert.equal(ctx.allMovies.length, 0);
  });
  for (const category of ['kids', 'anime']) await test('superseded ' + category + ' starts no follow-up gather for the new mode', async () => {
    const {ctx, calls, batch} = setupFeed();
    const task = ctx.loadMovies(category);
    ctx[category === 'kids' ? 'currentCartoonMode' : 'currentAnimeMode'] = 'movies';
    ctx.currentMoviePage = 7; ctx._mzFeedLoadGeneration++;
    batch.resolve([{status: 'fulfilled', value: {results: []}}]); await task;
    assert.equal(calls[category === 'kids' ? 'cartoon' : 'anime'].length, 0);
  });
  await test('in-flight extension releases its gate when superseded', async () => {
    const {ctx, batch} = setupFeed();
    const task = ctx.loadMovies('all', true);
    assert.equal(ctx.isLoadingMore, true);
    ctx.mzFeedPagerCategory = 'tv'; ctx._mzFeedLoadGeneration++;
    batch.resolve([]); await task;
    assert.equal(ctx.isLoadingMore, false);
    assert.equal(ctx._mzFeedChainBudget, 0);
  });
  for (const category of ['trending', 'toprated']) await test(category + ' preserves movie and TV rows sharing numeric IDs', async () => {
    const {ctx} = setupFeed();
    const rows = [{results: [{id: 42, title: 'Film'}, {id: 42, title: 'Film duplicate'}]}, {results: []}, {results: []}, {results: []}];
    const tvIndex = category === 'trending' ? 2 : 3;
    rows[tvIndex].results = [{id: 42, name: 'Series'}];
    const got = ctx.mzDedupeById(rows, (item, idx) => { if (idx === tvIndex) item.media_type = 'tv'; });
    assert.deepEqual(Array.from(got, m => typeOf(m) + ':' + m.id), ['movie:42', 'tv:42']);
    assert.equal(got[0].title, 'Film', 'first occurrence still wins within the same type');
  });
  if (functions.has('collectFeedMovies')) {
    await test('category collectors receive immutable request mode/page snapshots', async () => {
      const {ctx, calls} = setupFeed();
      ctx.currentMoviePage = 99; ctx.currentCartoonMode = 'new'; ctx.currentAnimeMode = 'new'; ctx.currentOttMode = 'new';
      const modes = {cartoon: 'tv', anime: 'movies', ott: 'webseries'};
      await ctx.collectFeedMovies('kids', [], 3, modes);
      await ctx.collectFeedMovies('anime', [], 4, modes);
      await ctx.collectFeedMovies('netflix', null, 5, modes);
      assert.deepEqual(calls.cartoon, [['tv', 3]]);
      assert.deepEqual(calls.anime, [['movies', 4]]);
      assert.deepEqual(calls.ott, [['netflix', 'webseries', 5]]);
    });
    await test('ALL collector tags TV sources, keeps most-popular duplicates and ranking order', async () => {
      const {ctx, calls} = setupFeed();
      const rows = Array.from({length: 12}, () => ({results: []}));
      rows[0].results = [{id: 7, title: 'less popular', popularity: 1}, null, {id: 8, title: 'second', popularity: 2}];
      rows[1].results = [{id: 7, title: 'more popular', popularity: 9}];
      rows[11].results = [{id: 7, name: 'TV', popularity: 4}];
      const got = await ctx.collectFeedMovies('all', rows, 1, {});
      assert.deepEqual(Array.from(got, m => m.title || m.name), ['more popular', 'second', 'TV']);
      assert.equal(got[2].media_type, 'tv'); assert.equal(calls.ranked, 3);
    });
    await test('TV collector retains source order and excludes duplicate/non-drama rows', async () => {
      const {ctx} = setupFeed();
      const got = await ctx.collectFeedMovies('tv', [{results: [{id: 1}, {id: 2, genre_ids: [10767]}]}, {results: [{id: 1}, {id: 3}]}], 1, {});
      assert.deepEqual(Array.from(got, m => m.id), [1, 3]);
    });
    await test('round-robin genre collectors preserve source ordering and adult filtering', async () => {
      const {ctx} = setupFeed();
      const rows = [{results: [{id: 1}, {id: 2}]}, {results: [{id: 3}]}];
      for (const cat of ['horror', 'dubbed']) {
        assert.deepEqual(Array.from(await ctx.collectFeedMovies(cat, rows, 1, {}), m => m.id), [1, 3, 2]);
      }
      const adult = await ctx.collectFeedMovies('adult', [{results: [{id: 1, genre_ids: [28]}, {id: 2, genre_ids: [28], adult: true}]}, {results: [{id: 3, genre_ids: [18]}]}], 1, {});
      assert.deepEqual(Array.from(adult, m => typeOf(m) + ':' + m.id), ['tv:3', 'movie:2']);
    });
  }
  console.log('client-feed-lifecycle: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
