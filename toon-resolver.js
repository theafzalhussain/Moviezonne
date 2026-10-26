'use strict';
/*  ══════════════════════════════════════════════════════════════════════════
 *  TOON HINDI  —  the anime + cartoon server, resolved on our side
 *  ══════════════════════════════════════════════════════════════════════════
 *
 *  ── what the server is ──
 *
 *  One server chip in the app, and behind it a small player of our own
 *  (/api/toon/embed, playerPageHtml below) with its own source bar:
 *
 *    1. Hindi libraries — anime and cartoon catalogues that carry Hindi audio,
 *       looked up in parallel, best player first:
 *         AnimeSalt  (animesalt.cx)   multi-audio JW player, Hindi default
 *         ToonStream (toonstream.us)  Disney / Pixar / DreamWorks / Nick / CN /
 *                                     Sony Yay / Hungama films and series
 *    2. Backups — general TMDB-keyed players, so a title neither library
 *       carries (or an episode they have not added yet) still plays on this
 *       server instead of the viewer being moved to another one.
 *
 *  Measured Oct 2026 in real Chrome, in an unsandboxed iframe on a foreign
 *  origin, with "playing" meaning a <video> decoding with currentTime moving:
 *
 *    ravok.buzz/video/<hex>          Naruto Shippuden 1x1 1280x720, audio tracks
 *                                    Japanese/English/Malayalam/Tamil/Hindi (Hindi
 *                                    default). AnimeSalt and ToonStream both embed it.
 *    (player.)abyssplayer.com/<id>   Pokémon 1x1 (AnimeSalt, Hindi file),
 *                                    SpongeBob 1x1, Inside Out 2, Naruto (ToonStream)
 *    NOT accepted: filesforever.link (-> pro.iqsmartgames.com), rubystm.com,
 *    vidmoly, upns, turbonewvid, strmup, animedekho — none produced video;
 *    vidstreaming.xyz and strmup redirect to ad click trackers.
 *
 *  Library coverage of 70 popular titles went from 25 (AnimeSalt alone) to
 *  roughly double with ToonStream: Hollywood animation (Kung Fu Panda 4, Inside
 *  Out 2, Moana 2, Frozen, Minions, Spider-Verse, Toy Story, Despicable Me, The
 *  Wild Robot, Elemental, Ne Zha 2), SpongeBob, Perman, Kiteretsu, Beyblade,
 *  Dragon Ball Super, Ninja Hattori Returns, The Tom and Jerry Show.
 *
 *  Backups, same measurement, on titles neither library has:
 *    films   vidnest.fun          Coco, Sponge on the Run, Encanto, Lion King: 4/4
 *            embed.vidrift.net    Coco, Sponge on the Run, Lion King (Referer: origin)
 *            player.vidzee.wtf    Coco, Sponge on the Run, Encanto, Lion King
 *    series  embed.vidrift.net    Peppa Pig, Powerpuff Girls, SpongeBob, Mr. Bean,
 *                                 Dragon Ball Super, Jungle Book, Ninja Hattori —
 *                                 ONLY with Referer: origin (with no-referrer it
 *                                 played none of them)
 *            moviesapi.vip        Powerpuff Girls, Mr. Bean
 *  Indian originals (Motu Patlu, Little Singham, Chhota Bheem) were on none of
 *  them; that is a catalogue gap, not something a parameter fixes.
 *
 *  ── mapping a TMDB title onto a library ──
 *
 *  Neither library carries TMDB ids, but both catalogues were imported FROM
 *  TMDB: every card's poster is a TMDB image path. So a card whose poster is one
 *  of the title's own TMDB posters is the same title — an exact match that
 *  survives renames ("Shinchan" for "Crayon Shin-chan"). A normalised-title
 *  match is accepted only when it is the one candidate of the right kind, so two
 *  different "Pokémon" entries can never be confused by name alone. When a
 *  library's search misses, the title's likely addresses (/series/<slug>/) are
 *  asked for directly and the page's OWN header poster must match.
 *
 *  Episodes: /episode/<slug>-<S>x<E>/ on both. Long anime number episodes
 *  absolutely inside a season (Naruto Shippuden season 16 is 16x349..16x361), so
 *  the season's own list is read and TMDB episode N is the Nth entry when the
 *  season does not start at 1. A season's episodes may carry a slug of their own
 *  (Ben 10 -> ben-10-classic-1x1, naruto-shippuden-hindi-dub -> naruto-shippuden-1x1).
 *
 *  ── what this is NOT ──
 *
 *  Not a proxy. Upstream hosts are fixed; slugs and post ids are only ever taken
 *  from the libraries' own markup and validated; a player URL handed to the
 *  browser must look like a player (a /video/<hex> page, or an allowlisted host
 *  with an id-shaped path), and backups are fixed templates fed numeric ids. No
 *  media passes through us: the browser's iframe talks to the player directly.
 *
 *  Upstream steps are bounded one by one (UPSTREAM_TIMEOUT_MS) and as a whole
 *  (RESOLVE_DEADLINE_MS); at the deadline whatever the libraries have answered
 *  is used, and a library still running is never reported as "does not have it".
 *
 *  Used by server.js and worker.js (bundled by wrangler from "main"), like
 *  ott-charts.js. Needs only a global fetch.
 */

const ORIGIN = 'https://animesalt.cx';
const TOONSTREAM_ORIGIN = 'https://toonstream.us';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UPSTREAM_TIMEOUT_MS = 8000;
/*  The whole answer, however many upstream steps it takes. Measured once at
 *  105s for a title that normally answers in 1s (an upstream stall). Past this
 *  the player gets what has arrived (backups at worst) at once; the lookup keeps
 *  running and fills the memo, so the next try is instant. */
const RESOLVE_DEADLINE_MS = 12000;

/*  How long answers are kept in this process / isolate. A player hash on a page
 *  does not change between visits, so hits live for hours; a miss is kept short
 *  so a title a library adds today shows up the same evening. */
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
/*  Library players offered per title: enough for a second and third choice in
 *  the source bar, not so many that the bar becomes a list of the same file. */
const MAX_SOURCES = 5;
const MAX_PLAYERS_PER_LIBRARY = 3;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,180}$/;
/*  The multi-audio JW player both libraries embed first. Matched by shape, not
 *  host, because these hosts rotate; the shape is what keeps this from handing
 *  the browser anything at all. */
