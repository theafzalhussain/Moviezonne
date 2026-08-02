/* ═══════════════════════════════════════════════════════════════════════════
   cat-tabs.mobile.browser.test.js — verifies the OTT Platform / Category
   dropdowns at PHONE widths, in a real browser, against the real page.

   Why a separate suite from cat-tabs.browser.test.js: that one drives a 1280px
   frame, and the phone layout is a different machine. Under 768px the tab strip
   becomes a horizontal scroller, which
     • shrinks the `.cat-group` wrapper (it is not a `.cat-tab`, so it did not
       get `flex: 0 0 auto`) until its trigger spills over the next pill, and
     • clips the dropdown panel on both axes, which made tapping a pill look
       like a no-op.
   Neither is observable from the markup or at desktop width, and both shipped.

   The browser is launched with an Android user agent so the mobile branches in
   moviezone.js (isMobile) are the ones under test.

   Mechanism: boot the production server.js (so index.html, moviezone.js,
   moviezone.css and /api/tmdb behave exactly as deployed), bolt a /__results
   collector onto it, then open the harness in headless Chrome.

   Skips loudly — never a false pass — when no browser binary is installed.

   Run: node cat-tabs.mobile.browser.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS = 'cat-tabs.mobile.browser.test.html';
const RESULT_TIMEOUT_MS = 90000;

// A real phone UA: moviezone.js keys `isMobile` off it, and the point of this
// suite is to exercise the phone code path rather than a narrow desktop window.
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

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
    console.log('SKIPPED: no Chrome/Edge binary found — cannot run the mobile dropdown tests.');
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

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzcatmob-'));
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
      // Roomy enough to hold a phone-sized iframe without the harness page
      // itself introducing a scrollbar that changes the frame's width.
      '--window-size=1000,1100',
      '--user-agent=' + MOBILE_UA,
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
  console.log('\nmobile category dropdowns — real page, phone-sized frames, headless browser');
  console.log('─'.repeat(74));
  results.forEach((c) => {
    if (c.pass) {
      console.log('  PASS  ' + c.name);
    } else {
      failed++;
      console.log('  FAIL  ' + c.name + (c.detail ? '\n          ' + c.detail : ''));
    }
  });
  console.log('─'.repeat(74));
  console.log('  ' + (results.length - failed) + '/' + results.length + ' checks passed\n');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
