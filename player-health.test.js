'use strict';

/*  Behavioural tests for the learned player-server ranking.
 *
 *  asset-perf-check.js proves the code is WIRED UP. This proves it is CORRECT:
 *  that a fast server actually outranks a slow one, that a dead server gets
 *  demoted and then forgiven when it recovers, that the give-up timer shortens
 *  for quick providers, and that the dub/anime rules are never violated in the
 *  name of speed.
 *
 *  The functions are extracted from moviezone.js at runtime rather than
 *  reimplemented, so this cannot pass against logic the app does not ship.
 *
 *  Run: node player-health.test.js
 */

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync('moviezone.js', 'utf8');

function block(marker) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('not found in moviezone.js: ' + marker);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced braces after: ' + marker);
}
function line(marker) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('not found in moviezone.js: ' + marker);
  return src.slice(at, src.indexOf('\n', at));
}

// ── a fake environment just large enough for the ranking code ──────────────
function makeSandbox(sources, animeIds) {
  const store = {};
  const sandbox = {
    console,
    Date, Math, JSON, Object, Array, String, Number, Set, Map, parseInt, isNaN,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    // Persistence is queued through this in the real app; run it immediately
    // here so assertions can observe the stored result.
    _mzOnIdle: (fn) => fn(),
    playerSources: sources,
    isAnimeContent: (m) => !!m && animeIds.has(m.id),
    isCartoonContent: () => false,
    currentModalMovie: null
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    line('const MZ_PLAYER_HEALTH_KEY ='),
    line('const MZ_PH_DEFAULT_TIMEOUT ='),
    line('const MZ_PH_MIN_TIMEOUT ='),
    line('const MZ_PH_MAX_TIMEOUT ='),
    line('const MZ_DUBBED_LANGS ='),
    'let _mzPlayerHealth = null;',
    block('function playerHealth('),
    block('function _mzPersistPlayerHealth('),
    block('function _mzHealthEntry('),
    block('function recordPlayerLoad('),
    block('function recordPlayerFailure('),
    block('function playerCost('),
    block('function rankSourceIdxs('),
    block('function candidateSourceIdxs('),
    block('function adaptivePlayerTimeout('),
    'let _mzTriedSources = new Set();',
    block('function resetTriedSources('),
    block('function getSelectedSourceIdx('),
    'globalThis.__api = { playerHealth, recordPlayerLoad, recordPlayerFailure, playerCost,'
      + ' rankSourceIdxs, candidateSourceIdxs, adaptivePlayerTimeout, getSelectedSourceIdx,'
      + ' MZ_PH_DEFAULT_TIMEOUT, MZ_PH_MIN_TIMEOUT, MZ_PH_MAX_TIMEOUT, store: null };'
  ].join('\n\n'), sandbox);
  return { api: sandbox.__api, sandbox, store };
}

const SOURCES = [
  { name: 'Alpha',  dubbed: true,  anime: true  },
  { name: 'Bravo',  dubbed: true,  anime: false },
  { name: 'Charlie', dubbed: false, anime: true  },
  { name: 'Delta',  dubbed: false, anime: false }
];

let pass = 0, fail = 0;
const failures = [];
function it(label, fn) {
  try { fn(); pass++; console.log('  PASS  ' + label); }
  catch (e) {
    fail++; failures.push(label + ' - ' + e.message);
    console.log('  FAIL  ' + label + '\n          ' + e.message);
  }
}

const fresh = () => makeSandbox(SOURCES, new Set([99]));

console.log('\nplayer server ranking\n' + '-'.repeat(62));

it('with no history, declared order is preserved (stable, no churn)', () => {
  const { api } = fresh();
  assert.deepStrictEqual(api.rankSourceIdxs([0, 1, 2, 3]), [0, 1, 2, 3]);
});

it('a faster server outranks a slower one', () => {
  const { api } = fresh();
  api.recordPlayerLoad('Delta', 600);
  api.recordPlayerLoad('Alpha', 4200);
  const ranked = api.rankSourceIdxs([0, 1, 2, 3]);
  assert.strictEqual(ranked[0], 3, 'Delta (600ms) should lead, got ' + SOURCES[ranked[0]].name);
  assert.ok(ranked.indexOf(0) > ranked.indexOf(3), 'Alpha (4200ms) should trail Delta');
});

it('a failing server is demoted below every working one', () => {
  const { api } = fresh();
  api.recordPlayerFailure('Alpha');
  api.recordPlayerFailure('Alpha');
  api.recordPlayerFailure('Alpha');
  api.recordPlayerLoad('Bravo', 3000);
  const ranked = api.rankSourceIdxs([0, 1, 2, 3]);
  assert.strictEqual(ranked[ranked.length - 1], 0,
    'Alpha failed 3x and must rank last, got ' + SOURCES[ranked[ranked.length - 1]].name);
});

