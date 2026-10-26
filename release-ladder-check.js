/*  ═══════════════════════════════════════════════════════════════════════════
 *  RELEASE LADDER — laddered tabs page in release order, by construction
 *  ═══════════════════════════════════════════════════════════════════════════
 *
 *  Bollywood, Hollywood, Tollywood (and its /movies/south alias) and Web Series
 *  page through consecutive release WINDOWS newest-first (FEED_LADDER in
 *  moviezone.js). Two properties make their pages read in release order, and
 *  both are easy to break without anything on screen looking wrong at first:
 *
 *    1. THE WINDOWS. Every gather's windows are contiguous with the gather
 *       before, never overlap, never go below the floor, and run out exactly at
 *       the floor — running out is the only way a laddered tab ends. One gather
 *       must also fit one /api/tmdb/batch round trip (worker.js MAX_BATCH_PATHS).
 *
 *    2. THE SEAM. Gather 1 opens with the latest window in the ALL feed's order;
 *       everything after it runs by release month. The head used to be "priority
 *       groups 0-3 from the last 135 days", so a last-week title outside those
 *       groups fell into the month-sorted tail and the tail opened NEWER than the
 *       head ended — Web Series page 3 ended in July and page 4 opened in October.
 *       Asserted here: every title after the head is older than every title in
 *       it, and the rest never goes back up a month.
 *
 *  moviezone.js is a browser script, so it is evaluated in a VM with the DOM
 *  surface it touches at parse time stubbed out — the same approach as
 *  ranking-parity-check.js — and the SHIPPED functions are called.
 *
 *  Run: node release-ladder-check.js
 *  ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + label);
  } catch (err) {
    failures.push(label);
    console.log('  FAIL  ' + label + '\n          ' + err.message);
  }
}

/*  Enough of a browser for moviezone.js's top-level statements to run. Kept in
 *  step with ranking-parity-check.js's sandbox. */
function makeSandbox() {
  const noop = () => {};
  const el = () => ({
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    appendChild: noop, insertBefore: noop, remove: noop, addEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    children: [], childNodes: [], dataset: {}, cloneNode: () => el(),
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    offsetHeight: 0, offsetWidth: 0, textContent: '', innerHTML: ''
  });
  const store = new Map();
  const win = {
    location: { hostname: 'moviezone.dev', href: 'https://moviezone.dev/', search: '', hash: '', pathname: '/' },
    navigator: { userAgent: 'node-ladder-harness', onLine: true, hardwareConcurrency: 8, languages: ['en'] },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop, removeEventListener: noop }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] || null,
      get length() { return store.size; }
    },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
    performance: { now: () => Date.now() },
    fetch: () => Promise.reject(new Error('no network in the ladder harness')),
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() {} },
    console: { log: noop, warn: noop, error: noop, debug: noop, info: noop }
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.document = {
    documentElement: el(), body: el(), head: el(),
    createElement: el, createDocumentFragment: el, createTextNode: () => ({ textContent: '' }),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    getElementsByTagName: () => [], getElementsByClassName: () => [], getElementsByName: () => [],
    addEventListener: noop, removeEventListener: noop,
    readyState: 'loading', visibilityState: 'visible', cookie: '',
    hidden: false, referrer: '', title: ''
  };
  return win;
}

const src = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');
const context = vm.createContext(makeSandbox());
vm.runInContext(src, context, { filename: 'moviezone.js' });
// Top-level const/let live in the context's lexical scope, not on its global
// object, so they are read back through a second script in the same context.
const api = vm.runInContext(
  '({ FEED_LADDER, FEED_LADDER_FLOOR, feedLadderRungs, feedLadderPlan, rankReleaseLadder, istDateStr })',
  context);

