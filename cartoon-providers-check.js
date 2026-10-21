/*  cartoon-providers-check.js — guards the homepage "Cartoon Providers" rail.
 *
 *  Run:  node cartoon-providers-check.js            (offline, part of test:offline)
 *        node cartoon-providers-check.js --online   (+ live catalogue depth)
 *
 *  What it proves, and why each matters:
 *    1. Every rail card in index.html names a mode that exists in BOTH
 *       CARTOON_PROVIDERS and CARTOON_MODES. A card whose mode is missing would
 *       be silently rewritten to 'all' by the click whitelist, i.e. the user taps
 *       "Disney" and gets every cartoon on TMDB.
 *    2. Every provider plan is SCOPED: each request is a /discover call carrying
 *       with_networks, with_companies or with_original_language. No /trending
 *       source, no watch-provider id — a global source is exactly how the OTT
 *       tabs once leaked other platforms' titles (see buildOttModeQueries).
 *    3. The animation gate is applied at source wherever TMDB genres are reliable
 *       (everything except the Indian kids-network query, see moviezone.js).
 *    4. The click handler only accepts a mode from the CARTOON_MODES whitelist.
 *    5. Logos are local, small (< 16 KB each) and inert: no <script>, no event
 *       handler attributes, no external references — they are served from our
 *       own origin, so an SVG that could run code would be an XSS vector.
 *    6. sw.js precaches every logo and providers.css brand-lights every card;
 *       every Cartoons chip has an SVG mask icon and none still uses an emoji.
 *    7. --online: each card, run through the REAL plan and the REAL strict
 *       cartoon gate against the live TMDB proxy, yields a usable grid — and
 *       EVERY title in that grid is re-opened (/tv/{id}, /movie/{id}) and must
 *       belong to that brand: a series must carry one of the card's networks
 *       (or studios), a film one of its studios. "Tap Cartoon Network, get only
 *       Cartoon Network" is therefore proven title by title, not assumed.
 *
 *  The functions under test are extracted from moviezone.js at runtime, the
 *  same way ott-sections-check.js does it, so this cannot drift from the code
 *  that ships.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');

const ONLINE = process.argv.includes('--online');
const PROXY = process.env.MZ_TMDB_PROXY || 'https://moviezone.dev/api/tmdb';

const src = fs.readFileSync('moviezone.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('providers.css', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failures.push(name + ' - ' + e.message); console.log('  FAIL  ' + name + '\n          ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── extraction helpers (brace / bracket matched, string-literal aware enough
//    for the declarations below, which hold no braces inside strings) ──
function block(marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found in moviezone.js: ' + marker);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) + ';'; }
  }
  throw new Error('unbalanced block: ' + marker);
}
function line(marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found in moviezone.js: ' + marker);
  return src.slice(at, src.indexOf('\n', at));
}
function until(marker, terminator) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found in moviezone.js: ' + marker);
  const end = src.indexOf(terminator, at);
  return src.slice(at, end + terminator.length);
}

const code = [
  line("const CARTOON_GENRE_ANIMATION"), line("const CARTOON_GENRE_KIDS"), line("const CARTOON_GENRE_FAMILY"),
  line("const CARTOON_NET_ALL"), line("const CARTOON_NET_CN"), line("const CARTOON_NET_NICK"),
  line("const CARTOON_NET_DISNEY"), line("const CARTOON_NET_INDIA"), line("const CARTOON_NET_JAPAN"),
  block('const CARTOON_PROVIDERS = {'),
  until('const CARTOON_ICON_IDS = new Set([', ']);'),
  until('const CARTOON_LEGEND_IDS = new Set([', ']);'),
  until('const CARTOON_BLOCK_IDS = new Set([', ']);'),
  line('const CARTOON_BLOCK_RE'), line('const CARTOON_NSFW_RE'), line('const CARTOON_FAMOUS_RE'),
  until('const CARTOON_MODES = [', '];'),
  block('function cartoonISTDate('), block('function cartoonGenreIds('), block('function cartoonTitleOf('),
  block('function isFamousCartoon('), block('function isStrictCartoon('),
  block('function buildCartoonQueries('),
  'this.out = { CARTOON_PROVIDERS, CARTOON_MODES, buildCartoonQueries, isStrictCartoon };'
].join('\n');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { CARTOON_PROVIDERS, CARTOON_MODES, buildCartoonQueries, isStrictCartoon } = sandbox.out;
const providerKeys = Object.keys(CARTOON_PROVIDERS);
const modeIds = new Set(CARTOON_MODES.map(m => m.id));

const cards = [...html.matchAll(/<a class="provider-card cartoon-card"[^>]*>[\s\S]*?<\/a>/g)].map(m => m[0]);
const cardMode = c => (c.match(/data-cartoon-mode="([^"]+)"/) || [])[1];
const cardLogo = c => (c.match(/<img src="([^"]+)"/) || [])[1];

console.log('cartoon providers check');
console.log('--------------------------------------------------------------');

check('the rail ships five cards, one per provider, in a #cartoon-providers section', () => {
  assert(/<section id="cartoon-providers" class="providers-section cartoon-providers"/.test(html), 'section missing');
  assert(cards.length === 5, 'expected 5 cards, found ' + cards.length);
  const modes = cards.map(cardMode);
  assert(new Set(modes).size === modes.length, 'duplicate card modes: ' + modes.join(','));
  assert(modes.slice().sort().join() === providerKeys.slice().sort().join(),
    'cards ' + modes.join(',') + ' do not match CARTOON_PROVIDERS ' + providerKeys.join(','));
});

check('every card opens the Cartoons category with a whitelisted mode', () => {
  cards.forEach(c => {
    assert(/data-provider-cat="kids"/.test(c), 'card without data-provider-cat="kids": ' + cardMode(c));
    assert(modeIds.has(cardMode(c)), 'mode not in CARTOON_MODES: ' + cardMode(c));
    assert(/aria-label="[^"]+"/.test(c), 'card without an accessible name: ' + cardMode(c));
  });
});

check('the click handler only accepts modes from the CARTOON_MODES whitelist', () => {
  assert(/CARTOON_MODES\.some\(m => m\.id === cartoonMode\) \? cartoonMode : 'all'/.test(src),
    'cartoon mode from the DOM is not validated against CARTOON_MODES');
  assert(/\['top-providers', 'cartoon-providers'\]\.forEach/.test(src), 'carousel does not mount the cartoon rail');
});

check('every provider plan is scoped to that brand — no global or trending source', () => {
  providerKeys.forEach(key => {
    [1, 2, 3].forEach(page => {
      const plan = buildCartoonQueries(key, page);
      assert(plan.length >= 4, key + ' p' + page + ': only ' + plan.length + ' requests');
      plan.forEach(q => {
        assert(/^\/discover\/(tv|movie)$/.test(q.endpoint), key + ': non-discover source ' + q.endpoint);
        const p = q.params;
        assert(p.with_networks || p.with_companies || p.with_original_language,
          key + ': unscoped request ' + q.endpoint + ' ' + JSON.stringify(p));
        assert(!p.with_watch_providers, key + ': uses a watch-provider id');
        assert(p.include_adult === 'false', key + ': include_adult is not false');
        assert(q.type === (q.endpoint.endsWith('/tv') ? 'tv' : 'movie'), key + ': type mismatch on ' + q.endpoint);
      });
    });
  });
});

check('the animation gate is applied at source except on the Indian kids-network query', () => {
  providerKeys.forEach(key => {
    buildCartoonQueries(key, 1).forEach(q => {
      const ungatedIndianNets = key === 'desi' && q.params.with_networks;
      if (!ungatedIndianNets) {
        assert(String(q.params.with_genres || '').split(/[,|]/).includes('16'),
          key + ': request without the Animation genre ' + JSON.stringify(q.params));
      }
    });
  });
});

check('paging moves every provider plan forward (no repeated page 1)', () => {
  providerKeys.forEach(key => {
    const p1 = buildCartoonQueries(key, 1).map(q => q.params.page).join();
    const p2 = buildCartoonQueries(key, 2).map(q => q.params.page).join();
    assert(p1 !== p2, key + ': page 2 requests the same pages as page 1');
  });
});

check('the strict cartoon gate still rejects live-action and adult titles', () => {
  assert(!isStrictCartoon({ id: 1, poster_path: '/x', genre_ids: [10762, 35], original_language: 'hi', name: 'Baalveer' }), 'live-action kids show passed');
  assert(!isStrictCartoon({ id: 2, poster_path: '/x', genre_ids: [16, 35], original_language: 'en', name: 'Family Guy' }), 'adult animation passed');
  assert(isStrictCartoon({ id: 3, poster_path: '/x', genre_ids: [16, 10751], original_language: 'en', name: 'Gravity Falls' }), 'real cartoon rejected');
});

check('logos are local, small and inert SVGs', () => {
  cards.forEach(c => {
    const src = cardLogo(c);
    assert(src && /^\/cartoon-[a-z]+\.svg$/.test(src), 'logo is not a local cartoon-*.svg: ' + src);
    const file = src.slice(1);
    assert(fs.existsSync(file), 'missing logo file ' + file);
    const svg = fs.readFileSync(file, 'utf8');
    const kb = Buffer.byteLength(svg) / 1024;
    assert(kb < 16, file + ' is ' + kb.toFixed(1) + ' KB (limit 16 KB)');
    assert(/^<svg[\s>]/.test(svg.trim()), file + ' does not start with <svg>');
    assert(!/<script|<foreignObject|\son[a-z]+\s*=|javascript:/i.test(svg), file + ' contains active content');
    assert(!/(xlink:)?href\s*=\s*"(?!#)/i.test(svg), file + ' references an external resource');
    assert(/width="\d+" height="\d+"/.test(c), file + ' card img has no intrinsic size (CLS)');
  });
});

check('every Cartoons chip has an SVG icon and no emoji (emoji render as boxes on TVs / Windows)', () => {
  CARTOON_MODES.forEach(m => {
    assert(!('icon' in m), 'CARTOON_MODES.' + m.id + ' still carries an emoji icon');
    const rule = css.match(new RegExp('\\.cz-i-' + m.id + '\\{--cz-i:url\\("data:image/svg\\+xml,([^"]+)"\\)\\}'));
    assert(rule, 'no .cz-i-' + m.id + ' icon rule in providers.css');
    const svg = decodeURIComponent(rule[1]);
    assert(/^<svg[^>]*viewBox='0 0 24 24'/.test(svg), '.cz-i-' + m.id + ' is not a 24x24 SVG');
    assert(!/<script|\son[a-z]+=|href=/i.test(svg), '.cz-i-' + m.id + ' contains active content');
  });
  assert(/class="anime-chip-icon cz-i cz-i-\$\{m\.id\}"/.test(src), 'chip renderer does not emit the cz-i icon class');
  assert(/@supports \(\(-webkit-mask-size: contain\) or \(mask-size: contain\)\)/.test(css), 'icons are not guarded by @supports');
});

check('sw.js precaches every logo and providers.css brand-lights every card', () => {
  cards.forEach(c => {
    const src = cardLogo(c);
    assert(sw.includes("'" + src + "'"), 'sw.js does not precache ' + src);
    assert(css.includes('#cartoon-providers [data-cartoon-mode="' + cardMode(c) + '"]'), 'no --pv brand colour for ' + cardMode(c));
  });
});

async function getJSON(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (r.status !== 429 && r.status < 500) throw new Error('HTTP ' + r.status + ' for ' + url);
    await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
  }
  throw new Error('gave up on ' + url);
}

/*  Small worker pool: hundreds of detail lookups, a handful at a time, so the
 *  live proxy is never hammered. */
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const ids = s => new Set(String(s || '').split('|').filter(Boolean).map(Number));

