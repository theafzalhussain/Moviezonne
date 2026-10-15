/*  Throwaway. Deleted after use. Minified size of the blocks added this session. */
'use strict';
const fs = require('fs');
const { minify } = require('terser');
const src = fs.readFileSync('moviezone.js', 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const i = src.indexOf(a); const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('marker not found: ' + a);
  return src.slice(i, j + b.length);
};
(async () => {
  const blocks = {
    'image fallback (page)': slice('const MZ_TMDB_IMG_RE', '}, 12000);'),
    'light posters': slice('const MZ_LIGHT_POSTERS', "' 500w');\n}"),
    'handshake watchdog': slice('const MZ_SIGNAL_GRACE_MS', 'MZ_SIGNAL_GRACE_MS);\n}'),
    'dead language consts': slice('const DUBBED_LANGS', "const EXTRA_LANGS  = ['ml', 'kn', 'mr', 'bn'];"),
  };
  let total = 0;
  for (const [k, v] of Object.entries(blocks)) {
    const m = (await minify(v, { compress: true, mangle: true })).code;
    total += m.length;
    console.log(k.padEnd(24), (m.length / 1024).toFixed(2), 'KB min');
  }
  console.log('sum'.padEnd(24), (total / 1024).toFixed(2), 'KB min');
})().catch((e) => { console.error(e.message); process.exit(1); });
