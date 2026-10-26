'use strict';
/*  ══════════════════════════════════════════════════════════════════════════
 *  TOON HINDI  —  the anime + cartoon server, resolved on our side
 *  ══════════════════════════════════════════════════════════════════════════
 *
 *  ── where this player comes from ──
 *
 *  ToonPlay's "Server 1" (the JW Player with Japanese / English / Telugu /
 *  Tamil / Hindi audio, Hindi selected) is not ToonPlay's own player and has no
 *  public embed API. Read from its public bundle (Oct 2026): ToonPlay calls its
 *  own backend, animesalt.streamindia.co.in, which scrapes AnimeSalt
 *  (animesalt.link -> animesalt.cx, a WordPress "torofilm" catalogue of Hindi
 *  dubbed anime and cartoons), and the iframe it shows is the player AnimeSalt
 *  itself embeds:
 *
 *      https://ravok.buzz/video/<hash>    JW Player 8, HLS, multi-audio
 *      var defaultAudio = ["hin","tam","tel","ben","mal","mar","kan","eng",...]
 *
 *  Measured in real Chrome inside an iframe on a foreign origin: Naruto
 *  Shippuden 1x1 played at 1280x720 with audio tracks Japanese, English,
 *  Malayalam, Tamil, Hindi and Hindi selected by default; no X-Frame-Options
 *  and no CSP, so it frames anywhere. ToonPlay's "Server 2" is the same stream
 *  pulled into its own player, and its fallback is a pair of Google sample
 *  videos (Big Buck Bunny) — not something worth copying.
 *
 *  So this does what ToonPlay's backend does, without depending on that
 *  backend: map the TMDB title the app already has onto AnimeSalt's page for
 *  it, and read the player iframe off that page.
 *
 *  ── mapping a TMDB title onto AnimeSalt ──
 *
 *  AnimeSalt pages carry no TMDB id, but the catalogue was imported FROM TMDB:
 *  every search card's poster is a TMDB image path. So a search card whose
 *  poster is one of the title's own TMDB posters is the same title — an exact
 *  match that survives AnimeSalt renaming things ("Shinchan" for "Crayon
 *  Shin-chan"). A normalised-title match is accepted only when it is the one
 *  candidate of the right kind, so two different "Pokémon" entries can never be
 *  confused by name alone.
 *
 *  Episodes: /episode/<slug>-<S>x<E>/. Long anime number episodes absolutely
 *  inside a season (Naruto Shippuden season 16 is 16x349..16x361), so the
 *  season's own list is read (admin-ajax action_select_season, no nonce) and
 *  TMDB episode N is the Nth entry when the season does not start at 1.
 *
 *  ── what this is NOT ──
 *
 *  Not a proxy. Upstream host is fixed; slugs and post ids are only ever taken
 *  from AnimeSalt's own markup and validated; the URL handed to the browser must
 *  look like a player (a /video/<hex> page, or one of the per-language hosts the
 *  torofilm player lists) or nothing is returned. No media passes through us:
 *  the browser's iframe talks to the player directly.
 *
 *  Offered on every title (the viewer asked for it to sit with the other
 *  servers), and every title is looked up: AnimeSalt is anime and cartoons with
 *  a little live action, so it decides. The app only PICKS it by itself for
 *  animated titles (isCartoonContent); on anything else it is there to click.
 *  Upstream steps are bounded one by one (UPSTREAM_TIMEOUT_MS) and as a whole
 *  (RESOLVE_DEADLINE_MS).
 *
 *  Used by server.js and worker.js (bundled by wrangler from "main"), like
 *  ott-charts.js. Needs only a global fetch.
 */

const ORIGIN = 'https://animesalt.cx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UPSTREAM_TIMEOUT_MS = 8000;
/*  The whole answer, however many upstream steps it takes. The embed route is
 *  what the player iframe is loading, so a hang here is a frame stuck on a
 *  spinner: measured once at 105s for a title that normally answers in 1s
 *  (an upstream stall). Past this the frame gets the "busy" page at once; the
 *  lookup keeps running and fills the memo, so the next try is instant. */
