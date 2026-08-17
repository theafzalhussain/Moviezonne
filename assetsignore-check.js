/* ═══════════════════════════════════════════════════════════════════════════
   assetsignore-check.js — the Cloudflare twin of vercelignore-check.js.

   WHY THIS EXISTS
   wrangler.jsonc publishes assets.directory "." — the entire repo root. The
   exclusion list used to live in .vercelignore, and the Cloudflare migration did
   not carry it over, so the test harnesses and .env.example were served from
   production again. That regression was invisible because nothing tested it.

   Two directions, both of which have already broken once:
     • a dev/test file must NEVER be publishable (that is the leak)
     • a file the browser loads must NEVER be excluded (that is an outage)

   Run: node assetsignore-check.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const IGNORE_FILE = '.assetsignore';

/*  Everything the browser actually requests. Deliberately concrete: a glob here
 *  would hide the very mistake this guards against. */
const BROWSER_NEEDS = [
  'index.html',
  'moviezone.min.js', 'moviezone.min.css',
  'tv-mode.min.js', 'tv-mode.min.css',
  'search-engine.min.js', 'pwa-install.min.js',
  'sw.js', 'manifest.json',
  'collections-catalog.json',
  'robots.txt', 'sitemap.xml',
  'moviezone-logo.webp', 'moviezone-logo.png',
  'icon-192.png', 'icon-512.png', 'icon-192.webp', 'icon-512.webp',
  'favicon-32.png', 'apple-touch-icon.png', 'apple-touch-icon.webp',
  'fonts/outfit-latin-var.woff2',
  'fonts/bebas-neue-latin-400.woff2',
  'fonts/playfair-display-latin-700.woff2'
];

/*  Files that must never be reachable. Each of these was verified answering 200
 *  on the live site before this list existed. */
const MUST_NOT_SHIP = [
  'player-health.test.js', 'seo-ssr.test.js', 'tv-mode.test.js',
  'asset-perf-check.js', 'cwv-check.js', 'ott-check.js',
  'tv-mode.browser.test.html', 'rum-gate.browser.test.html',
  'perf-baseline.json', 'sitemap-cache.json', 'asset-versions.json',
  '.env', '.env.example',
  'server.js', 'seo-ssr.js', 'worker.js', 'instrument.js', 'datadogRUM-init.js',
  'package.json', 'package-lock.json', 'wrangler.jsonc',
  'scripts/build-sitemap-cache.js'
];

// ── gitignore-style matcher ───────────────────────────────────────────────────

function toMatcher(pattern) {
  let p = pattern.trim();
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);

  // "**/x" matches x at any depth, including the root.
  const anyDepth = p.startsWith('**/');
  if (anyDepth) p = p.slice(3);

  const rx = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  return (name) => {
    const segments = name.split('/');
    if (dirOnly) return segments.slice(0, -1).some((s) => new RegExp('^' + rx + '$').test(s));
    if (new RegExp('^' + rx + '$').test(name)) return true;
    // A bare pattern also matches the basename at any depth (gitignore rule).
    if (anyDepth || !p.includes('/')) {
      return new RegExp('^' + rx + '$').test(segments[segments.length - 1]);
    }
    return false;
  };
}

const full = path.join(__dirname, IGNORE_FILE);
if (!fs.existsSync(full)) {
  console.error('FAILED: ' + IGNORE_FILE + ' is missing — the whole repo root would be published.');
  process.exit(1);
}

const patterns = fs.readFileSync(full, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const matchers = patterns.map(toMatcher);
const isIgnored = (name) => matchers.some((m) => m(name));

// ── checks ────────────────────────────────────────────────────────────────────

let fail = 0;
function check(label, pass, detail) {
  if (!pass) fail++;
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '\n          ' + detail : ''));
}

console.log('\n.assetsignore coverage — Cloudflare publishes assets.directory "."');
console.log('-'.repeat(70));

check(IGNORE_FILE + ' declares at least one pattern', patterns.length > 0);

// 1. Nothing the browser loads may be excluded.
const brokenOut = BROWSER_NEEDS.filter((f) => fs.existsSync(path.join(__dirname, f)) && isIgnored(f));
check('no browser-loaded file is excluded', brokenOut.length === 0,
  'wrongly excluded: ' + brokenOut.join(', '));

// 2. Every dev/secret file must be excluded.
const leaked = MUST_NOT_SHIP.filter((f) => fs.existsSync(path.join(__dirname, f)) && !isIgnored(f));
check('every dev/secret file is excluded', leaked.length === 0,
  'still publishable: ' + leaked.join(', '));

// 3. Sweep the real tree so a NEW test file cannot slip through unnoticed.
const rootFiles = fs.readdirSync(__dirname).filter((f) => {
  try { return fs.statSync(path.join(__dirname, f)).isFile(); } catch (e) { return false; }
});
const devPattern = (f) => /\.test\.(js|html)$/.test(f) || /-check\.js$/.test(f)
  || f === 'perf-baseline.json' || /^\.env/.test(f);
const sweepLeaked = rootFiles.filter((f) => devPattern(f) && !isIgnored(f));
check('sweep: all ' + rootFiles.filter(devPattern).length + ' dev/env files in the tree are excluded',
  sweepLeaked.length === 0, 'still publishable: ' + sweepLeaked.join(', '));

// 4. .env.example must not carry a real-looking secret, published or not —
//    it is committed to a public repository.
const examplePath = path.join(__dirname, '.env.example');
if (fs.existsSync(examplePath)) {
  const suspicious = [];
  for (const line of fs.readFileSync(examplePath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    const isPlaceholder = /REPLACE_WITH|USERNAME|PASSWORD|CLUSTER_HOST|PUBLIC_KEY|PROJECT_ID|ORG_ID|example\.com|^\d+$/i.test(value);
    // A long high-entropy value that is not obviously a placeholder.
    if (!isPlaceholder && value.length >= 20 && /[A-Za-z0-9_\-.]{20,}/.test(value)) {
      suspicious.push(key);
    }
  }
  check('.env.example carries no real-looking credential', suspicious.length === 0,
    'suspicious keys: ' + suspicious.join(', ') + ' — replace with a placeholder and ROTATE the leaked value');
}

console.log('-'.repeat(70));
console.log('  ' + (fail ? fail + ' failed' : 'asset exclusion list is correct') + '\n');
process.exit(fail ? 1 : 0);
