#!/usr/bin/env node
/*  franchise-check.js: the /collection franchise hubs, through the REAL worker.
 *
 *    node franchise-check.js            TMDB answered from fixtures (CI)
 *    node franchise-check.js --online   TMDB answered live via moviezone.dev
 *
 *  Guards: every franchise renders a complete page (title, h1, ordered list,
 *  ItemList + FAQ schema, canonical), unknown slugs fall through, the hubs are
 *  in the static sitemap and the footer, and the wrangler route list sends
 *  /collection to the worker (without it Cloudflare serves the SPA shell).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const seo = require('./seo-ssr.js');
const ONLINE = process.argv.includes('--online');

let passed = 0, failed = 0; const fails = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : '')); }
}

const realFetch = global.fetch;
function fixture(apiPath) {
  const id = Number((/\/(?:collection|tv)\/(\d+)/.exec(apiPath) || [])[1]);
  if (apiPath.startsWith('/collection/')) {
    return { id, name: 'Fixture Collection', parts: [
      { id: id * 10 + 1, title: 'Part One', release_date: '2006-07-14', poster_path: '/a.jpg', backdrop_path: '/ab.jpg', vote_average: 7.1, vote_count: 900, overview: 'The first film introduces the gang and their very first misadventure together.' },
      { id: id * 10 + 3, title: 'Part Three', release_date: '2010-11-05', poster_path: '/c.jpg', vote_average: 6.2, vote_count: 400, overview: 'Third time round.' },
      { id: id * 10 + 2, title: 'Part Two', release_date: '2008-10-29', poster_path: '/b.jpg', vote_average: 6.8, vote_count: 600, overview: 'They are back.' },
      { id: id * 10 + 9, title: 'Part Next', release_date: '2099-01-01', poster_path: '/n.jpg', overview: '' }
    ] };
  }
  if (apiPath.startsWith('/tv/')) return { id, name: 'Fixture Series ' + id, first_air_date: '2005-12-27', poster_path: '/t.jpg', vote_average: 7.5 };
  return null;
}
global.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input.url);
  const m = /^https:\/\/api\.themoviedb\.org\/3(\/[^?]*)(\?.*)?$/.exec(url);
  if (!m) return realFetch(input, init);
  if (ONLINE) return realFetch('https://moviezone.dev/api/tmdb' + m[1] + (m[2] || ''));
  const body = fixture(m[1]);
  return new Response(body ? JSON.stringify(body) : '{"status_code":34}', { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
};

function fakeKV() {
  const data = new Map();
  return {
    async get(k, t) { const v = data.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
    async getWithMetadata(k, t) { const v = await this.get(k, t); return { value: v, metadata: null }; },
    async put(k, v) { data.set(k, String(v)); }, async delete(k) { data.delete(k); },
    async list() { return { keys: [], list_complete: true }; }
  };
}
const assets = { async fetch(r) {
  const u = new URL(typeof r === 'string' ? r : r.url);
  const f = path.join(__dirname, u.pathname.replace(/^\/+/, ''));
  return fs.existsSync(f) ? new Response(fs.readFileSync(f, 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('nf', { status: 404 });
} };

(async () => {
  console.log('franchise hubs' + (ONLINE ? ' (live TMDB)' : ''));
  console.log('-'.repeat(62));
  const src = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g, (_m, f) => "from '" + pathToFileURL(path.join(__dirname, f)).href + "'");
  const worker = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const env = { TMDB_CACHE: fakeKV(), ASSETS: assets, TMDB_TOKEN: 'test-token' };
  const ctx = { waitUntil(p) { if (p && p.catch) p.catch(() => {}); } };
  const get = (p) => worker.ssrResponse(new Request('https://moviezone.dev' + p), env, ctx, new URL('https://moviezone.dev' + p));

  const idx = await get('/collection');
  const idxHtml = idx ? await idx.text() : '';
  check('/collection answers 200 with every franchise linked', idx && idx.status === 200 &&
    seo.FRANCHISES.every((f) => idxHtml.includes('href="/collection/' + f.slug + '"')));

  const bad = [];
  const thin = [];
  for (const f of seo.FRANCHISES) {
    const res = await get('/collection/' + f.slug);
    const html = res ? await res.text() : '';
    const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '';
    const items = (html.match(/class="fr-item"/g) || []).length;
    const problems = [];
    if (!res || res.status !== 200) problems.push('status ' + (res && res.status));
    if (!title || title.length > 75) problems.push('title "' + title + '" (' + title.length + ')');
    if (!/<h1>[^<]+<\/h1>/.test(html)) problems.push('no h1');
    if (!html.includes('"@type":"ItemList"') && !html.includes('"@type": "ItemList"')) problems.push('no ItemList');
    if (!/FAQPage/.test(html)) problems.push('no FAQPage');
    if (!html.includes('rel="canonical" href="https://moviezone.dev/collection/' + f.slug + '"')) problems.push('canonical');
    if (problems.length) bad.push(f.slug + ': ' + problems.join(', '));
    if (items < 2) thin.push(f.slug + ' (' + items + ' items)');
  }
  check('every franchise page renders title <= 75, h1, ItemList, FAQ and canonical', !bad.length, bad.slice(0, 6).join('\n          '));
  check('every franchise page lists at least two titles', !thin.length, thin.join(', '));

  const one = await (await get('/collection/golmaal-all-parts')).text();
  if (!ONLINE) {
    const list = one.slice(one.indexOf('<ol class="fr-list">'));
    const order = ['Part One', 'Part Two', 'Part Three', 'Part Next'].map((t) => list.indexOf('>' + t + ' ('));
    check('parts are listed in release order, upcoming last and marked', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])) && /Releasing 1 January 2099/.test(one));
    check('FAQ answers how many and what is next from the data', /There are 3 released Golmaal movies, with 1 more announced/.test(one) && /Part Next is scheduled for 1 January 2099/.test(one));
  } else {
    check('live: Golmaal page lists Golmaal Returns, 3 and Again', ['Golmaal Returns', 'Golmaal 3', 'Golmaal Again'].every((t) => one.includes('>' + t + ' (')));
    const mcu = await (await get('/collection/marvel-movies-in-order')).text();
    check('live: Marvel page starts with Iron Man (universe catalogue)', /class="fr-item">[\s\S]*?>Iron Man \(2008\)/.test(mcu));
    const ben = await (await get('/collection/ben-10-movies')).text();
    check('live: Ben 10 page has both movies and TV series', /Ben 10: Race Against Time/.test(ben) && /Ben 10 TV series/.test(ben));
  }

  check('unknown /collection slug falls through (null => SPA 404 handling)', (await get('/collection/not-a-real-franchise')) === null);
  const sm = seo.buildStaticSitemap();
  check('static sitemap lists the hub and every franchise', sm.includes('/collection</loc>') && seo.FRANCHISES.every((f) => sm.includes('/collection/' + f.slug + '</loc>')));
  const wr = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');
  check('wrangler sends /collection and /collection/* to the worker', wr.includes('"/collection"') && wr.includes('"/collection/*"'));
  check('every SSR footer links the franchise hub', idxHtml.includes('<a href="/collection">Franchises in order</a>'));
  const llms = fs.existsSync(path.join(__dirname, 'llms.txt')) ? fs.readFileSync(path.join(__dirname, 'llms.txt'), 'utf8') : '';
  const missing = seo.FRANCHISES.map((f) => '/collection/' + f.slug)
    .concat(Object.keys(seo.CATEGORIES).map((k) => seo.categoryPath(k)))
    .filter((p) => !llms.includes('https://moviezone.dev' + p + ')'));
  check('llms.txt (the AI-assistant summary) lists every franchise and category', llms.startsWith('# MovieZone') && !missing.length, missing.slice(0, 5).join(', '));
  const robots = fs.readFileSync(path.join(__dirname, 'robots.txt'), 'utf8');
  check('robots.txt lets AI search crawlers in (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended)',
    ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'].every((b) => new RegExp('User-agent: ' + b + '\\n(?:User-agent: [^\\n]+\\n)*Allow: /').test(robots)));
  check('franchise slugs are unique and URL-safe', new Set(seo.FRANCHISES.map((f) => f.slug)).size === seo.FRANCHISES.length && seo.FRANCHISES.every((f) => /^[a-z0-9-]+$/.test(f.slug)));

  console.log('='.repeat(62));
  console.log('  franchise-check: ' + passed + ' passed, ' + failed + ' failed');
  fails.forEach((f) => console.log('   x ' + f));
  console.log('='.repeat(62));
  process.exit(failed ? 1 : 0);
})();
