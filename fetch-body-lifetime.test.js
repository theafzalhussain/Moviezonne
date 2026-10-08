'use strict';
// Offline only: execute production helpers with a fake clock and abort-aware fetch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, 'moviezone.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
function setup(replies, retries = 2) {
  let now = 0, id = 0;
  const timers = new Map(), calls = [];
  const context = {
    AbortController, navigator: { onLine: true },
    Date: { now: () => now }, Math: Object.assign(Object.create(Math), { random: () => 0 }),
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout(key) { timers.delete(key); },
    fetch: async (url, { signal }) => {
      const reply = replies[calls.length];
      assert(reply, 'unexpected fetch');
      const call = { signal, jsonCalls: 0 };
      calls.push(call);
      return { ok: !reply.status || reply.status === 200, status: reply.status || 200,
        headers: { get: name => name === 'Retry-After' ? reply.retryAfter || null : null },
        json() {
          call.jsonCalls++;
          if (reply.error) return Promise.reject(reply.error);
          if (!reply.stall) return Promise.resolve(reply.data);
          return new Promise((resolve, reject) => {
            call.resolve = resolve;
            const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
      };
    }
  };
  vm.createContext(context);
  const constants = ['MZ_FETCH_TIMEOUT_MS', 'MZ_FETCH_TOTAL_BUDGET_MS', 'MZ_FETCH_BACKOFF_MS'].map(name => {
    const match = source.match(new RegExp('const ' + name + ' = (\\d+);'));
    assert(match); return `const ${name} = ${match[1]};`;
  }).join('\n');
  vm.runInContext(constants + `
    const MZ_FETCH_MAX_RETRIES = ${retries};
    const MZ_MAX_CONCURRENT_FETCHES = 1;
    let _mzPageHiding = false;
    const _mzRateStamps = [];
    const _mzRateDelayMs = () => 0;
    const _mzSleep = ms => new Promise(r => setTimeout(r, ms));
  ` + section('let _mzActiveFetches = 0;', '// Queued promises') +
    section('function _mzIsTransientStatus', 'function _mzIsSelfInflictedStatus') +
    section('function _mzIsForbiddenStatus', 'const _mzForbiddenUrls') +
    section('function _mzShouldRetryStatus', 'function _mzIsBenignFailure') +
    section('async function _mzFetchAttempt', 'function _mzTmdbUrl') + `
    this.attempt = _mzFetchAttempt; this.retry = _mzFetchWithRetry;
    this.active = () => _mzActiveFetches;
    this.queued = () => _mzFetchQueue.length;
  `, context);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  async function tick(ms) {
    const end = now + ms;
    await flush();
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = end; await flush();
  }
  return { context, calls, timers, tick, flush, now: () => now };
}
const signal = () => new AbortController().signal;
test('stalled successful bodies consume lane and are bounded across retries', async () => {
  const h = setup([{ stall: true }, { stall: true }]);
  const p = h.context.retry('/test', signal());
  const failed = assert.rejects(p, { name: 'TimeoutError' });
  await h.flush();
  assert.equal(h.context.active(), 1);
  await h.tick(14999); assert.equal(h.calls[0].signal.aborted, false);
  await h.tick(1); assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.context.active(), 0);
  await h.tick(500); assert.equal(h.calls.length, 2);
  await h.tick(4500); await failed;
  assert.equal(h.now(), 20000);
  assert.equal(h.context.active(), 0); assert.equal(h.timers.size, 0);
});
test('success holds lane until JSON resolves and releases queued request', async () => {
  const h = setup([{ stall: true }, { data: null }]);
  const a = h.context.retry('/a', signal()); await h.flush();
  const b = h.context.retry('/b', signal()); await h.flush();
  assert.equal(h.context.queued(), 1); assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 1);
  h.calls[0].resolve({ results: [1] });
  assert.deepEqual(await a, { results: [1] }); assert.equal(await b, null);
  assert.equal(h.calls[0].jsonCalls, 1); assert.equal(h.context.active(), 0);
  assert.equal(h.timers.size, 0);
});
test('caller cancellation during body aborts without retry and cleans up', async () => {
  const h = setup([{ stall: true }]); const controller = new AbortController();
  const p = h.context.retry('/test', controller.signal);
  const failed = assert.rejects(p, { name: 'AbortError' });
  await h.flush(); controller.abort(); await failed;
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.context.active(), 0); assert.equal(h.timers.size, 0);
});
test('HTTP Retry-After and retry status retain metadata without parsing error bodies', async () => {
  const h = setup([{ status: 429, retryAfter: '2' }, { data: 'ok' }]);
  const p = h.context.retry('/test', signal()); await h.flush();
  assert.equal(h.context.active(), 0); assert.equal(h.calls[0].jsonCalls, 0);
  await h.tick(1999); assert.equal(h.calls.length, 1);
  await h.tick(1); assert.equal(await p, 'ok');
  assert.equal(h.context.active(), 0); assert.equal(h.timers.size, 0);
});
test('403 retries only once; permanent HTTP failures release lane', async () => {
  for (const status of [403, 404]) {
    const h = setup([{ status }, { status }]);
    const failed = assert.rejects(h.context.retry('/test', signal()), { name: 'HttpError', status });
    await h.tick(500); await failed;
    assert.equal(h.calls.length, status === 403 ? 2 : 1);
    assert.equal(h.context.active(), 0); assert.equal(h.timers.size, 0);
  }
});
test('JSON parse failure releases lane and clears timeout', async () => {
  const h = setup([{ error: new SyntaxError('bad JSON') }], 0);
  await assert.rejects(h.context.retry('/test', signal()), { name: 'SyntaxError' });
  assert.equal(h.context.active(), 0); assert.equal(h.timers.size, 0);
});
test('queued first attempt still receives full per-attempt allowance', async () => {
  const h = setup([{ stall: true }, { stall: true }], 0);
  // Occupy the real lane to model unrelated page traffic.
  vm.runInContext('_mzActiveFetches = 1', h.context);
  const p = h.context.retry('/test', signal());
  const failed = assert.rejects(p, { name: 'TimeoutError' });
  await h.tick(25000); assert.equal(h.calls.length, 0);
  vm.runInContext('_mzReleaseSlot()', h.context); await h.flush();
  await h.tick(14999); assert.equal(h.calls[0].signal.aborted, false);
  await h.tick(1); await failed;
  assert.equal(h.context.active(), 0); assert.equal(h.timers.size, 0);
});

test('successful body removes outer abort relay and timeout', async () => {
  const h = setup([{ data: false }]); const controller = new AbortController();
  assert.equal(await h.context.retry('/test', controller.signal), false);
  controller.abort(); await h.tick(20000);
  assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.context.active(), 0); assert.equal(h.timers.size, 0);
});
test('retry with insufficient queued budget releases its lane without fetching', async () => {
  const h = setup([]);
  vm.runInContext('_mzActiveFetches = 1', h.context);
  const p = h.context.attempt('/test', signal(), 20000);
  await h.tick(19500);
  vm.runInContext('_mzReleaseSlot()', h.context);
  assert.equal(await p, null);
  assert.equal(h.calls.length, 0); assert.equal(h.context.active(), 0);
  assert.equal(h.timers.size, 0);
});
