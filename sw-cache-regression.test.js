'use strict';
// Offline regression tests: execute the complete production service worker, not
// extracted/reimplemented strategies. No browser, dependencies, or live traffic.
// SW_SOURCE=sw.baseline.js node --test sw-cache-regression.test.js reproduces bugs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.resolve(__dirname, process.env.SW_SOURCE || 'sw.js'), 'utf8');
const ORIGIN = 'https://moviezone.dev';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function response(body, status = 200, options = {}) {
  const r = new Response(body, { status, headers: options.headers });
  Object.defineProperty(r, 'type', { value: options.type || 'basic' });
  Object.defineProperty(r, 'redirected', { value: !!options.redirected });
  const clone = r.clone.bind(r);
  r.clone = () => {
    const c = clone();
    Object.defineProperty(c, 'type', { value: r.type });
    Object.defineProperty(c, 'redirected', { value: r.redirected });
    return c;
  };
  return r;
}
function request(url, options = {}) {
  const r = new Request(new URL(url, ORIGIN), { method: options.method || 'GET', headers: options.headers });
  Object.defineProperty(r, 'mode', { value: options.mode || 'cors' });
  Object.defineProperty(r, 'destination', { value: options.destination || '' });
  return r;
}
function setup(fetcher = async () => response('network')) {
  let now = 100000, nextTimer = 0;
  const timers = new Map(), listeners = new Map(), stores = new Map(), calls = [], invalidWaits = [], keyReads = new Map();
  let cacheError = false, cacheReadGate = null;
  const urlOf = value => { const u = new URL(typeof value === 'string' ? value : value.url, ORIGIN); u.hash = ''; return u.href; };
  function matches(entry, req, options = {}) {
    const a = new URL(entry.key), b = new URL(urlOf(req));
    if (options.ignoreSearch) { a.search = ''; b.search = ''; }
    if (a.href !== b.href) return false;
    const vary = entry.value.headers.get('vary');
    if (vary === '*') return false;
    const headers = typeof req === 'string' ? new Headers() : req.headers;
    return !vary || vary.split(',').every(h => entry.headers.get(h.trim()) === headers.get(h.trim()));
  }
  function open(name) {
    if (cacheError) return Promise.reject(new Error('storage unavailable'));
    if (!stores.has(name)) stores.set(name, []);
    return Promise.resolve({
      async match(req, options) {
        if (cacheReadGate) await cacheReadGate;
        const e = stores.get(name).find(e => matches(e, req, options));
        return e ? e.value.clone() : undefined;
      },
      async put(req, value) {
        if (cacheError) throw new Error('quota');
        if (value.status === 206 || value.headers.get('vary') === '*') throw new TypeError('uncacheable');
        const body = await value.clone().text();
        const copy = response(body, value.status, { type: value.type, redirected: value.redirected, headers: value.headers });
        const entries = stores.get(name), index = entries.findIndex(e => matches(e, req));
        const e = { key: urlOf(req), headers: typeof req === 'string' ? new Headers() : req.headers, value: copy };
        if (index < 0) entries.push(e); else entries[index] = e;
      },
      async keys() { keyReads.set(name, (keyReads.get(name) || 0) + 1); return stores.get(name).map(e => request(e.key, { headers: e.headers })); },
      async delete(req) { const entries = stores.get(name), index = entries.findIndex(e => matches(e, req)); if (index < 0) return false; entries.splice(index, 1); return true; },
      async add(req) { const value = await fetcher(request(req)); if (!value.ok) throw new Error('precache failed'); await (await open(name)).put(req, value); },
      async addAll(reqs) { const values = await Promise.all(reqs.map(r => fetcher(request(r)))); if (values.some(r => !r.ok)) throw new Error('precache failed'); await Promise.all(reqs.map((r, i) => open(name).then(c => c.put(r, values[i])))); }
    });
  }
  const caches = {
    open,
    async keys() { if (cacheError) throw new Error('storage unavailable'); return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(req, options) {
      if (cacheError) throw new Error('storage unavailable');
      for (const name of stores.keys()) { const hit = await (await open(name)).match(req, options); if (hit) return hit; }
    }
  };
  const state = { claimed: 0, skipped: 0, preloadEnabled: 0 };
  const context = {
    URL, Request, Response, Headers, AbortController, caches,
    console: { warn() {}, log() {} },
    Date: { now: () => now },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (r, options) => { calls.push({ url: urlOf(r), options, request: r }); return fetcher(r, options); },
    self: { location: { origin: ORIGIN },
      addEventListener(name, cb) { listeners.set(name, cb); },
      skipWaiting: async () => { state.skipped++; },
      clients: { claim: async () => { state.claimed++; } },
      registration: { navigationPreload: { enable: async () => { state.preloadEnabled++; } } }
    }
  };
  vm.createContext(context); vm.runInContext(source, context, { filename: 'sw.js' });
  const config = vm.runInContext('({ shell: CACHE_NAME, image: IMAGE_CACHE, imageMax: IMAGE_CACHE_MAX_ENTRIES, runtime: typeof RUNTIME_CACHE === "undefined" ? CACHE_NAME : RUNTIME_CACHE, runtimeMax: typeof RUNTIME_CACHE_MAX_ENTRIES === "undefined" ? 128 : RUNTIME_CACHE_MAX_ENTRIES, staticAssets: STATIC_ASSETS, optionalAssets: OPTIONAL_ASSETS })', context);
  function dispatch(name, props = {}) {
    const waits = []; let result; let dispatching = true, pending = 0;
    function track(p) { pending++; const tracked = Promise.resolve(p).finally(() => pending--); tracked.catch(() => {}); waits.push(tracked); return tracked; }
    const event = { ...props,
      waitUntil(p) { if (!dispatching && pending === 0) { invalidWaits.push(name); throw new Error('InvalidStateError'); } track(p); },
      respondWith(p) { result = track(p); }
    };
    listeners.get(name)(event); dispatching = false;
    return { result, waits, async done() { let i = 0; while (i < waits.length) await Promise.all(waits.slice(i, i = waits.length)); } };
  }
  return { config, stores, calls, state, timers, invalidWaits, keyReads, dispatch,
    seed: async (name, url, value = response('cached')) => (await open(name)).put(url, value),
    match: async (name, url) => (await open(name)).match(url),
    size: name => (stores.get(name) || []).length,
    storageFailure() { cacheError = true; },
    holdReads(p) { cacheReadGate = p; },
    async tick(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } await flush(); },
    fetch(url, options = {}) { return dispatch('fetch', { request: request(url, options), preloadResponse: options.preloadResponse }); }
  };
}