const MULTI_PLAYER_PATH = /^\/video\/[a-f0-9]{24,64}$/;
/*  Per-language / single-file players. Host-allowlisted: these are the only ones
 *  measured playing (see the header). */
const LANGUAGE_PLAYER_HOSTS = ['player.abyssplayer.com', 'abyssplayer.com'];
const LANGUAGE_PLAYER_PATH = /^\/[A-Za-z0-9_-]{5,32}$/;
const LIBRARY_HOST_RE = /(^|\.)(animesalt|toonstream)\.[a-z]+$/;

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

/** Search-result cards: { kind: 'series'|'movies', slug, title, poster }.
 *  Both libraries use torofilm's card markup; AnimeSalt links absolutely and
 *  lazy-loads the poster (data-src), ToonStream links relatively (src). */
function parseSearchCards(html) {
  const out = [];
  const seen = new Set();
  const re = /<article class="post dfx fcl[^"]*">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const body = m[1];
    const link = /href="(?:https:\/\/(?:www\.)?(?:animesalt|toonstream)\.[a-z]+)?\/(series|movies)\/([^/"?#]+)\/?"/.exec(body);
    if (!link || !SLUG_RE.test(link[2])) continue;
    const key = link[1] + '/' + link[2];
    if (seen.has(key)) continue;
    seen.add(key);
    const title = /<h2 class="entry-title"[^>]*>\s*([^<]*?)\s*<\/h2>/.exec(body);
    const poster = /\b(?:data-src|src)="[^"]*?image\.tmdb\.org\/t\/p\/[a-z0-9]+(\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))"/.exec(body);
    out.push({
      kind: link[1],
      slug: link[2],
      title: decodeEntities(title ? title[1] : '').trim(),
      poster: poster ? poster[1] : null
    });
  }
  return out;
}

/** True when an AnimeSalt search page links to a further page of results. */
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
    if (LIBRARY_HOST_RE.test(u.hostname)) return null;
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

/** The value of one attribute of a tag (`src` never matches `data-src`). */
function tagAttr(tag, name) {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]+)"', 'i').exec(String(tag || ''));
  return m ? m[1] : null;
}

/** Every iframe address on a page (src and lazy data-src), in page order. */
function iframeSources(html) {
  const srcs = [];
  const re = /<iframe\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const a = tagAttr(m[1], 'src');
    const b = tagAttr(m[1], 'data-src');
    if (a) srcs.push(a);
    if (b && b !== a) srcs.push(b);
  }
  return srcs;
}

function dedupePlayers(list) {
  const seen = new Set();
  return list.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
}

/*  AnimeSalt: the players a page offers, best first — the multi-audio player
 *  (all languages in one, Hindi default), then the page's Hindi per-language
 *  players, and only when it has neither, its first per-language player. */
function animesaltPlayers(html) {
  const srcs = iframeSources(html);
  const out = [];
  srcs.forEach((s) => {
    const multi = acceptMultiPlayer(s);
    if (multi) out.push({ url: multi, audio: 'multi' });
  });
  const languages = [];
  srcs.forEach((s) => decodeTorofilmData(s).forEach((entry) => {
    const url = acceptLanguagePlayer(entry.link);
    if (url) languages.push({ url, language: String(entry.language || '').trim() });
  }));
  languages.filter((x) => /^hindi$/i.test(x.language)).forEach((x) => out.push({ url: x.url, audio: 'hindi' }));
  if (!out.length && languages.length) {
    out.push({ url: languages[0].url, audio: languages[0].language.toLowerCase() || 'single' });
  }
  return dedupePlayers(out);
}

/** AnimeSalt's best player, or null when the page has none we accept. */
function pickPlayer(html) {
  const list = animesaltPlayers(html);
  return list.length ? list[0] : null;
}

function audioFromLabel(label) {
  const l = String(label || '').toLowerCase();
  if (/multi/.test(l)) return 'multi';
  if (/hindi/.test(l)) return 'hindi';
  const word = /^[a-z]{3,16}$/.exec(l.trim());
  return word ? word[0] : 'single';
}

/*  ToonStream: each server sits in <div id="options-N"><iframe …>, and the
 *  language tabs (<span tab="lnK">Multi Audio</span>) list which options-N
 *  belong to them. Only players we accept are kept, multi-audio first. */
function toonstreamPlayers(html) {
  const s = String(html || '');
  const tabs = new Map();
  const tabRe = /<span\b[^>]*\btab="(ln\d{1,2})"[^>]*>\s*([^<]{1,40}?)\s*<\/span>/g;
  let m;
  while ((m = tabRe.exec(s))) tabs.set(m[1], decodeEntities(m[2]).trim());
  const optLang = new Map();
  const groupRe = /<div\b[^>]*\bid="(ln\d{1,2})"[^>]*>([\s\S]*?)<\/ul>/g;
  while ((m = groupRe.exec(s))) {
    const label = tabs.get(m[1]) || '';
    m[2].replace(/href="#options-(\d{1,3})"/g, (x, n) => { if (!optLang.has(n)) optLang.set(n, label); return x; });
  }
  const found = [];
  const optRe = /<div\b[^>]*\bid="options-(\d{1,3})"[^>]*>\s*<iframe\b([^>]*)>/g;
  while ((m = optRe.exec(s))) {
    found.push({ src: tagAttr(m[2], 'data-src') || tagAttr(m[2], 'src'), language: optLang.get(m[1]) || '' });
  }
  // Markup changed and the option blocks are gone: every iframe, language unknown.
  if (!found.length) iframeSources(s).forEach((src) => found.push({ src, language: '' }));
  const out = [];
  found.forEach((f) => {
    if (!f.src) return;
    const multi = acceptMultiPlayer(f.src);
    if (multi) { out.push({ url: multi, audio: 'multi' }); return; }
    const single = acceptLanguagePlayer(f.src);
    if (single) out.push({ url: single, audio: audioFromLabel(f.language) });
  });
  const rank = (a) => (a === 'multi' ? 0 : a === 'hindi' ? 1 : 2);
  return dedupePlayers(out.map((p, i) => ({ p, i })).sort((x, y) => rank(x.p.audio) - rank(y.p.audio) || x.i - y.i).map((x) => x.p));
}

