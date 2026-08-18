/*  Temporary verification: does worker.js now serve the SSR pages that only
 *  server.js used to serve? Loads the real worker module (data: URL, like
 *  worker-push.test.js) and drives ssrResponse() with a real TMDB token.
 *
 *  Run: node ssr-worker-verify.tmp.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

require('dotenv').config();

const TOKEN = process.env.TMDB_TOKEN || process.env.TMDB_API_TOKEN || process.env.TMDB_READ_TOKEN;

let failures = 0;
function check(label, pass, detail) {
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + label + (!pass && detail ? '\n          ' + detail : ''));
  if (!pass) failures++;
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g,
      (_m, file) => "from '" + pathToFileURL(path.join(__dirname, file)).href + "'");
  const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

  console.log('\nworker SSR routes\n' + '-'.repeat(70));
  check('worker module loaded (no __dirname / fs crash at import time)', true);

  const env = { TMDB_TOKEN: TOKEN };            // no KV binding: exercises the uncached path
  const ctx = { waitUntil() {} };
  const call = (url, method = 'GET') =>
    worker.ssrResponse(new Request(url, { method }), env, ctx, new URL(url));

  // 1. the reported bug
  const cat = await call('https://moviezone.dev/movies/prime-video');
  check('/movies/prime-video is claimed by SSR (not the SPA fallback)', !!cat);
  if (cat) {
    const html = await cat.text();
    const title = (html.match(/<title>(.*?)<\/title>/) || [])[1] || '';
    check('  status 200 + text/html', cat.status === 200
      && /text\/html/.test(cat.headers.get('content-type')), cat.status + ' ' + cat.headers.get('content-type'));
    check('  its own <title>, not the homepage one', /prime video/i.test(title), title);
    check('  canonical points at the category URL',
      html.includes('<link rel="canonical" href="https://moviezone.dev/movies/prime-video">'));
    check('  real TMDB cards rendered', (html.match(/href="\/movie\//g) || []).length > 5,
      (html.match(/href="\/movie\//g) || []).length + ' movie links');
    check('  CollectionPage schema present', html.includes('"@type": "CollectionPage"')
      || html.includes('"@type":"CollectionPage"'));
  }

  // 2. other category families and paging
  const series = await call('https://moviezone.dev/series/anime');
  check('/series/anime renders', !!series && series.status === 200);
  const p2 = await call('https://moviezone.dev/movies/action?page=3');
  if (p2) {
    const html = await p2.text();
    check('/movies/action?page=3 canonicalises the page',
      html.includes('href="https://moviezone.dev/movies/action?page=3"'));
  } else check('/movies/action?page=3 renders', false);

  // 3. a category that does not exist must fall through to the SPA
  check('/movies/not-a-category falls through (null)',
    (await call('https://moviezone.dev/movies/not-a-category')) === null);
  check('/movies/anime is not a movie category (series-only slug)',
    (await call('https://moviezone.dev/movies/anime')) === null);

  // 4. detail page
  const detail = await call('https://moviezone.dev/movie/1339713-obsession');
  check('/movie/1339713-obsession renders the detail page', !!detail && detail.status === 200);
  if (detail && detail.status === 200) {
    const html = await detail.text();
    check('  title is the movie, not the homepage', /obsession/i.test(
      (html.match(/<title>(.*?)<\/title>/) || [])[1] || ''));
    check('  Movie schema present', html.includes('"@type": "Movie"') || html.includes('"@type":"Movie"'));
  }

  // 5. wrong slug is redirected, not served
  const wrong = await call('https://moviezone.dev/movie/1339713-wrong-slug');
  check('a wrong slug 301s to the canonical path',
    !!wrong && wrong.status === 301 && wrong.headers.get('location') === '/movie/1339713-obsession',
    wrong ? wrong.status + ' -> ' + wrong.headers.get('location') : 'null');

  // 6. watch page
  const watch = await call('https://moviezone.dev/movie/1339713-obsession/watch');
  check('/movie/<slug>/watch renders the player', !!watch && watch.status === 200);
  check('  and is noindex', !!watch && watch.headers.get('x-robots-tag') === 'noindex, follow',
    watch && watch.headers.get('x-robots-tag'));

  // 7. bare family redirects
  const movies = await call('https://moviezone.dev/movies');
  check('/movies -> 301 /movies/popular', !!movies && movies.status === 301
    && movies.headers.get('location') === '/movies/popular');
  const seriesRoot = await call('https://moviezone.dev/series');
  check('/series -> 301 /series/web-series', !!seriesRoot && seriesRoot.status === 301
    && seriesRoot.headers.get('location') === '/series/web-series');

  // 8. everything else stays with the SPA / assets
  check('/ falls through to the asset handler', (await call('https://moviezone.dev/')) === null);
  check('/moviezone.min.js falls through', (await call('https://moviezone.dev/moviezone.min.js')) === null);
  check('POST /movies/prime-video is not SSR', (await call('https://moviezone.dev/movies/prime-video', 'POST')) === null);

  console.log('-'.repeat(70));
  console.log(failures ? '  ' + failures + ' FAILED\n' : '  all passed\n');
  process.exit(failures ? 1 : 0);
})();
