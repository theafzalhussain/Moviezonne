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
  console.error('✖ No TMDB credential found. Checked, in order:');
  ['TMDB_TOKEN', 'TMDB_READ_TOKEN', 'TMDB_BEARER', 'TMDB_API_KEY', 'TMDB_KEY']
    .forEach((n) => console.error(`    ${n.padEnd(16)} ${process.env[n] ? 'set' : 'not set'}`));
  console.error('');
  console.error('  Locally  : add TMDB_TOKEN=... to .env (the script loads it automatically).');
  console.error('  In CI    : GitHub repo > Settings > Secrets and variables > Actions >');
  console.error('             New repository secret, named TMDB_TOKEN.');
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

/**
 * One cheap call before the fan-out. Without this, a rejected credential looks
 * identical to a quiet TMDB: hundreds of failed requests, then an unhelpful
 * "returned nothing" at the end.
 */
async function preflight() {
  const qs = new URLSearchParams({ language: 'en-US', page: '1' });
  if (API_KEY && !READ_TOKEN) qs.set('api_key', API_KEY);
  const headers = { accept: 'application/json' };
  if (READ_TOKEN) headers.Authorization = 'Bearer ' + READ_TOKEN;

  let res;
  try {
    res = await fetch(`${BASE}/movie/popular?${qs}`, { headers });
  } catch (err) {
    console.error(`✖ Could not reach TMDB: ${err.message}`);
    process.exit(1);
  }
  if (res.status === 401) {
    console.error('✖ TMDB rejected the credential (401).');
    console.error(`  Sent as: ${READ_TOKEN ? 'Authorization: Bearer …' : '?api_key=…'}`);
    console.error('  A v4 read access token is a long string starting "ey".');
    console.error('  A v3 API key is 32 hex characters. Check which one the secret holds.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`✖ TMDB preflight failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  console.log('✔ TMDB credential accepted');
}

(async () => {
  const started = Date.now();
  console.log('Building sitemap cache from TMDB…');
  await preflight();

  const [movie, tv] = await Promise.all([collect('movie'), collect('tv')]);

  if (!movie.length && !tv.length) {
    console.error('✖ TMDB returned nothing — leaving the existing cache untouched.');
    process.exit(1);
  }

  // Shrink guard. The curated franchise catalogue is merged in unconditionally,
  // so a total TMDB outage still yields a few hundred titles and would sail past
  // the emptiness check above — quietly collapsing a live 8,000-URL sitemap to a
  // few hundred, and committing it. A partial result is worse than a stale one.
  const total = movie.length + tv.length;
  if (fs.existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      const prevTotal = (prev.movie || []).length + (prev.tv || []).length;
      if (prevTotal > 0 && total < prevTotal * 0.8) {
        console.error(`✖ Refusing to write: ${total} titles is far below the existing ${prevTotal}.`);
        console.error('  TMDB was probably degraded during this run. Keeping the current cache.');
        console.error('  Re-run once TMDB is healthy, or set SITEMAP_ALLOW_SHRINK=1 to override.');
        if (!process.env.SITEMAP_ALLOW_SHRINK) process.exit(1);
      }
    } catch { /* unreadable previous cache is not a reason to block a good run */ }
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