/** Season list: [{ season, number, slug }] sorted by episode number.
 *
 *  Episodes are filtered to the series' own slug. `loose` is for markup that is
 *  the series' own list and nothing else (a season answer): there the episodes
 *  may carry a slug of their own — Ben 10's series page is /series/ben-10/ but
 *  its episodes are /episode/ben-10-classic-1x1/ — so when no link uses the
 *  series slug, the slug most of the links use is taken. Links may be absolute
 *  (AnimeSalt) or relative (ToonStream). */
function parseSeasonEpisodes(html, slug, loose) {
  const all = new Map();
  const groups = new Map();
  const re = /href="(?:https:\/\/(?:www\.)?(?:animesalt|toonstream)\.[a-z]+)?\/episode\/([a-z0-9-]+?)-(\d{1,3})x(\d{1,5})\/?"/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const entry = { season: Number(m[2]), number: Number(m[3]), slug: m[1] };
    const key = m[2] + 'x' + m[3];
    if (!all.has(key)) all.set(key, entry);
    if (!groups.has(m[1])) groups.set(m[1], new Map());
    if (!groups.get(m[1]).has(key)) groups.get(m[1]).set(key, entry);
  }
  let chosen = slug ? groups.get(slug) : all;
  if (!chosen && loose) {
    groups.forEach((g) => { if (!chosen || g.size > chosen.size) chosen = g; });
  }
  return chosen ? Array.from(chosen.values()).sort((x, y) => x.number - y.number) : [];
}

/** The season numbers a series page offers (its season picker). */
function seasonNumbers(html) {
  const seasons = new Set();
  String(html || '').replace(/data-season="(\d{1,3})"/g, (m, n) => { seasons.add(Number(n)); return m; });
  return seasons;
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
  // Drop non-Latin names (Japanese, Korean, Devanagari): the libraries title
  // their entries in English, so those searches can only come back empty. A
  // Latin LETTER is required — "टॉय स्टोरी 4" has a digit and nothing else.
  return names.filter((n) => /[a-z]/i.test(n)).slice(0, MAX_SEARCH_NAMES);
}

function posterSet(details) {
  const set = new Set();
  if (details.poster_path) set.add(details.poster_path);
  const posters = details.images && details.images.posters;
  if (Array.isArray(posters)) posters.forEach((p) => { if (p && p.file_path) set.add(p.file_path); });
  return set;
}

/*  ── finding a title the search does not surface ──
 *
 *  AnimeSalt's search ranks films first and is not exhaustive: "doraemon" is
 *  four pages of Doraemon films and the two Doraemon series (1979, 2005) are
 *  not among them. Their pages are where WordPress puts any post —
 *  /series/<slug>/ — and the slug is the title run through sanitize_title,
 *  sometimes with the year (doraemon-2005). So when the search comes back
 *  without the title, those addresses are asked for directly, and a page counts
 *  only when its OWN poster (the header, before the first related card) is one
 *  of the title's TMDB posters: the same identity rule as the search cards, so a
 *  "closest match" redirect (/series/crayon-shin-chan/ lands on the Spin-off)
 *  is refused. */
const MAX_SLUG_PROBES = 6;

/** "Nobita's Dinosaur: Tom & Jerry" -> "nobitas-dinosaur-tom-jerry" (sanitize_title's shape). */
function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The slugs worth asking for, most likely first. */
function probeSlugs(details, names, max) {
  const year = String(details.first_air_date || details.release_date || '').slice(0, 4);
  const out = [];
  // A slug of digits alone ("4" from a title whose letters were not Latin) is
  // never a title's address.
  const add = (slug) => { if (slug && SLUG_RE.test(slug) && /[a-z]/.test(slug) && out.indexOf(slug) === -1) out.push(slug); };
  names.forEach((n) => {
    const base = slugify(n);
    add(base);
    if (/^\d{4}$/.test(year)) add(base + '-' + year);
    if (/^the-/.test(base)) add(base.slice(4));
  });
  return out.slice(0, max > 0 ? max : MAX_SLUG_PROBES);
}

/** TMDB poster paths of the page's own title: its header, before any card. */
function pagePosters(html) {
  const s = String(html || '');
  const cut = s.indexOf('<article class="post');
  const head = cut === -1 ? s : s.slice(0, cut);
  const out = new Set();
  const re = /image\.tmdb\.org\/t\/p\/[a-z0-9]+(\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))/g;
  let m;
  while ((m = re.exec(head))) out.add(m[1]);
  return out;
}

/** The slug of the page a probe ended on (after any redirect), or null when it
 *  left the library or is not a page of the wanted kind. */
function landedSlug(finalUrl, want, hostRe) {
  try {
    const u = new URL(finalUrl);
    if (u.protocol !== 'https:' || !(hostRe || /(^|\.)animesalt\.[a-z]+$/).test(u.hostname)) return null;
    const m = /^\/(series|movies)\/([^/]+)\/?$/.exec(u.pathname);
    return m && m[1] === want && SLUG_RE.test(m[2]) ? m[2] : null;
  } catch (e) { return null; }
}

/*  Within one search, cards that matched by poster, Hindi editions first: a
 *  library may list one show twice (ToonStream: naruto-shippuden-hindi-dub and
 *  naruto-shippuden-eng-jap share the TMDB poster). */
const HINDI_SLUG = /(^|-)hindi(-|$)/;
const NOT_HINDI_SLUG = /(^|-)(eng-jap|english|japanese|jap|sub|subbed|uncensored)(-|$)/;
function hindiFirst(cards) {
  const score = (c) => (HINDI_SLUG.test(c.slug) ? 0 : NOT_HINDI_SLUG.test(c.slug) ? 2 : 1);
  return cards.map((c, i) => ({ c, i })).sort((a, b) => score(a.c) - score(b.c) || a.i - b.i).map((x) => x.c);
}

/*  ── the libraries ──
 *
 *  Everything that differs between the two catalogues lives here; the lookup
 *  itself (search -> poster identity -> probe -> season -> episode -> player) is
 *  shared. `io.getText(url, init)` is the resolver's bounded fetch. */
