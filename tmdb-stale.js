// Verifies graceful degradation: when TMDB is completely unreachable, the proxy must
// serve the last known-good payload (X-Cache: STALE) instead of a 503 error page.
process.env.PORT = '3997';
require('dotenv').config();
const http = require('http');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const TARGET = '/api/tmdb/movie/680?language=en-US';

function get(path) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({
        status: res.statusCode, ms: Date.now() - t0,
        cache: res.headers['x-cache'] || '-',
        reason: res.headers['x-stale-reason'] || '',
        json: (() => { try { return JSON.parse(body); } catch { return null; } })()
      }));
    });
    req.on('error', e => resolve({ status: 'ERR', err: e.code, ms: Date.now() - t0 }));
  });
}

(async () => {
  const app = require('./server.js');
  const server = app.listen(process.env.PORT);
  await new Promise(r => server.once('listening', r));
  const I = app.locals.tmdbInternals;
  let failures = 0;
  const check = (label, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
    if (!cond) failures++;
  };

  // 1. Prime the caches with a real response.
  const fresh = await get(TARGET);
  check('live fetch returns 200 + real data', fresh.status === 200 && fresh.json?.title === 'Pulp Fiction',
    `status=${fresh.status} cache=${fresh.cache} title=${fresh.json && fresh.json.title}`);

  // 2. Drop the hot cache but keep the 24h stale copy, then black-hole every TMDB host.
  I.apiCache.flushAll();
  const realHosts = [...I.TMDB_HOSTS];
  const BLACK_HOLE = '127.0.0.1:9'; // discard port — instant ECONNREFUSED
  I.TMDB_HOSTS.splice(0, I.TMDB_HOSTS.length, BLACK_HOLE);
  I.hostHealth.set(BLACK_HOLE, { fails: 0, penaltyUntil: 0 });
  I.setActiveHost(BLACK_HOLE, 'test: simulated total outage');

  console.log('\n(simulating total TMDB outage — expect STALE, not 503)');
  const staleResp = await get(TARGET);
  check('outage still answers 200 from stale cache',
    staleResp.status === 200 && staleResp.cache === 'STALE' && staleResp.json?.title === 'Pulp Fiction',
    `status=${staleResp.status} cache=${staleResp.cache} reason=${staleResp.reason}`);

  // 3. An endpoint with no stale copy must surface a clean 503/504, not a hang.
  const cold = await get('/api/tmdb/movie/13?language=en-US');
  check('uncached endpoint during outage returns a clean error',
    [503, 504, 500].includes(cold.status) && cold.json?.error,
    `status=${cold.status} body=${JSON.stringify(cold.json)}`);

  // 4. Restore hosts and confirm recovery.
  I.TMDB_HOSTS.splice(0, I.TMDB_HOSTS.length, ...realHosts);
  realHosts.forEach(h => I.hostHealth.set(h, { fails: 0, penaltyUntil: 0 }));
  I.setActiveHost(realHosts[0], 'test: outage over');
  await I.probeTmdbHosts({ samples: 2, quiet: true });
  I.apiCache.flushAll();
  const recovered = await get('/api/tmdb/movie/13?language=en-US');
  check('recovers to live data after hosts return',
    recovered.status === 200 && recovered.cache === 'MISS' && !!recovered.json?.title,
    `status=${recovered.status} cache=${recovered.cache} title=${recovered.json && recovered.json.title}`);

  server.close();
  console.log(`\n===== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} =====`);
  process.exit(failures === 0 ? 0 : 1);
})();
