/*  ═══════════════════════════════════════════════════════════════════════════
 *  BUNDLE DRIFT — every shipped .min file is a build of the source beside it
 *  ═══════════════════════════════════════════════════════════════════════════
 *
 *  The browser runs the .min bundles; the tests mostly read the sources. When a
 *  source is edited and `npm run build` is skipped, every source-level check
 *  passes and production keeps shipping the old code. That happened: commit
 *  f09a90e commented the 'Premium Mirror' (vidsrc.pm) server out of moviezone.js,
 *  and moviezone.min.js was never rebuilt, so the live site kept offering it
 *  while the source — and every test reading it — said it was gone.
 *
 *  asset-seal.js cannot see this: it hashes the .min file against its ?v=, and
 *  an unrebuilt bundle is unchanged, so its seal still matches.
 *
 *  So this runs each step of package.json's own "build" script into a temp
 *  directory and requires the result to be byte-identical to the committed
 *  bundle. The steps are read from package.json rather than listed here, so a
 *  bundle added to the build is covered without touching this file.
 *
 *  Uses the locally installed terser and clean-css-cli, exactly like
 *  `npm run build`. Run: node bundle-drift-check.js
 *  ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}

/*  The CLIs are run through `node <bin>` rather than npx: no shell, so the same
 *  argument array works on Windows and Linux, and nothing is ever downloaded. */
function binOf(pkgName, binName) {
  const dir = path.join(ROOT, 'node_modules', pkgName);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin[binName];
  return path.join(dir, rel);
}
const TOOLS = { terser: ['terser', 'terser'], cleancss: ['clean-css-cli', 'cleancss'] };

console.log('\nbundle drift — every shipped bundle is a build of its current source');
console.log('-'.repeat(72));

const steps = String(pkg.scripts && pkg.scripts.build || '').split('&&').map((s) => s.trim()).filter(Boolean);
check('package.json has a build script to compare against', steps.length > 0);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mzdrift-'));
try {
  steps.forEach((step) => {
    const args = step.split(/\s+/);
    const tool = args.shift();
    const outAt = args.indexOf('-o');
    if (!TOOLS[tool] || outAt === -1 || !args[outAt + 1]) {
      check('build step is one this check understands: ' + step, false,
        'expected "terser|cleancss ... -o <out> ...". Teach bundle-drift-check.js the new step.');
      return;
    }
    const out = args[outAt + 1];
    const built = path.join(tmp, path.basename(out));
    args[outAt + 1] = built;

    let bin;
    try { bin = binOf(TOOLS[tool][0], TOOLS[tool][1]); } catch (e) {
      check(out + ': ' + tool + ' is installed', false, 'run npm install (' + e.message + ')');
      return;
    }
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0 || !fs.existsSync(built)) {
      check(out + ' builds', false, (r.stderr || r.error && r.error.message || 'exit ' + r.status).trim().slice(0, 300));
      return;
    }
    if (!fs.existsSync(path.join(ROOT, out))) {
      check(out + ' is committed', false, 'run: npm run build');
      return;
    }
    const a = fs.readFileSync(built);
    const b = fs.readFileSync(path.join(ROOT, out));
    const source = args.filter((x, i) => i !== outAt && i !== outAt + 1 && !x.startsWith('-')).join(' ');
    check(out + ' matches a fresh build of ' + source, a.equals(b),
      'shipped ' + b.length + ' B, fresh build ' + a.length + ' B. The source changed without a rebuild:'
      + ' run npm run build, bump its ?v= in index.html and sw.js, bump CACHE_NAME, then npm run assets:seal.');
  });
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
}

console.log('-'.repeat(72));
console.log('  bundle-drift-check: ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