const LIBRARIES = {
  animesalt: {
    key: 'animesalt',
    hostRe: /(^|\.)animesalt\.[a-z]+$/,
    searchPages: 2,
    probes: MAX_SLUG_PROBES,
    searchUrl: (q, page) => ORIGIN + (page > 1 ? '/page/' + page + '/' : '/') + '?s=' + encodeURIComponent(q),
    hasNext: hasNextSearchPage,
    titleUrl: (kind, slug) => ORIGIN + '/' + kind + '/' + slug + '/',
    episodeUrl: (slug, label) => ORIGIN + '/episode/' + slug + '-' + label + '/',
    players: animesaltPlayers,
    async seasonList(io, slug, season) {
      const page = await io.getText(ORIGIN + '/series/' + slug + '/');
      if (!page) return [];
      const post = /data-post="(\d{1,10})"/.exec(page);
      const seasons = seasonNumbers(page);
      if (post && seasons.has(season)) {
        const body = new URLSearchParams({ action: 'action_select_season', season: String(season), post: post[1] });
        const html = await io.getText(ORIGIN + '/wp-admin/admin-ajax.php', {
          method: 'POST',
          body: body.toString(),
          headers: {
            'user-agent': UA,
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest',
            referer: ORIGIN + '/series/' + slug + '/'
          }
        });
        return parseSeasonEpisodes(html, slug, true).filter((x) => x.season === season);
      }
      // A one-season show may render its list inline with no season picker.
      if (!seasons.size && season === 1) return parseSeasonEpisodes(page, slug).filter((x) => x.season === 1);
      return [];
    }
  },
  toonstream: {
    key: 'toonstream',
    hostRe: /(^|\.)toonstream\.[a-z]+$/,
    searchPages: 1,
    probes: 3,
    // Its search takes the kind, so a film never crowds out the series.
    searchUrl: (q, page, want) => TOONSTREAM_ORIGIN + '/s?q=' + encodeURIComponent(q) + '&type=' + (want === 'series' ? 'series' : 'movies'),
    hasNext: () => false,
    titleUrl: (kind, slug) => TOONSTREAM_ORIGIN + '/' + kind + '/' + slug + '/',
    episodeUrl: (slug, label) => TOONSTREAM_ORIGIN + '/episode/' + slug + '-' + label + '/',
    players: toonstreamPlayers,
    async seasonList(io, slug, season) {
      const page = await io.getText(TOONSTREAM_ORIGIN + '/series/' + slug + '/');
      if (!page) return [];
      const seasons = seasonNumbers(page);
      if (seasons.has(season)) {
        // The season fragment is that season's list and nothing else.
        const html = await io.getText(TOONSTREAM_ORIGIN + '/series/' + slug + '/season/' + season);
        return parseSeasonEpisodes(html, slug, true).filter((x) => x.season === season);
      }
      if (!seasons.size && season === 1) return parseSeasonEpisodes(page, slug).filter((x) => x.season === 1);
      return [];
    }
  }
};
const LIBRARY_ORDER = ['animesalt', 'toonstream'];

/*  ── backups ──
 *  Fixed templates, numeric ids only (parseToonRequest), ordered by the
 *  measurement in the header. `referrer` is the policy the frame must use:
 *  VidRift plays series only when it can see the embedding origin. */
const BACKUP_PLAYERS = {
  vidnest: {
    movie: (id) => 'https://vidnest.fun/movie/' + id,
    tv: (id, s, e) => 'https://vidnest.fun/tv/' + id + '/' + s + '/' + e
  },
  vidrift: {
    referrer: 'origin',
    movie: (id) => 'https://embed.vidrift.net/embed/movie/' + id + '?autoplay=1&brandColor=f5c518',
    tv: (id, s, e) => 'https://embed.vidrift.net/embed/tv/' + id + '/' + s + '/' + e + '?autoplay=1&brandColor=f5c518'
  },
  vidzee: {
    movie: (id) => 'https://player.vidzee.wtf/embed/movie/' + id,
    tv: (id, s, e) => 'https://player.vidzee.wtf/embed/tv/' + id + '/' + s + '/' + e
  },
  moviesapi: {
    movie: (id) => 'https://moviesapi.vip/movie/' + id,
    tv: (id, s, e) => 'https://moviesapi.vip/tv/' + id + '/' + s + '/' + e
  }
};
const BACKUP_ORDER = {
  movie: ['vidnest', 'vidrift', 'vidzee'],
  tv: ['vidrift', 'moviesapi', 'vidnest', 'vidzee']
};
/** The host origins backups can land on (for the app's connection warm-up). */
const BACKUP_HOSTS = ['https://vidnest.fun', 'https://embed.vidrift.net', 'https://player.vidzee.wtf', 'https://moviesapi.vip'];

/** Backups for a parsed request: [{ key, url, referrer }]. */
function backupSources(req) {
  if (!req || (req.type !== 'movie' && req.type !== 'tv') || !Number.isInteger(req.id) || req.id < 1) return [];
  return BACKUP_ORDER[req.type].map((key) => {
    const b = BACKUP_PLAYERS[key];
    const url = req.type === 'tv' ? b.tv(req.id, req.season, req.episode) : b.movie(req.id);
    return { key, url, referrer: b.referrer || 'no-referrer' };
  });
}

const AUDIO_RANK = { multi: 0, hindi: 1 };
const SCOPE_RANK = { title: 0, season: 1, episode: 2 };

