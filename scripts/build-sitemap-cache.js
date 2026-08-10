#!/usr/bin/env node
/**
 * build-sitemap-cache.js
 * ──────────────────────────────────────────────────────────────────────────
 * Walks TMDB once and writes the full catalogue to sitemap-cache.json.
 *
 * Why this exists:
 *   The sitemap routes used to fan out to TMDB on every request, so they were
 *   deliberately bounded to a handful of endpoints — which capped the sitemap
 *   at ~670 URLs while Search Console already knew about 1,200+ pages. Doing
 *   the walk once, offline, removes both the request-time cost and the cap.
 *
 * Output shape (consumed by seo-ssr.js):
 *   {
 *     "generated": "2026-08-10",
 *     "movie": [{ "id": 550, "title": "Fight Club", "lastmod": "1999-10-15" }],
 *     "tv":    [{ "id": 1399, "title": "Game of Thrones", "lastmod": "2011-04-17" }]
 *   }
 *
 * Run:
 *   TMDB_API_KEY=xxx node scripts/build-sitemap-cache.js
 *
 * Safe to re-run. Writes atomically via a temp file, so a crashed run can
 * never leave a half-written cache behind for the server to read.
 */

'use strict';

// Load .env the same way server.js does, so this script picks up the TMDB_TOKEN
// you already have instead of needing it re-typed into the shell. Optional on
// purpose: in CI there is no .env and dotenv may not be installed.
try { require('dotenv').config(); } catch { /* no .env — env vars come from the environment */ }

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.TMDB_API_KEY || process.env.TMDB_KEY;
// server.js authenticates with a v4 bearer token in TMDB_TOKEN, so that is the
// first name we look for — these scripts must work with the env you already have.
const READ_TOKEN = process.env.TMDB_TOKEN || process.env.TMDB_READ_TOKEN || process.env.TMDB_BEARER;
const BASE = 'https://api.themoviedb.org/3';
const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'sitemap-cache.json');

// How deep to walk each endpoint. 500 is TMDB's hard page cap.
const PAGES = {
  discover: Number(process.env.SITEMAP_DISCOVER_PAGES || 60),  // 20/page → 1200 titles
  list: Number(process.env.SITEMAP_LIST_PAGES || 15)
};

// Politeness: TMDB allows ~50 req/s. We stay far below that.
const CONCURRENCY = 6;
const RETRY_LIMIT = 3;

if (!API_KEY && !READ_TOKEN) {
  console.error('✖ Set TMDB_TOKEN (v4 bearer, same as server.js) or TMDB_API_KEY (v3 key) before running.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdb(endpoint, params = {}, attempt = 1) {
  const qs = new URLSearchParams(Object.assign({ language: 'en-US' }, params));
  if (API_KEY && !READ_TOKEN) qs.set('api_key', API_KEY);

  const headers = { accept: 'application/json' };
  if (READ_TOKEN) headers.Authorization = 'Bearer ' + READ_TOKEN;

  try {
    const res = await fetch(`${BASE}${endpoint}?${qs}`, { headers });

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 2) * 1000;
      await sleep(wait);
      return tmdb(endpoint, params, attempt);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (attempt >= RETRY_LIMIT) {
      console.warn(`  ! ${endpoint} p${params.page || 1} failed: ${err.message}`);
      return null;
    }
    await sleep(400 * attempt);
    return tmdb(endpoint, params, attempt + 1);
  }
}

/** Run tasks with a fixed worker pool so we never open 500 sockets at once. */
async function pool(tasks, limit) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

