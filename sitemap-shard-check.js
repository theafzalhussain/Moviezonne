#!/usr/bin/env node
/*  sitemap-shard-check.js — guards the sharding of the catalogue sitemaps.
 *
 *  Two things went wrong here before, and both are covered below.
 *
 *  1. SITEMAP_CHUNK_SIZE was 5000 while the movie catalogue sat right on that
 *     boundary. Over four consecutive refreshes it read 4962, 5024, 5034, 4722
 *     — shard counts of 1, 1, 2, 2 — so /sitemap-movies-2.xml appeared, was
 *     registered by Google, then started 404ing. A 404 on a sitemap Search
 *     Console already knows is reported as an error.
 *
 *  2. The first attempt to fix that answered the missing shard with an empty
 *     <urlset>. sitemap.xsd requires at least one <url>, so the response was
 *     invalid XML — a worse report than the fetch failure it replaced.
 *
 *  So the assertions are: the shard count must not move anywhere inside the
 *  range the catalogue actually occupies, every sitemap the index advertises
 *  must be fetchable AND non-empty, and no <lastmod> may be in the future.
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

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '\n      ' + e.message); fail++; }
};

const CACHE = path.join(ROOT, 'sitemap-cache.json');
const BACKUP = path.join(os.tmpdir(), 'mz-sitemap-cache.backup.json');

/** Counts observed across four consecutive seo-refresh commits. */
const OBSERVED_MOVIE_COUNTS = [4722, 4962, 5024, 5034];
const OBSERVED_TV_COUNTS = [3200, 3251, 3253, 3284];

function writeCache(movieCount, tvCount, opts = {}) {
  const mk = (i, p) => ({ id: p + i, title: 'Sample Title ' + i, lastmod: '2020-05-06' });
  const movie = Array.from({ length: movieCount }, (_, i) => mk(i, 100000));
  const tv = Array.from({ length: tvCount }, (_, i) => mk(i, 700000));
  if (opts.future) movie[0] = { id: 999001, title: 'Future Premiere', lastmod: '2028-03-16' };
  if (opts.past) movie[1] = { id: 999002, title: 'Old Film', lastmod: '1999-01-02' };
  fs.writeFileSync(CACHE, JSON.stringify({ movie, tv }));
}

/** Fresh require each time so the module re-reads the cache it memoises. */
function loadSeo() {
  delete require.cache[require.resolve(path.join(ROOT, 'seo-ssr.js'))];
  return require(path.join(ROOT, 'seo-ssr.js'));
}

function serve(seo) {
  const app = express();
  seo.registerSeoRoutes(app, {
    tmdb: async () => { throw new Error('live TMDB must not be reached'); }
  });
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}

function get(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => res({ status: r.statusCode, body: b, type: r.headers['content-type'] }));
    }).on('error', rej);
  });
}

const urlCount = (xml) => (xml.match(/<url>/g) || []).length;
const childSitemaps = (xml) => [...xml.matchAll(/<loc>https?:\/\/[^/]+([^<]+)<\/loc>/g)].map((m) => m[1]);