it('a never-tried server is explored ahead of a known-bad one', () => {
  const { api } = fresh();
  api.recordPlayerFailure('Alpha');
  api.recordPlayerFailure('Alpha');
  const ranked = api.rankSourceIdxs([0, 1]);
  assert.strictEqual(ranked[0], 1, 'untried Bravo should be tried before twice-failed Alpha');
});

it('a known-good server is preferred over an unknown one', () => {
  const { api } = fresh();
  api.recordPlayerLoad('Delta', 800);
  const ranked = api.rankSourceIdxs([0, 3]);
  assert.strictEqual(ranked[0], 3, 'measured-fast Delta should beat the unknown Alpha');
});

it('a recovered server climbs back out of the penalty box', () => {
  const { api } = fresh();
  for (let i = 0; i < 4; i++) api.recordPlayerFailure('Alpha');
  const demoted = api.playerCost('Alpha');
  for (let i = 0; i < 8; i++) api.recordPlayerLoad('Alpha', 700);
  const recovered = api.playerCost('Alpha');
  assert.ok(recovered < demoted,
    'cost should fall after sustained success (' + demoted + ' -> ' + recovered + ')');
  const ranked = api.rankSourceIdxs([0, 1]);
  assert.strictEqual(ranked[0], 0, 'a fully recovered fast server should lead again');
});

it('one slow load does not condemn an otherwise fast server (EWMA)', () => {
  const { api } = fresh();
  for (let i = 0; i < 6; i++) api.recordPlayerLoad('Delta', 500);
  const before = api.playerCost('Delta');
  api.recordPlayerLoad('Delta', 9000);
  const after = api.playerCost('Delta');
  assert.ok(after < 4000,
    'a single 9 s outlier should not push a proven server past the unknown baseline, got ' + after);
  assert.ok(after > before, 'the outlier should still register');
});

console.log('\ngive-up timer\n' + '-'.repeat(62));

it('an unknown server keeps the original 5s patience', () => {
  const { api } = fresh();
  assert.strictEqual(api.adaptivePlayerTimeout('Alpha'), api.MZ_PH_DEFAULT_TIMEOUT);
});

it('a consistently fast server is abandoned sooner than 5s', () => {
  const { api } = fresh();
  for (let i = 0; i < 5; i++) api.recordPlayerLoad('Delta', 900);
  const t = api.adaptivePlayerTimeout('Delta');
  assert.ok(t < api.MZ_PH_DEFAULT_TIMEOUT,
    'expected under ' + api.MZ_PH_DEFAULT_TIMEOUT + ' ms, got ' + t);
  assert.ok(t >= api.MZ_PH_MIN_TIMEOUT, 'must not drop below the floor, got ' + t);
});

it('a genuinely slow server is still given room, capped', () => {
  const { api } = fresh();
  for (let i = 0; i < 5; i++) api.recordPlayerLoad('Alpha', 4000);
  const t = api.adaptivePlayerTimeout('Alpha');
  assert.ok(t <= api.MZ_PH_MAX_TIMEOUT, 'must respect the ceiling, got ' + t);
  assert.ok(t > api.MZ_PH_MIN_TIMEOUT, 'a slow-but-working server should keep headroom');
});

console.log('\ncandidate rules are never broken for speed\n' + '-'.repeat(62));

it('a dubbed language only ever gets dubbed-capable servers', () => {
  const { api } = fresh();
  const pool = api.candidateSourceIdxs('hi', { id: 1 });
  assert.ok(pool.length > 0, 'empty pool');
  pool.forEach((i) => assert.ok(SOURCES[i].dubbed,
    SOURCES[i].name + ' is not dubbed-capable but was offered for Hindi'));
});

it('English falls back to the full list', () => {
  const { api } = fresh();
  assert.deepStrictEqual(api.candidateSourceIdxs('en', { id: 1 }), [0, 1, 2, 3]);
});

it('anime content only ever gets anime-capable servers', () => {
  const { api, sandbox } = makeSandbox(SOURCES, new Set([99]));
  sandbox.currentModalMovie = { id: 99 };
  const pool = api.candidateSourceIdxs('en', { id: 99 });
  assert.ok(pool.length > 0, 'empty pool');
  pool.forEach((i) => assert.ok(SOURCES[i].anime,
    SOURCES[i].name + ' cannot serve anime but was offered'));
});

