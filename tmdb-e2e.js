// End-to-end verification of the TMDB proxy hardening.
// Boots server.js on a spare port and hammers /api/tmdb the way the frontend does.
process.env.PORT = process.env.PORT || '3999';
require('dotenv').config();
const http = require('http');

const BASE = `http://127.0.0.1:${process.env.PORT}`;

function get(path) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({
        path, status: res.statusCode, ms: Date.now() - t0,
        cache: res.headers['x-cache'] || '-',
        staleReason: res.headers['x-stale-reason'] || '',
        len: body.length,
        json: (() => { try { return JSON.parse(body); } catch { return null; } })()
      }));
    });
    req.on('error', e => resolve({ path, status: 'ERR', err: e.code || e.message, ms: Date.now() - t0 }));
    req.setTimeout(60000, () => req.destroy(new Error('client timeout')));
  });
}

// Frontend calls BASE + endpoint where BASE = '/api/tmdb' and endpoint has no /3 prefix.
const ENDPOINTS = [
  '/api/tmdb/trending/all/week?language=en-US&page=1',
  '/api/tmdb/movie/popular?language=en-US&page=1',
  '/api/tmdb/tv/popular?language=en-US&page=1',
  '/api/tmdb/movie/top_rated?language=en-US&page=1',
  '/api/tmdb/movie/550?language=en-US',
  '/api/tmdb/genre/movie/list?language=en-US',
  '/api/tmdb/movie/upcoming?language=en-US&page=1',
  '/api/tmdb/tv/top_rated?language=en-US&page=1',
  '/api/tmdb/discover/movie?sort_by=popularity.desc&page=1',
  '/api/tmdb/search/movie?query=batman&page=1',
  '/api/tmdb/movie/now_playing?language=en-US&page=1',
  '/api/tmdb/trending/movie/day?language=en-US&page=1'
];

(async () => {
  require('./server.js'); // require.main !== module here, so start it ourselves
  const app = require('./server.js');
  const server = app.listen(process.env.PORT);
  await new Promise(r => server.once('listening', r));
  console.log(`test server up on ${BASE}\n`);

  console.log('--- ROUND 1: 12 parallel cold requests (worst case for the ISP filter) ---');
  const r1 = await Promise.all(ENDPOINTS.map(get));
  r1.forEach(r => console.log(`${String(r.status).padEnd(4)} ${String(r.ms + 'ms').padEnd(8)} ${r.cache.padEnd(5)} ${r.staleReason ? '[stale:' + r.staleReason + '] ' : ''}${r.path}`));
  const ok1 = r1.filter(r => r.status === 200).length;
  console.log(`>>> ROUND 1: ${ok1}/${r1.length} HTTP 200`);

  console.log('\n--- ROUND 2: same 12, should be cache hits ---');
  const r2 = await Promise.all(ENDPOINTS.map(get));
  const ok2 = r2.filter(r => r.status === 200).length;
  const hits = r2.filter(r => r.cache === 'HIT').length;
  console.log(`>>> ROUND 2: ${ok2}/${r2.length} HTTP 200, ${hits} cache HIT, avg ${Math.round(r2.reduce((a, b) => a + b.ms, 0) / r2.length)}ms`);

  console.log('\n--- ROUND 3: request coalescing (10 identical parallel, uncached) ---');
  const dupe = '/api/tmdb/movie/155?language=en-US';
  const r3 = await Promise.all(Array.from({ length: 10 }, () => get(dupe)));
  const ok3 = r3.filter(r => r.status === 200).length;
  console.log(`>>> ROUND 3: ${ok3}/10 HTTP 200, titles: ${[...new Set(r3.map(r => r.json && r.json.title))].join(',')}`);

  console.log('\n--- ROUND 4: 30 mixed parallel (stress) ---');
  const many = Array.from({ length: 30 }, (_, i) => ENDPOINTS[i % ENDPOINTS.length].replace('page=1', `page=${(i % 5) + 1}`));
  const r4 = await Promise.all(many.map(get));
  const ok4 = r4.filter(r => r.status === 200).length;
  const bad = r4.filter(r => r.status !== 200);
  console.log(`>>> ROUND 4: ${ok4}/30 HTTP 200`);
  if (bad.length) bad.forEach(b => console.log(`    FAIL ${b.status} ${b.path} ${JSON.stringify(b.json)}`));

  console.log('\n--- host health ---');
  console.log(JSON.stringify((await get('/api/tmdb-health')).json, null, 2));

  const total = ok1 + ok2 + ok3 + ok4;
  console.log(`\n===== TOTAL: ${total}/${12 + 12 + 10 + 30} successful =====`);
  server.close();
  process.exit(total === 64 ? 0 : 1);
})();
