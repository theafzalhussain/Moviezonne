/*  ═══════════════════════════════════════════════════════════════════════════
 *  img-fallback-check.js — posters on networks that block image.tmdb.org
 *  ═══════════════════════════════════════════════════════════════════════════
 *  The reported failure: on some Indian networks (Jio and Airtel most often)
 *  titles, ratings and years render — they come through our own /api/tmdb — but
 *  every poster stays an empty placeholder, because image.tmdb.org itself is
 *  blocked, reset or blackholed. Three layers answer it, and each is held to its
 *  contract here:
 *
 *    1. /api/img/<size>/<file>  (server.js; worker.js and netlify.toml mirror it)
 *       relays TMDB images only — fixed upstream host, TMDB size tokens and
 *       hash-style names — so it can never become an open proxy, and it relays
 *       nothing but image bodies.
 *    2. sw.js retries a failed direct image through /api/img, penalises the direct
 *       host only after two failures in a row, never treats a 404 as a block, and
 *       stores nothing it cannot read (the old cache held opaque responses).
 *    3. moviezone.js does the same for pages the worker does not control yet:
 *       a failed poster is retried once, every pending image switches over only
 *       when failures outnumber successes, and that is remembered only once the
 *       fallback has actually delivered.
 *
 *  Offline by default: TMDB is stubbed in-process and intercepted in the browser.
 *  `--online` adds one end-to-end relay of a real poster through server.js.
 *  The browser section skips loudly (never a false pass) without Chrome/Edge.
 *
 *  Run: node img-fallback-check.js [--online]
 *  ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const ONLINE = process.argv.includes('--online');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*  A real-sized (200x300) PNG, built here so nothing touches the network. Not 1x1:
 *  chosen from a "185w" srcset candidate for a 120px slot, an image's naturalWidth
 *  is divided by that density (1.54), and a 1px image rounds to 0 — which every
 *  "is it broken?" test, the app's included, reads as a failed load. */
function makePng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0;                                 // 8-bit greyscale
  const raw = Buffer.alloc((width + 1) * height, 0x55);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;  // filter: none
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(200, 300);
const POSTER = 'qJ2tW6WMUDux911r6m7haRef0WH.jpg';

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + label);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + label + '\n        ' + ((err && err.message) || err));
  }
}

const serverSrc = read('server.js');
const workerSrc = read('worker.js');
const swSrc = read('sw.js');
const mzSrc = read('moviezone.js');

/* ── 1. every deployment target answers the same route the same way ──────── */
async function configChecks() {
  console.log('\n-- one route, every deployment target --------------------------');

  await check('server.js and worker.js accept exactly the same image paths', () => {
    const sizesM = serverSrc.match(/const TMDB_IMG_SIZES = new Set\((\[[^\]]+\])\)/);
    const fileM = serverSrc.match(/const TMDB_IMG_FILE = (\/.+\/);/);
    const routeM = workerSrc.match(/const TMDB_IMG_ROUTE =\s*(\/.+\/);/);
    assert(sizesM && fileM && routeM, 'TMDB_IMG_SIZES / TMDB_IMG_FILE (server.js) or TMDB_IMG_ROUTE (worker.js) not found');
    const sizes = new Set(vm.runInNewContext(sizesM[1]));
    const fileRe = vm.runInNewContext('(' + fileM[1] + ')');
    const route = vm.runInNewContext('(' + routeM[1] + ')');
    const sizeSamples = ['w45', 'w92', 'w185', 'w342', 'w500', 'w780', 'w1280', 'h632', 'original', 'w9999', 'W342', 'w342x', '..', 'w600_and_h900_bestv2'];
    const fileSamples = [POSTER, 'abcdef.png', 'abc-def_gh.webp', 'logo123.svg', 'a.jpg', 'abc..jpg', 'evil.html',
      'x'.repeat(65) + '.jpg', '..%2F..%2Fserver.js', 'abcdef.jpg.html', 'abcdef.JPG'];
    for (const s of sizeSamples) {
      for (const f of fileSamples) {
        const viaServer = sizes.has(s) && fileRe.test(f);
        const viaWorker = route.test('/api/img/' + s + '/' + f);
        assert.strictEqual(viaWorker, viaServer, '/api/img/' + s + '/' + f + ': server.js ' + (viaServer ? 'accepts' : 'rejects')
          + ' it, worker.js ' + (viaWorker ? 'accepts' : 'rejects') + ' it');
      }
    }
  });

  await check('the Worker dispatches /api/img/ before the TMDB data proxy', () => {
    const img = workerSrc.indexOf("pathname.startsWith('/api/img/')");
    const tmdb = workerSrc.indexOf("pathname.startsWith('/api/tmdb/')", workerSrc.indexOf('async function routeApi'));
    assert(img > 0 && tmdb > 0 && img < tmdb, 'routeApi() no longer routes /api/img/ ahead of /api/tmdb/');
  });

  await check('Cloudflare, Vercel and Netlify all hand /api/img/ to a handler', () => {
    const wrangler = read('wrangler.jsonc');
    const first = wrangler.match(/"run_worker_first"\s*:\s*\[([\s\S]*?)\]/);
    assert(first && /"\/api\/\*"/.test(first[1]), 'wrangler.jsonc run_worker_first lost "/api/*": the asset router would answer /api/img/ with index.html');
    assert(/"source"\s*:\s*"\/api\/\(\.\*\)"/.test(read('vercel.json')), 'vercel.json no longer rewrites /api/(.*) to the function');
    assert(/from = "\/api\/img\/\*"\s*\n\s*to = "https:\/\/image\.tmdb\.org\/t\/p\/:splat"\s*\n\s*status = 200/.test(read('netlify.toml')),
      'netlify.toml has no /api/img/* -> image.tmdb.org/t/p/:splat rewrite');
  });
}