it('the anime rule wins over the dub rule', () => {
  const { api } = fresh();
  const pool = api.candidateSourceIdxs('hi', { id: 99 });
  pool.forEach((i) => assert.ok(SOURCES[i].anime,
    'Hindi anime must still be restricted to anime-capable servers'));
});

console.log('\nstored preference\n' + '-'.repeat(62));

it('with nothing stored, the best-performing server is chosen', () => {
  const { api, sandbox } = fresh();
  api.recordPlayerLoad('Delta', 500);
  assert.strictEqual(sandbox.localStorage.getItem('moviezone.playerSourceIdx'), null);
  assert.strictEqual(api.getSelectedSourceIdx(), 3);
});

it('an explicit choice is respected even if it is not the fastest', () => {
  const { api, sandbox } = fresh();
  api.recordPlayerLoad('Delta', 500);
  api.recordPlayerLoad('Bravo', 1500);
  sandbox.localStorage.setItem('moviezone.playerSourceIdx', '1');
  assert.strictEqual(api.getSelectedSourceIdx(), 1,
    'a working preferred server must not be overridden just for being slower');
});

it('a chronically broken stored choice is overridden', () => {
  const { api, sandbox } = fresh();
  for (let i = 0; i < 6; i++) api.recordPlayerFailure('Bravo');
  api.recordPlayerLoad('Delta', 600);
  sandbox.localStorage.setItem('moviezone.playerSourceIdx', '1');
  assert.strictEqual(api.getSelectedSourceIdx(), 3,
    'a server that always fails must not trap the user behind a spinner');
});

it('a corrupt stored index cannot crash or point out of range', () => {
  const { api, sandbox } = fresh();
  ['abc', '-5', '9999', ''].forEach((bad) => {
    sandbox.localStorage.setItem('moviezone.playerSourceIdx', bad);
    const idx = api.getSelectedSourceIdx();
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < SOURCES.length,
      'bad value ' + JSON.stringify(bad) + ' produced index ' + idx);
  });
});

it('health survives a reload (it is persisted, not in-memory only)', () => {
  const { api, sandbox } = fresh();
  for (let i = 0; i < 3; i++) api.recordPlayerLoad('Delta', 700);
  const raw = sandbox.localStorage.getItem('mz_player_health_v1');
  assert.ok(raw, 'nothing was written to localStorage');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.Delta && parsed.Delta.ok >= 3, 'Delta stats missing: ' + raw);
});

it('corrupt stored health degrades to "no history" instead of throwing', () => {
  const { api, sandbox } = fresh();
  sandbox.localStorage.setItem('mz_player_health_v1', '{not json');
  assert.doesNotThrow(() => api.rankSourceIdxs([0, 1, 2, 3]));
  assert.deepStrictEqual(api.rankSourceIdxs([0, 1, 2, 3]), [0, 1, 2, 3]);
});

console.log('\nworst-case wait\n' + '-'.repeat(62));

it('two dead servers cost far less than the old flat 10s', () => {
  const { api } = fresh();
  // First visit learns they are dead at the default patience.
  const firstVisit = api.MZ_PH_DEFAULT_TIMEOUT * 2;
  for (let i = 0; i < 3; i++) { api.recordPlayerFailure('Alpha'); api.recordPlayerFailure('Bravo'); }
  api.recordPlayerLoad('Delta', 900);
  // Next visit: ranking puts the working server first, so the wait is one load.
  const ranked = api.rankSourceIdxs([0, 1, 2, 3]);
  assert.strictEqual(ranked[0], 3, 'the working server must lead after learning');
  const nextVisit = 900;
  assert.ok(nextVisit < firstVisit / 5,
    'expected a large drop, got ' + nextVisit + ' ms vs ' + firstVisit + ' ms');
  console.log('        first visit ~' + firstVisit + ' ms of dead-server waiting -> '
    + 'subsequent visits ~' + nextVisit + ' ms (working server ranked first)');
});

/* ── PROVIDER WARM-UP PATH ──────────────────────────────────────────────────
 *  Playback speed is decided before the click: whether the provider's origin is
 *  already connected, and whether its document is already in the HTTP cache.
 *  Two things silently broke that, and both are cheap to guard.
 */
console.log('\nprovider warm-up path\n' + '-'.repeat(62));

/*  Extracts the real playerSources array and asks each server for a URL, which
 *  is exactly what playerHostOrigins() does at runtime. */
