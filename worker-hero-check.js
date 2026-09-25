/*  ═══════════════════════════════════════════════════════════════════════════
 *  WORKER HERO PRELOAD — the homepage LCP hint is resolved at the edge
 *  ═══════════════════════════════════════════════════════════════════════════
 *
 *  WHAT WENT WRONG, AND WHY A TEST EXISTS FOR IT NOW
 *
 *  index.html ships a hard-coded hero backdrop preload at fetchpriority=high,
 *  written into the delimited MZ_PERF_HEAD block by heroPreloadTag() in
 *  seo-ssr.js. It is supposed to be refreshed nightly by .github/workflows/
 *  seo-refresh.yml. It never was: there is not one seo-refresh[bot] commit in the
 *  repository's history, so the value that shipped was whatever somebody typed.
 *
 *  Checked against the live API, the backdrop in the file was not in
 *  /trending/movie/week at all - not at [0], not anywhere on the page. That made
 *  the preload actively harmful in two compounding ways:
 *
 *    1. 80-160 KB was fetched at the HIGHEST image priority, on the visitor's
 *       mobile connection, for an image no slide would ever display - competing
 *       with the stylesheet, the bundle and the real LCP image.
 *    2. pinPreloadedHero() in moviezone.js pins slide 0 by MATCHING the <meta
 *       name="mz-hero-backdrop"> value against the candidates. A backdrop that is
 *       no longer in the data cannot match, so slide 0 fell through to the
 *       editorial pin - a different image, which could not even be REQUESTED
 *       until the bundle had parsed and the batch had returned.
 *
 *  So the LCP element was never the preloaded one. The whole mechanism was
 *  inverted: it was spending the visitor's bandwidth to slow down their LCP.
 *
 *  It cannot be fixed durably in the file, because the file is the output of a
 *  job that does not run. worker.js resolves it at the edge instead, from the KV
 *  copy it already holds, and the rewritten document is what gets stored in
 *  caches.default - so the cost is paid once per cache generation, not per
 *  request. These checks hold that behaviour in place.
 *
 *  ON THE HTMLRewriter SHIM
 *  HTMLRewriter is a Workers runtime global with no Node equivalent, so it is
 *  stubbed here. The shim is deliberately dumb - it does attribute get/set on
 *  matched tags and nothing else - because what is being tested is the WORKER's
 *  decisions, and those are all decisions the shim cannot make for it: which
 *  selector to register, that the local /moviezone-logo.webp preload on the same
 *  selector must be left alone, and which width belongs to which media query.
 *  `wrangler deploy --dry-run` is what proves HTMLRewriter itself resolves in the
 *  real runtime.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const WORKER_FILE = path.join(__dirname, 'worker.js');
const HOME_FILE = path.join(__dirname, 'index.html');

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + label);
  } catch (err) {
    failures.push(label + ' - ' + err.message);
    console.log('  FAIL  ' + label + '\n          ' + err.message);
  }
}

/*  The backdrop the stubbed TMDB answers with. Deliberately NOT the one in
 *  index.html: the whole point is that the file is stale, so a test that used the
 *  shipped value could pass while the rewrite did nothing at all. */
const LIVE_BACKDROP = '/zzTestLiveBackdrop123.jpg';
const SHIPPED_BACKDROP =
  (fs.readFileSync(HOME_FILE, 'utf8')
    .match(/<meta name="mz-hero-backdrop" content="([^"]+)"/) || [])[1];

// ── minimal HTMLRewriter over the tag shapes the Worker registers ────────────
/*  Supports exactly what worker.js uses: a single tag compound with attribute
 *  equality predicates, optionally scoped by one ancestor compound ("E F"). The
 *  ancestor's extent is found by balancing its own tag name, so the scoping is
 *  real rather than a hard-coded window. Anything beyond that - text handlers,
 *  replace(), streaming semantics - is out of scope by design: this shim exists so
 *  the WORKER's decisions can be asserted, and every decision that matters here
 *  (which selector, the TMDB-href guard, which width per media query) is one the
 *  shim cannot make on its behalf.
 */
