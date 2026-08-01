// Verifies PWA asset verification: manifest icon URLs carry cache-busting queries
// ("/icon-192.png?v=2"), which used to be treated as part of the filename and made
// verifyPwaAssets() report existing icons as missing.
process.env.PORT = '3995';
require('dotenv').config();
const path = require('path');

const app = require('./server.js');
const { resolveAsset, assetPathFromUrl, verifyPwaAssets } = app.locals.pwaInternals;

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const j = (...p) => path.join(...p);

// ── assetPathFromUrl: URL → on-disk relative path ──
const cases = [
  ['/icon-192.png?v=2', j('icon-192.png'), 'strips cache-busting query'],
  ['/icon-512.png?v=2#hash', j('icon-512.png'), 'strips query + fragment'],
  ['/icon-192.png', j('icon-192.png'), 'plain root-relative'],
  ['icon-192.png', j('icon-192.png'), 'plain relative'],
  ['/img/logo%20big.png', j('img', 'logo big.png'), 'decodes percent-encoding'],
  ['/nested/dir/icon.png', j('nested', 'dir', 'icon.png'), 'keeps subdirectories'],
  // URL parsing normalises "/../" away, so traversal never reaches the filesystem
  ['/../../etc/passwd', j('etc', 'passwd'), 'URL normalisation neutralises ../'],
  ['https://cdn.example.com/icon.png', null, 'remote https URL not checkable'],
  ['//cdn.example.com/icon.png', null, 'protocol-relative URL not checkable'],
  ['data:image/png;base64,AAAA', null, 'data URI not checkable'],
  ['', null, 'rejects empty string'],
  [null, null, 'rejects non-string']
];

for (const [input, expected, label] of cases) {
  const actual = assetPathFromUrl(input);
  check(`assetPathFromUrl: ${label}`, actual === expected, `${JSON.stringify(input)} -> ${JSON.stringify(actual)}`);
}

// ── resolveAsset must stay inside the asset directories ──
const escapes = ['../../../../Windows/win.ini', '..\\..\\..\\..\\Windows\\win.ini', path.join('..', '..', 'package.json')];
for (const attempt of escapes) {
  check(`resolveAsset refuses to escape asset dirs: ${attempt}`, resolveAsset(attempt) === null,
    `-> ${JSON.stringify(resolveAsset(attempt))}`);
}
check('resolveAsset still finds a real file', typeof resolveAsset('manifest.json') === 'string',
  String(resolveAsset('manifest.json')));

// ── The real icons referenced by manifest.json must now resolve ──
const manifest = JSON.parse(require('fs').readFileSync(resolveAsset('manifest.json'), 'utf8'));
const unresolved = manifest.icons
  .map(i => ({ src: i.src, rel: assetPathFromUrl(i.src) }))
  .filter(x => x.rel && !resolveAsset(x.rel));
check('every manifest.json icon resolves on disk', unresolved.length === 0,
  unresolved.length ? unresolved.map(x => x.src).join(', ') : `${manifest.icons.length} icons checked`);

// ── verifyPwaAssets() must now pass and stay silent ──
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));
const ok = verifyPwaAssets();
console.warn = originalWarn;

check('verifyPwaAssets() returns true', ok === true, `returned ${ok}`);
check('verifyPwaAssets() emits no warnings', warnings.length === 0,
  warnings.length ? warnings.join(' | ') : 'clean');

console.log(`\n===== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} =====`);
process.exit(failures === 0 ? 0 : 1);
