'use strict';

/*  Sanity-checks .vercelignore: every test/dev file must be excluded, and every
 *  file the running app needs must NOT be. Getting the second half wrong would
 *  break production, so it is asserted rather than eyeballed.
 *
 *  Run: node vercelignore-check.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const patterns = fs.readFileSync('.vercelignore', 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

// Minimal glob → regex for the simple "*.ext" / "*-suffix.js" forms used here.
function toRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp('^' + escaped + '$');
}
const matchers = patterns.map(toRegExp);
const isIgnored = (name) => matchers.some((re) => re.test(name));

// Anything the deployed app actually loads.
const MUST_SHIP = [
  'index.html', 'server.js', 'seo-ssr.js', 'moviezone.js', 'moviezone.min.js',
  'moviezone.css', 'moviezone.min.css', 'tv-mode.js', 'tv-mode.min.js',
  'tv-mode.css', 'tv-mode.min.css', 'search-engine.js', 'pwa-install.js',
  'sw.js', 'manifest.json', 'collections-catalog.json', 'robots.txt',
  'package.json', 'vercel.json', 'icon-192.png', 'icon-512.png',
  'favicon-32.png', 'apple-touch-icon.png', 'moviezone-logo.webp',
  'icon-192.webp', 'icon-512.webp'
];

let fail = 0;
function check(label, pass, detail) {
  if (!pass) fail++;
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '\n          ' + detail : ''));
}

console.log('\n.vercelignore coverage');
console.log('-'.repeat(58));

const files = fs.readdirSync('.').filter((f) => fs.statSync(f).isFile());

// 1. Every test / dev-only file is excluded.
const devFiles = files.filter((f) =>
  /\.test\.(js|html)$/.test(f) || /-check\.js$/.test(f) || f === 'perf-baseline.json');
const leaked = devFiles.filter((f) => !isIgnored(f));
check('all ' + devFiles.length + ' dev/test files excluded', leaked.length === 0,
  'still shipping: ' + leaked.join(', '));

// 2. Nothing the app needs is excluded.
const broken = MUST_SHIP.filter((f) => fs.existsSync(f) && isIgnored(f));
check('no production file is excluded', broken.length === 0,
  'wrongly excluded: ' + broken.join(', '));

// 3. The specific harness pages that were public are now covered.
['tv-mode.browser.test.html', 'tv-mode.browser.nontv.test.html',
  'cat-tabs.browser.test.html'].forEach((f) => {
  check(f + ' excluded', isIgnored(f));
});

// 4. seo-ssr.js is required by server.js at runtime — must never be ignored.
check('seo-ssr.js ships (server.js requires it)', !isIgnored('seo-ssr.js'));

console.log('-'.repeat(58));
console.log('  ' + (fail ? fail + ' problem(s)' : 'ignore list is correct') + '\n');
process.exit(fail ? 1 : 0);