function makeHTMLRewriter() {
  const parseCompound = (compound) => ({
    tag: (compound.match(/^[a-zA-Z][\w-]*/) || ['*'])[0],
    attrs: [...compound.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)]
      .map((m) => [m[1], m[2] === undefined ? null : m[2]])
  });
  const attrsOf = (openTag) =>
    new Map([...openTag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)]
      .slice(1)   // drop the tag name itself
      .map((m) => [m[1], m[2] === undefined ? '' : m[2]]));
  const matches = (openTag, compound) => {
    if (compound.tag !== '*' && !new RegExp('^<' + compound.tag + '\\b', 'i').test(openTag)) {
      return false;
    }
    const attrs = attrsOf(openTag);
    return compound.attrs.every(([k, v]) =>
      attrs.has(k) && (v === null || attrs.get(k) === v));
  };

  /** [start, end) of the element opening at `from`, by balancing its tag name. */
  function extentOf(html, from, tag) {
    const open = new RegExp('<' + tag + '\\b', 'gi');
    const close = new RegExp('</' + tag + '\\s*>', 'gi');
    let depth = 0;
    let i = from;
    while (i < html.length) {
      open.lastIndex = i; close.lastIndex = i;
      const o = open.exec(html);
      const c = close.exec(html);
      if (!c) return [from, html.length];
      if (o && o.index < c.index) { depth++; i = o.index + 1; continue; }
      depth--;
      if (depth === 0) return [from, c.index + c[0].length];
      i = c.index + 1;
    }
    return [from, html.length];
  }

  return class HTMLRewriter {
    constructor() { this.handlers = []; }
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    transform(response) {
      const self = this;
      const rewritten = response.text().then((html) => {
        for (const [selector, handler] of self.handlers) {
          const compounds = selector.trim().split(/\s+(?![^[]*\])/).map(parseCompound);
          const target = compounds[compounds.length - 1];
          const ancestor = compounds.length > 1 ? compounds[0] : null;

          // Regions this selector may act on.
          const regions = [];
          if (!ancestor) {
            regions.push([0, html.length]);
          } else {
            const scan = /<([a-zA-Z][\w-]*)\b[^>]*>/g;
            let m;
            while ((m = scan.exec(html))) {
              if (matches(m[0], ancestor)) regions.push(extentOf(html, m.index, m[1]));
            }
          }

          const edits = [];
          for (const [rStart, rEnd] of regions) {
            const slice = html.slice(rStart, rEnd);
            const scan = /<[a-zA-Z][\w-]*\b[^>]*>/g;
            let m;
            while ((m = scan.exec(slice))) {
              const openTag = m[0];
              if (!matches(openTag, target)) continue;
              const attrs = attrsOf(openTag);
              const tag = openTag.match(/^<([a-zA-Z][\w-]*)/)[1];
              let changed = false;
              handler.element({
                getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
                setAttribute: (n, v) => { attrs.set(n, v); changed = true; },
                hasAttribute: (n) => attrs.has(n)
              });
              if (!changed) continue;
              edits.push([rStart + m.index, rStart + m.index + openTag.length,
                '<' + tag + ' '
                  + [...attrs].map(([k, v]) => (v === '' ? k : k + '="' + v + '"')).join(' ')
                  + (/\/>$/.test(openTag) ? '/>' : '>')]);
            }
          }
          // Applied back-to-front so earlier offsets stay valid.
          edits.sort((a, b) => b[0] - a[0]);
          for (const [s, e, text] of edits) html = html.slice(0, s) + text + html.slice(e);
        }
        return html;
      });
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(await rewritten));
            controller.close();
          }
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers }
      );
    }
  };
}