test('REGRESSION: a new worker reads its own shell, not an older cache created first', async () => {
  const h = setup(async () => { throw new Error('offline'); });
  await h.seed('moviezone-v1', '/', response('old shell'));
  await h.seed(h.config.shell, '/', response('current shell'));
  const e = h.fetch('/', { mode: 'navigate' });
  assert.equal(await (await e.result).text(), 'current shell'); await e.done();
});

test('REGRESSION: versioned bundle lookup cannot use an unrelated/old cache', async () => {
  const h = setup(); const url = '/app.js?v=2';
  await h.seed('another-app', url, response('unrelated'));
  await h.seed(h.config.shell, url, response('current'));
  const e = h.fetch(url, { destination: 'script' });
  assert.equal(await (await e.result).text(), 'current'); assert.equal(h.calls.length, 0);
});

test('REGRESSION: activation deletes only obsolete MovieZone cache namespaces', async () => {
  const h = setup();
  for (const name of ['another-app', 'moviezone-v1', 'moviezone-runtime-v1', 'moviezone-tmdb-images-v1', h.config.shell, h.config.runtime, h.config.image]) await h.seed(name, '/');
  const e = h.dispatch('activate'); await e.done();
  assert(h.stores.has('another-app'), 'must not delete caches owned by another scope/app');
  assert(!h.stores.has('moviezone-v1')); assert(!h.stores.has('moviezone-runtime-v1')); assert(!h.stores.has('moviezone-tmdb-images-v1'));
  assert(h.stores.has(h.config.shell)); assert(h.stores.has(h.config.image));
  assert.equal(h.state.claimed, 1); assert.equal(h.state.preloadEnabled, 1);
});

