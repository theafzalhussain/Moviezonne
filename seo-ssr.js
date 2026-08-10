'use strict';

/*  ══════════════════════════════════════════════════════════════════════
 *  MovieZone — SERVER-RENDERED SEO SURFACE
 *  ══════════════════════════════════════════════════════════════════════
 *
 *  WHY THIS FILE EXISTS
 *  The MovieZone frontend is a single-page app that navigates with hash
 *  fragments (#watch-movie-550, #collections-mcu). Google discards
 *  everything after "#", so the entire catalogue collapsed into ONE
 *  indexable URL — the homepage. Nothing could ever rank for a title
 *  specific query like "fight club watch online" because no page existed
 *  to answer it.
 *
 *  This module adds real, crawlable, server-rendered URLs:
 *    /movie/550-fight-club        → Movie detail page + Movie schema
 *    /tv/1396-breaking-bad        → Series detail page + TVSeries schema
 *    /movies/action               → Category landing page
 *    /series/web-series           → TV category landing page
 *    /sitemap.xml                 → sitemap index
 *    /sitemap-static.xml          → homepage + every category page
 *    /sitemap-movies.xml          → popular / top rated / trending movies
 *    /sitemap-tv.xml              → popular / top rated series
 *
 *  Every page gets a UNIQUE <title> and <meta name="description">.
 *  Descriptions are built from real TMDB data and always fall back to a
 *  generated sentence, so a page is never shipped without one.
 *
 *  SECURITY: all TMDB values are attacker-influenced as far as this file
 *  is concerned (an overview can contain <script>). Text interpolated into
 *  markup goes through esc(); JSON-LD goes through jsonLdScript(), which
 *  escapes the "<", ">" and "&" that could break out of a <script> block.
 */

const fs = require('fs');
const path = require('path');

// ── Site identity ────────────────────────────────────────────────────────
const SITE_URL = (process.env.SITE_URL || 'https://moviezone.dev').replace(/\/+$/, '');
const SITE_NAME = 'MovieZone';
const LOGO_URL = SITE_URL + '/icon-512.png';

const IMG_POSTER = 'https://image.tmdb.org/t/p/w342';
const IMG_POSTER_LG = 'https://image.tmdb.org/t/p/w500';
const IMG_BACKDROP = 'https://image.tmdb.org/t/p/w1280';
const IMG_PROFILE = 'https://image.tmdb.org/t/p/w185';

// Detail pages are cheap to regenerate and change rarely — let the CDN own them.
const DETAIL_CACHE = 'public, max-age=1800, s-maxage=86400, stale-while-revalidate=604800';
const CATEGORY_CACHE = 'public, max-age=900, s-maxage=21600, stale-while-revalidate=86400';
const SITEMAP_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
const HOME_CACHE = 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400';
const BROWSE_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

// ── Sitemap freshness ──────────────────────────────────────────────────────
// Google learns to distrust <lastmod> when every URL claims to have changed
// today, every day. This date is a deliberate, hand-bumped constant: change it
// only when the SSR templates or category copy actually change. Detail-page
// lastmod comes from the title's real release/air date instead.
const SITEMAP_FALLBACK_DATE = process.env.SITEMAP_LASTMOD || '2026-08-10';

// Categories whose contents genuinely rotate day to day. Everything else is
// evergreen and gets a weekly changefreq.
const VOLATILE_CATEGORY_SLUGS = new Set([
  'trending', 'popular', 'now-playing', 'upcoming', 'airing-today', 'on-the-air'
]);

// Where the nightly sitemap builder writes the full catalogue.
const SITEMAP_CACHE_FILE = path.join(__dirname, 'sitemap-cache.json');
const SITEMAP_CHUNK_SIZE = 5000;

// A-Z hubs turn the catalogue into a flat index: any title is 2 clicks from
// the homepage instead of sitting 25 pages deep in a prev/next chain.
const BROWSE_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('').concat(['0-9']);
const BROWSE_PER_PAGE = 120;

// TMDB genre ids → display names (discover endpoints return ids, not names).
const GENRE_NAMES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics'
};

const LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
  kn: 'Kannada', mr: 'Marathi', bn: 'Bengali', pa: 'Punjabi', ur: 'Urdu',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', es: 'Spanish', fr: 'French',
  de: 'German', it: 'Italian', ru: 'Russian', pt: 'Portuguese', tr: 'Turkish',
  th: 'Thai', ar: 'Arabic', id: 'Indonesian'
};

// ══════════════════════════════════════════════════════════════════════
//  ESCAPING + SMALL HELPERS
// ══════════════════════════════════════════════════════════════════════

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for interpolation into HTML text or a quoted attribute. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

/**
 * Serialise structured data for a <script type="application/ld+json"> block.
 * JSON.stringify alone is NOT enough: a "</script>" inside any string value
 * would terminate the block early and turn the rest into live markup.
 */
function jsonLdScript(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (value === null || value === undefined || value === '') return undefined;
    if (Array.isArray(value) && value.length === 0) return undefined;
    return value;
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** Escape the five characters that are not legal in XML text nodes. */
function escXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** "Fight Club" → "fight-club". Diacritics folded, length capped. */
function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019\u2018]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/**
 * Split "550-fight-club" into its numeric id and title slug.
 * Returns null for anything that is not a plain positive integer prefix,
 * which keeps non-numeric junk from ever reaching the TMDB proxy.
 */
function parseIdSlug(raw) {
  const match = /^([1-9][0-9]{0,8})(?:-([a-z0-9-]*))?$/i.exec(String(raw || '').trim());
  if (!match) return null;
  return { id: match[1], slug: (match[2] || '').toLowerCase() };
}

/** Trim to maxLen without cutting a word in half; adds an ellipsis if cut. */
function truncate(text, maxLen) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\-]$/, '') + '…';
}

function yearOf(item) {
  return String(item && (item.release_date || item.first_air_date) || '').slice(0, 4);
}

function titleOf(item) {
  return (item && (item.title || item.name || item.original_title || item.original_name)) || '';
}

function ratingOf(item) {
  const n = Number(item && item.vote_average);
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : '';
}

function languageName(code) {
  return LANGUAGE_NAMES[code] || (code ? String(code).toUpperCase() : '');
}

function genreNamesOf(item) {
  if (Array.isArray(item.genres) && item.genres.length) {
    return item.genres.map((g) => g && g.name).filter(Boolean);
  }
  if (Array.isArray(item.genre_ids)) {
    return item.genre_ids.map((id) => GENRE_NAMES[id]).filter(Boolean);
  }
  return [];
}

/** Minutes → ISO-8601 duration ("PT2H28M"), the format schema.org expects. */
function isoDuration(minutes) {
  const total = parseInt(minutes, 10);
  if (!Number.isFinite(total) || total <= 0) return '';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '');
}

function runtimeLabel(minutes) {
  const total = parseInt(minutes, 10);
  if (!Number.isFinite(total) || total <= 0) return '';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm' : '').trim();
}

/** Canonical path for a title. Kind is 'movie' or 'tv'. */
function detailPath(kind, item) {
  const slug = slugify(titleOf(item));
  return '/' + (kind === 'tv' ? 'tv' : 'movie') + '/' + item.id + (slug ? '-' + slug : '');
}

// ══════════════════════════════════════════════════════════════════════
//  DESCRIPTION BUILDERS
//  Every page must ship a non-empty, page-specific description. TMDB
//  overviews are missing or empty often enough that a deterministic
//  fallback is mandatory, not a nicety.
// ══════════════════════════════════════════════════════════════════════

/**
 * Meta description for a movie/series detail page.
 * Prefers the real synopsis, prefixed with the facts a searcher scans for
 * (year, rating, language). Falls back to a fully generated sentence.
 */
function buildDetailDescription(item, kind) {
  const title = titleOf(item);
  const year = yearOf(item);
  const rating = ratingOf(item);
  const overview = String(item.overview || '').replace(/\s+/g, ' ').trim();
  const genres = genreNamesOf(item).slice(0, 3).join(', ');
  const noun = kind === 'tv' ? 'web series' : 'movie';

  const facts = [];
  if (year) facts.push(year);
  if (genres) facts.push(genres);
  if (rating) facts.push('IMDb style rating ' + rating + '/10');

  if (overview) {
    const prefix = facts.length ? '(' + facts.join(' • ') + ') ' : '';
    return truncate(prefix + overview, 158);
  }

  // No synopsis on TMDB — generate one from whatever metadata exists.
  const parts = ['Watch ' + title];
  if (year) parts[0] += ' (' + year + ')';
  parts[0] += ' ' + noun + ' online in HD and 4K on ' + SITE_NAME + '.';
  if (genres) parts.push(genres + '.');
  if (rating) parts.push('Rated ' + rating + '/10.');
  const lang = languageName(item.original_language);
  if (lang) parts.push(lang + ' with multi-language audio options.');
  return truncate(parts.join(' '), 158);
}

/** Human-readable <title> for a detail page. Kept under ~60 visible chars. */
function buildDetailTitle(item, kind) {
  const title = titleOf(item);
  const year = yearOf(item);
  const noun = kind === 'tv' ? 'Web Series' : 'Movie';
  return truncate(title + (year ? ' (' + year + ')' : '') + ' — Watch ' + noun + ' Online HD', 70)
    + ' | ' + SITE_NAME;
}

// ══════════════════════════════════════════════════════════════════════
//  CATEGORY CATALOGUE
//  Each entry carries its own hand-written description so no two landing
//  pages compete with duplicate copy — duplicate descriptions are one of
//  the fastest ways to get a set of pages ignored by Google.
// ══════════════════════════════════════════════════════════════════════

