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

const { renderHomeLinkBlock, injectHomeLinks, optimizeHomeHead, injectHeroSlide } = require(path.join(ROOT, 'seo-ssr.js'));

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

async function tmdb(endpoint) {
  if (!API_KEY && !READ_TOKEN) return null;
  const qs = new URLSearchParams({ language: 'en-US', page: '1' });
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

  const [trending, popular, tv] = await Promise.all([
    tmdb('/trending/movie/week'),
    tmdb('/movie/popular'),
    tmdb('/tv/popular')
  ]);

  // The homepage LCP element is the first carousel slide background, which the
  // app builds from movie/popular[0].backdrop_path at w780. Preloading it turns
  // a 2.4s serial wait (bundle -> API -> render -> image) into a parallel fetch.
  // Regenerated on every build, so it tracks whatever is popular that day.
  const heroItem = ((popular && popular.results) || [])[0];
  const freshHero = heroItem && heroItem.backdrop_path
    ? 'https://image.tmdb.org/t/p/w780' + heroItem.backdrop_path
    : null;

  // If this run could not resolve a hero, keep whatever is already preloaded
  // rather than dropping the preload and regressing LCP.
  const existingHero = (shell.match(/as="image" href="(https:\/\/image\.tmdb\.org[^"]+)"/) || [])[1];
  const heroUrl = freshHero || existingHero || null;
  if (!freshHero && existingHero) {
    console.warn('  ! No hero from TMDB — keeping the existing preload.');
  }

  const pick = (d, n) => ((d && d.results) || []).filter((r) => r && r.id).slice(0, n);
  const groups = {
    trending: pick(trending, 20),
    popular: pick(popular, 20),
    tv: pick(tv, 20)
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
  const tuned = injectHeroSlide(optimizeHomeHead(shell, heroUrl), heroUrl);
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
