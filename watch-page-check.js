/* ═══════════════════════════════════════════════════════════════════════════
   watch-page-check.js — the detail page's poster is not stretched, and its
   "Watch" button reaches a player that actually plays.

   TWO BUGS THIS LOCKS DOWN

   1. THE STRETCHED POSTER. .hero-in is a flex row and .poster only pinned its
      WIDTH (flex:0 0 214px). A flex item's default cross-axis behaviour is
      align-items:stretch, so the <img> was pulled to the height of .hero-copy —
      title, tagline, facts, chips, synopsis and CTA stacked up, 700px+ against an
      intrinsic 321px. The artwork was visibly distorted, and no width value could
      have fixed it.

   2. THE DEAD WATCH BUTTON. The CTA pointed at '/#watch-movie-<id>', which could
      never work: moviezone.js strips a '#watch-' hash on DOMContentLoaded and
      openModal() refuses to run without a trusted user gesture (that guard is what
      stops a PWA relaunch or BFCache restore resuming playback, and on TV it wants
      a fresh D-pad press). A freshly loaded document has no gesture. So the link
      only ever dumped the user on the homepage.

      It now points at a server-rendered /watch page where the iframe is in the
      HTML — no JS, no guard to satisfy, nothing auto-opened.

   Run: node watch-page-check.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const seo = require(path.join(__dirname, 'seo-ssr.js'));
const ssrSrc = fs.readFileSync(path.join(__dirname, 'seo-ssr.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}

console.log('\ndetail page — poster geometry and a Watch button that works');
console.log('-'.repeat(70));

// ── 1. the poster cannot be stretched by the flex row ────────────────────────
const posterRule = /\.poster\{([^}]*)\}/.exec(ssrSrc);
check('a .poster rule exists', !!posterRule);
const poster = posterRule ? posterRule[1] : '';

check('the poster opts out of the flex row\'s stretch', /align-self:flex-start/.test(poster),
  'without this, flex align-items:stretch forces the height and distorts the art');
check('its height is intrinsic, not imposed', /height:auto/.test(poster), poster);
check('the poster ratio is pinned as a backstop', /aspect-ratio:2\/3/.test(poster), poster);
check('art that is not exactly 2:3 is cropped, not squashed',
  /object-fit:cover/.test(poster), poster);
check('the width is still fixed', /width:214px/.test(poster) && /flex:0 0 214px/.test(poster), poster);

// The container that caused it must still be a flex row, or this test guards
// nothing — if the layout ever stops being flex, these rules are harmless anyway.
check('.hero-in is still the flex row that made this necessary',
  /\.hero-in\{[^}]*display:flex/.test(ssrSrc));

// The <img> keeps its intrinsic dimensions so the box is reserved before load.
check('the poster img still declares width and height attributes',
  /class="poster"[^>]*width="500"[^>]*height="750"/.test(ssrSrc)
  || /class=\\?"poster\\?"[\s\S]{0,160}width="500"/.test(ssrSrc),
  'needed so the slot is reserved and CLS stays at zero');

// ── 2. the CTA points at a real page, not the dead hash ──────────────────────
console.log('');
check('the watch CTA no longer uses the stripped #watch- hash',
  !/watchHref = '\/#watch-/.test(ssrSrc),
  "moviezone.js deletes that hash on load, so the link could not work");
check('the CTA points at the server-rendered /watch page',
  /const watchHref = detailPath\(kind, item\) \+ '\/watch'/.test(ssrSrc));
check('moviezone.js really does strip the hash (the reason for the change)',
  /window\.location\.hash\.startsWith\('#watch-'\)[\s\S]{0,160}replaceState/.test(appSrc),
  'if this ever stops being true, revisit the approach rather than this test');
check('and really does gate opening on a trusted gesture',
  /if \(!claimExplicitDetailActivation\(activationEvent\)\) return;/.test(appSrc));

// ── 3. the watch page renders a playable frame ───────────────────────────────
console.log('');
const MOVIE = {
  id: 1515729, title: 'Blast', release_date: '2026-01-09',
  poster_path: '/p.jpg', backdrop_path: '/b.jpg'
};
const TV = {
  id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20',
  poster_path: '/p.jpg'
};

const movieHtml = seo.renderWatchPage(MOVIE, 'movie', {});
check('the movie watch page renders a document',
  /^<!DOCTYPE html>/.test(movieHtml) && movieHtml.length > 1000);
check('the player iframe is present in the HTML, no JS required',
  /<iframe src="https:\/\/[^"]+"/.test(movieHtml));
check('the iframe carries the TMDB id', movieHtml.includes(String(MOVIE.id)));
check('it is allowed to go fullscreen and autoplay',
  /allow="autoplay; fullscreen; encrypted-media; picture-in-picture"/.test(movieHtml)
  && /allowfullscreen/.test(movieHtml));
check('the frame holds a 16:9 box so the page does not jump',
  /\.player-frame\{[^}]*aspect-ratio:16\/9/.test(ssrSrc));
/*  This used to assert the page shipped NO script at all. That was a proxy for
 *  the property that actually matters — playback must not depend on JavaScript —
 *  and it stopped being usable once the page carried an ad loader.
 *
 *  So the real property is asserted directly instead, and more strictly than
 *  before: the player, the server switcher and the episode form must contain no
 *  script, no event handler and no JS URL, and every script on the page must be
 *  either JSON-LD or the ad loader. Kill JavaScript and the film still plays. */
