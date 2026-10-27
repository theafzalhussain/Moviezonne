'use strict';
/*  Throwaway (deleted after use). Splits the audit jobs across N Chromes, one
 *  server per Chrome (so one server's popunders and rate limits cannot spill into
 *  another's results), and waits for all of them. */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PAR = Number(process.env.PAR || 6);
const OUT = process.env.OUT || path.join(os.tmpdir(), 'mz-audit.jsonl');
const skip = (process.env.SKIP || 'Toon Hindi').split(',');
const all = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'tmp-audit-urls.js')], { env: process.env }).toString())
  .filter((j) => skip.indexOf(j.server) === -1 && !/^ERR/.test(j.url));
const byServer = new Map();
all.forEach((j) => { if (!byServer.has(j.server)) byServer.set(j.server, []); byServer.get(j.server).push(j); });
const groups = [...byServer.values()];
if (!process.env.APPEND) { try { fs.unlinkSync(OUT); } catch (e) {} }
let port = Number(process.env.BASE_PORT || 9700);
let running = 0;
let next = 0;
function launch() {
  while (running < PAR && next < groups.length) {
    const g = groups[next++];
    const jobFile = path.join(os.tmpdir(), 'mz-audit-job-' + next + '.json');
    fs.writeFileSync(jobFile, JSON.stringify(g));
    running++;
    const p = spawn(process.execPath, [path.join(__dirname, 'tmp-audit-probe.js')], {
      env: Object.assign({}, process.env, { JOBS: jobFile, OUT, PORT: String(port) }), stdio: 'inherit' });
    port += 3;
    p.on('exit', () => { running--; try { fs.unlinkSync(jobFile); } catch (e) {} if (next >= groups.length && running === 0) done(); else launch(); });
  }
}
function done() {
  const rows = fs.readFileSync(OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const titles = [...new Set(all.map((j) => j.title))];
  console.log('\n' + 'server'.padEnd(16) + titles.map((t) => t.split(' ').slice(1).join(' ').slice(0, 11).padEnd(12)).join(''));
  [...byServer.keys()].forEach((s) => {
    console.log(s.padEnd(16) + titles.map((t) => {
      const r = rows.find((x) => x.server === s && x.title === t);
      return (!r ? '?' : r.plays ? ('OK ' + (r.res !== '-' ? r.res.split('x')[1] + 'p' : '')) : 'dead').padEnd(12);
    }).join(''));
  });
  console.log('\nresults: ' + OUT);
}
launch();
