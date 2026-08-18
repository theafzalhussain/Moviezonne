/*  ═══════════════════════════════════════════════════════════════════════════
    worker-seo.test.js — proves the Worker serves the sitemaps and the A-Z hubs.

    WHY THIS EXISTS
    sitemap-shard-check.js covers the same routes under Express, and passed the
    whole time the Cloudflare deployment had none of them. registerSeoRoutes()
    serves /sitemap*.xml and /browse* from sitemap-cache.json; worker.js carried
    over only the detail and category pages, so on moviezone.dev:

      • /sitemap.xml   was answered by the stale five-URL file in the repo root,
                       three of whose URLs (/movie, /tv, /trending) are not pages
      • /browse        fell through to not_found_handling "single-page-application"
                       and answered 200 with the homepage shell

    robots.txt advertises that sitemap, so the entire catalogue was submitted to
    Google as five URLs.

    The failure mode being guarded is narrower than "the route exists". The shard
    count in /sitemap.xml and the shard bodies must come from ONE item list: a
    /sitemap-movies-2.xml that the index advertises and the shard handler 404s is
    reported as an error by Search Console, and that regression has already
    happened once on the Express side.

    worker.js is ESM and this package is commonjs, so it is imported through a
    data: URL — the real module, unmodified, with real ESM semantics.

    Run: node worker-seo.test.js
    ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const seo = require('./seo-ssr.js');

const WORKER_FILE = path.join(__dirname, 'worker.js');
const CATALOG_FILE = path.join(__dirname, 'sitemap-cache.json');

let failures = 0;
let checks = 0;

function check(label, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + label
    + (!pass && detail ? '\n          ' + detail : ''));
}

function equal(label, actual, expected) {
  check(label, actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── fakes ────────────────────────────────────────────────────────────────────

/** A KV namespace with just enough behaviour for the sitemap paths. */
function fakeKV(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async put(key, value) { data.set(key, String(value)); return undefined; },
    async delete(key) { data.delete(key); },
    async list() { return { keys: [...data.keys()].map((name) => ({ name })), list_complete: true }; }
  };
}

/*  Serves collections-catalog.json the way the assets binding would.
 *
 *  Bound to the REAL fs up front: hideServerOnlyFiles() below makes those two
 *  files unreadable to emulate the Worker, and the asset binding is the one
 *  channel that must keep working through it. */
const realFs = { existsSync: fs.existsSync.bind(fs), readFileSync: fs.readFileSync.bind(fs) };

