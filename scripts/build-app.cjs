'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readAppSource } = require('./app-source.cjs');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '-o' || !args[1]) {
  throw new Error('Usage: node scripts/build-app.cjs -o <output>');
}
// Validate inputs before touching the output. One classic-script input retains
// existing scope, declaration hoisting and side-effect order.
const source = readAppSource(root);
const output = path.resolve(args[1]);
const metaPath = require.resolve('terser/package.json');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const bin = path.resolve(path.dirname(metaPath), typeof meta.bin === 'string' ? meta.bin : meta.bin.terser);
const temp = fs.mkdtempSync(path.join(path.dirname(output), '.mz-app-build-'));
try {
  const candidate = path.join(temp, 'moviezone.min.js');
  const result = spawnSync(process.execPath, [bin, '-o', candidate, '-c', '-m'], {
    cwd: root, input: source, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Application build failed');
  // Replace only a complete successful build; errors preserve the prior bundle.
  fs.renameSync(candidate, output);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
