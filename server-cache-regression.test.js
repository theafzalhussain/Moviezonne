'use strict';
// Offline regressions for 70d8517: execute the real server module with telemetry,
// dotenv and external I/O disabled. Dependencies (NodeCache/axios-retry) are real.
// Run: node server-cache-regression.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const NodeCache = require('node-cache');
const axios = require('axios');
const localRequire = createRequire(__filename);
const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
function loadServer() {
  const errors = [];
  const sandbox = {
    require(id) {
      if (id === './instrument.js' || id === 'dotenv') return { config() {} };
      if (id === '@sentry/node') return { setupExpressErrorHandler() {}, captureException() {} };
      return localRequire(id);
    },
    module: { exports: {} }, __dirname, __filename: __dirname + '/server.js',
    process: { env: { TMDB_TOKEN: 'offline-test-token', API_RATE_LIMIT_MAX: '10000' }, pid: 1 },
    console: { log() {}, warn() {}, error(...args) { errors.push(args.join(' ')); } },
    URL, URLSearchParams, Buffer, AbortController, AbortSignal, Request, Response,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch() { throw new Error('Unexpected external fetch'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\n;globalThis.testInternals = { app, apiCache, staleCache, tmdbClient, tmdbForSsr, hydrateChart, fetchTmdbOnce };', sandbox, { filename: 'server.js' });
  const i = sandbox.testInternals;
  i.tmdbClient.defaults.adapter = async () => { throw new Error('Unexpected external axios call'); };
  i.errors = errors;
  i.close = () => { i.apiCache.close(); i.staleCache.close(); };
  return i;
}
function ok(config, data) { return { status: 200, statusText: 'OK', headers: {}, config, data }; }
function failure(config, status = 503) {
  return new axios.AxiosError('offline upstream failure', 'ERR_BAD_RESPONSE', config, {}, { status, headers: {}, config, data: {} });
}
function fill(cache) { cache.flushAll(); for (let n = 0; n < 2000; n++) cache.set('fill:' + n, { id: n }); }
function json(value) { return JSON.parse(JSON.stringify(value)); }
function get(server, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: url }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
(async () => {
  await check('real NodeCache maxKeys throws for both insertion and replacement at capacity', () => {
    const c = new NodeCache({ maxKeys: 1, checkperiod: 0 });
    try {
      c.set('a', 1);
      assert.throws(() => c.set('b', 2), { name: 'ECACHEFULL' });
      assert.throws(() => c.set('a', 3), { name: 'ECACHEFULL' });
    } finally { c.close(); }
  });
  for (const name of ['apiCache', 'staleCache']) {
    await check(name + ' evicts an oldest write at 2000 without throwing', () => {
      const i = loadServer(); const c = i[name];
      try { fill(c); c.set('new', { id: 2001 }); assert.equal(c.keys().length, 2000); assert.equal(c.get('new').id, 2001); assert.equal(c.get('fill:0'), undefined); }
      finally { i.close(); }
    });
    await check(name + ' refreshes an existing full-cache key without evicting another key', () => {
      const i = loadServer(); const c = i[name];
      try { fill(c); c.set('fill:10', { id: 9000 }, 60); assert.equal(c.keys().length, 2000); assert.equal(c.get('fill:0').id, 0); assert.equal(c.get('fill:10').id, 9000); assert(c.getTtl('fill:10') > Date.now()); }
      finally { i.close(); }
    });
  }
  await check('fresh and stale caches isolate nested input and output mutations', () => {
    const i = loadServer();
    try {
      const data = { results: [{ id: 7, genres: [1, 2] }] };
      i.apiCache.set('same', data); i.staleCache.set('same', data);
      data.results[0].genres.push(3);
      const hit = i.apiCache.get('same'); hit.results[0].id = 99; hit.results.push({ id: 100 });
      assert.deepEqual(json(i.apiCache.get('same')), { results: [{ id: 7, genres: [1, 2] }] });
      assert.deepEqual(json(i.staleCache.get('same')), { results: [{ id: 7, genres: [1, 2] }] });
    } finally { i.close(); }
  });
  await check('eviction tracking survives delete, expiration, flush, and repeated turnover', async () => {
    const i = loadServer(); const c = i.apiCache;
    try {
      fill(c); c.del('fill:0'); c.set('expires', 1, 0.001);
      await new Promise(r => setTimeout(r, 5)); assert.equal(c.get('expires'), undefined);
      for (let n = 0; n < 2100; n++) { c.set('next:' + n, n); assert(c.keys().length <= 2000); }
      c.flushAll(); c.set('post-flush', 9); assert.deepEqual(c.keys(), ['post-flush']);
    } finally { i.close(); }
  });
  await check('successful SSR upstream survives full fresh and stale caches', async () => {
    const i = loadServer();
    try {
      fill(i.apiCache); fill(i.staleCache);
      i.tmdbClient.defaults.adapter = async config => ok(config, { id: 550, title: 'Offline title' });
      const data = await i.tmdbForSsr('/movie/550');
      assert.equal(data.id, 550); assert.equal(i.apiCache.keys().length, 2000); assert.equal(i.staleCache.keys().length, 2000);
      assert.equal((await i.tmdbForSsr('/movie/550')).id, 550);
    } finally { i.close(); }
  });
  await check('SSR stale fallback survives caller mutation, and cold failure rejects', async () => {
    const i = loadServer(); let calls = 0;
    try {
      i.tmdbClient.defaults['axios-retry'] = { retries: 0 };
      i.tmdbClient.defaults.adapter = async config => { calls++; return ok(config, { id: 550, nested: { title: 'Good' } }); };
      const first = await i.tmdbForSsr('/movie/550'); first.nested.title = 'Changed'; i.apiCache.flushAll();
      i.tmdbClient.defaults.adapter = async config => { calls++; throw failure(config); };
      assert.equal((await i.tmdbForSsr('/movie/550')).nested.title, 'Good');
      await assert.rejects(i.tmdbForSsr('/movie/551'));
      assert.equal(calls, 3);
    } finally { i.close(); }
  });
  await check('real Express proxy serves successful cold request when both caches are full', async () => {
    const i = loadServer(); let server;
    try {
      fill(i.apiCache); fill(i.staleCache);
      i.tmdbClient.defaults.adapter = async config => ok(config, { id: 550, title: 'Offline proxy' });
      server = i.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
      const response = await get(server, '/api/tmdb/movie/550');
      assert.equal(response.status, 200); assert.equal(response.data.id, 550); assert.equal(response.headers['x-cache'], 'MISS');
    } finally { if (server) await new Promise(r => server.close(r)); i.close(); }
  });
  await check('real Express proxy serves stale on outage and errors cleanly without stale', async () => {
    const i = loadServer(); let server;
    try {
      i.tmdbClient.defaults['axios-retry'] = { retries: 0 };
      i.staleCache.set('https://api.themoviedb.org/3/movie/550', { id: 550, title: 'Last good' });
      i.tmdbClient.defaults.adapter = async config => { throw failure(config); };
      server = i.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
      const stale = await get(server, '/api/tmdb/movie/550'); assert.equal(stale.status, 200); assert.equal(stale.headers['x-cache'], 'STALE'); assert.equal(stale.data.title, 'Last good');
      const cold = await get(server, '/api/tmdb/movie/551'); assert([500, 503, 504].includes(cold.status)); assert(cold.data.error);
    } finally { if (server) await new Promise(r => server.close(r)); i.close(); }
  });
  await check('Node six-worker hydration preserves input order, compact ranks, and sources under partial failure', async () => {
    const i = loadServer(); let active = 0, peak = 0, calls = 0;
    try {
      i.tmdbClient.defaults['axios-retry'] = { retries: 0 };
      const order = Array.from({ length: 24 }, (_, n) => ({ id: n + 1, media_type: n % 2 ? 'tv' : 'movie', chartSource: n % 2 ? 'newly' : 'trending' }));
      i.tmdbClient.defaults.adapter = async config => {
        calls++; active++; peak = Math.max(peak, active);
        const id = Number(config.url.match(/\/(\d+)/)[1]);
        try { await new Promise(r => setTimeout(r, (7 - id % 7) * 2)); if (id === 4) throw failure(config, 404); return ok(config, { id, title: 'Title ' + id, poster_path: id === 9 ? null : '/p.jpg' }); }
        finally { active--; }
      };
      const cards = await i.hydrateChart(order);
      assert.equal(peak, 6); assert.equal(calls, 24);
      assert.deepEqual(json(cards.map(c => c.id)), order.filter(e => ![4, 9].includes(e.id)).map(e => e.id));
      cards.forEach((c, n) => { assert.equal(c._chartRank, n + 1); assert.equal(c._chartSource, order[c.id - 1].chartSource); });
      assert.deepEqual(json(await i.hydrateChart([])), []);
    } finally { i.close(); }
  });
  await check('actual axios-retry makes at most three attempts sharing the 5000ms budget and switches host on reset', async () => {
    const i = loadServer(); const seen = []; const started = Date.now();
    try {
      assert.equal(i.tmdbClient.defaults.timeout, 5000);
      i.tmdbClient.defaults.adapter = async config => {
        seen.push({ timeout: config.timeout, baseURL: config.baseURL });
        await new Promise(r => setTimeout(r, 20));
        throw new axios.AxiosError('offline reset', 'ECONNRESET', config);
      };
      await assert.rejects(i.tmdbForSsr('/movie/1'));
      assert.equal(seen.length, 3); assert.equal(seen[0].timeout, 5000);
      assert(seen[1].timeout < seen[0].timeout); assert(seen[2].timeout < seen[1].timeout);
      assert.notEqual(seen[1].baseURL, seen[0].baseURL); assert(Date.now() - started < 5000);
      console.log('  OBSERVED retry attempt budgets: ' + seen.map(s => s.timeout).join(', ') + ' ms');
    } finally { i.close(); }
  });
  await check('exhausted axios shared timeout does not grant another 5s attempt; stale fallback still works', async () => {
    const i = loadServer(); let calls = 0; const started = Date.now();
    try {
      i.staleCache.set('https://api.themoviedb.org/3/movie/1', { id: 1, title: 'Fallback' });
      i.tmdbClient.defaults.adapter = config => new Promise((resolve, reject) => {
        calls++; setTimeout(() => reject(new axios.AxiosError('offline timeout', 'ECONNABORTED', config)), config.timeout);
      });
      assert.equal((await i.tmdbForSsr('/movie/1')).title, 'Fallback');
      assert.equal(calls, 1); const elapsed = Date.now() - started; assert(elapsed >= 4900 && elapsed < 7000);
      console.log('  OBSERVED exhausted request: ' + elapsed + ' ms, ' + calls + ' attempt');
    } finally { i.close(); }
  });
  await check('Retry-After beyond the shared axios budget is not slept or retried', async () => {
    const i = loadServer(); let calls = 0; const started = Date.now();
    try {
      i.tmdbClient.defaults.adapter = async config => { calls++; const e = failure(config, 429); e.response.headers['retry-after'] = '10'; throw e; };
      await assert.rejects(i.tmdbForSsr('/movie/1')); assert.equal(calls, 1); assert(Date.now() - started < 1000);
    } finally { i.close(); }
  });
  console.log('\nserver-cache-regression: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
