'use strict';

/*  Behavioural tests for the Continue Watching watch session.
 *
 *  WHY THIS EXISTS
 *  persistSessionProgress() used to end a finished title by calling
 *  stopWatchSession(), and stopWatchSession() flushes by calling
 *  persistSessionProgress() — with the session still alive. The two recursed into
 *  each other until the stack overflowed: "Maximum call stack size exceeded",
 *  371 of 373 RUM errors in one day, all on /.
 *
 *  The visible damage was worse than the error count. Every lap rebuilt the
 *  rail's innerHTML and rewrote localStorage, so each overflow was a long freeze:
 *  measured on the real page as a 4x-throttled 360px Android, every OmniPlay
 *  progress message past 92% blocked the main thread for 25-53 SECONDS. On most
 *  Android phones the provider's player iframe shares that thread, so the film
 *  itself stalled in its last minutes. The throw also skipped clearInterval, so
 *  the stall repeated every few seconds, and the next Play press aborted inside
 *  _mzStartWatchSession() before loadPlayer() ran.
 *
 *  The module is extracted from moviezone.js at runtime and run in a sandbox, as
 *  player-health.test.js does, so this cannot pass against code the app does not
 *  ship.
 *
 *  Run: node continue-watching.test.js
 */

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync('moviezone.js', 'utf8');
const MARKER = '(function initContinueWatching() {';

function moduleSource() {
  const at = src.indexOf(MARKER);
  if (at === -1) throw new Error('not found in moviezone.js: ' + MARKER);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, src.indexOf(';', i) + 1);
    }
  }
  throw new Error('unbalanced braces after: ' + MARKER);
}
const MODULE = moduleSource();

const ORIGIN = 'https://embed.vidrift.net';
const CW_KEY = 'mz_continue_watching';
const DONE_KEY = 'mz_watched_done';

// ── a fake page just large enough for the module ──────────────────────────
function makePage(seed) {
  const store = Object.assign({}, seed || {});
  const stats = { cwWrites: 0, renders: 0 };
  const intervals = new Map();
  let nextTimer = 1;
  const listeners = { window: new Map(), document: new Map() };
  const on = (bag) => (type, fn) => { if (!bag.has(type)) bag.set(type, new Set()); bag.get(type).add(fn); };
  const off = (bag) => (type, fn) => { if (bag.has(type)) bag.get(type).delete(fn); };
  const grid = {
    _html: '',
    set innerHTML(v) { stats.renders++; this._html = v; },
    get innerHTML() { return this._html; },
    querySelector: () => null
  };
  const section = { style: {} };
  let clock = 1700000000000;

  const sandbox = {
    console, JSON, Math, Number, String, Set, Map, Array, Object, parseInt,
    Date: { now: () => clock },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { if (k === CW_KEY) stats.cwWrites++; store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    setInterval: (fn) => { const id = nextTimer++; intervals.set(id, fn); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    escapeHTML: (s) => String(s),
    playerHostOrigins: () => [ORIGIN],
    recordPlayerPlayed: () => {},
    MZ_PLAYED_PROOF_SEC: 15,
    currentEpisodeSelection: () => null,
    openModal: () => {},
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      hasFocus: () => true,
      getElementById: (id) => (id === 'continueWatchingGrid' ? grid : id === 'continue-watching' ? section : null),
      addEventListener: on(listeners.document),
      removeEventListener: off(listeners.document)
    }
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = on(listeners.window);
  sandbox.removeEventListener = off(listeners.window);
  vm.createContext(sandbox);
  vm.runInContext(MODULE, sandbox, { filename: 'moviezone.js#initContinueWatching' });

  const fire = (bag, type, arg) => [...(bag.get(type) || [])].forEach((fn) => fn(arg));
  return {
    win: sandbox, store, stats, intervals,
    advance: (sec) => { clock += sec * 1000; },
    tick: () => [...intervals.values()].forEach((fn) => fn()),
    progress: (tmdbId, currentTime, duration) => fire(listeners.window, 'message',
      { origin: ORIGIN, data: { type: 'vidrift:progress', tmdbId, currentTime, duration } }),
    fireWindow: (type) => fire(listeners.window, type),
    listenerCount: (type) => (listeners.window.get(type) || new Set()).size
      + (listeners.document.get(type) || new Set()).size,
    rail: () => JSON.parse(store[CW_KEY] || '[]'),
    done: () => JSON.parse(store[DONE_KEY] || '[]')
  };
}

const FILM = { id: 550, title: 'Fight Club', media_type: 'movie', runtime: 139 };
const NEXT = { id: 680, title: 'Pulp Fiction', media_type: 'movie', runtime: 154 };
const DURATION = 8340;                    // 139 min, as OmniPlay reports it
const PAST_COMPLETE = 7800;               // 93.5% — past COMPLETE_AT (92)

// A regular viewer: a dozen rows in the rail and a history of finished titles.
// The recursion's cost grew with both, which is why it froze real phones.
function regularViewer() {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ id: 9000 + i, key: String(9000 + i), title: 'Title ' + i, media_type: 'movie',
      progress: 30 + i, watchedSec: 1200, runtimeSec: 7200, positionSec: 0, timestamp: 1 });
  }
  const done = [];
  for (let i = 0; i < 120; i++) done.push(String(100000 + i));
  return { [CW_KEY]: JSON.stringify(rows), [DONE_KEY]: JSON.stringify(done) };
}

