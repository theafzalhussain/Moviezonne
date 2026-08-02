'use strict';

/*  Verifies the OTT platform tabs against the live TMDB API:
 *   • the ids resolve to the right platform (spot-checked by title)
 *   • each tab has enough depth for the infinite scroll to keep going
 *   • each scroll step yields genuinely NEW titles, not repeats
 *
 *  Run: node ott-check.js
 */

const http = require('http');
const assert = require('assert');
const app = require('./server');

// Mirrors the OTT table and ottQueries() in moviezone.js.
const OTT = {
  netflix:    { provider: '8',    regions: ['IN', 'US'], networks: '213' },
  prime:      { provider: '119',  regions: ['IN'],       networks: '1024', providerUS: '9' },
  jiohotstar: { provider: '2336', regions: ['IN'],       networks: '3919' },
  zee5:       { provider: '232',  regions: ['IN'],       networks: '2590|526|6989' }
};

function ottQueries(key, p1, p2) {
  const cfg = OTT[key];
  const base = { sort_by: 'popularity.desc', language: 'en-US' };
  const out = [];
  [p1, p2].forEach((page) => {
    out.push({ endpoint: '/discover/tv', type: 'tv', params: Object.assign({}, base, { with_watch_providers: cfg.provider, watch_region: 'IN', page }) });
    out.push({ endpoint: '/discover/movie', type: 'movie', params: Object.assign({}, base, { with_watch_providers: cfg.provider, watch_region: 'IN', page }) });
  });
  if (cfg.networks) out.push({ endpoint: '/discover/tv', type: 'tv', params: Object.assign({}, base, { with_networks: cfg.networks, page: p1 }) });
  if (cfg.regions.includes('US')) out.push({ endpoint: '/discover/movie', type: 'movie', params: Object.assign({}, base, { with_watch_providers: cfg.providerUS || cfg.provider, watch_region: 'US', page: p1 }) });
  return out;
}

function api(server, endpoint, params) {
  const qs = Object.entries(params || {}).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/tmdb' + endpoint + (qs ? '?' + qs : '') }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 150))); } });
    }).on('error', reject);
  });
}

let pass = 0;
let fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log('    PASS  ' + label); }
  catch (e) { fail++; console.log('    FAIL  ' + label + '\n            ' + e.message); }
}

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

  // Same post-filter loadMovies() applies before rendering.
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const usable = (m) => {
    if (!m.poster_path) return false;
    const d = m.release_date || m.first_air_date;
    if (!d) return (m.vote_count || 0) > 50;
    return d <= today;
  };

  for (const key of Object.keys(OTT)) {
    console.log('\n=== ' + key.toUpperCase() + ' ===');

    // Depth: how many pages does TMDB say exist for the provider filter?
    const tvDepth = await api(server, '/discover/tv', { with_watch_providers: OTT[key].provider, watch_region: 'IN', sort_by: 'popularity.desc', page: '1', language: 'en-US' });
    const mvDepth = await api(server, '/discover/movie', { with_watch_providers: OTT[key].provider, watch_region: 'IN', sort_by: 'popularity.desc', page: '1', language: 'en-US' });
    console.log('  catalogue depth: ' + tvDepth.total_results + ' series over ' + tvDepth.total_pages
      + ' pages, ' + mvDepth.total_results + ' movies over ' + mvDepth.total_pages + ' pages');

    check('provider returns a non-trivial catalogue', () => {
      assert.ok(tvDepth.total_results + mvDepth.total_results > 200,
        'only ' + (tvDepth.total_results + mvDepth.total_results) + ' titles total');
    });

    // Simulate three infinite-scroll steps exactly as loadMovies does.
    const seen = new Set();
    const perStep = [];
    for (let pageNum = 1; pageNum <= 3; pageNum++) {
      const p1 = String(pageNum * 2 - 1);
      const p2 = String(pageNum * 2);
      const queries = ottQueries(key, p1, p2);
      const results = await Promise.all(queries.map((q) => api(server, q.endpoint, q.params).catch(() => ({ results: [] }))));

      let fresh = 0;
      results.forEach((r, i) => {
        (r.results || []).forEach((item) => {
          if (!usable(item)) return;
          const k = queries[i].type + '-' + item.id;
          if (seen.has(k)) return;
          seen.add(k);
          fresh++;
        });
      });
      perStep.push(fresh);
    }

    console.log('  new titles per scroll step: ' + perStep.join(' → ') + '   (cumulative ' + seen.size + ')');

    check('first load fills the grid', () => {
      assert.ok(perStep[0] >= 24, 'first step produced only ' + perStep[0] + ' cards, grid shows 24');
    });
    check('scroll steps 2 and 3 keep adding new titles', () => {
      assert.ok(perStep[1] >= 15, 'step 2 added only ' + perStep[1]);
      assert.ok(perStep[2] >= 15, 'step 3 added only ' + perStep[2]);
    });

    // Spot-check that the catalogue actually looks like this platform.
    const sample = (tvDepth.results || []).slice(0, 5).map((s) => s.name);
    console.log('  sample series: ' + sample.join(', '));
    check('returns real titles, not an empty or junk list', () => {
      assert.ok(sample.length >= 3, 'only ' + sample.length + ' series returned');
      assert.ok(!sample.some((n) => /PBS|Fishing|Azteca|Imedi/i.test(n)), 'junk network content present: ' + sample.join(', '));
    });
  }

  // Regression: the retired ids must no longer be referenced anywhere.
  console.log('\n=== regression: retired/bogus ids removed from moviezone.js ===');
  const src = require('fs').readFileSync('moviezone.js', 'utf8');
  check('provider/network 122 no longer used', () => {
    assert.ok(!/with_watch_providers:\s*'122'/.test(src), "with_watch_providers '122' still present");
    assert.ok(!/with_networks:\s*'122'/.test(src), "with_networks '122' still present");
  });
  check('the old junk network list is gone', () => {
    assert.ok(!/213\|1024\|122\|3295\|3009/.test(src), 'old STREAMING_NETWORKS string still present');
  });
  check('non-existent network ids are gone', () => {
    ['2600', '2212', '2694', '3321', '3328'].forEach((id) => {
      assert.ok(!new RegExp("\\|" + id + "\\||'" + id + "\\|").test(src), 'dead network id ' + id + ' still referenced');
    });
  });
  check('zee5 wired into headings and the OTT table', () => {
    assert.ok(/zee5:\s*\{/.test(src), 'zee5 missing from the OTT table');
    assert.ok(/zee5:'ZEE5/.test(src), 'zee5 missing from CAT_HEADINGS');
  });
  check('zee5 tab present in index.html', () => {
    const html = require('fs').readFileSync('index.html', 'utf8');
    assert.ok(/filterCat\('zee5'\)/.test(html), 'no Zee5 tab button');
  });

  await new Promise((r) => server.close(r));
  console.log('\n' + '='.repeat(58));
  console.log('  ott-check: ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(58) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
