/* ═══════════════════════════════════════════════════════════════════════════
   cwv-check.js — measures Core Web Vitals against the REAL page in a REAL
   browser, and asserts the things that Datadog RUM flagged as poor.

   Why this exists: asset-perf-check.js reads the source and can only prove that
   the right markup and the right cache rules are present. It cannot prove that
   the browser picked the hero <img> as its LCP candidate, that the self-hosted
   face was ready before the hero title painted, or that nothing shifted. Those
   are runtime facts, so they need a runtime measurement.

   What it asserts, in one headless run at a 412x915 mobile viewport:
     • the LCP element is the hero backdrop <img fetchpriority="high">, and the
       URL it loaded is a sized TMDB backdrop (never "original")
     • CLS stays inside the "good" band (< 0.1), with the offending nodes named
       in the failure detail when it does not
     • no request reaches fonts.googleapis.com / fonts.gstatic.com, the
       self-hosted woff2 files were fetched, and both critical faces are ready
     • every rendered <img> carries width + height
     • the loader overlay is dismissed and nothing threw

   Numbers are printed even on success, because the useful signal here is the
   trend, not just the pass.

   Skips loudly — never a false pass — when no browser binary is installed.

   Run: node cwv-check.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS = 'cwv.browser.test.html';
const RESULT_TIMEOUT_MS = 90000;

/*  moviezone.js treats localhost/127.0.0.1 as dev and hard-codes
 *  BASE = 'http://localhost:3001/api/tmdb'. The page therefore has to be served
 *  from exactly that port or every TMDB fetch in the frame fails with
 *  "Failed to fetch" and every content assertion becomes a false negative.
 *
 *  Port 3001 is also where `npm run dev` lives, so this script reuses a dev
 *  server if one is already listening instead of fighting it for the port.
 *  Results come back over a separate collector on a random port, which keeps the
 *  measurement independent of whether the page server is ours.
 *
 *  MZ_CWV_PAGE_PORT overrides the page port. That exists to measure a second
 *  checkout (e.g. a git worktree at an older commit) side by side: the page is
 *  served from the other port while /api/tmdb still resolves to whatever is on
 *  3001, which is fine because the API is not what is being compared.
 */
const APP_PORT = Number(process.env.MZ_CWV_PAGE_PORT) || 3001;

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

// Is something already serving the app on APP_PORT?
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
  });
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('SKIPPED: no Chrome/Edge binary found — cannot measure Core Web Vitals.');
    console.log('         (static guards still run via: node asset-perf-check.js)');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(__dirname, HARNESS))) {
    console.error('FAILED: ' + HARNESS + ' is missing.');
    process.exit(1);
  }

  let deliver = null;

  /*  Results collector, deliberately separate from the page server. When a dev
   *  server already owns 3001 we cannot bolt a /__results route onto it, so the
   *  harness posts here instead and the page origin becomes irrelevant.
   */
  const collector = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(204).end();
      try { if (deliver) deliver(JSON.parse(body)); }
      catch (e) { if (deliver) deliver(null); }
    });
  });
  await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const collectorPort = collector.address().port;

  // Reuse an existing dev server on 3001 if there is one; otherwise start ours.
  let ownServer = null;
  const reusing = await portInUse(APP_PORT);
  if (reusing) {
    console.log('Reusing the dev server already listening on ' + APP_PORT + '.');
  } else {
    const app = require('./server');
    ownServer = await new Promise((resolve, reject) => {
      const s = app.listen(APP_PORT, () => resolve(s));
      s.on('error', reject);
    }).catch((err) => {
      console.error('FAILED: could not serve the page on ' + APP_PORT + ': ' + err.message);
      process.exit(1);
    });
  }
  const port = APP_PORT;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzcwv-'));
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
      '--window-size=460,1000',
      '--user-data-dir=' + profileDir,
      'http://localhost:' + port + '/' + HARNESS + '?collector=' + collectorPort
    ], { stdio: 'ignore' });

    child.on('error', (err) => finish(new Error('could not launch the browser: ' + err.message)));
  }).catch((err) => {
    console.error('FAILED: ' + err.message);
    collector.close();
    if (ownServer) ownServer.close();
    process.exit(1);
  });

  collector.close();
  if (ownServer) ownServer.close();

  let failed = 0;
  console.log('\nCore Web Vitals — real page, headless browser, 412x915 viewport');
  console.log('─'.repeat(72));
  results.forEach((c) => {
    if (c.pass) {
      console.log('  PASS  ' + c.name + (c.detail ? '\n          ' + c.detail : ''));
    } else {
      failed++;
      console.log('  FAIL  ' + c.name + (c.detail ? '\n          ' + c.detail : ''));
    }
  });
  console.log('─'.repeat(72));
  console.log('  ' + (results.length - failed) + '/' + results.length + ' checks passed\n');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