let pass = 0, fail = 0;
const failures = [];
function it(label, fn) {
  try { fn(); pass++; console.log('  PASS  ' + label); }
  catch (e) {
    fail++; failures.push(label + ' - ' + e.message);
    console.log('  FAIL  ' + label + '\n          ' + (e && e.constructor && e.constructor.name) + ': ' + e.message);
  }
}

console.log('\nfinishing a title through the player\'s own playhead\n' + '-'.repeat(62));
{
  let page = null;
  // Page load and the session seed each render the rail once; only what the
  // completion message itself does is under test.
  let rendersBefore = 0, writesBefore = 0, rendersAfter = 0, writesAfter = 0;

  it('crossing the completion line does not throw (no persist <-> stop recursion)', () => {
    page = makePage(regularViewer());
    page.win._mzStartWatchSession(FILM, FILM.runtime);
    rendersBefore = page.stats.renders; writesBefore = page.stats.cwWrites;
    page.progress(FILM.id, PAST_COMPLETE, DURATION);
    rendersAfter = page.stats.renders; writesAfter = page.stats.cwWrites;
  });
  it('...and costs exactly one rail render and one rail write', () => {
    // The recursive version re-rendered and re-wrote thousands of times per message.
    assert.strictEqual(rendersAfter - rendersBefore, 1, (rendersAfter - rendersBefore) + ' rail renders');
    assert.strictEqual(writesAfter - writesBefore, 1, (writesAfter - writesBefore) + ' rail writes');
  });
  it('a stray progress message after the end changes nothing', () => {
    page.progress(FILM.id, 600, DURATION);
    assert.strictEqual(page.stats.renders, rendersAfter, 'rail re-rendered');
    assert.strictEqual(page.stats.cwWrites, writesAfter, 'rail re-written');
  });
  it('the finished session leaves no timer running', () => {
    assert.strictEqual(page.intervals.size, 0, page.intervals.size + ' interval(s) still running');
  });
  it('...and no listeners attached', () => {
    for (const type of ['message', 'blur', 'focus', 'visibilitychange']) {
      assert.strictEqual(page.listenerCount(type), 0, type + ' listener still attached');
    }
  });
  it('the title leaves Continue Watching and is remembered as finished', () => {
    assert.ok(!page.rail().some((e) => e.id === FILM.id), 'still in the rail');
    assert.ok(page.done().includes(String(FILM.id)), 'not in the finished list');
  });
  it('the other rows of the rail are untouched', () => {
    assert.strictEqual(page.rail().length, 12, page.rail().length + ' rows');
  });
  it('closing the player afterwards does not throw', () => {
    page.win._mzStopWatchSession();
  });
  it('pressing Play on the next title starts its session', () => {
    page.win._mzStartWatchSession(NEXT, NEXT.runtime);
    assert.ok(page.rail().some((e) => e.id === NEXT.id), 'the next title never reached the rail');
    assert.strictEqual(page.intervals.size, 1, 'expected exactly one live timer');
  });
}

