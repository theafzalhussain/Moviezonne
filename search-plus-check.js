#!/usr/bin/env node
/*  search-plus-check.js: guards typo recall and franchise / related results.
 *
 *    node search-plus-check.js            offline (fake TMDB), runs in CI
 *    node search-plus-check.js --online   the same queries against live TMDB
 *                                         through moviezone.dev's proxy
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const ONLINE = process.argv.includes('--online');

global.window = global;
global.document = { createElement: () => ({}), head: { appendChild() {} } };
const realFetch = global.fetch;
global.fetch = (u, o) => String(u).startsWith('/search-vocab')
  ? Promise.resolve({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'search-vocab.json'), 'utf8')) })
  : realFetch(u, o);
const engine = require('./search-engine.js');
require('./search-plus.js');
const plus = window.MZSearchPlus;

let passed = 0, failed = 0; const fails = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; fails.push(name + ' - ' + e.message); console.log('  FAIL  ' + name + '\n          ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
const T = m => m.title || m.name;

/* ---------------------------------------------------------------- TMDB */
const BASE = 'https://moviezone.dev/api/tmdb';
const cache = new Map();
function fakeTmdb(ep, p) {
  const q = (p && p.query || '').toLowerCase();
  const mv = (id, title, extra) => Object.assign({ id, title, media_type: 'movie', poster_path: '/p.jpg', release_date: '2010-01-01', vote_count: 500, popularity: 20, genre_ids: [35], original_language: 'hi' }, extra);
  const tv = (id, name, extra) => Object.assign({ id, name, media_type: 'tv', poster_path: '/t.jpg', first_air_date: '2005-12-27', vote_count: 900, popularity: 40, genre_ids: [16, 10762], original_language: 'en' }, extra);
  const search = {
    'housful': [],
    'housefull': [mv(1, 'Housefull', { vote_count: 900, popularity: 30 }), mv(2, 'Housefull 2'), mv(9, 'Houseful of Animals', { original_language: 'en', vote_count: 4, popularity: 0.4 }), mv(10, 'Jailer+(2023)+Telugu+HD+Movie')],
    'ben 10': [tv(20, 'Ben 10'), tv(23, 'Ben 10: Alien Force', { first_air_date: '2008-04-18' }),
      mv(22, 'Ben 10: Race Against Time', { genre_ids: [16, 10751], original_language: 'en', release_date: '2007-11-21', vote_count: 378 }),
      mv(24, 'Ben 10: Break Room', { original_language: 'en', release_date: '2010-06-18', vote_count: 1, popularity: 1.5 }),
      mv(25, 'Ben 10 Back Again', { original_language: 'en', release_date: '2021-07-29', vote_count: 1, popularity: 0.5 }),
      mv(21, 'Power of 10', { original_language: 'en', genre_ids: [18] })],
    'ek tha tiger': [mv(50, 'Ek Tha Tiger', { release_date: '2012-08-15', vote_count: 232 }), mv(55, 'Tiger Cage', { original_language: 'cn', release_date: '1988-01-01', vote_count: 40 })]
  };
  const db = {
    '/search/multi': search[q],
    '/search/collection': { housefull: [{ id: 100, name: 'Housefull Collection' }], 'ben 10': [{ id: 200, name: 'Ben 10 Collection' }] }[q] || [],
    '/collection/100': { parts: [mv(1, 'Housefull'), mv(2, 'Housefull 2', { release_date: '2012-04-05' }), mv(3, 'Housefull 3', { release_date: '2016-06-03' })] },
    '/collection/200': { parts: [mv(22, 'Ben 10: Race Against Time', { genre_ids: [16, 10751], original_language: 'en', release_date: '2007-11-21' })] },
    '/collection/485645': { parts: [mv(50, 'Ek Tha Tiger', { release_date: '2012-08-15' }), mv(51, 'Tiger Zinda Hai', { release_date: '2017-12-22' }), mv(52, 'Tiger 3', { release_date: '2023-11-12' })] },
    '/movie/1': { id: 1, belongs_to_collection: { id: 100 } },
    '/movie/50': { id: 50, belongs_to_collection: { id: 485645 } },
    '/tv/20': { id: 20, production_companies: [{ name: 'Cartoon Network Studios' }], networks: [{ name: 'Cartoon Network' }] },
    '/movie/24': { id: 24, runtime: 2, production_companies: [{ name: 'Cartoon Network Studios' }] },
    '/movie/25': { id: 25, runtime: 29, production_companies: [{ name: 'Comic chay' }] }
  };
  const hit = db[ep];
  if (hit === undefined) return Promise.resolve({ results: [] });
  return Promise.resolve(Array.isArray(hit) ? { results: hit } : hit);
}
async function liveTmdb(ep, p) {
  const u = BASE + ep + '?' + new URLSearchParams(p);
  if (!cache.has(u)) cache.set(u, await realFetch(u).then(r => r.json()));
  return cache.get(u);
}
const tmdb = ONLINE ? liveTmdb : fakeTmdb;

