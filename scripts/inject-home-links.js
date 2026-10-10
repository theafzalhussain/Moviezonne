#!/usr/bin/env node
/**
 * inject-home-links.js
 * ──────────────────────────────────────────────────────────────────────────
 * Writes a server-rendered link block into index.html at BUILD time.
 *
 * Why build time and not request time:
 *   vercel.json serves "/" with @vercel/static (index.html is on the
 *   filesystem), so an Express route for "/" never runs in production. Baking
 *   the block into the file is the only path that reliably ships it on Vercel —
 *   and it costs nothing at runtime.
 *
 * What it fixes:
 *   The homepage held ~82% of the site's clicks and contained ZERO links to any
 *   /movie/ or /tv/ page, because the poster grid is built client-side. None of
 *   that authority reached the catalogue, which is why 573 sitemap URLs were
 *   still showing "Discovered – currently not indexed, never crawled".
 *
 * Idempotent: re-running replaces the previous block instead of stacking a
 * second one. Safe to run on every deploy.
 *
 * Run:
 *   TMDB_API_KEY=xxx node scripts/inject-home-links.js
 *
 * Exits 0 even when TMDB is unreachable — a failed enrichment must never fail
 * the build. In that case it still injects the category + A-Z links, which are
 * static and are the more important half of the crawl graph anyway.
 */

'use strict';

// Load .env the same way server.js does, so this script picks up the TMDB_TOKEN
// you already have instead of needing it re-typed into the shell. Optional on
// purpose: in CI there is no .env and dotenv may not be installed.
try { require('dotenv').config(); } catch { /* no .env — env vars come from the environment */ }

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOME_FILE = path.join(ROOT, 'index.html');

const { renderHomeLinkBlock, injectHomeLinks, optimizeHomeHead, injectHeroSlide,
  pickHomeLinks, homeLinkSeriesQuery } = require(path.join(ROOT, 'seo-ssr.js'));

// server.js authenticates with a v4 bearer token in TMDB_TOKEN, so that name is
// checked first — these scripts must work with the env that already exists.
//
// A v3 key and a v4 token are not interchangeable: v3 goes in an ?api_key= query
// param, v4 goes in an Authorization: Bearer header. Putting a v3 key in
// TMDB_TOKEN would send it as a bearer and every request would 401. Rather than
// trust the variable name, the value is inspected: v3 keys are 32 hex chars,
// v4 tokens are long JWTs starting with "ey".
const RAW_TOKEN = process.env.TMDB_TOKEN || process.env.TMDB_READ_TOKEN || process.env.TMDB_BEARER;
const RAW_KEY = process.env.TMDB_API_KEY || process.env.TMDB_KEY;

const looksLikeV3 = (v) => !!v && /^[a-f0-9]{32}$/i.test(v.trim());

const API_KEY = RAW_KEY || (looksLikeV3(RAW_TOKEN) ? RAW_TOKEN : null);
const READ_TOKEN = looksLikeV3(RAW_TOKEN) ? null : RAW_TOKEN;

if (looksLikeV3(RAW_TOKEN)) {
  console.log('ℹ TMDB_TOKEN looks like a v3 key — sending it as ?api_key= instead of a bearer.');
}
const BASE = 'https://api.themoviedb.org/3';

async function tmdb(endpoint, page, extra) {
  if (!API_KEY && !READ_TOKEN) return null;
  const qs = new URLSearchParams(Object.assign(
    { language: 'en-US', page: String(page || 1) }, extra || {}
  ));
  if (API_KEY && !READ_TOKEN) qs.set('api_key', API_KEY);
  const headers = { accept: 'application/json' };
  if (READ_TOKEN) headers.Authorization = 'Bearer ' + READ_TOKEN;

  try {
    const res = await fetch(`${BASE}${endpoint}?${qs}`, { headers });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return await res.json();
  } catch (err) {
    console.warn(`  ! ${endpoint}: ${err.message}`);
    return null;
  }
}