console.log('\nfinishing a title on the time estimate (servers that post nothing)\n' + '-'.repeat(62));
{
  let page = null;

  it('the 5 s timer crossing 92% does not throw', () => {
    page = makePage(regularViewer());
    page.win._mzStartWatchSession({ id: 1, title: 'Short', media_type: 'movie' }, 1);   // 60 s runtime
    for (let i = 0; i < 15; i++) { page.advance(5); page.tick(); }
  });
  it('the timer stops itself once the title is finished', () => {
    assert.strictEqual(page.intervals.size, 0, page.intervals.size + ' interval(s) still running');
  });
  it('blur, page hide and close after completion do not throw', () => {
    page.fireWindow('blur');
    page.fireWindow('pagehide');
    page.fireWindow('beforeunload');
    page.win._mzStopWatchSession();
  });
  it('the finished title is not offered back', () => {
    assert.ok(!page.rail().some((e) => e.id === 1), 'still in the rail');
  });
}

console.log('\nfinishing exactly at a flush (close / blur at >= 92%)\n' + '-'.repeat(62));
{
  for (const exit of ['close', 'blur', 'pagehide']) {
    it(exit + ' while past 92% completes the title without throwing', () => {
      const page = makePage();
      page.win._mzStartWatchSession(FILM, FILM.runtime);
      page.advance(20);
      page.progress(FILM.id, 4000, DURATION);                  // normal persist
      page.advance(2);
      page.progress(FILM.id, PAST_COMPLETE - 30, DURATION);    // 93%, inside the batch window
      if (exit === 'close') page.win._mzStopWatchSession();
      else page.fireWindow(exit);
      assert.ok(page.done().includes(String(FILM.id)), 'not marked finished');
      assert.strictEqual(page.intervals.size, 0, 'timer still running');
    });
  }
}

console.log('\nplayer progress is batched, never lost\n' + '-'.repeat(62));
{
  let page = null;
  let before = 0;

  it('a dozen progress messages in 12 s cost at most two storage writes', () => {
    page = makePage();
    page.win._mzStartWatchSession(FILM, FILM.runtime);
    before = page.stats.cwWrites;
    for (let i = 1; i <= 12; i++) { page.advance(1); page.progress(FILM.id, 600 + i, DURATION); }
    const writes = page.stats.cwWrites - before;
    assert.ok(writes <= 2, writes + ' synchronous localStorage writes');
  });
  it('the playhead reaches storage once the 15 s window passes', () => {
    page.advance(16);
    page.progress(FILM.id, 640, DURATION);
    const row = page.rail().find((e) => e.id === FILM.id);
    assert.ok(row && row.positionSec === 640, 'stored positionSec=' + (row && row.positionSec));
  });
  it('closing the player flushes the latest playhead immediately', () => {
    page.advance(2);
    page.progress(FILM.id, 645, DURATION);
    page.win._mzStopWatchSession();
    const row = page.rail().find((e) => e.id === FILM.id);
    assert.ok(row && row.positionSec === 645, 'stored positionSec=' + (row && row.positionSec));
  });
  it('a playhead for another title is ignored', () => {
    const p2 = makePage();
    p2.win._mzStartWatchSession(FILM, FILM.runtime);
    p2.progress(999, PAST_COMPLETE, DURATION);
    assert.ok(!p2.done().includes(String(FILM.id)), 'another title\'s playhead completed this one');
    assert.strictEqual(p2.intervals.size, 1, 'session ended on a foreign message');
  });
}

console.log('\nremoving the running title from the rail\n' + '-'.repeat(62));
{
  let page = null;
  it('removeCW on the live row ends the session cleanly', () => {
    page = makePage();
    page.win._mzStartWatchSession(FILM, FILM.runtime);
    page.win.removeCW(String(FILM.id));
    assert.strictEqual(page.intervals.size, 0, 'timer still running');
    assert.strictEqual(page.listenerCount('message'), 0, 'message listener still attached');
    assert.ok(!page.rail().some((e) => e.id === FILM.id), 'row still in the rail');
  });
  it('a later progress message for it changes nothing', () => {
    page.progress(FILM.id, 4000, DURATION);
    assert.ok(!page.rail().some((e) => e.id === FILM.id), 'row came back');
  });
}

console.log('\n' + '='.repeat(62));
console.log('  continue-watching: ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(62) + '\n');
if (fail) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
