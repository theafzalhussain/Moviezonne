'use strict';

/*  asset-seal.js — records the content hash of every immutably-cached asset
 *  against the ?v= it ships under.
 *
 *  WHY THIS EXISTS
 *  netlify.toml and vercel.json serve /*.min.js and /*.min.css with
 *  `Cache-Control: public, max-age=31536000, immutable`, and sw.js serves any
 *  URL carrying ?v= cache-first. Both are correct — but they make the version
 *  string load-bearing: it is the ONLY thing that can invalidate a client.
 *
 *  That went wrong exactly once, and expensively. moviezone.min.js was bumped
 *  7.5 -> 7.6 in one change, then its contents were modified twice more without
 *  another bump. The CDN, every returning browser, and every service worker kept
 *  serving the FIRST 7.6 for a year, so two rounds of fixes — including the one
 *  that stopped a retry storm — never reached a single user. Datadog kept
 *  reporting the error that had already been fixed in the repo, which is a very
 *  confusing way to lose a day.
 *
 *  So: the hash of each asset is sealed here next to its version. If the file
 *  changes and the version does not, asset-perf-check fails and tells you what
 *  to bump. `npm run assets:seal` re-seals after a legitimate bump.
 *
 *  Run:  node asset-seal.js          verify (exit 1 on drift)
 *        node asset-seal.js --write  re-seal after bumping versions
 */

const fs = require('fs');
const crypto = require('crypto');

const SEAL_FILE = 'asset-versions.json';
const ASSETS = ['moviezone.min.js', 'moviezone.min.css', 'tv-mode.min.js', 'tv-mode.min.css',
  'search-engine.min.js', 'pwa-install.min.js'];

const html = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

/*  The version an asset ships under. Most are a tag in index.html; pwa-install
 *  is injected at runtime so its version lives in the loader snippet instead.
 */
function versionOf(name) {
  const escaped = name.replace(/\./g, '\\.');
  const patterns = [
    new RegExp('href="' + escaped + '\\?v=([\\d.]+)"'),
    new RegExp('src="' + escaped + '\\?v=([\\d.]+)"'),
    new RegExp("s\\.src = '" + escaped + "\\?v=([\\d.]+)'")
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

function build() {
  const out = {};
  for (const name of ASSETS) {
    if (!fs.existsSync(name)) continue;
    out[name] = { version: versionOf(name), sha256: sha(name) };
  }
  return out;
}

const current = build();

if (process.argv.includes('--write')) {
  fs.writeFileSync(SEAL_FILE, JSON.stringify(current, null, 2) + '\n');
  console.log('Sealed ' + Object.keys(current).length + ' assets into ' + SEAL_FILE + ':');
  for (const name of Object.keys(current)) {
    console.log('  ' + name.padEnd(24) + 'v' + current[name].version + '  ' + current[name].sha256);
  }
  process.exit(0);
}

if (!fs.existsSync(SEAL_FILE)) {
  console.error('FAILED: ' + SEAL_FILE + ' is missing. Run: npm run assets:seal');
  process.exit(1);
}

const sealed = JSON.parse(fs.readFileSync(SEAL_FILE, 'utf8'));
const problems = [];

for (const name of Object.keys(current)) {
  const now = current[name];
  const was = sealed[name];

  if (!now.version) {
    problems.push(name + ' ships with no ?v= at all, so it can never be invalidated');
    continue;
  }
  if (!was) {
    problems.push(name + ' is not sealed yet (v' + now.version + ', ' + now.sha256 + ') — run: npm run assets:seal');
    continue;
  }
  if (now.sha256 !== was.sha256 && now.version === was.version) {
    problems.push(name + ' CHANGED but still ships as v' + now.version +
      '\n              sealed ' + was.sha256 + ' -> now ' + now.sha256 +
      '\n              It is served immutable for a year and cache-first by sw.js, so every' +
      '\n              existing client keeps the OLD file. Bump the ?v= in index.html AND' +
      '\n              sw.js, bump CACHE_NAME, then run: npm run assets:seal');
  }
  if (now.version !== was.version && now.sha256 === was.sha256) {
    problems.push(name + ' version moved v' + was.version + ' -> v' + now.version +
      ' but the file is byte-identical; that just discards a warm cache for nothing');
  }
}

// index.html and sw.js must agree, or an offline client runs different code.
for (const name of ['moviezone.min.js', 'moviezone.min.css', 'tv-mode.min.js', 'tv-mode.min.css', 'search-engine.min.js']) {
  const v = current[name] && current[name].version;
  if (!v) continue;
  if (!sw.includes("'/" + name + '?v=' + v + "'")) {
    problems.push(name + ' is v' + v + ' in index.html but sw.js does not precache that exact URL');
  }
}

console.log('\nimmutable asset seal');
console.log('-'.repeat(62));
for (const name of Object.keys(current)) {
  console.log('  ' + name.padEnd(24) + 'v' + String(current[name].version).padEnd(6) + current[name].sha256);
}
console.log('-'.repeat(62));

if (problems.length) {
  problems.forEach((p) => console.log('  FAIL  ' + p));
  console.log('\n  ' + problems.length + ' problem(s)\n');
  process.exit(1);
}
console.log('  every immutably-cached asset matches the version it ships under\n');
process.exit(0);