(async () => {
  fs.copyFileSync(CACHE, BACKUP);
  const restore = () => fs.copyFileSync(BACKUP, CACHE);
  const TODAY = new Date().toISOString().slice(0, 10);

  try {
    // ── 1. the shard count must not move inside the operating range ──
    console.log('\n1. shard count is stable across the range the catalogue occupies');
    const shardCounts = { movie: new Set(), tv: new Set() };

    for (let i = 0; i < OBSERVED_MOVIE_COUNTS.length; i++) {
      const mc = OBSERVED_MOVIE_COUNTS[i], tc = OBSERVED_TV_COUNTS[i];
      writeCache(mc, tc);
      const seo = loadSeo();
      const s = await serve(seo);
      const port = s.address().port;
      const index = await get(port, '/sitemap.xml');
      const kids = childSitemaps(index.body);
      shardCounts.movie.add(kids.filter((k) => /^\/sitemap-movies(-\d+)?\.xml$/.test(k)).length);
      shardCounts.tv.add(kids.filter((k) => /^\/sitemap-tv(-\d+)?\.xml$/.test(k)).length);
      await new Promise((r) => s.close(r));
    }

    ok(`movie shard count identical for ${OBSERVED_MOVIE_COUNTS.join(', ')}`, () =>
      assert.strictEqual(shardCounts.movie.size, 1,
        'shard count moved: ' + [...shardCounts.movie].join(' vs ')));
    ok(`tv shard count identical for ${OBSERVED_TV_COUNTS.join(', ')}`, () =>
      assert.strictEqual(shardCounts.tv.size, 1,
        'shard count moved: ' + [...shardCounts.tv].join(' vs ')));

    // ── 2. everything the index advertises is fetchable and non-empty ──
    console.log('\n2. every advertised sitemap is fetchable and non-empty');
    writeCache(4722, 3284, { future: true, past: true });
    let seo = loadSeo();
    let s = await serve(seo);
    let port = s.address().port;

    const index = await get(port, '/sitemap.xml');
    const kids = childSitemaps(index.body);
    const fetched = [];
    for (const k of kids) fetched.push([k, await get(port, k)]);

    ok('index advertises more than one media shard', () =>
      assert.ok(kids.filter((k) => k.startsWith('/sitemap-movies')).length > 1,
        'expected the movie catalogue to shard: ' + kids.join(', ')));
    ok('every advertised sitemap returns 200', () => {
      const bad = fetched.filter(([, r]) => r.status !== 200).map(([k]) => k);
      assert.deepStrictEqual(bad, [], 'non-200: ' + bad.join(', '));
    });
    ok('no advertised sitemap is empty (sitemap.xsd needs >= 1 <url>)', () => {
      const empty = fetched.filter(([, r]) => urlCount(r.body) === 0).map(([k]) => k);
      assert.deepStrictEqual(empty, [], 'empty urlset: ' + empty.join(', '));
    });
    ok('shard URLs are not duplicated across shards', () => {
      const seen = new Set(); const dupes = [];
      for (const [, r] of fetched) {
        for (const m of r.body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
          if (seen.has(m[1])) dupes.push(m[1]); else seen.add(m[1]);
        }
      }
      assert.deepStrictEqual(dupes.slice(0, 3), [], 'duplicated: ' + dupes.slice(0, 3).join(', '));
    });
    ok('every shard is served as XML', () => {
      const bad = fetched.filter(([, r]) => !/xml/.test(r.type || '')).map(([k]) => k);
      assert.deepStrictEqual(bad, [], 'not XML: ' + bad.join(', '));
    });

    // ── 3. a shard that was never advertised still 404s ──
    console.log('\n3. an unadvertised shard 404s');
    const beyond = await get(port, '/sitemap-movies-99.xml');
    const zero = await get(port, '/sitemap-movies-0.xml');
    ok('shard far beyond the count 404s', () => assert.strictEqual(beyond.status, 404));
    ok('shard 0 404s', () => assert.strictEqual(zero.status, 404));

    // ── 4. lastmod is never in the future ──
    console.log('\n4. lastmod is never in the future');
    const bodies = fetched.filter(([k]) => k.startsWith('/sitemap-movies')).map(([, r]) => r.body);
    const all = bodies.join('\n');
    ok('no lastmod ahead of today across every shard', () => {
      const dates = [...all.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
      assert.ok(dates.length > 0, 'expected lastmod values');
      const future = dates.filter((d) => d > TODAY);
      assert.strictEqual(future.length, 0, 'future dates: ' + future.slice(0, 3));
    });
    ok('the 2028 premiere was clamped to today', () => {
      const row = all.split('\n').find((l) => l.includes('/movie/999001'));
      assert.ok(row, 'future-dated entry missing from the shards');
      assert.match(row, new RegExp('<lastmod>' + TODAY + '</lastmod>'));
    });
    ok('a genuine past date is left alone', () => {
      const row = all.split('\n').find((l) => l.includes('/movie/999002'));
      assert.ok(row, 'past-dated entry missing from the shards');
      assert.match(row, /<lastmod>1999-01-02<\/lastmod>/);
    });
    await new Promise((r) => s.close(r));

    // ── 5. the whole catalogue is still covered once sharded ──
    console.log('\n5. sharding loses nothing');
    ok('shards together carry every catalogue entry', () => {
      const total = fetched
        .filter(([k]) => k.startsWith('/sitemap-movies'))
        .reduce((n, [, r]) => n + urlCount(r.body), 0);
      assert.strictEqual(total, 4722, 'expected 4722 movie URLs, got ' + total);
    });
  } finally {
    restore();
  }

  console.log(`\n${'='.repeat(56)}\n  sitemap-shard-check: ${pass} passed, ${fail} failed\n${'='.repeat(56)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  try { fs.copyFileSync(BACKUP, CACHE); } catch (_) {}
  console.error('harness error:', e);
  process.exit(1);
});