/* Mirrors intelligentMovieSearch + searchAndDisplay in moviezone.js. */
async function search(query) {
  const base = { language: 'en-US', page: '1', include_adult: 'false' };
  const fixedRaw = await plus.correct(query);
  const runQ = q => tmdb('/search/multi', Object.assign({}, base, { query: q })).then(r => r.results || []);
  const all = [].concat(...await Promise.all([runQ(query)].concat(fixedRaw ? [runQ(fixedRaw)] : [])));
  const people = engine.rankSearchCandidates(query, all.filter(i => i.media_type === 'person'), 5);
  const bestPerson = people[0];
  const pool = all.filter(i => i.media_type !== 'person');
  (bestPerson ? people.filter(p => p === bestPerson || (p.popularity || 0) >= (bestPerson.popularity || 0) / 3) : [])
    .forEach(p => (p.known_for || []).forEach(k => k.id && pool.push(Object.assign({}, k, { _matchedPerson: p.name }))));
  let ranked = engine.rankSearchCandidates(query, pool, 60);
  const personFound = plus.isPerson(query, bestPerson, ranked);
  let fixed = fixedRaw;
  if (fixed && plus.useFix(query, ranked, personFound)) ranked = plus.merge(ranked, engine.rankSearchCandidates(fixed, pool, 60));
  else fixed = '';
  ranked = plus.strict(plus.order(ranked, query, personFound), query, fixed, personFound);
  const movies = ranked.slice(0, 40).filter(m => m.poster_path);
  const full = await plus.franchise(query, fixed, movies, tmdb, personFound ? bestPerson : null);
  return { fixed, dropdown: ranked.slice(0, 8), main: full, sectioned: full.some(m => m._mzSection) };
}

