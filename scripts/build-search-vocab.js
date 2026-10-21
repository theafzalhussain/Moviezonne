#!/usr/bin/env node
/*  Builds search-vocab.json: the spelling dictionary search-plus.js corrects
 *  typos against.
 *
 *  TMDB's /search does no typo correction at all. Measured Oct 2026:
 *    "housful"  -> 0 results          (Housefull)
 *    "golmal"   -> Golmal Love, ...   (Golmaal)
 *    "dhamal"   -> Ajinkya Dhamal...  (Dhamaal)
 *    "kalky"    -> 0 results          (Kalki)
 *  The fuzzy ranker in search-engine.js can only re-order what TMDB returned,
 *  so when TMDB returns nothing useful there is nothing to rank. The fix is to
 *  correct the WORDS before asking TMDB, and the right words are the ones in
 *  our own catalogue: every title in sitemap-cache.json, which the SEO refresh
 *  workflow rebuilds daily, plus a short list of franchise names people search
 *  for that may not be in the sitemap yet.
 *
 *  Output: { v, generated, w } where w is one space-separated string of words,
 *  most frequent first. Position = priority when two corrections tie.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cache = JSON.parse(fs.readFileSync(path.join(ROOT, 'sitemap-cache.json'), 'utf8'));

// Franchise / character names searched on the site that are worth correcting
// towards even when the sitemap snapshot happens not to hold them.
const EXTRA = `
housefull golmaal dhamaal pheri hera chhota bheem krishna doraemon nobita shinchan
motu patlu oggy cockroaches jerry pokemon naruto boruto dragon ball goku ninja hattori
ben omniverse omnitrix pushpa baahubali kalki jailer salaar devara kantara pathaan jawan
dunki tiger singham sooryavanshi krrish dhoom stree bhediya munjya bhool bhulaiyaa
welcome phir hungama raaz race judwaa drishyam mirzapur panchayat farzi aspirants kota
squid stranger things money heist avengers spider batman superman marvel transformers
conjuring annabelle insidious avatar frozen minions despicable shrek kungfu panda madagascar
toy story cars incredibles moana encanto coco zootopia simpsons spongebob peppa
`;

const counts = new Map();
function add(word, weight) {
  if (word.length < 3 || word.length > 18) return;
  if (!/^[a-z]+$/.test(word)) return;
  counts.set(word, (counts.get(word) || 0) + weight);
}

function words(title) {
  return String(title || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(Boolean);
}

for (const list of [cache.movie || [], cache.tv || []]) {
  for (const entry of list) words(entry.title || entry.name).forEach(w => add(w, 1));
}
EXTRA.split(/\s+/).filter(Boolean).forEach(w => add(w, 3));

// Stop-words carry no spelling signal and would only win ties by frequency.
const STOP = new Set('the and for with from that this you your are was his her its our who what'.split(' '));
const ranked = [...counts.entries()]
  .filter(([w]) => !STOP.has(w))
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([w]) => w);

const out = { v: 1, generated: new Date().toISOString().slice(0, 10), w: ranked.join(' ') };
fs.writeFileSync(path.join(ROOT, 'search-vocab.json'), JSON.stringify(out));
console.log('search-vocab.json: ' + ranked.length + ' words, ' + Buffer.byteLength(JSON.stringify(out)) + ' bytes');
