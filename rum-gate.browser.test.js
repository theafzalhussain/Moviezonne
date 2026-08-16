/* ═══════════════════════════════════════════════════════════════════════════
   rum-gate.browser.test.js — verifies the Datadog RUM profile gate in a REAL
   browser, against the REAL index.html, once per user-agent profile.

   WHAT IS UNDER TEST
   index.html decides three things BEFORE requesting the RUM agent:
     • a real crawler gets no agent at all (bot sessions are not user sessions)
     • a dev host reports env "development" and samples nothing, so localhost
       errors can never land in the production error feed again
     • a weak device (TV, or fewer than 4 cores / under 4 GB) keeps errors and
       metrics but loses Session Replay, the most expensive RUM feature on INP

   WHY A BROWSER TEST
   The gate reads navigator.userAgent, navigator.hardwareConcurrency,
   navigator.deviceMemory and location.hostname. None of that exists in Node, and
   a source-level regex cannot tell whether the agent was actually requested —
   which is the entire point of the crawler branch. So: launch headless Chrome
   once per UA with --user-agent, and read the decisions plus the real resource
   timings out of the page.

   Skips loudly — never a false pass — when no browser binary is installed.

   Run: node rum-gate.browser.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS = 'rum-gate.browser.test.html';
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

/*  One profile per real-world visitor class. The TV string is a Tizen UA, the
 *  same one tv-perf-check drives the TV budget with. */
const PROFILES = [
  {
    name: 'desktop Chrome',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    expectAgent: true
  },
  {
    name: 'Googlebot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/125.0.0.0 Safari/537.36',
    expectAgent: false
  },
  {
    name: 'Samsung Tizen TV',
    ua: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.0 TV Safari/537.36',
    expectAgent: true
  }
];

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const checks = [];
function ok(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}

/** Opens the harness once with the given UA and resolves the reported payload. */
function probe(browser, port, ua) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzrum-'));
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('the harness did not report within '
      + (RESULT_TIMEOUT_MS / 1000) + 's')), RESULT_TIMEOUT_MS);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) { try { child.kill(); } catch (e) {} }
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
      if (err) reject(err); else resolve(value);
    }

    module.exports.deliver = finish;
    global.__mzRumDeliver = (body) => finish(null, body);

    child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--window-size=1440,1000',
      '--user-agent=' + ua,
      '--user-data-dir=' + profileDir,
      'http://127.0.0.1:' + port + '/' + HARNESS
    ], { stdio: 'ignore' });

    child.on('error', (err) => finish(new Error('could not launch the browser: ' + err.message)));
  });
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('SKIPPED: no Chrome/Edge binary found — cannot run the RUM gate tests.');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(__dirname, HARNESS))) {
    console.error('FAILED: ' + HARNESS + ' is missing.');
    process.exit(1);
  }

  const app = require('./server');
  app.post('/__results', (req, res) => {
    res.status(204).end();
    if (global.__mzRumDeliver) global.__mzRumDeliver(req.body);
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    for (const profile of PROFILES) {
      const r = await probe(browser, port, profile.ua);

      ok(profile.name + ': the gate ran and exported its decisions',
        r.hasProfile && r.profile, JSON.stringify(r.profile));
      if (!r.hasProfile || !r.profile) continue;

      ok(profile.name + ': no uncaught error in the page', !r.error, r.error || '');

      // The crawler branch: measured by whether the agent was fetched at all.
      ok(profile.name + ': agent ' + (profile.expectAgent ? 'is' : 'is not') + ' requested',
        r.agentRequested === profile.expectAgent,
        'agentRequested=' + r.agentRequested + ' skipped=' + r.profile.skipped);
      ok(profile.name + ': skipped flag matches the agent decision',
        r.profile.skipped === !profile.expectAgent, 'skipped=' + r.profile.skipped);

      /*  Dev isolation. The harness is served from 127.0.0.1, so every profile
       *  must report the development branch — this is the check that would have
       *  caught the old hardcoded env:'production'. */
      ok(profile.name + ': a dev host reports env "development"',
        r.profile.env === 'development', 'env=' + r.profile.env);
      ok(profile.name + ': a dev host samples no sessions',
        r.profile.sessionSampleRate === 0, 'sessionSampleRate=' + r.profile.sessionSampleRate);

      /*  Replay budget. Asserted against the SAME rule the gate documents
       *  (TV, or under 4 cores / under 4 GB) rather than a hardcoded number, so
       *  the test is valid on a small CI box as well as a workstation. */
      const tvUA = /tizen|smart-?tv/i.test(r.ua);
      const shouldBeWeak = tvUA || (r.cores > 0 && r.cores < 4) || (r.memory > 0 && r.memory < 4);
      ok(profile.name + ': weak-device verdict follows cores/memory/TV',
        r.profile.weakDevice === shouldBeWeak,
        'weakDevice=' + r.profile.weakDevice + ' cores=' + r.cores + ' memory=' + r.memory
          + ' tvUA=' + tvUA);
      ok(profile.name + ': Session Replay is ' + (shouldBeWeak ? 'off' : 'on') + ' for this device',
        r.profile.sessionReplaySampleRate === (shouldBeWeak ? 0 : 10),
        'sessionReplaySampleRate=' + r.profile.sessionReplaySampleRate);
    }
  } catch (err) {
    console.error('FAILED: ' + err.message);
    server.close();
    process.exit(1);
  }

  server.close();

  let failed = 0;
  console.log('\nDatadog RUM profile gate — real page, headless browser');
  console.log('─'.repeat(70));
  checks.forEach((c) => {
    if (c.pass) {
      console.log('  PASS  ' + c.name);
    } else {
      failed++;
      console.log('  FAIL  ' + c.name + (c.detail ? '\n          ' + c.detail : ''));
    }
  });
  console.log('─'.repeat(70));
  console.log('  ' + (checks.length - failed) + '/' + checks.length + ' checks passed\n');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
