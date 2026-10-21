/*  growth-check.js — guards the WhatsApp share, voice search and the Oct 2026
 *  Search Console-driven SEO fixes. Offline; part of test:offline.
 *
 *    1. Platform pages (any category gated on with_watch_providers) lead with a
 *       "new this month" rail and a month-stamped title — and fall back to the
 *       evergreen title when fewer than OTT_FRESH_MIN new titles exist.
 *    2. Titles stay short enough that Google does not cut them mid-word.
 *    3. No meta description borrows IMDb's name for a TMDB score.
 *    4. Share cards: og:image is the 1200x630 card on the homepage and on
 *       non-title pages, and a landscape backdrop on title pages.
 *    5. The share button builds the SAME canonical slug the server renders, so
 *       WhatsApp caches the real page's preview, not a 301 hop.
 *    6. mz-extras.js is loaded deferred by a ?v= that the asset seal tracks, is
 *       immutable-cached, and never ships a TV share button.
 *    7. The SEO refresh workflow commits BEFORE it rebases (the inverse order
 *       failed every scheduled run from 8 Oct 2026).
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const seo = require('./seo-ssr.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failures.push(name + ' - ' + e.message); console.log('  FAIL  ' + name + '\n          ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
const titleOfHtml = h => ((h.match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/&amp;/g, '&');
const meta = (h, attr, key) => ((h.match(new RegExp('<meta ' + attr + '="' + key + '" content="([^"]*)"')) || [])[1] || '');

const fakeTitles = n => Array.from({ length: n }, (_, i) => ({
  id: 1000 + i, title: 'New Film ' + i, poster_path: '/p' + i + '.jpg', release_date: '2026-10-01', vote_average: 7, vote_count: 10
}));

console.log('growth check');
console.log('--------------------------------------------------------------');

check('platform pages get a scoped, recent "new this month" query', () => {
  const p = seo.ottLatestParams(seo.CATEGORIES['prime-video']);
  assert(p && p.with_watch_providers === '119' && p.watch_region === 'IN', 'not gated on the platform');
  assert(p['primary_release_date.gte'] && p['primary_release_date.lte'], 'no release window');
  const days = (Date.parse(p['primary_release_date.lte']) - Date.parse(p['primary_release_date.gte'])) / 864e5;
  assert(days >= 30 && days <= 120, 'window is ' + days + ' days');
  const tv = seo.ottLatestParams(seo.CATEGORIES['netflix-series']);
  assert(tv && tv['first_air_date.gte'], 'series pages must window on first_air_date');
  assert(seo.ottLatestParams(seo.CATEGORIES['tollywood']) === null, 'non-platform pages must not get the rail');
});

check('fresh title + rail only when enough new titles exist; evergreen otherwise', () => {
  const cat = seo.CATEGORIES['prime-video'];
  const fresh = seo.renderCategoryPage('prime-video', cat, fakeTitles(5), 1, 3, fakeTitles(8));
  assert(/^New on Amazon Prime Video India \([A-Z][a-z]+ \d{4}\)/.test(titleOfHtml(fresh)), 'fresh title: ' + titleOfHtml(fresh));
  assert(/id="new-this-month"/.test(fresh), 'rail missing');
  const thin = seo.renderCategoryPage('prime-video', cat, fakeTitles(5), 1, 3, fakeTitles(2));
  assert(titleOfHtml(thin).startsWith(cat.title), 'thin rail must keep the evergreen title, got: ' + titleOfHtml(thin));
  assert(!/id="new-this-month"/.test(thin), 'thin rail must not render');
  const p2 = seo.renderCategoryPage('prime-video', cat, fakeTitles(5), 2, 3, fakeTitles(8));
  assert(!/id="new-this-month"/.test(p2), 'page 2 must not repeat the rail');
});

check('page titles stay within ~75 characters', () => {
  Object.keys(seo.CATEGORIES).forEach(slug => {
    const t = titleOfHtml(seo.renderCategoryPage(slug, seo.CATEGORIES[slug], fakeTitles(5), 1, 3, fakeTitles(8)));
    assert(t.length <= 110, slug + ' title is ' + t.length + ' chars');
    if (seo.ottLatestParams(seo.CATEGORIES[slug])) assert(t.length <= 75, slug + ' fresh title is ' + t.length + ' chars: ' + t);
  });
});

check('meta descriptions do not borrow the IMDb name for a TMDB score', () => {
  const src = fs.readFileSync('seo-ssr.js', 'utf8');
  assert(!/['"`]IMDb style rating/.test(src), 'the "IMDb style rating" string is back in seo-ssr.js');
});

check('share cards: 1200x630 image on home and non-title pages, backdrop on titles', () => {
  const home = fs.readFileSync('index.html', 'utf8');
  assert(meta(home, 'property', 'og:image') === 'https://moviezone.dev/og-image.jpg', 'homepage og:image');
  assert(meta(home, 'property', 'og:image:width') === '1200' && meta(home, 'property', 'og:image:height') === '630', 'homepage og dims');
  assert(fs.existsSync('og-image.jpg') && fs.statSync('og-image.jpg').size < 200 * 1024, 'og-image.jpg missing or > 200 KB');
  const cat = seo.renderCategoryPage('tollywood', seo.CATEGORIES['tollywood'], fakeTitles(3), 1, 1, null);
  assert(meta(cat, 'property', 'og:image').endsWith('/og-image.jpg'), 'category og:image is not the share card');
  const src = fs.readFileSync('seo-ssr.js', 'utf8');
  assert(/ogImage: \(item\.backdrop_path \? IMG_OG \+ item\.backdrop_path/.test(src), 'title pages do not share their backdrop');
});

check('homepage WebSite schema carries the brand spellings people search', () => {
  const home = fs.readFileSync('index.html', 'utf8');
  ['Movie Zone', 'MovieZone Telugu', 'Movies Zone'].forEach(n => assert(home.includes('"' + n + '"'), 'missing alternateName ' + n));
});

check('share button slug matches the server canonical slug', () => {
  const src = fs.readFileSync('mz-extras.js', 'utf8');
  const fn = src.slice(src.indexOf('function slugify('), src.indexOf('var css = ['));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fn + ';this.s=slugify;', ctx);
  ['Avengers: Infinity War', 'Spider-Man: Across the Spider-Verse', 'Pokémon: Détective Pikachu',
    "Ocean's Eleven", 'Fast & Furious 7', 'K.G.F: Chapter 2', 'Bhool Bhulaiyaa 3'].forEach(t => {
    assert(ctx.s(t) === seo.slugify(t), t + ': ' + ctx.s(t) + ' vs ' + seo.slugify(t));
  });
});

check('mz-extras.js is deferred, versioned, sealed, immutable, and TV-safe', () => {
  const home = fs.readFileSync('index.html', 'utf8');
  const v = (home.match(/s\.src = '\/mz-extras\.js\?v=([0-9.]+)'/) || [])[1];
  assert(v, 'index.html does not request /mz-extras.js?v=');
  assert(!/<script[^>]+src="\/mz-extras\.js/.test(home), 'mz-extras.js must not be a parser-inserted script');
  const versions = JSON.parse(fs.readFileSync('asset-versions.json', 'utf8'));
  assert(versions['mz-extras.js'] && versions['mz-extras.js'].version === v, 'asset seal does not track mz-extras.js v' + v);
  assert(/\/mz-extras\.js\n\s+Cache-Control: public, max-age=31536000, immutable/.test(fs.readFileSync('_headers', 'utf8')), '_headers not immutable');
  const src = fs.readFileSync('mz-extras.js', 'utf8');
  assert(/if \(isTV \|\| document\.querySelector\('\.mz-wa-fab'\)\) return;/.test(src), 'share button is not suppressed on TVs');
  assert(/if \(!Recognition \|\| !window\.isSecureContext\) return;/.test(src), 'mic is not feature-detected');
  assert(/rel = 'noopener noreferrer'/.test(src), 'share link opens without noopener');
  assert(!/innerHTML\s*=\s*[^'"]*(title|transcript|query)/i.test(src), 'user/remote text must never reach innerHTML');
});

check('SEO refresh workflow commits before it rebases, and retries the push', () => {
  const wf = fs.readFileSync('.github/workflows/seo-refresh.yml', 'utf8');
  const step = wf.slice(wf.indexOf('- name: Commit if anything changed'));
  const commitAt = step.indexOf('git commit');
  const pullAt = step.indexOf('git pull --rebase');
  assert(commitAt > 0 && pullAt > 0 && commitAt < pullAt, 'git commit must come before git pull --rebase');
  assert(/for TRY in 1 2 3/.test(step), 'push is not retried');
});

console.log('==============================================================');
console.log('  growth-check: ' + passed + ' passed, ' + failures.length + ' failed');
failures.forEach(f => console.log('   x ' + f));
console.log('==============================================================');
process.exit(failures.length ? 1 : 0);
