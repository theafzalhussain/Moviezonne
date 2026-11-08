/* mz-pwa.js — extracted from moviezone.js. Load after moviezone.min.js. */


// === PWA INSTALL & NOTIFY ME SYSTEM ===
(function initPWA() {
  const isMzTV = (window.__mzBridge && window.__mzBridge.isMzTV) || window.isMzTV || (() => false);
  // 1. Service Worker is registered by the inline <head> PWA bootstrap.
  // Consume its shared readiness promise here; do not create duplicate registrations.
  if ('serviceWorker' in navigator) {
    const swReady = window.__mzServiceWorkerReady || navigator.serviceWorker.ready;
    Promise.resolve(swReady).then(reg => {
      if (reg) console.log('[MovieZone] Service Worker ready:', reg.scope);
    }).catch(err => console.warn('[MovieZone] SW readiness failed:', err));
  }

  // 2. PWA Install UI - driven by pwa-install.js shared live monitor.
  const navInstallBtn = document.getElementById('navInstallBtn');

  function applyPwaInstallState(installed) {
    if (!navInstallBtn) return;
    navInstallBtn.style.display = installed ? 'none' : 'flex';
    navInstallBtn.classList.toggle('mz-install-native-ready', !installed && !!window.deferredPrompt);
  }

  window.addEventListener('mz:pwa-statechange', function(event) {
    applyPwaInstallState(!!(event.detail && event.detail.installed));
  });

  /*  pwa-install.min.js is now loaded lazily (see the loader in index.html), so
   *  its monitor may not exist yet. This resolves the state from what is
   *  available now, and re-resolves it authoritatively when the controller
   *  arrives — the mz:pwainstallready event the loader fires on script load.
   */
  function syncPwaInstallState() {
    const monitor = window.__mzPwaInstallMonitor;
    if (monitor && typeof monitor.check === 'function') {
      monitor.check().then(applyPwaInstallState).catch(function() { applyPwaInstallState(false); });
      return;
    }
    // Cheap local signals, good enough to decide whether to show the button
    // before the controller lands.
    const installedFallback = window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true ||
      localStorage.getItem('mz_app_installed') === '1';
    applyPwaInstallState(installedFallback);
  }
  setTimeout(syncPwaInstallState, 0);
  window.addEventListener('mz:pwainstallready', syncPwaInstallState);

  // Global install function - called from navbar button and banner.
  window.installPWA = function() {
    const monitor = window.__mzPwaInstallMonitor;
    if (monitor && monitor.isInstalled()) {
      applyPwaInstallState(true);
      if (typeof showToast === 'function') showToast('MovieZone is already installed on this device.');
      return;
    }

    if (typeof window.__mzTriggerInstall === 'function') {
      if (!window.deferredPrompt && window.__mzOpenInstallPopup) window.__mzOpenInstallPopup();
      return window.__mzTriggerInstall();
    }

    /*  The user got here before the lazy controller did — the common case being
     *  a click within the first second or two. Pull it in and re-enter once, so
     *  the click is honoured instead of being dropped on a "still loading" toast.
     */
    if (typeof window.__mzLoadPwaInstall === 'function' && !window.__mzInstallRetried) {
      window.__mzInstallRetried = true;
      if (typeof showToast === 'function') showToast('Preparing install…');
      window.__mzLoadPwaInstall().then(function () {
        window.__mzInstallRetried = false;
        window.installPWA();
      });
      return;
    }

    if (window.__mzOpenInstallPopup) {
      window.__mzOpenInstallPopup();
      return;
    }
    const overlay = document.getElementById('pwa-install-overlay');
    if (overlay) {
      overlay.classList.add('open');
      if (!isMzTV()) {
        document.body.style.overflow = 'hidden';
      }
    } else if (typeof showToast === 'function') {
      showToast('Install controls are still loading. Please try again.');
    }
  };

  window.closePWABanner = function() {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.remove();
    sessionStorage.setItem('mz_banner_closed', '1');
  };

  // 3. NOTIFY ME System
  const NOTIFY_KEY = 'mz_notify_movies';

  // ── WEB PUSH SUBSCRIPTION ──

  /*  True when a response is the SPA shell rather than the API answering.
   *
   *  wrangler.jsonc sets not_found_handling to "single-page-application", so an
   *  /api/* route the Worker does not implement answers 200 with index.html
   *  instead of 404. response.ok was therefore true and response.json() threw
   *      Unexpected token '<', "<!DOCTYPE "... is not valid JSON
   *  which reads like a corrupt payload when the real fact is simply that the
   *  endpoint is not deployed on this host. Checking the content type is what
   *  separates those two cases. */
  const servedSpaShell = (response) =>
    !(response.headers.get('content-type') || '').toLowerCase().includes('application/json');

  async function subscribeToPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Push notifications are not supported in this browser');
      }

      const reg = await navigator.serviceWorker.ready;
      let subscription = await reg.pushManager.getSubscription();

      if (!subscription) {
        const response = await fetch('/api/push/vapid-key', { cache: 'no-store' });
        if (!response.ok || servedSpaShell(response)) {
          /*  Push is not wired up on this deployment. That is a deployment
           *  state rather than a fault, so it is said once, plainly — a warning
           *  carrying a SyntaxError stack taught us to scroll past the console
           *  instead of reading it. */
          if (!subscribeToPush.reportedMissing) {
            subscribeToPush.reportedMissing = true;
            console.info('[MovieZone] Push notifications are not configured here: '
              + '/api/push/vapid-key returned ' + response.status + ' '
              + (response.headers.get('content-type') || 'no content type')
              + '. Skipping subscription.');
          }
          return null;
        }
        const { publicKey } = await response.json();
        if (!publicKey) throw new Error('The push configuration has no public key');
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      /*  The server sync is intentionally gone.
       *
       *  /api/push/subscribe answers 503 because the PUSH_SUBS KV namespace is out
       *  of its daily write quota, so this POST could never succeed — it only cost
       *  a failed request and a console error on every page load. The browser-level
       *  subscription above is still created and returned, so nothing else changes;
       *  we simply stop telling a store that cannot accept the write.
       *
       *  To turn server-side push back on: restore the POST to /api/push/subscribe
       *  here once the KV namespace has write headroom (or move the store off KV). */
      return subscription;
    } catch (err) {
      console.warn('[MovieZone] Push subscription failed:', err);
      return null;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function saveNotifyMovie(subscription, movie, confirm) {
    const response = await fetch('/api/notify-movies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        movieId: movie.id,
        title: movie.title,
        releaseDate: movie.releaseDate,
        url: '/#upcoming',
        confirm
      })
    });
    const result = servedSpaShell(response)
      ? {}
      : await response.json().catch(() => ({}));
    if (!response.ok || servedSpaShell(response)) {
      /*  Without the content-type check a missing endpoint answers 200 with
       *  index.html and this reads as a successful save, so the movie would be
       *  reported as scheduled when nothing was stored. */
      throw new Error(result.error
        || ('Could not save movie notification (' + response.status + ')'));
    }
    return result;
  }

  async function syncLocalNotifyMovies(subscription) {
    const movies = getNotifyList().filter(movie => movie.releaseDate);
    await Promise.allSettled(movies.map(movie => saveNotifyMovie(subscription, movie, false)));
    try { localStorage.setItem('mz_notify_migrated_v1', '1'); } catch (e) { /* retried next visit */ }
  }

  async function loadServerNotifyMovies(subscription) {
    const response = await fetch('/api/notify-movies/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
    /*  A 200 carrying index.html would make response.json() throw here, and this
     *  runs from a bare setTimeout — an unhandled rejection that silently stops
     *  the rest of the sync. Treated as "nothing to load" instead. */
    if (!response.ok || servedSpaShell(response)) return false;
    const { movies = [] } = await response.json().catch(() => ({ movies: [] }));
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(movies.map(movie => ({
      id: movie.movieId,
      title: movie.title,
      releaseDate: movie.releaseDate,
      addedAt: movie.createdAt ? new Date(movie.createdAt).getTime() : Date.now()
    }))));
    return true;
  }

  /*  How often this browser re-reads its reminder list from the server.
   *
   *  It used to be EVERY page view of every visitor who had granted notification
   *  permission: one Worker invocation, one KV list() and one KV read per saved
   *  movie, just to rewrite a list this same browser already holds - it is the
   *  browser that adds and removes entries. On the free plan KV list() is capped
   *  at 1,000 operations a day, account-wide. Twice a day is plenty to pick up a
   *  reminder the server delivered (and deleted) in between. */
  const NOTIFY_SYNC_KEY = 'mz_notify_synced_at';
  const NOTIFY_SYNC_EVERY_MS = 12 * 60 * 60 * 1000;

  // Keep both the device subscription and movie choices synchronized.
  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    setTimeout(async () => {
      const subscription = await subscribeToPush();
      if (!subscription) return;
      if (!localStorage.getItem('mz_notify_migrated_v1')) {
        await syncLocalNotifyMovies(subscription);
      }
      let lastSync = 0;
      try { lastSync = Number(localStorage.getItem(NOTIFY_SYNC_KEY) || 0); } catch (e) { lastSync = 0; }
      if (Date.now() - lastSync < NOTIFY_SYNC_EVERY_MS) return;
      if (await loadServerNotifyMovies(subscription)) {
        try { localStorage.setItem(NOTIFY_SYNC_KEY, String(Date.now())); } catch (e) {}
      }
    }, 1500);
  }

  window.getNotifyList = function() {
    try { return JSON.parse(localStorage.getItem(NOTIFY_KEY)) || []; }
    catch { return []; }
  };

  window.toggleNotifyMe = async function(movieId, movieTitle, releaseDate) {
    const list = getNotifyList();
    const idx = list.findIndex(movie => movie.id === movieId);

    try {
      if (idx > -1) {
        const reg = await navigator.serviceWorker.ready;
        const subscription = await reg.pushManager.getSubscription();
        if (subscription) {
          const response = await fetch('/api/notify-movies/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: subscription.endpoint, movieId })
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Could not remove notification');
          }
        }

        list.splice(idx, 1);
        localStorage.setItem(NOTIFY_KEY, JSON.stringify(list));
        if (typeof showToast === 'function') showToast('Notification removed for ' + movieTitle);
        return false;
      }

      if (!releaseDate) throw new Error('Release date is unavailable for this movie');
      const subscription = await requestNotificationPermission();
      if (!subscription) throw new Error('Notification permission or push subscription is unavailable');

      const movie = { id: movieId, title: movieTitle, releaseDate, addedAt: Date.now() };
      
      // TV local-only mode: save locally without server push
      if (subscription === 'local-only') {
        list.push(movie);
        localStorage.setItem(NOTIFY_KEY, JSON.stringify(list));
        if (typeof showToast === 'function') showToast('🔔 Reminder saved for ' + movieTitle + '! You\'ll see it on your next visit.');
        return true;
      }

      const result = await saveNotifyMovie(subscription, movie, true);
      list.push(movie);
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(list));

      if (typeof showToast === 'function') {
        showToast(result.confirmationSent
          ? 'Notification saved and confirmation sent for ' + movieTitle
          : 'Notification saved for ' + movieTitle);
      }
      return true;
    } catch (err) {
      // Already shown to the user as a toast; permission denied / push not
      // configured are expected outcomes, not app errors for the RUM feed.
      console.warn('[MovieZone] Notify Me failed:', err && err.message);
      if (typeof showToast === 'function') showToast(err.message || 'Could not save notification');
      return idx > -1;
    }
  };

  window.isNotifySet = function(movieId) {
    return getNotifyList().some(movie => movie.id === movieId);
  };

  async function requestNotificationPermission() {
    if (!('Notification' in window) || !('PushManager' in window)) {
      // TV fallback: Push not supported, use local-only notify (reminder on next visit)
      if (isMzTV()) {
        console.log('[MovieZone] TV mode: using local-only notifications');
        return 'local-only';
      }
      if (typeof showToast === 'function') showToast('Notifications are not supported in this browser');
      return null;
    }
    if (Notification.permission === 'denied') {
      if (typeof showToast === 'function') showToast('Please enable notifications in browser settings');
      return null;
    }
    if (Notification.permission !== 'granted') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') return null;
    }
    return subscribeToPush();
  }

  // Release notifications are sent by the server, so they work while the website is closed.
})();

// Notify Me button click handler for upcoming cards
window.handleNotifyMe = async function(btn) {
  const movieId = parseInt(btn.dataset.movieId, 10);
  const title = btn.dataset.title;
  const releaseDate = btn.dataset.release;
  const label = btn.querySelector('span');

  if (typeof toggleNotifyMe !== 'function' || btn.disabled) return;
  btn.disabled = true;
  if (label) label.textContent = 'Saving...';

  try {
    const isNowSet = await toggleNotifyMe(movieId, title, releaseDate);
    btn.classList.toggle('notified', isNowSet);
    if (label) label.textContent = isNowSet ? 'Notified ✓' : 'Notify Me';
  } finally {
    btn.disabled = false;
  }
};




// === CINEMATIC UNIVERSES (per-franchise pages, opened from the homepage rail) ===
