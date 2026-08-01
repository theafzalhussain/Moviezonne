/* ═══════════════════════════════════════════════════════════════════════════
   tv-mode.browser.test.js — runs tv-mode.js's DOM layer in a REAL browser.

   tv-mode.test.js covers the pure logic. This file verifies what only a browser
   can answer: does focus() actually move, does the D-pad traverse a real grid by
   geometry, does Back close overlays in the right order, are text fields left
   alone, do the platform-specific remote keycodes reach the handler.

   Mechanism: serve the repo over loopback HTTP, open the harness page in
   headless Chrome/Edge, and wait for the page to POST its verdict back. Serving
   over HTTP (rather than file://) keeps module loading, fetch and timer
   behaviour identical to production.

   Skips loudly — never a false pass — when no browser binary is installed.

   Run: node tv-mode.browser.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HARNESS_PAGES = [
  { file: 'tv-mode.browser.test.html', label: 'TV (spoofed Tizen user agent)' },
  { file: 'tv-mode.browser.nontv.test.html', label: 'desktop regression (no TV signal)' }
];
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function startServer(onResults) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__results') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(204).end();
        onResults(body);
      });
      return;
    }

    const requested = decodeURIComponent((req.url || '/').split('?')[0]);
    const relative = requested.replace(/^\/+/, '');
    const filePath = path.resolve(__dirname, relative);

    // Never serve outside the project directory.
    if (filePath !== __dirname && !filePath.startsWith(__dirname + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  });
  return server;
}

// Opens one harness page in a fresh browser profile and resolves with its checks.
function runPage(browser, port, page) {
  return new Promise((resolve, reject) => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mztv-'));
    let settled = false;
    let child = null;

    const timer = setTimeout(() => {
      done(new Error('page "' + page.file + '" did not report within ' + (RESULT_TIMEOUT_MS / 1000) + 's'));
    }, RESULT_TIMEOUT_MS);

    function done(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending = null;
      if (child) { try { child.kill(); } catch (e) {} }
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
      if (err) reject(err); else resolve(value);
    }

    pending = (body) => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (err) { done(new Error('page "' + page.file + '" sent invalid JSON: ' + err.message)); return; }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        done(new Error('page "' + page.file + '" sent no checks'));
        return;
      }
      done(null, parsed);
    };

    child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1920,1080',
      '--user-data-dir=' + profileDir,
      'http://127.0.0.1:' + port + '/' + page.file
    ], { stdio: 'ignore' });

    child.on('error', (err) => done(new Error('could not launch the browser: ' + err.message)));
  });
}

// Set by runPage while a page is in flight; the server routes POSTs here.
let pending = null;

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('SKIPPED: no Chrome/Edge binary found — cannot run the browser-side TV tests.');
    console.log('         (pure logic is still covered by: node tv-mode.test.js)');
    process.exit(0);
  }
  for (const page of HARNESS_PAGES) {
    if (!fs.existsSync(path.join(__dirname, page.file))) {
      console.error('FAILED: ' + page.file + ' is missing.');
      process.exit(1);
    }
  }
  console.log('browser: ' + path.basename(browser));

  const server = startServer((body) => { if (pending) pending(body); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let total = 0;
  let failures = [];

  try {
    for (const page of HARNESS_PAGES) {
      const results = await runPage(browser, port, page);
      const failed = results.filter(r => !r.pass);
      total += results.length;
      failed.forEach(r => failures.push('[' + page.label + '] ' + r.label + (r.detail ? ' — ' + r.detail : '')));
      console.log('  ' + page.label + ': ' + (results.length - failed.length) + '/' + results.length + ' passed');
    }
  } catch (err) {
    console.error('FAILED: ' + err.message);
    server.close();
    process.exit(1);
  }

  server.close();
  failures.forEach(f => console.log('FAIL  ' + f));
  console.log('\n' + '='.repeat(62));
  if (failures.length === 0) console.log('ALL ' + total + ' BROWSER TV CHECKS PASSED');
  else console.log((total - failures.length) + ' passed, ' + failures.length + ' FAILED');
  console.log('='.repeat(62));

  // The killed browser children can keep the event loop alive on Windows.
  setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 150);
}

main();