const RESOLVE_DEADLINE_MS = 12000;

/*  How long answers are kept in this process / isolate. A player hash on a page
 *  does not change between visits, so hits live for hours; a miss is kept short
 *  so a title AnimeSalt adds today shows up the same evening. */
const TTL_MS = {
  hit: 6 * 60 * 60 * 1000,
  miss: 30 * 60 * 1000,
  title: 24 * 60 * 60 * 1000,
  titleMiss: 60 * 60 * 1000,
  season: 6 * 60 * 60 * 1000
};
const MEMO_MAX = 3000;

const ANIMATED_GENRES = [16, 10762];
const MAX_SEARCH_NAMES = 3;
const MAX_SEASON = 200;
const MAX_EPISODE = 5000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,180}$/;
/*  The multi-audio JW player AnimeSalt embeds first. Matched by shape, not host,
 *  because these hosts rotate (the bundle ToonPlay ships already names an older
 *  one); the shape is what keeps this from redirecting anywhere at all. */
const MULTI_PLAYER_PATH = /^\/video\/[a-f0-9]{24,64}$/;
/*  Per-language players listed by torofilm's player.php — the fallback when a
 *  page has no multi-audio player. Host-allowlisted. */
const LANGUAGE_PLAYER_HOSTS = ['player.abyssplayer.com'];
const LANGUAGE_PLAYER_PATH = /^\/[A-Za-z0-9_-]{5,32}$/;

class ToonRequestError extends Error {}

/** Query -> { type, id, season, episode } or throws ToonRequestError. */
function parseToonRequest(query) {
  const q = query || {};
  const read = (k) => {
    const v = typeof q.get === 'function' ? q.get(k) : q[k];
    return v === undefined || v === null ? '' : String(Array.isArray(v) ? v[0] : v).trim();
  };
  const type = read('type');
  if (type !== 'movie' && type !== 'tv') throw new ToonRequestError('type must be movie or tv');
  const id = read('id');
  if (!/^[1-9][0-9]{0,8}$/.test(id)) throw new ToonRequestError('id must be a TMDB id');
  let season = 0;
  let episode = 0;
  if (type === 'tv') {
    season = Number(read('s') || '1');
    episode = Number(read('e') || '1');
    if (!Number.isInteger(season) || season < 1 || season > MAX_SEASON) throw new ToonRequestError('bad season');
    if (!Number.isInteger(episode) || episode < 1 || episode > MAX_EPISODE) throw new ToonRequestError('bad episode');
  }
  return { type, id: Number(id), season, episode };
}

function normaliseTitle(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Search-result cards: { kind: 'series'|'movies', slug, title, poster }. */
function parseSearchCards(html) {
  const out = [];
  const seen = new Set();
  const re = /<article class="post dfx fcl[^"]*">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const body = m[1];
    const link = /href="https:\/\/animesalt\.[a-z]+\/(series|movies)\/([^/"]+)\/"/.exec(body);
    if (!link || !SLUG_RE.test(link[2])) continue;
    const key = link[1] + '/' + link[2];
    if (seen.has(key)) continue;
    seen.add(key);
    const title = /<h2 class="entry-title"[^>]*>([^<]*)<\/h2>/.exec(body);
    const poster = /data-src="[^"]*?image\.tmdb\.org\/t\/p\/[a-z0-9]+(\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))"/.exec(body);
    out.push({
      kind: link[1],
      slug: link[2],
      title: decodeEntities(title ? title[1] : '').trim(),
      poster: poster ? poster[1] : null
    });
  }
  return out;
}

/** True when the search page links to a further page of results. */
function hasNextSearchPage(html, page) {
  return new RegExp('/page/' + (page + 1) + '/\\?s=').test(String(html || ''));
}

function absolute(src) {
  const s = decodeEntities(String(src || '').trim());
  if (s.startsWith('//')) return 'https:' + s;
  return s;
}

