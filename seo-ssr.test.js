'use strict';

/*  Tests for seo-ssr.js — the server-rendered SEO surface.
 *  Run: node seo-ssr.test.js
 *
 *  Covers the things that silently destroy SEO or security if wrong:
 *   • every page has a unique, non-empty title + meta description
 *   • TMDB text cannot break out of HTML or a JSON-LD <script> block
 *   • slug ↔ id parsing rejects junk before it reaches the TMDB proxy
 *   • canonical URLs are absolute and self-consistent
 *   • routes 404/redirect instead of rendering a broken page
 */

const assert = require('assert');
const http = require('http');
const express = require('express');

const seo = require('./seo-ssr');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

function section(title) {
  console.log('\n' + title);
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const MOVIE = {
  id: 550,
  title: 'Fight Club',
  original_title: 'Fight Club',
  overview: 'A ticking-time-bomb insomniac and a slippery soap salesman channel primal male aggression into a shocking new form of therapy.',
  tagline: 'Mischief. Mayhem. Soap.',
  release_date: '1999-10-15',
  runtime: 139,
  vote_average: 8.438,
  vote_count: 29500,
  original_language: 'en',
  status: 'Released',
  budget: 63000000,
  revenue: 100853753,
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  genres: [{ id: 18, name: 'Drama' }, { id: 53, name: 'Thriller' }],
  spoken_languages: [{ iso_639_1: 'en', english_name: 'English' }],
  production_countries: [{ name: 'United States of America' }],
  production_companies: [{ name: 'Fox 2000 Pictures' }],
  credits: {
    cast: [
      { name: 'Brad Pitt', character: 'Tyler Durden', profile_path: '/bp.jpg' },
      { name: 'Edward Norton', character: 'The Narrator', profile_path: null }
    ],
    crew: [
      { job: 'Director', name: 'David Fincher' },
      { job: 'Screenplay', name: 'Jim Uhls' }
    ]
  },
  similar: { results: [{ id: 807, title: 'Se7en', poster_path: '/s7.jpg', release_date: '1995-09-22', vote_average: 8.4 }] },
  recommendations: { results: [{ id: 680, title: 'Pulp Fiction', poster_path: '/pf.jpg', release_date: '1994-09-10', vote_average: 8.5 }] }
};

const SERIES = {
  id: 1396,
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  overview: 'A high school chemistry teacher diagnosed with cancer turns to manufacturing drugs to secure his family future.',
  first_air_date: '2008-01-20',
  last_air_date: '2013-09-29',
  episode_run_time: [47],
  number_of_seasons: 5,
  number_of_episodes: 62,
  vote_average: 8.9,
  vote_count: 14200,
  original_language: 'en',
  status: 'Ended',
  poster_path: '/bb.jpg',
  backdrop_path: '/bbbg.jpg',
  genres: [{ id: 18, name: 'Drama' }, { id: 80, name: 'Crime' }],
  networks: [{ name: 'AMC' }],
  created_by: [{ name: 'Vince Gilligan' }],
  credits: { cast: [{ name: 'Bryan Cranston', character: 'Walter White', profile_path: '/bc.jpg' }], crew: [] },
  similar: { results: [] },
  recommendations: { results: [] }
};

// A payload engineered to break naive templating.
const HOSTILE = {
  id: 999,
  title: '<script>alert("xss")</script> & "Quoted" \u2019Title',
  overview: 'Ends a script block: </script><img src=x onerror=alert(1)> and has <b>tags</b> & ampersands.',
  tagline: '"><svg/onload=alert(2)>',
  release_date: '2024-01-01',
  runtime: 100,
  vote_average: 5,
  vote_count: 10,
  original_language: 'en',
  poster_path: '/h.jpg',
  genres: [{ id: 28, name: 'Action' }],
  credits: { cast: [{ name: '</script><b>Evil</b>', character: '"onmouseover="x', profile_path: null }], crew: [] },
  similar: { results: [] },
  recommendations: { results: [] }
};

const DISCOVER_RESULTS = [
  { id: 1, title: 'Alpha One', poster_path: '/a.jpg', release_date: '2024-03-01', vote_average: 7.2, genre_ids: [28] },
  { id: 2, title: 'Beta Two', poster_path: '/b.jpg', release_date: '2023-05-11', vote_average: 6.4, genre_ids: [35] },
  { id: 3, name: 'Gamma Show', poster_path: '/g.jpg', first_air_date: '2022-08-08', vote_average: 8.1, genre_ids: [18] }
];

// ── Helpers ──────────────────────────────────────────────────────────────

function metaContent(html, nameOrProp) {
  const re = new RegExp('<meta\\s+(?:name|property)="' + nameOrProp + '"\\s+content="([^"]*)"', 'i');
  const m = re.exec(html);
  return m ? m[1] : null;
}

function tagText(html, tag) {
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(html);
  return m ? m[1] : null;
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// ══════════════════════════════════════════════════════════════════════
section('escaping + helpers');
// ══════════════════════════════════════════════════════════════════════

test('esc() neutralises all five HTML-significant characters', () => {
  assert.strictEqual(seo.esc('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('esc() renders null/undefined as empty string, not "null"', () => {
  assert.strictEqual(seo.esc(null), '');
  assert.strictEqual(seo.esc(undefined), '');
});

test('jsonLdScript() escapes < > & so a payload cannot close the script tag', () => {
  const out = seo.jsonLdScript({ name: '</script><img src=x onerror=alert(1)>' });
  assert.ok(!out.includes('</script>'), 'raw </script> leaked into JSON-LD');
  assert.ok(!out.includes('<'), 'raw < leaked into JSON-LD');
  assert.ok(out.includes('\\u003c'), 'expected unicode-escaped <');
});

test('jsonLdScript() output still parses back to the original string', () => {
  const original = '</script>Tricky & <b>bold</b>';
  const parsed = JSON.parse(seo.jsonLdScript({ name: original }));
  assert.strictEqual(parsed.name, original);
});

test('jsonLdScript() drops empty values so no null fields ship to Google', () => {
  const parsed = JSON.parse(seo.jsonLdScript({ a: 'keep', b: null, c: '', d: [], e: undefined }));
  assert.deepStrictEqual(Object.keys(parsed), ['a']);
});

test('escXml() escapes the five XML entities', () => {
  assert.strictEqual(seo.escXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
});

test('slugify() lowercases, folds diacritics and strips punctuation', () => {
  assert.strictEqual(seo.slugify('Fight Club'), 'fight-club');
  assert.strictEqual(seo.slugify('Amélie'), 'amelie');
  assert.strictEqual(seo.slugify("Don't Look Up!"), 'dont-look-up');
  assert.strictEqual(seo.slugify('Fast & Furious'), 'fast-and-furious');
  assert.strictEqual(seo.slugify('  ---  '), '');
});

test('slugify() never emits a trailing hyphen even when truncating', () => {
  const slug = seo.slugify('a'.repeat(60) + ' ' + 'b'.repeat(60));
  assert.ok(slug.length <= 80);
  assert.ok(!slug.endsWith('-'), 'slug ended with a hyphen: ' + slug);
});

test('parseIdSlug() accepts an id with and without a slug', () => {
  assert.deepStrictEqual(seo.parseIdSlug('550-fight-club'), { id: '550', slug: 'fight-club' });
  assert.deepStrictEqual(seo.parseIdSlug('550'), { id: '550', slug: '' });
});

test('parseIdSlug() rejects junk, traversal and injection attempts', () => {
  ['', 'abc', '0-zero', '-5', '../../etc/passwd', '550;DROP TABLE', '1e5', '550 fight',
    '<script>', '9999999999999'].forEach((bad) => {
    assert.strictEqual(seo.parseIdSlug(bad), null, 'should reject: ' + JSON.stringify(bad));
  });
});

test('truncate() keeps within budget and does not split a word', () => {
  const out = seo.truncate('the quick brown fox jumps over the lazy dog', 20);
  assert.ok(out.length <= 20, 'too long: ' + out.length);
  assert.ok(!/\bfo$|\bqui$/.test(out), 'word was cut mid-way: ' + out);
});

test('truncate() leaves short text untouched (no stray ellipsis)', () => {
  assert.strictEqual(seo.truncate('short text', 50), 'short text');
});

test('isoDuration() emits schema.org durations, and nothing for bad input', () => {
  assert.strictEqual(seo.isoDuration(139), 'PT2H19M');
  assert.strictEqual(seo.isoDuration(60), 'PT1H');
  assert.strictEqual(seo.isoDuration(47), 'PT47M');
  assert.strictEqual(seo.isoDuration(0), '');
  assert.strictEqual(seo.isoDuration(null), '');
});

test('detailPath() builds the canonical id-slug path per media kind', () => {
  assert.strictEqual(seo.detailPath('movie', MOVIE), '/movie/550-fight-club');
  assert.strictEqual(seo.detailPath('tv', SERIES), '/tv/1396-breaking-bad');
});

test('resolveKind() trusts an explicit media_type above everything else', () => {
  assert.strictEqual(seo.resolveKind({ media_type: 'tv', release_date: '2020-01-01' }, 'movie'), 'tv');
  assert.strictEqual(seo.resolveKind({ media_type: 'movie', first_air_date: '2020-01-01' }, 'tv'), 'movie');
});

test('resolveKind() prefers the item field shape over the page default', () => {
  // A mixed endpoint on a movie page must still emit /tv/ links, otherwise
  // the URL 404s or redirects to an unrelated title.
  assert.strictEqual(seo.resolveKind({ first_air_date: '2022-08-08', name: 'Show' }, 'movie'), 'tv');
  assert.strictEqual(seo.resolveKind({ release_date: '2022-08-08', title: 'Film' }, 'tv'), 'movie');
  assert.strictEqual(seo.resolveKind({ name: 'Nameless Show' }, 'movie'), 'tv');
});

test('resolveKind() falls back to the page default when nothing is decisive', () => {
  assert.strictEqual(seo.resolveKind({ title: 'X', name: 'X' }, 'tv'), 'tv');
  assert.strictEqual(seo.resolveKind({}, 'movie'), 'movie');
  assert.strictEqual(seo.resolveKind(null, 'tv'), 'tv');
});

// ══════════════════════════════════════════════════════════════════════
section('descriptions — every page must have one');
// ══════════════════════════════════════════════════════════════════════

test('detail description is non-empty and within Google\'s snippet budget', () => {
  [[MOVIE, 'movie'], [SERIES, 'tv'], [HOSTILE, 'movie']].forEach(([item, kind]) => {
    const d = seo.buildDetailDescription(item, kind);
    assert.ok(d.length > 40, 'too short for ' + item.id + ': ' + d);
    assert.ok(d.length <= 160, 'too long for ' + item.id + ': ' + d.length);
  });
});

test('detail description falls back to generated copy when TMDB has no overview', () => {
  const bare = { id: 7, title: 'Untitled Project', release_date: '2026-02-01', original_language: 'hi', vote_average: 0 };
  const d = seo.buildDetailDescription(bare, 'movie');
  assert.ok(d.length > 40, 'fallback description was not generated: ' + d);
  assert.ok(d.includes('Untitled Project'), 'fallback omitted the title');
  assert.ok(/hindi/i.test(d), 'fallback omitted the language');
});

test('detail description survives a completely empty payload', () => {
  const d = seo.buildDetailDescription({ id: 1 }, 'movie');
  assert.strictEqual(typeof d, 'string');
  assert.ok(d.length > 0, 'empty description for empty payload');
});

test('detail titles are unique per title and mention the media kind', () => {
  const a = seo.buildDetailTitle(MOVIE, 'movie');
  const b = seo.buildDetailTitle(SERIES, 'tv');
  assert.notStrictEqual(a, b);
  assert.ok(a.includes('Fight Club') && /Movie/.test(a), a);
  assert.ok(b.includes('Breaking Bad') && /Web Series/.test(b), b);
});

test('about paragraph is real prose, not a stub', () => {
  const p = seo.buildAboutParagraph(MOVIE, 'movie', ['Drama', 'Thriller'], 'English', 139);
  assert.ok(p.length > 120, 'about paragraph too thin: ' + p);
  assert.ok(p.includes('Fight Club'));
  assert.ok(p.includes('2h 19m'), 'runtime missing from about paragraph');
});

test('about paragraph reports seasons/episodes for a series', () => {
  const p = seo.buildAboutParagraph(SERIES, 'tv', ['Drama'], 'English', 47);
  assert.ok(/5 seasons/.test(p), p);
  assert.ok(/62 episodes/.test(p), p);
});

test('every category ships a unique, substantial description', () => {
  const seen = new Map();
  Object.keys(seo.CATEGORIES).forEach((slug) => {
    const c = seo.CATEGORIES[slug];
    assert.ok(c.description && c.description.length > 80, slug + ' description too short');
    assert.ok(c.title && c.title.length > 20, slug + ' title too short');
    assert.ok(c.intro && c.intro.length > 80, slug + ' intro too short');
    assert.ok(!seen.has(c.description), 'duplicate description: ' + slug + ' vs ' + seen.get(c.description));
    seen.set(c.description, slug);
  });
});

test('every category title is unique', () => {
  const titles = Object.keys(seo.CATEGORIES).map((s) => seo.CATEGORIES[s].title);
  assert.strictEqual(new Set(titles).size, titles.length, 'duplicate category <title> found');
});

test('category slugs resolve to their declared family path', () => {
  seo.MOVIE_CATEGORY_SLUGS.forEach((s) => assert.ok(seo.categoryPath(s).startsWith('/movies/'), s));
  seo.SERIES_CATEGORY_SLUGS.forEach((s) => assert.ok(seo.categoryPath(s).startsWith('/series/'), s));
  assert.strictEqual(seo.categoryPath('does-not-exist'), null);
});

// ══════════════════════════════════════════════════════════════════════
section('detail page rendering');
// ══════════════════════════════════════════════════════════════════════

const movieHtml = seo.renderDetailPage(MOVIE, 'movie');
const seriesHtml = seo.renderDetailPage(SERIES, 'tv');
const hostileHtml = seo.renderDetailPage(HOSTILE, 'movie');

test('renders a complete HTML document', () => {
  assert.ok(movieHtml.startsWith('<!DOCTYPE html>'));
  assert.ok(movieHtml.includes('<html lang="en">'));
  assert.ok(movieHtml.trimEnd().endsWith('</html>'));
});

test('has exactly one <h1> and one <title>', () => {
  assert.strictEqual((movieHtml.match(/<h1[\s>]/g) || []).length, 1);
  assert.strictEqual((movieHtml.match(/<title>/g) || []).length, 1);
});

test('title and description tags are populated', () => {
  assert.ok(tagText(movieHtml, 'title').includes('Fight Club'));
  const desc = metaContent(movieHtml, 'description');
  assert.ok(desc && desc.length > 40, 'missing/short meta description');
});

test('canonical, og:url and og:image are absolute URLs', () => {
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(movieHtml)[1];
  assert.strictEqual(canonical, seo.SITE_URL + '/movie/550-fight-club');
  assert.strictEqual(metaContent(movieHtml, 'og:url'), canonical);
  assert.ok(/^https:\/\//.test(metaContent(movieHtml, 'og:image')));
});

test('robots meta allows indexing', () => {
  assert.ok(/index/.test(metaContent(movieHtml, 'robots')));
  assert.ok(!/noindex/.test(metaContent(movieHtml, 'robots')));
});

test('emits Movie schema with aggregateRating, director and duration', () => {
  const blocks = jsonLdBlocks(movieHtml).map((b) => JSON.parse(b));
  const movie = blocks.find((b) => b['@type'] === 'Movie');
  assert.ok(movie, 'no Movie schema emitted');
  assert.strictEqual(movie.name, 'Fight Club');
  assert.strictEqual(movie.aggregateRating.ratingValue, '8.4');
  assert.strictEqual(movie.aggregateRating.ratingCount, 29500);
  assert.strictEqual(movie.duration, 'PT2H19M');
  assert.strictEqual(movie.director[0].name, 'David Fincher');
  assert.ok(movie.actor.length >= 2);
});

test('emits TVSeries schema with season and episode counts', () => {
  const blocks = jsonLdBlocks(seriesHtml).map((b) => JSON.parse(b));
  const tv = blocks.find((b) => b['@type'] === 'TVSeries');
  assert.ok(tv, 'no TVSeries schema emitted');
  assert.strictEqual(tv.numberOfSeasons, 5);
  assert.strictEqual(tv.numberOfEpisodes, 62);
  assert.strictEqual(tv.creator[0].name, 'Vince Gilligan');
  assert.ok(!('duration' in tv), 'duration should be omitted for a series');
});

test('emits BreadcrumbList with absolute item URLs', () => {
  const crumbs = jsonLdBlocks(movieHtml).map((b) => JSON.parse(b))
    .find((b) => b['@type'] === 'BreadcrumbList');
  assert.ok(crumbs, 'no BreadcrumbList emitted');
  assert.strictEqual(crumbs.itemListElement[0].position, 1);
  assert.ok(crumbs.itemListElement[0].item.startsWith('https://'));
  const last = crumbs.itemListElement[crumbs.itemListElement.length - 1];
  assert.ok(!last.item, 'the current page should not be a link');
});

test('every JSON-LD block is valid JSON', () => {
  [movieHtml, seriesHtml, hostileHtml].forEach((html, i) => {
    const blocks = jsonLdBlocks(html);
    assert.ok(blocks.length >= 2, 'expected schema blocks on document ' + i);
    blocks.forEach((b) => assert.doesNotThrow(() => JSON.parse(b), 'invalid JSON-LD on document ' + i));
  });
});

test('links to related titles, giving crawlers a path deeper into the catalogue', () => {
  assert.ok(movieHtml.includes('/movie/807-se7en'), 'similar title link missing');
  assert.ok(movieHtml.includes('/movie/680-pulp-fiction'), 'recommended title link missing');
});

test('links to category pages from genre chips and the browse rail', () => {
  assert.ok(movieHtml.includes('/movies/thriller'), 'genre chip did not link to its category');
  assert.ok(movieHtml.includes('/movies/action'), 'browse rail missing');
  assert.ok(seriesHtml.includes('/series/anime'), 'series browse rail missing');
});

test('cast section renders names and characters', () => {
  assert.ok(movieHtml.includes('Brad Pitt'));
  assert.ok(movieHtml.includes('Tyler Durden'));
});

test('falls back to an initial when a cast member has no photo', () => {
  assert.ok(movieHtml.includes('Edward Norton'));
  assert.ok(/aspect-ratio:2\/3;display:flex/.test(movieHtml), 'no placeholder for missing profile image');
});

test('renders a synopsis sentence even with no TMDB overview', () => {
  const bare = Object.assign({}, MOVIE, { overview: '' });
  const html = seo.renderDetailPage(bare, 'movie');
  const synopsis = /<p class="synopsis">([\s\S]*?)<\/p>/.exec(html)[1];
  assert.ok(synopsis.trim().length > 60, 'synopsis fallback missing: ' + synopsis);
});

// ── XSS ──
test('hostile title is escaped in the document body', () => {
  assert.ok(!/<script>alert\("xss"\)<\/script>/.test(hostileHtml), 'raw <script> from title survived');
  assert.ok(hostileHtml.includes('&lt;script&gt;alert('), 'title was not HTML-escaped');
});

test('hostile overview cannot form an HTML tag anywhere in the document', () => {
  // The page legitimately contains its own <img> tags (poster, backdrop, logo),
  // so a bare "<img" check proves nothing. What must hold is:
  //   1. the exact tag shape from the payload never appears, and
  //   2. no event-handler attribute exists in the markup at all — the SSR
  //      templates emit zero inline handlers, so any on*= is an injection.
  // JSON-LD blocks are excluded because escaped payload text lives there
  // inertly (verified separately by the angle-bracket test below).
  const markup = hostileHtml.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/g, ''
  );

  // Only inspect real tags. Escaped payload text starts with "&lt;", so it is
  // never captured here — which is precisely the property under test.
  const realTags = markup.match(/<[a-z][^>]*>/gi) || [];

  // Strip quoted attribute VALUES before looking for handler attribute NAMES.
  // Escaped payload text legitimately sits inside content="…" on the meta
  // description tags; that is inert, and flagging it would be a false positive.
  const withHandler = realTags.filter((tag) => {
    const namesOnly = tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    return /\son[a-z]+\s*=/i.test(namesOnly);
  });

  assert.deepStrictEqual(withHandler, [],
    'event-handler attribute found in real markup: ' + withHandler.join(' | '));
  assert.ok(!realTags.some((t) => /^<img\s+src=x/i.test(t)), 'the payload\'s <img src=x> tag survived');
  assert.ok(!realTags.some((t) => /^<svg\b/i.test(t)), 'unescaped <svg> survived');
  assert.ok(!/<b>tags<\/b>/i.test(markup), 'unescaped <b> from the overview survived');
  assert.ok(hostileHtml.includes('&lt;img src=x onerror=alert(1)&gt;'),
    'overview should appear HTML-escaped in the rendered body');
});

test('every attribute value in the document is properly quoted and closed', () => {
  // An unterminated attribute is the other way an injection escapes: it would
  // leave a stray odd number of quotes inside a tag.
  const realTags = hostileHtml.match(/<[a-z][^>]*>/gi) || [];
  realTags.forEach((tag) => {
    const quotes = (tag.match(/"/g) || []).length;
    assert.strictEqual(quotes % 2, 0, 'unbalanced quotes in tag: ' + tag.slice(0, 120));
  });
});

test('JSON-LD escapes angle brackets so payload text stays inert', () => {
  jsonLdBlocks(hostileHtml).forEach((block, i) => {
    assert.ok(!block.includes('<'), 'raw < inside JSON-LD block ' + i);
    assert.ok(!block.includes('>'), 'raw > inside JSON-LD block ' + i);
  });
  // …and the escaped form must still round-trip to the original text.
  const movieSchema = jsonLdBlocks(hostileHtml).map((b) => JSON.parse(b))
    .find((b) => b['@type'] === 'Movie');
  assert.ok(movieSchema.description.includes('<img src=x onerror=alert(1)>'),
    'JSON-LD lost the original description text');
});

test('the only <script> tags in the document are the JSON-LD blocks we emitted', () => {
  const scripts = hostileHtml.match(/<script\b[^>]*>/gi) || [];
  scripts.forEach((tag) => {
    assert.strictEqual(tag, '<script type="application/ld+json">',
      'unexpected script tag rendered: ' + tag);
  });
});

test('hostile tagline cannot break out of its attribute or element', () => {
  assert.ok(!/<svg\/onload/.test(hostileHtml), 'unescaped <svg onload> survived');
});

test('hostile cast values are escaped', () => {
  assert.ok(!/<b>Evil<\/b>/.test(hostileHtml), 'unescaped cast markup survived');
});

test('no JSON-LD block is terminated early by hostile content', () => {
  // Count opening and closing script tags: a breakout produces a mismatch.
  const opens = (hostileHtml.match(/<script type="application\/ld\+json">/g) || []).length;
  const closes = (hostileHtml.match(/<\/script>/g) || []).length;
  assert.strictEqual(opens, closes, 'script tag imbalance implies a JSON-LD breakout');
});

test('meta description attribute is never broken by a quote in the data', () => {
  const desc = metaContent(hostileHtml, 'description');
  assert.ok(desc !== null, 'meta description could not be parsed — attribute likely broken');
  assert.ok(!desc.includes('"'), 'raw double quote inside the attribute value');
});

// ══════════════════════════════════════════════════════════════════════
section('category page rendering');
// ══════════════════════════════════════════════════════════════════════

const catHtml = seo.renderCategoryPage('action', seo.CATEGORIES.action, DISCOVER_RESULTS, 1, 5);
const catPage3 = seo.renderCategoryPage('action', seo.CATEGORIES.action, DISCOVER_RESULTS, 3, 5);

test('renders heading, description and intro copy', () => {
  assert.ok(catHtml.includes('<h1>Action Movies</h1>'));
  assert.strictEqual(metaContent(catHtml, 'description'), seo.esc(seo.CATEGORIES.action.description));
  assert.ok(catHtml.includes(seo.esc(seo.CATEGORIES.action.intro.slice(0, 40))), 'intro copy missing');
});

test('grid links out to detail pages with correct kind per item', () => {
  assert.ok(catHtml.includes('/movie/1-alpha-one'));
  assert.ok(catHtml.includes('/movie/2-beta-two'));
  assert.ok(catHtml.includes('/tv/3-gamma-show'), 'item with only first_air_date should route to /tv/');
});

test('emits CollectionPage and ItemList schema', () => {
  const types = jsonLdBlocks(catHtml).map((b) => JSON.parse(b)['@type']);
  assert.ok(types.includes('CollectionPage'), types.join(','));
  assert.ok(types.includes('ItemList'), types.join(','));
});

test('ItemList URLs match the links actually rendered in the grid', () => {
  const list = jsonLdBlocks(catHtml).map((b) => JSON.parse(b)).find((b) => b['@type'] === 'ItemList');
  list.itemListElement.forEach((entry) => {
    const relative = entry.url.replace(seo.SITE_URL, '');
    assert.ok(catHtml.includes('href="' + relative + '"'),
      'schema advertises ' + relative + ' but the grid does not link to it');
  });
  // The mixed-kind item must be /tv/ in the schema too, not /movie/.
  assert.ok(list.itemListElement.some((e) => e.url.endsWith('/tv/3-gamma-show')),
    'series item was mislabelled as a movie in the schema');
});

test('ItemList positions continue across pages', () => {
  const list = jsonLdBlocks(catPage3).map((b) => JSON.parse(b)).find((b) => b['@type'] === 'ItemList');
  assert.strictEqual(list.itemListElement[0].position, 41, 'page 3 should start at position 41');
});

test('page 1 canonical has no query string; page 3 canonical keeps it', () => {
  assert.ok(catHtml.includes('href="' + seo.SITE_URL + '/movies/action"'));
  assert.ok(catPage3.includes('href="' + seo.SITE_URL + '/movies/action?page=3"'));
});

test('paginated pages get their own description so they are not duplicates', () => {
  assert.notStrictEqual(metaContent(catPage3, 'description'), metaContent(catHtml, 'description'));
  assert.ok(/Page 3/.test(metaContent(catPage3, 'description')));
});

test('pagination exposes prev and next links', () => {
  assert.ok(catPage3.includes('rel="prev"'));
  assert.ok(catPage3.includes('rel="next"'));
  assert.ok(!catHtml.includes('rel="prev"'), 'page 1 must not advertise a previous page');
});

test('renders a graceful empty state instead of a blank grid', () => {
  const empty = seo.renderCategoryPage('action', seo.CATEGORIES.action, [], 1, 1);
  assert.ok(empty.includes('class="empty"'), 'no empty-state block');
  assert.ok(metaContent(empty, 'description').length > 40, 'empty page still needs a description');
});

test('every category renders without throwing and yields a unique title', () => {
  const titles = new Set();
  Object.keys(seo.CATEGORIES).forEach((slug) => {
    const html = seo.renderCategoryPage(slug, seo.CATEGORIES[slug], DISCOVER_RESULTS, 1, 2);
    const t = tagText(html, 'title');
    assert.ok(t && t.length > 10, slug + ' produced no <title>');
    assert.ok(!titles.has(t), 'duplicate rendered <title> for ' + slug);
    titles.add(t);
    assert.ok(metaContent(html, 'description').length > 40, slug + ' produced a thin description');
  });
});

// ══════════════════════════════════════════════════════════════════════
section('sitemaps');
// ══════════════════════════════════════════════════════════════════════

test('every rendered page carries the verbatim TMDB attribution notice', () => {
  // TMDB's API Terms of Use mandate this exact sentence. Paraphrasing it is a
  // terms breach, so the wording is asserted rather than trusted to review.
  const REQUIRED = /This product uses the\s+(?:<[^>]+>\s*)?TMDb API\s*(?:<\/[^>]+>\s*)?but is not endorsed or certified by TMDb\./;
  const pages = [
    ['movie detail', movieHtml],
    ['series detail', seriesHtml],
    ['category', catHtml],
    ['category page 3', catPage3]
  ];
  pages.forEach(([label, html]) => {
    const collapsed = html.replace(/\s+/g, ' ');
    assert.ok(REQUIRED.test(collapsed), 'TMDB attribution notice missing/reworded on the ' + label + ' page');
  });
});

test('the SPA homepage carries the verbatim TMDB attribution notice', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, 'index.html'), 'utf8')
    .replace(/\s+/g, ' ');
  assert.ok(/This product uses the .*TMDb API.* but is not endorsed or certified by TMDb\./.test(html),
    'index.html is missing the required TMDB attribution notice');
  assert.ok(!/Powered by <a[^>]*>TMDB API<\/a>/.test(html),
    'the old non-compliant "Powered by TMDB API" wording is still present');
});

test('sitemap index lists the three child sitemaps', () => {
  const xml = seo.buildSitemapIndex();
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<sitemapindex'));
  ['/sitemap-static.xml', '/sitemap-movies.xml', '/sitemap-tv.xml']
    .forEach((c) => assert.ok(xml.includes(seo.SITE_URL + c), 'missing child: ' + c));
});

test('static sitemap includes the homepage and every category page', () => {
  const xml = seo.buildStaticSitemap();
  assert.ok(xml.includes('<loc>' + seo.SITE_URL + '/</loc>'));
  Object.keys(seo.CATEGORIES).forEach((slug) => {
    assert.ok(xml.includes(seo.SITE_URL + seo.categoryPath(slug)), 'missing category: ' + slug);
  });
});

test('media sitemap emits one canonical URL per title', () => {
  const xml = seo.buildMediaSitemap([MOVIE, SERIES], 'movie');
  assert.strictEqual((xml.match(/<url>/g) || []).length, 2);
  assert.ok(xml.includes('/movie/550-fight-club'));
});

test('media sitemap skips entries with no usable title', () => {
  const xml = seo.buildMediaSitemap([MOVIE, { id: 42 }], 'movie');
  assert.strictEqual((xml.match(/<url>/g) || []).length, 1);
});

test('sitemap XML escapes ampersands in generated URLs', () => {
  const xml = seo.buildMediaSitemap([{ id: 5, title: 'Fast & Furious' }], 'movie');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'unescaped ampersand in sitemap XML');
  assert.ok(xml.includes('fast-and-furious'));
});

test('collectSitemapItems dedupes across endpoints and tolerates failures', async () => {
  const calls = [];
  const fakeTmdb = async (endpoint, params) => {
    calls.push(endpoint);
    if (endpoint.includes('top_rated')) throw new Error('upstream down');
    return { results: [{ id: 11, title: 'Shared Title', poster_path: '/x.jpg' }] };
  };
  const items = await seo.collectSitemapItems(fakeTmdb, 'movie', 1);
  assert.ok(calls.length >= 3, 'expected several endpoints to be probed');
  const ids = items.map((i) => i.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids survived');
  assert.ok(ids.includes(11), 'successful endpoint contributed nothing');
});

// ══════════════════════════════════════════════════════════════════════
section('route integration');
// ══════════════════════════════════════════════════════════════════════

function buildTestApp() {
  const app = express();
  const store = new Map();
  const cache = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };

  const tmdb = async (endpoint) => {
    if (endpoint === '/movie/550') return MOVIE;
    if (endpoint === '/tv/1396') return SERIES;
    if (endpoint === '/movie/404404') {
      const err = new Error('TMDB responded 404');
      err.tmdbStatus = 404;
      throw err;
    }
    if (endpoint === '/movie/500500') throw new Error('network exploded');
    return { results: DISCOVER_RESULTS, total_pages: 5 };
  };

  seo.registerSeoRoutes(app, { tmdb, cache });
  app.use((req, res) => res.status(404).send('not found'));
  return app;
}

function request(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body
      }));
    }).on('error', reject);
  });
}

