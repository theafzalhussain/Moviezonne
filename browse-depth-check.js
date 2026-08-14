/*  browse-depth-check.js — guards the crawl depth of the A-Z browse hubs.
 *
 *  The hubs exist for one reason, stated at the top of seo-ssr.js: "any title is
 *  2 clicks from the homepage instead of sitting 25 pages deep in a prev/next
 *  chain." BROWSE_PER_PAGE = 120 quietly broke that for most of the catalogue —
 *  5,034 of 7,924 titles (63.5%) were on ?page=N sub-pages at depth 3, each with
 *  a single inbound link from a hub page that sitemap-browse.xml does not list.
 *  Search Console reported the result as 919 pages "Discovered - currently not
 *  indexed".
 *
 *  So the assertions are: every letter fits on one page for the catalogue we
 *  actually ship, every title in the cache is reachable from a letter root,
 *  nothing is duplicated or dropped by the bucketing, every URL that
 *  sitemap-browse.xml advertises answers 200 rather than 301, and the largest
 *  page stays inside a sane byte budget.
 *
 *  Unlike sitemap-shard-check.js this runs against the REAL sitemap-cache.json.
 *  Synthetic titles would all bucket into one letter and prove nothing about
 *  depth.
 *
 *  Run: node browse-depth-check.js
 */
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');

const ROOT = __dirname;
const seo = require(path.join(ROOT, 'seo-ssr.js'));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '\n      ' + e.message); fail++; }
};

/*  The largest letter page. 96 KB today for T's 1,043 titles; the ceiling leaves
 *  room to grow without silently turning a hub into a megabyte of anchors.
 */
const MAX_LETTER_PAGE_KB = 200;

function serve() {
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
      r.on('end', () => res({ status: r.statusCode, body: b, loc: r.headers.location }));
    }).on('error', rej);
  });
}