test('REGRESSION: versioned data never falls back to an unversioned cached representation', async () => {
  const h = setup(); await h.seed(h.config.shell, '/collections-catalog.json', response('old data'));
  const e = h.fetch('/collections-catalog.json?v=99');
  assert.equal(await (await e.result).text(), 'network'); await e.done();
  assert.equal(h.calls.length, 1);
});

test('REGRESSION: runtime query variants stay bounded without evicting the precached shell', async () => {
  const h = setup(); await h.seed(h.config.shell, '/', response('shell'));
  await h.seed(h.config.shell, '/moviezone.min.js?v=17.5', response('bundle'));
  for (let i = 0; i < h.config.runtimeMax + 20; i++) { const e = h.fetch('/runtime.json?query=' + i); await e.result; await e.done(); }
  assert(h.size(h.config.runtime) <= h.config.runtimeMax, 'runtime cache must have a finite ceiling');
  assert.equal(await (await h.match(h.config.shell, '/')).text(), 'shell');
  assert.equal(await (await h.match(h.config.shell, '/moviezone.min.js?v=17.5')).text(), 'bundle');
  assert.equal(h.size(h.config.shell), 2, 'dynamic responses cannot accumulate in the pinned shell');
});

test('REGRESSION: concurrent runtime writes finish within the same finite ceiling', async () => {
  const h = setup();
  const events = Array.from({ length: h.config.runtimeMax + 40 }, (_, i) => h.fetch('/dynamic-' + i + '.json'));
  await Promise.all(events.map(e => e.done()));
  assert(h.size(h.config.runtime) <= h.config.runtimeMax);
  assert.equal(h.invalidWaits.length, 0);
});

test('REGRESSION: image bursts cannot exceed the documented bounded trim allowance', async () => {
  const h = setup();
  for (let i = 0; i < h.config.imageMax + 130; i++) { const e = h.fetch('/api/img/w342/poster-' + i + '.jpg'); await e.result; await e.done(); }
  assert(h.size(h.config.image) < h.config.imageMax + 32, 'time-only trimming leaves the whole burst cached forever');
  assert((h.keyReads.get(h.config.image) || 0) < 30, 'do not enumerate every poster write');
});

test('REGRESSION: fast navigation response does not wait for a stalled shell cache read', async () => {
  const h = setup(); await h.seed(h.config.shell, '/', response('shell'));
  const gate = deferred(); h.holdReads(gate.promise);
  const e = h.fetch('/', { mode: 'navigate' });
  let settled = false; e.result.then(() => { settled = true; });
  await flush(); const completedBeforeCache = settled;
  gate.resolve(); assert.equal(await (await e.result).text(), 'network'); await e.done();
  assert(completedBeforeCache, 'a warm shell lookup must not block a ready network document');
});

test('home timeout returns the shell and retains the late network cache refresh', async () => {
  const net = deferred(), h = setup(() => net.promise);
  await h.seed(h.config.shell, '/', response('shell'));
  const e = h.fetch('/?utm_source=test', { mode: 'navigate' });
  await flush(); await h.tick(2500);
  assert.equal(await (await e.result).text(), 'shell');
  net.resolve(response('fresh')); await e.done();
  assert.equal(await (await h.match(h.config.shell, '/')).text(), 'fresh');
  assert.equal(h.size(h.config.shell), 1); assert.equal(h.invalidWaits.length, 0); assert.equal(h.timers.size, 0);
});

