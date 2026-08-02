'use strict';

/*  Geometry check for the hero carousel thumbnail rail.
 *
 *  The bug: ten fixed 82px thumbs + gaps + padding needed ~936px of vertical
 *  space, but #hero is only 95vh (86vh at <=1024px wide). Any viewport shorter
 *  than ~985px clipped the rail against #hero's overflow:hidden.
 *
 *  This asserts the height-relative sizing now fits on real devices.
 *  Run: node carousel-fit-check.js
 */

const assert = require('assert');
const fs = require('fs');

const css = fs.readFileSync('moviezone.css', 'utf8');
const THUMB_COUNT = 10; // carouselMovies.slice(0, 10) in moviezone.js

// ── confirm the CSS actually carries the height-relative values ──────────
const checks = [
  [/\.carousel-thumbs\s*\{[\s\S]*?gap:\s*min\(0\.65rem,\s*0\.85vh\)/, 'rail gap is height-relative'],
  [/\.carousel-thumbs\s*\{[\s\S]*?padding:\s*min\(0\.7rem,\s*1vh\)/, 'rail padding is height-relative'],
  [/\.carousel-thumbs\s*\{[\s\S]*?max-height:\s*calc\(100% - 2rem\)/, 'rail is capped to the hero height'],
  [/\.carousel-thumbs\s*\{[\s\S]*?overflow-y:\s*auto/, 'rail scrolls internally as a last resort'],
  [/\.thumb\s*\{[\s\S]*?height:\s*min\(82px,\s*7\.1vh\)/, 'thumb height is height-relative'],
  [/\.thumb\s*\{[\s\S]*?width:\s*min\(58px,\s*5\.02vh\)/, 'thumb width is height-relative'],
  [/\.thumb\s*\{[\s\S]*?flex:\s*0 0 auto/, 'thumbs do not squash under a max-height'],
  [/@media \(max-height: 560px\)\s*\{\s*\.carousel-thumbs\s*\{\s*display:\s*none/, 'rail hides on very short viewports']
];

let pass = 0;
let fail = 0;

checks.forEach(([re, label]) => {
  if (re.test(css)) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
});

// Fallback declarations must come first so old TV browsers get usable values.
const thumbBlock = /\.thumb\s*\{([\s\S]*?)\}/.exec(css)[1];
const fixedH = thumbBlock.indexOf('height: 82px');
const minH = thumbBlock.indexOf('height: min(82px');
if (fixedH !== -1 && fixedH < minH) { pass++; console.log('  PASS  px fallback precedes the min() override'); }
else { fail++; console.log('  FAIL  px fallback must precede the min() override'); }

// ── geometry across real viewports ──────────────────────────────────────
console.log('\n  Rail height vs available hero height');
console.log('  ' + '-'.repeat(72));
console.log('  ' + 'viewport'.padEnd(16) + 'hero'.padStart(8) + 'rail(old)'.padStart(11)
  + 'rail(new)'.padStart(11) + 'available'.padStart(11) + '   verdict');
console.log('  ' + '-'.repeat(72));

const VIEWPORTS = [
  ['iPhone SE', 375, 667],
  ['iPhone 14', 390, 844],
  ['Pixel 7', 412, 915],
  ['iPad mini', 768, 1024],
  ['iPad Pro 11', 834, 1194],
  ['iPad landscape', 1024, 768],
  ['Laptop 1366x768', 1366, 768],
  ['Laptop 1536x864', 1536, 864],
  ['Desktop 1920x1080', 1920, 1080],
  ['QHD 2560x1440', 2560, 1440],
  // Browser zoom shrinks the CSS viewport in BOTH axes, which is the most
  // likely way a desktop user lands on a short-but-wide viewport where the
  // width-based hide rule does not apply. 1366x768 at 150% zoom:
  ['1366x768 @150%', 911, 512],
  ['1920x1080 @150%', 1280, 720],
  ['1920x1080 @200%', 960, 540],
  // Half-height window on a large monitor.
  ['1920x600 window', 1920, 600]
];

function railHeight(vh, mode) {
  const thumb = mode === 'old' ? 82 : Math.min(82, 0.071 * vh);
  const gap = mode === 'old' ? 10.4 : Math.min(10.4, 0.0085 * vh);
  const pad = mode === 'old' ? 11.2 : Math.min(11.2, 0.01 * vh);
  return THUMB_COUNT * thumb + (THUMB_COUNT - 1) * gap + 2 * pad;
}

// Require real headroom, not a 1px squeeze: sub-pixel rounding and a
// platform scrollbar should not be able to tip a "fits" case into overflow.
const MIN_MARGIN_PX = 8;

VIEWPORTS.forEach(([name, w, h]) => {
  // Rail is hidden at <=768px wide (existing rule) or <=560px tall (new rule).
  const hidden = w <= 768 || h <= 560;
  const heroVh = w <= 1024 ? 0.86 : 0.95;
  const hero = heroVh * h;
  const available = hero - 32; // max-height: calc(100% - 2rem)
  const oldRail = railHeight(h, 'old');
  const newRail = railHeight(h, 'new');

  let verdict;
  if (hidden) {
    verdict = 'rail hidden';
  } else if (newRail <= available - MIN_MARGIN_PX) {
    verdict = 'FITS';
    pass++;
  } else if (newRail <= available) {
    verdict = 'TIGHT (<' + MIN_MARGIN_PX + 'px margin)';
    fail++;
  } else {
    verdict = 'OVERFLOWS';
    fail++;
  }

  console.log('  ' + name.padEnd(16)
    + Math.round(hero).toString().padStart(8)
    + Math.round(oldRail).toString().padStart(11)
    + Math.round(newRail).toString().padStart(11)
    + Math.round(available).toString().padStart(11)
    + '   ' + verdict
    + (!hidden && oldRail > available ? '  (was clipped)' : ''));
});

console.log('  ' + '-'.repeat(72));
console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