/* ── 2. the route itself (server.js, in-process) ─────────────────────────── */
async function routeChecks() {
  console.log('\n-- /api/img in server.js ---------------------------------------');

  // Requiring server.js must not send traces to the real Sentry project, nor
  // connect to the real database: instrument.js is pre-empted, MongoDB is off
  // (dotenv never overrides a variable that is already set).
  const instrumentPath = require.resolve('./instrument.js');
  require.cache[instrumentPath] = { id: instrumentPath, filename: instrumentPath, loaded: true, exports: {}, children: [] };
  process.env.MONGODB_URI = '';
  process.env.IMG_RATE_LIMIT_MAX = '100000';

  // TMDB is stubbed: every image request server.js makes lands here.
  const axios = require('axios');
  const realGet = axios.get;
  const upstream = { mode: 'ok', calls: [], closed: false };
  const WEBP = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.alloc(64, 7)]);
  axios.get = function stubbedGet(url, config) {
    if (typeof url !== 'string' || url.indexOf('https://image.tmdb.org/') !== 0) return realGet.apply(this, arguments);
    upstream.calls.push({ url, config });
    if (upstream.mode === 'real') return realGet.apply(this, arguments);
    const body = (chunks) => Readable.from(chunks);
    switch (upstream.mode) {
      case 'ok':
        return Promise.resolve({ status: 200, headers: { 'content-type': 'image/webp', 'content-length': String(WEBP.length) }, data: body([WEBP]) });
      case 'gzip': {
        const gz = zlib.gzipSync(WEBP);
        return Promise.resolve({ status: 200, headers: { 'content-type': 'image/webp', 'content-encoding': 'gzip', 'content-length': String(gz.length) }, data: body([gz]) });
      }
      case '404':
        return Promise.resolve({ status: 404, headers: { 'content-type': 'text/html' }, data: body(['<html>not found</html>']) });
      case 'html200':
        return Promise.resolve({ status: 200, headers: { 'content-type': 'text/html' }, data: body(['<script>alert(1)</script>']) });
      case 'throw':
        return Promise.reject(Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }));
      case 'slow': {
        let sent = false;
        const s = new Readable({ read() { if (!sent) { sent = true; this.push(Buffer.alloc(4096, 1)); } } });
        s.on('close', () => { upstream.closed = true; });
        return Promise.resolve({ status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '10485760' }, data: s });
      }
      default:
        return Promise.reject(new Error('unknown stub mode ' + upstream.mode));
    }
  };

  const app = require('./server.js');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;
  const get = (p, headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  try {
    await check('anything that is not a TMDB size + hash-style name is refused before TMDB is asked', async () => {
      upstream.calls.length = 0;
      for (const p of ['/api/img/w9999/' + POSTER, '/api/img/w342/a.jpg', '/api/img/w342/evil.html',
        '/api/img/w342/..%2F..%2Fserver.js', '/api/img/original/abcdef.jpg.html', '/api/img/W342/' + POSTER]) {
        const r = await get(p);
        assert.strictEqual(r.status, 404, p + ' answered ' + r.status);
        assert(!/^image\//.test(r.headers['content-type'] || ''), p + ' answered with an image body');
      }
      const deeper = await get('/api/img/w342/' + POSTER + '/extra');
      assert.notStrictEqual(deeper.status, 200, 'a deeper path was answered 200');
      assert.strictEqual(upstream.calls.length, 0, 'TMDB was contacted ' + upstream.calls.length + ' time(s) for refused paths');
    });

    await check('a poster is relayed byte-for-byte, immutable, with the requested format', async () => {
      upstream.mode = 'ok'; upstream.calls.length = 0;
      const r = await get('/api/img/w342/' + POSTER, { Accept: 'image/avif,image/webp,*/*' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers['content-type'], 'image/webp');
      assert(r.body.equals(WEBP), 'the body differs from what TMDB sent');
      assert.strictEqual(r.headers['content-length'], String(WEBP.length));
      assert(/immutable/.test(r.headers['cache-control'] || ''), 'not cacheable as immutable: ' + r.headers['cache-control']);
      assert(/accept/i.test(r.headers.vary || ''), 'Vary: Accept is missing, so a shared cache could hand WebP to a browser that cannot show it');
      assert(/sandbox/.test(r.headers['content-security-policy'] || ''), 'no sandbox CSP: a relayed SVG opened as a document could run script on our origin');
      assert.strictEqual(upstream.calls[0].url, 'https://image.tmdb.org/t/p/w342/' + POSTER, 'the upstream URL changed');
      assert(/image\/webp/.test(upstream.calls[0].config.headers.Accept), 'the browser\'s WebP preference was not passed on');
      const jpeg = await get('/api/img/w185/' + POSTER, { Accept: '*/*' });
      assert.strictEqual(jpeg.status, 200);
      assert(!/webp/.test(upstream.calls[1].config.headers.Accept), 'WebP was requested for a browser that did not ask for it');
    });

    await check('an encoded upstream body keeps its encoding, so Content-Length still matches', async () => {
      upstream.mode = 'gzip';
      const r = await get('/api/img/w342/' + POSTER, { Accept: 'image/webp' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers['content-encoding'], 'gzip', 'Content-Encoding was dropped');
      assert.strictEqual(Number(r.headers['content-length']), r.body.length, 'Content-Length does not match the bytes sent');
      assert(zlib.gunzipSync(r.body).equals(WEBP), 'the relayed bytes are not the upstream bytes');
    });

    await check('TMDB errors and non-image bodies are never relayed from our origin', async () => {
      upstream.mode = '404';
      const missing = await get('/api/img/w342/' + POSTER);
      assert.strictEqual(missing.status, 404, 'a TMDB 404 became ' + missing.status);
      assert.strictEqual(missing.body.length, 0, 'TMDB\'s HTML error page was relayed');
      upstream.mode = 'html200';
      const html = await get('/api/img/w342/' + POSTER);
      assert.strictEqual(html.status, 502, 'a 200 text/html from upstream became ' + html.status);
      assert(!/alert/.test(html.body.toString()), 'an HTML body was relayed as-is');
      upstream.mode = 'throw';
      const down = await get('/api/img/w342/' + POSTER);
      assert.strictEqual(down.status, 504, 'an upstream timeout became ' + down.status);
    });

    await check('a viewer who goes away stops the upstream download with them', async () => {
      upstream.mode = 'slow'; upstream.closed = false; upstream.calls.length = 0;
      await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/img/w780/' + POSTER }, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', () => {});
        setTimeout(() => reject(new Error('no first chunk within 3s')), 3000);
      });
      for (let i = 0; i < 30 && !upstream.closed; i++) await sleep(50);
      assert(upstream.closed, 'the upstream stream kept running after the client disconnected');
      const signal = upstream.calls[0].config.signal;
      assert(signal && signal.aborted, 'the upstream request was not aborted');
    });

    if (ONLINE) {
      await check('[online] a real TMDB poster comes through intact', async () => {
        upstream.mode = 'real';
        const webp = await get('/api/img/w342/' + POSTER, { Accept: 'image/avif,image/webp,*/*' });
        assert.strictEqual(webp.status, 200, 'answered ' + webp.status);
        assert.strictEqual(webp.headers['content-type'], 'image/webp');
        assert.strictEqual(Number(webp.headers['content-length']), webp.body.length, 'Content-Length does not match the body');
        assert(webp.body.slice(0, 4).toString('latin1') === 'RIFF', 'the body is not a WebP file');
        const jpeg = await get('/api/img/w342/' + POSTER, { Accept: '*/*' });
        assert.strictEqual(jpeg.headers['content-type'], 'image/jpeg');
        assert(jpeg.body[0] === 0xff && jpeg.body[1] === 0xd8, 'the body is not a JPEG file');
      });
    }
  } finally {
    axios.get = realGet;
    await new Promise((r) => server.close(r));
  }
}