/**
 * createToonResolver({ tmdbDetails, fetch, now, log, deadlineMs, libraries })
 *
 *   tmdbDetails(type, id, context) -> Promise<TMDB details with `images` (posters) and
 *     `alternative_titles` appended, or null when TMDB has no such title>
 *   libraries: which libraries to ask, in priority order (default: all).
 *
 * Returns { resolve(request, context) } where request is parseToonRequest's
 * output, `context` is handed untouched to tmdbDetails (the Worker passes its
 * env/ctx there), and the answer is
 *   { available: true, url, audio, match, sources: [...], backups: [...] }  or
 *   { available: false, reason, scope, sources: [], backups: [...] }.
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
  const libs = (Array.isArray(options.libraries) ? options.libraries : LIBRARY_ORDER)
    .map((k) => LIBRARIES[k]).filter(Boolean);

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

  /*  { text, url } of a page (url: where redirects ended), or null when the
   *  page does not exist. ToonStream answers a missing page with a 500 whose
   *  body is its "404 Not Found" page; that is a miss, not an outage. */
  async function getPage(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await doFetch(url, Object.assign({
        headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8' },
        redirect: 'follow',
        signal: controller.signal
      }, init || {}));
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = res.status === 500 ? await res.text().catch(() => '') : '';
        if (/<title>[^<]*404 Not Found/i.test(body)) return null;
        throw new Error('upstream responded ' + res.status + ' for ' + url);
      }
      return { text: await res.text(), url: res.url || url };
    } finally {
      clearTimeout(timer);
    }
  }
  async function getText(url, init) {
    const page = await getPage(url, init);
    return page ? page.text : null;
  }
  const io = { getText };

  /*  What identifies a TMDB title to the libraries — names to search, its
   *  posters, its year — fetched once and shared by every library. Kept small on
   *  purpose: the full TMDB answer (with every image) is tens of KB, and the
   *  memo holds thousands of entries inside one isolate. */
  function identity(type, id, context) {
    const key = 'identity:' + type + ':' + id;
    const cached = memoGet(key);
    if (cached !== undefined) return Promise.resolve(cached);
    return once(key, async () => {
      const details = await tmdbDetails(type, id, context);
      const value = details ? {
        names: searchNames(details),
        posters: Array.from(posterSet(details)),
        year: String(details.first_air_date || details.release_date || '').slice(0, 4)
      } : null;
      memoPut(key, value, value ? TTL_MS.title : TTL_MS.titleMiss);
      return value;
    });
  }

  /*  The search missed: ask for the title's likely addresses directly, all at
   *  once, and keep the first (in probeSlugs order) whose own poster is one of
   *  the title's. A probe that failed on the network, with nothing found, is
   *  an upstream failure rather than a miss, so it is not memoised as one. */
  async function probeTitle(lib, want, ident, posters) {
    if (!posters.size || !lib.probes) return null;
    const slugs = probeSlugs({ release_date: ident.year }, ident.names, lib.probes);
    const settled = await Promise.all(slugs.map((slug) =>
      getPage(lib.titleUrl(want, slug)).then((page) => ({ page }), (err) => ({ err }))));
    let failure = null;
    for (const s of settled) {
      if (s.err) { failure = failure || s.err; continue; }
      if (!s.page) continue;
      const slug = landedSlug(s.page.url, want, lib.hostRe);
      if (!slug) continue;
      const own = pagePosters(s.page.text);
      for (const p of own) if (posters.has(p)) return { kind: want, slug, by: 'page' };
    }
    if (failure) throw failure;
    return null;
  }

  /*  TMDB title -> { kind, slug, by } in one library, or { miss }. Cached per
   *  library and title: the mapping does not depend on the episode. No genre
   *  gate — the libraries carry some live action (ONE PIECE Live Action), so
   *  they decide, by poster identity like everything else. */
  function findTitle(lib, type, id, context) {
    const key = 'title:' + lib.key + ':' + type + ':' + id;
    const cached = memoGet(key);
    if (cached !== undefined) return Promise.resolve(cached);
    return once(key, async () => {
      const ident = await identity(type, id, context);
      if (!ident) { memoPut(key, { miss: 'tmdb' }, TTL_MS.titleMiss); return { miss: 'tmdb' }; }

      const want = type === 'tv' ? 'series' : 'movies';
      const posters = new Set(ident.posters);
      const names = ident.names;
      const wantedTitles = new Set(names.map(normaliseTitle));
      const byTitle = new Map();
      let found = null;

      for (let n = 0; n < names.length && !found; n++) {
        // The primary name may read a second page (Doraemon's series sits behind
        // a page of Doraemon films); the alternates read one.
        const pages = n === 0 ? lib.searchPages : 1;
        for (let page = 1; page <= pages && !found; page++) {
          const html = await getText(lib.searchUrl(names[n], page, want));
          if (!html) break;
          const cards = parseSearchCards(html).filter((c) => c.kind === want);
          const byPoster = hindiFirst(cards.filter((c) => c.poster && posters.has(c.poster)));
          if (byPoster.length) { found = { kind: want, slug: byPoster[0].slug, by: 'poster' }; break; }
          cards.forEach((c) => { if (wantedTitles.has(normaliseTitle(c.title))) byTitle.set(c.slug, c); });
          if (!lib.hasNext(html, page)) break;
        }
      }
      if (!found && byTitle.size === 1) {
        found = { kind: want, slug: byTitle.keys().next().value, by: 'title' };
      }
      if (!found) found = await probeTitle(lib, want, ident, posters);
      const value = found || { miss: 'not-in-library' };
      memoPut(key, value, found ? TTL_MS.title : TTL_MS.titleMiss);
      return value;
    });
  }

  function seasonList(lib, slug, season) {
    const key = 'season:' + lib.key + ':' + slug + ':' + season;
    const cached = memoGet(key);
    if (cached !== undefined) return Promise.resolve(cached);
    return once(key, async () => {
      const list = await lib.seasonList(io, slug, season);
      memoPut(key, list, list.length ? TTL_MS.season : TTL_MS.miss);
      return list;
    });
  }

  /*  One library's answer for one request: { players, match } or
   *  { reason, scope }. Throws on an upstream failure. */
  async function libraryUncached(lib, req, context) {
    const title = await findTitle(lib, req.type, req.id, context);
    if (!title || title.miss) return { reason: (title && title.miss) || 'not-in-library', scope: 'title' };

    let pageUrl;
    let episodeLabel = null;
    if (req.type === 'movie') {
      pageUrl = lib.titleUrl('movies', title.slug);
    } else {
      const list = await seasonList(lib, title.slug, req.season);
      if (!list.length) return { reason: 'season-not-in-library', scope: 'season' };
      const ep = pickEpisode(list, req.episode);
      if (!ep) return { reason: 'episode-not-in-library', scope: 'episode' };
      episodeLabel = ep.season + 'x' + ep.number;
      pageUrl = lib.episodeUrl(ep.slug, episodeLabel);
    }

    const html = await getText(pageUrl);
    const players = html ? lib.players(html).slice(0, MAX_PLAYERS_PER_LIBRARY) : [];
    if (!players.length) return { reason: 'no-player-on-page', scope: req.type === 'tv' ? 'episode' : 'title' };
    return { players, match: { slug: title.slug, by: title.by, episode: episodeLabel } };
  }

  function resultKey(req) {
    return req.type + ':' + req.id + (req.type === 'tv' ? ':' + req.season + ':' + req.episode : '');
  }

  /*  Memoised per library: a hit for hours, a miss for half an hour, an
   *  upstream failure not at all (the next request asks again). */
  function libraryResult(lib, req, context) {
    const key = 'result:' + lib.key + ':' + resultKey(req);
    const cached = memoGet(key);
    if (cached !== undefined) return Promise.resolve(Object.assign({ cache: 'HIT' }, cached));
    return once(key, async () => {
      const value = await libraryUncached(lib, req, context);
      memoPut(key, value, value.players ? TTL_MS.hit : TTL_MS.miss);
      return Object.assign({ cache: 'MISS' }, value);
    });
  }

  /*  Every library's answer by the deadline: { v } settled, { err } failed,
   *  null still running. */
  function settleWithin(tasks, ms) {
    const state = tasks.map(() => null);
    if (!tasks.length) return Promise.resolve(state);
    return new Promise((done) => {
      let left = tasks.length;
      const timer = setTimeout(() => done(state.slice()), ms);
      tasks.forEach((t, i) => t.then((v) => ({ v }), (err) => ({ err }))
        .then((r) => {
          state[i] = r;
          if (--left === 0) { clearTimeout(timer); done(state.slice()); }
        }));
    });
  }

  async function resolve(req, context) {
    const tasks = libs.map((lib) => libraryResult(lib, req, context));
    // A Worker would cancel the late lookups with the response; keep them alive
    // so they still land in the memo.
    const ctx = context && context.ctx;
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(Promise.all(tasks.map((t) => t.catch(() => null))));
    const settled = await settleWithin(tasks, deadlineMs);

    const key = resultKey(req);
    const found = [];
    let busy = false;
    let late = false;
    let allHit = true;
    let miss = null;
    settled.forEach((r, i) => {
      const lib = libs[i];
      if (!r) {
        busy = true; late = true; allHit = false;
        log('[toon] ' + lib.key + ' ' + key + ' over the ' + deadlineMs + 'ms deadline');
        return;
      }
      if (r.err) {
        busy = true; allHit = false;
        log('[toon] ' + lib.key + ' ' + key + ' upstream failure: ' + (r.err && r.err.message));
        return;
      }
      const v = r.v;
      if (v.cache !== 'HIT') allHit = false;
      if (v.players) {
        v.players.forEach((p, n) => found.push({ url: p.url, audio: p.audio, library: lib.key, match: v.match, order: i, n }));
      } else if (!miss || (SCOPE_RANK[v.scope] || 0) > (SCOPE_RANK[miss.scope] || 0)) {
        miss = { reason: v.reason, scope: v.scope };
      }
    });

    const rank = (a) => (Object.prototype.hasOwnProperty.call(AUDIO_RANK, a) ? AUDIO_RANK[a] : 2);
    found.sort((a, b) => rank(a.audio) - rank(b.audio) || a.order - b.order || a.n - b.n);
    const seen = new Set();
    const sources = [];
    found.forEach((p) => {
      if (seen.has(p.url) || sources.length >= MAX_SOURCES) return;
      seen.add(p.url);
      sources.push(p);
    });
    const backups = backupSources(req);
    const cache = allHit ? 'HIT' : 'MISS';

    if (sources.length) {
      const best = sources[0];
      return {
        available: true,
        url: best.url,
        audio: best.audio,
        match: Object.assign({ library: best.library }, best.match),
        sources: sources.map((p) => ({ url: p.url, audio: p.audio, library: p.library })),
        backups,
        cache
      };
    }
    /*  Nothing found while a library failed or is still running: that is "busy",
     *  never "does not have it". Nothing about it is memoised. */
    if (busy) {
      const out = { available: false, reason: 'upstream-error', scope: 'request', sources: [], backups, cache: 'MISS' };
      if (late) out.late = true;
      return out;
    }
    return {
      available: false,
      reason: miss ? miss.reason : 'not-in-library',
      scope: miss ? miss.scope : 'title',
      sources: [],
      backups,
      cache
    };
  }

  return { resolve, _memo: memo };
}