(async () => {
  const app = buildTestApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  await testAsync('GET /movie/550-fight-club returns 200 HTML with schema', async () => {
    const r = await request(server, '/movie/550-fight-club');
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/html/.test(r.headers['content-type']));
    assert.ok(r.body.includes('Fight Club'));
    assert.ok(r.body.includes('"@type":"Movie"'));
  });

  await testAsync('detail response is cacheable by the CDN', async () => {
    const r = await request(server, '/movie/550-fight-club');
    assert.ok(/s-maxage=\d+/.test(r.headers['cache-control']), r.headers['cache-control']);
  });

  await testAsync('GET /movie/550 redirects 301 to the canonical slug', async () => {
    const r = await request(server, '/movie/550');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.headers.location, '/movie/550-fight-club');
  });

  await testAsync('a wrong slug redirects 301 rather than serving a duplicate', async () => {
    const r = await request(server, '/movie/550-wrong-slug-here');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.headers.location, '/movie/550-fight-club');
  });

  await testAsync('GET /tv/1396-breaking-bad returns TVSeries schema', async () => {
    const r = await request(server, '/tv/1396-breaking-bad');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('"@type":"TVSeries"'));
  });

  await testAsync('an unknown TMDB id falls through to 404, not a broken page', async () => {
    const r = await request(server, '/movie/404404-ghost');
    assert.strictEqual(r.status, 404);
  });

  await testAsync('a malformed id never reaches the proxy and 404s', async () => {
    for (const bad of ['/movie/not-a-number', '/movie/0-zero', '/tv/abc']) {
      const r = await request(server, bad);
      assert.strictEqual(r.status, 404, bad + ' should 404');
    }
  });

  await testAsync('GET /movies/action returns 200 with CollectionPage schema', async () => {
    const r = await request(server, '/movies/action');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Action Movies'));
    assert.ok(r.body.includes('"@type":"CollectionPage"'));
  });

  await testAsync('GET /series/anime returns 200 and links to detail pages', async () => {
    const r = await request(server, '/series/anime');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('/tv/3-gamma-show'));
  });

  await testAsync('a movie slug is rejected on the series route and vice versa', async () => {
    assert.strictEqual((await request(server, '/series/action')).status, 404);
    assert.strictEqual((await request(server, '/movies/anime')).status, 404);
  });

  await testAsync('an unknown category 404s instead of rendering an empty shell', async () => {
    assert.strictEqual((await request(server, '/movies/not-a-category')).status, 404);
  });

  await testAsync('?page=2 renders page 2 with its own canonical', async () => {
    const r = await request(server, '/movies/action?page=2');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('/movies/action?page=2"'), 'canonical did not include the page');
  });

  await testAsync('a hostile page parameter is clamped, not trusted', async () => {
    for (const q of ['?page=0', '?page=-5', '?page=abc', '?page=99999']) {
      const r = await request(server, '/movies/action' + q);
      assert.strictEqual(r.status, 200, q + ' should still render');
      assert.ok(!/page=(0|-5|abc|99999)"/.test(r.body), 'unclamped page leaked into markup for ' + q);
    }
  });

  await testAsync('/movies and /series redirect to a default category', async () => {
    assert.strictEqual((await request(server, '/movies')).headers.location, '/movies/popular');
    assert.strictEqual((await request(server, '/series')).headers.location, '/series/web-series');
  });

  await testAsync('GET /sitemap.xml serves the index as XML', async () => {
    const r = await request(server, '/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.ok(/application\/xml/.test(r.headers['content-type']));
    assert.ok(r.body.includes('<sitemapindex'));
  });

  await testAsync('child sitemaps serve valid XML with URLs', async () => {
    for (const p of ['/sitemap-static.xml', '/sitemap-movies.xml', '/sitemap-tv.xml']) {
      const r = await request(server, p);
      assert.strictEqual(r.status, 200, p);
      assert.ok(r.body.startsWith('<?xml'), p + ' is not XML');
      assert.ok(r.body.includes('<urlset'), p + ' has no urlset');
      assert.ok((r.body.match(/<loc>/g) || []).length > 0, p + ' contains no URLs');
    }
  });

  await testAsync('a category still renders when TMDB is unavailable', async () => {
    const failingApp = express();
    seo.registerSeoRoutes(failingApp, {
      tmdb: async () => { throw new Error('TMDB down'); },
      cache: null
    });
    failingApp.use((req, res) => res.status(404).send('nf'));
    const s2 = await new Promise((resolve) => {
      const x = failingApp.listen(0, '127.0.0.1', () => resolve(x));
    });
    const r = await request(s2, '/movies/action');
    assert.strictEqual(r.status, 200, 'should degrade to an empty page, not 5xx');
    assert.ok(metaContent(r.body, 'description').length > 40, 'description lost during degradation');
    assert.ok(r.body.includes('class="empty"'), 'no empty state shown');
    await new Promise((resolve) => s2.close(resolve));
  });

  await testAsync('registerSeoRoutes rejects a missing tmdb dependency', async () => {
    assert.throws(() => seo.registerSeoRoutes(express(), {}), /deps\.tmdb/);
  });

  await new Promise((resolve) => server.close(resolve));

  // ── summary ──
  console.log('\n' + '═'.repeat(56));
  console.log('  seo-ssr: ' + passed + ' passed, ' + failed + ' failed');
  console.log('═'.repeat(56));
  if (failed) {
    failures.forEach((f) => console.log('\n✗ ' + f.name + '\n' + (f.err.stack || f.err.message)));
    process.exit(1);
  }
})().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