function acceptMultiPlayer(src) {
  try {
    const u = new URL(absolute(src));
    if (u.protocol !== 'https:' || u.search || u.hash) return null;
    if (/animesalt\./.test(u.hostname)) return null;
    return MULTI_PLAYER_PATH.test(u.pathname) ? u.href : null;
  } catch (e) { return null; }
}

function acceptLanguagePlayer(link) {
  try {
    const u = new URL(absolute(link));
    if (u.protocol !== 'https:' || LANGUAGE_PLAYER_HOSTS.indexOf(u.hostname) === -1) return null;
    return LANGUAGE_PLAYER_PATH.test(u.pathname) ? u.origin + u.pathname : null;
  } catch (e) { return null; }
}

/*  torofilm's player.php?data=<base64 of [{"language","link"}]>. Decoded with
 *  atob/Buffer, whichever the runtime has. */
function decodeTorofilmData(src) {
  try {
    const u = new URL(absolute(src));
    if (!/animesalt\./.test(u.hostname) || !/\/player\.php$/.test(u.pathname)) return [];
    const data = u.searchParams.get('data');
    if (!data || data.length > 8000) return [];
    const text = typeof atob === 'function'
      ? decodeURIComponent(escape(atob(data)))
      : Buffer.from(data, 'base64').toString('utf8');
    const list = JSON.parse(text);
    return Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : [];
  } catch (e) { return []; }
}

/*  The player a page offers, best first: the multi-audio player (all languages
 *  in one, Hindi default), else the page's Hindi per-language player, else its
 *  first per-language player. null when the page has none we accept. */
function pickPlayer(html) {
  const srcs = [];
  const re = /<iframe\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const tag = m[0];
    const a = /\bsrc="([^"]+)"/i.exec(tag);
    const b = /\bdata-src="([^"]+)"/i.exec(tag);
    if (a) srcs.push(a[1]);
    if (b && (!a || b[1] !== a[1])) srcs.push(b[1]);
  }
  for (const s of srcs) {
    const multi = acceptMultiPlayer(s);
    if (multi) return { url: multi, audio: 'multi' };
  }
  const languages = [];
  srcs.forEach((s) => decodeTorofilmData(s).forEach((entry) => {
    const url = acceptLanguagePlayer(entry.link);
    if (url) languages.push({ url, language: String(entry.language || '').trim() });
  }));
  const hindi = languages.find((x) => /^hindi$/i.test(x.language));
  if (hindi) return { url: hindi.url, audio: 'hindi' };
  if (languages.length) return { url: languages[0].url, audio: languages[0].language.toLowerCase() || 'single' };
  return null;
}

/** Season list: [{ season, number, slug }] sorted by episode number. */
function parseSeasonEpisodes(html, slug) {
  const out = [];
  const seen = new Set();
  const re = /href="https:\/\/animesalt\.[a-z]+\/episode\/([a-z0-9-]+?)-(\d{1,3})x(\d{1,5})\/"/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (slug && m[1] !== slug) continue;
    const key = m[2] + 'x' + m[3];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ season: Number(m[2]), number: Number(m[3]), slug: m[1] });
  }
  return out.sort((x, y) => x.number - y.number);
}

/*  Which entry of a season's list is TMDB's episode N. Per-season numbering
 *  (list starts at 1) is matched by number; absolute numbering (a later season
 *  of a long anime) by position. */
function pickEpisode(list, episode) {
  if (!list.length) return null;
  if (list[0].number === 1) return list.find((x) => x.number === episode) || null;
  return list[episode - 1] || null;
}

function isAnimated(details) {
  const ids = (details && Array.isArray(details.genres) ? details.genres.map((g) => g && g.id)
    : (details && details.genre_ids) || []);
  return ids.some((g) => ANIMATED_GENRES.indexOf(g) !== -1);
}

