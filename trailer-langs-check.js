/* ═══════════════════════════════════════════════════════════════════════════
   trailer-langs-check.js — the hover trailer must work outside Hollywood.

   THE BUG THIS PINS
   TMDB applies the `language` parameter to the videos it appends, so requesting a
   title with `language=en-US` returns ONLY English-tagged videos. Every detail
   fetch did exactly that, so `videos.results` came back EMPTY for Hindi, Tamil,
   Telugu and Malayalam titles — the hover trailer worked on Hollywood and
   silently did nothing on much of the catalogue, while the play indicator was
   rendered anyway so it looked broken rather than absent.

   Measured live across 54 popular titles (en/hi/te/ta/ml/ko movies, ja/hi/ko
   series): 22 had no playable video with `language=en-US` alone, and 10 of those
   returned one as soon as include_video_language was sent — one Tamil title went
   from 0 videos to 5.

   WHAT IS ASSERTED
     • every detail fetch sends include_video_language, covering the languages
       this site actually serves plus `null` (TMDB's token for untagged videos)
     • the hover prefetch and the modal fetch send byte-identical params, because
       tmdb() caches by full URL — one differing key makes the prefetch useless
     • the trailer indicator is conditional, so a title with genuinely no video
       does not advertise one
     • the SSR detail page broadens the same way, so its trailer link appears too

   Run: node trailer-langs-check.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, 'moviezone.js'), 'utf8');
const min = fs.readFileSync(path.join(__dirname, 'moviezone.min.js'), 'utf8');
const ssr = fs.readFileSync(path.join(__dirname, 'seo-ssr.js'), 'utf8');

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}

/*  The languages the site's own categories cover. If a category is added that
 *  needs another one, this list is where it goes — and this check is what fails
 *  until it does. */
const REQUIRED = ['en', 'hi', 'ta', 'te', 'ml', 'ja', 'ko', 'null'];

const declared = (js.match(/const VIDEO_LANGS = '([^']+)'/) || [])[1] || '';
check('moviezone.js declares one shared video-language list', Boolean(declared), declared);

REQUIRED.forEach((code) => {
  check('video languages include ' + code,
    declared.split(',').indexOf(code) !== -1,
    'VIDEO_LANGS = ' + declared);
});

check('`null` is included, for videos with no language tag',
  declared.split(',').indexOf('null') !== -1,
  'regional distributors usually upload untagged trailers; without null they stay invisible');

/*  Every detail fetch must go through the shared builder. A literal
 *  `append_to_response: 'videos...'` is the old bug reintroduced — the builder
 *  itself passes a variable, so it does not match this pattern. */
const rawDetailFetches = js.match(/append_to_response:\s*'[^']*videos[^']*'/g) || [];
check('no detail fetch hardcodes its own params any more',
  rawDetailFetches.length === 0,
  'these bypass the builder and so send no video languages: ' + rawDetailFetches.join(' | '));

const builderUses = (js.match(/detailParams\(/g) || []).length;
check('every detail call site uses the builder (prefetch + modal + upcoming)',
  builderUses >= 4,                       // 1 definition + 3 call sites
  'detailParams( appears ' + builderUses + ' times');

check('the builder always sends include_video_language',
  /function detailParams\([\s\S]{0,320}?include_video_language: VIDEO_LANGS/.test(js),
  'the builder can return params without the video language list');

check('the builder keeps a fixed key order, so prefetch and open share a cache entry',
  /function detailParams\([\s\S]*?language: 'en-US',\s*append_to_response:[\s\S]*?include_video_language/.test(js),
  'tmdb() caches by full URL; reordered keys mean the prefetch warms a URL nobody requests');

/*  The other half of the report: a play icon on a title with nothing to play. */
check('the trailer indicator is conditional, not unconditional',
  /const canPlayTrailer = bestVids\.length > 0 && !isMzTV\(\);/.test(js),
  'the indicator is back to being appended for every title');

check('the indicator is removed when there is nothing to play',
  /!canPlayTrailer && trailerIndicator[\s\S]{0,80}?\.remove\(\)/.test(js),
  'a title with no video keeps a play icon from a previous modal');

check('the hover handlers are only wired when a trailer exists',
  /if \(canPlayTrailer\) \{/.test(js),
  'hover would arm a player with an empty queue');

/*  Server-rendered detail pages read the same videos for their trailer link. */
check('the SSR detail fetch broadens video languages too',
  /include_video_language: 'en,hi,ta,te,ml,kn,mr,bn,pa,ja,ko,null'/.test(ssr),
  'trailerOf() would find nothing for regional titles, so the trailer link vanishes');

check('the SSR list matches the client list exactly',
  (ssr.match(/include_video_language: '([^']+)'/) || [])[1] === declared,
  'the two surfaces would disagree about which trailers exist');

/*  Shipped bundle, because the browser runs that one. */
check('the fix is in the minified bundle',
  min.includes('include_video_language'),
  'run `npm run build` — moviezone.min.js is what the browser loads');

console.log('\nHover trailer — video languages and the play indicator');
console.log('-'.repeat(70));
let failed = 0;
checks.forEach((c) => {
  if (c.pass) console.log('  PASS  ' + c.name);
  else { failed++; console.log('  FAIL  ' + c.name + (c.detail ? '\n          ' + c.detail : '')); }
});
console.log('-'.repeat(70));
console.log('  trailer-langs-check: ' + (checks.length - failed) + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
