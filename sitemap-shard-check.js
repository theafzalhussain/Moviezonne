#!/usr/bin/env node
/*  Verifies the two sitemap fixes against the real route handlers.
 *
 *  A. a shard the catalogue has shrunk past answers 200 with a valid, empty
 *     urlset (retired), while a shard far beyond the window still 404s
 *  B. no <lastmod> is ever in the future, and a real past date is preserved
 *
 *  Run: node sitemap-shard-check.js
 */
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

const ROOT = __dirname;
const seo = require(path.join(ROOT, 'seo-ssr.js'));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '\n      ' + e.message); fail++; }
};

const CACHE = path.join(ROOT, 'sitemap-cache.json');
const BACKUP = path.join(os.tmpdir(), 'sitemap-cache.backup.json');
fs.copyFileSync(CACHE, BACKUP);

/** Writes a cache with an exact movie count so shard maths is deterministic. */
function writeCache(movieCount, opts = {}) {
  const mk = (i) => ({ id: 100000 + i, title: 'Sample Title ' + i, lastmod: '2020-05-06' });
  const movie = Array.from({ length: movieCount }, (_, i) => mk(i));
  if (opts.future) movie[0] = { id: 999001, title: 'Future Premiere', lastmod: '2028-03-16' };
  if (opts.past) movie[1] = { id: 999002, title: 'Old Film', lastmod: '1999-01-02' };
  fs.writeFileSync(CACHE, JSON.stringify({ movie, tv: [mk(1)] }));
}

function serve() {
  const app = express();
  seo.registerSeoRoutes(app, {
    tmdb: async () => { throw new Error('live TMDB must not be reached'); }
  });
  return new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
}

function get(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => res({ status: r.statusCode, body: b, type: r.headers['content-type'] }));
    }).on('error', rej);
  });
}

(async () => {
  const TODAY = new Date().toISOString().slice(0, 10);

  // ── A: catalogue below the boundary, so shard 2 no longer has content ──
  console.log('\nA. retired shard (4722 movies -> 1 live shard)');
  writeCache(4722, { future: true, past: true });
  let s = await serve(); let port = s.address().port;

  const live = await get(port, '/sitemap-movies.xml');
  const retired = await get(port, '/sitemap-movies-2.xml');
  const edge = await get(port, '/sitemap-movies-5.xml');
  const beyond = await get(port, '/sitemap-movies-6.xml');
  const zero = await get(port, '/sitemap-movies-0.xml');
  const index = await get(port, '/sitemap.xml');

  ok('live shard 1 serves 200', () => assert.strictEqual(live.status, 200));
  ok('retired shard 2 serves 200, not 404', () => assert.strictEqual(retired.status, 200));
  ok('retired shard is a valid empty urlset', () => {
    assert.match(retired.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.match(retired.body, /<\/urlset>/);
    assert.strictEqual((retired.body.match(/<url>/g) || []).length, 0);
  });
  ok('retired shard is served as XML', () => assert.match(retired.type || '', /xml/));
  ok('last shard inside the window still answers', () => assert.strictEqual(edge.status, 200));
  ok('shard beyond the window 404s', () => assert.strictEqual(beyond.status, 404));
  ok('shard 0 404s', () => assert.strictEqual(zero.status, 404));
  ok('index lists only the live shard', () => {
    assert.ok(index.body.includes('/sitemap-movies.xml'));
    assert.ok(!index.body.includes('/sitemap-movies-2.xml'));
  });

  // ── B: lastmod clamping ──
  console.log('\nB. lastmod is never in the future');
  ok('no lastmod ahead of today', () => {
    const dates = [...live.body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
    assert.ok(dates.length > 0, 'expected lastmod values');
    const future = dates.filter((d) => d > TODAY);
    assert.strictEqual(future.length, 0, 'future dates present: ' + future.slice(0, 3));
  });
  ok('the 2028 premiere was clamped to today', () => {
    assert.ok(live.body.includes('999001'), 'future-dated entry missing from file');
    const row = live.body.split('\n').find((l) => l.includes('/movie/999001'));
    assert.match(row, new RegExp('<lastmod>' + TODAY + '</lastmod>'));
  });
  ok('a genuine past date is left alone', () => {
    const row = live.body.split('\n').find((l) => l.includes('/movie/999002'));
    assert.match(row, /<lastmod>1999-01-02<\/lastmod>/);
  });
  await new Promise((r) => s.close(r));

  // ── A2: catalogue above the boundary, so shard 2 is real again ──
  console.log('\nA2. boundary crossed upward (5034 movies -> 2 live shards)');
  delete require.cache[require.resolve(path.join(ROOT, 'seo-ssr.js'))];
  writeCache(5034);
  s = await serve(); port = s.address().port;
  const two = await get(port, '/sitemap-movies-2.xml');
  const idx2 = await get(port, '/sitemap.xml');
  ok('shard 2 now carries the remainder', () => {
    assert.strictEqual(two.status, 200);
    assert.strictEqual((two.body.match(/<url>/g) || []).length, 34);
  });
  ok('index now lists shard 2', () => assert.ok(idx2.body.includes('/sitemap-movies-2.xml')));
  await new Promise((r) => s.close(r));

  fs.copyFileSync(BACKUP, CACHE);
  console.log(`\n${'='.repeat(52)}\n  sitemap fixes: ${pass} passed, ${fail} failed\n${'='.repeat(52)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  fs.copyFileSync(BACKUP, CACHE);
  console.error('harness error:', e);
  process.exit(1);
});