check('playback needs no JavaScript',
  !/<script/.test(movieHtml.slice(
    movieHtml.indexOf('<div class="player-shell">'),
    movieHtml.indexOf('<aside class="ad-slot"')))
  && !/\son(?:click|load|error|submit)=/i.test(movieHtml)
  && !/href="javascript:/i.test(movieHtml),
  'the player region grew a script or an inline handler — the page must work with JS off');

check('the only scripts on the page are JSON-LD and the ad loader',
  (function () {
    const tags = movieHtml.match(/<script[^>]*>/g) || [];
    const loaders = tags.filter((t) => /data-mz-ads/.test(t));
    const other = tags.filter((t) => !/data-mz-ads/.test(t) && !/application\/ld\+json/.test(t));
    return loaders.length === 1 && other.length === 0;
  })(),
  'an unexpected script tag appeared on the watch page: '
    + JSON.stringify((movieHtml.match(/<script[^>]*>/g) || [])));

check('the ad loader cannot block the player',
  !/<script\s+src="https?:/.test(movieHtml),
  'a cross-origin script tag is in the markup; ad units must be injected at runtime');

check('the ad loader cannot block the player',
  !/<script\s+src="https?:/.test(movieHtml),
  'a cross-origin script tag is in the markup; ad units must be injected at runtime');

check('every alternate server is offered as a link',
  (movieHtml.match(/class="srv"/g) || []).length === 1
  && seo.WATCH_SOURCES.every(function (s, i) {
    return i === 0 ? movieHtml.includes(s.name) : movieHtml.includes('?s=' + i);
  }),
  'a blocked host must be escapable without JS');
check('the current server is marked, not linked',
  /<span aria-current="true">/.test(movieHtml));
check('server links are nofollow', /class="srv">[\s\S]{0,400}rel="nofollow"/.test(movieHtml));
check('there is a way back to the detail page',
  movieHtml.includes(seo.pageHref ? '/movie/1515729-blast' : '/movie/1515729-blast'));

// noindex: a bare player frame must not compete with the detail page.
check('the watch page is noindex, follow',
  /<meta name="robots" content="noindex, follow">/.test(movieHtml));
check('it points its canonical at the detail page, not itself',
  /<link rel="canonical" href="[^"]*\/movie\/1515729-blast">/.test(movieHtml),
  'the detail page is the surface that should rank');