/* ── 3. the service worker's image branch (vm sandbox, fake network) ─────── */
const ORIGIN = 'https://moviezone.test';
const TMDB = 'https://image.tmdb.org/t/p/';
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function loadSw(route, source) {
  const calls = [];
  const stores = new Map();
  const keyOf = (r) => (typeof r === 'string' ? new URL(r, ORIGIN).href : r.url);
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (r) => { const hit = m.get(keyOf(r)); return hit ? hit.clone() : undefined; },
      put: async (r, res) => { m.set(keyOf(r), res); },
      keys: async () => [...m.keys()].map((u) => new Request(u)),
      delete: async (r) => m.delete(keyOf(r)),
      addAll: async () => {},
      add: async () => {}
    };
  };
  const caches = {
    open: async (n) => open(n),
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
    has: async (n) => stores.has(n),
    match: async () => undefined
  };
  const fakeFetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(new URL(String(input), ORIGIN).href, init);
    const answer = route(req, calls);
    calls.push({ url: req.url, mode: req.mode, credentials: req.credentials, accept: req.headers.get('accept'), answer });
    if (answer === 'fail') throw new TypeError('Failed to fetch');
    if (answer === 'hang') {
      return new Promise((resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    }
    if (typeof answer === 'number') return new Response('error ' + answer, { status: answer, headers: { 'Content-Type': 'text/html' } });
    return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  const handlers = {};
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    location: new URL(ORIGIN + '/sw.js'),
    clients: { claim: async () => {}, matchAll: async () => [] },
    registration: { navigationPreload: null },
    skipWaiting: async () => {}
  };
  const sandbox = { self, caches, fetch: fakeFetch, Request, Response, Headers, URL, AbortController, DOMException, setTimeout, clearTimeout, console: quiet };
  vm.createContext(sandbox);
  vm.runInContext(source || swSrc, sandbox, { filename: 'sw.js' });
  const state = (expr) => vm.runInContext(expr, sandbox);
  return { handlers, calls, stores, state, imageCache: () => stores.get(state('IMAGE_CACHE')) || new Map() };
}

