'use strict';

/*  ══════════════════════════════════════════════════════════════════════════
 *  PER-PLATFORM CHARTS  —  what is ACTUALLY trending / newly added on each OTT
 *  ══════════════════════════════════════════════════════════════════════════
 *
 *  ── the problem this file exists to solve ──
 *
 *  The OTT platform sections were already ACCURATE: every query in
 *  buildOttModeQueries() carries with_watch_providers + watch_region, and
 *  ott-sections-check.js re-verifies a live sample of every grid against each
 *  title's own /watch/providers record. Nothing on a platform tab was ever a
 *  title that is not on that platform.
 *
 *  What was wrong was the ORDER. TMDB has no per-provider chart, so "trending on
 *  Netflix" was being expressed as `sort_by=popularity.desc` inside Netflix's
 *  catalogue. TMDB popularity is a GLOBAL, slow-moving, lifetime-ish signal, so
 *  the grid opened on whatever is globally popular and happens to be licensed to
 *  that platform — not on what the platform's own home screen is pushing today,
 *  and not on what it added last week. TMDB also carries no "date added to
 *  provider X" field at all, so "New on JioHotstar" was simply not expressible.
 *
 *  ── why JustWatch and not each platform's own site ──
 *
 *  Every Indian platform's own home screen was probed before writing this, and
 *  none of them is a usable public source:
 *
 *    JioHotstar   www.hotstar.com/in serves 200 but its __NEXT_DATA__ carries
 *                 only i18n strings; the trays are loaded client-side from
 *                 api.hotstar.com, which answers 401 without a session token.
 *    Zee5         gwapi.zee5.com answers 401 / 402 without a platform token.
 *    SonyLIV      apiv2.sonyliv.com answers 503 without a security_token.
 *    aha          api.aha.video answers 403.
 *    Netflix      the ONLY one that publishes officially — the Tudum Top 10 —
 *                 and even that is weekly, per-country, and title-name only
 *                 (no ids), so it still needs a fuzzy match to be usable.
 *
 *  Scraping a token-gated internal BFF would break on their next deploy and
 *  would give a per-platform, per-region parser to maintain for fourteen
 *  services. JustWatch is the licensed availability aggregator, and — this is
 *  the part that makes it the right choice rather than a convenient one — it is
 *  the SAME source TMDB's own /watch/providers data comes from. Proof, read off
 *  its packages(country: IN) response: JustWatch's packageId is TMDB's provider
 *  id, exactly, for every platform this app ships:
 *
 *    nfx 8    prv 119   atp 350   jhs 2336  zee 232   snl 237   mxp 515
 *    aha 532  cru 283   snx 309   lgp 561   vim 614   dsp 510   sme 474
 *
 *  So the charts below and the provider gate in moviezone.js are two views of
 *  one dataset. A chart entry cannot disagree with the /watch/providers record
 *  that ott-sections-check.js verifies it against, because both are JustWatch.
 *  That is why this can be merged into the grid without weakening the accuracy
 *  guarantee the OTT sections already had — ott-charts-check.js asserts exactly
 *  that, against the live TMDB API, for every platform.
 *
 *  ── what this file does NOT do ──
 *
 *  It returns ids and ranks only. Hydration into renderable cards is TMDB's job
 *  and happens in the /api/ott/charts handler, so the client keeps getting TMDB
 *  shapes and TMDB artwork and nothing downstream has to learn a second schema.
 *
 *  Runtime-agnostic on purpose: global fetch only, no Node builtins, so
 *  server.js and worker.js can both use it unchanged.
 */

/*  Our OTT key -> JustWatch package. `provider` duplicates the TMDB provider id
 *  from the OTT table in moviezone.js deliberately: ott-charts-check.js asserts
 *  the two tables agree AND that the id really is JustWatch's packageId, so a
 *  wrong short code cannot silently start serving another platform's chart.
 *
 *  The short codes are NOT guessable. Measured mistakes from the first pass:
 *  'amp' for Prime Video returned 2 titles (the code is `prv`), 'zee5' for Zee5
 *  was rejected outright (`zee`), and 'hst' silently returns the LEGACY
 *  Disney+ Hotstar package — Marvel and Star Wars — rather than JioHotstar's
 *  own chart, which is `jhs`.
 */
const OTT_JW_PACKAGES = {
  netflix:       { pkg: 'nfx', provider: '8'    },
  prime:         { pkg: 'prv', provider: '119'  },
  jiohotstar:    { pkg: 'jhs', provider: '2336' },
  zee5:          { pkg: 'zee', provider: '232'  },
  apple:         { pkg: 'atp', provider: '350'  },
  sonyliv:       { pkg: 'snl', provider: '237'  },
  /*  The OTT table fetches MX Player under provider 1898 ("Amazon MX Player")
   *  because that is the id with the deeper Indian index, but JustWatch files
   *  the package itself under 515 / mxp. OTT_ALT_PROVIDERS already accepts both
   *  ids when verifying, which is what keeps the chart and the gate consistent. */
  mxplayer:      { pkg: 'mxp', provider: '515'  },
  aha:           { pkg: 'aha', provider: '532'  },
  crunchyroll:   { pkg: 'cru', provider: '283'  },
  sunnxt:        { pkg: 'snx', provider: '309'  },
  lionsgate:     { pkg: 'lgp', provider: '561'  },
  vi:            { pkg: 'vim', provider: '614'  },
  discoveryplus: { pkg: 'dsp', provider: '510'  },
  shemaroo:      { pkg: 'sme', provider: '474'  }
};