(async () => {
  const cache = seo.readSitemapCache();
  assert.ok(cache, 'sitemap-cache.json must be readable for this check to mean anything');

  const all = (cache.movie || []).concat(cache.tv || []);
  const titled = all.filter((e) => e && (e.title || e.name));
  const byLetter = new Map();
  for (const e of titled) {
    const l = seo.browseLetterOf(e.title || e.name);
    byLetter.set(l, (byLetter.get(l) || 0) + 1);
  }

  const s = await serve();
  const port = s.address().port;

  try {
    // ── 1. every letter is a single page ──
    console.log('\n1. every letter fits on one page for the catalogue we ship');
    const multi = [];
    for (const [l, n] of byLetter) if (n > seo.BROWSE_PER_PAGE) multi.push(l + '=' + n);
    ok(`no letter exceeds BROWSE_PER_PAGE (${seo.BROWSE_PER_PAGE})`, () =>
      assert.deepStrictEqual(multi, [], 'paginated letters: ' + multi.join(', ')));

    const biggest = [...byLetter.entries()].sort((a, b) => b[1] - a[1])[0];
    ok(`the largest letter (${biggest[0]}=${biggest[1]}) has headroom left`, () =>
      assert.ok(biggest[1] < seo.BROWSE_PER_PAGE * 0.9,
        `letter ${biggest[0]} is at ${biggest[1]} of ${seo.BROWSE_PER_PAGE} — raise the cap before it paginates`));

    // ── 2. no pager is rendered, so nothing sits at depth 3 ──
    console.log('\n2. no letter page renders a pager, so no title is at depth 3');
    const pages = new Map();
    for (const l of seo.BROWSE_LETTERS) pages.set(l, await get(port, '/browse/' + l));

    ok('every letter root returns 200', () => {
      const bad = [...pages.entries()].filter(([, r]) => r.status !== 200).map(([l, r]) => l + '=' + r.status);
      assert.deepStrictEqual(bad, [], 'non-200: ' + bad.join(', '));
    });
    ok('no letter page contains a ?page= link', () => {
      const withPager = [...pages.entries()]
        .filter(([, r]) => /href="[^"]*\?page=/.test(r.body)).map(([l]) => l);
      assert.deepStrictEqual(withPager, [], 'still paginated: ' + withPager.join(', '));
    });

    // ── 3. the bucketing loses nothing and duplicates nothing ──
    console.log('\n3. the letter pages together cover the whole catalogue exactly once');
    const seen = new Map();
    for (const [l, r] of pages) {
      for (const m of r.body.matchAll(/href="(\/(?:movie|tv)\/[^"]+)"/g)) {
        seen.set(m[1], (seen.get(m[1]) || 0) + 1);
      }
    }
    ok(`all ${titled.length} catalogue titles are linked from a letter root`, () =>
      assert.strictEqual(seen.size, titled.length,
        `cache has ${titled.length} titles, letter pages link ${seen.size}`));
    ok('no detail URL appears on more than one letter page', () => {
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([u]) => u);
      assert.deepStrictEqual(dupes.slice(0, 3), [], 'duplicated: ' + dupes.slice(0, 3).join(', '));
    });

    // ── 4. everything sitemap-browse.xml advertises answers 200 ──
    /*  This is the defect class that produced #7 and #8: a sitemap URL that
     *  redirects or 404s is reported by Search Console rather than forgotten.
     */
    console.log('\n4. every URL in sitemap-browse.xml answers 200, not 301');
    const sm = await get(port, '/sitemap-browse.xml');
    const locs = [...sm.body.matchAll(/<loc>https?:\/\/[^/]+([^<]+)<\/loc>/g)].map((m) => m[1]);
    const fetched = [];
    for (const l of locs) fetched.push([l, await get(port, l)]);

    ok('sitemap-browse.xml is not empty', () => assert.ok(locs.length > 0, 'no URLs'));
    ok(`all ${locs.length} advertised browse URLs return 200`, () => {
      const bad = fetched.filter(([, r]) => r.status !== 200)
        .map(([l, r]) => l + ' -> ' + r.status + (r.loc ? ' ' + r.loc : ''));
      assert.deepStrictEqual(bad, [], 'not 200: ' + bad.join(', '));
    });
    ok('no advertised browse URL carries a ?page= query', () => {
      const paged = locs.filter((l) => l.includes('?page='));
      assert.deepStrictEqual(paged, [], 'unstable paginated URLs submitted: ' + paged.join(', '));
    });
    ok('sitemap-browse.xml advertises one URL per letter', () =>
      assert.strictEqual(locs.length, seo.BROWSE_LETTERS.length,
        `expected ${seo.BROWSE_LETTERS.length}, got ${locs.length}`));

    // ── 5. an out-of-range page still redirects rather than 404ing ──
    console.log('\n5. a stale ?page=N still resolves instead of 404ing');
    const stale = await get(port, '/browse/t?page=2');
    ok('/browse/t?page=2 301s to the letter root', () => {
      assert.strictEqual(stale.status, 301);
      assert.strictEqual(stale.loc, '/browse/t');
    });

    // ── 6. page weight stays sane ──
    console.log('\n6. the largest letter page stays inside its byte budget');
    const sizes = [...pages.entries()]
      .map(([l, r]) => [l, Buffer.byteLength(r.body) / 1024])
      .sort((a, b) => b[1] - a[1]);
    ok(`largest page (${sizes[0][0]}) is ${sizes[0][1].toFixed(1)} KB, under ${MAX_LETTER_PAGE_KB} KB`, () =>
      assert.ok(sizes[0][1] < MAX_LETTER_PAGE_KB,
        `${sizes[0][0]} is ${sizes[0][1].toFixed(1)} KB`));

    console.log('\n   depth summary: ' + seen.size + ' titles at depth 2 (home -> /browse/x -> detail), 0 at depth 3');
  } finally {
    await new Promise((r) => s.close(r));
  }

  console.log(`\n${'='.repeat(56)}\n  browse-depth-check: ${pass} passed, ${fail} failed\n${'='.repeat(56)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