const CATEGORIES = {
  // ── Movie families → /movies/:slug ──────────────────────────────────
  trending: {
    family: 'movies', kind: 'movie', heading: 'Trending Movies',
    endpoint: '/trending/movie/week',
    title: 'Trending Movies This Week — Watch Online Free in HD & 4K',
    description: 'The most talked-about movies on MovieZone right now, refreshed every week. Stream trending Bollywood, Hollywood and South Indian releases in HD and 4K with multi-language audio.',
    intro: 'This list tracks what people are actually watching this week — it is rebuilt from live popularity data, so a film that breaks out on Friday shows up here by the weekend. Expect a mix of new theatrical releases, streaming premieres and older titles that a trailer or a meme pushed back into circulation.'
  },
  'top-rated': {
    family: 'movies', kind: 'movie', heading: 'Top Rated Movies',
    endpoint: '/movie/top_rated',
    title: 'Top 250 Movies of All Time — Best Films Ranked (2026)',
    description: 'The highest rated movies ever made, ranked by audience score across hundreds of thousands of votes. Watch critically acclaimed classics and modern masterpieces online in HD and 4K.',
    intro: 'Every film here clears a high bar on both rating and vote count, which filters out the small-sample flukes that dominate raw score lists. If you want a guaranteed good watch rather than something merely new, start at the top of this page.'
  },
  popular: {
    family: 'movies', kind: 'movie', heading: 'Popular Movies',
    endpoint: '/movie/popular',
    title: 'Popular Movies Right Now — Stream Online Free in HD & 4K',
    description: 'The most popular movies people are streaming today across every language and genre. Watch popular Hindi, English, Tamil and Telugu films online in HD and 4K quality on MovieZone.',
    intro: 'Popularity blends viewing volume, search interest and recency, so this page sits between "trending" and "top rated" — broader than the weekly spike list, less demanding than the all-time rankings.'
  },
  'now-playing': {
    family: 'movies', kind: 'movie', heading: 'Movies In Cinemas Now',
    endpoint: '/movie/now_playing',
    title: 'Movies In Cinemas Now — Latest Theatrical Releases in HD',
    description: 'Every movie currently running in theatres, updated daily. Track new theatrical releases, check ratings and runtimes, and stream them in HD and 4K as soon as they land online.',
    intro: 'These titles are in their theatrical window right now. Ratings on brand-new releases move a lot in the first two weeks as the vote count grows, so treat an early score as provisional.'
  },
  upcoming: {
    family: 'movies', kind: 'movie', heading: 'Upcoming Movies',
    endpoint: '/movie/upcoming',
    title: 'Upcoming Movies 2026 — Release Dates & Trailers',
    description: 'Every confirmed upcoming movie release with dates, posters and synopses. Track anticipated Bollywood and Hollywood releases and get notified the moment they are available to stream.',
    intro: 'Release dates shift constantly, especially for big-budget films — this page reads from live studio data rather than a static list, so a delay is reflected here as soon as it is announced.'
  },
  hollywood: {
    family: 'movies', kind: 'movie', heading: 'Hollywood Movies',
    endpoint: '/discover/movie', params: { with_original_language: 'en', sort_by: 'popularity.desc' },
    title: 'Hollywood Movies — Watch English Films Online Free in HD & 4K',
    description: 'Stream the biggest Hollywood movies online in HD and 4K, from current blockbusters to award-winning drama. English originals with Hindi dubbed audio and subtitle options available.',
    intro: 'English-language releases sorted by current popularity. Most titles here offer a Hindi dubbed track as well as the original audio, selectable from the player once you open a film.'
  },
  bollywood: {
    family: 'movies', kind: 'movie', heading: 'Bollywood Movies',
    endpoint: '/discover/movie', params: { with_original_language: 'hi', sort_by: 'popularity.desc' },
    title: 'Bollywood Movies — Watch Hindi Films Online Free in HD & 4K',
    description: 'Watch the latest Bollywood movies online in HD and 4K. Stream new Hindi releases, evergreen classics and the biggest box office hits, all with original Hindi audio.',
    intro: 'Hindi-language cinema sorted by what is popular today. New Bollywood releases usually appear within days of their theatrical run ending, and the catalogue reaches back through decades of classics.'
  },
  south: {
    family: 'movies', kind: 'movie', heading: 'South Indian Movies',
    endpoint: '/discover/movie', params: { with_original_language: 'ta', sort_by: 'popularity.desc' },
    title: 'South Indian Movies — Watch Tamil Films Online in HD & 4K',
    description: 'Stream Tamil cinema online in HD and 4K, from mass-market blockbusters to acclaimed independent film. Watch South Indian movies with original audio or Hindi dubbed tracks.',
    intro: 'Tamil-language releases ranked by current popularity. Pan-Indian productions are increasingly released in Tamil, Telugu and Hindi simultaneously, so many of these films also appear on the Tollywood and Bollywood pages.'
  },
  tollywood: {
    family: 'movies', kind: 'movie', heading: 'Tollywood Movies',
    endpoint: '/discover/movie', params: { with_original_language: 'te', sort_by: 'popularity.desc' },
    title: 'Tollywood Movies — Watch Telugu Films Online in HD & 4K',
    description: 'Watch Telugu movies online in HD and 4K quality. Stream the newest Tollywood releases, blockbuster franchises and classic Telugu cinema with original or Hindi dubbed audio.',
    intro: 'Telugu-language cinema sorted by popularity. Telugu productions now regularly top the all-India box office, and the biggest of them are released with Hindi and Tamil audio on the same day.'
  },
  action: {
    family: 'movies', kind: 'movie', heading: 'Action Movies',
    endpoint: '/discover/movie', params: { with_genres: '28', sort_by: 'popularity.desc' },
    title: 'Action Movies — Watch Best Action Films Online in HD & 4K',
    description: 'Stream the best action movies online in HD and 4K — spy thrillers, martial arts, heist films and large-scale war epics across Hindi, English, Tamil and Telugu cinema.',
    intro: 'Action is the single largest genre on MovieZone, which means this page rewards filtering. Sort by rating if you want craft over spectacle; the popularity default surfaces whatever released most recently.'
  },
  comedy: {
    family: 'movies', kind: 'movie', heading: 'Comedy Movies',
    endpoint: '/discover/movie', params: { with_genres: '35', sort_by: 'popularity.desc' },
    title: 'Comedy Movies — Watch Funny Films Online Free in HD & 4K',
    description: 'Watch comedy movies online in HD and 4K. Stream Hindi comedy classics, Hollywood laugh-out-loud hits, satire and family-friendly funny films with multi-language audio.',
    intro: 'Comedy travels less well across languages than action does, so the dubbed track is not always the better watch here — if a film is originally Hindi or Tamil, the original audio usually lands the jokes properly.'
  },
  horror: {
    family: 'movies', kind: 'movie', heading: 'Horror Movies',
    endpoint: '/discover/movie', params: { with_genres: '27', sort_by: 'popularity.desc' },
    title: 'Horror Movies — Watch Scary Films Online Free in HD & 4K',
    description: 'Stream horror movies online in HD and 4K — supernatural hauntings, slashers, psychological horror and Hindi horror-comedy. Watch the scariest films with lights off.',
    intro: 'Horror rewards a good picture more than most genres, because so much of the frame is deliberately underlit — the 4K option is worth choosing here if your connection can carry it.'
  },
  thriller: {
    family: 'movies', kind: 'movie', heading: 'Thriller Movies',
    endpoint: '/discover/movie', params: { with_genres: '53', sort_by: 'popularity.desc' },
    title: 'Thriller Movies — Watch Suspense Films Online in HD & 4K',
    description: 'Watch thriller movies online in HD and 4K. Stream crime thrillers, psychological suspense, courtroom drama and edge-of-the-seat mystery films across every major language.',
    intro: 'Thriller overlaps heavily with crime and mystery, so if a title you expected is missing from this page it is worth checking the Crime category as well — TMDB assigns primary genres, not every applicable one.'
  },
  romance: {
    family: 'movies', kind: 'movie', heading: 'Romance Movies',
    endpoint: '/discover/movie', params: { with_genres: '10749', sort_by: 'popularity.desc' },
    title: 'Romance Movies — Watch Romantic Films Online in HD & 4K',
    description: 'Stream romance movies online in HD and 4K. Watch Bollywood love stories, Hollywood romantic comedy, Korean romance and timeless romantic classics with subtitles.',
    intro: 'Bollywood and Korean productions dominate the upper half of this list, which reflects genuine viewing patterns rather than any editorial choice on our side.'
  },
  scifi: {
    family: 'movies', kind: 'movie', heading: 'Sci-Fi Movies',
    endpoint: '/discover/movie', params: { with_genres: '878', sort_by: 'popularity.desc' },
    title: 'Sci-Fi Movies — Watch Science Fiction Films Online in 4K',
    description: 'Watch science fiction movies online in HD and 4K — space opera, time travel, dystopian futures, alien contact and hard sci-fi. Stream the best sci-fi films with 4K picture.',
    intro: 'Science fiction and fantasy get separate genre ids on TMDB even though the shelves blur in practice, so browse the Fantasy page too if nothing here appeals.'
  },
  adventure: {
    family: 'movies', kind: 'movie', heading: 'Adventure Movies',
    endpoint: '/discover/movie', params: { with_genres: '12', sort_by: 'popularity.desc' },
    title: 'Adventure Movies — Watch Best Adventure Films in HD & 4K',
    description: 'Stream adventure movies online in HD and 4K. Watch treasure hunts, survival epics, jungle expeditions and globe-trotting quests suitable for the whole family.',
    intro: 'Adventure is the most family-safe of the big-scale genres, and almost every title here is paired with an Action or Fantasy tag as well.'
  },
  fantasy: {
    family: 'movies', kind: 'movie', heading: 'Fantasy Movies',
    endpoint: '/discover/movie', params: { with_genres: '14', sort_by: 'popularity.desc' },
    title: 'Fantasy Movies — Watch Magic & Mythology Films in HD & 4K',
    description: 'Watch fantasy movies online in HD and 4K — wizards, mythology, sword-and-sorcery epics and modern urban fantasy. Stream complete fantasy franchises in one place.',
    intro: 'Long-running fantasy franchises are easier to watch in order from the Cinematic Universes hub, which groups every entry in a series by release and in-story chronology.'
  },
  crime: {
    family: 'movies', kind: 'movie', heading: 'Crime Movies',
    endpoint: '/discover/movie', params: { with_genres: '80', sort_by: 'popularity.desc' },
    title: 'Crime Movies — Watch Gangster & Heist Films Online in HD',
    description: 'Stream crime movies online in HD and 4K. Watch gangster sagas, heist thrillers, police procedurals and true-crime dramas across Hindi, English and regional cinema.',
    intro: 'Indian crime cinema is unusually strong in this category — several of the highest rated Hindi films of the last decade sit in this genre rather than in drama.'
  },
  documentary: {
    family: 'movies', kind: 'movie', heading: 'Documentary Films',
    endpoint: '/discover/movie', params: { with_genres: '99', sort_by: 'popularity.desc' },
    title: 'Documentaries — Watch Documentary Films Online in HD',
    description: 'Watch documentaries online in HD — true crime investigations, nature and wildlife films, sports documentaries, music profiles and historical retrospectives.',
    intro: 'Documentary vote counts run far lower than fiction, so ratings on this page are noisier. A 9.0 backed by 200 votes is a much weaker signal than a 7.5 backed by 20,000.'
  },
  family: {
    family: 'movies', kind: 'movie', heading: 'Family Movies',
    endpoint: '/discover/movie', params: { with_genres: '10751', sort_by: 'popularity.desc' },
    title: 'Family Movies — Watch Kids & Family Films Online in HD',
    description: 'Stream family movies online in HD and 4K. Watch animated features, live-action kids films and all-ages adventures that work for children and adults together.',
    intro: 'Everything on this page carries a family rating, which makes it the safest starting point for watching with children. Animation has its own page if you want the format rather than the audience.'
  },
  animation: {
    family: 'movies', kind: 'movie', heading: 'Animated Movies',
    endpoint: '/discover/movie', params: { with_genres: '16', sort_by: 'popularity.desc' },
    title: 'Animated Movies — Watch Animation Films Online in HD & 4K',
    description: 'Watch animated movies online in HD and 4K — Pixar and Disney features, DreamWorks comedies, Japanese anime films and Hindi dubbed animation for kids.',
    intro: 'This page covers animation as a format, so it spans everything from preschool titles to adult-oriented Japanese features. For Japanese animation specifically, the Anime page is the better entry point.'
  },
  '4k': {
    family: 'movies', kind: 'movie', heading: '4K Ultra HD Movies',
    endpoint: '/discover/movie',
    params: { sort_by: 'vote_average.desc', 'vote_count.gte': '2000', 'primary_release_date.gte': '2015-01-01' },
    title: '4K Ultra HD Movies — Watch in 2160p Ultra HD Quality',
    description: 'Watch movies in true 4K Ultra HD. A curated list of highly rated modern releases that hold up at 2160p, with HDR-grade picture and high-bitrate audio where available.',
    intro: 'A 4K stream only helps if the film was finished at that resolution, so this page is restricted to well-reviewed releases from 2015 onward where a genuine Ultra HD master exists.'
  },

  // ── Streaming platform catalogues ───────────────────────────────────
  // Filtered by TMDB watch provider for region IN. Provider ids are verified
  // against /watch/providers/movie?watch_region=IN — see the OTT table in
  // moviezone.js for why network ids cannot be used for these.
  netflix: {
    family: 'movies', kind: 'movie', heading: 'Netflix Movies',
    endpoint: '/discover/movie',
    params: { with_watch_providers: '8', watch_region: 'IN', sort_by: 'popularity.desc' },
    title: 'Netflix Movies in India (2026) — Full List & New Releases',
    description: 'Every movie streaming on Netflix India right now, sorted by popularity. Browse Netflix originals, Bollywood titles and Hollywood licences with ratings, runtimes and full synopses.',
    intro: 'This list is filtered by what Netflix actually carries in India, so it reflects the Indian catalogue rather than the US one — the two differ substantially on licensed films.'
  },
  'prime-video': {
    family: 'movies', kind: 'movie', heading: 'Amazon Prime Video Movies',
    endpoint: '/discover/movie',
    params: { with_watch_providers: '119', watch_region: 'IN', sort_by: 'popularity.desc' },
    title: 'Amazon Prime Video Movies in India (2026) — Full List, New Releases & Top Picks',
    description: 'The complete movie catalogue on Amazon Prime Video India, ranked by popularity. Find Prime originals, regional Indian cinema and international films with ratings and details.',
    intro: 'Prime carries the deepest regional Indian film library of the major platforms, so this page runs long on Tamil, Telugu and Malayalam titles alongside the Hindi and English ones.'
  },
  jiohotstar: {
    family: 'movies', kind: 'movie', heading: 'JioHotstar Movies',
    endpoint: '/discover/movie',
    params: { with_watch_providers: '2336', watch_region: 'IN', sort_by: 'popularity.desc' },
    title: 'JioHotstar Movies List (2026) — New Releases & Full India Catalogue',
    description: 'Movies streaming on JioHotstar in India, sorted by popularity. Browse Disney and HBO licensed films, Hindi releases and regional cinema with ratings, cast and synopses.',
    intro: 'JioHotstar is the merged Disney+ Hotstar and JioCinema service, which is why its catalogue mixes Disney, HBO and Star studio output with a large Indian film library.'
  },
  zee5: {
    family: 'movies', kind: 'movie', heading: 'Zee5 Movies',
    endpoint: '/discover/movie',
    params: { with_watch_providers: '232', watch_region: 'IN', sort_by: 'popularity.desc' },
    title: 'Zee5 Movies — Full List, Watch Zee5 Films Online in HD',
    description: 'Every movie on Zee5 India, ranked by popularity. Browse Zee Studios releases, Hindi, Marathi, Bengali, Tamil and Telugu films with ratings, runtimes and full details.',
    intro: 'Zee5 is the strongest of the major platforms for regional-language cinema outside the big four industries, particularly Marathi, Bengali, Gujarati and Punjabi film.'
  },

  // ── Series families → /series/:slug ─────────────────────────────────
  'web-series': {
    family: 'series', kind: 'tv', heading: 'Web Series',
    endpoint: '/discover/tv', params: { sort_by: 'popularity.desc' },
    title: 'Web Series — Watch Latest Web Series Online Free in HD & 4K',
    description: 'Watch the latest web series online in HD and 4K. Stream complete seasons of Hindi, English and Korean shows with episode-by-episode playback and multi-language audio.',
    intro: 'Series pages give you a season and episode selector once opened, and MovieZone remembers where you stopped so the next visit resumes from the right episode.'
  },
  'top-rated-series': {
    family: 'series', kind: 'tv', heading: 'Top Rated Series',
    endpoint: '/tv/top_rated',
    title: 'Top Rated Web Series of All Time — Watch Online in HD',
    description: 'The highest rated television and web series ever made, ranked by audience score. Stream award-winning drama, comedy and limited series online in HD and 4K.',
    intro: 'Long-running shows have an advantage in these rankings because their scores are averaged across a large, self-selected audience. Limited series that hold a high score are usually the safer bet.'
  },
  'trending-series': {
    family: 'series', kind: 'tv', heading: 'Trending Series',
    endpoint: '/trending/tv/week',
    title: 'Trending Web Series This Week — Watch Online in HD & 4K',
    description: 'The web series everyone is watching this week, refreshed continuously. Stream trending Hindi, English and Korean shows online in HD and 4K on MovieZone.',
    intro: 'Weekly momentum rather than all-time quality drives this page, so a mid-season episode drop or a finale can push a show to the top overnight.'
  },
  anime: {
    family: 'series', kind: 'tv', heading: 'Anime',
    endpoint: '/discover/tv',
    params: { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc' },
    title: 'Anime — Watch Anime Series Online Free with Hindi Dub & Sub',
    description: 'Watch anime online in HD with Hindi dubbed, English dubbed and subtitled audio. Stream shounen, isekai, slice-of-life and seasonal simulcast anime series episode by episode.',
    intro: 'Anime titles route to a dedicated anime player with separate sub, English dub and Hindi dub tracks, and season numbering follows the streaming convention rather than the manga arc.'
  },
  kdrama: {
    family: 'series', kind: 'tv', heading: 'Korean Drama',
    endpoint: '/discover/tv',
    params: { with_original_language: 'ko', sort_by: 'popularity.desc' },
    title: 'Korean Drama — Watch K-Drama Online Free with Hindi Sub',
    description: 'Stream Korean dramas online in HD with Hindi and English subtitles. Watch romance, thriller and historical K-drama series with complete season playback.',
    intro: 'Most K-dramas run a single self-contained season of 12 to 20 episodes, so you can start almost anywhere on this page without needing prior context.'
  },
  kids: {
    family: 'series', kind: 'tv', heading: 'Cartoons',
    endpoint: '/discover/tv',
    params: { with_genres: '16,10762', sort_by: 'popularity.desc' },
    title: 'Cartoons — Watch Cartoon Series Online Free in HD',
    description: 'Watch cartoons online in HD with Hindi dubbed audio. Stream animated cartoon series for children with episode selection and safe, all-ages content.',
    intro: 'Every title here carries both the Animation and Kids classification, so live-action children\'s serials never appear on this page. Hindi dubbed audio is available for most of the long-running cartoon series.'
  },
  'zee5-series': {
    family: 'series', kind: 'tv', heading: 'Zee5 Web Series',
    endpoint: '/discover/tv',
    params: { with_watch_providers: '232', watch_region: 'IN', sort_by: 'popularity.desc' },
    title: 'Zee5 Web Series — Watch Zee5 Originals Online in HD',
    description: 'All web series streaming on Zee5 India, ranked by popularity. Watch Zee5 originals and serials in Hindi, Marathi, Bengali, Tamil and Telugu with complete season playback.',
    intro: 'Zee5 mixes short-run originals with very long-running daily serials, so sorting matters here — the originals sit near the top while the serials dominate by sheer episode count.'
  },
  'jiohotstar-series': {
    family: 'series', kind: 'tv', heading: 'JioHotstar Web Series',
    endpoint: '/discover/tv',
    params: { with_watch_providers: '2336', watch_region: 'IN', sort_by: 'popularity.desc' },
    title: 'JioHotstar Web Series — Watch Shows Online in HD & 4K',
    description: 'Web series and shows streaming on JioHotstar India. Watch HBO series, Disney originals, Hotstar Specials and Indian shows with season and episode selection in HD.',
    intro: 'This is where the HBO catalogue lives in India, alongside Hotstar Specials and the Star network back catalogue, so the range runs from prestige drama to daily programming.'
  },
  'netflix-series': {
    family: 'series', kind: 'tv', heading: 'Netflix Series',
    endpoint: '/discover/tv',
    params: { with_watch_providers: '8', watch_region: 'IN', sort_by: 'popularity.desc' },
    title: 'Netflix Series India — Full List, Watch Online in HD & 4K',
    description: 'Every series streaming on Netflix India, sorted by popularity. Browse Netflix originals, Korean drama, anime and licensed international shows with ratings and episode counts.',
    intro: 'Netflix India carries a large share of its global originals slate, so this list overlaps heavily with the international catalogue — the licensed third-party shows are where it differs.'
  }
};

const MOVIE_CATEGORY_SLUGS = Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].family === 'movies');
const SERIES_CATEGORY_SLUGS = Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].family === 'series');