const JW_ENDPOINT = 'https://apis.justwatch.com/graphql';
const JW_TIMEOUT_MS = 9000;
const JW_REGION = 'IN';
const JW_LANGUAGE = 'en';

/*  ── THE MONETIZATION GATE, AND WHY IT IS NOT OPTIONAL ──
 *
 *  Without this, a `packages: ['zee']` filter means "anything Zee5 offers",
 *  INCLUDING its rental and purchase storefront. Measured: the Zee5 chart came
 *  back with Talladega Nights (2006) at rank 5, and TMDB's own /watch/providers
 *  record confirms it is Zee5 RENT in IN and not part of the subscription —
 *  ott-charts-check.js failed that platform at 83% on-platform because of it.
 *  A user clicking Zee5 expects what they can watch, not a shop window.
 *
 *  These three tiers are exactly what ottIsOnPlatform() accepts when verifying
 *  (entry.flatrate + entry.free + entry.ads), so the chart and the accuracy gate
 *  now describe the same catalogue by construction rather than by luck. RENT and
 *  BUY are deliberately absent — that is the whole point of gating at all.
 *
 *  Measured cost of adding it: none. All fourteen platforms still return a full
 *  30-deep list on both queries.
 */
const JW_MONETIZATION = ['FLATRATE', 'FREE', 'ADS'];

// How many ranks to ask for per list. 30 is well past the 24-card grid, which
// leaves room for the entries that carry no TMDB id to be dropped without the
// chart head thinning out.
const JW_LIST_SIZE = 30;

/*  A browser UA is sent for the same reason the client's own fetches do: a bare
 *  runtime default is the first thing an edge rejects. Nothing here depends on
 *  being taken for a browser — the endpoint is unauthenticated and read-only. */
const JW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/*  The node shape both queries share. externalIds.tmdbId is the whole point of
 *  using this source: it means a chart entry maps onto the exact TMDB record the
 *  rest of the app already renders, with no title matching and no year guessing. */
const JW_NODE_FIELDS = `
  objectType
  content(country: $country, language: $language) {
    title
    originalReleaseYear
    externalIds { tmdbId }
  }`;

const JW_TRENDING_QUERY = `
  query MzPlatformTrending($country: Country!, $language: Language!, $first: Int!,
                           $sortBy: PopularTitlesSorting!, $filter: TitleFilter) {
    popularTitles(country: $country, first: $first, sortBy: $sortBy, filter: $filter) {
      edges { node {${JW_NODE_FIELDS} } }
    }
  }`;

const JW_NEW_QUERY = `
  query MzPlatformNew($country: Country!, $language: Language!, $first: Int!,
                      $filter: TitleFilter) {
    newTitles(country: $country, first: $first, filter: $filter) {
      edges { node {${JW_NODE_FIELDS} } }
    }
  }`;

/** True for a platform this app actually ships a rail card for. */
function isKnownChartPlatform(key) {
  return Object.prototype.hasOwnProperty.call(OTT_JW_PACKAGES, String(key || ''));
}

/** Every platform key with a chart mapping. */
function chartPlatforms() {
  return Object.keys(OTT_JW_PACKAGES);
}

/*  JustWatch object types -> the media_type the app renders with.
 *
 *  SHOW_SEASON and SHOW_EPISODE matter more than they look: the "newly added"
 *  list is season-granular, so a platform that just dropped Bigg Boss season 13
 *  is reported as a SHOW_SEASON whose tmdbId is "11436:13". Collapsing those to
 *  the base show id is what turns three seasons of one show into one card.
 */
const JW_TYPE_TO_MEDIA = {
  MOVIE: 'movie',
  SHOW: 'tv',
  SHOW_SEASON: 'tv',
  SHOW_EPISODE: 'tv'
};

/**
 * One JustWatch node -> { id, media_type } or null.
 *
 * Returns null rather than guessing whenever the mapping is not certain: an
 * entry with no TMDB id, or an object type we do not render, is dropped. The
 * chart is a RANKING, so a dropped entry costs one rank; a wrongly mapped one
 * would put a stranger at the top of the grid.
 */
function normaliseChartNode(node) {
  if (!node) return null;
  const media = JW_TYPE_TO_MEDIA[node.objectType];
  if (!media) return null;

  const content = node.content || {};
  const raw = content.externalIds && content.externalIds.tmdbId;
  if (!raw) return null;

  // "11436:13" (show:season) and "1408162" (movie) are both valid here.
  const base = String(raw).split(':')[0].trim();
  if (!/^\d+$/.test(base)) return null;

  return {
    id: Number(base),
    media_type: media,
    title: content.title || '',
    year: content.originalReleaseYear || null
  };
}