async function swFetch(sw, url) {
  let request;
  const accept = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
  try { request = new Request(url, { mode: 'no-cors', headers: { Accept: accept } }); }
  catch (e) { request = new Request(url, { headers: { Accept: accept } }); }
  const waits = [];
  let responded = null;
  sw.handlers.fetch({
    request,
    respondWith: (p) => { responded = Promise.resolve(p); },
    waitUntil: (p) => { waits.push(Promise.resolve(p).catch(() => {})); }
  });
  let response = null;
  let error = null;
  if (responded) { try { response = await responded; } catch (e) { error = e; } }
  await Promise.all(waits);
  return { responded: !!responded, response, error };
}

const isDirect = (req) => req.url.indexOf('https://image.tmdb.org/') === 0;
const directCalls = (sw) => sw.calls.filter((c) => c.url.indexOf('https://image.tmdb.org/') === 0);
const proxyCalls = (sw) => sw.calls.filter((c) => c.url.indexOf(ORIGIN + '/api/img/') === 0);

async function swChecks() {
  console.log('\n-- sw.js: direct first, /api/img when the host is blocked ------');

  await check('the image cache is not the v1 cache that was filled with opaque responses', () => {
    const m = swSrc.match(/const IMAGE_CACHE = '([^']+)'/);
    assert(m, 'IMAGE_CACHE not found');
    assert.notStrictEqual(m[1], 'moviezone-tmdb-images-v1', 'IMAGE_CACHE is still v1: its opaque entries (and their quota padding) would survive');
    const branch = swSrc.slice(swSrc.indexOf('if (isTmdbImage(url))'), swSrc.indexOf('EVERYTHING ELSE CROSS-ORIGIN'));
    assert(branch.length > 200, 'TMDB image branch not found');
    assert(!/type === 'opaque'/.test(branch), 'the image branch accepts opaque responses again');
  });

  await check('activate() deletes the v1 image cache and keeps the current one', async () => {
    const sw = loadSw(() => 'ok');
    const names = ['moviezone-tmdb-images-v1', sw.state('IMAGE_CACHE'), sw.state('CACHE_NAME'), 'moviezone-v1'];
    for (const n of names) sw.stores.set(n, new Map([['x', new Response('x')]]));
    let done = null;
    sw.handlers.activate({ waitUntil: (p) => { done = p; } });
    await done;
    assert(!sw.stores.has('moviezone-tmdb-images-v1'), 'the v1 image cache survived activate()');
    assert(!sw.stores.has('moviezone-v1'), 'an old shell cache survived activate()');
    assert(sw.stores.has(sw.state('IMAGE_CACHE')), 'activate() deleted the CURRENT image cache');
    assert(sw.stores.has(sw.state('CACHE_NAME')), 'activate() deleted the current shell cache');
  });

  await check('a healthy host: one readable CORS request, stored, then served from cache', async () => {
    const sw = loadSw(() => 'ok');
    const url = TMDB + 'w342/healthyPoster01.jpg';
    const first = await swFetch(sw, url);
    assert(first.responded && first.response && first.response.status === 200, 'no 200 for a healthy poster');
    assert.strictEqual(sw.calls.length, 1, 'expected exactly one network request, saw ' + sw.calls.length);
    assert.strictEqual(sw.calls[0].url, url);
    assert.strictEqual(sw.calls[0].mode, 'cors', 'the direct request is ' + sw.calls[0].mode + ', so its status is unreadable and errors get cached');
    assert.strictEqual(sw.calls[0].credentials, 'omit');
    assert(/image\/webp/.test(sw.calls[0].accept || ''), 'the page\'s Accept header was lost, so TMDB would answer JPEG instead of WebP');
    assert(sw.imageCache().has(url), 'the poster was not stored');
    const second = await swFetch(sw, url);
    assert(second.response && second.response.status === 200);
    assert.strictEqual(sw.calls.length, 1, 'a cached poster was fetched again');
    assert.strictEqual(proxyCalls(sw).length, 0, '/api/img was used on a healthy network');
  });

  await check('a blocked host: each poster still arrives, and after two failures in a row the direct try is skipped', async () => {
    const sw = loadSw((req) => (isDirect(req) ? 'fail' : 'ok'));
    const a = await swFetch(sw, TMDB + 'w342/blockedPosterA.jpg');
    assert(a.response && a.response.status === 200, 'poster A did not arrive through the fallback');
    assert.deepStrictEqual(sw.calls.map((c) => c.url), [TMDB + 'w342/blockedPosterA.jpg', ORIGIN + '/api/img/w342/blockedPosterA.jpg']);
    assert(sw.imageCache().has(TMDB + 'w342/blockedPosterA.jpg'), 'the fallback bytes were not stored under the poster\'s own URL');
    assert.strictEqual(sw.state('tmdbDirectSkipUntil'), 0, 'ONE failure already penalised the direct host');
    await swFetch(sw, TMDB + 'w500/blockedPosterB.jpg');
    const until = sw.state('tmdbDirectSkipUntil');
    assert(until > Date.now() + 9 * 60 * 1000, 'two failures in a row did not skip the direct host (skipUntil=' + until + ')');
    const before = directCalls(sw).length;
    const c = await swFetch(sw, TMDB + 'w185/blockedPosterC.jpg');
    assert(c.response && c.response.status === 200, 'poster C did not arrive');
    assert.strictEqual(directCalls(sw).length, before, 'the direct host was tried again inside the penalty window');
    assert.strictEqual(proxyCalls(sw).length, 3);
  });

  await check('a 404 is an answer about one file, not a blocked host', async () => {
    const sw = loadSw((req) => (isDirect(req) ? (/missing/.test(req.url) ? 404 : 'ok') : 'ok'));
    const one = await swFetch(sw, TMDB + 'w342/missingPoster1.jpg');
    const two = await swFetch(sw, TMDB + 'w342/missingPoster2.jpg');
    assert(one.response.status === 404 && two.response.status === 404, 'a missing poster did not come back as 404');
    assert.strictEqual(proxyCalls(sw).length, 0, 'a 404 was retried through /api/img');
    assert.strictEqual(sw.state('tmdbDirectSkipUntil'), 0, '404s penalised the direct host');
    assert(!sw.imageCache().has(TMDB + 'w342/missingPoster1.jpg'), 'a 404 was cached');
    await swFetch(sw, TMDB + 'w342/presentPoster3.jpg');
    assert.strictEqual(directCalls(sw).length, 3, 'the direct host was skipped after 404s');
  });

  await check('one unlucky request between successes never penalises the host', async () => {
    let n = 0;
    const sw = loadSw((req) => (isDirect(req) ? ((n++ % 2 === 0) ? 'fail' : 'ok') : 'ok'));
    for (let i = 0; i < 6; i++) {
      const r = await swFetch(sw, TMDB + 'w342/flakyPoster' + i + '.jpg');
      assert(r.response && r.response.status === 200, 'flaky poster ' + i + ' did not arrive');
    }
    assert.strictEqual(sw.state('tmdbDirectSkipUntil'), 0, 'alternating failures penalised the host');
    assert.strictEqual(directCalls(sw).length, 6, 'the direct host was skipped although it kept working');
  });

  await check('server errors and a hung connection both fall back', async () => {
    const sw = loadSw((req) => (isDirect(req) ? 503 : 'ok'));
    const r = await swFetch(sw, TMDB + 'w342/errorPoster.jpg');
    assert(r.response && r.response.status === 200, 'a TMDB 503 was handed to the page instead of the fallback');
    const timeout = swSrc.match(/const TMDB_DIRECT_TIMEOUT_MS = (\d+);/);
    assert(timeout && Number(timeout[1]) >= 5000 && Number(timeout[1]) <= 15000, 'TMDB_DIRECT_TIMEOUT_MS is missing or outside 5-15 s');
    const fast = swSrc.replace(timeout[0], 'const TMDB_DIRECT_TIMEOUT_MS = 60;');
    const hung = loadSw((req) => (isDirect(req) ? 'hang' : 'ok'), fast);
    const t0 = Date.now();
    const h = await swFetch(hung, TMDB + 'w342/hungPoster.jpg');
    assert(h.response && h.response.status === 200, 'a hung direct request never fell back');
    assert(Date.now() - t0 < 2000, 'the fallback waited ' + (Date.now() - t0) + 'ms for a 60ms timeout');
  });

  await check('same-origin /api/img requests are cached when they succeed and only then', async () => {
    const sw = loadSw((req) => (/missingProxied/.test(req.url) ? 404 : 'ok'));
    const ok = await swFetch(sw, ORIGIN + '/api/img/w342/proxiedPoster1.jpg');
    assert(ok.responded, 'the /api/ bypass swallowed /api/img/, so fallback posters are never cached');
    assert.strictEqual(ok.response.status, 200);
    assert(sw.imageCache().has(ORIGIN + '/api/img/w342/proxiedPoster1.jpg'), 'a proxied poster was not cached');
    const missing = await swFetch(sw, ORIGIN + '/api/img/w342/missingProxied.jpg');
    assert.strictEqual(missing.response.status, 404);
    assert(!sw.imageCache().has(ORIGIN + '/api/img/w342/missingProxied.jpg'), 'a 404 from /api/img was cached');
    const data = await swFetch(sw, ORIGIN + '/api/tmdb/movie/popular');
    assert(!data.responded, 'the TMDB data proxy is now handled by the worker; its freshness belongs to moviezone.js');
  });

  await check('a TMDB path /api/img cannot carry goes to the network as the browser asked', async () => {
    // First attempt (the CORS try) fails, the second (the page's own request) works.
    const sw = loadSw((req, calls) => (calls.length === 0 ? 'fail' : 'ok'));
    const r = await swFetch(sw, TMDB + 'w600_and_h900_bestv2/oddSizePoster.jpg');
    assert(r.response && r.response.status === 200, 'an odd-size poster was lost');
    assert.strictEqual(proxyCalls(sw).length, 0, 'an odd-size poster was sent to /api/img, which refuses that size');
    assert.strictEqual(sw.calls.length, 2, 'expected the CORS try and then the original request');
    assert.strictEqual(sw.state('tmdbDirectSkipUntil'), 0, 'a path without a fallback penalised the host');
  });
}