/*  ══════════════════════════════════════════════════════════════════════════
 *  THE TOON HINDI PLAYER  —  what /api/toon/embed serves
 *  ══════════════════════════════════════════════════════════════════════════
 *
 *  A small page of our own, framed by the app's player, that frames the actual
 *  player and puts a source bar above it:
 *
 *    [Toon Hindi] [Multi-Audio] [Hindi 2] [Backup 1] [Backup 2]   Hindi default
 *
 *  It answers at once (nothing to wait for on our side), asks /api/toon/resolve
 *  for the sources, and starts the best one — or the one this viewer picked last
 *  time for this title, so a series keeps the source that worked. A title the
 *  libraries do not carry plays its first backup, and the bar says so. Nothing
 *  ever moves the viewer to another server of the app: that was the reported
 *  problem (tap Toon Hindi, land on another server's error page).
 *
 *  Opened with autoplay=0 (the app's hidden warm-up frame), it only asks for
 *  the sources — which warms our memo and the browser's HTTP cache — and frames
 *  nothing, so a hidden frame can never start audio.
 *
 *  The page tells the app what it is playing (mz-toon:playing) so the app can
 *  say so; the message carries no data from the URL. The script is static and
 *  runs under a per-response nonce; the frame target is checked to be https.
 */
const PLAYER_CSS = 'html,body{margin:0;height:100%;background:#000;color:#e8e8f4;overflow:hidden;'
  + 'font:500 13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
  + 'body{display:flex;flex-direction:column}'
  + '#bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:34px;padding:3px 8px;box-sizing:border-box;'
  + 'background:linear-gradient(180deg,#121224,#0a0a14);border-bottom:1px solid rgba(245,197,24,.18)}'
  + '#brand{flex:0 0 auto;font-weight:800;font-size:12px;letter-spacing:.02em;color:#f5c518;white-space:nowrap}'
  + '#srcs{flex:0 1 auto;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:2px 0}'
  + '#srcs::-webkit-scrollbar{display:none}'
  + '.chip{flex:0 0 auto;min-height:26px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e8e8f4;'
  + 'border-radius:999px;padding:3px 11px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}'
  + '.chip:hover{border-color:rgba(245,197,24,.6)}'
  + '.chip[aria-pressed="true"]{background:#f5c518;border-color:#f5c518;color:#111;font-weight:700}'
  + '.chip.bk{border-style:dashed}'
  + '.chip:focus-visible,#retry:focus-visible,#reload:focus-visible{outline:2px solid #fff;outline-offset:2px}'
  + '#note{flex:1 1 auto;min-width:0;text-align:right;font-size:11.5px;color:rgba(232,232,244,.66);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '#retry,#reload{flex:0 0 auto;min-height:26px;border:0;border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;'
  + 'background:rgba(245,197,24,.14);color:#f5c518}'
  + '#retry[hidden],#reload[hidden]{display:none}'
  + '#stage{position:relative;flex:1 1 auto;min-height:0;background:#000}'
  + '#stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0}'
  + '#spin{position:absolute;inset:0;z-index:2;display:grid;place-items:center;text-align:center;padding:16px;background:#05050c}'
  + '#spin[hidden]{display:none}'
  + '.ring{width:34px;height:34px;margin:0 auto 12px;border:3px solid rgba(245,197,24,.2);border-top-color:#f5c518;border-radius:50%;animation:r .9s linear infinite}'
  + '#spinText{color:#f5c518;font-weight:600}#spinSub{margin-top:4px;font-size:12px;color:rgba(232,232,244,.55)}'
  + '@keyframes r{to{transform:rotate(360deg)}}'
  + '@media (prefers-reduced-motion:reduce){.ring{animation-duration:2.4s}}'
  + '@media (max-width:520px){#brand,#note{display:none}#bar{gap:6px;padding:3px 6px}}';

