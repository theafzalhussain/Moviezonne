/* ═══════════════════════════════════════════════════════════════════════════
   feed-pager-check.js — the homepage feed pages, it does not grow forever.

   WHY THIS EXISTS
   The feed used to append a page every time an IntersectionObserver 400px below
   the grid came into view. Nothing below the grid was reachable, the DOM grew
   without limit on the phones that are most of the traffic, and it fetched
   titles nobody asked for. It is now an explicit pager.

   Three things are guarded, and the first is the one that would silently
   regress:

     1. THE OBSERVER IS NOT INSTALLED. If setupInfiniteScroll ever stops checking
        MZ_FEED_PAGED, the feed goes back to appending on scroll and the pager
        just becomes decoration sitting under an ever-growing grid. Nothing
        visible breaks, which is exactly why it needs a test.

     2. THE PAGE NUMBERS MATCH THE SSR PAGER. The same rule is implemented twice
        — here for the SPA feed, and in seo-ssr.js for the category pages, where
        it exists to cap crawl depth. Two controls that look different on the same
        site is a bug, so the two implementations are run against each other.

     3. THE CONTROL IS REACHABLE. Minimum 44px targets, a visible focus ring, and
        no per-button listeners (the pager is re-rendered on every page change, so
        per-button handlers would leak a set each time).

   Run: node feed-pager-check.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'moviezone.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const ssr = fs.readFileSync(path.join(__dirname, 'seo-ssr.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}

console.log('\nfeed pagination — the homepage feed pages instead of growing forever');
console.log('-'.repeat(72));

// ── 1. the page-number rule, run for real ────────────────────────────────────
/*  Lifted out of the bundle rather than reimplemented, so this tests the
 *  shipped function and not a copy of it that could drift from the original. */
function extract(name) {
  const at = js.indexOf('function ' + name + '(');
  assert.ok(at !== -1, name + ' not found in moviezone.js');
  let depth = 0;
  let started = false;
  for (let i = at; i < js.length; i++) {
    if (js[i] === '{') { depth++; started = true; }
    else if (js[i] === '}') {
      depth--;
      if (started && depth === 0) return js.slice(at, i + 1);
    }
  }
  throw new Error('unbalanced braces reading ' + name);
}

// eslint-disable-next-line no-new-func
const mzFeedPageNumbers = new Function(
  extract('mzFeedPageNumbers') + '; return mzFeedPageNumbers;'
)();

