const fs = require('fs');
const path = require('path');
const dir = __dirname;
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const checks = [];
const check = (name, ok) => checks.push([name, Boolean(ok)]);

const manifest = JSON.parse(read('manifest.json'));
const collectionsCatalog = JSON.parse(read('collections-catalog.json'));
for (const key of ['name', 'short_name', 'start_url', 'scope', 'id', 'display', 'icons']) {
  check(`manifest.${key} exists`, Boolean(manifest[key]));
}
check('manifest display standalone', manifest.display === 'standalone');
check('manifest start_url/scope/id are root', manifest.start_url === '/' && manifest.scope === '/' && manifest.id === '/');
check('manifest relaunch navigates existing client to root', manifest.launch_handler && manifest.launch_handler.client_mode === 'navigate-existing');
check('manifest has usable 192 icon', manifest.icons.some(i => i.sizes === '192x192' && (!i.purpose || i.purpose.includes('any'))));
check('manifest has usable 512 icon (any)', manifest.icons.some(i => i.sizes === '512x512' && (!i.purpose || i.purpose.includes('any'))));
check('manifest has usable 512 icon (maskable)', manifest.icons.some(i => i.sizes === '512x512' && i.purpose && i.purpose.includes('maskable')));
check('manifest declares itself for installed-related-app detection', Array.isArray(manifest.related_applications) && manifest.related_applications.some(app => app.platform === 'webapp' && app.url === '/manifest.json'));
for (const icon of manifest.icons) check(`icon exists: ${icon.src}`, fs.existsSync(path.join(dir, icon.src.replace(/^\//, '').split('?')[0])));

const html = read('index.html');
const pwa = read('pwa-install.js');
const moviezone = read('moviezone.js');
const css = read('moviezone.css');
const tvJs = read('tv-mode.js');
const tvCss = read('tv-mode.css');
const min = read('moviezone.min.js');
const sw = read('sw.js');
const server = read('server.js');
const vercel = JSON.parse(read('vercel.json'));

check('index has absolute manifest link', html.includes('<link rel="manifest" href="/manifest.json">'));
check('index captures beforeinstallprompt in head', html.indexOf('beforeinstallprompt') > -1 && html.indexOf('beforeinstallprompt') < html.indexOf('</head>'));
check('index registers SW early', html.indexOf(".register('/sw.js'") > -1 && html.indexOf(".register('/sw.js'") < html.indexOf('</head>'));
check('index has no forced reload loop', !html.includes('window.location.reload') && !html.includes('reloadOnceForControl'));
check('index waits for controllerchange', html.includes("addEventListener('controllerchange'"));
check('index loads pwa-install v1.6', html.includes('pwa-install.js?v=1.6') && !html.includes('pwa-install.js?v=1.5'));
check('index loads moviezone v5.1', html.includes('moviezone.js?v=5.1') && !html.includes('moviezone.js?v=5.0'));
check('index loads moviezone styles v4.4', html.includes('moviezone.css?v=4.4') && !html.includes('moviezone.css?v=4.3'));
check('index uses versioned website and browser branding',
  html.includes('src="/moviezone-logo.png?v=2"') &&
  html.includes('href="/favicon-32.png?v=2"') &&
  html.includes('href="/apple-touch-icon.png?v=2"'));
check('manifest uses versioned replacement app icons',
  manifest.icons.length >= 4 && manifest.icons.every(icon => icon.src.endsWith('?v=2')));
check('base CSS hides app artwork from website navbar and loader',
  css.includes('App/TV artwork stays hidden') &&
  /\.nav-logo-tv,\s*\.loader-logo-tv\s*\{\s*display:\s*none/.test(css) &&
  /\.nav-logo-mark\s*\{[\s\S]*?display:\s*grid/.test(css) &&
  !css.includes('.nav-logo-mark,\n.loader-icon'));
check('index declares modern mobile PWA capability', html.includes('<meta name="mobile-web-app-capable" content="yes">'));
check('collections catalog contains all configured universes', collectionsCatalog && collectionsCatalog.universes && Object.keys(collectionsCatalog.universes).length >= 18);
check('collections loader uses deployed absolute v2 asset', moviezone.includes("fetch('/collections-catalog.json?v=2'"));

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
check('Chromium normal-tab fallback suppresses false install UI', pwa.includes('function isChromiumRuntime()') && pwa.includes('function chromiumSuppressesInstallPrompt()') && pwa.includes('window.__mzPromptCaptureReady === true'));
check('Chromium fallback tolerates DevTools mobile UA emulation', pwa.includes('Do not rely on Android/Mobile tokens here') && pwa.includes('if (isIOS()) return false;') && !pwa.includes('if (isIOS() || /Android'));
check('late native prompt overrides Chromium fallback', pwa.includes("refreshInstalledState('native-prompt-ready', false)") && pwa.includes('prepareUninstalledUI()'));
check('installed state hides both popup and navbar', pwa.includes("navBtn.style.display = installed ? 'none' : 'flex'") && pwa.includes('closePopup(false)') && pwa.includes('closeTvPopup(false)'));
check('native install and uninstall evidence updates state', pwa.includes("window.addEventListener('appinstalled'") && pwa.includes("refreshInstalledState('native-prompt-ready', false)"));
check('PWA state is monitored while page lives', pwa.includes('display-mode-change') && pwa.includes('visibilitychange') && pwa.includes('periodic-monitor'));
check('TV and desktop popup no longer use dismissal cooldown', !pwa.includes('recentlyDismissed('));
check('moviezone navbar consumes shared PWA state', moviezone.includes("addEventListener('mz:pwa-statechange'") && moviezone.includes('__mzPwaInstallMonitor'));
check('server fallback manifest declares related webapp', server.includes('related_applications') && server.includes("platform: 'webapp'"));
check('server fallback manifest preserves root relaunch navigation', server.includes("launch_handler: { client_mode: 'navigate-existing' }"));
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
check('TV launch key requires release or deliberate navigation', tvJs.includes("document.addEventListener('keyup'") && moviezone.includes('tvActivationArmed') && tvJs.includes('D-pad movement proves'));
check('TV activation never auto-arms from elapsed startup time',
  !tvJs.includes('tvAutoArmAt') &&
  !tvJs.includes('setTimeout(() => { tvPageReady = true; }'));
check('TV activation requires trusted non-repeat input and post-keyup debounce',
  moviezone.includes('TV_POST_KEYUP_DEBOUNCE_MS = 400') &&
  moviezone.includes('if (!event.isTrusted) return;') &&
  moviezone.includes('if (event.repeat) return;') &&
  tvJs.includes('tvActivationAllowedAt'));
check('startup and pageshow sanitize restored detail/player state',
  moviezone.includes('function resetRestoredWatchSurface()') &&
  moviezone.includes("document.addEventListener('DOMContentLoaded', resetRestoredWatchSurface") &&
  /window\.addEventListener\('pageshow',[\s\S]*?resetRestoredWatchSurface\(\)/.test(moviezone) &&
  moviezone.includes("for (const id of ['modal-overlay', 'upcoming-detail-overlay'])") &&
  moviezone.includes("for (const id of ['videoEmbed', 'udTrailerEmbed'])"));
check('pageshow resets TV launch readiness epoch',
  moviezone.includes('resetTVLaunchActivation();') &&
  moviezone.includes('detailActivationGuard.tvInteractionEpoch += 1') &&
  tvJs.includes('syncTVPageReadiness'));
check('stale watch hash is cleaned without auto-open', moviezone.includes("if (window.location.hash.startsWith('#watch-'))") && moviezone.includes('Direct #watch URLs are never auto-opened'));
check('all detail callsites propagate activation evidence', !moviezone.includes('openModal(m.id, type);') && !moviezone.includes('openModal(item.id, type);') && !moviezone.includes('openUpcomingDetail(m.id);'));

// Low frame rate may reduce effects, but must never change device identity/navigation mode.
check('low FPS uses low-end mode without false TV activation',
  moviezone.includes("lowFPSCount > 3 && !document.documentElement.classList.contains('low-end-mode')") &&
  !moviezone.includes('Auto-enabled tv-mode due to low FPS'));
check('real and explicitly forced TV modes remain available',
  tvJs.includes("setAttribute('data-mz-tv', 'true')") &&
  tvJs.includes("tvParam === '1'"));


// TV detection logic is now in tv-mode.js. Extract regex for testing.
function detectTV(userAgent, userAgentData) {
  const ua = userAgent;
  // Main UA regex from tv-mode.js
  const tvUA = /SmartTV|Web0S|WebOS|Tizen|VIDAA|Roku|RokuOS|AppleTV|Apple TV|Android TV|AndroidTV|BRAVIA|AFT[A-Z0-9]+|Fire TV|FireTV|CrKey|Chromecast|GoogleTV|Google TV|PlayStation|PS[45]|Xbox One|XBOX|SmartCast|PHILIPSTV|HbbTV|Opera TV|NETTV|Panasonic.*Viera|Vestel|DuneHD|Eltex|NetCast|MITV|MiTV/i.test(ua);
  if (tvUA) return true;
  if (userAgentData) {
    const platform = (userAgentData.platform || '').toLowerCase();
    if (/smarttv|tizen|webos|android tv|googletv|chromecast|firetv/.test(platform)) return true;
    const brands = userAgentData.brands || [];
    const brandStr = brands.map(function(b) { return b.brand; }).join(' ').toLowerCase();
    if (/tizen|webos|smarttv|googletv|firetv/.test(brandStr)) return true;
  }
  const isDesktopOS = /Windows NT|Macintosh|Mac OS X|CrOS|Ubuntu|Fedora|Linux x86_64|Linux i686/i.test(ua);
  const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  if (isDesktopOS || isMobileDevice) return false;
  return false;
}
const realTvUAs = [
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 SamsungBrowser/5.0 TV Safari/537.36',
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/538.2 LG Browser/8.0',
  'Mozilla/5.0 (Linux; Android 7.1.2; AFTMM Build/NS6265) AppleWebKit/537.36 Silk/112 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 9; BRAVIA 4K GB ATV3 Build/PTT1) AppleWebKit/537.36 Chrome/87 Safari/537.36',
  'Roku/DVP-12.5 (12.5.0.4178-46)',
  'Mozilla/5.0 (Linux; U; VIDAA U6; en-us) AppleWebKit/537.36 SmartTV/10.0',
  'Mozilla/5.0 (Linux; Android 12; SHIELD Android TV) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Xbox; Xbox One) AppleWebKit/537.36 Edge/44'
];
const nonTvUAs = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Chrome/138 Mobile Safari/537.36'
];
check('confirmed Samsung/LG/Fire/BRAVIA/Roku/VIDAA/Android/Xbox TV UAs detected', realTvUAs.every(ua => detectTV(ua)));
check('desktop, DevTools iPhone, and Android phone UAs remain non-TV', nonTvUAs.every(ua => !detectTV(ua)));
check('Chromium reduced-UA TV platform hint remains detected', detectTV(nonTvUAs[0], { platform: 'Android TV', brands: [] }));
check('screen/pointer heuristics never assign TV identity', !moviezone.includes('TV mode activated via screen heuristic') && !moviezone.includes('TV mode activated via Android large-screen heuristic'));
check('forced-TV gets dynamic focus, memory, and image safeguards',
  moviezone.includes('if (isMzTVMode()) return MAX_CARDS_TV;') &&
  moviezone.includes("isMzTV() || isMobile"));
check('TV focus covers custom tabindex controls and buttons', tvJs.includes('button:not([disabled])') && tvJs.includes('[tabindex]:not([tabindex="-1"])'));
check('Android/Fire, Tizen and WebOS Back keys supported', tvJs.includes("key === 'BrowserBack'") && tvJs.includes('keyCode === 4') && tvJs.includes('keyCode === 10009') && tvJs.includes('keyCode === 461'));
check('TV scrolling instant while non-TV remains smooth', moviezone.includes("behavior: isMzTVMode() ? 'auto' : 'smooth'") && !moviezone.includes("behavior: 'smooth'"));
check('FPS monitor bounded and skips optimized modes', moviezone.includes('MAX_PERFORMANCE_SAMPLES = 300') && moviezone.includes("if (!isMzTVMode() && !document.documentElement.classList.contains('low-end-mode'))"));
check('TV CSS bypasses content skipping while preserving containment and root instant scrolling',
  !tvCss.includes('contain: none !important') &&
  tvCss.includes('content-visibility: visible !important') &&
  tvCss.includes('contain-intrinsic-size: none !important') &&
  /html\[data-mz-tv="true"\]\s*\{\s*scroll-behavior:\s*auto\s*!important;/.test(tvCss));


const tvHiddenNavItems = html.match(/<li data-tv-hide><a[^>]+filterCat\('(hollywood|south)'/g) || [];
check('exactly Hollywood and South navbar links are marked TV-only hidden',
  tvHiddenNavItems.length === 2 && html.includes("filterCat('hollywood'") && html.includes("filterCat('south'"));
check('TV-only nav CSS hides marked links without changing desktop markup',
  /html\[data-mz-tv="true"\]\s+\[data-tv-hide\]\s*\{[^}]*display:\s*none\s*!important;/.test(tvCss));
check('compact/mobile nav clone preserves TV-hide markers',
  moviezone.includes("a.closest('[data-tv-hide]') ? ' data-tv-hide' : ''"));
check('TV D-pad has vertical page-scroll fallback at focus boundary',
  tvJs.includes("direction === 'up' || direction === 'down'") &&
  tvJs.includes("scrollTVPage(direction === 'down' ? 1 : -1)"));
check('TV Page and Channel remote keys scroll both directions',
  tvJs.includes("key === 'PageDown'") && tvJs.includes("key === 'PageUp'") &&
  tvJs.includes("key === 'ChannelDown'") && tvJs.includes("key === 'ChannelUp'") &&
  tvJs.includes('keyCode === 428') && tvJs.includes('keyCode === 427'));
check('TV scrolling is cancellable and supports overlay-owned scroll surfaces',
  tvJs.includes('function getTVScrollContainer') &&
  tvJs.includes("getElementById('chScroll')") &&
  tvJs.includes('function applyScroll') &&
  tvJs.includes('window.scrollTo(0, position)') &&
  tvJs.includes('scroller.scrollTop = position') &&
  tvJs.includes('activeScrollAnimation = requestAnimationFrame(animateFrame)') &&
  tvJs.includes('cancelAnimationFrame(activeScrollAnimation)'));
check('TV focus reveal supports legacy scrollIntoView signature',
  tvJs.includes('function focusAndRevealTVTarget') &&
  tvJs.includes("target.scrollIntoView(direction !== 'up')"));
check('infinite-scroll sentinels remain scroll-driven with preload margin',
  moviezone.includes("document.getElementById('infiniteScrollTrigger')") &&
  moviezone.includes("document.getElementById('infiniteScrollTriggerUpcoming')") &&
  moviezone.includes("rootMargin: '400px'"));

const playerSandbox = moviezone.match(/iframe\.setAttribute\('sandbox', '([^']+)'\)/);
check('player iframe sandbox blocks top navigation and popups',
  playerSandbox && playerSandbox[1].includes('allow-scripts') &&
  playerSandbox[1].includes('allow-presentation') &&
  !playerSandbox[1].includes('allow-top-navigation') &&
  !playerSandbox[1].includes('allow-popups'));
check('legacy beforeunload redirect trap is removed',
  !moviezone.includes("window.addEventListener('beforeunload'"));

check('SW cache is v40', sw.includes("CACHE_NAME = 'moviezone-v40'"));
check('SW precaches replacement branding v2',
  sw.includes("'/moviezone-logo.png?v=2'") &&
  sw.includes("'/icon-192.png?v=2'") &&
  sw.includes("'/icon-512.png?v=2'") &&
  sw.includes("'/favicon-32.png?v=2'") &&
  sw.includes("'/apple-touch-icon.png?v=2'"));
check('SW caches moviezone styles v4.4', sw.includes("'/moviezone.css?v=4.4'"));
check('SW caches moviezone v5.1', sw.includes("'/moviezone.js?v=5.1'"));
check('SW caches pwa-install v1.6', sw.includes("'/pwa-install.js?v=1.6'"));
check('SW treats collections catalog as optional', sw.includes('const OPTIONAL_ASSETS') && sw.includes("'/collections-catalog.json?v=2'") && sw.includes('Promise.allSettled'));
check('SW uses skipWaiting and clients.claim', sw.includes('self.skipWaiting()') && sw.includes('self.clients.claim()'));
check('server manifest MIME configured', server.includes('application/manifest+json'));
check('server SW MIME configured', server.includes("res.type('application/javascript')"));
const swHeaders = vercel.headers.find(h => h.source === '/sw.js');
check('Vercel SW has JavaScript MIME', swHeaders && swHeaders.headers.some(h => h.key === 'Content-Type' && h.value.includes('application/javascript')));
check('Vercel deploys collections catalog as a static asset', vercel.builds.some(b => b.src === 'collections-catalog.json' && b.use === '@vercel/static'));
const catalogHeaders = vercel.headers.find(h => h.source === '/collections-catalog.json');
check('Vercel serves catalog with JSON MIME', catalogHeaders && catalogHeaders.headers.some(h => h.key === 'Content-Type' && h.value.includes('application/json')));
check('Vercel static JS glob excludes server.js', vercel.builds.some(b => b.use === '@vercel/static' && b.src.includes('search-engine')) && !vercel.builds.some(b => b.use === '@vercel/static' && b.src.includes('**/*') && b.src.includes('js')));

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