function fakeAssets() {
  return {
    async fetch(request) {
      const url = new URL(typeof request === 'string' ? request : request.url);
      const file = path.join(__dirname, url.pathname.replace(/^\/+/, ''));
      if (!realFs.existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(realFs.readFileSync(file, 'utf8'), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  };
}

const ctx = { waitUntil(promise) { if (promise && promise.catch) promise.catch(() => {}); } };
const req = (url) => new Request(url, { method: 'GET' });
const urlOf = (u) => new URL(u);

/*  Emulates the Worker's filesystem: there isn't one.
 *
 *  seo-ssr.js reads collections-catalog.json and sitemap-cache.json with fs, and
 *  under Node those reads SUCCEED — so a test that leaves fs alone proves nothing
 *  about the Cloudflare runtime, where every one of them falls into the catch and
 *  returns nothing. Both files are hidden for the live-fallback cases below so
 *  the only data the Worker can reach is what worker.js fetches itself.
 */
function hideServerOnlyFiles() {
  const hidden = /(collections-catalog|sitemap-cache)\.json$/;
  const real = {
    existsSync: fs.existsSync, readFileSync: fs.readFileSync, statSync: fs.statSync
  };
  fs.existsSync = (p, ...rest) => (hidden.test(String(p)) ? false : real.existsSync(p, ...rest));
  fs.readFileSync = (p, ...rest) => {
    if (hidden.test(String(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return real.readFileSync(p, ...rest);
  };
  fs.statSync = (p, ...rest) => {
    if (hidden.test(String(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return real.statSync(p, ...rest);
  };
  return () => Object.assign(fs, real);
}

const urlCount = (xml) => (xml.match(/<url>/g) || []).length;
const childSitemaps = (xml) =>
  [...xml.matchAll(/<sitemap><loc>https?:\/\/[^/]+([^<]+)<\/loc>/g)].map((m) => m[1]);
const locs = (xml) => [...xml.matchAll(/<url><loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

(async () => {
  console.log('\nWorker SEO layer — sitemap index, media shards and the A-Z browse hubs');
  console.log('-'.repeat(74));

  /*  Same rewrite worker-push.test.js uses: a data: URL has no base to resolve
   *  './seo-ssr.js' against, so the specifier is made absolute first. */
  const source = fs.readFileSync(WORKER_FILE, 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g,
      (_m, file) => "from '" + pathToFileURL(path.join(__dirname, file)).href + "'");
  const worker = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const limits = worker.seoLimits();

  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const movieCount = catalog.movie.length;
  const tvCount = catalog.tv.length;

  // ── 1. the two runtimes must shard identically ────────────────────────────
  console.log('\n1. sharding agrees with seo-ssr.js');
  equal('SITEMAP_CHUNK matches SITEMAP_CHUNK_SIZE', limits.SITEMAP_CHUNK, seo.SITEMAP_CHUNK_SIZE);
  check('shard 1 keeps the URL Search Console already has',
    worker.sitemapShardPaths('movie', 1)[0] === '/sitemap-movies.xml'
    && worker.sitemapShardPaths('tv', 1)[0] === '/sitemap-tv.xml');
  equal('an exact multiple of the chunk size does not add an empty shard',
    worker.sitemapShardPaths('movie', limits.SITEMAP_CHUNK).length, 1);
  equal('one title past the boundary adds exactly one shard',
    worker.sitemapShardPaths('movie', limits.SITEMAP_CHUNK + 1).length, 2);
  equal('an empty catalogue still advertises the canonical first shard',
    worker.sitemapShardPaths('movie', 0).join(','), '/sitemap-movies.xml');

  // ── 2. the full catalogue, served out of KV ───────────────────────────────
  console.log(`\n2. the KV catalogue (${movieCount} movies, ${tvCount} series) is served whole`);
  const kv = fakeKV({ 'sitemap:catalog': JSON.stringify(catalog) });
  const env = { TMDB_CACHE: kv, ASSETS: fakeAssets() };

  const index = await worker.ssrResponse(req('https://moviezone.dev/sitemap.xml'), env, ctx,
    urlOf('https://moviezone.dev/sitemap.xml'));
  equal('/sitemap.xml answers 200', index && index.status, 200);
  check('/sitemap.xml is served as XML',
    /xml/.test((index && index.headers.get('content-type')) || ''),
    'content-type: ' + (index && index.headers.get('content-type')));
  const indexXml = await index.text();
  const kids = childSitemaps(indexXml);

  equal('the index lists static + browse + every media shard', kids.length,
    2 + Math.ceil(movieCount / limits.SITEMAP_CHUNK) + Math.ceil(tvCount / limits.SITEMAP_CHUNK));
  check('the index carries the catalogue build date',
    indexXml.includes('<lastmod>' + catalog.generated + '</lastmod>'),
    'expected ' + catalog.generated + ' in ' + indexXml.slice(0, 240));

  // Every advertised child must be fetchable, XML, and non-empty: sitemap.xsd
  // requires at least one <url>, so an empty urlset is invalid XML.
  const fetched = [];
  for (const child of kids) {
    const res = await worker.ssrResponse(req('https://moviezone.dev' + child), env, ctx,
      urlOf('https://moviezone.dev' + child));
    fetched.push([child, res, res ? await res.text() : '']);
  }

  check('every advertised sitemap is claimed by the Worker',
    fetched.every(([, res]) => res !== null),
    'fell through to the SPA: ' + fetched.filter(([, r]) => !r).map(([k]) => k).join(', '));
  check('every advertised sitemap answers 200',
    fetched.every(([, res]) => res && res.status === 200),
    'non-200: ' + fetched.filter(([, r]) => !r || r.status !== 200).map(([k]) => k).join(', '));
  check('every advertised sitemap is XML',
    fetched.every(([, res]) => res && /xml/.test(res.headers.get('content-type') || '')),
    'not XML: ' + fetched.filter(([, r]) => !r || !/xml/.test(r.headers.get('content-type') || ''))
      .map(([k]) => k).join(', '));
  check('no advertised sitemap is empty',
    fetched.every(([, , body]) => urlCount(body) > 0),
    'empty urlset: ' + fetched.filter(([, , b]) => urlCount(b) === 0).map(([k]) => k).join(', '));

  const movieShards = fetched.filter(([k]) => k.startsWith('/sitemap-movies'));
  const tvShards = fetched.filter(([k]) => k.startsWith('/sitemap-tv'));
  equal('the movie shards together carry every movie',
    movieShards.reduce((n, [, , b]) => n + urlCount(b), 0), movieCount);
  equal('the tv shards together carry every series',
    tvShards.reduce((n, [, , b]) => n + urlCount(b), 0), tvCount);

  const seen = new Set();
  const dupes = [];
  for (const [, , body] of fetched) {
    for (const loc of locs(body)) {
      if (seen.has(loc)) dupes.push(loc); else seen.add(loc);
    }
  }
  equal('no URL appears in two shards', dupes.length, 0);
  check('movie shards hold /movie/ URLs and tv shards hold /tv/ URLs',
    movieShards.every(([, , b]) => locs(b).every((l) => l.includes('/movie/')))
    && tvShards.every(([, , b]) => locs(b).every((l) => l.includes('/tv/'))));

  const TODAY = new Date().toISOString().slice(0, 10);
  const dates = [...fetched.map(([, , b]) => b).join('\n')
    .matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
  check('no lastmod is in the future', dates.every((d) => d <= TODAY),
    'future: ' + dates.filter((d) => d > TODAY).slice(0, 3).join(', '));
  check('no lastmod predates the epoch', dates.every((d) => d >= seo.SITEMAP_MIN_LASTMOD),
    'pre-epoch: ' + dates.filter((d) => d < seo.SITEMAP_MIN_LASTMOD).slice(0, 3).join(', '));

  // ── 3. shards the index never advertised ──────────────────────────────────
  console.log('\n3. an unadvertised shard 404s instead of answering the SPA shell');
  for (const p of ['/sitemap-movies-99.xml', '/sitemap-movies-0.xml', '/sitemap-tv-99.xml']) {
    const res = await worker.ssrResponse(req('https://moviezone.dev' + p), env, ctx, urlOf('https://moviezone.dev' + p));
    equal(p + ' answers 404', res && res.status, 404);
  }

  // ── 4. the static and browse sitemaps ─────────────────────────────────────
  console.log('\n4. /sitemap-static.xml and /sitemap-browse.xml');
  const staticRes = await worker.ssrResponse(req('https://moviezone.dev/sitemap-static.xml'), env, ctx,
    urlOf('https://moviezone.dev/sitemap-static.xml'));
  const staticXml = await staticRes.text();
  equal('/sitemap-static.xml answers 200', staticRes.status, 200);
  check('it lists the homepage, /browse and every category', urlCount(staticXml) >= 3
    && staticXml.includes('<loc>' + seo.SITE_URL + '/</loc>')
    && staticXml.includes('<loc>' + seo.SITE_URL + '/browse</loc>'),
    urlCount(staticXml) + ' urls');

  const browseSitemap = await worker.ssrResponse(req('https://moviezone.dev/sitemap-browse.xml'), env, ctx,
    urlOf('https://moviezone.dev/sitemap-browse.xml'));
  const browseXml = await browseSitemap.text();
  equal('/sitemap-browse.xml lists one URL per letter', urlCount(browseXml), seo.BROWSE_LETTERS.length);

  // ── 5. the A-Z hubs ───────────────────────────────────────────────────────
  console.log('\n5. /browse and /browse/:letter render server-side');
  const hub = await worker.ssrResponse(req('https://moviezone.dev/browse'), env, ctx,
    urlOf('https://moviezone.dev/browse'));
  equal('/browse answers 200', hub && hub.status, 200);
  check('/browse is HTML, not the SPA shell served as XML',
    /text\/html/.test((hub && hub.headers.get('content-type')) || ''));
  equal('/browse is indexable', hub && hub.headers.get('x-robots-tag'), 'index, follow');
  const hubHtml = await hub.text();
  check('/browse links every letter',
    seo.BROWSE_LETTERS.every((l) => hubHtml.includes('href="/browse/' + l + '"')),
    'missing: ' + seo.BROWSE_LETTERS.filter((l) => !hubHtml.includes('href="/browse/' + l + '"')).join(', '));
  check('/browse carries a per-letter count', /\/browse\/t">t <span/.test(hubHtml));

  const byLetter = {};
  for (const entry of catalog.movie.concat(catalog.tv)) {
    const l = seo.browseLetterOf(entry.title);
    byLetter[l] = (byLetter[l] || 0) + 1;
  }
  const biggest = Object.keys(byLetter).sort((a, b) => byLetter[b] - byLetter[a])[0];

  const letterRes = await worker.ssrResponse(req('https://moviezone.dev/browse/' + biggest), env, ctx,
    urlOf('https://moviezone.dev/browse/' + biggest));
  equal('/browse/' + biggest + ' answers 200', letterRes && letterRes.status, 200);
  const letterHtml = await letterRes.text();
  const linkCount = (letterHtml.match(/href="\/(movie|tv)\/\d+-/g) || []).length;
  equal(`the busiest letter (${biggest}, ${byLetter[biggest]} titles) links all of them on one page`,
    linkCount, Math.min(byLetter[biggest], seo.BROWSE_PER_PAGE));
  check('the letter page canonicalises to itself',
    letterHtml.includes('rel="canonical" href="' + seo.SITE_URL + '/browse/' + biggest + '"'));

  const digits = await worker.ssrResponse(req('https://moviezone.dev/browse/0-9'), env, ctx,
    urlOf('https://moviezone.dev/browse/0-9'));
  equal('/browse/0-9 answers 200', digits && digits.status, 200);

  const upper = await worker.ssrResponse(req('https://moviezone.dev/browse/T'), env, ctx,
    urlOf('https://moviezone.dev/browse/T'));
  equal('/browse/T is matched case-insensitively', upper && upper.status, 200);

  const overflow = await worker.ssrResponse(req('https://moviezone.dev/browse/' + biggest + '?page=99'), env, ctx,
    urlOf('https://moviezone.dev/browse/' + biggest + '?page=99'));
  equal('?page= beyond the end redirects instead of serving a thin duplicate',
    overflow && overflow.status, 301);
  equal('and it redirects to page 1 of the same letter',
    overflow && overflow.headers.get('location'), '/browse/' + biggest);

  const bogus = await worker.ssrResponse(req('https://moviezone.dev/browse/zz'), env, ctx,
    urlOf('https://moviezone.dev/browse/zz'));
  equal('an unknown letter falls through to the SPA', bogus, null);

  // ── 6. nothing above may have leaked into the page routes ─────────────────
  console.log('\n6. the existing routes are untouched');
  const home = await worker.ssrResponse(req('https://moviezone.dev/'), env, ctx, urlOf('https://moviezone.dev/'));
  equal('/ still falls through', home, null);
  const movies = await worker.ssrResponse(req('https://moviezone.dev/movies'), env, ctx, urlOf('https://moviezone.dev/movies'));
  equal('/movies still redirects', movies && movies.status, 301);
  equal('  to /movies/popular', movies && movies.headers.get('location'), '/movies/popular');
  const posted = await worker.ssrResponse(new Request('https://moviezone.dev/sitemap.xml', { method: 'POST' }),
    env, ctx, urlOf('https://moviezone.dev/sitemap.xml'));
  equal('POST /sitemap.xml is not an SSR route', posted, null);

  // ── 7. no catalogue in KV: the bounded live build ─────────────────────────
  console.log('\n7. with no catalogue in KV the routes fall back to live TMDB');
  const restoreFs = hideServerOnlyFiles();
  const realFetch = globalThis.fetch;
  let tmdbCalls = 0;
  globalThis.fetch = async (input) => {
    const target = String(typeof input === 'string' ? input : input.url);
    if (!target.startsWith('https://api.themoviedb.org/')) return realFetch(input);
    tmdbCalls++;
    const page = Number(new URL(target).searchParams.get('page') || 1);
    const tv = /\/tv\/|\/trending\/tv/.test(target);
    const results = Array.from({ length: 20 }, (_, i) => {
      const id = (tv ? 700000 : 100000) + page * 100 + i;
      return tv
        ? { id, name: 'Live Series ' + id, first_air_date: '2021-04-05', poster_path: '/p.jpg' }
        : { id, title: 'Live Movie ' + id, release_date: '2021-04-05', poster_path: '/p.jpg' };
    });
    return new Response(JSON.stringify({ page, results, total_pages: 500 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const liveKv = fakeKV();
    const liveEnv = { TMDB_CACHE: liveKv, ASSETS: fakeAssets(), TMDB_TOKEN: 'test-token' };

    const liveMovies = await worker.ssrResponse(req('https://moviezone.dev/sitemap-movies.xml'), liveEnv, ctx,
      urlOf('https://moviezone.dev/sitemap-movies.xml'));
    const liveXml = await liveMovies.text();
    equal('/sitemap-movies.xml answers 200 off live data', liveMovies.status, 200);
    check('it reached TMDB', tmdbCalls > 0, tmdbCalls + ' calls');
    check('it is non-empty', urlCount(liveXml) > 0, urlCount(liveXml) + ' urls');
    check('the franchise catalogue is folded in',
      liveXml.includes('/movie/1726-iron-man'), 'collections-catalog.json ids missing');
    check('the live build is written to KV for the next request',
      liveKv.data.has('sitemap:items:movie'));

    const liveIndex = await worker.ssrResponse(req('https://moviezone.dev/sitemap.xml'), liveEnv, ctx,
      urlOf('https://moviezone.dev/sitemap.xml'));
    const liveKids = childSitemaps(await liveIndex.text());
    const advertised = [];
    for (const child of liveKids) {
      const res = await worker.ssrResponse(req('https://moviezone.dev' + child), liveEnv, ctx,
        urlOf('https://moviezone.dev' + child));
      advertised.push([child, res, res ? await res.text() : '']);
    }
    check('every shard the live index advertises is 200 and non-empty',
      advertised.every(([, r, b]) => r && r.status === 200 && urlCount(b) > 0),
      'bad: ' + advertised.filter(([, r, b]) => !r || r.status !== 200 || !urlCount(b))
        .map(([k]) => k).join(', '));

    const liveBrowse = await worker.ssrResponse(req('https://moviezone.dev/browse'), liveEnv, ctx,
      urlOf('https://moviezone.dev/browse'));
    equal('/browse still renders off live data', liveBrowse && liveBrowse.status, 200);

    // ── 8. TMDB down and nothing cached ────────────────────────────────────
    console.log('\n8. TMDB down and nothing cached: 5xx, never an invalid or HTML sitemap');
    globalThis.fetch = async (input) => {
      const target = String(typeof input === 'string' ? input : input.url);
      if (!target.startsWith('https://api.themoviedb.org/')) return realFetch(input);
      return new Response('upstream is down', { status: 503 });
    };
    const deadEnv = { TMDB_CACHE: fakeKV(), TMDB_TOKEN: 'test-token' };
    const dead = await worker.ssrResponse(req('https://moviezone.dev/sitemap-movies.xml'), deadEnv, ctx,
      urlOf('https://moviezone.dev/sitemap-movies.xml'));
    check('a shard with no data answers 5xx so Google retries',
      dead && dead.status >= 500 && dead.status < 600, 'status ' + (dead && dead.status));
    check('it does not answer an empty urlset (sitemap.xsd needs >= 1 <url>)',
      dead && urlCount(await dead.clone().text()) === 0 && dead.status !== 200);
    const deadBrowse = await worker.ssrResponse(req('https://moviezone.dev/browse'), deadEnv, ctx,
      urlOf('https://moviezone.dev/browse'));
    equal('/browse with no catalogue falls through to the SPA', deadBrowse, null);
  } finally {
    globalThis.fetch = realFetch;
    restoreFs();
  }

  console.log('-'.repeat(74));
  console.log('  ' + checks + ' checks, ' + (failures ? failures + ' FAILED' : 'all passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err && err.stack);
  process.exit(1);
});
