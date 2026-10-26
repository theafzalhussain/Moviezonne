/*  ═══════════════════════════════════════════════════════════════════════════
 *  TOON HINDI — the anime + cartoon server, checked without the network
 *  ═══════════════════════════════════════════════════════════════════════════
 *
 *  toon-resolver.js maps a TMDB title onto AnimeSalt and hands back the
 *  multi-audio player its page embeds (see that file's header). Everything here
 *  runs against fixture HTML and a fake fetch, so it is deterministic and needs
 *  no credentials. The live behaviour was measured separately in real Chrome.
 *
 *  What is pinned, and why each one matters:
 *    - the request is validated before anything is fetched (it is a public route)
 *    - a title TMDB does not tag Animation/Kids never reaches AnimeSalt at all
 *    - the redirect target must look like a player, never an arbitrary URL
 *    - poster identity beats a name match; an ambiguous name match is refused
 *    - absolute episode numbering (long anime) maps by position
 *    - an upstream failure is not remembered as "not available"
 *    - the server is wired in both runtimes, and on the client it is the LAST
 *      entry (no existing server's index moves) and offered for animation only
 *
 *  Run: node toon-resolver-check.js
 *  ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const toon = require('./toon-resolver');

let passed = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + label);
  } catch (err) {
    failures.push(label);
    console.log('  FAIL  ' + label + '\n          ' + err.message);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────
const card = (kind, slug, title, poster) =>
  '<li><article class="post dfx fcl ' + kind + '"><header class="entry-header"><h2 class="entry-title" style="x">'
  + title + '</h2></header><div class="post-thumbnail or-1"><figure><img data-src="//image.tmdb.org/t/p/w500'
  + poster + '" class="lazyload"></figure></div><a href="https://animesalt.cx/' + (kind === 'series' ? 'series' : 'movies')
  + '/' + slug + '/" class="lnk-blk"></a></article></li>';
// AnimeSalt marks every card "movies" in the class and tells kinds apart by URL.
const searchPage = (cards, hasNext) => '<html><body><ul>' + cards.join('') + '</ul>'
  + (hasNext ? '<a href="https://animesalt.cx/page/2/?s=x">2</a>' : '') + '</body></html>';
const torofilm = (list) => 'https://animesalt.cx/wp-content/themes/torofilm/public/plyr/player.php?data='
  + encodeURIComponent(Buffer.from(JSON.stringify(list)).toString('base64'));
const playerPage = (iframes) => '<aside class="video-player">' + iframes.map((f) => '<iframe ' + f + ' frameborder="0"></iframe>').join('') + '</aside>';
const RAVOK = 'https://ravok.buzz/video/49182f81e6a13cf5eaa496d51fea6406';

// ── 1. request validation ─────────────────────────────────────────────────
(async () => {
  console.log('\ntoon hindi — anime + cartoon server');
  console.log('-'.repeat(72));

  await check('a well-formed series and film request parse', () => {
    assert.deepStrictEqual(toon.parseToonRequest({ type: 'tv', id: '31910', s: '16', e: '3' }), { type: 'tv', id: 31910, season: 16, episode: 3 });
    assert.deepStrictEqual(toon.parseToonRequest(new URLSearchParams('type=movie&id=372058')), { type: 'movie', id: 372058, season: 0, episode: 0 });
  });
  await check('anything else is refused before a single fetch', () => {
    [{ type: 'person', id: '1' }, { type: 'tv', id: '0' }, { type: 'tv', id: '12a' }, { type: 'movie', id: '1234567890' },
      { type: 'tv', id: '1', s: '0', e: '1' }, { type: 'tv', id: '1', s: '1', e: '-2' }, { type: 'tv', id: '1', s: '1.5', e: '1' },
      { type: 'tv', id: '1', s: '201', e: '1' }]
      .forEach((q) => assert.throws(() => toon.parseToonRequest(q), toon.ToonRequestError, JSON.stringify(q)));
  });

  // ── 2. parsing ──────────────────────────────────────────────────────────
  await check('search cards: kind from the URL, title, TMDB poster path', () => {
    const cards = toon.parseSearchCards(searchPage([
      card('series', 'naruto-shippuden', 'Naruto Shippuden', '/kV27j3Nz4d5z8u6mN3EJw9RiLg2.jpg'),
      card('movies', 'your-name', 'Your Name &#038; More', '/q719jXXEzOoYaps6babgKnONONX.jpg')
    ]));
    assert.deepStrictEqual(cards.map((c) => c.kind + ' ' + c.slug), ['series naruto-shippuden', 'movies your-name']);
    assert.strictEqual(cards[1].title, 'Your Name & More');
    assert.strictEqual(cards[0].poster, '/kV27j3Nz4d5z8u6mN3EJw9RiLg2.jpg');
  });
  await check('the multi-audio player wins over the per-language ones', () => {
    const p = toon.pickPlayer(playerPage(['src="' + RAVOK + '" data-src="' + RAVOK + '"',
      'data-src="' + torofilm([{ language: 'Hindi', link: 'https://player.abyssplayer.com/Pi1IUyAiT' }]) + '"']));
    assert.deepStrictEqual(p, { url: RAVOK, audio: 'multi' });
  });
  await check('without it, the Hindi per-language player is chosen over the others', () => {
    const p = toon.pickPlayer(playerPage(['data-src="' + torofilm([
      { language: 'Tamil', link: 'https://player.abyssplayer.com/TUeEBihEY' },
      { language: 'Hindi', link: 'https://player.abyssplayer.com/Pi1IUyAiT' }]) + '"']));
    assert.deepStrictEqual(p, { url: 'https://player.abyssplayer.com/Pi1IUyAiT', audio: 'hindi' });
  });
  await check('a page with only players we do not accept yields nothing', () => {
    assert.strictEqual(toon.pickPlayer(playerPage(['src="https://megaplay.buzz/stream/s-2/8242/sub"'])), null);
    assert.strictEqual(toon.pickPlayer(playerPage([])), null);
  });
  await check('the redirect target must be shaped like a player — never an arbitrary URL', () => {
    ['https://evil.example/', 'http://ravok.buzz/video/49182f81e6a13cf5eaa496d51fea6406',
      'https://ravok.buzz/video/49182f81e6a13cf5eaa496d51fea6406?next=https://evil.example',
      'https://ravok.buzz/video/../admin', 'https://animesalt.cx/video/49182f81e6a13cf5eaa496d51fea6406',
      'javascript:alert(1)'].forEach((u) => assert.strictEqual(toon.acceptMultiPlayer(u), null, u));
    ['https://evil.example/Pi1IUyAiT', 'https://player.abyssplayer.com/../x', 'http://player.abyssplayer.com/Pi1IUyAiT']
      .forEach((u) => assert.strictEqual(toon.acceptLanguagePlayer(u), null, u));
    assert.strictEqual(toon.acceptMultiPlayer('//ravok.buzz/video/49182f81e6a13cf5eaa496d51fea6406'), RAVOK);
  });
  await check('episodes: per-season numbering by number, absolute numbering by position', () => {
    const perSeason = [1, 2, 3].map((n) => ({ season: 2, number: n, slug: 'x' }));
    assert.strictEqual(toon.pickEpisode(perSeason, 3).number, 3);
    assert.strictEqual(toon.pickEpisode(perSeason, 4), null);
    const absolute = [349, 350, 351].map((n) => ({ season: 16, number: n, slug: 'x' }));
    assert.strictEqual(toon.pickEpisode(absolute, 1).number, 349);
    assert.strictEqual(toon.pickEpisode(absolute, 3).number, 351);
    assert.strictEqual(toon.pickEpisode(absolute, 4), null);
    const parsed = toon.parseSeasonEpisodes('<a href="https://animesalt.cx/episode/naruto-shippuden-16x350/"></a>'
      + '<a href="https://animesalt.cx/episode/naruto-shippuden-16x349/"></a><a href="https://animesalt.cx/episode/other-show-16x1/"></a>', 'naruto-shippuden');
    assert.deepStrictEqual(parsed.map((x) => x.number), [349, 350]);
  });
  await check('the unavailable page tells its parent, and echoes nothing it was given', () => {
    const html = toon.unavailablePageHtml('not-on-animesalt"><script>alert(1)</script>');
    assert.ok(/postMessage\(\{type:"mz-toon:unavailable",reason:"not-on-animesaltscriptalertscript"\}/.test(html), html.slice(-200));
    assert.ok(!/<script>alert/.test(html));
    assert.ok(/frame-ancestors 'self'/.test(toon.UNAVAILABLE_FRAME_ANCESTORS));
  });

  // ── 3. the resolver against a fake AnimeSalt ────────────────────────────
  function fakeSite(routes) {
    const calls = [];
    const fetchFn = async (url, init) => {
      const u = String(url);
      calls.push((init && init.method || 'GET') + ' ' + u.replace(toon.ORIGIN, ''));
      const route = routes.find(([re]) => re.test(u) && (!init || !init.method || init.method === 'GET' || re.post));
      if (!route) return new Response('nope', { status: 404 });
      const out = typeof route[1] === 'function' ? route[1](u, init) : route[1];
      if (out instanceof Error) throw out;
      return new Response(out, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    return { fetchFn, calls };
  }
  const series = (id) => ({ id, name: 'Naruto Shippuden', original_name: 'ナルト 疾風伝', genres: [{ id: 16 }],
    poster_path: '/a.jpg', images: { posters: [{ file_path: '/kV27j3Nz4d5z8u6mN3EJw9RiLg2.jpg' }] }, alternative_titles: { results: [] } });

  await check('a title TMDB does not tag Animation/Kids never reaches AnimeSalt', async () => {
    const site = fakeSite([]);
    const r = toon.createToonResolver({ fetch: site.fetchFn, tmdbDetails: async () => ({ id: 1396, name: 'Breaking Bad', genres: [{ id: 18 }] }) });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '1396', s: '1', e: '1' }));
    assert.strictEqual(out.available, false);
    assert.strictEqual(out.reason, 'not-animated');
    assert.deepStrictEqual(site.calls, []);
  });
  await check('poster identity picks the right series even when the name differs', async () => {
    const seasonRe = /admin-ajax\.php$/; seasonRe.post = true;
    const site = fakeSite([
      [/\?s=Naruto%20Shippuden$/, searchPage([
        card('movies', 'naruto-shippuden-movie', 'Naruto Shippuden', '/zzz.jpg'),
        card('series', 'boruto', 'Naruto Shippuden', '/other.jpg'),
        card('series', 'naruto-shippuden-hindi', 'Naruto: Shippuden (Hindi)', '/kV27j3Nz4d5z8u6mN3EJw9RiLg2.jpg')])],
      [/\/series\/naruto-shippuden-hindi\/$/, '<div data-post="352" data-season="1"></div><div data-post="352" data-season="16"></div>'],
      [seasonRe, (u, init) => (/season=16/.test(init.body)
        ? '<a href="https://animesalt.cx/episode/naruto-shippuden-hindi-16x349/"></a><a href="https://animesalt.cx/episode/naruto-shippuden-hindi-16x350/"></a>'
        : '')],
      [/\/episode\/naruto-shippuden-hindi-16x350\/$/, playerPage(['src="' + RAVOK + '"'])]
    ]);
    const r = toon.createToonResolver({ fetch: site.fetchFn, tmdbDetails: async (t, id) => series(id) });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '31910', s: '16', e: '2' }));
    assert.strictEqual(out.available, true, JSON.stringify(out));
    assert.strictEqual(out.url, RAVOK);
    assert.deepStrictEqual(out.match, { slug: 'naruto-shippuden-hindi', by: 'poster', episode: '16x350' });
    assert.ok(site.calls.every((c) => !/[ぁ-ん]|ナルト/.test(decodeURIComponent(c))), 'searched a non-Latin title: ' + site.calls.join(', '));
  });
  await check('a name match counts only when it is the single candidate of that kind', async () => {
    const twins = fakeSite([[/\?s=Pok/, searchPage([card('series', 'pokemon-a', 'Pokémon', '/1.jpg'), card('series', 'pokemon-b', 'Pokemon', '/2.jpg')])]]);
    const r = toon.createToonResolver({ fetch: twins.fetchFn, tmdbDetails: async () => ({ id: 60572, name: 'Pokémon', genres: [{ id: 16 }], poster_path: '/x.jpg' }) });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '60572', s: '1', e: '1' }));
    assert.strictEqual(out.reason, 'not-on-animesalt', JSON.stringify(out));
  });
  await check('answers are memoised, and concurrent asks share one lookup', async () => {
    const site = fakeSite([
      [/\?s=Your%20Name$/, searchPage([card('movies', 'your-name', 'Your Name.', '/q.jpg')])],
      [/\/movies\/your-name\/$/, playerPage(['src="' + RAVOK + '"'])]
    ]);
    const r = toon.createToonResolver({ fetch: site.fetchFn, tmdbDetails: async () => ({ id: 372058, title: 'Your Name', genres: [{ id: 16 }], poster_path: '/q.jpg' }) });
    const req = toon.parseToonRequest({ type: 'movie', id: '372058' });
    const [a, b] = await Promise.all([r.resolve(req), r.resolve(req)]);
    const c = await r.resolve(req);
    assert.ok(a.available && b.available && c.available);
    assert.strictEqual(c.cache, 'HIT');
    assert.strictEqual(site.calls.length, 2, site.calls.join(', '));
  });
  await check('an upstream failure is reported, not remembered as "not available"', async () => {
    let down = true;
    const site = fakeSite([
      [/\?s=Your%20Name$/, () => (down ? new Error('ECONNRESET') : searchPage([card('movies', 'your-name', 'Your Name', '/q.jpg')]))],
      [/\/movies\/your-name\/$/, playerPage(['src="' + RAVOK + '"'])]
    ]);
    const r = toon.createToonResolver({ fetch: site.fetchFn, log: () => {}, tmdbDetails: async () => ({ id: 372058, title: 'Your Name', genres: [{ id: 16 }], poster_path: '/q.jpg' }) });
    const req = toon.parseToonRequest({ type: 'movie', id: '372058' });
    const first = await r.resolve(req);
    assert.strictEqual(first.reason, 'upstream-error');
    down = false;
    const second = await r.resolve(req);
    assert.strictEqual(second.available, true, JSON.stringify(second));
  });

  // ── 4. wiring ───────────────────────────────────────────────────────────
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');
  await check('both runtimes serve /api/toon/resolve and /api/toon/embed from the shared module', () => {
    assert.ok(/require\('\.\/toon-resolver'\)/.test(server) && /app\.get\('\/api\/toon\/embed', apiLimiter/.test(server)
      && /app\.get\('\/api\/toon\/resolve', apiLimiter/.test(server), 'server.js');
    assert.ok(/import toonResolver from '\.\/toon-resolver\.js'/.test(worker)
      && /pathname === '\/api\/toon\/resolve' \|\| pathname === '\/api\/toon\/embed'/.test(worker), 'worker.js');
  });

  const start = client.indexOf('const playerSources = [');
  const end = client.indexOf('\n];', start) + 3;
  const evalSources = (m, missing) => {
    const sb = { console, URL, String, Number, parseInt, Array, Object, JSON, Math, Date, encodeURIComponent,
      currentModalMovie: m, TOON_API: '/api/toon',
      isAnimeContent: () => false, isCartoonContent: (x) => !!(x && (x.genre_ids || []).some((g) => g === 16 || g === 10762)),
      toonKnownMissing: () => !!missing, getAnilistIdSync: () => null, animeAudioTrack: () => 'sub' };
    vm.createContext(sb);
    vm.runInContext(client.slice(start, end) + '\nthis.__s = playerSources;', sb);
    return sb.__s;
  };
  await check('the client server is the LAST entry, so no existing server changes index', () => {
    const srcs = evalSources(null);
    assert.strictEqual(srcs[srcs.length - 1].name, 'Toon Hindi');
    assert.strictEqual(srcs.filter((s) => s.toon).length, 1, 'exactly one toon server');
  });
  await check('it plays through the same-origin embed route, for films and episodes', () => {
    const s = evalSources(null).find((x) => x.toon);
    assert.strictEqual(s.url(31910, 'hi', 'tv', '16', '2'), 'https://moviezone.dev/api/toon/embed?type=tv&id=31910&s=16&e=2');
    assert.strictEqual(s.url(372058, 'hi', 'movie', '1', '1'), 'https://moviezone.dev/api/toon/embed?type=movie&id=372058');
    assert.deepStrictEqual(Array.from(s.hosts).sort(), ['https://player.abyssplayer.com', 'https://ravok.buzz']);
  });
  await check('it rules itself out for live action and for a title it already said it lacks', () => {
    assert.strictEqual(evalSources({ id: 1, genre_ids: [18] }).find((x) => x.toon).skip(), true);
    assert.strictEqual(evalSources({ id: 2, genre_ids: [16] }).find((x) => x.toon).skip(), false);
    assert.strictEqual(evalSources({ id: 2, genre_ids: [16] }, true).find((x) => x.toon).skip(), true);
  });
  await check('the picker shows it only for animated titles; Try All honours skip()', () => {
    assert.ok(/\.filter\(\(s\) => !s\.toon \|\| isCartoonContent\(currentModalMovie\)\)/.test(client));
    assert.ok(/if \(!s\.dubbed\) return;\s*if \(typeof s\.skip === 'function'\)/.test(client));
  });
  await check('its "not on this server" page fails over at once without overwriting the saved pick', () => {
    assert.ok(/d\.type !== 'mz-toon:unavailable'/.test(client));
    assert.ok(/autoRetryNextServer\(m\.id, idx, getSelectedLang\(\), getSelectedQuality\(\), m\.media_type, \{ keepPick: true, reason: 'unavailable' \}\)/.test(client));
  });

  console.log('-'.repeat(72));
  console.log('  toon-resolver-check: ' + passed + ' passed, ' + failures.length + ' failed\n');
  process.exit(failures.length ? 1 : 0);
})();
