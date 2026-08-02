/* ═══════════════════════════════════════════════════════════════════════════
   all-feed-ranking.browser.test.js — verifies the freshness ranking of the
   "ALL MOVIES & SHOWS" feed in a REAL browser, against the REAL page.

   What is under test: the ALL feed enforces product priority before any score:
   latest movie releases, then recent movie quality updates, then remaining
   movies, followed by latest/trending web series and anime. Freshness tiers and
   composite relevance only order titles inside one priority group. The suite
   also verifies that language balancing cannot move a series above a movie.

   Why a browser test: moviezone.js is a classic browser script with no module
   exports, and the badge half of the feature only exists once a card is
   rendered. Both halves read the same timeline table, and the whole thing is
   date arithmetic against thresholds — an off-by-one or a reordered stage
   silently degrades the feed back to "most popular first" while everything
   still looks fine on screen.

   Mechanism: boot the production server.js, bolt a /__results collector onto
   it, then open the harness in headless Chrome and drive the real helpers with
   synthetic titles whose release dates are pinned relative to now.

   Skips loudly — never a false pass — when no browser binary is installed.

   Run: node all-feed-ranking.browser.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS = 'all-feed-ranking.browser.test.html';
const RESULT_TIMEOUT_MS = 60000;

const BROWSER_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('SKIPPED: no Chrome/Edge binary found — cannot run the ALL feed ranking tests.');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(__dirname, HARNESS))) {
    console.error('FAILED: ' + HARNESS + ' is missing.');
    process.exit(1);
  }

  const app = require('./server');

  let deliver = null;
  app.post('/__results', (req, res) => {
    res.status(204).end();
    if (deliver) deliver(req.body);
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzrank-'));
  let child = null;

  const results = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error('the harness did not report within ' + (RESULT_TIMEOUT_MS / 1000) + 's'));
    }, RESULT_TIMEOUT_MS);

    let settled = false;
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) { try { child.kill(); } catch (e) {} }
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
      if (err) reject(err); else resolve(value);
    }

    deliver = (body) => {
      if (!Array.isArray(body) || body.length === 0) {
        finish(new Error('the harness reported no checks'));
        return;
      }
      finish(null, body);
    };

    child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,1000',
      '--user-data-dir=' + profileDir,
      'http://127.0.0.1:' + port + '/' + HARNESS
    ], { stdio: 'ignore' });

    child.on('error', (err) => finish(new Error('could not launch the browser: ' + err.message)));
  }).catch((err) => {
    console.error('FAILED: ' + err.message);
    server.close();
    process.exit(1);
  });

  server.close();

  let failed = 0;
  console.log('\nALL feed freshness ranking — real page, headless browser');
  console.log('─'.repeat(70));
  results.forEach((c) => {
    if (c.pass) {
      console.log('  PASS  ' + c.name);
    } else {
      failed++;
      console.log('  FAIL  ' + c.name + (c.detail ? '\n          ' + c.detail : ''));
    }
  });
  console.log('─'.repeat(70));
  console.log('  ' + (results.length - failed) + '/' + results.length + ' checks passed\n');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
