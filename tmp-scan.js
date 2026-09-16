'use strict';
const fs = require('fs');
const file = process.argv[2];
const t = fs.readFileSync(file, 'utf8');
const show = (label, re, limit) => {
  const seen = new Set();
  let m;
  const out = [];
  while ((m = re.exec(t)) !== null) {
    const v = m[0];
    if (!seen.has(v)) { seen.add(v); out.push(v); }
    if (out.length >= (limit || 25)) break;
  }
  console.log('\n--- ' + label + ' (' + out.length + ')');
  out.forEach((x) => console.log('   ' + x.replace(/\s+/g, ' ').slice(0, 180)));
};
show('template urls', /`[^`]{0,140}\$\{[^`]{0,90}`/g, 200);