test('preload is reused, and a preload rejection falls back to one fetch', async () => {
  const h = setup();
  const a = h.fetch('/', { mode: 'navigate', preloadResponse: Promise.resolve(response('preload')) });
  assert.equal(await (await a.result).text(), 'preload'); await a.done(); assert.equal(h.calls.length, 0);
  const b = h.fetch('/', { mode: 'navigate', preloadResponse: Promise.reject(new Error('preload failed')) });
  assert.equal(await (await b.result).text(), 'network'); await b.done(); assert.equal(h.calls.length, 1);
});

test('non-home navigation is not raced or cached, but gets the shell when offline', async () => {
  const net = deferred(); const h = setup(() => net.promise);
  await h.seed(h.config.shell, '/', response('shell'));
  const e = h.fetch('/movie/123', { mode: 'navigate' }); let done = false; e.result.then(() => { done = true; });
  await h.tick(2501); assert.equal(done, false);
  net.resolve(response('detail')); assert.equal(await (await e.result).text(), 'detail'); await e.done();
  assert.equal(h.size(h.config.shell), 1);
  const offline = setup(async () => { throw new Error('offline'); }); await offline.seed(offline.config.shell, '/', response('shell', 200, { redirected: true }));
  const fallback = await offline.fetch('/movie/123', { mode: 'navigate' }).result;
  assert.equal(await fallback.text(), 'shell'); assert.equal(fallback.redirected, false);
});

test('non-image API, external scripts, and mutations remain untouched', () => {
  const h = setup();
  for (const [url, options] of [['/api/tmdb/trending', {}], ['/api/toon/title', {}], ['/api/push/status', {}], ['https://example.test/ad.js', { destination: 'script' }], ['/api/img/w342/x.jpg', { method: 'POST' }]]) assert.equal(h.fetch(url, options).result, undefined);
  assert.equal(h.calls.length, 0); assert.equal(h.stores.size, 0);
});

test('HTTP errors and partial responses do not poison a cache', async () => {
  for (const status of [404, 500, 206]) {
    const h = setup(async () => response('error', status));
    for (const [url, options] of [['/app.js?v=2', { destination: 'script' }], ['/random.json', {}], ['/api/img/w342/x.jpg', {}], ['/', { mode: 'navigate' }]]) {
      const e = h.fetch(url, options); assert.equal((await e.result).status, status); await e.done();
    }
    assert.equal([...h.stores.values()].reduce((n, entries) => n + entries.length, 0), 0);
  }
});

test('storage faults still deliver network scripts, fonts, images and navigations', async () => {
  const h = setup(); h.storageFailure();
  for (const [url, options] of [['/app.js?v=2', { destination: 'script' }], ['/fonts/test.woff2', {}], ['/api/img/w342/x.jpg', {}], ['/', { mode: 'navigate' }], ['/data.json', {}]]) {
    const e = h.fetch(url, options); assert.equal(await (await e.result).text(), 'network'); await e.done();
  }
  assert.equal(h.invalidWaits.length, 0);
});

test('immutable image cache hits do not refetch and direct 404 does not proxy', async () => {
  const h = setup(async () => response('missing', 404));
  const url = 'https://image.tmdb.org/t/p/w342/poster.jpg'; await h.seed(h.config.image, url, response('poster'));
  assert.equal(await (await h.fetch(url).result).text(), 'poster'); assert.equal(h.calls.length, 0);
  const e = h.fetch('https://image.tmdb.org/t/p/w342/absent.jpg'); assert.equal((await e.result).status, 404); await e.done();
  assert.equal(h.calls.length, 1); assert.equal(h.size(h.config.image), 1);
});

