/*  ═══════════════════════════════════════════════════════════════════════════
 *  TOON HINDI — the anime + cartoon server, checked without the network
 *  ═══════════════════════════════════════════════════════════════════════════
 *
 *  toon-resolver.js maps a TMDB title onto two Hindi libraries (AnimeSalt,
 *  ToonStream), merges their players, adds backups, and serves the Toon Hindi
 *  player page that switches between them (see that file's header).
 *  Everything here runs against fixture HTML and a fake fetch, so it is
 *  deterministic and needs no credentials. The live behaviour was measured
 *  separately in real Chrome.
 *
 *  What is pinned, and why each one matters:
 *    - the request is validated before anything is fetched (it is a public route)
 *    - a player URL must look like a player, never an arbitrary URL
 *    - poster identity beats a name match; an ambiguous name match is refused
 *    - absolute episode numbering (long anime) maps by position
 *    - an upstream failure, or a library still running, is never remembered
 *      or reported as "not available"
 *    - both libraries are asked; multi-audio first; one failing never hides
 *      the other
 *    - every answer carries backups, so the server always has something to play
 *    - the player page runs under a nonce CSP and echoes nothing it was given
 *    - the server is wired in both runtimes, and on the client it is the LAST
 *      entry (no existing server's index moves) and never moves a hand pick
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
const TS = toon.TOONSTREAM_ORIGIN;
// ToonStream: relative links, eager src posters, whitespace inside the title.
const tsCard = (kind, slug, title, poster) =>
  '<li><article class="post dfx fcl movies"><header class="entry-header"><h2 class="entry-title">\n    ' + title
  + '\n  </h2></header><div class="post-thumbnail or-1"><figure><img loading="lazy" src="https://image.tmdb.org/t/p/w780'
  + poster + '" alt="x"></figure></div><a href="/' + kind + '/' + slug + '" class="lnk-blk"></a></article></li>';
// ToonStream episode/film page: <div id="options-N"><iframe>, then the language tabs.
const tsPlayerPage = (srcs, language) => srcs.map((src, i) => '<div\n  id="options-' + i + '"\n  class="video aa-tb hdd">\n  <iframe\n  '
  + (i ? 'data-src' : 'src') + '="' + src + '"\n  frameborder="0"\n  loading="lazy">\n</iframe></div>').join('')
  + '<aside class="video-options"><div class="d-flex-ch mb-10 btr"><span\n tab="ln0"\n class="btn rtg active">\n  ' + (language || 'Multi Audio')
  + '\n </span></div><div\n id="ln0"\n class="lrt active"><ul class="aa-tbs aa-tbs-video">'
  + srcs.map((s, i) => '<li><a class="btn" href="#options-' + i + '">Server <span>' + (i + 1) + '</span></a></li>').join('') + '</ul></div></aside>';
const ABYSS = 'https://abyssplayer.com/29pJ-4F4A';

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
  await check('the unavailable page tells its parent, says why, and echoes nothing it was given', () => {
    const html = toon.unavailablePageHtml('bad-request"><script>alert(1)</script>');
    assert.ok(/postMessage\(\{type:"mz-toon:unavailable",reason:"bad-requestscriptalertscript"\}/.test(html), html.slice(-200));
    assert.ok(!/<script>alert/.test(html));
    assert.ok(/cannot be opened on Toon Hindi/.test(toon.unavailablePageHtml('bad-request')));
    assert.ok(!/another server is being opened/.test(html), 'the page must not promise a server switch');
    assert.ok(/frame-ancestors 'self'/.test(toon.UNAVAILABLE_FRAME_ANCESTORS));
  });
  await check('ToonStream cards: relative links, src posters, trimmed titles', () => {
    const cards = toon.parseSearchCards('<ul>' + tsCard('series', 'spongebob-squarepants', 'SpongeBob SquarePants', '/amvt.jpg')
      + tsCard('movies', 'inside-out-2', 'Inside Out 2', '/io2.jpg') + tsCard('series', 'jaadugar:-a-witch', 'Jaadugar', '/j.jpg') + '</ul>');
    assert.deepStrictEqual(cards.map((c) => [c.kind, c.slug, c.title, c.poster]),
      [['series', 'spongebob-squarepants', 'SpongeBob SquarePants', '/amvt.jpg'], ['movies', 'inside-out-2', 'Inside Out 2', '/io2.jpg']]);
  });
  await check('ToonStream players: only hosts measured playing, multi-audio first, ad redirectors refused', () => {
    const page = tsPlayerPage(['https://filesforever.link/embed/phxqppq', 'https://vidstreaming.xyz/v/6O3jVXTeOSSx/',
      ABYSS, 'https://rubystm.com/e/g5nevagd1dp0.html', RAVOK, 'https://abyssplayer.com/../../etc']);
    assert.deepStrictEqual(toon.toonstreamPlayers(page), [{ url: ABYSS, audio: 'multi' }, { url: RAVOK, audio: 'multi' }]);
    assert.deepStrictEqual(toon.toonstreamPlayers(tsPlayerPage([ABYSS], 'Hindi')), [{ url: ABYSS, audio: 'hindi' }]);
    assert.deepStrictEqual(toon.toonstreamPlayers(tsPlayerPage(['https://filesforever.link/embed/x1'])), []);
  });
  await check('names without a Latin letter are not searched, and digit-only slugs are never probed', () => {
    const names = toon.searchNames({ title: 'Toy Story 4', original_title: 'टॉय स्टोरी 4',
      alternative_titles: { titles: [{ iso_3166_1: 'IN', title: '4' }, { iso_3166_1: 'US', title: 'Toy Story Four' }] } });
    assert.deepStrictEqual(names, ['Toy Story 4', 'Toy Story Four']);
    const slugs = toon.probeSlugs({ release_date: '2019-06-19' }, ['4', 'Toy Story 4']);
    assert.ok(slugs.every((s) => /[a-z]/.test(s)), slugs.join(', '));
    assert.ok(slugs.indexOf('toy-story-4-2019') !== -1);
  });
  await check('backups: fixed templates, numeric ids only, VidRift with an origin referrer', () => {
    const tv = toon.backupSources(toon.parseToonRequest({ type: 'tv', id: '387', s: '2', e: '5' }));
    assert.deepStrictEqual(tv.map((b) => b.key), ['vidrift', 'moviesapi', 'vidnest', 'vidzee']);
    assert.strictEqual(tv[0].url, 'https://embed.vidrift.net/embed/tv/387/2/5?autoplay=1&brandColor=f5c518');
    assert.strictEqual(tv[0].referrer, 'origin');
    assert.ok(tv.slice(1).every((b) => b.referrer === 'no-referrer'));
    const film = toon.backupSources(toon.parseToonRequest({ type: 'movie', id: '354912' }));
    assert.deepStrictEqual(film.map((b) => b.key), ['vidnest', 'vidrift', 'vidzee']);
    assert.ok(film.concat(tv).every((b) => /^https:\/\/[a-z.]+\/[a-z/]*\d+(\/\d+\/\d+)?(\?autoplay=1&brandColor=f5c518)?$/.test(b.url)), 'a backup URL carries anything but ids');
    assert.deepStrictEqual(toon.backupSources({ type: 'movie', id: '1;alert(1)' }), []);
  });
  await check('the player page: nonce CSP, a script that parses, data escaped, nothing from the URL', () => {
    const backups = toon.backupSources(toon.parseToonRequest({ type: 'tv', id: '387', s: '1', e: '1' }));
    backups.push({ key: 'x', url: 'https://example.invalid/</script><script>alert(1)</script>', referrer: 'no-referrer' });
    const html = toon.playerPageHtml('n0nce"x', backups);
    assert.ok(/<script nonce="n0ncex">/.test(html) && /<style nonce="n0ncex">/.test(html), 'nonce is sanitised and on both');
    assert.ok(!/<\/script><script>alert/.test(html), 'embedded data closed the script element');
    const scripts = html.match(/<script\b[^>]*>/g);
    assert.deepStrictEqual(scripts, ['<script type="application/json" id="bk">', '<script nonce="n0ncex">']);
    assert.ok(!/\son[a-z]+=/i.test(html), 'inline event handler attribute');
    const js = /<script nonce="n0ncex">([\s\S]*?)<\/script>/.exec(html)[1];
    assert.doesNotThrow(() => new Function(js));
    assert.ok(/autoplay"\)==="0"/.test(js) && /if\(warm\)\{idle\(\);render\(\);return\}/.test(js), 'the warm-up copy must not frame a player');
    assert.ok(!/mz-toon:unavailable",reason:"(?!bad-request)/.test(js));
    const csp = toon.playerPageCsp('n0nce"x');
    assert.ok(/default-src 'none'/.test(csp) && /script-src 'nonce-n0ncex'/.test(csp) && /connect-src 'self'/.test(csp)
      && /frame-src https:/.test(csp) && /frame-ancestors 'self'/.test(csp), csp);
    assert.ok(/^[0-9a-f]{32}$/.test(toon.makeNonce()));
    assert.notStrictEqual(toon.makeNonce(), toon.makeNonce());
  });

  // ── 3. the resolver against fake libraries ──────────────────────────────
  function fakeSite(routes) {
    const calls = [];
    const fetchFn = async (url, init) => {
      const u = String(url);
      calls.push((init && init.method || 'GET') + ' ' + u.replace(toon.ORIGIN, ''));
      const route = routes.find(([re]) => re.test(u) && (!init || !init.method || init.method === 'GET' || re.post));
      if (!route) return new Response('nope', { status: 404 });
      const out = typeof route[1] === 'function' ? await route[1](u, init) : route[1];
      if (out instanceof Error) throw out;
      if (out && typeof out === 'object' && out.status) return new Response(out.body || '', { status: out.status, headers: { 'content-type': 'text/html' } });
      return new Response(out, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    return { fetchFn, calls };
  }
  const series = (id) => ({ id, name: 'Naruto Shippuden', original_name: 'ナルト 疾風伝', genres: [{ id: 16 }],
    poster_path: '/a.jpg', images: { posters: [{ file_path: '/kV27j3Nz4d5z8u6mN3EJw9RiLg2.jpg' }] }, alternative_titles: { results: [] } });

  // AnimeSalt alone: the identity, deadline and memo rules, one library at a time.
  const AS_ONLY = ['animesalt'];
  await check('a live-action title is looked up too, and a miss is reported as not in the library — with backups', async () => {
    const site = fakeSite([[/\?s=Breaking%20Bad$/, searchPage([card('series', 'one-piece-live-action', 'ONE PIECE Live Action', '/op.jpg')])]]);
    const r = toon.createToonResolver({ libraries: AS_ONLY, fetch: site.fetchFn, tmdbDetails: async () => ({ id: 1396, name: 'Breaking Bad', genres: [{ id: 18 }], poster_path: '/bb.jpg' }) });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '1396', s: '1', e: '1' }));
    assert.strictEqual(out.available, false);
    assert.strictEqual(out.reason, 'not-in-library');
    assert.deepStrictEqual(out.sources, []);
    assert.ok(out.backups.length >= 3 && /vidrift/.test(out.backups[0].url), 'a miss must still carry backups');
    assert.ok(site.calls.length >= 1 && site.calls.every((c) => /\?s=|^GET \/series\/breaking-bad(-2008)?\/$/.test(c)), site.calls.join(', '));
  });
  await check('...and live action AnimeSalt does carry is found by poster', async () => {
    const site = fakeSite([
      [/\?s=ONE%20PIECE$/, searchPage([card('series', 'one-piece-live-action', 'ONE PIECE Live Action', '/op.jpg')])],
      [/\/series\/one-piece-live-action\/$/, '<div data-post="9" data-season="1"></div>'],
      [Object.assign(/admin-ajax\.php$/, { post: true }), '<a href="https://animesalt.cx/episode/one-piece-live-action-1x1/"></a>'],
      [/\/episode\/one-piece-live-action-1x1\/$/, playerPage(['src="' + RAVOK + '"'])]
    ]);
    const r = toon.createToonResolver({ libraries: AS_ONLY, fetch: site.fetchFn, tmdbDetails: async () => ({ id: 111110, name: 'ONE PIECE', genres: [{ id: 10759 }], poster_path: '/op.jpg' }) });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '111110', s: '1', e: '1' }));
    assert.strictEqual(out.available, true, JSON.stringify(out));
    assert.strictEqual(out.match.slug, 'one-piece-live-action');
  });
  await check('a stalled upstream is answered "busy" at the deadline, and the late answer still lands in the memo', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const site = fakeSite([
      [/\?s=Your%20Name$/, async () => { await gate; return searchPage([card('movies', 'your-name', 'Your Name', '/q.jpg')]); }],
      [/\/movies\/your-name\/$/, playerPage(['src="' + RAVOK + '"'])]
    ]);
    const r = toon.createToonResolver({ libraries: AS_ONLY, fetch: site.fetchFn, deadlineMs: 50, log: () => {},
      tmdbDetails: async () => ({ id: 372058, title: 'Your Name', genres: [{ id: 16 }], poster_path: '/q.jpg' }) });
    const req = toon.parseToonRequest({ type: 'movie', id: '372058' });
    const t0 = Date.now();
    const first = await r.resolve(req);
    assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
    assert.strictEqual(first.reason, 'upstream-error');
    assert.ok(first.backups.length >= 3, 'busy must still carry backups');
    release();
    await new Promise((d) => setTimeout(d, 50));
    const second = await r.resolve(req);
    assert.strictEqual(second.available, true, JSON.stringify(second));
    assert.strictEqual(second.cache, 'HIT');
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
    const r = toon.createToonResolver({ libraries: AS_ONLY, fetch: site.fetchFn, tmdbDetails: async (t, id) => series(id) });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '31910', s: '16', e: '2' }));
    assert.strictEqual(out.available, true, JSON.stringify(out));
    assert.strictEqual(out.url, RAVOK);
    assert.deepStrictEqual(out.match, { library: 'animesalt', slug: 'naruto-shippuden-hindi', by: 'poster', episode: '16x350' });
    assert.deepStrictEqual(out.sources, [{ url: RAVOK, audio: 'multi', library: 'animesalt' }]);
    assert.ok(site.calls.every((c) => !/[ぁ-ん]|ナルト/.test(decodeURIComponent(c))), 'searched a non-Latin title: ' + site.calls.join(', '));
  });
  await check('a name match counts only when it is the single candidate of that kind', async () => {
    const twins = fakeSite([[/\?s=Pok/, searchPage([card('series', 'pokemon-a', 'Pokémon', '/1.jpg'), card('series', 'pokemon-b', 'Pokemon', '/2.jpg')])]]);
    const r = toon.createToonResolver({ libraries: AS_ONLY, fetch: twins.fetchFn, tmdbDetails: async () => ({ id: 60572, name: 'Pokémon', genres: [{ id: 16 }], poster_path: '/x.jpg' }) });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '60572', s: '1', e: '1' }));
    assert.strictEqual(out.reason, 'not-in-library', JSON.stringify(out));
  });
  await check('answers are memoised, and concurrent asks share one lookup', async () => {
    const site = fakeSite([
      [/\?s=Your%20Name$/, searchPage([card('movies', 'your-name', 'Your Name.', '/q.jpg')])],
      [/\/movies\/your-name\/$/, playerPage(['src="' + RAVOK + '"'])]
    ]);
    const r = toon.createToonResolver({ libraries: AS_ONLY, fetch: site.fetchFn, tmdbDetails: async () => ({ id: 372058, title: 'Your Name', genres: [{ id: 16 }], poster_path: '/q.jpg' }) });
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
    const r = toon.createToonResolver({ libraries: AS_ONLY, fetch: site.fetchFn, log: () => {}, tmdbDetails: async () => ({ id: 372058, title: 'Your Name', genres: [{ id: 16 }], poster_path: '/q.jpg' }) });
    const req = toon.parseToonRequest({ type: 'movie', id: '372058' });
    const first = await r.resolve(req);
    assert.strictEqual(first.reason, 'upstream-error');
    down = false;
    const second = await r.resolve(req);
    assert.strictEqual(second.available, true, JSON.stringify(second));
  });

  // Both libraries, as production runs them.
  const sponge = { id: 387, name: 'SpongeBob SquarePants', genres: [{ id: 16 }], poster_path: '/amvt.jpg', first_air_date: '1999-05-01' };
  const tsSpongeRoutes = () => [
    [/toonstream\.us\/s\?q=SpongeBob%20SquarePants&type=series$/, '<ul>' + tsCard('series', 'the-boys-presents-diabolical', 'The Boys Presents: Diabolical', '/boys.jpg')
      + tsCard('series', 'spongebob-squarepants', 'SpongeBob SquarePants', '/amvt.jpg') + '</ul>'],
    [/toonstream\.us\/series\/spongebob-squarepants\/$/, '<div><span data-season="1" data-url="/series/spongebob-squarepants/season/1"></span>'
      + '<span data-season="2" data-url="/series/spongebob-squarepants/season/2"></span></div>'],
    [/toonstream\.us\/series\/spongebob-squarepants\/season\/2$/, '<a href="/episode/spongebob-squarepants-2x1/"></a><a href="/episode/spongebob-squarepants-2x2/"></a>'],
    [/toonstream\.us\/episode\/spongebob-squarepants-2x2\/$/, tsPlayerPage(['https://filesforever.link/embed/r3gdmwn', ABYSS])]
  ];
  await check('ToonStream: found by poster past its featured cards, season fragment, abyss player accepted', async () => {
    const site = fakeSite(tsSpongeRoutes());
    const r = toon.createToonResolver({ fetch: site.fetchFn, log: () => {}, tmdbDetails: async () => sponge });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '387', s: '2', e: '2' }));
    assert.strictEqual(out.available, true, JSON.stringify(out));
    assert.strictEqual(out.url, ABYSS);
    assert.deepStrictEqual(out.match, { library: 'toonstream', slug: 'spongebob-squarepants', by: 'poster', episode: '2x2' });
    assert.ok(site.calls.some((c) => /animesalt|^GET \/\?s=/.test(c)), 'AnimeSalt was not asked too');
  });
  await check('ToonStream answers a missing page with a 500 "404 Not Found" page: a miss, not an outage', async () => {
    const notFound = { status: 500, body: '<html><head><title>404 Not Found - ToonStream</title></head></html>' };
    const site = fakeSite([[/toonstream\.us\/s\?q=/, '<ul></ul>'], [/toonstream\.us\/series\//, notFound]]);
    const r = toon.createToonResolver({ libraries: ['toonstream'], fetch: site.fetchFn, log: () => {}, tmdbDetails: async () => sponge });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '387', s: '1', e: '1' }));
    assert.strictEqual(out.reason, 'not-in-library', JSON.stringify(out));
    const down = fakeSite([[/toonstream\.us\/s\?q=/, { status: 503, body: 'down' }]]);
    const r2 = toon.createToonResolver({ libraries: ['toonstream'], fetch: down.fetchFn, log: () => {}, tmdbDetails: async () => sponge });
    assert.strictEqual((await r2.resolve(toon.parseToonRequest({ type: 'tv', id: '387', s: '1', e: '1' }))).reason, 'upstream-error');
  });
  await check('both libraries: multi-audio first, AnimeSalt before ToonStream, one file listed once', async () => {
    const site = fakeSite([
      [/animesalt\.cx\/\?s=Your%20Name$/, searchPage([card('movies', 'your-name', 'Your Name', '/q.jpg')])],
      [/animesalt\.cx\/movies\/your-name\/$/, playerPage(['src="' + RAVOK + '"', 'data-src="' + torofilm([{ language: 'Hindi', link: 'https://player.abyssplayer.com/Pi1IUyAiT' }]) + '"'])],
      [/toonstream\.us\/s\?q=Your%20Name&type=movies$/, '<ul>' + tsCard('movies', 'your-name', 'Your Name.', '/q.jpg') + '</ul>'],
      [/toonstream\.us\/movies\/your-name\/$/, tsPlayerPage([RAVOK, ABYSS])]
    ]);
    const r = toon.createToonResolver({ fetch: site.fetchFn, log: () => {}, tmdbDetails: async () => ({ id: 372058, title: 'Your Name', genres: [{ id: 16 }], poster_path: '/q.jpg' }) });
    const out = await r.resolve(toon.parseToonRequest({ type: 'movie', id: '372058' }));
    assert.deepStrictEqual(out.sources.map((x) => x.library + ' ' + x.audio + ' ' + x.url), [
      'animesalt multi ' + RAVOK,
      'toonstream multi ' + ABYSS,
      'animesalt hindi https://player.abyssplayer.com/Pi1IUyAiT'
    ]);
    assert.strictEqual(out.url, RAVOK);
    assert.strictEqual(out.match.library, 'animesalt');
  });
  await check('one library failing never hides the other\'s answer', async () => {
    const site = fakeSite([[/animesalt\.cx/, new Error('ECONNRESET')]].concat(tsSpongeRoutes()));
    const r = toon.createToonResolver({ fetch: site.fetchFn, log: () => {}, tmdbDetails: async () => sponge });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '387', s: '2', e: '2' }));
    assert.strictEqual(out.available, true, JSON.stringify(out));
    assert.strictEqual(out.sources[0].library, 'toonstream');
  });
  await check('the most specific miss wins: "this episode is not there yet" over "no such title"', async () => {
    const routes = tsSpongeRoutes().slice(0, 3);
    const site = fakeSite(routes);
    const r = toon.createToonResolver({ fetch: site.fetchFn, log: () => {}, tmdbDetails: async () => sponge });
    const out = await r.resolve(toon.parseToonRequest({ type: 'tv', id: '387', s: '2', e: '9' }));
    assert.strictEqual(out.available, false);
    assert.strictEqual(out.reason, 'episode-not-in-library', JSON.stringify(out));
    assert.ok(out.backups.length >= 3);
  });
  await check('TMDB itself is asked once per title, however many libraries look it up', async () => {
    let tmdbCalls = 0;
    const site = fakeSite(tsSpongeRoutes());
    const r = toon.createToonResolver({ fetch: site.fetchFn, log: () => {}, tmdbDetails: async () => { tmdbCalls++; return sponge; } });
    await r.resolve(toon.parseToonRequest({ type: 'tv', id: '387', s: '2', e: '2' }));
    await r.resolve(toon.parseToonRequest({ type: 'tv', id: '387', s: '2', e: '1' }));
    assert.strictEqual(tmdbCalls, 1);
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
  await check('both serve the player page under its own nonce CSP, and hand out sources + backups', () => {
    [['server.js', server], ['worker.js', worker]].forEach(([name, src]) => {
      assert.ok(/toonResolver\.playerPageHtml\(nonce, toonResolver\.backupSources\((q|req)\)\)/.test(src), name + ': player page');
      assert.ok(/toonResolver\.playerPageCsp\(nonce\)/.test(src), name + ': nonce CSP');
      assert.ok(/sources: Array\.isArray\(result\.sources\)/.test(src) && /backups: Array\.isArray\(result\.backups\)/.test(src), name + ': resolve JSON');
      assert.ok(!/redirect\(302, result\.url\)|status: 302/.test(src.slice(src.indexOf('TOON HINDI'), src.indexOf('TOON HINDI') + 6000)), name + ': still redirects');
    });
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
    assert.strictEqual(srcs[srcs.length - 1].name, 'Anime/Toon Hindi');
    assert.strictEqual(srcs.filter((s) => s.toon).length, 1, 'exactly one toon server');
  });
  await check('it plays through the same-origin embed route, for films and episodes; the warm-up copy cannot play', () => {
    const s = evalSources(null).find((x) => x.toon);
    assert.strictEqual(s.url(31910, 'hi', 'tv', '16', '2'), 'https://moviezone.dev/api/toon/embed?type=tv&id=31910&s=16&e=2&autoplay=1');
    assert.strictEqual(s.url(372058, 'hi', 'movie', '1', '1'), 'https://moviezone.dev/api/toon/embed?type=movie&id=372058&autoplay=1');
    const w = client.indexOf('function warmUrlVariant(url) {');
    const tail = /\r?\n\}\r?\n/.exec(client.slice(w));
    const warmFn = client.slice(w, w + tail.index + tail[0].length);
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(warmFn + '\nthis.__w = warmUrlVariant;', sb);
    assert.strictEqual(sb.__w(s.url(372058, 'hi', 'movie', '1', '1')), 'https://moviezone.dev/api/toon/embed?type=movie&id=372058&autoplay=0');
    assert.deepStrictEqual(Array.from(s.hosts).sort(), ['https://abyssplayer.com', 'https://embed.vidrift.net',
      'https://player.abyssplayer.com', 'https://ravok.buzz', 'https://vidnest.fun']);
  });
  await check('it rules itself out for live action and for a title it already said it lacks', () => {
    assert.strictEqual(evalSources({ id: 1, genre_ids: [18] }).find((x) => x.toon).skip(), true);
    assert.strictEqual(evalSources({ id: 2, genre_ids: [16] }).find((x) => x.toon).skip(), false);
    assert.strictEqual(evalSources({ id: 2, genre_ids: [16] }, true).find((x) => x.toon).skip(), true);
  });
  await check('the picker offers it on every title, like the other servers; Try All honours skip()', () => {
    assert.ok(/const allServers = playerSources\.map\(\(s, i\) => \(\{ \.\.\.s, _idx: i \}\)\);/.test(client),
      'renderExternalSources must not filter Toon Hindi out');
    assert.ok(!/!s\.toon \|\| isCartoonContent/.test(client), 'the old animation-only filter is back');
    assert.ok(/if \(!s\.dubbed\) return;\s*if \(typeof s\.skip === 'function'\)/.test(client));
  });
  await check('picked by hand, Toon Hindi is never switched away from', () => {
    assert.ok(/loadPlayer\(id, idx, getSelectedLang\(\), quality, type, \{ userPick: true \}\)/.test(client), 'card click does not mark the pick');
    assert.ok(/if \(_mzToonUserPick\) \{\s*showToast\([^;]*\);\s*return;\s*\}\s*autoRetryNextServer/.test(client), 'a refused request moves a hand pick');
    assert.ok(/if \(!hasLoaded && _mzStayPut\) \{[\s\S]{0,400}return;/.test(client), 'load timeout still switches a hand pick');
    assert.ok(!/_mzBeforeToon|prefer: back/.test(client), 'the "go back to the previous server" switch is back');
  });
  await check('the app\'s own picks still fail over, and clear the hand pick first', () => {
    const clears = (client.match(/_mzToonUserPick = false;\s*\/\/ the app is/g) || []).length;
    assert.strictEqual(clears, 3, 'playMovie, the retry chain and Try All must each clear it (found ' + clears + ')');
  });
  await check('it gets its own load patience, longer than the default timeout', () => {
    const s = evalSources(null).find((x) => x.toon);
    const def = Number((/const MZ_PH_MAX_TIMEOUT = (\d+);/.exec(client) || [])[1]);
    assert.ok(s.patience > def, 'patience ' + s.patience + ' vs max timeout ' + def);
    assert.ok(/Math\.max\(adaptivePlayerTimeout\(_mzSrcName\), _mzSource\.patience \|\| 0\)/.test(client));
  });
  await check('a backup playing inside Toon Hindi is announced with a toast — never a server switch', () => {
    const at = client.indexOf("if (d.type === 'mz-toon:playing') {");
    assert.ok(at !== -1, 'no mz-toon:playing handler');
    const rest = client.slice(at);
    const branch = rest.slice(0, /\r?\n  \}\r?\n/.exec(rest).index);
    assert.ok(/showToast\(/.test(branch) && !/autoRetryNextServer|loadPlayer/.test(branch), branch);
    assert.ok(/d\.library \|\| d\.byHand/.test(branch), 'announces library plays or in-player hand picks');
    assert.ok(/autoRetryNextServer\(m\.id, idx, getSelectedLang\(\), getSelectedQuality\(\), m\.media_type, \{ keepPick: true, reason: 'unavailable' \}\)/.test(client),
      'an app pick the server refused must still fail over without overwriting the saved pick');
  });

  console.log('-'.repeat(72));
  console.log('  toon-resolver-check: ' + passed + ' passed, ' + failures.length + ' failed\n');
  process.exit(failures.length ? 1 : 0);
})();