/** The names worth searching, most specific first, deduplicated. */
function searchNames(details) {
  const names = [];
  const seen = new Set();
  const add = (s) => {
    const n = normaliseTitle(s);
    if (!n || seen.has(n)) return;
    seen.add(n);
    names.push(String(s).trim());
  };
  add(details.name || details.title);
  add(details.original_name || details.original_title);
  const alt = details.alternative_titles || {};
  (alt.results || alt.titles || [])
    .filter((t) => t && ['US', 'GB', 'IN'].indexOf(t.iso_3166_1) !== -1)
    .forEach((t) => add(t.title));
  // Drop non-Latin originals (Japanese, Korean, Hindi script): AnimeSalt titles
  // its entries in English, so those searches can only come back empty.
  return names.filter((n) => /[a-z0-9]/i.test(n)).slice(0, MAX_SEARCH_NAMES);
}

function posterSet(details) {
  const set = new Set();
  if (details.poster_path) set.add(details.poster_path);
  const posters = details.images && details.images.posters;
  if (Array.isArray(posters)) posters.forEach((p) => { if (p && p.file_path) set.add(p.file_path); });
  return set;
}

/**
 * createToonResolver({ tmdbDetails, fetch, now, log })
 *
 *   tmdbDetails(type, id, context) -> Promise<TMDB details with `images` (posters) and
 *     `alternative_titles` appended, or null when TMDB has no such title>
 *
 * Returns { resolve(request, context) } where request is parseToonRequest's
 * output, `context` is handed untouched to tmdbDetails (the Worker passes its
 * env/ctx there), and the answer is { available: true, url, audio, match } or
 * { available: false, reason }.
 */