async function online() {
  const enc = p => Object.entries(p).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  for (const key of providerKeys) {
    const cfg = CARTOON_PROVIDERS[key];
    const plan = buildCartoonQueries(key, 1);
    const seen = new Map();
    for (const q of plan) {
      const data = await getJSON(PROXY + q.endpoint + '?' + enc(q.params));
      (data.results || []).forEach(raw => {
        const item = Object.assign({}, raw, { media_type: q.type });
        if (isStrictCartoon(item)) seen.set(q.type + '-' + item.id, item);
      });
    }
    const items = [...seen.values()];
    const tv = items.filter(m => m.media_type === 'tv').length;
    console.log('          ' + key.padEnd(11) + items.length + ' usable cards (' + tv + ' series, ' + (items.length - tv) + ' films)');
    assert(items.length >= 40, key + ': only ' + items.length + ' usable cards on page 1 (floor 40)');

    // Title-by-title brand proof.
    const nets = ids(cfg.net), tvCos = ids(cfg.tvCo), movieCos = ids(cfg.movieCo);
    const langs = new Set(String(cfg.langs || '').split('|').filter(Boolean));
    const strays = (await pool(items, 6, async m => {
      const d = await getJSON(PROXY + '/' + m.media_type + '/' + m.id + '?language=en-US');
      const dNets = (d.networks || []).map(n => n.id);
      const dCos = (d.production_companies || []).map(c => c.id);
      let ok;
      if (m.media_type === 'tv') {
        ok = dNets.some(n => nets.has(n)) || dCos.some(c => tvCos.has(c)) || langs.has(d.original_language);
      } else {
        ok = dCos.some(c => movieCos.has(c)) || langs.has(d.original_language);
      }
      return ok ? null : (m.name || m.title) + ' [' + m.media_type + ' ' + m.id + ']';
    })).filter(Boolean);
    console.log('          ' + ' '.repeat(11) + 'brand-verified ' + (items.length - strays.length) + '/' + items.length);
    assert(!strays.length, key + ': titles outside the brand: ' + strays.join(', '));
  }
}

(async () => {
  if (ONLINE) {
    console.log('-- live catalogue depth (' + PROXY + ') --');
    try { await online(); passed++; console.log('  PASS  every provider fills a grid, and every title is verified to belong to that brand'); }
    catch (e) { failures.push('live catalogue - ' + e.message); console.log('  FAIL  live catalogue\n          ' + e.message); }
  }
  console.log('==============================================================');
  console.log('  cartoon-providers-check: ' + passed + ' passed, ' + failures.length + ' failed');
  failures.forEach(f => console.log('   x ' + f));
  console.log('==============================================================');
  process.exit(failures.length ? 1 : 0);
})();
