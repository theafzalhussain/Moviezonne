/*  Throwaway. Deleted after use.
 *  Serves the CURRENT server.js / seo-ssr.js on a side port so the user's own
 *  `npm run dev` on :3001 is left alone. Side-effect free: Sentry is pre-empted
 *  (instrument.js never runs) and MongoDB is off (dotenv never overrides a
 *  variable that is already set), so it cannot report errors, send pushes or
 *  touch reminder rows. Not started via app.listen in server.js's main block,
 *  so the boot-time reminder sweep never runs either.
 *  Usage: node tmp-side-server.js [port]   (or with --spawn to detach itself)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const port = Number(process.argv[2] || 3101);

if (process.argv.includes('--spawn')) {
  const { spawn } = require('child_process');
  const log = fs.openSync(path.join(os.tmpdir(), 'mzside.log'), 'w');
  const child = spawn(process.execPath, [__filename, String(port)], {
    cwd: __dirname, detached: true, stdio: ['ignore', log, log], windowsHide: true
  });
  fs.writeFileSync(path.join(os.tmpdir(), 'mzside.pid'), String(child.pid));
  child.unref();
  console.log('spawned side server pid ' + child.pid + ' on :' + port);
  process.exit(0);
}

const instrumentPath = require.resolve('./instrument.js');
require.cache[instrumentPath] = { id: instrumentPath, filename: instrumentPath, loaded: true, exports: {}, children: [] };
process.env.MONGODB_URI = '';
const app = require('./server.js');
app.listen(port, () => console.log('side server on ' + port + ' pid ' + process.pid));