(async () => {
  if (!fs.existsSync(HOME_FILE)) {
    console.error('✖ index.html not found at ' + HOME_FILE);
    process.exit(1);
  }

  const shell = fs.readFileSync(HOME_FILE, 'utf8');

  /*  The eligibility rules live in seo-ssr.js, not here — registerHomeSsr()
   *  rebuilds this same block at REQUEST time on the Node deployment and would
   *  otherwise overwrite whatever this script baked in. See the note above
   *  HOME_LINK_MIN_MOVIE_YEAR there for what is filtered and why. */
  const seriesQ = homeLinkSeriesQuery();
  if (!seriesQ) {
    console.warn('  ! could not read STREAMING_NETWORK_IDS from moviezone.js — falling back to /tv/popular');
  }
  const seriesEndpoint = seriesQ ? seriesQ.endpoint : '/tv/popular';
  const seriesParams = seriesQ ? seriesQ.params : {};

  /*  Three pages per endpoint. Two was not enough and the number is measured, not
   *  guessed: of 40 /tv/popular rows, filtering leaves NINETEEN. The script's own
   *  "fewer links than before" guard caught it at 59 of 60. */
  const [tr1, tr2, tr3, po1, po2, po3, tv1, tv2, tv3] = await Promise.all([
    tmdb('/trending/movie/week', 1),
    tmdb('/trending/movie/week', 2),
    tmdb('/trending/movie/week', 3),
    tmdb('/movie/popular', 1),
    tmdb('/movie/popular', 2),
    tmdb('/movie/popular', 3),
    tmdb(seriesEndpoint, 1, seriesParams),
    tmdb(seriesEndpoint, 2, seriesParams),
    tmdb(seriesEndpoint, 3, seriesParams)
  ]);
  const trending = tr1, popular = po1;

  // The homepage LCP element is the first carousel slide background, which
  // pinPreloadedHero() pins to trending/movie/week[0].backdrop_path. Preloading it
  // turns a 2.4s serial wait (bundle -> API -> render -> image) into a parallel
  // fetch. Regenerated on every build, so it tracks whatever is trending that day.
  //
  // ── WHY TRENDING AND NOT movie/popular[0] (Sep 2026) ──
  // /movie/popular barely moves, so this tag barely moved, so slide 0 — the one
  // image every visitor looks at first — was effectively frozen between deploys.
  // Measured on the same day: popular[0] was Spider-Man: Brand New Day, released
  // 54 days earlier and holding that position for weeks, while trending[0] was
  // Resident Evil, released 5 days earlier. The carousel's own hero score now
  // weights TMDB's trending ordinal above everything else it adds, so trending[0]
  // is usually what the ranking would choose anyway: the preload and the deck
  // agree, and slide 0 turns over as trending does. Falls back to popular[0] if
  // the trending call is the one that failed.
  const heroItem = ((trending && trending.results) || [])[0]
    || ((popular && popular.results) || [])[0];
  const freshHero = heroItem && heroItem.backdrop_path
    ? 'https://image.tmdb.org/t/p/w780' + heroItem.backdrop_path
    : null;

  // If this run could not resolve a hero, keep whatever is already preloaded
  // rather than dropping the preload and regressing LCP.
  const existingHero = (shell.match(/as="image" href="(https:\/\/image\.tmdb\.org[^"]+)"/) || [])[1];
  const heroUrl = freshHero || existingHero || null;
  // Portrait-phone poster travels with the backdrop it belongs to.
  const existingPoster = (shell.match(/<meta name="mz-hero-poster" content="([^"]+)"/) || [])[1] || '';
  const heroPoster = freshHero ? ((heroItem && heroItem.poster_path) || '') : (existingHero ? existingPoster : '');
  if (!freshHero && existingHero) {
    console.warn('  ! No hero from TMDB — keeping the existing preload.');
  }

  /*  ── THE LINK BLOCK IS FILTERED THE SAME WAY THE GRID IS ──
   *
   *  It was not, and the result was visible on the homepage and in the crawl: the
   *  "Popular web series and shows" list came back as The Tonight Show Starring
   *  Johnny Carson (1962), Tagesschau (1952), What's My Line? (1950), four late-
   *  night talk shows and Law & Order (1990), while "Popular movies right now"
   *  carried Zero Woman 2 (1995). That is /tv/popular and /movie/popular raw —
   *  TMDB popularity is lifetime-ish and its TV side is dominated by linear
   *  broadcast formats that this site does not carry at all.
   *
   *  Two consequences, both bad. For a visitor it is a list of links to things the
   *  grid will never show. For search it is worse: these are the internal links
   *  the homepage spends its crawl budget on, pointed at pages nobody wants.
   *
   *  So the same two rules the feed uses are applied here — no pre-2000 MOVIES
   *  (isPreMillenniumMovie in moviezone.js), no news / reality / soap / talk shows
   *  (NON_DRAMA_TV_GENRE_IDS). Series are not year-filtered for the same reason
   *  they are not in the feed: first_air_date is season one, not currency.
   *
   *  Two pages per endpoint instead of one, so filtering still leaves twenty links
   *  per section rather than shrinking the block. These are build-time requests in
   *  a nightly script — there is no budget here to protect. */
  const groups = {
    trending: pickHomeLinks([tr1, tr2, tr3], 20, 'movie'),
    popular: pickHomeLinks([po1, po2, po3], 20, 'movie'),
    tv: pickHomeLinks([tv1, tv2, tv3], 20, 'tv')
  };

  const titleCount = groups.trending.length + groups.popular.length + groups.tv.length;

  // Regression guard. With no TMDB data the generated block still carries the
  // category and A-Z links, so writing it would look like a success while
  // silently deleting every detail-page link from the homepage — the exact thing
  // this script exists to add. On a scheduled run that would be committed and
  // deployed unnoticed. Refuse instead: yesterday's homepage is strictly better.
  const existingDetailLinks = (shell.match(/href="\/(?:movie|tv)\/[^"]+"/g) || []).length;
  if (!titleCount) {
    if (existingDetailLinks > 0) {
      console.error(`✖ TMDB returned no titles, but index.html already has ${existingDetailLinks} detail links.`);
      console.error('  Refusing to overwrite them with an empty block. Nothing written.');
      process.exit(1);
    }
    console.warn('  ! No TMDB data — injecting category + A-Z links only (none to lose).');
  }

  // Head first, then slide 0, then the link block, so all three live in one
  // generated file. The hero slide MUST be written from the same heroUrl as the
  // preload: if the two ever disagree the preload goes unused again, which is
  // the warning this pairing exists to remove.
  const tuned = injectHeroSlide(optimizeHomeHead(shell, heroUrl, heroPoster), heroUrl, heroPoster);
  const block = renderHomeLinkBlock(groups);
  const out = injectHomeLinks(tuned, block);

  if (!out) {
    console.error('✖ Could not find the footer anchor in index.html. Nothing injected.');
    console.error('  Expected: <footer class="site-footer" role="contentinfo">');
    process.exit(1);
  }

  const newDetailLinks = (out.match(/href="\/(?:movie|tv)\/[^"]+"/g) || []).length;
  if (newDetailLinks < existingDetailLinks) {
    console.error(`✖ Generated page has fewer detail links than the current one `
      + `(${newDetailLinks} < ${existingDetailLinks}). Nothing written.`);
    process.exit(1);
  }

  fs.writeFileSync(HOME_FILE, out);

  const detailLinks = (out.match(/href="\/(?:movie|tv)\/[^"]+"/g) || []).length;
  const catLinks = new Set(out.match(/href="\/(?:movies|series)\/[a-z0-9-]+"/g) || []).size;
  const azLinks = (out.match(/href="\/browse\/[^"]+"/g) || []).length;
  const tunedHead = out.includes('<!--MZ_PERF_HEAD-->');

  console.log('✔ index.html updated');
  console.log(`  detail-page links : ${detailLinks}  (was 0)`);
  console.log(`  category links    : ${catLinks} unique`);
  console.log(`  A-Z hub links     : ${azLinks}`);
  console.log(`  critical path     : ${tunedHead ? 'tuned' : 'NOT tuned — check index.html <head>'}`);
  console.log(`  hero preload      : ${heroUrl ? heroItem.title + ' — ' + heroUrl.split('/').pop() : 'none (no TMDB data)'}`);
})();