function endpointsFor(kind) {
  if (kind === 'tv') {
    return [
      { path: '/tv/popular', pages: PAGES.list },
      { path: '/tv/top_rated', pages: PAGES.list },
      { path: '/tv/airing_today', pages: 5 },
      { path: '/tv/on_the_air', pages: 5 },
      { path: '/trending/tv/week', pages: 5 },
      // Language-scoped discover sweeps: this is what actually grows coverage
      { path: '/discover/tv', pages: PAGES.discover, params: { sort_by: 'popularity.desc' } },
      { path: '/discover/tv', pages: 25, params: { with_original_language: 'hi', sort_by: 'popularity.desc' } },
      { path: '/discover/tv', pages: 25, params: { with_original_language: 'ko', sort_by: 'popularity.desc' } },
      { path: '/discover/tv', pages: 25, params: { with_original_language: 'ja', sort_by: 'popularity.desc' } },
      { path: '/discover/tv', pages: 15, params: { with_original_language: 'te', sort_by: 'popularity.desc' } },
      { path: '/discover/tv', pages: 15, params: { with_original_language: 'ta', sort_by: 'popularity.desc' } }
    ];
  }
  return [
    { path: '/movie/popular', pages: PAGES.list },
    { path: '/movie/top_rated', pages: PAGES.list },
    { path: '/movie/now_playing', pages: 8 },
    { path: '/movie/upcoming', pages: 8 },
    { path: '/trending/movie/week', pages: 5 },
    { path: '/discover/movie', pages: PAGES.discover, params: { sort_by: 'popularity.desc' } },
    { path: '/discover/movie', pages: 40, params: { with_original_language: 'hi', sort_by: 'popularity.desc' } },
    { path: '/discover/movie', pages: 30, params: { with_original_language: 'te', sort_by: 'popularity.desc' } },
    { path: '/discover/movie', pages: 30, params: { with_original_language: 'ta', sort_by: 'popularity.desc' } },
    { path: '/discover/movie', pages: 20, params: { with_original_language: 'ml', sort_by: 'popularity.desc' } },
    { path: '/discover/movie', pages: 20, params: { with_original_language: 'kn', sort_by: 'popularity.desc' } },
    { path: '/discover/movie', pages: 20, params: { with_original_language: 'ko', sort_by: 'popularity.desc' } },
    { path: '/discover/movie', pages: 20, params: { with_original_language: 'ja', sort_by: 'popularity.desc' } }
  ];
}

/**
 * The hand-curated franchise/universe catalogue (Marvel, DC, Bond, Fast &
 * Furious, Conjuring…). TMDB's popularity sweeps do NOT reliably surface these
 * — the original collectSitemapItems() merged this file for exactly that
 * reason, and dropping it silently lost ~100 titles Google had already
 * discovered. It ships id, title and release_date, so no API call is needed.
 */
function catalogItems(kind) {
  const file = path.join(ROOT, 'collections-catalog.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.warn('  ! collections-catalog.json unreadable — skipping franchise merge');
    return [];
  }
  const bucket = kind === 'tv' ? 'tv' : 'movies';
  const out = [];
  Object.values((data && data.universes) || {}).forEach((universe) => {
    ((universe && universe[bucket]) || []).forEach((item) => {
      if (item && item.id && (item.title || item.name)) out.push(item);
    });
  });
  return out;
}

async function collect(kind) {
  const seen = new Map();
  const endpoints = endpointsFor(kind);

  const tasks = [];
  endpoints.forEach((ep) => {
    for (let p = 1; p <= ep.pages; p++) {
      tasks.push(() => tmdb(ep.path, Object.assign({ page: String(p) }, ep.params || {})));
    }
  });

  console.log(`→ ${kind}: ${tasks.length} requests across ${endpoints.length} endpoints`);
  const pages = await pool(tasks, CONCURRENCY);

  pages.forEach((page) => {
    ((page && page.results) || []).forEach((item) => {
      if (!item || !item.id) return;
      const title = item.title || item.name || item.original_title || item.original_name;
      // No title → no slug → the URL would 301 to itself. Skip it.
      if (!title) return;
      // Adult titles stay out of the index entirely.
      if (item.adult) return;
      const key = String(item.id);
      if (seen.has(key)) return;
      seen.set(key, {
        id: item.id,
        title,
        lastmod: String(item.release_date || item.first_air_date || '').slice(0, 10) || undefined
      });
    });
  });

  // Merge the curated franchise catalogue last so API data wins on conflicts,
  // but nothing curated is ever dropped.
  const fromApi = seen.size;
  catalogItems(kind).forEach((item) => {
    const key = String(item.id);
    if (seen.has(key)) return;
    seen.set(key, {
      id: item.id,
      title: item.title || item.name,
      lastmod: String(item.release_date || item.first_air_date || '').slice(0, 10) || undefined
    });
  });

  const out = [...seen.values()];
  console.log(`  ${kind}: ${out.length} unique titles (${fromApi} from TMDB + ${out.length - fromApi} from the franchise catalogue)`);
  return out;
}

(async () => {
  const started = Date.now();
  console.log('Building sitemap cache from TMDB…');

  const [movie, tv] = await Promise.all([collect('movie'), collect('tv')]);

  if (!movie.length && !tv.length) {
    console.error('✖ TMDB returned nothing — leaving the existing cache untouched.');
    process.exit(1);
  }

  const payload = {
    generated: new Date().toISOString().slice(0, 10),
    counts: { movie: movie.length, tv: tv.length },
    movie,
    tv
  };

  // Atomic write: the server may be reading the old file right now.
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, OUT_FILE);

  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`✔ Wrote ${OUT_FILE} — ${movie.length} movies + ${tv.length} series (${kb} KB) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
})();
