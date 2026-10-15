/*  Throwaway. Deleted after use.
 *  Runs every `node X.js` of an npm script chain on its own (the chain stops at
 *  the first failure), and prints exit code, duration and the last summary line.
 *  Usage: node tmp-run-suite.js <npm script name> [--only=a.js,b.js]
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const name = process.argv[2] || 'test:offline';
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const chain = require('./package.json').scripts[name];
const steps = chain.split('&&').map((s) => s.trim()).filter((s) => s.startsWith('node '))
  .map((s) => s.slice(5).split(/\s+/)).filter((a) => !only.length || only.includes(a[0]));
const logDir = path.join(os.tmpdir(), 'mzsuite');
fs.mkdirSync(logDir, { recursive: true });
let failed = 0;
for (const args of steps) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 1 << 26 });
  const out = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(logDir, args[0] + '.log'), out);
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const summary = [...lines].reverse().find((l) => /passed|failed|checks|PASS|FAIL|SKIP|ok\b|all /i.test(l)) || lines[lines.length - 1] || '';
  const fails = lines.filter((l) => /^(FAIL|✗|x |✘)|\bFAIL\b/.test(l)).slice(0, 4);
  const code = r.status === null ? 'TIMEOUT/' + r.signal : r.status;
  if (code !== 0) failed++;
  console.log((code === 0 ? 'ok  ' : 'BAD ') + args.join(' ').padEnd(40) + ' exit=' + code + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  | ' + summary.slice(0, 110));
  if (code !== 0) fails.forEach((l) => console.log('        ' + l.slice(0, 160)));
}
console.log('\n' + name + ': ' + (steps.length - failed) + '/' + steps.length + ' scripts passed; logs in ' + logDir);
process.exit(failed ? 1 : 0);