function categoryPath(slug) {
  const cat = CATEGORIES[slug];
  if (!cat) return null;
  return '/' + cat.family + '/' + slug;
}

// ══════════════════════════════════════════════════════════════════════
//  SHARED PAGE SHELL
//  Styles are inlined deliberately: these pages are landing surfaces that
//  must paint fast on a cold cache, and the SPA stylesheet is ~230 KB of
//  rules built for a completely different DOM.
// ══════════════════════════════════════════════════════════════════════

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#03030a;color:#f2f2f5;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6}
a{color:#f5c518;text-decoration:none}
a:hover,a:focus-visible{text-decoration:underline}
img{max-width:100%;display:block}
.wrap{max-width:1140px;margin:0 auto;padding:0 20px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:12px;top:12px;z-index:100;background:#f5c518;color:#000;padding:10px 16px;border-radius:8px}
header.bar{border-bottom:1px solid rgba(255,255,255,.09);background:rgba(5,5,12,.96);position:sticky;top:0;z-index:20}
header.bar .wrap{display:flex;align-items:center;gap:16px;height:62px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.5px;color:#fff}
.brand span{color:#f5c518}
nav.top{margin-left:auto;display:flex;gap:18px;flex-wrap:wrap}
nav.top a{color:rgba(255,255,255,.72);font-size:.9rem;font-weight:600}
nav.top a:hover{color:#f5c518}
.crumbs{font-size:.82rem;color:rgba(255,255,255,.5);padding:18px 0 0}
.crumbs ol{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0}
.crumbs li::after{content:'/';margin-left:8px;color:rgba(255,255,255,.25)}
.crumbs li:last-child::after{content:''}
.hero{position:relative;border-radius:18px;overflow:hidden;margin:20px 0 0;background:#0b0b16}
.hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.32;filter:saturate(1.05)}
.hero-veil{position:absolute;inset:0;background:linear-gradient(105deg,rgba(3,3,10,.96) 12%,rgba(3,3,10,.72) 52%,rgba(3,3,10,.42) 100%)}
.hero-in{position:relative;display:flex;gap:28px;padding:30px;flex-wrap:wrap}
.poster{width:214px;flex:0 0 214px;border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.6);background:#14141f}
.hero-copy{flex:1 1 380px;min-width:280px}
h1{font-size:clamp(1.6rem,4vw,2.5rem);line-height:1.15;margin:0 0 6px;color:#fff}
.tagline{color:#f5c518;font-style:italic;margin:0 0 14px;font-size:.98rem}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;padding:0;list-style:none}
.facts li{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);border-radius:999px;padding:5px 13px;font-size:.82rem;font-weight:600}
.facts li.rate{background:rgba(245,197,24,.15);border-color:rgba(245,197,24,.4);color:#f5c518}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:0;list-style:none}
.chips a{background:rgba(124,58,237,.16);border:1px solid rgba(124,58,237,.36);border-radius:8px;padding:5px 12px;font-size:.82rem;color:#c9b6ff;font-weight:600}
.synopsis{color:rgba(255,255,255,.82);margin:0 0 20px;max-width:62ch}
.cta{display:inline-flex;align-items:center;gap:9px;background:linear-gradient(135deg,#f5c518,#e6a817);color:#08080f;font-weight:800;padding:13px 26px;border-radius:12px;font-size:1rem;box-shadow:0 10px 26px rgba(245,197,24,.28)}
.cta:hover{text-decoration:none;filter:brightness(1.07)}
.cta-note{display:block;margin-top:10px;font-size:.8rem;color:rgba(255,255,255,.45)}
section{margin:44px 0}
h2{font-size:1.32rem;margin:0 0 6px;color:#fff}
h3{font-size:1.04rem;margin:0 0 8px;color:#fff}
.lede{color:rgba(255,255,255,.66);margin:0 0 20px;max-width:78ch}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:18px;padding:0;margin:0;list-style:none}
.card{background:#0c0c17;border:1px solid rgba(255,255,255,.08);border-radius:13px;overflow:hidden;height:100%;display:flex;flex-direction:column}
.card:hover{border-color:rgba(245,197,24,.42)}
.card a.thumb{display:block;position:relative;aspect-ratio:2/3;background:#14141f}
.card a.thumb img{width:100%;height:100%;object-fit:cover}
.card-b{padding:11px 12px 13px}
.card-t{font-size:.9rem;font-weight:700;margin:0 0 5px;color:#fff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-t a{color:#fff}
.card-m{font-size:.76rem;color:rgba(255,255,255,.52);display:flex;gap:9px;flex-wrap:wrap}
.card-m .r{color:#f5c518;font-weight:700}
.cast{display:grid;grid-template-columns:repeat(auto-fill,minmax(122px,1fr));gap:16px;padding:0;margin:0;list-style:none}
.cast li{background:#0c0c17;border:1px solid rgba(255,255,255,.08);border-radius:11px;overflow:hidden}
.cast img{aspect-ratio:2/3;object-fit:cover;width:100%;background:#14141f}
.cast .nm{padding:9px 10px;font-size:.82rem;font-weight:700;color:#fff}
.cast .ch{padding:0 10px 10px;font-size:.74rem;color:rgba(255,255,255,.5)}
.facts-table{width:100%;border-collapse:collapse;font-size:.9rem}
.facts-table th,.facts-table td{text-align:left;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.07);vertical-align:top}
.facts-table th{width:190px;color:rgba(255,255,255,.55);font-weight:600}
.pill-links{display:flex;flex-wrap:wrap;gap:10px;padding:0;margin:0;list-style:none}
.pill-links a{display:inline-block;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:8px 16px;font-size:.86rem;font-weight:600;color:rgba(255,255,255,.82)}
.pill-links a:hover{border-color:rgba(245,197,24,.5);color:#f5c518;text-decoration:none}
.pager{display:flex;gap:12px;align-items:center;margin-top:26px;flex-wrap:wrap}
.pager a{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:10px 18px;font-weight:700;font-size:.88rem}
.pager span{color:rgba(255,255,255,.45);font-size:.86rem}
footer.foot{border-top:1px solid rgba(255,255,255,.09);margin-top:56px;padding:30px 0 40px;color:rgba(255,255,255,.5);font-size:.86rem}
footer.foot h3{font-size:.74rem;letter-spacing:1.4px;text-transform:uppercase;color:rgba(255,255,255,.42);margin:0 0 12px}
.foot-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:28px;margin-bottom:26px}
.foot-cols ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.foot-cols a{color:rgba(255,255,255,.66);font-size:.87rem}
.empty{background:#0c0c17;border:1px solid rgba(255,255,255,.09);border-radius:13px;padding:34px;text-align:center;color:rgba(255,255,255,.6)}
.pager-cur{background:rgba(245,197,24,.16);border:1px solid rgba(245,197,24,.42);border-radius:10px;padding:10px 16px;font-weight:800;color:#f5c518}
.pager-gap{padding:0 2px;color:rgba(255,255,255,.3)}
.faq dt{font-weight:700;color:#fff;margin:18px 0 6px;font-size:.98rem}
.faq dd{margin:0;color:rgba(255,255,255,.7);max-width:78ch}
.cta-sec{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:10px 20px;font-weight:700;font-size:.9rem}
.link-cols{columns:3 200px;column-gap:26px;padding:0;margin:0;list-style:none}
.link-cols li{break-inside:avoid;margin-bottom:9px}
.link-cols a{color:rgba(255,255,255,.78);font-size:.88rem}
.az{display:flex;flex-wrap:wrap;gap:7px;padding:0;margin:0;list-style:none}
.az a{display:inline-block;min-width:38px;text-align:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);border-radius:8px;padding:7px 10px;font-weight:700;font-size:.85rem;text-transform:uppercase;color:rgba(255,255,255,.8)}
.az a:hover{border-color:rgba(245,197,24,.5);color:#f5c518;text-decoration:none}
@media (max-width:640px){
  .hero-in{padding:20px;gap:18px}
  .poster{width:132px;flex:0 0 132px}
  .facts-table th{width:120px}
  nav.top{display:none}
}
`.replace(/\n\s*/g, '');

/** Header + breadcrumb + footer are identical on every SSR page. */
function renderShell(opts) {
  const {
    title, description, canonicalPath, ogImage, ogType = 'website',
    schemas = [], breadcrumbs = [], body, robots = 'index, follow, max-image-preview:large'
  } = opts;

  const canonical = SITE_URL + canonicalPath;
  const image = ogImage || LOGO_URL;

  const crumbHtml = breadcrumbs.length
    ? '<nav class="crumbs" aria-label="Breadcrumb"><ol>'
      + breadcrumbs.map((c, i) => {
        const isLast = i === breadcrumbs.length - 1;
        return '<li>' + (isLast || !c.path
          ? '<span aria-current="page">' + esc(c.name) + '</span>'
          : '<a href="' + esc(c.path) + '">' + esc(c.name) + '</a>') + '</li>';
      }).join('')
      + '</ol></nav>'
    : '';

  const breadcrumbSchema = breadcrumbs.length > 1 ? {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.path ? SITE_URL + c.path : undefined
    }))
  } : null;

  const allSchemas = (breadcrumbSchema ? [breadcrumbSchema] : []).concat(schemas).filter(Boolean);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#f5c518">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${esc(robots)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=2">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">
<link rel="manifest" href="/manifest.json">
<link rel="preconnect" href="https://image.tmdb.org" crossorigin>
<link rel="dns-prefetch" href="https://image.tmdb.org">
<style>${BASE_CSS}</style>
${allSchemas.map((s) => '<script type="application/ld+json">' + jsonLdScript(s) + '</script>').join('\n')}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar">
  <div class="wrap">
    <a class="brand" href="/"><img src="/moviezone-logo.webp" alt="MovieZone" width="30" height="30" style="border-radius:7px"> MOVIE<span>ZONE</span></a>
    <nav class="top" aria-label="Browse">
      <a href="/movies/trending">Trending</a>
      <a href="/movies/bollywood">Bollywood</a>
      <a href="/movies/hollywood">Hollywood</a>
      <a href="/series/web-series">Web Series</a>
      <a href="/series/anime">Anime</a>
      <a href="/movies/top-rated">Top Rated</a>
    </nav>
  </div>
</header>
<div class="wrap">${crumbHtml}</div>
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="wrap">
    <div class="foot-cols">
      <div>
        <h3>Movies by industry</h3>
        <ul>
          <li><a href="/movies/bollywood">Bollywood movies</a></li>
          <li><a href="/movies/hollywood">Hollywood movies</a></li>
          <li><a href="/movies/south">South Indian movies</a></li>
          <li><a href="/movies/tollywood">Tollywood movies</a></li>
        </ul>
      </div>
      <div>
        <h3>Movies by genre</h3>
        <ul>
          <li><a href="/movies/action">Action movies</a></li>
          <li><a href="/movies/comedy">Comedy movies</a></li>
          <li><a href="/movies/horror">Horror movies</a></li>
          <li><a href="/movies/thriller">Thriller movies</a></li>
          <li><a href="/movies/romance">Romance movies</a></li>
          <li><a href="/movies/scifi">Sci-Fi movies</a></li>
        </ul>
      </div>
      <div>
        <h3>Series &amp; shows</h3>
        <ul>
          <li><a href="/series/web-series">Web series</a></li>
          <li><a href="/series/anime">Anime</a></li>
          <li><a href="/series/kdrama">Korean drama</a></li>
          <li><a href="/series/kids">Cartoons</a></li>
        </ul>
      </div>
      <div>
        <h3>By platform</h3>
        <ul>
          <li><a href="/movies/netflix">Netflix movies</a></li>
          <li><a href="/movies/prime-video">Prime Video movies</a></li>
          <li><a href="/movies/jiohotstar">JioHotstar movies</a></li>
          <li><a href="/movies/zee5">Zee5 movies</a></li>
          <li><a href="/series/zee5-series">Zee5 web series</a></li>
          <li><a href="/series/jiohotstar-series">JioHotstar shows</a></li>
        </ul>
      </div>
      <div>
        <h3>Discover</h3>
        <ul>
          <li><a href="/movies/trending">Trending this week</a></li>
          <li><a href="/movies/top-rated">Top rated of all time</a></li>
          <li><a href="/movies/4k">4K Ultra HD</a></li>
          <li><a href="/movies/upcoming">Upcoming releases</a></li>
          <li><a href="/browse">Browse every title A-Z</a></li>
        </ul>
      </div>
    </div>
    <nav aria-label="All categories" style="margin:0 0 22px">
      <h3>All categories</h3>
      <ul class="link-cols">
        ${MOVIE_CATEGORY_SLUGS.concat(SERIES_CATEGORY_SLUGS)
    .map((s) => '<li><a href="' + esc(categoryPath(s)) + '">' + esc(CATEGORIES[s].heading) + '</a></li>')
    .join('')}
      </ul>
    </nav>
    <p>&copy; 2025-2026 ${esc(SITE_NAME)}. All rights reserved.</p>
    <!-- Attribution notice required verbatim by the TMDB API Terms of Use.
         Do not reword: TMDB specifies this exact sentence. -->
    <p>This product uses the
      <a href="https://www.themoviedb.org/" rel="noopener noreferrer nofollow" target="_blank">TMDb API</a>
      but is not endorsed or certified by TMDb.</p>
  </div>
</footer>
</body>
</html>`;
}

/**
 * Decide whether a list item is a movie or a series.
 * Precedence matters. An explicit media_type is authoritative; failing that,
 * the item's own field shape wins over the calling page's default, because
 * mixed endpoints (/trending/all, recommendations) return both kinds and a
 * TV item linked as /movie/<id> would 404 or redirect to the wrong title.
 */
function resolveKind(item, kindHint) {
  if (!item) return kindHint || 'movie';
  if (item.media_type === 'tv' || item.media_type === 'movie') return item.media_type;
  if (item.first_air_date && !item.release_date) return 'tv';
  if (item.release_date && !item.first_air_date) return 'movie';
  if (item.name && !item.title) return 'tv';
  return kindHint || 'movie';
}

/** One poster card. Used by category grids and "similar titles" rails. */
function renderCard(item, kindHint) {
  const kind = resolveKind(item, kindHint);

  const title = titleOf(item);
  if (!title) return '';
  const href = detailPath(kind, item);
  const year = yearOf(item);
  const rating = ratingOf(item);
  const poster = item.poster_path
    ? IMG_POSTER + item.poster_path
    : null;

  return '<li class="card">'
    + '<a class="thumb" href="' + esc(href) + '" aria-label="' + esc(title + (year ? ' (' + year + ')' : '')) + '">'
    + (poster
      ? '<img src="' + esc(poster) + '" alt="' + esc(title + ' poster') + '" width="342" height="513" loading="lazy" decoding="async">'
      : '<span style="display:flex;align-items:center;justify-content:center;height:100%;color:#3a3a52;font-weight:800">MZ</span>')
    + '</a>'
    + '<div class="card-b">'
    + '<p class="card-t"><a href="' + esc(href) + '">' + esc(title) + '</a></p>'
    + '<p class="card-m">'
    + (rating ? '<span class="r">★ ' + esc(rating) + '</span>' : '')
    + (year ? '<span>' + esc(year) + '</span>' : '')
    + '<span>' + esc(kind === 'tv' ? 'Series' : 'Movie') + '</span>'
    + '</p></div></li>';
}

// ══════════════════════════════════════════════════════════════════════
//  DETAIL PAGE
// ══════════════════════════════════════════════════════════════════════

/**
 * India streaming availability from TMDB's watch/providers payload.
 * This is the block that makes a detail page answer a real query
 * ("where can I watch X in India") instead of restating the TMDB overview
 * that a few hundred other sites already publish verbatim.
 */
function watchProvidersIN(item) {
  const box = item && item['watch/providers'] && item['watch/providers'].results;
  const region = box && (box.IN || box.US);
  if (!region) return null;
  const pick = (list) => [...new Set((list || []).map((p) => p && p.provider_name).filter(Boolean))];
  const out = {
    region: box && box.IN ? 'India' : 'the US',
    stream: pick(region.flatrate),
    rent: pick(region.rent),
    buy: pick(region.buy),
    free: pick(region.ads).concat(pick(region.free))
  };
  return (out.stream.length || out.rent.length || out.buy.length || out.free.length) ? out : null;
}

/** Official trailer key, if TMDB has one. Linked, not embedded — keeps LCP low. */
function trailerOf(item) {
  const vids = (item && item.videos && item.videos.results) || [];
  const yt = vids.filter((v) => v && v.site === 'YouTube' && v.key);
  const best = yt.find((v) => v.type === 'Trailer' && v.official)
    || yt.find((v) => v.type === 'Trailer')
    || yt.find((v) => v.type === 'Teaser');
  return best ? { key: best.key, name: best.name || 'Official trailer' } : null;
}

/** India certification (U / UA / A) from release_dates or content_ratings. */
function certificationIN(item, isTv) {
  if (isTv) {
    const rows = (item.content_ratings && item.content_ratings.results) || [];
    const row = rows.find((r) => r && r.iso_3166_1 === 'IN');
    return (row && row.rating) || '';
  }
  const rows = (item.release_dates && item.release_dates.results) || [];
  const row = rows.find((r) => r && r.iso_3166_1 === 'IN');
  const entry = ((row && row.release_dates) || []).find((d) => d && d.certification);
  return (entry && entry.certification) || '';
}

/** Dubbed/original audio, phrased for the query it answers. */
function audioLanguages(item) {
  return (item.spoken_languages || [])
    .map((l) => l && (l.english_name || l.name))
    .filter(Boolean);
}

/**
 * Page-specific Q&A. Every answer is built from this title's own data, so the
 * block is unique per page rather than boilerplate — and it is FAQPage-eligible.
 */
function buildFaq(item, kind, providers, langNames, cert, runtimeMins) {
  const title = titleOf(item);
  const year = yearOf(item);
  const isTv = kind === 'tv';
  const label = title + (year ? ' (' + year + ')' : '');
  const faq = [];

  if (providers) {
    const parts = [];
    if (providers.stream.length) parts.push('included with a subscription on ' + providers.stream.join(', '));
    if (providers.free.length) parts.push('free with ads on ' + providers.free.join(', '));
    if (providers.rent.length) parts.push('available to rent on ' + providers.rent.join(', '));
    if (providers.buy.length) parts.push('available to buy on ' + providers.buy.join(', '));
    faq.push({
      q: 'Where can I watch ' + label + ' in ' + providers.region + '?',
      a: label + ' is ' + parts.join('; ') + '. Availability is checked against live streaming data and can change when a licensing window ends.'
    });
  } else {
    faq.push({
      q: 'Where can I watch ' + label + '?',
      a: 'No Indian streaming licence is listed for ' + label + ' right now. This page updates automatically when a platform picks it up, so it is worth re-checking after a new release window opens.'
    });
  }

  if (langNames.length) {
    faq.push({
      q: 'Is ' + title + ' available in Hindi?',
      a: langNames.indexOf('Hindi') >= 0
        ? 'Yes — ' + title + ' has a Hindi audio track alongside ' + (langNames.filter((l) => l !== 'Hindi').join(', ') || 'the original audio') + '.'
        : title + ' is listed with ' + langNames.join(', ') + ' audio. A Hindi dub is not part of the official language list for this title.'
    });
  }

  if (!isTv && runtimeMins) {
    faq.push({
      q: 'How long is ' + title + '?',
      a: title + ' runs for ' + runtimeLabel(runtimeMins) + '.'
    });
  }
  if (isTv && item.number_of_seasons) {
    faq.push({
      q: 'How many seasons does ' + title + ' have?',
      a: title + ' has ' + item.number_of_seasons + ' season' + (item.number_of_seasons > 1 ? 's' : '')
        + (item.number_of_episodes ? ' and ' + item.number_of_episodes + ' episodes in total' : '') + '.'
    });
  }
  if (cert) {
    faq.push({
      q: 'What is the age rating of ' + title + ' in India?',
      a: title + ' carries a ' + cert + ' certificate in India.'
    });
  }
  return faq.slice(0, 5);
}

function renderDetailPage(item, kind) {
  const title = titleOf(item);
  const year = yearOf(item);
  const rating = ratingOf(item);
  const votes = Number(item.vote_count) || 0;
  const genres = genreNamesOf(item);
  const canonicalPath = detailPath(kind, item);
  const description = buildDetailDescription(item, kind);
  const pageTitle = buildDetailTitle(item, kind);
  const isTv = kind === 'tv';

  const runtimeMins = isTv
    ? (Array.isArray(item.episode_run_time) && item.episode_run_time[0]) || 0
    : item.runtime || 0;

  const cast = ((item.credits && item.credits.cast) || []).slice(0, 12);
  const crew = (item.credits && item.credits.crew) || [];
  const directors = crew.filter((c) => c.job === 'Director').map((c) => c.name).filter(Boolean);
  const writers = crew
    .filter((c) => c.job === 'Screenplay' || c.job === 'Writer' || c.job === 'Story')
    .map((c) => c.name).filter(Boolean);
  const creators = (item.created_by || []).map((c) => c.name).filter(Boolean);

  // Similar + recommended titles are the internal-link engine: they give
  // Googlebot a path from any one detail page deeper into the catalogue.
  const relatedSeen = new Set([String(item.id)]);
  const related = []
    .concat((item.recommendations && item.recommendations.results) || [])
    .concat((item.similar && item.similar.results) || [])
    .filter((r) => {
      if (!r || !r.id || !r.poster_path || relatedSeen.has(String(r.id))) return false;
      relatedSeen.add(String(r.id));
      return true;
    })
    .slice(0, 12);

  const backdrop = item.backdrop_path ? IMG_BACKDROP + item.backdrop_path : '';
  const posterLg = item.poster_path ? IMG_POSTER_LG + item.poster_path : '';

  // ── facts row ──
  const facts = [];
  if (rating) facts.push('<li class="rate">★ ' + esc(rating) + '/10' + (votes ? ' <span style="opacity:.7;font-weight:500">(' + votes.toLocaleString('en-IN') + ' votes)</span>' : '') + '</li>');
  if (year) facts.push('<li>' + esc(year) + '</li>');
  if (runtimeMins) facts.push('<li>' + esc(runtimeLabel(runtimeMins)) + (isTv ? ' / episode' : '') + '</li>');
  if (isTv && item.number_of_seasons) {
    facts.push('<li>' + esc(item.number_of_seasons) + ' season' + (item.number_of_seasons > 1 ? 's' : '') + '</li>');
  }
  if (isTv && item.number_of_episodes) facts.push('<li>' + esc(item.number_of_episodes) + ' episodes</li>');
  const langName = languageName(item.original_language);
  if (langName) facts.push('<li>' + esc(langName) + '</li>');
  if (item.status && item.status !== 'Released') facts.push('<li>' + esc(item.status) + '</li>');

  // ── genre chips link to the matching category page (internal links) ──
  const genreSlugByName = {};
  Object.keys(CATEGORIES).forEach((slug) => {
    const c = CATEGORIES[slug];
    if (c.params && c.params.with_genres && !c.params.with_genres.includes(',')) {
      genreSlugByName[GENRE_NAMES[c.params.with_genres]] = slug;
    }
  });
  const genreChips = genres.map((g) => {
    const slug = genreSlugByName[g];
    return slug
      ? '<li><a href="' + esc(categoryPath(slug)) + '">' + esc(g) + '</a></li>'
      : '<li><a href="' + esc(isTv ? '/series/web-series' : '/movies/popular') + '">' + esc(g) + '</a></li>';
  }).join('');

  // ── specification table ──
  const rows = [];
  const pushRow = (label, value) => {
    if (value) rows.push('<tr><th scope="row">' + esc(label) + '</th><td>' + value + '</td></tr>');
  };
  pushRow(isTv ? 'Original title' : 'Original title', esc(item.original_title || item.original_name || ''));
  pushRow(isTv ? 'First aired' : 'Release date', esc(item.release_date || item.first_air_date || ''));
  if (isTv && item.last_air_date) pushRow('Last aired', esc(item.last_air_date));
  pushRow('Genre', esc(genres.join(', ')));
  if (directors.length) pushRow('Director', esc(directors.slice(0, 3).join(', ')));
  if (creators.length) pushRow('Created by', esc(creators.slice(0, 3).join(', ')));
  if (writers.length) pushRow('Writer', esc([...new Set(writers)].slice(0, 3).join(', ')));
  pushRow('Original language', esc(langName));
  if (Array.isArray(item.spoken_languages) && item.spoken_languages.length) {
    pushRow('Audio languages', esc(item.spoken_languages.map((l) => l.english_name || l.name).filter(Boolean).join(', ')));
  }
  if (Array.isArray(item.production_countries) && item.production_countries.length) {
    pushRow('Country', esc(item.production_countries.map((c) => c.name).join(', ')));
  }
  if (Array.isArray(item.production_companies) && item.production_companies.length) {
    pushRow('Production', esc(item.production_companies.slice(0, 4).map((c) => c.name).join(', ')));
  }
  if (Array.isArray(item.networks) && item.networks.length) {
    pushRow('Network', esc(item.networks.map((n) => n.name).join(', ')));
  }
  if (!isTv && item.budget > 0) pushRow('Budget', '$' + esc((item.budget / 1e6).toFixed(1)) + 'M');
  if (!isTv && item.revenue > 0) pushRow('Box office', '$' + esc((item.revenue / 1e6).toFixed(1)) + 'M');
  pushRow('Streaming quality', 'Up to 4K Ultra HD (2160p), 1080p, 720p and 480p');
  pushRow('India certification', esc(certificationIN(item, isTv)));

  // ── JSON-LD ──
  const schema = {
    '@context': 'https://schema.org',
    '@type': isTv ? 'TVSeries' : 'Movie',
    name: title,
    alternateName: item.original_title || item.original_name || undefined,
    url: SITE_URL + canonicalPath,
    description: String(item.overview || description).replace(/\s+/g, ' ').trim(),
    image: posterLg || undefined,
    datePublished: item.release_date || item.first_air_date || undefined,
    inLanguage: item.original_language || undefined,
    genre: genres.length ? genres : undefined,
    aggregateRating: votes > 0 && rating ? {
      '@type': 'AggregateRating',
      ratingValue: rating,
      bestRating: '10',
      worstRating: '1',
      ratingCount: votes
    } : undefined,
    actor: cast.slice(0, 8).map((c) => ({ '@type': 'Person', name: c.name })),
    director: directors.slice(0, 3).map((n) => ({ '@type': 'Person', name: n })),
    creator: creators.slice(0, 3).map((n) => ({ '@type': 'Person', name: n })),
    duration: !isTv ? isoDuration(runtimeMins) || undefined : undefined,
    numberOfSeasons: isTv ? item.number_of_seasons || undefined : undefined,
    numberOfEpisodes: isTv ? item.number_of_episodes || undefined : undefined,
    productionCompany: (item.production_companies || []).slice(0, 3)
      .map((c) => ({ '@type': 'Organization', name: c.name })),
    potentialAction: {
      '@type': 'WatchAction',
      target: SITE_URL + '/#watch-' + (isTv ? 'tv' : 'movie') + '-' + item.id
    }
  };

  const breadcrumbs = [
    { name: 'Home', path: '/' },
    isTv
      ? { name: 'Web Series', path: '/series/web-series' }
      : { name: 'Movies', path: '/movies/popular' },
    { name: title + (year ? ' (' + year + ')' : '') }
  ];

  const watchHref = '/#watch-' + (isTv ? 'tv' : 'movie') + '-' + item.id;

  // ── unique-value blocks ──
  const providers = watchProvidersIN(item);
  const trailer = trailerOf(item);
  const cert = certificationIN(item, isTv);
  const langNames = audioLanguages(item);
  const faq = buildFaq(item, kind, providers, langNames, cert, runtimeMins);

  const providerRow = (label, names) => (names && names.length)
    ? '<tr><th scope="row">' + esc(label) + '</th><td>' + esc(names.join(', ')) + '</td></tr>'
    : '';

  const whereToWatchHtml = providers ? `
  <section id="where-to-watch">
    <h2>Where to watch ${esc(title)} in ${esc(providers.region)}</h2>
    <p class="lede">${esc(
    title + ' is currently licensed to the platforms below in ' + providers.region
    + '. Streaming rights move between services, so this list is rebuilt from live availability data rather than hand-written.'
  )}</p>
    <table class="facts-table">
      <caption class="skip">Streaming availability for ${esc(title)}</caption>
      <tbody>
        ${providerRow('Stream with subscription', providers.stream)}
        ${providerRow('Watch free with ads', providers.free)}
        ${providerRow('Rent', providers.rent)}
        ${providerRow('Buy', providers.buy)}
      </tbody>
    </table>
  </section>` : '';

  const trailerHtml = trailer ? `
  <section id="trailer">
    <h2>${esc(title)} trailer</h2>
    <p class="lede">Watch the official trailer for ${esc(title)}${year ? ' (' + esc(year) + ')' : ''} before you start.</p>
    <p><a class="cta-sec" href="https://www.youtube.com/watch?v=${esc(trailer.key)}" rel="noopener nofollow" target="_blank">▶ ${esc(trailer.name)}</a></p>
  </section>` : '';

  const faqHtml = faq.length ? `
  <section id="faq">
    <h2>${esc(title)} — frequently asked questions</h2>
    <dl class="faq">
      ${faq.map((f) => '<dt>' + esc(f.q) + '</dt><dd>' + esc(f.a) + '</dd>').join('')}
    </dl>
  </section>` : '';

  const faqSchema = faq.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a }
    }))
  } : null;

  const body = `
<div class="wrap">
  <article class="hero">
    ${backdrop ? '<img class="hero-bg" src="' + esc(backdrop) + '" alt="" width="1280" height="720" fetchpriority="high" decoding="async">' : ''}
    <div class="hero-veil"></div>
    <div class="hero-in">
      ${posterLg
    ? '<img class="poster" src="' + esc(posterLg) + '" alt="' + esc(title + ' poster') + '" width="500" height="750" fetchpriority="high" decoding="async">'
    : ''}
      <div class="hero-copy">
        <h1>${esc(title)}${year ? ' <span style="font-weight:400;opacity:.6">(' + esc(year) + ')</span>' : ''}</h1>
        ${item.tagline ? '<p class="tagline">' + esc(item.tagline) + '</p>' : ''}
        ${facts.length ? '<ul class="facts">' + facts.join('') + '</ul>' : ''}
        ${genreChips ? '<ul class="chips">' + genreChips + '</ul>' : ''}
        <p class="synopsis">${esc(
    String(item.overview || '').trim()
      || (title + (year ? ' (' + year + ')' : '') + ' is a ' + (genres.join(', ') || (isTv ? 'television' : 'feature')) + ' '
        + (isTv ? 'series' : 'film') + (langName ? ' in ' + langName : '') + '. A full synopsis for this title is not yet available; '
        + 'the cast, crew and technical details below are complete.')
  )}</p>
        <a class="cta" href="${esc(watchHref)}">▶ Watch ${esc(isTv ? 'Series' : 'Movie')}</a>
        <span class="cta-note">Opens the MovieZone player. Choose audio language and quality after it loads.</span>
      </div>
    </div>
  </article>

  <section>
    <h2>About ${esc(title)}</h2>
    <p class="lede">${esc(buildAboutParagraph(item, kind, genres, langName, runtimeMins))}</p>
    <table class="facts-table">
      <caption class="skip">Technical and production details for ${esc(title)}</caption>
      <tbody>${rows.join('')}</tbody>
    </table>
  </section>

  ${whereToWatchHtml}

  ${trailerHtml}

  ${cast.length ? `<section>
    <h2>Cast &amp; characters</h2>
    <p class="lede">The principal cast of ${esc(title)}${directors.length ? ', directed by ' + esc(directors[0]) : ''}.</p>
    <ul class="cast">
      ${cast.map((c) => '<li>'
    + (c.profile_path
      ? '<img src="' + esc(IMG_PROFILE + c.profile_path) + '" alt="' + esc(c.name) + '" width="185" height="278" loading="lazy" decoding="async">'
      : '<div style="aspect-ratio:2/3;display:flex;align-items:center;justify-content:center;background:#14141f;color:#3a3a52;font-weight:800">' + esc((c.name || '?').slice(0, 1)) + '</div>')
    + '<p class="nm">' + esc(c.name) + '</p>'
    + (c.character ? '<p class="ch">as ' + esc(c.character) + '</p>' : '')
    + '</li>').join('')}
    </ul>
  </section>` : ''}

  ${related.length ? `<section>
    <h2>More like ${esc(title)}</h2>
    <p class="lede">Titles that share a genre, cast or tone with ${esc(title)} — each one opens its own page with full details.</p>
    <ul class="grid">${related.map((r) => renderCard(r, kind)).join('')}</ul>
  </section>` : ''}

  ${faqHtml}

  <section>
    <h2>Browse more on ${esc(SITE_NAME)}</h2>
    <ul class="pill-links">
      ${(isTv ? SERIES_CATEGORY_SLUGS : MOVIE_CATEGORY_SLUGS).slice(0, 14)
    .map((slug) => '<li><a href="' + esc(categoryPath(slug)) + '">' + esc(CATEGORIES[slug].heading) + '</a></li>').join('')}
    </ul>
  </section>
</div>`;

  return renderShell({
    title: pageTitle,
    description,
    canonicalPath,
    ogImage: posterLg || (backdrop || LOGO_URL),
    ogType: 'video.movie',
    schemas: faqSchema ? [schema, faqSchema] : [schema],
    breadcrumbs,
    body
  });
}

/**
 * A second, longer prose block. Detail pages that carry only a one-line
 * TMDB overview read as thin content; this states the facts already in the
 * payload as a sentence so each page has genuine, non-duplicated copy.
 */
function buildAboutParagraph(item, kind, genres, langName, runtimeMins) {
  const title = titleOf(item);
  const year = yearOf(item);
  const isTv = kind === 'tv';
  const rating = ratingOf(item);
  const votes = Number(item.vote_count) || 0;
  const bits = [];

  let opener = title + (year ? ', released in ' + year + ',' : '') + ' is a ';
  if (genres.length) opener += genres.slice(0, 3).join(' / ').toLowerCase() + ' ';
  opener += isTv ? 'series' : 'film';
  if (langName) opener += ' produced in ' + langName;
  opener += '.';
  bits.push(opener);

  if (isTv && item.number_of_seasons) {
    bits.push('It runs to ' + item.number_of_seasons + ' season' + (item.number_of_seasons > 1 ? 's' : '')
      + (item.number_of_episodes ? ' and ' + item.number_of_episodes + ' episodes' : '')
      + (runtimeMins ? ', with episodes around ' + runtimeMins + ' minutes long' : '') + '.');
  } else if (runtimeMins) {
    bits.push('The runtime is ' + runtimeLabel(runtimeMins) + '.');
  }

  if (rating && votes >= 50) {
    const verdict = Number(rating) >= 8 ? 'exceptionally well received'
      : Number(rating) >= 7 ? 'well received'
        : Number(rating) >= 6 ? 'received a mixed-to-positive response'
          : 'divided its audience';
    bits.push('It is ' + verdict + ', holding ' + rating + '/10 from '
      + votes.toLocaleString('en-IN') + ' audience votes.');
  }

  bits.push('On ' + SITE_NAME + ' you can stream it up to 4K Ultra HD, with Hindi, English, Tamil, Telugu, '
    + 'Malayalam and Kannada audio options where a dubbed track exists'
    + (isTv ? ', and a season and episode selector that remembers your position.' : '.'));

  return bits.join(' ');
}

// ══════════════════════════════════════════════════════════════════════
//  CATEGORY PAGE
// ══════════════════════════════════════════════════════════════════════

/** Page 1 has no ?page= param, so it never competes with its own canonical. */
function pageHref(basePath, page) {
  return page > 1 ? basePath + '?page=' + page : basePath;
}

function renderCategoryPage(slug, cat, results, page, totalPages) {
  const basePath = categoryPath(slug);
  const canonicalPath = page > 1 ? basePath + '?page=' + page : basePath;
  const isTv = cat.kind === 'tv';

  // Page 2+ gets its own description so paginated URLs are not duplicates.
  const description = page > 1
    ? truncate('Page ' + page + ' of ' + cat.heading.toLowerCase() + ' on ' + SITE_NAME + '. ' + cat.description, 158)
    : cat.description;
  const title = page > 1
    ? cat.heading + ' — Page ' + page + ' | ' + SITE_NAME
    : cat.title + ' | ' + SITE_NAME;

  const cards = results.map((r) => renderCard(r, cat.kind)).filter(Boolean).join('');

  const itemListSchema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: cat.heading,
    description: cat.description,
    numberOfItems: results.length,
    itemListElement: results.slice(0, 24).map((r, i) => ({
      '@type': 'ListItem',
      position: (page - 1) * 20 + i + 1,
      url: SITE_URL + detailPath(resolveKind(r, cat.kind), r),
      name: titleOf(r)
    })).filter((e) => e.name)
  };

  const collectionSchema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: cat.heading,
    description: cat.description,
    url: SITE_URL + canonicalPath,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL + '/' }
  };

  const siblings = (isTv ? SERIES_CATEGORY_SLUGS : MOVIE_CATEGORY_SLUGS).filter((s) => s !== slug);
  const crossFamily = isTv ? MOVIE_CATEGORY_SLUGS.slice(0, 8) : SERIES_CATEGORY_SLUGS.slice(0, 8);

  // A prev/next-only chain puts page 25 twenty-six clicks from the homepage,
  // which is past the depth Googlebot will follow on a low-authority site.
  // Emitting first/last, neighbours and every 5th page caps real depth at ~3.
  const pager = [];
  if (page > 1) {
    pager.push('<a href="' + esc(pageHref(basePath, page - 1)) + '" rel="prev">← Previous</a>');
  }

  const wanted = new Set([1, totalPages, page - 1, page, page + 1]);
  for (let p = 5; p <= totalPages; p += 5) wanted.add(p);
  const numbers = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let previous = 0;
  numbers.forEach((p) => {
    if (previous && p - previous > 1) pager.push('<span class="pager-gap">…</span>');
    pager.push(p === page
      ? '<span class="pager-cur" aria-current="page">' + p + '</span>'
      : '<a href="' + esc(pageHref(basePath, p)) + '" aria-label="Page ' + p + '">' + p + '</a>');
    previous = p;
  });

  if (page < totalPages) {
    pager.push('<a href="' + esc(pageHref(basePath, page + 1)) + '" rel="next">Next →</a>');
  }

  const body = `
<div class="wrap">
  <section style="margin-top:26px">
    <h1>${esc(cat.heading)}${page > 1 ? ' — page ' + page : ''}</h1>
    <p class="lede">${esc(cat.description)}</p>
    ${page === 1 && cat.intro ? '<p class="lede">' + esc(cat.intro) + '</p>' : ''}
  </section>

  <section>
    <h2 class="skip">${esc(cat.heading)} list</h2>
    ${cards
    ? '<ul class="grid">' + cards + '</ul>'
    : '<div class="empty"><p>No titles could be loaded for this category right now. Please try again in a moment.</p></div>'}
    ${totalPages > 1 ? '<nav class="pager" aria-label="Pagination">' + pager.join('') + '</nav>' : ''}
  </section>

  <section>
    <h2>Related ${esc(isTv ? 'series' : 'movie')} categories</h2>
    <ul class="pill-links">
      ${siblings.map((s) => '<li><a href="' + esc(categoryPath(s)) + '">' + esc(CATEGORIES[s].heading) + '</a></li>').join('')}
    </ul>
  </section>

  <section>
    <h2>${esc(isTv ? 'Browse movies' : 'Browse series & shows')}</h2>
    <ul class="pill-links">
      ${crossFamily.map((s) => '<li><a href="' + esc(categoryPath(s)) + '">' + esc(CATEGORIES[s].heading) + '</a></li>').join('')}
    </ul>
  </section>
</div>`;

  const extraHead = [];
  if (page > 1) extraHead.push({ rel: 'prev', href: SITE_URL + basePath + (page - 1 > 1 ? '?page=' + (page - 1) : '') });
  if (page < totalPages) extraHead.push({ rel: 'next', href: SITE_URL + basePath + '?page=' + (page + 1) });

  return renderShell({
    title,
    description,
    canonicalPath,
    ogImage: LOGO_URL,
    schemas: [collectionSchema, itemListSchema],
    breadcrumbs: [
      { name: 'Home', path: '/' },
      { name: isTv ? 'Series' : 'Movies', path: isTv ? '/series/web-series' : '/movies/popular' },
      { name: cat.heading + (page > 1 ? ' — page ' + page : '') }
    ],
    body
  });
}

// ══════════════════════════════════════════════════════════════════════
//  SITEMAPS
// ══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
//  A-Z BROWSE HUBS
//  A flat, paginated index of the whole catalogue. Category pages can only
//  surface 20 titles at a time behind a long pagination chain; these hubs put
//  120 crawlable links on one page, so nothing in the catalogue is orphaned.
// ═══════════════════════════════════════════════════════════════════════════

function browseLetterOf(title) {
  const ch = String(title || '').trim().charAt(0).toLowerCase();
  return /[a-z]/.test(ch) ? ch : '0-9';
}

function renderBrowseIndexPage(counts) {
  const body = `
<div class="wrap">
  <section style="margin-top:26px">
    <h1>Browse every title on ${esc(SITE_NAME)} A-Z</h1>
    <p class="lede">The complete ${esc(SITE_NAME)} catalogue, indexed alphabetically. Pick a letter to see every movie and series whose title starts with it, with ratings, year and a direct link to each title's page.</p>
  </section>
  <section>
    <h2>Jump to a letter</h2>
    <ul class="az">
      ${BROWSE_LETTERS.map((l) => '<li><a href="/browse/' + esc(l) + '">' + esc(l) + (counts && counts[l] ? ' <span style="opacity:.45;font-weight:500">' + counts[l] + '</span>' : '') + '</a></li>').join('')}
    </ul>
  </section>
  <section>
    <h2>Browse by category instead</h2>
    <ul class="pill-links">
      ${MOVIE_CATEGORY_SLUGS.concat(SERIES_CATEGORY_SLUGS).slice(0, 24)
    .map((s) => '<li><a href="' + esc(categoryPath(s)) + '">' + esc(CATEGORIES[s].heading) + '</a></li>').join('')}
    </ul>
  </section>
</div>`;

  return renderShell({
    title: 'Browse All Movies & Series A-Z | ' + SITE_NAME,
    description: 'The full ' + SITE_NAME + ' catalogue indexed A to Z. Browse every movie and web series alphabetically and jump straight to any title.',
    canonicalPath: '/browse',
    ogImage: LOGO_URL,
    breadcrumbs: [{ name: 'Home', path: '/' }, { name: 'Browse A-Z' }],
    body
  });
}

function renderBrowseLetterPage(letter, entries, page, totalPages) {
  const basePath = '/browse/' + letter;
  const canonicalPath = pageHref(basePath, page);
  const shown = letter === '0-9' ? 'a number or symbol' : 'the letter ' + letter.toUpperCase();
  const heading = letter === '0-9' ? 'Titles starting with 0-9' : 'Titles starting with ' + letter.toUpperCase();

  const rows = entries.map((e) => {
    const kind = e.media_type === 'tv' ? 'tv' : 'movie';
    const year = yearOf(e);
    return '<li><a href="' + esc(detailPath(kind, e)) + '">' + esc(titleOf(e))
      + (year ? ' <span style="opacity:.45">(' + esc(year) + ')</span>' : '') + '</a></li>';
  }).join('');

  const pager = [];
  if (page > 1) pager.push('<a href="' + esc(pageHref(basePath, page - 1)) + '" rel="prev">&larr; Previous</a>');
  for (let p = 1; p <= totalPages; p++) {
    pager.push(p === page
      ? '<span class="pager-cur" aria-current="page">' + p + '</span>'
      : '<a href="' + esc(pageHref(basePath, p)) + '">' + p + '</a>');
  }
  if (page < totalPages) pager.push('<a href="' + esc(pageHref(basePath, page + 1)) + '" rel="next">Next &rarr;</a>');

  const body = `
<div class="wrap">
  <section style="margin-top:26px">
    <h1>${esc(heading)}${page > 1 ? ' &mdash; page ' + page : ''}</h1>
    <p class="lede">${esc('Every movie and series on ' + SITE_NAME + ' whose title begins with ' + shown + '. ' + entries.length + ' titles on this page' + (totalPages > 1 ? ' of ' + totalPages + '.' : '.'))}</p>
  </section>
  <section>
    <h2 class="skip">${esc(heading)} list</h2>
    ${rows ? '<ul class="link-cols">' + rows + '</ul>' : '<div class="empty"><p>No titles indexed under this letter yet.</p></div>'}
    ${totalPages > 1 ? '<nav class="pager" aria-label="Pagination">' + pager.join('') + '</nav>' : ''}
  </section>
  <section>
    <h2>Other letters</h2>
    <ul class="az">
      ${BROWSE_LETTERS.filter((l) => l !== letter).map((l) => '<li><a href="/browse/' + esc(l) + '">' + esc(l) + '</a></li>').join('')}
    </ul>
  </section>
</div>`;

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: heading,
    numberOfItems: entries.length,
    itemListElement: entries.slice(0, 50).map((e, i) => ({
      '@type': 'ListItem',
      position: (page - 1) * BROWSE_PER_PAGE + i + 1,
      url: SITE_URL + detailPath(e.media_type === 'tv' ? 'tv' : 'movie', e),
      name: titleOf(e)
    }))
  };

  return renderShell({
    title: heading + (page > 1 ? ' — Page ' + page : '') + ' | ' + SITE_NAME,
    description: 'Browse every movie and web series on ' + SITE_NAME + ' starting with ' + shown
      + '. Alphabetical index with release years and direct links to each title.',
    canonicalPath,
    ogImage: LOGO_URL,
    schemas: [itemList],
    breadcrumbs: [
      { name: 'Home', path: '/' },
      { name: 'Browse A-Z', path: '/browse' },
      { name: heading + (page > 1 ? ' — page ' + page : '') }
    ],
    body
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  HOMEPAGE LINK INJECTION
//  index.html is a client-rendered SPA: its poster grid is built in JS, so the
//  served HTML contains zero links to any detail page. The homepage holds most
//  of the site's authority, and none of it was reaching the catalogue. This
//  injects a server-rendered link block into the static file before it ships.
// ═══════════════════════════════════════════════════════════════════════════

const HOME_FILE = path.join(__dirname, 'index.html');
const HOME_ANCHOR = '<footer class="site-footer" role="contentinfo">';
const HOME_MARK_START = '<!--MZ_SSR_LINKS_START-->';
const HOME_MARK_END = '<!--MZ_SSR_LINKS_END-->';
const HOME_BLOCK_RE = /<!--MZ_SSR_LINKS_START-->[\s\S]*?<!--MZ_SSR_LINKS_END-->/;

/**
 * Injects (or replaces) the server-rendered link block in an index.html string.
 * Idempotent: running it twice produces the same output, so the build-time
 * injector and the runtime handler can never stack two blocks on the page.
 */
function injectHomeLinks(shell, block) {
  if (!shell || !block) return shell;
  const cleaned = shell.replace(HOME_BLOCK_RE, '');
  if (cleaned.indexOf(HOME_ANCHOR) === -1) return null;
  return cleaned.replace(HOME_ANCHOR, block + '\n' + HOME_ANCHOR);
}

let homeShellMemo = null;
let homeShellMtime = 0;

function readHomeShell() {
  const stat = fs.statSync(HOME_FILE);
  if (homeShellMemo && stat.mtimeMs === homeShellMtime) return homeShellMemo;
  homeShellMemo = fs.readFileSync(HOME_FILE, 'utf8');
  homeShellMtime = stat.mtimeMs;
  return homeShellMemo;
}

function renderHomeLinkBlock(groups) {
  const section = (id, heading, blurb, items) => {
    if (!items || !items.length) return '';
    const links = items.map((it) => {
      const kind = resolveKind(it, it.first_air_date || it.name ? 'tv' : 'movie');
      const t = titleOf(it);
      if (!t) return '';
      const y = yearOf(it);
      return '<li><a href="' + esc(detailPath(kind, it)) + '">' + esc(t)
        + (y ? ' <span style="opacity:.45">(' + esc(y) + ')</span>' : '') + '</a></li>';
    }).filter(Boolean).join('');
    if (!links) return '';
    return '<section class="mz-ssr-sec" aria-labelledby="' + id + '">'
      + '<h2 id="' + id + '">' + esc(heading) + '</h2>'
      + '<p class="mz-ssr-blurb">' + esc(blurb) + '</p>'
      + '<ul class="mz-ssr-links">' + links + '</ul></section>';
  };

  const inner = [
    section('mz-ssr-trending', 'Trending movies this week',
      'The titles people are watching on ' + SITE_NAME + ' right now. Each one opens a full page with cast, ratings and streaming availability.',
      groups.trending),
    section('mz-ssr-popular', 'Popular movies right now',
      'Broadly popular films across Bollywood, Hollywood and South Indian cinema.',
      groups.popular),
    section('mz-ssr-tv', 'Popular web series and shows',
      'Web series, K-drama and anime currently drawing the most viewers.',
      groups.tv)
  ].filter(Boolean).join('');

  // Even with zero TMDB data the category and A-Z links are worth shipping:
  // they are the static half of the crawl graph and never go stale.
  const cats = MOVIE_CATEGORY_SLUGS.concat(SERIES_CATEGORY_SLUGS)
    .map((s) => '<li><a href="' + esc(categoryPath(s)) + '">' + esc(CATEGORIES[s].heading) + '</a></li>').join('');

  const az = BROWSE_LETTERS
    .map((l) => '<li><a href="/browse/' + esc(l) + '">' + esc(l) + '</a></li>').join('');

  return HOME_MARK_START
    + '<div class="mz-ssr-index">'
    + '<style>'
    + '.mz-ssr-index{max-width:1140px;margin:40px auto 0;padding:0 20px}'
    + '.mz-ssr-sec{margin:0 0 34px}'
    + '.mz-ssr-index h2{font-size:1.2rem;margin:0 0 6px}'
    + '.mz-ssr-blurb{opacity:.62;margin:0 0 14px;font-size:.92rem;max-width:78ch}'
    + '.mz-ssr-links,.mz-ssr-cats{columns:3 210px;column-gap:24px;padding:0;margin:0;list-style:none}'
    + '.mz-ssr-links li,.mz-ssr-cats li{break-inside:avoid;margin-bottom:8px;font-size:.9rem}'
    + '.mz-ssr-az{display:flex;flex-wrap:wrap;gap:7px;padding:0;margin:0;list-style:none}'
    + '.mz-ssr-az a{display:inline-block;min-width:36px;text-align:center;padding:6px 9px;border:1px solid rgba(255,255,255,.14);border-radius:8px;text-transform:uppercase;font-weight:700;font-size:.82rem}'
    + '</style>'
    + inner
    + '<section class="mz-ssr-sec" aria-labelledby="mz-ssr-cats-h">'
    + '<h2 id="mz-ssr-cats-h">Browse ' + esc(SITE_NAME) + ' by category</h2>'
    + '<ul class="mz-ssr-cats">' + cats + '</ul></section>'
    + '<section class="mz-ssr-sec" aria-labelledby="mz-ssr-az-h">'
    + '<h2 id="mz-ssr-az-h">Browse the full catalogue A-Z</h2>'
    + '<p class="mz-ssr-blurb">Every title on ' + esc(SITE_NAME) + ', indexed alphabetically.</p>'
    + '<ul class="mz-ssr-az">' + az + '</ul></section>'
    + '</div>'
    + HOME_MARK_END;
}

function sitemapUrl(loc, opts) {
  const o = opts || {};
  return '<url><loc>' + escXml(SITE_URL + loc) + '</loc>'
    + (o.lastmod ? '<lastmod>' + escXml(o.lastmod) + '</lastmod>' : '')
    + (o.changefreq ? '<changefreq>' + escXml(o.changefreq) + '</changefreq>' : '')
    + (o.priority ? '<priority>' + escXml(o.priority) + '</priority>' : '')
    + '</url>';
}

function wrapUrlset(urls) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('\n') + '\n</urlset>\n';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function buildSitemapIndex() {
  const cache = readSitemapCache();
  const children = ['/sitemap-static.xml', '/sitemap-browse.xml']
    .concat(sitemapChunkPaths('movie', cache))
    .concat(sitemapChunkPaths('tv', cache));
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + children.map((c) => '<sitemap><loc>' + escXml(SITE_URL + c) + '</loc>'
      + '<lastmod>' + escXml(sitemapCacheDate(cache)) + '</lastmod></sitemap>').join('\n')
    + '\n</sitemapindex>\n';
}

function buildStaticSitemap() {
  const urls = [sitemapUrl('/', {
    lastmod: SITEMAP_FALLBACK_DATE, changefreq: 'daily', priority: '1.0'
  })];
  urls.push(sitemapUrl('/browse', {
    lastmod: SITEMAP_FALLBACK_DATE, changefreq: 'weekly', priority: '0.6'
  }));
  Object.keys(CATEGORIES).forEach((slug) => {
    urls.push(sitemapUrl(categoryPath(slug), {
      lastmod: SITEMAP_FALLBACK_DATE,
      changefreq: VOLATILE_CATEGORY_SLUGS.has(slug) ? 'daily' : 'weekly',
      priority: '0.8'
    }));
  });
  return wrapUrlset(urls);
}

/** Curated franchise ids ship with the repo, so they cost no API calls. */
function collectionsCatalogIds() {
  try {
    const file = path.join(__dirname, 'collections-catalog.json');
    if (!fs.existsSync(file)) return { movies: [], tv: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const movies = [];
    const tv = [];
    Object.keys(data.universes || {}).forEach((key) => {
      const u = data.universes[key] || {};
      (u.movies || []).forEach((m) => { if (m && m.id) movies.push(m); });
      (u.tv || []).forEach((t) => { if (t && t.id) tv.push(t); });
    });
    return { movies, tv };
  } catch (err) {
    console.warn('[seo-ssr] collections-catalog.json unreadable:', err.message);
    return { movies: [], tv: [] };
  }
}

/**
 * Collect ids for a media sitemap. Bounded on purpose: a sitemap request
 * that fans out to 50 upstream calls would be a self-inflicted outage, so
 * we take a few pages from a few high-signal endpoints and rely on the
 * long CDN TTL.
 */
async function collectSitemapItems(tmdb, kind, pagesPerEndpoint) {
  const endpoints = kind === 'tv'
    ? ['/tv/popular', '/tv/top_rated', '/trending/tv/week']
    : ['/movie/popular', '/movie/top_rated', '/trending/movie/week', '/movie/now_playing'];

  const tasks = [];
  endpoints.forEach((endpoint) => {
    for (let p = 1; p <= pagesPerEndpoint; p++) {
      tasks.push(tmdb(endpoint, { language: 'en-US', page: String(p) }).catch(() => null));
    }
  });

  const settled = await Promise.all(tasks);
  const seen = new Map();
  settled.forEach((res) => {
    ((res && res.results) || []).forEach((item) => {
      if (item && item.id && !seen.has(String(item.id))) seen.set(String(item.id), item);
    });
  });

  const catalog = collectionsCatalogIds();
  (kind === 'tv' ? catalog.tv : catalog.movies).forEach((item) => {
    if (item && item.id && !seen.has(String(item.id))) seen.set(String(item.id), item);
  });

  return Array.from(seen.values());
}

/**
 * A title's real last-meaningful-change date. Falls back to the hand-bumped
 * constant rather than today() so the value stays stable between crawls.
 */
function releaseLastmod(item) {
  const raw = String((item && (item.release_date || item.first_air_date || item.lastmod)) || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : SITEMAP_FALLBACK_DATE;
}

let sitemapCacheMemo = null;
let sitemapCacheMtime = 0;

/**
 * Reads sitemap-cache.json, written by scripts/build-sitemap-cache.js.
 * Returns null when the file is absent so every caller can fall back to the
 * old live-TMDB path — a missing cache must never take the sitemaps down.
 */
function readSitemapCache() {
  try {
    const stat = fs.statSync(SITEMAP_CACHE_FILE);
    if (sitemapCacheMemo && stat.mtimeMs === sitemapCacheMtime) return sitemapCacheMemo;
    const parsed = JSON.parse(fs.readFileSync(SITEMAP_CACHE_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.movie) || !Array.isArray(parsed.tv)) return null;
    sitemapCacheMemo = parsed;
    sitemapCacheMtime = stat.mtimeMs;
    return parsed;
  } catch {
    return null;
  }
}

function sitemapCacheDate(cache) {
  const d = cache && String(cache.generated || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : SITEMAP_FALLBACK_DATE;
}

/**
 * Sitemap files must stay under 50k URLs; chunk the catalogue to match.
 * Chunk 1 deliberately keeps the original /sitemap-movies.xml name — that URL
 * is already submitted in Search Console and there is no reason to churn it.
 */
function sitemapChunkPaths(kind, cache) {
  const plural = kind === 'tv' ? 'tv' : 'movies';
  const first = '/sitemap-' + plural + '.xml';
  const items = cache && cache[kind];
  if (!items || !items.length) return [first];
  const chunks = Math.ceil(items.length / SITEMAP_CHUNK_SIZE);
  if (chunks <= 1) return [first];
  const out = [first];
  for (let i = 2; i <= chunks; i++) out.push('/sitemap-' + plural + '-' + i + '.xml');
  return out;
}

/** The A–Z hub pages, so Google can find the flat index of the catalogue. */
function buildBrowseSitemap() {
  const urls = BROWSE_LETTERS.map((letter) => sitemapUrl('/browse/' + letter, {
    lastmod: SITEMAP_FALLBACK_DATE, changefreq: 'weekly', priority: '0.5'
  }));
  return wrapUrlset(urls);
}

function buildMediaSitemap(items, kind) {
  const urls = items.map((item) => {
    const t = titleOf(item);
    if (!t) return null;
    return sitemapUrl(detailPath(resolveKind(item, kind), item), {
      lastmod: releaseLastmod(item),
      changefreq: 'monthly',
      priority: '0.7'
    });
  }).filter(Boolean);
  return wrapUrlset(urls);
}

// ══════════════════════════════════════════════════════════════════════
//  ROUTE REGISTRATION
// ══════════════════════════════════════════════════════════════════════

/**
 * @param {import('express').Application} app
 * @param {object} deps
 * @param {(endpoint: string, params?: object) => Promise<any>} deps.tmdb
 *        Cached TMDB fetcher. Must resolve JSON or reject.
 * @param {{get(k):any, set(k,v):any}} [deps.cache] Used to memoise rendered HTML/XML.
 */
function registerSeoRoutes(app, deps) {
  const tmdb = deps && deps.tmdb;
  if (typeof tmdb !== 'function') {
    throw new TypeError('registerSeoRoutes requires deps.tmdb to be a function');
  }
  const cache = (deps && deps.cache) || null;

  const cacheGet = (key) => {
    try { return cache ? cache.get(key) : undefined; } catch { return undefined; }
  };
  const cacheSet = (key, value) => {
    try { if (cache) cache.set(key, value); } catch { /* cache is best-effort */ }
  };

  // ── Detail pages ──────────────────────────────────────────────────
  const detailHandler = (kind) => async (req, res, next) => {
    const parsed = parseIdSlug(req.params.slug);
    if (!parsed) return next();

    const cacheKey = 'ssr:' + kind + ':' + parsed.id;
    const cached = cacheGet(cacheKey);

    let item = cached && cached.item;
    if (!item) {
      try {
        item = await tmdb('/' + kind + '/' + parsed.id, {
          language: 'en-US',
          append_to_response: 'credits,similar,recommendations,videos,watch/providers,release_dates,content_ratings'
        });
      } catch (err) {
        const status = err && (err.tmdbStatus || err.status);
        if (status === 404) return next();
        console.warn('[seo-ssr] ' + kind + '/' + parsed.id + ' failed:', err && err.message);
        return next(err);
      }
    }
    if (!item || !item.id) return next();

    const title = titleOf(item);
    if (!title) return next();

    // One canonical URL per title: redirect a wrong/absent slug to the real one.
    const wantSlug = slugify(title);
    if (wantSlug && parsed.slug !== wantSlug) {
      res.set('Cache-Control', DETAIL_CACHE);
      return res.redirect(301, detailPath(kind, item));
    }

    let html = cached && cached.html;
    if (!html) {
      html = renderDetailPage(item, kind);
      cacheSet(cacheKey, { item, html });
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', DETAIL_CACHE);
    res.set('X-Robots-Tag', 'index, follow');
    return res.status(200).send(html);
  };

  app.get('/movie/:slug', detailHandler('movie'));
  app.get('/tv/:slug', detailHandler('tv'));

  // ── Category pages ────────────────────────────────────────────────
  const categoryHandler = (family) => async (req, res, next) => {
    const slug = String(req.params.slug || '').toLowerCase();
    const cat = CATEGORIES[slug];
    if (!cat || cat.family !== family) return next();

    let page = parseInt(req.query.page, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    page = Math.min(page, 25); // beyond this the data thins out and adds no SEO value

    const cacheKey = 'ssr:cat:' + family + ':' + slug + ':' + page;
    const cachedHtml = cacheGet(cacheKey);
    if (cachedHtml) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', CATEGORY_CACHE);
      return res.status(200).send(cachedHtml);
    }

    let results = [];
    let totalPages = 1;
    try {
      const data = await tmdb(cat.endpoint, Object.assign(
        { language: 'en-US', page: String(page) },
        cat.params || {}
      ));
      results = ((data && data.results) || []).filter((r) => r && r.id && r.poster_path);
      totalPages = Math.max(1, Math.min(parseInt(data && data.total_pages, 10) || 1, 25));
    } catch (err) {
      console.warn('[seo-ssr] category ' + slug + ' failed:', err && err.message);
      // Still render the page: the copy, schema and internal links are the
      // SEO payload, and an empty grid beats a 500 for both users and crawlers.
    }

    const html = renderCategoryPage(slug, cat, results, page, totalPages);
    if (results.length) cacheSet(cacheKey, html);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', CATEGORY_CACHE);
    res.set('X-Robots-Tag', 'index, follow');
    return res.status(200).send(html);
  };

  app.get('/movies/:slug', categoryHandler('movies'));
  app.get('/series/:slug', categoryHandler('series'));

  // Bare family URLs are useful entry points; send them to the best default.
  app.get('/movies', (req, res) => res.redirect(301, '/movies/popular'));
  app.get('/series', (req, res) => res.redirect(301, '/series/web-series'));

  // ── Sitemaps ──────────────────────────────────────────────────────
  const sendXml = (res, xml) => {
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', SITEMAP_CACHE);
    return res.status(200).send(xml);
  };

  // ── A-Z browse hubs ──────────────────────────────────────────────────
  const browseEntries = () => {
    const cache = readSitemapCache();
    if (!cache) return null;
    return cache.movie.map((m) => Object.assign({ media_type: 'movie' }, m))
      .concat(cache.tv.map((t) => Object.assign({ media_type: 'tv' }, t)));
  };

  app.get('/browse', (req, res, next) => {
    const all = browseEntries();
    if (!all) return next();
    const counts = {};
    all.forEach((e) => {
      const l = browseLetterOf(titleOf(e));
      counts[l] = (counts[l] || 0) + 1;
    });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', BROWSE_CACHE);
    res.set('X-Robots-Tag', 'index, follow');
    return res.status(200).send(renderBrowseIndexPage(counts));
  });

  app.get('/browse/:letter', (req, res, next) => {
    const letter = String(req.params.letter || '').toLowerCase();
    if (BROWSE_LETTERS.indexOf(letter) === -1) return next();

    const all = browseEntries();
    if (!all) return next();

    const entries = all
      .filter((e) => browseLetterOf(titleOf(e)) === letter)
      .sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'en'));

    const totalPages = Math.max(1, Math.ceil(entries.length / BROWSE_PER_PAGE));
    let page = parseInt(req.query.page, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (page > totalPages) return res.redirect(301, '/browse/' + letter);

    const slice = entries.slice((page - 1) * BROWSE_PER_PAGE, page * BROWSE_PER_PAGE);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', BROWSE_CACHE);
    res.set('X-Robots-Tag', 'index, follow');
    return res.status(200).send(renderBrowseLetterPage(letter, slice, page, totalPages));
  });

  app.get('/sitemap.xml', (req, res) => sendXml(res, buildSitemapIndex()));
  app.get('/sitemap-browse.xml', (req, res) => sendXml(res, buildBrowseSitemap()));
  app.get('/sitemap-static.xml', (req, res) => sendXml(res, buildStaticSitemap()));

  // Prefer the nightly cache (full catalogue, zero upstream calls). Fall back
  // to the original bounded live fetch whenever the cache file is missing.
  const mediaSitemap = (kind) => async (req, res) => {
    const chunk = parseInt(req.params.chunk, 10);
    const fileCache = readSitemapCache();

    if (fileCache && fileCache[kind] && fileCache[kind].length) {
      const all = fileCache[kind];
      const chunks = Math.ceil(all.length / SITEMAP_CHUNK_SIZE);
      const index = Number.isFinite(chunk) ? chunk : 1;
      if (index < 1 || index > Math.max(1, chunks)) return res.status(404).end();
      const slice = chunks > 1
        ? all.slice((index - 1) * SITEMAP_CHUNK_SIZE, index * SITEMAP_CHUNK_SIZE)
        : all;
      return sendXml(res, buildMediaSitemap(slice, kind));
    }

    const cacheKey = 'ssr:sitemap:' + kind;
    const cached = cacheGet(cacheKey);
    if (cached) return sendXml(res, cached);

    let xml;
    try {
      const items = await collectSitemapItems(tmdb, kind, 8);
      xml = buildMediaSitemap(items, kind);
      if (items.length) cacheSet(cacheKey, xml);
    } catch (err) {
      console.warn('[seo-ssr] sitemap ' + kind + ' failed:', err && err.message);
      const catalog = collectionsCatalogIds();
      xml = buildMediaSitemap(kind === 'tv' ? catalog.tv : catalog.movies, kind);
    }
    return sendXml(res, xml);
  };

  app.get('/sitemap-movies.xml', mediaSitemap('movie'));
  app.get('/sitemap-tv.xml', mediaSitemap('tv'));
  app.get('/sitemap-movies-:chunk.xml', mediaSitemap('movie'));
  app.get('/sitemap-tv-:chunk.xml', mediaSitemap('tv'));

  console.log('🔎 SEO SSR routes active: /movie/:slug, /tv/:slug, /movies/:slug, /series/:slug, /browse, /sitemap*.xml');
}

/**
 * Registers the homepage handler. MUST be called BEFORE app.use(express.static(...))
 * in server.js, otherwise the static middleware answers "/" first and this
 * never runs.
 *
 * Two jobs:
 *   1. Inject server-rendered links to real detail pages into index.html, so
 *      the homepage passes authority into the catalogue instead of dead-ending.
 *   2. Mark "/?search=..." noindex — search result URLs are an infinite
 *      duplicate space and should never enter the index.
 *
 * Any failure calls next(), so express.static serves the untouched file. The
 * homepage can never go down because of this layer.
 */
function registerHomeSsr(app, deps) {
  const tmdb = deps && deps.tmdb;
  const getCache = (deps && deps.getCache) || (() => (deps && deps.cache) || null);

  app.get('/', async (req, res, next) => {
    let shell;
    try {
      shell = readHomeShell();
    } catch {
      return next();
    }

    // ── search results: same page, but never indexable ──
    if (req.query && typeof req.query.search === 'string' && req.query.search.trim()) {
      const noindex = shell.replace(
        /<meta name="robots" content="[^"]*">/i,
        '<meta name="robots" content="noindex, follow">'
      );
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=0, must-revalidate');
      res.set('X-Robots-Tag', 'noindex, follow');
      return res.status(200).send(noindex);
    }

    if (typeof tmdb !== 'function' || shell.indexOf(HOME_ANCHOR) === -1) return next();
    // Already injected at build time and TMDB is unreachable? Ship it as-is.

    let cache = null;
    try { cache = getCache(); } catch { cache = null; }
    const cacheKey = 'ssr:home:links';

    let html;
    try { html = cache && cache.get(cacheKey); } catch { html = null; }

    if (!html) {
      let block = '';
      try {
        const [trending, popular, tv] = await Promise.all([
          tmdb('/trending/movie/week', { language: 'en-US', page: '1' }).catch(() => null),
          tmdb('/movie/popular', { language: 'en-US', page: '1' }).catch(() => null),
          tmdb('/tv/popular', { language: 'en-US', page: '1' }).catch(() => null)
        ]);
        const pick = (d, n) => ((d && d.results) || []).filter((r) => r && r.id).slice(0, n);
        block = renderHomeLinkBlock({
          trending: pick(trending, 20),
          popular: pick(popular, 20),
          tv: pick(tv, 20)
        });
      } catch (err) {
        console.warn('[seo-ssr] homepage link block failed:', err && err.message);
      }

      // Even with no TMDB data the category + A-Z links are worth shipping.
      if (!block) block = renderHomeLinkBlock({ trending: [], popular: [], tv: [] });
      if (!block) return next();

      html = injectHomeLinks(shell, block);
      if (!html) return next();
      try { if (cache) cache.set(cacheKey, html); } catch { /* best effort */ }
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', HOME_CACHE);
    res.set('X-Robots-Tag', 'index, follow');
    return res.status(200).send(html);
  });

  console.log('🏠 Homepage SSR link block active on /');
}

module.exports = {
  registerSeoRoutes,
  registerHomeSsr,
  renderBrowseIndexPage,
  renderBrowseLetterPage,
  renderHomeLinkBlock,
  injectHomeLinks,
  readSitemapCache,
  releaseLastmod,
  browseLetterOf,
  buildBrowseSitemap,
  pageHref,
  watchProvidersIN,
  buildFaq,
  BROWSE_LETTERS,
  SITEMAP_FALLBACK_DATE,
  // exported for tests
  esc,
  escXml,
  jsonLdScript,
  slugify,
  parseIdSlug,
  truncate,
  isoDuration,
  detailPath,
  categoryPath,
  resolveKind,
  buildDetailDescription,
  buildDetailTitle,
  buildAboutParagraph,
  renderDetailPage,
  renderCategoryPage,
  renderShell,
  buildSitemapIndex,
  buildStaticSitemap,
  buildMediaSitemap,
  collectSitemapItems,
  CATEGORIES,
  MOVIE_CATEGORY_SLUGS,
  SERIES_CATEGORY_SLUGS,
  SITE_URL
};
