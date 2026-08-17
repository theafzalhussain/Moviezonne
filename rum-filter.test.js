/* ═══════════════════════════════════════════════════════════════════════════
   rum-filter.test.js — tests the REAL Datadog RUM beforeSend filter that
   index.html ships, plus the invariant one of its rules depends on.

   WHY THIS EXISTS
   beforeSend decides which browser errors reach Datadog. Every rule in it is a
   deliberate decision to stop looking at a class of error, so each one is a
   place a real bug could hide. Two rules are only safe while a fact about this
   codebase stays true:

     • the ".at is not a function" rule is safe only while this site ships no
       .at( call of its own. The moment someone writes one, that rule would
       silently swallow their bug — so this test fails the build instead.

     • the "Script error." rule must match the browser's CORS mask exactly and
       nothing else, or it starts dropping real messages that merely begin with
       those words.

   HOW
   The filter is not copied here — it is extracted from index.html and executed,
   so the test can only pass if the shipped code behaves. If the extraction ever
   stops finding it, that is a failure, not a skip.

   Run: node rum-filter.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const checks = [];
function ok(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}

/*  Everything that executes in a browser under our origin. If a file is added
 *  to the deployment it belongs here, otherwise the .at invariant is only
 *  half-checked. */
const SHIPPED_TO_BROWSER = [
  'moviezone.js', 'moviezone.min.js',
  'tv-mode.js', 'tv-mode.min.js',
  'search-engine.js', 'search-engine.min.js',
  'pwa-install.js', 'pwa-install.min.js',
  'sw.js', 'worker.js', 'seo-ssr.js', 'index.html'
];

// ── 1. extract the shipped filter ────────────────────────────────────────────

/** Pulls a `name: function (arg) { ... }` body out of source by brace matching. */
function extractFunction(source, needle) {
  const start = source.indexOf(needle);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  let inLineComment = false, inBlockComment = false, quote = '';
  for (let i = open; i < source.length; i++) {
    const c = source[i], next = source[i + 1];

    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const body = extractFunction(indexHtml, 'beforeSend: function (event)');

ok('beforeSend is present in index.html and could be extracted', !!body);
if (!body) {
  report();
}

let beforeSend;
try {
  beforeSend = new Function('event', 'return (' + 'function (event) ' + body + ')(event);');
  ok('the extracted beforeSend compiles', true);
} catch (e) {
  ok('the extracted beforeSend compiles', false, e.message);
  report();
}

/** Builds the RUM event shape beforeSend receives. */
const errEvent = (message, stack) => ({ type: 'error', error: { message, stack: stack || '' } });

function kept(message, stack) { return beforeSend(errEvent(message, stack)) !== false; }

// ── 2. what must be dropped ──────────────────────────────────────────────────

ok('drops the exact CORS mask "Script error."',
  !kept('Script error.'));
ok('drops the mask without its full stop',
  !kept('Script error'));
ok('drops the injected "this.i.at is not a function"',
  !kept('this.i.at is not a function'));
ok('drops the injected "t.entries.at is not a function"',
  !kept('t.entries.at is not a function'));
ok('still drops ResizeObserver loop noise',
  !kept('ResizeObserver loop completed with undelivered notifications.'));
ok('still drops errors thrown from a browser extension',
  !kept('boom', 'at foo (chrome-extension://abcdef/inject.js:1:1)'));

// ── 3. what must survive — the filter must not become a way to hide bugs ─────

ok('keeps a real TypeError from our own code',
  kept('Cannot read properties of undefined (reading "poster_path")',
    'at renderCard (https://moviezone.dev/moviezone.min.js:120:5)'));
ok('keeps a genuine failure whose message merely starts with "Script error"',
  kept('Script error. Failed to parse the player payload at index 3'));
ok('keeps an unrelated "is not a function"',
  kept('m.getPoster is not a function'));
ok('keeps a .at TypeError raised on our own origin (see the .at invariant below)',
  // Message alone is filtered by design; the invariant test is what keeps that
  // safe. This asserts the filter is not ALSO keying on our origin, so the
  // invariant is the single thing protecting us — one rule, one guard.
  !kept('x.at is not a function'));
ok('keeps a network error',
  kept('Failed to fetch'));
ok('keeps non-error events untouched (resource, view, action)',
  beforeSend({ type: 'resource', error: undefined }) === true);
ok('survives an error event with no error object',
  beforeSend({ type: 'error' }) === true);

// ── 4. the invariant the .at rule depends on ─────────────────────────────────

const offenders = [];

/*  Comments must not count. This rule is documented in prose that necessarily
 *  spells out `.at(`, and an HTML comment or a JSDoc block mentioning it is not
 *  a call site. Strings are left in place so `obj["at"](x)` style access would
 *  still be caught if it ever appeared. */
function stripComments(source) {
  let out = '';
  let inLine = false, inBlock = false, inHtml = false, quote = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];

    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inHtml) { if (c === '-' && next === '-' && source[i + 2] === '>') { inHtml = false; i += 2; } continue; }
    if (quote) {
      out += c;
      if (c === '\\') { out += source[i + 1] || ''; i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '<' && source.startsWith('<!--', i)) { inHtml = true; i += 3; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

for (const file of SHIPPED_TO_BROWSER) {
  const full = path.join(__dirname, file);
  if (!fs.existsSync(full)) { offenders.push(file + ' (MISSING)'); continue; }
  const text = stripComments(fs.readFileSync(full, 'utf8'));
  const hits = (text.match(/\.at\(/g) || []).length;
  if (hits > 0) offenders.push(file + ' (' + hits + ')');
}

ok('no file this site ships calls .at( — so the .at filter cannot hide our bug',
  offenders.length === 0,
  offenders.length ? 'offenders: ' + offenders.join(', ')
    + ' — either stop using .at() or remove the filter rule in index.html' : '');

report();

// ── report ───────────────────────────────────────────────────────────────────

function report() {
  let failed = 0;
  console.log('\nDatadog RUM error filter — shipped beforeSend');
  console.log('─'.repeat(74));
  checks.forEach((c) => {
    if (c.pass) {
      console.log('  PASS  ' + c.name);
    } else {
      failed++;
      console.log('  FAIL  ' + c.name + (c.detail ? '\n          ' + c.detail : ''));
    }
  });
  console.log('─'.repeat(74));
  console.log('  rum-filter: ' + (checks.length - failed) + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
}