/** POST one GraphQL document. Throws on transport or GraphQL-level failure. */
async function jwQuery(query, variables, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('no fetch implementation available');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JW_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(JW_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': JW_UA
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error('JustWatch responded ' + res.status);
  const payload = await res.json();
  if (payload && payload.errors && payload.errors.length) {
    throw new Error('JustWatch GraphQL error: '
      + String(payload.errors[0] && payload.errors[0].message).slice(0, 160));
  }
  return payload && payload.data;
}

/**
 * Read one ranked list and collapse it to unique { id, media_type, rank }.
 *
 * Dedupe is by media_type + id, keeping the FIRST occurrence, because the first
 * occurrence is the better rank — and because the newly-added list is
 * season-granular, so without this a show that just dropped three seasons would
 * occupy three of the grid's first rows.
 */
function collapseEdges(edges) {
  const out = [];
  const seen = new Set();
  (edges || []).forEach((edge) => {
    const entry = normaliseChartNode(edge && edge.node);
    if (!entry) return;
    const dedupeKey = entry.media_type + '-' + entry.id;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    entry.rank = out.length + 1;
    out.push(entry);
  });
  return out;
}

/**
 * The platform's own two charts for a region.
 *
 * `trending` is JustWatch's TRENDING ranking scoped to that package — the
 * platform's current demand curve, not TMDB's global popularity. `newly` is its
 * recently-added list, which is the signal TMDB has no field for at all.
 *
 * Rejects only when BOTH lists fail. A platform with one working list is still
 * a better grid than none, and every caller treats an empty chart as "rank the
 * pool the way it was ranked before", never as an error.
 *
 * @returns {Promise<{platform:string, package:string, provider:string,
 *                    region:string, trending:Array, newly:Array, fetchedAt:number}>}
 */
async function fetchPlatformChart(key, options) {
  const opts = options || {};
  const cfg = OTT_JW_PACKAGES[key];
  if (!cfg) throw new Error('unknown chart platform: ' + key);

  const region = opts.region || JW_REGION;
  const language = opts.language || JW_LANGUAGE;
  const size = opts.size || JW_LIST_SIZE;
  const fetchImpl = opts.fetch;
  const filter = { packages: [cfg.pkg], monetizationTypes: JW_MONETIZATION };

  const [trendingRes, newRes] = await Promise.allSettled([
    jwQuery(JW_TRENDING_QUERY,
      { country: region, language, first: size, sortBy: 'TRENDING', filter }, fetchImpl),
    jwQuery(JW_NEW_QUERY,
      { country: region, language, first: size, filter }, fetchImpl)
  ]);

  if (trendingRes.status === 'rejected' && newRes.status === 'rejected') {
    const why = (trendingRes.reason && trendingRes.reason.message) || 'unknown';
    throw new Error('both charts failed for ' + key + ': ' + why);
  }

  const trending = trendingRes.status === 'fulfilled'
    ? collapseEdges(trendingRes.value
      && trendingRes.value.popularTitles && trendingRes.value.popularTitles.edges)
    : [];
  const newly = newRes.status === 'fulfilled'
    ? collapseEdges(newRes.value
      && newRes.value.newTitles && newRes.value.newTitles.edges)
    : [];

  return {
    platform: key,
    package: cfg.pkg,
    provider: cfg.provider,
    region,
    trending,
    newly,
    fetchedAt: Date.now()
  };
}

/**
 * Merge the two charts into ONE ordered id list for the grid head.
 *
 * The interleave is 2 trending : 1 newly rather than "all trending then all
 * newly", because both claims are being made at once — the section promises
 * what is hot AND what just landed. A block layout would push the newly-added
 * titles off the first screen on any platform with a busy trending list, which
 * is the specific thing a user opening JioHotstar is looking for.
 *
 * Trending leads, so a platform's actual hit still takes rank 1.
 */
function mergeChartOrder(chart, limit) {
  const trending = (chart && chart.trending) || [];
  const newly = (chart && chart.newly) || [];
  const cap = limit || (trending.length + newly.length);
  const merged = [];
  const seen = new Set();

  const take = (entry, source) => {
    if (!entry || merged.length >= cap) return;
    const dedupeKey = entry.media_type + '-' + entry.id;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    merged.push({
      id: entry.id,
      media_type: entry.media_type,
      title: entry.title,
      chartRank: merged.length + 1,
      chartSource: source,
      sourceRank: entry.rank
    });
  };

  let ti = 0;
  let ni = 0;
  while (merged.length < cap && (ti < trending.length || ni < newly.length)) {
    const before = merged.length;
    take(trending[ti++], 'trending');
    take(trending[ti++], 'trending');
    take(newly[ni++], 'newly');
    // Both lists exhausted of anything new — stop instead of spinning.
    if (merged.length === before && ti > trending.length && ni > newly.length) break;
  }
  return merged;
}

module.exports = {
  OTT_JW_PACKAGES,
  JW_LIST_SIZE,
  JW_MONETIZATION,
  isKnownChartPlatform,
  chartPlatforms,
  normaliseChartNode,
  collapseEdges,
  fetchPlatformChart,
  mergeChartOrder
};
