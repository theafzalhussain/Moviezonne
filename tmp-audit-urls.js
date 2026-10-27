'use strict';
/*  Throwaway (deleted after use). Builds the exact embed URL every server in
 *  moviezone.js's playerSources would load for a fixed set of test titles, by
 *  evaluating the array the same way toon-resolver-check.js does.
 *  Output: JSON [{ server, title, url }] on stdout. */
const fs = require('fs');
const vm = require('vm');
const client = fs.readFileSync(__dirname + '/moviezone.js', 'utf8');
const start = client.indexOf('const playerSources = [');
const end = client.indexOf('\n];', start) + 3;

const TITLES = [
  { key: 'cartoon-movie SpongeBob', id: 400160, type: 'movie', m: { id: 400160, media_type: 'movie', genre_ids: [16, 10751], original_language: 'en' } },
  { key: 'movie Endgame', id: 299534, type: 'movie', m: { id: 299534, media_type: 'movie', genre_ids: [28], original_language: 'en' } },
  { key: 'indian-movie 3 Idiots', id: 20453, type: 'movie', m: { id: 20453, media_type: 'movie', genre_ids: [18, 35], original_language: 'hi' } },
  { key: 'series GoT 1x1', id: 1399, type: 'tv', s: 1, e: 1, m: { id: 1399, media_type: 'tv', genre_ids: [18], original_language: 'en' } },
  { key: 'anime Naruto 1x1', id: 46260, type: 'tv', s: 1, e: 1, anilist: 20, m: { id: 46260, media_type: 'tv', genre_ids: [16, 10759], original_language: 'ja' } },
  { key: 'cartoon-tv Oggy 1x1', id: 2777, type: 'tv', s: 1, e: 1, m: { id: 2777, media_type: 'tv', genre_ids: [16, 35], original_language: 'fr' } }
];

const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const out = [];
for (const t of TITLES) {
  const sb = {
    console, URL, String, Number, parseInt, Array, Object, JSON, Math, Date, encodeURIComponent,
    location: { protocol: 'http:', href: 'http://localhost:3001/' },
    currentModalMovie: t.m, TOON_API: 'http://localhost:3001/api/toon',
    isAnimeContent: (x) => !!(x && x.original_language === 'ja' && (x.genre_ids || []).indexOf(16) !== -1),
    isCartoonContent: (x) => !!(x && (x.genre_ids || []).some((g) => g === 16 || g === 10762)),
    toonKnownMissing: () => false, getAnilistIdSync: () => t.anilist || null,
    animeAudioTrack: (lang) => (lang === 'hi' ? 'hindi' : lang === 'en' ? 'dub' : 'sub'),
    mzResumeSec: () => 0
  };
  vm.createContext(sb);
  vm.runInContext(client.slice(start, end) + '\nthis.__s = playerSources;', sb);
  sb.__s.forEach((s) => {
    if (only && only.indexOf(s.name) === -1) return;
    let url;
    try { url = s.url(t.id, 'hi', t.type, String(t.s || 1), String(t.e || 1)); } catch (e) { url = 'ERR ' + e.message; }
    out.push({ server: s.name, title: t.key, url, anime: !!s.anime });
  });
}
process.stdout.write(JSON.stringify(out, null, 1));