(async () => {
  console.log('search-plus check' + (ONLINE ? ' (live TMDB)' : ''));
  console.log('-'.repeat(62));

  await check('dictionary corrects Hindi-romanisation typos', async () => {
    const want = { housful: 'housefull', golmal: 'golmaal', dhamal: 'dhamaal', 'hera feri': 'hera pheri', 'chota bheem': 'chhota bheem', kalky: 'kalki', doremon: 'doraemon', jailor: 'jailer', mirjapur: 'mirzapur', 'avengars': 'avengers' };
    for (const [typed, fixed] of Object.entries(want)) {
      const got = await plus.correct(typed);
      assert(got === fixed, `"${typed}" -> "${got}", expected "${fixed}"`);
    }
  });

  await check('correct spellings are left alone', async () => {
    for (const q of ['housefull', 'ben 10', 'naruto', 'stree 2', 'akshay kumar', 'squid game']) {
      const got = await plus.correct(q);
      assert(!got || got === q, `"${q}" was rewritten to "${got}"`);
    }
  });

  await check('a dictionary guess never overrides a person ("prabhas" is not "prabhat")', () => {
    assert(!plus.useFix('prabhas', [{ _searchScore: 900 }], true), 'person query accepted a title-dictionary fix');
    assert(plus.useFix('housful', [], false), 'zero results did not accept the fix');
    assert(plus.useFix('jailor', [{ _searchScore: 1500 }], false), 'curated fix was refused');
  });

  await check('a title query is not an actor search because a name shares a word', () => {
    assert(!plus.isPerson('housful', { name: 'Tarang Housefull', _searchScore: 900 }), '"housful" treated as Tarang Housefull');
    assert(plus.isPerson('akshay kumar', { name: 'Akshay Kumar', _searchScore: 1500 }), 'akshay kumar not a person');
    assert(plus.isPerson('akshay', { name: 'Akshay Kumar', _searchScore: 1200 }), 'akshay not a person');
    assert(plus.isPerson('srk', { name: 'Shah Rukh Khan', _searchScore: 900 }), 'srk alias not a person');
  });

  await check('upload-spam and "Untitled" records are dropped; "golmaal 3" leads with Golmaal 3', () => {
    const list = plus.order([
      { title: 'Golmaal Returns', _matchQuality: 'Starts with', vote_count: 900, popularity: 30 },
      { title: 'Golmaal 3', _matchQuality: 'Exact match', vote_count: 500, popularity: 10 },
      { title: 'Jailer+(2023)+Telugu+HD+Movie', _matchQuality: 'Starts with' },
      { title: 'Untitled Akshay Kumar Film', _matchQuality: 'Title match' }], 'golmaal 3');
    assert(list.length === 2, 'spam kept: ' + list.map(T).join(', '));
    assert(T(list[0]) === 'Golmaal 3', 'first is ' + T(list[0]));
  });

  await check('"housful" -> Housefull first, then its parts in order, nothing else', async () => {
    const r = await search('housful');
    const titles = r.main.map(T);
    assert(r.fixed === 'housefull', 'fixed = ' + r.fixed);
    assert(titles[0] === 'Housefull', 'first result ' + titles[0]);
    assert(titles.slice(0, 3).join('|') === 'Housefull|Housefull 2|Housefull 3', titles.join(', '));
    if (!ONLINE) assert(titles.length === 3, 'extra titles: ' + titles.join(', '));
    assert(!titles.some(t => /\+|Animals/.test(t)), 'spam or off-topic title in results');
  });

  await check('no "More like" block: results are only the searched title and its franchise', async () => {
    for (const q of ['housefull', 'ben 10', 'ek tha tiger']) {
      const r = await search(q);
      assert(!r.sectioned, '"' + q + '" still has a related section');
    }
  });

  await check('"ek tha tiger" -> Ek Tha Tiger, Tiger Zinda Hai, Tiger 3 (and no other "Tiger")', async () => {
    const titles = (await search('ek tha tiger')).main.map(T);
    assert(titles.join('|') === 'Ek Tha Tiger|Tiger Zinda Hai|Tiger 3', titles.join(', '));
  });

  await check('"ben 10": official series and films only, no fan clips or fan films', async () => {
    const r = await search('ben 10');
    const titles = r.main.map(T);
    assert(titles[0] === 'Ben 10', 'first ' + titles[0]);
    assert(titles.includes('Ben 10: Race Against Time'), 'official film missing: ' + titles.join(', '));
    for (const bad of ['Ben 10: Break Room', 'Ben 10 Back Again', 'Beast Boy vs Ben 10', 'Ben 10: Evolution', 'Power of 10']) {
      assert(!titles.includes(bad), bad + ' listed: ' + titles.join(', '));
    }
    assert(r.main.every(m => /ben 10|ben gen 10/i.test(T(m))), 'off-topic: ' + titles.join(', '));
  });

  if (ONLINE) {
    await check('live: misspelt Indian titles reach the right film first', async () => {
      const want = { golmal: /^Golmaal/, dhamal: /^Dhamaal/, 'hera feri': /^Hera Pheri/, jailor: /^Jailer/, kalky: /^Kalki/, doremon: /Doraemon/, 'chota bheem': /Bheem/ };
      for (const [q, re] of Object.entries(want)) {
        const r = await search(q);
        assert(r.dropdown[0] && re.test(T(r.dropdown[0])), `"${q}" -> ${r.dropdown[0] && T(r.dropdown[0])}`);
      }
    });
    await check('live: an actor search returns their filmography', async () => {
      const r = await search('akshay kumar');
      const titles = r.main.slice(0, 30).map(T);
      for (const t of ['Hera Pheri', 'Housefull']) assert(titles.includes(t), t + ' missing from top 30');
      assert(!titles.some(t => /^Untitled/.test(t)), 'Untitled placeholders listed');
    });
    await check('live: a web series search shows that series, not films sharing the word', async () => {
      const titles = (await search('panchayat')).main.map(T);
      assert(titles[0] === 'Panchayat' && !titles.some(t => /Jetty|Panchayath/.test(t)), titles.join(', '));
    });
    await check('live: "tiger 3" lists only the Tiger films', async () => {
      const titles = (await search('tiger 3')).main.map(T);
      assert(titles[0] === 'Tiger 3' && titles.includes('Ek Tha Tiger') && !titles.some(t => /Glass|Cage|Bunny/.test(t)), titles.join(', '));
    });
    await check('live: every content type returns only its own franchise', async () => {
      const cases = {
        'breaking bad': [/breaking bad/i, /Bad News Bears/],            // web series
        'demon slayer': [/demon slayer/i, /Woochi|Immortal Demon/],      // anime
        'one piece': [/one piece/i, null],
        'oggy': [/oggy/i, null],                                           // cartoon
        'tom and jerry': [/tom (and|&) jerry/i, null],
        'fast and furious': [/fast|furious|hobbs/i, /\(1939\)|Fast Company|Fast and Loose/], // Hollywood
        'conjuring': [/conjuring/i, /^Conjuring$|Time Raiders|Misty Creed/],
        'pushpa': [/pushpa/i, /Impossible|Hate Tears/],                    // South
        'kantara': [/kantara/i, null]
      };
      const bad = [];
      for (const [q, [want, never]] of Object.entries(cases)) {
        const r = await search(q);
        const titles = r.main.map(T);
        if (!titles.length || !want.test(titles[0])) bad.push(q + ': first = ' + titles[0]);
        if (never && titles.some(t => never.test(t))) bad.push(q + ': has ' + titles.filter(t => never.test(t)).join(', '));
      }
      assert(!bad.length, bad.join(' | '));
    });
    await check('live: "stree2" brings the first film too', async () => {
      const titles = (await search('stree2')).main.map(T);
      assert(titles.includes('Stree') && titles.includes('Stree 2'), titles.join(', '));
    });
  }

  console.log('='.repeat(62));
  console.log('  search-plus-check: ' + passed + ' passed, ' + failed + ' failed');
  fails.forEach(f => console.log('   x ' + f));
  console.log('='.repeat(62));
  process.exit(failed ? 1 : 0);
})();