/*  Runs in the frame. ES5 on purpose: smart-TV browsers frame this too. */
const PLAYER_JS = '(function(){"use strict";'
  + 'var q=new URLSearchParams(location.search);'
  + 'var type=q.get("type")==="tv"?"tv":"movie",id=String(q.get("id")||"").replace(/[^0-9]/g,"");'
  + 'var s=String(parseInt(q.get("s"),10)||1),e=String(parseInt(q.get("e"),10)||1);'
  + 'var warm=q.get("autoplay")==="0";'
  + 'var api=location.pathname.replace(/\\/embed\\/?$/,"/resolve")+"?type="+type+"&id="+id+(type==="tv"?"&s="+s+"&e="+e:"");'
  + 'var pickKey="mzToonPick:"+type+":"+id;'
  + 'var $=function(x){return document.getElementById(x)};'
  + 'var stage=$("stage"),bar=$("srcs"),note=$("note"),spin=$("spin"),spinText=$("spinText"),spinSub=$("spinSub"),retry=$("retry"),reload=$("reload");'
  + 'var list=[],cur=-1,frame=null,spinTimer=null,info={};'
  + 'function tell(m){try{if(parent!==window)parent.postMessage(m,"*")}catch(x){}}'
  + 'function setNote(t){note.textContent=t;note.title=t}'
  + 'function busy(t,sub){spinText.textContent=t;spinSub.textContent=sub||"";spin.hidden=false}'
  + 'function idle(){spin.hidden=true;if(spinTimer){clearTimeout(spinTimer);spinTimer=null}}'
  + 'var NAMES={multi:"Multi-Audio",hindi:"Hindi"};'
  + 'function cap(a){return a&&a!=="single"?a.charAt(0).toUpperCase()+a.slice(1):"Server"}'
  /*  Pick keys are library:audio:nth-within-library, so "the second ToonStream
   *  multi-audio file" is still found on the next episode even when AnimeSalt
   *  does not have that one. A resolve answer without `sources` (one cached by
   *  an older build) still plays its single `url`. */
  + 'function build(d){list=[];var count={},per={},tally={},n=0;'
  + 'var srcs=d.sources||(d.url?[{url:d.url,audio:d.audio||"multi",library:"library"}]:[]);'
  + 'srcs.forEach(function(x){if(!x||!/^https:\\/\\//.test(x.url))return;var name=NAMES[x.audio]||cap(x.audio);count[name]=(count[name]||0)+1;'
  + 'var base=String(x.library)+":"+x.audio;per[base]=(per[base]||0)+1;'
  + 'list.push({url:x.url,ref:"no-referrer",audio:x.audio,lib:true,name:name,key:base+":"+per[base]})});'
  + 'list.forEach(function(x){if(count[x.name]>1){tally[x.name]=(tally[x.name]||0)+1;x.label=x.name+" "+tally[x.name]}else x.label=x.name});'
  + '(d.backups||BACKUPS).forEach(function(x){if(!x||!/^https:\\/\\//.test(x.url))return;n++;'
  + 'list.push({url:x.url,ref:x.referrer==="origin"?"origin":"no-referrer",lib:false,label:"Backup "+n,key:"backup:"+x.key})})}'
  + 'function render(){bar.textContent="";list.forEach(function(x,i){var b=document.createElement("button");b.type="button";'
  + 'b.className="chip"+(x.lib?"":" bk");b.textContent=x.label;b.setAttribute("aria-pressed",i===cur?"true":"false");'
  + 'b.title=x.lib?(x.audio==="multi"?"Hindi library \\u00b7 one stream, every audio track, Hindi selected":"Hindi library"):"Backup stream \\u00b7 audio depends on the source";'
  + 'b.addEventListener("click",function(){play(i,true)});bar.appendChild(b)})}'
  + 'function explain(x){if(x.lib)return x.audio==="multi"?"Hindi \\u00b7 multi-audio (switch tracks in the player)":"Hindi audio";'
  + 'if(info.reason==="upstream-error")return "Hindi library is slow right now \\u00b7 playing a backup";'
  + 'if(info.available)return "Backup stream \\u00b7 audio depends on the source";'
  + 'return "Not in the Hindi library yet \\u00b7 playing a backup (audio may vary)"}'
  + 'function play(i,byHand){var x=list[i];if(!x)return;cur=i;'
  + 'if(byHand){try{localStorage.setItem(pickKey,x.key)}catch(err){}}'
  + 'if(frame&&frame.parentNode)frame.parentNode.removeChild(frame);'
  + 'frame=document.createElement("iframe");frame.setAttribute("allow","autoplay; encrypted-media; fullscreen; picture-in-picture");'
  + 'frame.setAttribute("allowfullscreen","");frame.setAttribute("referrerpolicy",x.ref);frame.setAttribute("title","Toon Hindi player");'
  + 'frame.setAttribute("scrolling","no");'
  + 'busy("Loading "+x.label+"\\u2026",x.lib?"Hindi library":"Backup stream");'
  + 'frame.addEventListener("load",function(){setTimeout(idle,250)});spinTimer=setTimeout(idle,12000);'
  + 'frame.src=x.url;stage.appendChild(frame);render();setNote(explain(x));reload.hidden=false;'
  + 'tell({type:"mz-toon:playing",library:!!x.lib,audio:x.lib?x.audio:null,label:x.label,byHand:!!byHand})}'
  + 'function start(d){info=d||{};build(info);retry.hidden=info.reason!=="upstream-error";'
  + 'if(!list.length){idle();setNote("");busy("This title cannot be opened here","Pick another server below the player.");'
  + 'tell({type:"mz-toon:unavailable",reason:"bad-request"});return}'
  + 'if(warm){idle();render();return}'
  + 'var want=null;try{want=localStorage.getItem(pickKey)}catch(err){}'
  + 'var at=0;for(var i=0;i<list.length;i++){if(list[i].key===want){at=i;break}}'
  + 'play(at,false)}'
  + 'function load(){busy("Finding the Hindi version\\u2026","Searching the Hindi anime & cartoon libraries");retry.hidden=true;'
  + 'var ctl=typeof AbortController==="function"?new AbortController():null;var t=setTimeout(function(){if(ctl)ctl.abort()},15000);'
  + 'fetch(api,{credentials:"same-origin",signal:ctl?ctl.signal:undefined}).then(function(r){if(!r.ok)throw new Error("resolve "+r.status);return r.json()})'
  + '.then(function(d){clearTimeout(t);start(d)},function(){clearTimeout(t);start({available:false,reason:"upstream-error",sources:[],backups:BACKUPS})})}'
  + 'retry.addEventListener("click",function(){try{localStorage.removeItem(pickKey)}catch(err){}load()});'
  + 'reload.addEventListener("click",function(){if(cur>-1)play(cur,false)});'
  + 'bar.addEventListener("keydown",function(ev){var k=ev.key;if(k!=="ArrowRight"&&k!=="ArrowLeft")return;'
  + 'var bs=bar.querySelectorAll("button"),i=Array.prototype.indexOf.call(bs,document.activeElement);if(i<0)return;'
  + 'var j=k==="ArrowRight"?Math.min(bs.length-1,i+1):Math.max(0,i-1);bs[j].focus();ev.preventDefault()});'
  + 'var BACKUPS=JSON.parse($("bk").textContent||"[]");'
  + 'if(!id){start({sources:[],backups:[]});return}'
  + 'load()})();';

