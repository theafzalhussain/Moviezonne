/* ═══════════════════════════════════════════════════════════════════════════
   cat-tabs.browser.test.js — verifies the grouped category strip in a REAL
   browser, against the REAL page.

   Why a browser test: the tab strip's behaviour depends on computed CSS
   (display:none menus), real click dispatch, and — critically — on
   loadMoreMoviesAction() being able to find `.cat-tab.active` even when that
   element sits inside a collapsed dropdown. None of that is observable from a
   static read of the markup, and getting it wrong silently breaks infinite
   scroll for every category that moved into a menu.

   Mechanism: boot the production server.js (so index.html, moviezone.js,
   moviezone.css and /api/tmdb all behave exactly as deployed), bolt a
   /__results collector onto it, then open the harness in headless Chrome.

   Skips loudly — never a false pass — when no browser binary is installed.

   Run: node cat-tabs.browser.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS = 'cat-tabs.browser.test.html';
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
    console.log('SKIPPED: no Chrome/Edge binary found — cannot run the browser-side tab tests.');
    console.log('         (markup wiring is still covered by: node cat-tabs.test.js)');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(__dirname, HARNESS))) {
    console.error('FAILED: ' + HARNESS + ' is missing.');
    process.exit(1);
  }

  // The production app, so the harness exercises the deployed wiring.
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

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzcat-'));
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
  console.log('\ncategory strip grouping — real page, headless browser');
  console.log('─'.repeat(66));
  results.forEach((c) => {
    if (c.pass) {
      console.log('  PASS  ' + c.name);
    } else {
      failed++;
      console.log('  FAIL  ' + c.name + (c.detail ? '\n          ' + c.detail : ''));
    }
  });
  console.log('─'.repeat(66));
  console.log('  ' + (results.length - failed) + '/' + results.length + ' checks passed\n');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