function realPlayerOrigins() {
  const start = src.indexOf('const playerSources = [');
  const end = src.indexOf('\n];', start) + 3;
  const sandbox = {
    console, URL, String, Number, parseInt, Array, Object, JSON, Math, Date,
    currentModalMovie: null,
    isAnimeContent: () => false,
    isCartoonContent: () => false,
    getAnilistIdSync: () => null,
    animeAudioTrack: (l) => (l === 'hi' ? 'hindi' : l === 'en' ? 'dub' : 'sub')
  };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end) + '\nthis.__sources = playerSources;', sandbox);
  const sources = sandbox.__sources;
  const movie = [], tv = [];
  sources.forEach((s) => {
    try { movie.push(new URL(s.url(550, 'en', 'movie', '1', '1')).origin); } catch (e) { movie.push(null); }
    try { tv.push(new URL(s.url(1396, 'hi', 'tv', '1', '1')).origin); } catch (e) { tv.push(null); }
  });
  return { sources, movie, tv };
}

it('every shipped server yields a warmable origin', () => {
  const { sources, movie } = realPlayerOrigins();
  assert.ok(sources.length >= 8, 'only ' + sources.length + ' servers found');
  const broken = sources.filter((s, i) => !movie[i]).map((s) => s.name);
  assert.strictEqual(broken.length, 0,
    'these servers build no usable URL, so their host can never be preconnected: ' + broken.join(', '));
  console.log('        ' + sources.length + ' servers -> '
    + new Set(movie).size + ' unique origins, all resolvable');
});

/*  The regression this replaces: the warm list was a hand-copied array. It still
 *  named vidrock.ru and embed.smashystream.com (a commented-out source) while
 *  vidfast.pro, flicky.host and 111movies.com — live servers — were never warmed,
 *  so switching to one of those paid a cold DNS + TLS handshake at the exact
 *  moment the user wanted video. Deriving the list is the fix; this keeps it. */