/* ── 4. the in-page fallback, in a real browser ──────────────────────────── */
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const findBrowser = () => BROWSER_CANDIDATES.find((c) => c && fs.existsSync(c)) || null;

function closeBrowser(proc, dir) {
  return new Promise((resolve) => {
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {}
      resolve();
    };
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) { remove(); return; }
    proc.once('exit', remove);
    setTimeout(remove, 5000).unref();
    try { proc.kill(); } catch (e) { remove(); }
  });
}

async function openBrowser(binary) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mzimg-'));
  const child = spawn(binary, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--remote-debugging-port=0', '--window-size=1280,800',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let endpoint = null;
  for (let i = 0; i < 150 && !endpoint; i++) {
    await sleep(100);
    try {
      const [port, wsPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      if (port && wsPath) endpoint = 'ws://127.0.0.1:' + port.trim() + wsPath.trim();
    } catch (e) { /* not written yet */ }
  }
  if (!endpoint) { await closeBrowser(child, profile); throw new Error('the browser never exposed a DevTools endpoint'); }
  const WS = globalThis.WebSocket || require('undici').WebSocket;
  const ws = new WS(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    listeners.forEach((fn) => fn(msg));
  });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
  return { child, profile, ws, send, on: (fn) => listeners.push(fn) };
}