test('blocked TMDB direct host uses proxy and retains its penalty circuit', async () => {
  const h = setup(async r => response(String(typeof r === 'string' ? r : r.url).includes('image.tmdb.org') ? 'blocked' : 'poster', String(typeof r === 'string' ? r : r.url).includes('image.tmdb.org') ? 403 : 200));
  for (let i = 0; i < 3; i++) { const e = h.fetch('https://image.tmdb.org/t/p/w342/p' + i + '.jpg'); assert.equal(await (await e.result).text(), 'poster'); await e.done(); }
  assert.equal(h.calls.filter(c => c.url.includes('image.tmdb.org')).length, 2);
  assert.equal(h.calls.filter(c => c.url.includes('/api/img/')).length, 3); assert.equal(h.size(h.config.image), 3);
});

test('core install failure prevents activation while optional failure preserves successful shell', async () => {
  const bad = setup(async () => response('failed', 503));
  await assert.rejects(bad.dispatch('install').done()); assert.equal(bad.state.skipped, 0);
  const h = setup(async r => response('asset', r.url.includes('providers.css') ? 404 : 200));
  await h.dispatch('install').done(); assert.equal(h.state.skipped, 1);
  assert(await h.match(h.config.shell, '/')); assert.equal(h.invalidWaits.length, 0);
});

// Upgrade and concurrency cases intentionally exercise the same event handlers.
test('REGRESSION: activation trims inherited image overflow even if later requests are all hits', async () => {
  const h = setup();
  for (let i = 0; i < h.config.imageMax + 50; i++) await h.seed(h.config.image, '/api/img/w342/old-' + i + '.jpg', response('poster'));
  await h.dispatch('activate').done();
  assert.equal(h.size(h.config.image), h.config.imageMax);
  assert(await h.match(h.config.image, '/api/img/w342/old-449.jpg'));
});

test('concurrent image writes settle within the bounded allowance with batched enumeration', async () => {
  const h = setup();
  const events = Array.from({ length: h.config.imageMax + 60 }, (_, i) => h.fetch('/api/img/w342/burst-' + i + '.jpg'));
  await Promise.all(events.map(e => e.done()));
  assert(h.size(h.config.image) < h.config.imageMax + 32);
  assert((h.keyReads.get(h.config.image) || 0) < 30);
  assert.equal(h.invalidWaits.length, 0);
});

test('a response arriving after the navigation budget still beats a stalled cache read', async () => {
  const net = deferred(), gate = deferred(), h = setup(() => net.promise);
  await h.seed(h.config.shell, '/', response('shell')); h.holdReads(gate.promise);
  const e = h.fetch('/', { mode: 'navigate' }); let settled = false; e.result.then(() => { settled = true; });
  await flush(); await h.tick(2500); net.resolve(response('late network')); await flush();
  const beforeCache = settled; gate.resolve();
  assert.equal(await (await e.result).text(), 'late network'); await e.done();
  assert(beforeCache); assert.equal(h.timers.size, 0);
});

test('a cold cache never replaces a slow real navigation with an empty fallback', async () => {
  const net = deferred(), h = setup(() => net.promise);
  const e = h.fetch('/', { mode: 'navigate' }); let settled = false; e.result.then(() => { settled = true; });
  await flush(); await h.tick(2500); assert.equal(settled, false);
  net.resolve(response('first home')); assert.equal(await (await e.result).text(), 'first home'); await e.done();
  assert.equal(await (await h.match(h.config.shell, '/')).text(), 'first home'); assert.equal(h.timers.size, 0);
});

test('offline without any shell returns Response.error and leaves no timer behind', async () => {
  const h = setup(async () => { throw new Error('offline'); });
  const e = h.fetch('/', { mode: 'navigate' });
  const r = await e.result; await e.done();
  assert.equal(r.type, 'error'); assert.equal(h.timers.size, 0); assert.equal(h.invalidWaits.length, 0);
});

test('HTTP navigation errors remain visible but never replace the usable cached shell', async () => {
  const h = setup(async () => response('maintenance', 503));
  await h.seed(h.config.shell, '/', response('good shell'));
  const e = h.fetch('/', { mode: 'navigate' }); assert.equal((await e.result).status, 503); await e.done();
  assert.equal(await (await h.match(h.config.shell, '/')).text(), 'good shell');
});