const DAY = 86400000;
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
const cats = Object.keys(api.FEED_LADDER);
const maxBatch = Number((/const MAX_BATCH_PATHS = (\d+);/.exec(fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')) || [])[1]);

console.log('\nrelease ladder — laddered tabs page in release order');
console.log('-'.repeat(72));

check('the laddered tabs are the four industry/series tabs plus the south alias', () => {
  assert.deepStrictEqual(cats.slice().sort(), ['bollywood', 'hollywood', 'south', 'tollywood', 'tv']);
  assert.strictEqual(api.FEED_LADDER.south, api.FEED_LADDER.tollywood, "'south' must alias 'tollywood', not be a second pool");
});

// ── 1. the windows ─────────────────────────────────────────────────────────
console.log('');
const walks = {};
cats.forEach((cat) => {
  const gathers = [];
  for (let g = 1; g <= 400; g++) {
    const rungs = api.feedLadderRungs(cat, g);
    if (!rungs.length) break;
    gathers.push(rungs);
  }
  walks[cat] = gathers;
});

check('gather 1 starts at rung 0, which ends today', () => {
  cats.forEach((cat) => {
    const first = walks[cat][0][0];
    assert.strictEqual(first.rung, 0, cat + ': gather 1 opens on rung ' + first.rung);
    assert.strictEqual(first.lte, api.istDateStr(0), cat + ': rung 0 ends ' + first.lte);
  });
});

check('every window is contiguous with the one before it, newest first, never overlapping', () => {
  cats.forEach((cat) => {
    const flat = [].concat(...walks[cat]);
    flat.forEach((w, i) => {
      assert.ok(w.gte <= w.lte, cat + ' rung ' + w.rung + ' is inverted: ' + w.gte + '..' + w.lte);
      if (i === 0) return;
      const prev = flat[i - 1];
      assert.strictEqual(w.rung, prev.rung + 1, cat + ': rung ' + w.rung + ' follows rung ' + prev.rung);
      assert.strictEqual(nextDay(w.lte), prev.gte,
        cat + ': gap or overlap between ' + w.gte + '..' + w.lte + ' and ' + prev.gte + '..' + prev.lte);
    });
  });
});

check('the ladder ends exactly at the floor, and only there', () => {
  cats.forEach((cat) => {
    const flat = [].concat(...walks[cat]);
    const last = flat[flat.length - 1];
    assert.strictEqual(last.gte, api.FEED_LADDER_FLOOR, cat + ' stops at ' + last.gte + ', floor is ' + api.FEED_LADDER_FLOOR);
    flat.forEach((w) => assert.ok(w.gte >= api.FEED_LADDER_FLOOR, cat + ' goes below the floor: ' + w.gte));
    assert.strictEqual(api.feedLadderRungs(cat, walks[cat].length + 1).length, 0, cat + ' does not run out past the floor');
  });
  console.log('          gathers to the floor: ' + cats.map((c) => c + ' ' + walks[c].length).join(', '));
});

check('every gather fits one batch round trip (worker.js MAX_BATCH_PATHS)', () => {
  assert.ok(maxBatch > 0, 'MAX_BATCH_PATHS not found in worker.js');
  cats.forEach((cat) => {
    walks[cat].forEach((_, i) => {
      const n = api.feedLadderPlan(cat, i + 1).length;
      assert.ok(n > 0 && n <= maxBatch, cat + ' gather ' + (i + 1) + ' sends ' + n + ' paths (limit ' + maxBatch + ')');
    });
  });
});

check("each plan asks TMDB for exactly its gather's windows", () => {
  cats.forEach((cat) => {
    [1, 2, 5].forEach((g) => {
      const cfg = api.FEED_LADDER[cat];
      const wanted = new Set(api.feedLadderRungs(cat, g).map((w) => w.gte + '..' + w.lte));
      const asked = new Set(api.feedLadderPlan(cat, g)
        .filter(([endpoint]) => endpoint === cfg.endpoint)
        .map(([, p]) => p[cfg.date + '.gte'] + '..' + p[cfg.date + '.lte']));
      assert.deepStrictEqual([...asked].sort(), [...wanted].sort(), cat + ' gather ' + g);
    });
  });
});

// ── 2. the seam ────────────────────────────────────────────────────────────
console.log('');
/*  A synthetic gather spread over every window plus rows that must be dropped.
 *  Titles inside the latest window deliberately include ones the ALL feed's
 *  priority groups would NOT treat as a headline (few votes, low popularity) —
 *  that is the row that used to fall into the tail and open it on this month. */
function fixture(cat, gather) {
  const cfg = api.FEED_LADDER[cat];
  const isTv = cfg.endpoint === '/discover/tv';
  const lang = (cfg.sources[0][0].with_original_language || 'en').split('|')[0];
  const rows = [];
  let id = 1;
  const add = (date, votes, popularity, extra) => {
    const r = Object.assign({
      id: id++, poster_path: '/p.jpg', vote_count: votes, vote_average: 7, popularity: popularity,
      original_language: lang, genre_ids: isTv ? [18] : [28]
    }, extra || {});
    if (isTv) { r.name = 'Show ' + r.id; r.first_air_date = date; r.media_type = 'tv'; }
    else { r.title = 'Film ' + r.id; r.release_date = date; r.media_type = 'movie'; }
    rows.push(r);
  };
  const rungs = api.feedLadderRungs(cat, gather);
  const span = (w) => Math.round((Date.parse(w.lte) - Date.parse(w.gte)) / DAY);
  rungs.forEach((w) => {
    for (let k = 0; k <= 12; k++) {
      const date = new Date(Date.parse(w.lte) - Math.round(span(w) * k / 12) * DAY).toISOString().slice(0, 10);
      add(date, 400 + k * 37, 60 + k * 9);   // a headline-grade title
      add(date, 3, 4.5);                     // passes the audience gate, nothing more
    }
  });
  const from = rungs[rungs.length - 1].gte;
  const older = new Date(Date.parse(from) - 40 * DAY).toISOString().slice(0, 10);
  add(older, 9000, 900, { _expectDropped: 'older than the gather' });
  add(rungs[0].lte, 0, 1, { _expectDropped: 'fails the audience gate' });
  return rows;
}

const dateOf = (m) => m.release_date || m.first_air_date || '';
const monthOf = (m) => dateOf(m).slice(0, 7);

cats.filter((c) => c !== 'south').forEach((cat) => {
  const rungs1 = api.feedLadderRungs(cat, 1);
  const headFrom = rungs1[0].gte;
  const input = fixture(cat, 1);
  const out = api.rankReleaseLadder(input, cat, 1, Date.now());

  check(cat + ': out-of-window and no-audience rows are dropped, nothing else is', () => {
    assert.ok(out.every((m) => !m._expectDropped), 'kept: ' + out.filter((m) => m._expectDropped).map((m) => m._expectDropped).join(', '));
    assert.strictEqual(out.length, input.filter((m) => !m._expectDropped).length, 'lost titles: ' + (input.length - 2 - out.length));
    assert.strictEqual(new Set(out.map((m) => m.id)).size, out.length, 'a title appears twice');
  });

  const headLen = out.findIndex((m) => dateOf(m) < headFrom);
  const head = headLen === -1 ? out : out.slice(0, headLen);
  const tail = headLen === -1 ? [] : out.slice(headLen);

  check(cat + ': gather 1 opens with the WHOLE latest window, low-audience titles included', () => {
    const inWindow = out.filter((m) => dateOf(m) >= headFrom);
    assert.ok(inWindow.length > 0, 'fixture has no latest-window titles');
    assert.strictEqual(head.length, inWindow.length,
      'latest-window titles after the head: ' + tail.filter((m) => dateOf(m) >= headFrom).map(dateOf).join(', '));
  });

  check(cat + ': every title after the head is older than every title in it (no seam)', () => {
    assert.ok(tail.length > 0, 'fixture has no tail');
    const oldestHead = head.map(dateOf).sort()[0];
    const newestTail = tail.map(dateOf).sort().pop();
    assert.ok(newestTail < oldestHead, 'tail opens ' + newestTail + ', head ends ' + oldestHead);
  });

  check(cat + ': after the head, release months never go back up', () => {
    const bad = tail.findIndex((m, i) => i > 0 && monthOf(m) > monthOf(tail[i - 1]));
    assert.strictEqual(bad, -1, bad === -1 ? '' : monthOf(tail[bad - 1]) + ' then ' + monthOf(tail[bad]));
  });

  check(cat + ': a later gather has no head, runs by month, and is older than all of gather 1', () => {
    const out2 = api.rankReleaseLadder(fixture(cat, 2), cat, 2, Date.now());
    assert.ok(out2.length > 0, 'gather 2 ranked nothing');
    const bad = out2.findIndex((m, i) => i > 0 && monthOf(m) > monthOf(out2[i - 1]));
    assert.strictEqual(bad, -1, bad === -1 ? '' : monthOf(out2[bad - 1]) + ' then ' + monthOf(out2[bad]));
    const oldest1 = out.map(dateOf).sort()[0];
    const newest2 = out2.map(dateOf).sort().pop();
    assert.ok(newest2 < oldest1, 'gather 2 reaches ' + newest2 + ', gather 1 goes down to ' + oldest1);
  });
});

console.log('-'.repeat(72));
console.log('  release-ladder-check: ' + passed + ' passed, ' + failures.length + ' failed\n');
process.exit(failures.length ? 1 : 0);