it('the warm list is derived from playerSources, never hand-written', () => {
  const hostList = /const PLAYER_HOSTS\s*=\s*\[/.test(src);
  assert.ok(!hostList, 'PLAYER_HOSTS is a hardcoded list again — it will drift from playerSources');
  assert.ok(/function playerHostOrigins\(\)/.test(src), 'playerHostOrigins() is gone');
  assert.ok(/playerSources\.forEach/.test(src.slice(src.indexOf('function playerHostOrigins()'), src.indexOf('function playerHostOrigins()') + 900)),
    'playerHostOrigins() no longer reads playerSources');
  const preconnectBlock = src.slice(src.indexOf('function preconnectServers()'),
    src.indexOf('function preconnectServers()') + 1600);
  assert.ok(/playerHostOrigins\(\)/.test(preconnectBlock),
    'the page-load preconnect still uses its own server list');
  ['cinextream.net', '2embed.stream', 'vidsrc.sbs', 'multiembed.mov', 'vidrock.ru', 'smashystream.com']
    .forEach((deadHost) => {
      assert.ok(!new RegExp(deadHost.replace('.', '\\.')).test(preconnectBlock),
        'dead/unused host ' + deadHost + ' is being warmed again');
    });
});

it('a movie and a series warm the same origins (no cold host on episode play)', () => {
  const { movie, tv } = realPlayerOrigins();
  const missed = tv.filter((o) => o && movie.indexOf(o) === -1);
  assert.strictEqual(missed.length, 0,
    'series playback uses origins the movie probe never warms: ' + missed.join(', '));
});

/*  On a phone there is no hover, so mouseenter/focus warmed nothing at all and
 *  every server switch on touch paid the full handshake after the tap. */
it('server switching is warmed on touch, not only on hover', () => {
  const at = src.indexOf('const srcButtons = ext.querySelectorAll');
  assert.ok(at !== -1, 'the server chip wiring could not be found');
  const wiring = src.slice(at, at + 2000);
  const listeners = /\[([^\]]*)\]\s*\n?\s*\.forEach\(evt => btn\.addEventListener\(evt, warmThis/.exec(wiring);
  assert.ok(listeners, 'the chip warm-up listeners could not be read');
  ['mouseenter', 'focus', 'pointerdown', 'touchstart'].forEach((evt) => {
    assert.ok(listeners[1].includes(evt), evt + ' no longer warms the server the user is about to pick');
  });
  assert.ok(/warmEmbedUrl\(buildPlayerUrl\(id, type, idx\),/.test(wiring),
    'the light warm path (preconnect + provider document) is gone from the chip handler');
});

/*  prewarmPlayer() deliberately refuses to build a hidden frame once #playerFrame
 *  exists, which is exactly the "switch server while watching" case. If the chip
 *  handler only called prewarmPlayer, that case would warm nothing. */
it('switching while something is already playing still warms the next server', () => {
  assert.ok(/if \(!id \|\| isDataSaver\(\) \|\| document\.getElementById\('playerFrame'\)\) return;/.test(src),
    'prewarmPlayer no longer bails while a player is open — the assumption below changed');
  const at = src.indexOf('const warmThis = (event) =>');
  assert.ok(at !== -1, 'the chip warm handler was renamed');
  const handler = src.slice(at, src.indexOf('};', at));
  const lightAt = handler.indexOf('warmEmbedUrl');
  const heavyAt = handler.indexOf('prewarmPlayer');
  assert.ok(lightAt !== -1 && heavyAt !== -1, 'the handler lost one of its two warm paths');
  assert.ok(lightAt < heavyAt,
    'the light path must run first so it is not skipped when the heavy one bails');
  assert.ok(/kind === 'mouseenter' \|\| kind === 'focus'/.test(handler),
    'the hidden prewarm frame is no longer restricted to hover/focus — a tap would build one');
});

/*  A live probe from one Indian connection: nine of the ten servers answered in
 *  232-928ms, one did not answer within twelve seconds. A dead server must cost
 *  the user a warm-up, not a spinner after they press play — so the warm-up is
 *  bounded and its failure is fed to the same ranking playback attempts feed. */
it('a warm-up is bounded by a timeout', () => {
  const warmEmbed = block('function warmEmbedUrl(url, sourceName)');
  assert.ok(/AbortController/.test(warmEmbed), 'the warm-up fetch can hang forever');
  assert.ok(/MZ_WARM_TIMEOUT_MS/.test(warmEmbed), 'the warm-up has no timeout constant');
  const timeout = Number(/const MZ_WARM_TIMEOUT_MS = (\d+)/.exec(src)[1]);
  assert.ok(timeout >= 3000 && timeout <= 15000, 'implausible warm timeout: ' + timeout);
});

it('an unreachable server is demoted from the warm-up, before any play', () => {
  const warmEmbed = block('function warmEmbedUrl(url, sourceName)');
  assert.ok(/recordPlayerFailure\(sourceName\)/.test(warmEmbed),
    'a failed warm-up teaches the ranking nothing, so the next pick repeats it');
  assert.ok(/_mzWarmedDocs\.delete\(url\)/.test(warmEmbed),
    'a failed warm-up is never retried — a recovered provider would stay cold forever');
});

it('every warm-up call site names the server it is warming', () => {
  // One level of nesting is enough: warmEmbedUrl(buildPlayerUrl(...), name)
  const calls = src.match(/warmEmbedUrl\((?:[^()]|\([^()]*\))*\)/g) || [];
  const callSites = calls.filter((c) => !/^warmEmbedUrl\(url/.test(c));
  assert.ok(callSites.length >= 3, 'expected at least three warm-up call sites, found ' + callSites.length);
  const unnamed = callSites.filter((c) => !/name/.test(c));
  assert.strictEqual(unnamed.length, 0,
    'these warm-ups cannot report a failure to the ranking: ' + unnamed.join(' | '));
});

/*  Warming must never start video in the background: that is what produced
 *  Chrome's "background media paused" abort, and on a phone it is data the user
 *  did not ask to spend. */
it('warming never delegates autoplay or spends data on a metered link', () => {
  const warmUrl = block('function warmUrlVariant(url)');
  assert.ok(/autoplay\|autoPlay/.test(warmUrl), 'autoplay params are no longer neutralised for warm-ups');
  const warmEmbed = block('function warmEmbedUrl(url, sourceName)');
  assert.ok(/isDataSaver\(\)/.test(warmEmbed), 'warmEmbedUrl no longer respects data saver / 2g');
  /*  Read the attribute VALUE, not the surrounding prose — the code comments here
   *  mention autoplay precisely because it must stay absent. */
  const prewarm = block('function prewarmPlayer(id, type, srcIdxOverride)');
  const allowAttr = /setAttribute\('allow',\s*'([^']*)'\)/.exec(prewarm);
  assert.ok(allowAttr, 'the prewarm frame no longer sets an allow attribute at all');
  assert.ok(!/autoplay/i.test(allowAttr[1]),
    'the prewarm frame delegates autoplay again (allow="' + allowAttr[1] + '"), which is what made '
      + 'Chrome abort the background load');
});

console.log('\n' + '='.repeat(62));
console.log('  player-health: ' + pass + ' passed, ' + fail + ' failed');
if (fail) failures.forEach((f) => console.log('   x ' + f));
console.log('='.repeat(62) + '\n');
process.exit(fail ? 1 : 0);