function fakeCaches() {
  const store = new Map();
  return {
    store,
    default: {
      async match(request) {
        const hit = store.get(typeof request === 'string' ? request : request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        store.set(typeof request === 'string' ? request : request.url, response.clone());
      }
    }
  };
}

function makeCtx() {
  const pending = [];
  return {
    ctx: { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } },
    settle: () => Promise.all(pending.splice(0))
  };
}

/** A KV double that records reads/writes so SWR behaviour is observable. */
function fakeKv() {
  const store = new Map();
  return {
    store,
    async getWithMetadata(key) {
      const hit = store.get(key);
      return hit ? { value: hit.value, metadata: hit.metadata } : { value: null, metadata: null };
    },
    async get(key) { const hit = store.get(key); return hit ? hit.value : null; },
    async put(key, value, opts) {
      store.set(key, { value, metadata: (opts && opts.metadata) || null });
    }
  };
}

(async () => {
  console.log('\nWorker hero preload - resolved at the edge, not pinned in the file');
  console.log('-'.repeat(74));

  const source = fs.readFileSync(WORKER_FILE, 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g,
      (_m, file) => "from '" + pathToFileURL(path.join(__dirname, file)).href + "'");
  const worker = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );

  global.HTMLRewriter = makeHTMLRewriter();
  const realFetch = global.fetch;

  const homeHtml = fs.readFileSync(HOME_FILE, 'utf8');

  /** Runs one GET / through the real handler. */
  async function getHome(opts) {
    const options = opts || {};
    const cacheLayer = fakeCaches();
    global.caches = cacheLayer;
    const { ctx, settle } = makeCtx();

    let tmdbCalls = 0;
    global.fetch = async (input) => {
      const href = typeof input === 'string' ? input : input.url;
      if (href.indexOf('api.themoviedb.org') !== -1) {
        tmdbCalls++;
        if (options.tmdbFails) return new Response('upstream down', { status: 503 });
        if (options.tmdbHangs) { await new Promise((r) => setTimeout(r, 3000)); }
        return new Response(
          JSON.stringify({ results: [{ id: 1, title: 'Live Pick', backdrop_path: LIVE_BACKDROP }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return realFetch(input);
    };

    const env = {
      TMDB_TOKEN: 'test-token',
      TMDB_CACHE: options.kv || fakeKv(),
      ASSETS: {
        async fetch() {
          return new Response(homeHtml, {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              // The validator env.ASSETS attaches. It describes the ORIGINAL
              // bytes, which is exactly why the Worker has to drop it.
              ETag: '"assets-index-html"',
              'Last-Modified': 'Thu, 25 Sep 2026 00:00:00 GMT'
            }
          });
        }
      }
    };

    const started = Date.now();
    const response = await worker.default.fetch(
      new Request('https://moviezone.dev/'), env, ctx
    );
    /*  Measured on the RESPONSE, before settle(). settle() awaits the ctx.waitUntil
     *  promises, and the hero fetch is deliberately one of them - so timing around
     *  settle() would measure the background work the budget exists to escape and
     *  report a pass as a failure. */
    const responseMs = Date.now() - started;
    const body = await response.text();
    await settle();
    return { response, body, cacheLayer, tmdbCalls, env, responseMs };
  }

  // ── 1. the happy path ──────────────────────────────────────────────────────
  const live = await getHome();

  check('the stale backdrop in index.html is gone from the served document', () => {
    assert.ok(SHIPPED_BACKDROP, 'index.html has no mz-hero-backdrop meta to begin with');
    assert.ok(!live.body.includes(SHIPPED_BACKDROP),
      'the document still carries ' + SHIPPED_BACKDROP + ', so the rewrite did nothing');
  });

  check('<meta name="mz-hero-backdrop"> carries the live backdrop', () => {
    const meta = (live.body.match(/<meta[^>]*name="mz-hero-backdrop"[^>]*>/) || [])[0] || '';
    assert.ok(meta.includes('content="' + LIVE_BACKDROP + '"'),
      'pinPreloadedHero() reads this value to pin slide 0; it is: ' + meta);
  });

  check('the mobile preload asks for w780 and the wide one for w1280', () => {
    const hints = [...live.body.matchAll(/<link[^>]*rel="preload"[^>]*as="image"[^>]*>/g)]
      .map((m) => m[0])
      .filter((t) => t.includes('image.tmdb.org'));
    assert.strictEqual(hints.length, 2, 'expected exactly 2 TMDB image preloads, got ' + hints.length);
    const mobile = hints.find((t) => t.includes('max-width: 1024px'));
    const wide = hints.find((t) => t.includes('min-width: 1025px'));
    assert.ok(mobile && mobile.includes('/t/p/w780' + LIVE_BACKDROP),
      'the phone branch is not w780 of the live backdrop: ' + mobile);
    assert.ok(wide && wide.includes('/t/p/w1280' + LIVE_BACKDROP),
      'the desktop branch is not w1280 of the live backdrop: ' + wide);
  });

  check('the local logo preload on the same selector is untouched', () => {
    /*  The Worker's selector is link[rel="preload"][as="image"], which also
     *  matches /moviezone-logo.webp. Rewriting that would 404 the nav and loader
     *  logo - the href guard in rewriteHeroPreload() is what prevents it. */
    assert.ok(live.body.includes('href="/moviezone-logo.webp"'),
      'the 7 KB local logo preload was rewritten or dropped');
  });

  check('the server-rendered slide 0 shows the same backdrop it preloaded', () => {
    /*  THE PAIRING IS THE POINT. injectHeroSlide() emits slide 0 statically so the
     *  parser has an LCP element immediately, and heroPreloadTag() hints the same
     *  URL so that element is a cache hit. If the rewrite updated the hint but not
     *  the slide, the browser would preload the live backdrop, paint the STALE one
     *  as LCP, and then download the live one a third time when buildCarousel()
     *  replaced the slide - strictly worse than the bug being fixed. */
    const slide = (live.body.match(/<!--MZ_HERO_SLIDE-->[\s\S]*?<\/picture>/) || [])[0];
    assert.ok(slide, 'the MZ_HERO_SLIDE block is gone from index.html');
    assert.ok(!slide.includes(SHIPPED_BACKDROP),
      'slide 0 still renders the stale backdrop, so the LCP element and the '
        + 'preload disagree');
    const sources = [...slide.matchAll(/<source[^>]*>/g)].map((m) => m[0]);
    assert.strictEqual(sources.length, 2, 'expected 2 <source> branches in the hero <picture>');
    assert.ok(sources.some((s) => s.includes('max-width: 1024px') && s.includes('w780' + LIVE_BACKDROP)),
      'the phone <source> is not w780 of the live backdrop');
    assert.ok(sources.some((s) => s.includes('min-width: 1025px') && s.includes('w1280' + LIVE_BACKDROP)),
      'the desktop <source> is not w1280 of the live backdrop');
    assert.ok(/<img[^>]*src="[^"]*w1280\/zzTestLiveBackdrop123\.jpg"/.test(slide),
      'the <picture> fallback <img> - the LCP element itself - was not rewritten');
  });

  check('the hero URL is identical in the hint and in the slide', () => {
    // One backdrop, one download. Any drift here is a second full-size image.
    const urls = new Set(
      [...live.body.matchAll(/https:\/\/image\.tmdb\.org\/t\/p\/(w780|w1280)(\/[\w.-]+)/g)]
        .map((m) => m[2])
    );
    assert.deepStrictEqual([...urls], [LIVE_BACKDROP],
      'more than one backdrop path is referenced: ' + [...urls].join(', '));
  });

  check('the hero goes out as media-scoped Early Hints too', () => {
    const link = live.response.headers.get('Link') || '';
    assert.ok(link.includes('rel=preconnect'), 'the image.tmdb.org preconnect hint was lost');
    assert.ok(link.includes('w780' + LIVE_BACKDROP) && link.includes('media="(max-width: 1024px)"'),
      'no media-scoped w780 preload hint: ' + link);
    assert.ok(link.includes('w1280' + LIVE_BACKDROP) && link.includes('media="(min-width: 1025px)"'),
      'no media-scoped w1280 preload hint: ' + link);
  });

  check('the asset validator is dropped once the body is rewritten', () => {
    /*  env.ASSETS' ETag describes index.html as stored, and those are no longer
     *  the bytes being sent. Left in place a client could revalidate its way back
     *  into a document pinning last week's backdrop, and two hero generations
     *  would collapse onto one cache entry. */
    assert.strictEqual(live.response.headers.get('ETag'), null,
      'the ETag still describes the un-rewritten asset');
    assert.strictEqual(live.response.headers.get('Last-Modified'), null,
      'Last-Modified still describes the un-rewritten asset');
  });

  check('the rewritten document is what gets stored at the edge', () => {
    assert.strictEqual(live.cacheLayer.store.size, 1,
      'expected exactly one edge entry, got ' + live.cacheLayer.store.size);
  });

  check('the document is still the homepage, not just the head', () => {
    // Cheap shape guard: a rewrite bug that truncated the stream would pass every
    // assertion above, because all of them look only at <head>.
    assert.ok(live.body.includes('</html>'), 'the response body was truncated');
    assert.ok(live.body.length > homeHtml.length - 512,
      'the body lost ' + (homeHtml.length - live.body.length) + ' bytes in the rewrite');
  });

  // ── 2. TMDB is down ───────────────────────────────────────────────────────
  const broken = await getHome({ tmdbFails: true });

  check('a TMDB fault serves the page rather than failing it', () => {
    assert.strictEqual(broken.response.status, 200,
      'the homepage 500s when the hero cannot be resolved');
    assert.ok(broken.body.includes('</html>'), 'the body is incomplete');
  });

  check('a page whose hero did not resolve is NOT cached at the edge', () => {
    /*  This is the guard that matters most. Storing the pass-through would pin the
     *  stale hard-coded preload for the full s-maxage=3600 - turning a transient
     *  KV miss into an hour of the exact bug this code removes. */
    assert.strictEqual(broken.cacheLayer.store.size, 0,
      'the un-rewritten homepage was cached, so the stale preload is now pinned at '
        + 'the edge for an hour');
  });

  check('no Early Hint is emitted for a hero that does not exist', () => {
    const link = broken.response.headers.get('Link') || '';
    assert.ok(!link.includes('rel=preload'),
      'a preload hint was sent for an unresolved hero: ' + link);
  });

  // ── 3. a slow upstream must not hold the document ─────────────────────────
  const slowKv = fakeKv();
  const slow = await getHome({ tmdbHangs: true, kv: slowKv });

  check('a hanging upstream cannot hold the homepage past its budget', () => {
    /*  HERO_RESOLVE_BUDGET_MS is 400. The upstream here takes 3s, which is what
     *  TMDB_TIMEOUT_MS alone would allow. Nobody's homepage should wait 3s for a
     *  preload hint. Generous ceiling so this is not a flake on a loaded machine. */
    assert.ok(slow.responseMs < 2000,
      'the homepage response took ' + slow.responseMs + 'ms, so it is waiting on the '
        + 'hero fetch instead of racing it');
    assert.strictEqual(slow.response.status, 200, 'the slow path did not serve a page');
  });

  check('the abandoned fetch still warms KV for the next request', () => {
    /*  ctx.waitUntil keeps it alive past the response. Without that every visitor
     *  would time out forever and the hero would never resolve at all. */
    assert.ok(slowKv.store.size > 0,
      'nothing was written to KV, so the next request is just as cold');
  });

  global.fetch = realFetch;
  delete global.caches;
  delete global.HTMLRewriter;

  console.log('-'.repeat(74));
  console.log('  worker-hero-check: ' + passed + ' passed, ' + failures.length + ' failed\n');
  if (failures.length) process.exit(1);
})().catch((err) => {
  console.error('\nharness error:', err && err.stack);
  process.exit(1);
});