/**
 * The Toon Hindi player page. `nonce` is the per-response CSP nonce;
 * `backups` (backupSources(req)) is embedded so the page can still play when
 * the resolve call itself fails. Nothing from the URL is written into the page:
 * backups are built from a parsed request, and JSON is escaped for a script
 * element.
 */
function playerPageHtml(nonce, backups) {
  const safeNonce = String(nonce || '').replace(/[^A-Za-z0-9+/=_-]/g, '');
  const data = JSON.stringify(Array.isArray(backups) ? backups : []).replace(/</g, '\\u003c');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>Toon Hindi</title>'
    + '<style nonce="' + safeNonce + '">' + PLAYER_CSS + '</style></head><body>'
    + '<div id="bar" role="toolbar" aria-label="Toon Hindi sources">'
    + '<span id="brand">\u{1F338} Toon Hindi</span>'
    + '<div id="srcs"></div>'
    + '<button id="retry" type="button" hidden>Retry Hindi</button>'
    + '<span id="note" role="status" aria-live="polite"></span>'
    + '<button id="reload" type="button" hidden aria-label="Reload this source" title="Reload this source">\u21BB</button>'
    + '</div>'
    + '<main id="stage"><div id="spin"><div><div class="ring"></div><div id="spinText">Loading\u2026</div><div id="spinSub"></div></div></div></main>'
    + '<script type="application/json" id="bk">' + data + '</script>'
    + '<script nonce="' + safeNonce + '">' + PLAYER_JS + '</script>'
    + '</body></html>';
}

/*  The player page and the "cannot open" page may be framed by the app's own
 *  pages only. 'self' is the production case; the localhost entries cover the
 *  dev server, where the page and the API can sit on different ports. */
const UNAVAILABLE_FRAME_ANCESTORS = "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*";

/** CSP for the player page: its own nonce'd script and style, our API, https frames. */
function playerPageCsp(nonce) {
  const n = "'nonce-" + String(nonce || '').replace(/[^A-Za-z0-9+/=_-]/g, '') + "'";
  return "default-src 'none'; script-src " + n + '; style-src ' + n + "; connect-src 'self'; frame-src https:; "
    + "img-src 'self' data:; base-uri 'none'; form-action 'none'; " + UNAVAILABLE_FRAME_ANCESTORS;
}

/*  The page the player frame shows when the request itself is malformed (the
 *  app never builds one, so this is a hand-typed or truncated URL). It tells the
 *  app (its parent) straight away. No user input is echoed: `reason` is one of
 *  this module's own constants, and only lowercase letters and dashes survive. */
function unavailablePageHtml(reason) {
  const safe = String(reason || 'bad-request').replace(/[^a-z-]/g, '');
  const copy = ['This title cannot be opened on Toon Hindi', 'Pick another server below the player.'];
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

/** A fresh CSP nonce. Workers and Node 19+ both have Web Crypto as a global;
 *  no require('crypto') here, which the Worker bundle could not resolve. */
function makeNonce() {
  const bytes = new Uint8Array(16);
  const c = typeof globalThis !== 'undefined' && globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

module.exports = {
  ORIGIN,
  TOONSTREAM_ORIGIN,
  ANIMATED_GENRES,
  TTL_MS,
  LIBRARY_ORDER,
  BACKUP_HOSTS,
  ToonRequestError,
  parseToonRequest,
  normaliseTitle,
  parseSearchCards,
  pickPlayer,
  animesaltPlayers,
  toonstreamPlayers,
  parseSeasonEpisodes,
  pickEpisode,
  isAnimated,
  searchNames,
  slugify,
  probeSlugs,
  pagePosters,
  landedSlug,
  acceptMultiPlayer,
  acceptLanguagePlayer,
  backupSources,
  createToonResolver,
  playerPageHtml,
  playerPageCsp,
  makeNonce,
  unavailablePageHtml,
  UNAVAILABLE_FRAME_ANCESTORS
};
