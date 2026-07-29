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
check('manifest declares itself for installed-related-app detection', Array.isArray(manifest.related_applications) && manifest.related_applications.some(app => app.platform === 'webapp' && app.url === '/manifest.json'));
for (const icon of manifest.icons) check(`icon exists: ${icon.src}`, fs.existsSync(path.join(dir, icon.src.replace(/^\//, ''))));

const html = read('index.html');
const pwa = read('pwa-install.js');
const moviezone = read('moviezone.js');
const css = read('moviezone.css');
const min = read('moviezone.min.js');
const sw = read('sw.js');
const server = read('server.js');
const vercel = JSON.parse(read('vercel.json'));

check('index has absolute manifest link', html.includes('<link rel="manifest" href="/manifest.json">'));
check('index captures beforeinstallprompt in head', html.indexOf('beforeinstallprompt') > -1 && html.indexOf('beforeinstallprompt') < html.indexOf('</head>'));
check('index registers SW early', html.indexOf(".register('/sw.js'") > -1 && html.indexOf(".register('/sw.js'") < html.indexOf('</head>'));
check('index has no forced reload loop', !html.includes('window.location.reload') && !html.includes('reloadOnceForControl'));
check('index waits for controllerchange', html.includes("addEventListener('controllerchange'"));
check('index loads pwa-install v1.5', html.includes('pwa-install.js?v=1.5'));
check('index loads moviezone v4.4', html.includes('moviezone.js?v=4.4') && !html.includes('moviezone.js?v=4.3'));
check('index keeps moviezone styles v4.0', html.includes('moviezone.css?v=4.0') && !html.includes('moviezone.css?v=4.1'));

check('pwa-install has no BOM', pwa.charCodeAt(0) !== 0xFEFF);
check('pwa-install keeps one deferred prompt source', pwa.includes('window.deferredPrompt'));
check('pwa-install prevents default', pwa.includes('e.preventDefault()'));
check('pwa-install calls native prompt', pwa.includes('await promptEvent.prompt()'));
check('pwa-install awaits userChoice', pwa.includes('await promptEvent.userChoice'));
check('pwa-install no QR truncation', !pwa.includes('parsedData.splice(this.parsedData.length - 2, 2)'));
check('pwa-install QR uses current href', pwa.includes('window.location.href'));
check('pwa-install QR API configured', pwa.includes('https://api.qrserver.com/v1/create-qr-code/'));
check('pwa-install shows uninstalled popup on each refresh after 3s', pwa.includes('SHOW_DELAY_MS = 3000') && pwa.includes('popupShownThisLoad') && pwa.includes('before-auto-popup'));
check('pwa-install cancels delayed popup when ready', pwa.includes('clearTimeout(popupTimer)'));
check('pwa-install explains engagement/cooldown policy', pwa.includes('engagement threshold') && pwa.includes('dismissal cooldown'));
check('pwa-install has no obsolete reload queue', !pwa.includes('__mzControlReloadQueued'));
check('pwa-install delayed event requires another click', pwa.includes('Ready — tap to install') && pwa.includes('fresh direct click'));
check('shared PWA monitor is exposed', pwa.includes('window.__mzPwaInstallMonitor') && pwa.includes('refreshInstalledState'));
check('installed state hides both popup and navbar', pwa.includes("navBtn.style.display = installed ? 'none' : 'flex'") && pwa.includes('closePopup(false)') && pwa.includes('closeTvPopup(false)'));
check('native install and uninstall evidence updates state', pwa.includes("window.addEventListener('appinstalled'") && pwa.includes("refreshInstalledState('native-prompt-ready', false)"));
check('PWA state is monitored while page lives', pwa.includes('display-mode-change') && pwa.includes('visibilitychange') && pwa.includes('periodic-monitor'));
check('TV and desktop popup no longer use dismissal cooldown', !pwa.includes('recentlyDismissed('));
check('moviezone navbar consumes shared PWA state', moviezone.includes("addEventListener('mz:pwa-statechange'") && moviezone.includes('__mzPwaInstallMonitor'));
check('server fallback manifest declares related webapp', server.includes('related_applications') && server.includes("platform: 'webapp'"));
check('moviezone has no second prompt() implementation', !moviezone.includes('.prompt()'));
check('moviezone delegates to canonical trigger', moviezone.includes('__mzTriggerInstall'));
check('min bundle regenerated from canonical trigger', min.includes('__mzTriggerInstall'));

// VidCore and the abandoned provider panel must both stay removed.
check('VidCore embed and preconnect are removed', !moviezone.includes('VidCore') && !moviezone.includes('vidcore.org'));
check('official OTT provider panel is removed', !moviezone.includes('/watch/providers') && !moviezone.includes('officialWatchProvider') && !css.includes('.official-watch'));
check('min bundle contains neither VidCore nor provider panel', !min.includes('vidcore.org') && !min.includes('watch/providers') && !min.includes('JustWatch via TMDB'));

// Detail/watch-page navigation must require a fresh, explicit activation.
check('detail activation guard exists', moviezone.includes('function claimExplicitDetailActivation(event)'));
check('viewport resize blocks detail activation', moviezone.includes("window.addEventListener('resize', blockDetailActivationForViewportChange") && moviezone.includes('DETAIL_VIEWPORT_SETTLE_MS'));
check('orientation change blocks detail activation', moviezone.includes("window.addEventListener('orientationchange', blockDetailActivationForViewportChange"));
check('watch modal claims activation before history navigation', /async function openModal\([^)]*activationEvent[^)]*\)\s*\{\s*if \(!claimExplicitDetailActivation\(activationEvent\)\) return;\s*\/\/ Add hash/.test(moviezone));
check('upcoming detail claims activation before opening', /async function openUpcomingDetail\([^)]*activationEvent[^)]*\)\s*\{\s*if \(!claimExplicitDetailActivation\(activationEvent\)\) return;/.test(moviezone));
check('TV launch key requires release or deliberate navigation', moviezone.includes("document.addEventListener('keyup'") && moviezone.includes('tvActivationArmed') && moviezone.includes('D-pad movement proves'));
check('stale watch hash is cleaned without auto-open', moviezone.includes("if (window.location.hash.startsWith('#watch-'))") && moviezone.includes('Disabled auto-open'));
check('all detail callsites propagate activation evidence', !moviezone.includes('openModal(m.id, type);') && !moviezone.includes('openModal(item.id, type);') && !moviezone.includes('openUpcomingDetail(m.id);'));

check('SW cache is v30', sw.includes("CACHE_NAME = 'moviezone-v30'"));
check('SW caches moviezone v4.4', sw.includes("'/moviezone.js?v=4.4'"));
check('SW caches pwa-install v1.5', sw.includes("'/pwa-install.js?v=1.5'"));
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