// ── 4. episode handling and hostile input ────────────────────────────────────
console.log('');
const tvHtml = seo.renderWatchPage(TV, 'tv', { season: '2', episode: '5' });
check('a series page embeds the requested season and episode',
  /\/tv\/1396\/2\/5/.test(tvHtml), (tvHtml.match(/vidfast[^"]*/) || [''])[0]);
check('a series page offers an episode picker', /class="ep-form"/.test(tvHtml));
check('the picker is a plain GET form, so it needs no JS',
  /<form class="ep-form" method="get"/.test(tvHtml));
check('switching server keeps the current episode',
  /\?s=1&amp;season=2&amp;episode=5/.test(tvHtml) || /\?s=1&season=2&episode=5/.test(tvHtml));
check('a movie page has no episode picker',
  !/class="ep-form"/.test(movieHtml));

// Input reaches a URL, so it has to be clamped rather than trusted.
const hostile = [
  ['a non-numeric source', { source: 'evil' }],
  ['an out-of-range source', { source: '99' }],
  ['a negative source', { source: '-1' }]
];
hostile.forEach(function (entry) {
  const html = seo.renderWatchPage(MOVIE, 'movie', entry[1]);
  check('falls back to the first server for ' + entry[0],
    html.includes(seo.WATCH_SOURCES[0].name) && /<iframe src="https:\/\//.test(html));
});
const wildEp = seo.renderWatchPage(TV, 'tv', { season: '../etc', episode: '99999' });
check('a hostile season/episode is clamped to safe integers',
  /\/tv\/1396\/1\/1/.test(wildEp), (wildEp.match(/vidfast[^"]*/) || [''])[0]);
check('no unescaped user input reaches the iframe src',
  !/src="[^"]*\.\./.test(wildEp));

// ── 5. the server list must not drift from the app's ─────────────────────────
console.log('');
/*  WATCH_SOURCES is a deliberate short mirror of moviezone.js's list. When a dead
 *  domain is swapped out there (it has happened — cinextream.net lost its DNS
 *  record) this page would keep pointing at it, and the failure looks like "the
 *  player is broken" rather than "one file was missed". */
seo.WATCH_SOURCES.forEach(function (source) {
  const url = source.build(1, 'movie', 1, 1);
  const host = new URL(url).host;
  check('moviezone.js still uses ' + host, appSrc.includes(host),
    'swap it here too, or the watch page points at a dead host');
});
check('the mirror is a short fallback list, not a second copy of all ten',
  seo.WATCH_SOURCES.length >= 2 && seo.WATCH_SOURCES.length <= 6,
  seo.WATCH_SOURCES.length + ' sources');
check('every server has a distinct name and host',
  new Set(seo.WATCH_SOURCES.map((s) => s.name)).size === seo.WATCH_SOURCES.length
  && new Set(seo.WATCH_SOURCES.map((s) => new URL(s.build(1, 'movie', 1, 1)).host)).size
     === seo.WATCH_SOURCES.length);

// ── 6. routing ───────────────────────────────────────────────────────────────
console.log('');
check('the watch routes are registered for both kinds',
  /app\.get\('\/movie\/:slug\/watch', watchHandler\('movie'\)\)/.test(ssrSrc)
  && /app\.get\('\/tv\/:slug\/watch', watchHandler\('tv'\)\)/.test(ssrSrc));
check('a wrong slug is redirected so the page has one URL',
  /redirect\(301, detailPath\(kind, item\) \+ '\/watch'/.test(ssrSrc));
check('the watch response is sent noindex at the header level too',
  /X-Robots-Tag', 'noindex, follow'/.test(ssrSrc));
check('the player page is cached briefly, not for hours',
  /max-age=300, s-maxage=900/.test(ssrSrc),
  'embed hosts rotate; a stale frame is worse than a slower page');

// ── 7. index.html must reference its bundles root-absolutely ─────────────────
console.log('');
/*  THE BUG THIS CATCHES
 *  index.html shipped its bundles as relative URLs ("moviezone.min.js?v=9.6").
 *  That is fine on "/" and broken on every nested route. On
 *  /movie/1339713-obsession the browser resolved them against the directory and
 *  requested /movie/moviezone.min.js, which does not exist, so Cloudflare's
 *  single-page-application fallback returned index.html — and the browser tried to
 *  parse HTML as JavaScript:
 *
 *      Uncaught SyntaxError: Unexpected token '<'   moviezone.min.js:1
 *      Uncaught SyntaxError: Unexpected token '<'   tv-mode.min.js:1
 *      Uncaught SyntaxError: Unexpected token '<'   search-engine.min.js:1
 *      Uncaught SyntaxError: Unexpected token '<'   pwa-install.min.js:1
 *
 *  The stylesheet failed identically, which is why the detail pages rendered as
 *  unstyled text. Every SSR route added here widens the blast radius, so this is
 *  asserted rather than remembered.
 */
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const BUNDLES = ['moviezone.min.js', 'moviezone.min.css', 'tv-mode.min.js',
  'tv-mode.min.css', 'search-engine.min.js', 'pwa-install.min.js'];

BUNDLES.forEach(function (name) {
  const escaped = name.replace(/\./g, '\\.');
  // Any reference NOT preceded by "/" is a relative one.
  const relative = new RegExp('(?:href|src)="' + escaped + '|s\\.src = \'' + escaped);
  check(name + ' is referenced root-absolutely', !relative.test(indexHtml),
    'a relative URL breaks on /movie/<slug> — the SPA fallback returns index.html');
});

check('every bundle really is referenced in index.html',
  BUNDLES.every(function (name) { return indexHtml.includes('/' + name); }));

// The head optimizer rewrites those same tags, so its patterns must accept the
// absolute form or it silently turns into a no-op on the next nightly run.
const reoptimised = seo.optimizeHomeHead(indexHtml, 'https://image.tmdb.org/t/p/w780/x.jpg');
check('optimizeHomeHead can still rewrite the real index.html',
  reoptimised !== indexHtml && reoptimised.includes('<!--MZ_PERF_HEAD-->'),
  'it returned the file unchanged, which means its regexes stopped matching');
check('and it preloads the absolute stylesheet URL',
  /<link rel="preload" href="\/moviezone\.min\.css\?v=[\d.]+" as="style"/.test(reoptimised),
  (reoptimised.match(/<link rel="preload" href="[^"]*\.css[^"]*"/) || [''])[0]);

console.log('-'.repeat(70));
console.log('  watch-page-check: ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