function pageHtml(p) {
  const hero = p + 'hero.jpg';
  const posters = [1, 2, 3, 4, 5, 6].map((i) => {
    const f = p + 'poster' + i + '.jpg';
    return '<img class="poster" data-f="' + f + '" src="' + TMDB + 'w342/' + f + '" srcset="' + TMDB + 'w185/' + f
      + ' 185w, ' + TMDB + 'w342/' + f + ' 342w" sizes="120px" width="120" height="180" alt="">';
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><title>img fallback</title></head><body>'
    + '<picture id="pic"><source media="(max-width: 1024px)" srcset="' + TMDB + 'w780/' + hero + '">'
    + '<source media="(min-width: 1025px)" srcset="' + TMDB + 'w1280/' + hero + '">'
    + '<img id="hero" data-f="' + hero + '" src="' + TMDB + 'w1280/' + hero + '" fetchpriority="high" width="320" height="180" alt=""></picture>'
    + posters + '<script defer src="/fallback.js"></script></body></html>';
}

const PROBE = `(() => ({
  on: _mzImgProxyOn, fails: _mzImgFails, ok: _mzImgOk,
  flag: localStorage.getItem('mz_img_proxy_until'),
  imgs: Array.from(document.images).map((i) => ({ f: i.getAttribute('data-f') || i.id, src: i.getAttribute('src'),
    srcset: i.getAttribute('srcset'), mode: i.getAttribute('data-mz-img'), w: i.naturalWidth, complete: i.complete })),
  sources: Array.from(document.querySelectorAll('#pic source')).map((s) => s.getAttribute('srcset'))
}))()`;

async function browserChecks() {
  console.log('\n-- moviezone.js: the in-page fallback (headless browser) -------');
  const binary = findBrowser();
  if (!binary) {
    console.log('  SKIPPED: no Chrome/Edge binary found — the in-page fallback was NOT exercised.');
    return;
  }

  const start = mzSrc.indexOf('const MZ_TMDB_IMG_RE');
  const endMarker = '}, 12000);';
  const end = mzSrc.indexOf(endMarker, start);
  let block = null;
  await check('the in-page fallback block is present and self-contained', () => {
    assert(start > 0 && end > start, 'could not find the block from MZ_TMDB_IMG_RE to the 12 s watchdog in moviezone.js');
    block = mzSrc.slice(start, end + endMarker.length);
    assert.strictEqual(block.split(endMarker).length, 2, 'the watchdog timer is ambiguous');
  });
  if (!block) return;

  const st = { html: '', script: block, scriptDelayMs: 0, tmdb: () => 'ok', proxyMissing: new Set(), tmdbHits: [], proxyHits: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/fallback.js') {
      const send = () => { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(st.script); };
      if (st.scriptDelayMs) setTimeout(send, st.scriptDelayMs); else send();
      return;
    }
    const m = /^\/api\/img\/(w\d+|h\d+|original)\/([A-Za-z0-9_-]+\.jpg)$/.exec(u.pathname);
    if (m) {
      st.proxyHits.push(m[2]);
      if (st.proxyMissing.has(m[2])) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(PNG);
      return;
    }
    if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(st.html); return; }
    if (u.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end('<!doctype html><title>blank</title>'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  let cdp = null;
  try {
    cdp = await openBrowser(binary);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => cdp.send(method, params, sessionId);
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId || msg.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = msg.params;
      const file = request.url.split('/').pop();
      st.tmdbHits.push(file);
      const answer = st.tmdb(file);
      if (answer === 'hang') return;                       // never answered: a blackholed host
      if (answer === 'fail') { S('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }).catch(() => {}); return; }
      const ok = answer === 'ok';
      S('Fetch.fulfillRequest', {
        requestId,
        responseCode: ok ? 200 : answer,
        responseHeaders: [{ name: 'Content-Type', value: ok ? 'image/png' : 'text/html' }, { name: 'Cache-Control', value: 'no-store' }],
        body: (ok ? PNG : Buffer.from('not found')).toString('base64')
      }).catch(() => {});
    });
    await S('Page.enable');
    await S('Runtime.enable');
    await S('Network.enable');
    await S('Network.setCacheDisabled', { cacheDisabled: true });
    await S('Fetch.enable', { patterns: [{ urlPattern: 'https://image.tmdb.org/*', requestStage: 'Request' }] });

    const evaluate = async (expression) => {
      const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    };
    const waitFor = async (expression, ms, what) => {
      const t0 = Date.now();
      for (;;) {
        try { if (await evaluate(expression)) return; } catch (e) { /* navigating */ }
        if (Date.now() - t0 > ms) {
          let state = '';
          try {
            const s = await evaluate(PROBE);
            state = '\n        state: on=' + s.on + ' fails=' + s.fails + ' ok=' + s.ok + ' flag=' + s.flag
              + '\n        ' + s.imgs.map((i) => (i.f || '?').slice(-12) + ' ' + (i.mode || 'direct') + ' w=' + i.w + (i.complete ? '' : ' pending') + ' ' + String(i.src).slice(0, 48)).join('\n        ')
              + '\n        tmdb requests: ' + st.tmdbHits.length + ', /api/img requests: ' + st.proxyHits.length;
          } catch (e) { state = ' (page state unavailable: ' + e.message + ')'; }
          throw new Error('timed out after ' + ms + 'ms waiting for ' + what + state);
        }
        await sleep(100);
      }
    };
    const open = async (scenario, opts) => {
      Object.assign(st, { scriptDelayMs: 0, tmdb: () => 'ok', proxyMissing: new Set(), tmdbHits: [], proxyHits: [], script: block }, opts);
      st.html = pageHtml(scenario.replace(/[^A-Za-z0-9]/g, '') + Date.now().toString(36));
      if (!(opts && opts.keepStorage)) {
        await S('Page.navigate', { url: base + '/blank' });
        await waitFor("location.pathname === '/blank' && document.readyState === 'complete'", 10000, '/blank');
        await evaluate('localStorage.clear(), true');
      }
      await S('Page.navigate', { url: base + '/?s=' + scenario });
      await waitFor("location.search === '?s=" + scenario + "' && typeof _mzImgProxyOn !== 'undefined'", 15000, 'the fallback script');
    };
    const allSettled = "Array.from(document.images).every((i) => i.complete)";
    const allLoaded = "Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0)";

    await check('healthy network: nothing is rerouted, nothing is remembered', async () => {
      await open('healthy', { tmdb: () => 'ok' });
      await waitFor(allLoaded, 10000, 'all posters');
      await sleep(1800);
      const s = await evaluate(PROBE);
      assert.strictEqual(s.on, false, 'proxy mode switched on for a healthy network');
      assert.strictEqual(s.flag, null, 'proxy mode was remembered for a healthy network');
      assert(s.imgs.every((i) => !i.mode && /^https:\/\/image\.tmdb\.org\//.test(i.src)), 'a poster was rerouted');
      assert.strictEqual(st.proxyHits.length, 0, '/api/img was requested ' + st.proxyHits.length + ' time(s)');
      assert(s.ok >= 7, 'only ' + s.ok + ' of 7 loads were counted as successes');
    });

    await check('two missing posters get one retry each and do not switch a healthy page over', async () => {
      const missing = (f) => /poster[56]\.jpg$/.test(f);
      await open('missing', { tmdb: (f) => (missing(f) ? 404 : 'ok'), proxyMissing: { has: missing } });
      await waitFor(allSettled, 10000, 'all posters to settle');
      await sleep(2000);
      const s = await evaluate(PROBE);
      const rerouted = s.imgs.filter((i) => i.mode === 'proxy').map((i) => i.f);
      assert.deepStrictEqual(rerouted.map((f) => f.slice(-11)).sort(), ['poster5.jpg', 'poster6.jpg'], 'rerouted: ' + JSON.stringify(rerouted));
      assert.strictEqual(s.on, false, 'two 404s on a page that loads fine switched every image to the fallback');
      assert.strictEqual(s.flag, null, 'two 404s were remembered as a blocked host');
      assert(st.proxyHits.every(missing), 'healthy posters were fetched through /api/img: ' + st.proxyHits.join(', '));
    });

    await check('blocked host: every poster arrives through /api/img, srcset stays responsive', async () => {
      await open('blocked', { tmdb: () => 'fail' });
      await waitFor(allLoaded, 10000, 'all posters via the fallback');
      await waitFor("_mzImgProxyOn === true && !!localStorage.getItem('mz_img_proxy_until')", 5000, 'the page-wide switch');
      const s = await evaluate(PROBE);
      assert.strictEqual(s.on, true, 'a fully blocked host did not switch the page over');
      assert(s.imgs.every((i) => i.mode === 'proxy' && /^\/api\/img\//.test(i.src)), 'not every image was rerouted: ' + JSON.stringify(s.imgs.map((i) => i.src)));
      const poster = s.imgs.find((i) => i.srcset);
      assert(poster && /^\/api\/img\/w185\/\S+ 185w, \/api\/img\/w342\/\S+ 342w$/.test(poster.srcset), 'srcset lost its candidates: ' + (poster && poster.srcset));
      assert(s.sources.length === 2 && s.sources.every((x) => /^\/api\/img\/w(780|1280)\//.test(x)), '<picture> sources still point at TMDB: ' + JSON.stringify(s.sources));
      assert(Number(s.flag) > Date.now() + 5 * 3600e3, 'a confirmed block was not remembered (flag=' + s.flag + ')');
      const late = 'late' + Date.now().toString(36) + '.jpg';
      await evaluate("document.body.insertAdjacentHTML('beforeend', '<img id=\"late\" loading=\"lazy\" width=\"50\" height=\"75\" src=\"" + TMDB + 'w342/' + late + "\">'), true");
      await waitFor("(() => { const i = document.getElementById('late'); return i && i.complete && i.naturalWidth > 0; })()", 8000, 'the late poster');
      const lateSrc = await evaluate("document.getElementById('late').getAttribute('src')");
      assert(/^\/api\/img\/w342\//.test(lateSrc), 'a poster rendered after the switch still pointed at TMDB: ' + lateSrc);
      assert(!st.tmdbHits.includes(late), 'a lazy poster rendered after the switch still asked TMDB first');
    });

    await check('a remembered block reroutes at startup without extending itself', async () => {
      const before = await evaluate("localStorage.getItem('mz_img_proxy_until')");
      assert(before, 'nothing was remembered by the previous scenario');
      await open('remembered', { tmdb: () => 'ok', keepStorage: true });
      await waitFor(allLoaded, 10000, 'all posters');
      await sleep(1800);
      const s = await evaluate(PROBE);
      assert.strictEqual(s.on, true, 'the remembered block was ignored');
      assert.strictEqual(s.flag, before, 'the six-hour window was extended without any new failure');
    });

    await check('images that failed before the bundle ran are still rescued', async () => {
      await open('early', { tmdb: () => 'fail', scriptDelayMs: 1500 });
      await waitFor(allLoaded, 12000, 'all posters via the fallback');
      await waitFor('_mzImgProxyOn === true', 5000, 'the page-wide switch');
      const s = await evaluate(PROBE);
      assert(s.imgs.every((i) => i.mode === 'proxy'), 'an image that failed before the listener existed was left broken');
      assert.strictEqual(s.on, true);
    });

    await check('a blackholed host is detected by the watchdog, for this page only', async () => {
      const fast = block.replace(endMarker, '}, 1500);');
      await open('hang', { tmdb: () => 'hang', script: fast });
      await waitFor(allLoaded, 9000, 'all posters via the fallback');
      const s = await evaluate(PROBE);
      assert.strictEqual(s.on, true, 'the watchdog never switched over');
      assert.strictEqual(s.flag, null, 'a hang (possibly just a slow link) was remembered for six hours');
    });

    await check('offline: failures are not mistaken for a blocked host', async () => {
      await open('offline', { tmdb: () => 'ok' });
      await waitFor(allLoaded, 10000, 'all posters');
      st.tmdb = () => 'fail';
      await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      try {
        const names = [1, 2, 3].map((i) => 'offline' + i + Date.now().toString(36) + '.jpg');
        await evaluate("document.body.insertAdjacentHTML('beforeend', '" + names.map((n) => '<img class=\"off\" width=\"40\" height=\"60\" src=\"' + TMDB + 'w342/' + n + '\">').join('') + "'), true");
        await waitFor("Array.from(document.querySelectorAll('img.off')).every((i) => i.complete)", 8000, 'the offline images to fail');
        await sleep(1800);
        const s = await evaluate(PROBE + '.on === false && localStorage.getItem("mz_img_proxy_until") === null && navigator.onLine === false');
        assert.strictEqual(s, true, 'going offline switched the page to the fallback or remembered a block');
        const marked = await evaluate("Array.from(document.querySelectorAll('img.off')).filter((i) => i.getAttribute('data-mz-img')).length");
        assert.strictEqual(marked, 0, marked + ' offline image(s) were rerouted');
      } finally {
        await S('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
    });
  } catch (err) {
    failed++;
    console.log('  FAIL  browser harness: ' + ((err && err.message) || err));
  } finally {
    if (cdp) { try { cdp.ws.close(); } catch (e) {} await closeBrowser(cdp.child, cdp.profile); }
    await new Promise((r) => server.close(r));
  }
}

(async () => {
  await configChecks();
  await routeChecks();
  await swChecks();
  await browserChecks();
  console.log('\n' + '-'.repeat(74));
  console.log('  ' + (passed + failed) + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
  console.log('-'.repeat(74));
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
