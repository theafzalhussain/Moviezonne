'use strict';

/*  Live smoke check: boots the real server.js (real TMDB credentials, real
 *  cache, real express.static ordering) and asserts the SSR pages render
 *  correctly end to end. This is the check that catches wiring mistakes the
 *  unit tests cannot see — e.g. express.static swallowing /movie/... , or a
 *  route registered after a catch-all.
 *
 *  Run: node seo-live-check.js
 */

const http = require('http');
const assert = require('assert');

const app = require('./server');

let pass = 0;
let fail = 0;

function get(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.get({
      host: '127.0.0.1',
      port,
      path,
      headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function check(label, fn) {
  try {
    await fn();
    pass++;
    console.log('  PASS  ' + label);
  } catch (err) {
    fail++;
    console.log('  FAIL  ' + label + '\n          ' + err.message);
  }
}

function meta(html, name) {
  const m = new RegExp('<meta\\s+(?:name|property)="' + name + '"\\s+content="([^"]*)"', 'i').exec(html);
  return m ? m[1] : null;
}

function schemas(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(JSON.parse(m[1]));
  return out;
}

(async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  console.log('\nServer booted on port ' + server.address().port + '\n');
  console.log('── real movie detail page (TMDB 550 = Fight Club) ──────────────');

  let movieHtml = '';
  await check('GET /movie/550-fight-club returns 200 HTML', async () => {
    const r = await get(server, '/movie/550-fight-club');
    assert.strictEqual(r.status, 200, 'got ' + r.status);
    assert.ok(/text\/html/.test(r.headers['content-type']), r.headers['content-type']);
    movieHtml = r.body;
  });

  await check('page is served by SSR, not the SPA shell', () => {
    assert.ok(!movieHtml.includes('id="mz-loader"'), 'the SPA index.html was served instead of the SSR page');
    assert.ok(movieHtml.includes('class="hero-in"'), 'SSR template markers missing');
  });

  await check('real TMDB title and synopsis are present in the HTML source', () => {
    assert.ok(/Fight Club/.test(movieHtml), 'title missing');
    assert.ok(/insomniac|soap salesman/i.test(movieHtml), 'real TMDB overview text missing');
  });

  await check('unique non-empty meta description', () => {
    const d = meta(movieHtml, 'description');
    assert.ok(d && d.length > 60, 'description too short: ' + d);
    assert.ok(/Fight Club|insomniac|1999/i.test(d), 'description is generic: ' + d);
  });

  await check('canonical URL points at the slug URL', () => {
    const c = /<link rel="canonical" href="([^"]+)"/.exec(movieHtml)[1];
    assert.ok(c.endsWith('/movie/550-fight-club'), c);
  });

  await check('Movie schema carries a real aggregateRating from TMDB', () => {
    const movie = schemas(movieHtml).find((s) => s['@type'] === 'Movie');
    assert.ok(movie, 'no Movie schema');
    assert.ok(movie.aggregateRating, 'no aggregateRating');
    assert.ok(Number(movie.aggregateRating.ratingValue) > 7, 'rating looks wrong: ' + movie.aggregateRating.ratingValue);
    assert.ok(movie.aggregateRating.ratingCount > 1000, 'ratingCount looks wrong');
    assert.ok(movie.director && movie.director.length, 'no director in schema');
  });

  await check('real cast names rendered from TMDB credits', () => {
    assert.ok(/Brad Pitt|Edward Norton/.test(movieHtml), 'cast missing');
  });

  await check('internal links to related titles exist', () => {
    const links = movieHtml.match(/href="\/movie\/\d+-[a-z0-9-]+"/g) || [];
    assert.ok(links.length >= 5, 'only ' + links.length + ' internal detail links');
  });

  console.log('\n── real series detail page (TMDB 1396 = Breaking Bad) ──────────');

  await check('GET /tv/1396-breaking-bad renders TVSeries schema with season count', async () => {
    const r = await get(server, '/tv/1396-breaking-bad');
    assert.strictEqual(r.status, 200, 'got ' + r.status);
    const tv = schemas(r.body).find((s) => s['@type'] === 'TVSeries');
    assert.ok(tv, 'no TVSeries schema');
    assert.strictEqual(tv.name, 'Breaking Bad');
    assert.ok(tv.numberOfSeasons >= 5, 'seasons: ' + tv.numberOfSeasons);
    assert.ok(tv.numberOfEpisodes >= 60, 'episodes: ' + tv.numberOfEpisodes);
  });

  console.log('\n── canonical redirects ─────────────────────────────────────────');

  await check('/movie/550 redirects 301 to the slug URL', async () => {
    const r = await get(server, '/movie/550');
    assert.strictEqual(r.status, 301, 'got ' + r.status);
    assert.strictEqual(r.headers.location, '/movie/550-fight-club');
  });

  await check('a stale slug redirects 301 to the current one', async () => {
    const r = await get(server, '/movie/550-old-wrong-name');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.headers.location, '/movie/550-fight-club');
  });

  console.log('\n── category landing pages ──────────────────────────────────────');

  for (const path of ['/movies/bollywood', '/movies/action', '/series/anime', '/movies/4k']) {
    await check('GET ' + path + ' renders with real titles + description', async () => {
      const r = await get(server, path);
      assert.strictEqual(r.status, 200, 'got ' + r.status);
      const d = meta(r.body, 'description');
      assert.ok(d && d.length > 80, 'thin description on ' + path);
      const cards = (r.body.match(/class="card"/g) || []).length;
      assert.ok(cards >= 5, path + ' rendered only ' + cards + ' cards from TMDB');
      const list = schemas(r.body).find((s) => s['@type'] === 'ItemList');
      assert.ok(list && list.itemListElement.length >= 5, 'ItemList schema thin on ' + path);
    });
  }

  await check('category detail links resolve to real pages (spot check)', async () => {
    const r = await get(server, '/movies/bollywood');
    const m = /href="(\/movie\/\d+-[a-z0-9-]+)"/.exec(r.body);
    assert.ok(m, 'no detail link found on the category page');
    const child = await get(server, m[1]);
    assert.strictEqual(child.status, 200, m[1] + ' returned ' + child.status);
    assert.ok(meta(child.body, 'description').length > 60, 'child page had a thin description');
  });

  console.log('\n── sitemaps ────────────────────────────────────────────────────');

  await check('/sitemap.xml is a valid sitemap index', async () => {
    const r = await get(server, '/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.ok(/application\/xml/.test(r.headers['content-type']), r.headers['content-type']);
    assert.ok(r.body.includes('<sitemapindex'), 'not a sitemap index');
    assert.strictEqual((r.body.match(/<sitemap>/g) || []).length, 3);
  });

  await check('/sitemap-static.xml lists homepage + all category pages', async () => {
    const r = await get(server, '/sitemap-static.xml');
    const count = (r.body.match(/<url>/g) || []).length;
    assert.ok(count >= 25, 'only ' + count + ' static URLs');
  });

  let movieSitemapUrls = [];
  await check('/sitemap-movies.xml contains many real movie URLs', async () => {
    const r = await get(server, '/sitemap-movies.xml');
    assert.strictEqual(r.status, 200);
    movieSitemapUrls = (r.body.match(/<loc>([^<]+)<\/loc>/g) || []).map((s) => s.replace(/<\/?loc>/g, ''));
    assert.ok(movieSitemapUrls.length >= 100,
      'only ' + movieSitemapUrls.length + ' movie URLs — expected 100+');
    assert.ok(movieSitemapUrls.every((u) => /\/movie\/\d+-/.test(u)), 'malformed URL in movie sitemap');
  });

  await check('/sitemap-tv.xml contains many real series URLs', async () => {
    const r = await get(server, '/sitemap-tv.xml');
    const urls = (r.body.match(/<loc>/g) || []).length;
    assert.ok(urls >= 60, 'only ' + urls + ' series URLs — expected 60+');
    assert.ok(r.body.includes('/tv/'), 'no /tv/ URLs present');
  });

  await check('sitemap XML has no unescaped ampersands', async () => {
    for (const p of ['/sitemap.xml', '/sitemap-static.xml', '/sitemap-movies.xml', '/sitemap-tv.xml']) {
      const r = await get(server, p);
      assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(r.body), 'unescaped & in ' + p);
    }
  });

  await check('a sitemap URL actually resolves to a 200 page', async () => {
    const sample = movieSitemapUrls[0].replace(/^https?:\/\/[^/]+/, '');
    const r = await get(server, sample);
    assert.strictEqual(r.status, 200, sample + ' returned ' + r.status);
  });

  console.log('\n── regressions: existing surfaces still work ───────────────────');

  await check('GET / still serves the SPA shell, not an SSR page', async () => {
    const r = await get(server, '/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('id="mz-loader"'), 'SPA index.html no longer served at /');
    assert.ok(r.body.includes('moviezone.js'), 'SPA bundle reference missing');
  });

  await check('/robots.txt still served and points at the sitemap index', async () => {
    const r = await get(server, '/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.ok(/Sitemap:\s*https:\/\/moviezone\.dev\/sitemap\.xml/.test(r.body), r.body);
  });

  await check('/manifest.json still served with the correct MIME type', async () => {
    const r = await get(server, '/manifest.json');
    assert.strictEqual(r.status, 200);
    assert.ok(/application\/manifest\+json/.test(r.headers['content-type']));
  });

  await check('/api/tmdb proxy still responds', async () => {
    const r = await get(server, '/api/tmdb/movie/550?language=en-US');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).id, 550);
  });

  await check('static assets still served (moviezone.js, logo.webp)', async () => {
    for (const p of ['/moviezone.js', '/moviezone-logo.webp']) {
      const r = await get(server, p);
      assert.strictEqual(r.status, 200, p + ' returned ' + r.status);
    }
  });

  await new Promise((resolve) => server.close(resolve));

  console.log('\n' + '='.repeat(60));
  console.log('  live check: ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(60) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nHarness crashed:', err);
  process.exit(1);
});