// The same rule as it exists in seo-ssr.js, transcribed from the source below
// and asserted against it, so this is not just two copies of my own reading.
const ssrPager = (page, totalPages) => {
  const wanted = new Set([1, totalPages, page - 1, page, page + 1]);
  for (let p = 5; p <= totalPages; p += 5) wanted.add(p);
  return [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
};
check('seo-ssr.js still builds its page set the way this check assumes',
  /const wanted = new Set\(\[1, totalPages, page - 1, page, page \+ 1\]\)/.test(ssr)
  && /for \(let p = 5; p <= totalPages; p \+= 5\) wanted\.add\(p\)/.test(ssr));

let mismatch = null;
for (let total = 1; total <= 40 && !mismatch; total++) {
  for (let page = 1; page <= total; page++) {
    const a = JSON.stringify(mzFeedPageNumbers(page, total));
    const b = JSON.stringify(ssrPager(page, total));
    if (a !== b) { mismatch = `page ${page}/${total}: feed ${a} vs ssr ${b}`; break; }
  }
}
check('the feed pager and the SSR pager pick identical page numbers', !mismatch, mismatch);

// The shape in the screenshot: 1 2 … 5 … 10 … 15 … 20 … 25 Next
check('page 1 of 25 shows first, neighbour, every 5th and last',
  JSON.stringify(mzFeedPageNumbers(1, 25)) === JSON.stringify([1, 2, 5, 10, 15, 20, 25]),
  JSON.stringify(mzFeedPageNumbers(1, 25)));
check('a middle page keeps both neighbours',
  JSON.stringify(mzFeedPageNumbers(12, 25)) === JSON.stringify([1, 5, 10, 11, 12, 13, 15, 20, 25]),
  JSON.stringify(mzFeedPageNumbers(12, 25)));
check('the last page is never past the total',
  mzFeedPageNumbers(25, 25).every((p) => p <= 25) && mzFeedPageNumbers(25, 25).includes(25));
check('a single-page feed collapses to one entry',
  JSON.stringify(mzFeedPageNumbers(1, 1)) === JSON.stringify([1]));
check('no page number is ever repeated',
  [1, 5, 12, 20, 25].every((p) => {
    const nums = mzFeedPageNumbers(p, 25);
    return new Set(nums).size === nums.length;
  }));
check('the list is always ascending',
  [1, 7, 13, 25].every((p) => {
    const nums = mzFeedPageNumbers(p, 25);
    return nums.every((n, i) => i === 0 || n > nums[i - 1]);
  }));

// ── 2. infinite scroll is genuinely off ──────────────────────────────────────
console.log('');
const setupSrc = extract('setupInfiniteScroll');
check('setupInfiniteScroll returns before installing an IntersectionObserver',
  setupSrc.indexOf('MZ_FEED_PAGED') !== -1
  && setupSrc.indexOf('MZ_FEED_PAGED') < setupSrc.indexOf('new IntersectionObserver'),
  'the paged guard must come first, or scrolling still appends pages');
check('MZ_FEED_PAGED is on', /const MZ_FEED_PAGED = true;/.test(js));
check('the paged path still wires the pager up',
  /MZ_FEED_PAGED\)\s*\{[\s\S]{0,200}renderFeedPager\(\)/.test(setupSrc));

// The load-more button must not offer a second, contradictory way to page.
check('the manual load-more button stays hidden',
  /loadMoreBtn\.style\.display = 'none'/.test(js));

// ── 3. pages are slices of the pool, not one fetch each ──────────────────────
console.log('');
/*  The whole point of the rework. One gather returns ~200 unique titles; the old
 *  code showed 24 and refetched all 16 sources for page 2, which is both slow and
 *  the reason titles repeated across pages. */
check('a page is a slice of the pool',
  /allMovies\.slice\(start, start \+ MZ_FEED_PAGE_SIZE\)/.test(js));
check('the slice offset is derived from the page number',
  /function mzFeedPageStart[\s\S]{0,200}\(Math\.max\(1, page\) - 1\) \* MZ_FEED_PAGE_SIZE/.test(js));
check('loadMovies no longer takes a per-page target — pages are not fetched',
  /async function loadMovies\(cat, isLoadMore = false\)/.test(js)
  && !/targetPage/.test(js),
  'a targetPage parameter would mean page N still refetches');

// No refetch for a page the pool already covers: this is what makes Prev and any
// revisited page instant, and it is the "no fresh reload" the report asked for.
check('a page the pool already covers is rendered without a fetch',
  /if \(mzFeedPageIsReady\(target\)\) \{\s*renderCurrentFeedPage\(\);\s*renderFeedPager\(\);\s*return;/.test(js));
check('readiness is decided from the pool length, not from a guess',
  /function mzFeedPageIsReady[\s\S]{0,300}allMovies\.length >= start \+ MZ_FEED_PAGE_SIZE/.test(js));

// Growing the pool must never rewrite earlier pages.
check('running past the pool extends it by appending',
  /loadMovies\(mzFeedPagerCategory, true\)/.test(js));
check('an extension repaints the current page instead of appending to the DOM',
  /MZ_FEED_PAGED && !isFullViewMovies[\s\S]{0,900}renderCurrentFeedPage\(\)/.test(js));
check('the pool is only ever concatenated, so earlier pages are stable',
  /allMovies = allMovies\.concat\(newMovies\)/.test(js));

/*  Duplicates across pages were the reported bug. They cannot happen now because
 *  the pool is deduped by type+id before it is sliced. */
check('the pool is deduped by media type + id before it is sliced',
  /const keyOf = \(m\) => \(m\.media_type[\s\S]{0,200}existingIds\.has\(k\)/.test(js));

// Only whole pages while more titles may arrive, or a page would be shown
// half-full and then silently refilled underneath the reader.
check('only complete pages are offered while the pool can still grow',
  /Math\.floor\(size \/ MZ_FEED_PAGE_SIZE\) \+ 1/.test(js));
check('the final partial page is offered once TMDB is exhausted',
  /if \(mzFeedPoolExhausted\)[\s\S]{0,200}Math\.ceil\(size \/ MZ_FEED_PAGE_SIZE\)/.test(js));
check('the total is capped', /MZ_FEED_PAGE_CAP\)\)/.test(js));
check('a page holds 30 cards — five rows of six on a desktop window',
  /const MZ_FEED_PAGE_SIZE = 30;/.test(js));
/*  The non-paged fallback must slice to the same size, or flipping MZ_FEED_PAGED
 *  off would silently change how much the feed shows. */
check('the infinite-scroll fallback uses the same page size, not a literal',
  /allMovies\.slice\(firstPaintCount, MZ_FEED_PAGE_SIZE\)/.test(js));

check('goToFeedPage clamps to the real total',
  /Math\.min\(page, mzFeedTotalPages\(\)\)/.test(js));
check('goToFeedPage refuses a non-integer page',
  /if \(!Number\.isInteger\(page\) \|\| page < 1\) return;/.test(js));
check('goToFeedPage will not fire while a load is in flight',
  /function goToFeedPage[\s\S]{0,300}if \(isLoadingMore\) return;/.test(js));
check('the user is moved to the top of the grid on a page change',
  /function goToFeedPage[\s\S]{0,900}scrollIntoView/.test(js));
check('a fresh load resets to page 1 and un-exhausts the pool',
  /currentMoviePage = 1;\s*mzFeedPage = 1;\s*mzFeedPoolExhausted = false;/.test(js));
check('switching category restarts paging',
  /if \(cat !== mzFeedPagerCategory\) \{[\s\S]{0,200}mzFeedPage = 1;/.test(js));

// Running out must not look like an empty category.
check('an exhausted extension marks the pool final',
  /mzFeedPoolExhausted = true;/.test(js));
check('and clamps onto the last page that has content',
  /mzFeedPage = Math\.min\(mzFeedPage, mzFeedTotalPages\(\)\)/.test(js));
check('running out does not render the empty-category state',
  /isLoadMore && allMovies\.length\) \{[\s\S]{0,600}return;/.test(js),
  'the feed is not empty, it just has no more');
check('the in-flight gate is released on that early return',
  /isLoadingMore = false;\s*const doneIndicator/.test(js));
check('the two-stage paint is kept for page changes',
  /function renderCurrentFeedPage[\s\S]{0,600}requestIdleCallback\(paintTail/.test(js));

// ── 4. finite result sets get no pager ───────────────────────────────────────
console.log('');
check('the pager clears itself for search results and the watchlist',
  /if \(!MZ_FEED_PAGED \|\| isSearchResultsMode \|\| isWatchlistMode\)/.test(js));
check('renderMovies also hooks the pager, which is how those modes are caught',
  /grid\.innerHTML = '';[\s\S]{0,600}renderFeedPager\(\);/.test(js));

// ── 5. markup and wiring ─────────────────────────────────────────────────────
console.log('');
check('index.html carries the pager container', /id="feedPager"/.test(html));
check('the container sits after the grid, not before it',
  html.indexOf('id="feedPager"') > html.indexOf('id="movieGrid"'));

/*  Position, asserted because it was moved on purpose. It belongs in the gap
 *  between the movie panel and Upcoming — that space was already empty, and it is
 *  where someone who has run out of cards is looking. Inside .main-content it read
 *  as grid chrome; below .section-sep it would look like it belonged to Upcoming.
 */
const panelClose = html.indexOf('<div class="section-sep">');
check('the pager is outside .main-content, in the gap before the separator',
  html.indexOf('id="feedPager"') < panelClose && panelClose !== -1,
  'feedPager=' + html.indexOf('id="feedPager"') + ' section-sep=' + panelClose);
check('the pager comes above the Upcoming section',
  html.indexOf('id="feedPager"') < html.indexOf('id="upcoming"'));
check('the pager is no longer nested inside the movies panel',
  html.indexOf('id="feedPager"') > html.indexOf('id="loadMoreMoviesBtn"'),
  'it must follow the panel that closes after the load-more button');
check('the spacing was retuned for the gap, not left at the in-panel value',
  /\.mz-pager\{[^}]*margin:1\.4rem auto \.4rem/.test(css));
check('the pager is a labelled nav landmark',
  /<nav class="mz-pager" aria-label="Movie feed pagination">/.test(js));
check('the current page is marked for assistive tech',
  /aria-current="page"/.test(js));
check('the … separators are hidden from screen readers',
  /class="mz-pager-gap" aria-hidden="true"/.test(js));
check('every numbered control has an accessible name',
  /aria-label="Go to page ' \+ p \+ '"/.test(js));
check('buttons are type=button so they cannot submit anything',
  (js.match(/<button type="button" class="mz-pager-btn/g) || []).length >= 3);

// One delegated listener, because the pager is re-rendered on every page change.
check('clicks are delegated to the container, not bound per button',
  /function ensurePagerDelegation[\s\S]{0,400}host\.addEventListener\('click'/.test(js));
check('delegation is installed at most once',
  /if \(!host \|\| _mzPagerDelegated\) return;/.test(js));
/*  Scoped to renderFeedPager's own source: an unscoped search reaches
 *  loadMoreMoviesAction's getAttribute('onclick') further down the file and
 *  reports a handler that is not there. */
const renderPagerSrc = extract('renderFeedPager');
check('no inline onclick is generated for pager buttons',
  !/onclick/.test(renderPagerSrc), renderPagerSrc.match(/.{0,60}onclick.{0,60}/) || '');
check('the pager markup is built by renderFeedPager alone',
  renderPagerSrc.includes('mz-pager-btn') && renderPagerSrc.includes('</nav>'));

// ── 6. it is usable on a phone and a TV ──────────────────────────────────────
console.log('');
const pagerCss = css.slice(css.indexOf('/* ── Feed pagination'));
check('the pager CSS is present', pagerCss.length > 200);
check('an empty container takes no vertical space', /#feedPager:empty\{display:none\}/.test(pagerCss));
check('targets are at least 44px, the smallest reliable tap size',
  /min-width:44px;min-height:44px/.test(pagerCss));
check('targets stay at least 42px on small phones',
  /@media \(max-width:600px\)[\s\S]{0,400}min-width:42px;min-height:42px/.test(pagerCss));
check('keyboard focus is visible', /\.mz-pager-btn:focus-visible\{outline:/.test(pagerCss));
check('the pager wraps instead of overflowing a narrow screen',
  /\.mz-pager\{[^}]*flex-wrap:wrap/.test(pagerCss));
check('the current page is visually distinct from the rest',
  /\.mz-pager-cur\{[^}]*border:1px solid var\(--gold\)/.test(pagerCss));
check('low-end devices skip the hover lift',
  /\.low-end-mode \.mz-pager-btn:hover\{transform:none/.test(pagerCss));
check('reduced-motion is honoured',
  /prefers-reduced-motion:reduce\)\{[\s\S]{0,200}\.mz-pager-btn\{transition:none/.test(pagerCss));
check('TV gets larger targets and an unmistakable focus ring',
  /\[data-mz-tv="true"\] \.mz-pager-btn[\s\S]{0,200}min-width:56px/.test(pagerCss)
  && /\[data-mz-tv="true"\] \.mz-pager-btn:focus\{outline:/.test(pagerCss));

// The shipped bundle is what the browser runs.
const min = fs.readFileSync(path.join(__dirname, 'moviezone.min.js'), 'utf8');
check('the pager shipped in the minified bundle',
  min.includes('mz-pager') && min.includes('Movie feed pagination'),
  'run: npm run build');

console.log('-'.repeat(72));
console.log('  feed-pager-check: ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
