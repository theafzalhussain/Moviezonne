'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { MARKER, assembleAppSource, readAppSource } = require('./scripts/app-source.cjs');

test('assembly preserves replacement tokens and exact source order', () => {
  const player = "/* $& $` $' $$ */\nfunction play() { return 'unchanged'; }\n";
  assert.equal(assembleAppSource('before\n' + MARKER + '\nafter', player), 'before\n' + player + '\nafter');
});
test('missing, duplicate markers and empty fragments fail closed', () => {
  assert.throws(() => assembleAppSource('no marker', 'code'), /exactly one/);
  assert.throws(() => assembleAppSource(MARKER + MARKER, 'code'), /exactly one/);
  assert.throws(() => assembleAppSource(MARKER, ' \n'), /empty/);
});
test('one classic-script scope preserves shared state and function hoisting', () => {
  const main = "let current = 7; result = openModal();\n" + MARKER + "\ncurrent = 8; next = openModal();";
  const fragment = 'function openModal() { return current; }';
  const context = {};
  vm.runInNewContext(assembleAppSource(main, fragment), context);
  assert.equal(context.result, 7);
  assert.equal(context.next, 8);
});
test('production source compiles and moves player declarations exactly once', () => {
  const root = __dirname;
  const main = fs.readFileSync(path.join(root, 'moviezone.js'), 'utf8');
  const player = fs.readFileSync(path.join(root, 'moviezone-player.js'), 'utf8');
  const combined = readAppSource(root);
  assert.doesNotThrow(() => new vm.Script(combined));
  for (const marker of ['async function openModal(', 'function closeModal(', 'function loadPlayer(', 'const playerSources =']) {
    assert.equal(main.includes(marker), false, marker + ' remains in main source');
    assert.equal(player.split(marker).length - 1, 1, marker + ' must exist exactly once');
    assert.equal(combined.split(marker).length - 1, 1, marker + ' duplicates in assembled source');
  }
  assert(combined.indexOf('async function openModal(') < combined.indexOf('function closeModal('));
  assert(combined.indexOf('const playerSources =') < combined.indexOf('window.__mzBridge ='));
});
test('player source is not separately loaded by the browser or service worker', () => {
  for (const name of ['index.html', 'sw.js']) {
    const content = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert(!content.includes('moviezone-player.js'), name + ' must keep the existing single bundle');
  }
});
test('missing fragment fails rather than producing a partial app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-source-missing-'));
  try {
    fs.writeFileSync(path.join(dir, 'moviezone.js'), MARKER);
    assert.throws(() => readAppSource(dir), /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('build CLI preserves output on errors and uses sources outside cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-source-build-'));
  const output = path.join(dir, 'result.min.js');
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const name of ['app-source.cjs', 'build-app.cjs']) {
      fs.copyFileSync(path.join(__dirname, 'scripts', name), path.join(dir, 'scripts', name));
    }
    fs.symlinkSync(fs.realpathSync(path.join(__dirname, 'node_modules')), path.join(dir, 'node_modules'), 'junction');
    fs.writeFileSync(path.join(dir, 'moviezone.js'), 'globalThis.answer = openModal();\n' + MARKER);
    fs.writeFileSync(path.join(dir, 'moviezone-player.js'), 'function openModal() { return 42; }');
    const run = () => spawnSync(process.execPath, [path.join(dir, 'scripts/build-app.cjs'), '-o', output], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(run().status, 0);
    const valid = fs.readFileSync(output);
    const context = {}; vm.runInNewContext(valid.toString(), context);
    assert.equal(context.answer, 42);
    fs.writeFileSync(path.join(dir, 'moviezone-player.js'), 'function { invalid');
    assert.notEqual(run().status, 0);
    assert(fs.readFileSync(output).equals(valid), 'minifier failure must not overwrite output');
    fs.unlinkSync(path.join(dir, 'moviezone-player.js'));
    assert.notEqual(run().status, 0);
    assert(fs.readFileSync(output).equals(valid), 'missing source must not overwrite output');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('source loading is independent of process working directory', () => {
  const expected = readAppSource();
  const previous = process.cwd();
  try { process.chdir(path.dirname(__dirname)); assert.equal(readAppSource(), expected); }
  finally { process.chdir(previous); }
});
