'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MARKER = '/* @moviezone-source: moviezone-player.js */';

// Build-time inclusion only: keep classic-script scope, declaration hoisting,
// top-level side effects and execution order exactly as before the extraction.
function assembleAppSource(mainSource, playerSource) {
  const parts = mainSource.split(MARKER);
  if (parts.length !== 2) throw new Error('Expected exactly one player source marker in moviezone.js');
  if (!playerSource.trim()) throw new Error('Player source is empty');
  return parts[0] + playerSource + parts[1];
}
function readAppSource(root = path.resolve(__dirname, '..')) {
  return assembleAppSource(
    fs.readFileSync(path.join(root, 'moviezone.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'moviezone-player.js'), 'utf8')
  );
}
module.exports = { MARKER, assembleAppSource, readAppSource };