function createToonResolver(opts) {
  const options = opts || {};
  const tmdbDetails = options.tmdbDetails;
  if (typeof tmdbDetails !== 'function') throw new Error('createToonResolver needs tmdbDetails(type, id)');
  const doFetch = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error('no fetch implementation available');
  const now = options.now || (() => Date.now());
  const log = options.log || (() => {});
  const deadlineMs = options.deadlineMs > 0 ? options.deadlineMs : RESOLVE_DEADLINE_MS;

  const memo = new Map();
  const inFlight = new Map();

  function memoGet(key) {
    const hit = memo.get(key);
    if (!hit) return undefined;
    if (hit.until <= now()) { memo.delete(key); return undefined; }
    // Re-insert so iteration order stays least-recently-used first.
    memo.delete(key);
    memo.set(key, hit);
    return hit.value;
  }
  function memoPut(key, value, ttl) {
    memo.delete(key);
    memo.set(key, { value, until: now() + ttl });
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  }
  function once(key, task) {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const p = task().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  async function getText(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await doFetch(url, Object.assign({
        headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8' },
        redirect: 'follow',
        signal: controller.signal
      }, init || {}));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('AnimeSalt responded ' + res.status + ' for ' + url.replace(ORIGIN, ''));
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /*  TMDB title -> { kind, slug, by } or null. Cached per title: the mapping
   *  does not depend on the episode. */
  function findTitle(type, id, context) {
    const key = 'title:' + type + ':' + id;
    const cached = memoGet(key);
    if (cached !== undefined) return Promise.resolve(cached);
    return once(key, async () => {
      const details = await tmdbDetails(type, id, context);
      if (!details) { memoPut(key, { miss: 'tmdb' }, TTL_MS.titleMiss); return { miss: 'tmdb' }; }
      /*  No genre gate. The server is offered on every title now, and AnimeSalt
       *  does carry some live action (ONE PIECE Live Action) — so AnimeSalt
       *  decides, by poster identity like everything else. A live-action title
       *  it does not have costs one or two searches and is memoised as a miss. */

      const want = type === 'tv' ? 'series' : 'movies';
      const posters = posterSet(details);
      const names = searchNames(details);
      const wantedTitles = new Set(names.map(normaliseTitle));
      const byTitle = new Map();
      let found = null;

      for (let n = 0; n < names.length && !found; n++) {
        // The primary name may read a second page (Doraemon's series sits behind
        // a page of Doraemon films); the alternates read one.
        const pages = n === 0 ? 2 : 1;
        for (let page = 1; page <= pages && !found; page++) {
          const url = ORIGIN + (page > 1 ? '/page/' + page + '/' : '/') + '?s=' + encodeURIComponent(names[n]);
          const html = await getText(url);
          if (!html) break;
          const cards = parseSearchCards(html).filter((c) => c.kind === want);
          const poster = cards.find((c) => c.poster && posters.has(c.poster));
          if (poster) { found = { kind: want, slug: poster.slug, by: 'poster' }; break; }
          cards.forEach((c) => { if (wantedTitles.has(normaliseTitle(c.title))) byTitle.set(c.slug, c); });
          if (!hasNextSearchPage(html, page)) break;
        }
      }
      if (!found && byTitle.size === 1) {
        found = { kind: want, slug: byTitle.keys().next().value, by: 'title' };
      }
      const value = found || { miss: 'not-on-animesalt' };
      memoPut(key, value, found ? TTL_MS.title : TTL_MS.titleMiss);
      return value;
    });
  }

  async function seasonList(slug, season) {
    const key = 'season:' + slug + ':' + season;
    const cached = memoGet(key);
    if (cached !== undefined) return cached;
    return once(key, async () => {
      const page = await getText(ORIGIN + '/series/' + slug + '/');
      if (!page) { memoPut(key, [], TTL_MS.miss); return []; }
      const post = /data-post="(\d{1,10})"/.exec(page);
      const seasons = new Set();
      page.replace(/data-season="(\d{1,3})"/g, (m, s) => { seasons.add(Number(s)); return m; });
      let list = [];
      if (post && seasons.has(season)) {
        const body = new URLSearchParams({ action: 'action_select_season', season: String(season), post: post[1] });
        const html = await getText(ORIGIN + '/wp-admin/admin-ajax.php', {
          method: 'POST',
          body: body.toString(),
          headers: {
            'user-agent': UA,
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest',
            referer: ORIGIN + '/series/' + slug + '/'
          }
        });
        list = parseSeasonEpisodes(html, slug).filter((x) => x.season === season);
      } else if (!seasons.size && season === 1) {
        // A one-season show may render its list inline with no season picker.
        list = parseSeasonEpisodes(page, slug).filter((x) => x.season === 1);
      }
      memoPut(key, list, list.length ? TTL_MS.season : TTL_MS.miss);
      return list;
    });
  }

  async function resolveUncached(req, context) {
    const title = await findTitle(req.type, req.id, context);
    if (!title || title.miss) return { available: false, reason: (title && title.miss) || 'not-found', scope: 'title' };

    let pageUrl;
    let episodeLabel = null;
    if (req.type === 'movie') {
      pageUrl = ORIGIN + '/movies/' + title.slug + '/';
    } else {
      const list = await seasonList(title.slug, req.season);
      if (!list.length) return { available: false, reason: 'season-not-on-animesalt', scope: 'season' };
      const ep = pickEpisode(list, req.episode);
      if (!ep) return { available: false, reason: 'episode-not-on-animesalt', scope: 'episode' };
      episodeLabel = ep.season + 'x' + ep.number;
      pageUrl = ORIGIN + '/episode/' + ep.slug + '-' + episodeLabel + '/';
    }

    const html = await getText(pageUrl);
    const player = html ? pickPlayer(html) : null;
    if (!player) return { available: false, reason: 'no-player-on-page', scope: req.type === 'tv' ? 'episode' : 'title' };
    return {
      available: true,
      url: player.url,
      audio: player.audio,
      match: { slug: title.slug, by: title.by, episode: episodeLabel }
    };
  }

  function resultKey(req) {
    return 'result:' + req.type + ':' + req.id + (req.type === 'tv' ? ':' + req.season + ':' + req.episode : '');
  }

  async function resolve(req, context) {
    const key = resultKey(req);
    const cached = memoGet(key);
    if (cached !== undefined) return Object.assign({ cache: 'HIT' }, cached);
    const work = once(key, async () => {
      let value;
      try {
        value = await resolveUncached(req, context);
      } catch (err) {
        /*  An upstream failure is not "AnimeSalt does not have it": nothing is
         *  memoised, so the next request asks again. */
        log('[toon] ' + key + ' upstream failure: ' + (err && err.message));
        return { available: false, reason: 'upstream-error', scope: 'request', cache: 'MISS' };
      }
      memoPut(key, value, value.available ? TTL_MS.hit : TTL_MS.miss);
      return Object.assign({ cache: 'MISS' }, value);
    });
    // A Worker would cancel the late lookup with the response; keep it alive.
    const ctx = context && context.ctx;
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work.catch(() => {}));
    let timer = null;
    const late = new Promise((done) => {
      timer = setTimeout(() => {
        log('[toon] ' + key + ' over the ' + deadlineMs + 'ms deadline, answering busy');
        done({ available: false, reason: 'upstream-error', scope: 'request', cache: 'MISS', late: true });
      }, deadlineMs);
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { resolve, _memo: memo };
}

/*  The page the player frame shows when there is nothing to play. It tells the
 *  app (its parent, which created the frame) straight away. Whether the app then
 *  moves on is the app's call — it does for a server it picked by itself, and
 *  does NOT when the viewer picked Toon Hindi by hand — so the copy promises no
 *  switch. No user input is echoed: `reason` is one of this module's own
 *  constants, and only lowercase letters and dashes survive. */
const UNAVAILABLE_COPY = {
  busy: ['Toon Hindi is busy', 'It is not responding right now. Try again in a moment, or pick another server below.'],
  episode: ['This episode is not on Toon Hindi yet', 'The show is here, this episode is not. Pick another episode, or another server below.'],
  title: ['Not on Toon Hindi', 'Toon Hindi carries anime and cartoons with Hindi audio, and this title is not one of them yet. Pick another server below.']
};
function unavailablePageHtml(reason) {
  const safe = String(reason || 'not-found').replace(/[^a-z-]/g, '');
  const copy = safe === 'upstream-error' ? UNAVAILABLE_COPY.busy
    : /^(season|episode)-|^no-player/.test(safe) ? UNAVAILABLE_COPY.episode
      : UNAVAILABLE_COPY.title;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + '<title>' + copy[0] + '</title>'
    + '<style>html,body{margin:0;height:100%;background:#05050c;color:#e8e8f4;font:500 15px/1.5 system-ui,sans-serif}'
    + 'main{height:100%;display:grid;place-items:center;text-align:center;padding:20px;box-sizing:border-box}'
    + 'h1{margin:0 0 6px;font-size:17px;color:#f5c518}p{margin:0 auto;max-width:440px;color:rgba(232,232,244,.72)}</style></head>'
    + '<body><main><div><h1>' + copy[0] + '</h1><p>' + copy[1] + '</p></div></main>'
    + '<script>try{parent.postMessage({type:"mz-toon:unavailable",reason:"' + safe + '"},"*")}catch(e){}</script>'
    + '</body></html>';
}

/*  The unavailable page may be framed by the app's own pages only. 'self' is the
 *  production case; the localhost entries cover the dev server, where the page
 *  and the API can sit on different ports. */
const UNAVAILABLE_FRAME_ANCESTORS = "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*";

module.exports = {
  ORIGIN,
  ANIMATED_GENRES,
  TTL_MS,
  ToonRequestError,
  parseToonRequest,
  normaliseTitle,
  parseSearchCards,
  pickPlayer,
  parseSeasonEpisodes,
  pickEpisode,
  isAnimated,
  searchNames,
  acceptMultiPlayer,
  acceptLanguagePlayer,
  createToonResolver,
  unavailablePageHtml,
  UNAVAILABLE_FRAME_ANCESTORS
};
