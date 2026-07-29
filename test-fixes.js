const fs = require('fs');
const path = require('path');
const dir = __dirname;
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);

const manifest = JSON.parse(read('manifest.json'));
for (const key of ['name', 'short_name', 'start_url', 'scope', 'id', 'display', 'icons']) {
  check(`manifest.${key} exists`, Boolean(manifest[key]));
}
check('manifest display standalone', manifest.display === 'standalone');
check('manifest start_url/scope/id are root', manifest.start_url === '/' && manifest.scope === '/' && manifest.id === '/');
check('manifest has usable 192 icon', manifest.icons.some(i => i.sizes === '192x192' && (!i.purpose || i.purpose.includes('any'))));
check('manifest has usable 512 icon (any)', manifest.icons.some(i => i.sizes === '512x512' && (!i.purpose || i.purpose.includes('any'))));
check('manifest has usable 512 icon (maskable)', manifest.icons.some(i => i.sizes === '512x512' && i.purpose && i.purpose.includes('maskable')));
for (const icon of manifest.icons) check(`icon exists: ${icon.src}`, fs.existsSync(path.join(dir, icon.src.replace(/^\//, ''))));

const html = read('index.html');
const pwa = read('pwa-install.js');
const moviezone = read('moviezone.js');
const min = read('moviezone.min.js');
const sw = read('sw.js');
const server = read('server.js');
const vercel = JSON.parse(read('vercel.json'));

check('index has absolute manifest link', html.includes('<link rel="manifest" href="/manifest.json">'));
check('index captures beforeinstallprompt in head', html.indexOf('beforeinstallprompt') > -1 && html.indexOf('beforeinstallprompt') < html.indexOf('</head>'));
check('index registers SW early', html.indexOf(".register('/sw.js'") > -1 && html.indexOf(".register('/sw.js'") < html.indexOf('</head>'));
check('index has no forced reload loop', !html.includes('window.location.reload') && !html.includes('reloadOnceForControl'));
check('index waits for controllerchange', html.includes("addEventListener('controllerchange'"));
check('index loads pwa-install v1.4', html.includes('pwa-install.js?v=1.4'));

check('pwa-install has no BOM', pwa.charCodeAt(0) !== 0xFEFF);
check('pwa-install keeps one deferred prompt source', pwa.includes('window.deferredPrompt'));
check('pwa-install prevents default', pwa.includes('e.preventDefault()'));
check('pwa-install calls native prompt', pwa.includes('await promptEvent.prompt()'));
check('pwa-install awaits userChoice', pwa.includes('await promptEvent.userChoice'));
check('pwa-install no QR truncation', !pwa.includes('parsedData.splice(this.parsedData.length - 2, 2)'));
check('pwa-install QR uses current href', pwa.includes('window.location.href'));
check('pwa-install QR API configured', pwa.includes('https://api.qrserver.com/v1/create-qr-code/'));
check('pwa-install has 20s engagement delay', pwa.includes('SHOW_DELAY_MS = 20000'));
check('pwa-install cancels delayed popup when ready', pwa.includes('clearTimeout(popupTimer)'));
check('pwa-install explains engagement/cooldown policy', pwa.includes('engagement threshold') && pwa.includes('dismissal cooldown'));
check('pwa-install has no obsolete reload queue', !pwa.includes('__mzControlReloadQueued'));
check('pwa-install delayed event requires another click', pwa.includes('Ready — tap to install') && pwa.includes('fresh direct click'));
check('moviezone has no second prompt() implementation', !moviezone.includes('.prompt()'));
check('moviezone delegates to canonical trigger', moviezone.includes('__mzTriggerInstall'));
check('min bundle regenerated from canonical trigger', min.includes('__mzTriggerInstall'));

check('SW cache is v18', sw.includes("CACHE_NAME = 'moviezone-v18'"));
check('SW caches pwa-install v1.4', sw.includes("'/pwa-install.js?v=1.4'"));
check('SW uses skipWaiting and clients.claim', sw.includes('self.skipWaiting()') && sw.includes('self.clients.claim()'));
check('server manifest MIME configured', server.includes('application/manifest+json'));
check('server SW MIME configured', server.includes("res.type('application/javascript')"));
const swHeaders = vercel.headers.find(h => h.source === '/sw.js');
check('Vercel SW has JavaScript MIME', swHeaders && swHeaders.headers.some(h => h.key === 'Content-Type' && h.value.includes('application/javascript')));
check('Vercel static JS glob excludes server.js', vercel.builds.some(b => b.use === '@vercel/static' && b.src.includes('search-engine')) && !vercel.builds.some(b => b.use === '@vercel/static' && b.src.includes('**/*') && b.src.includes('js')));

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
