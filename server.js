// IMPORTANT: Make sure to import `instrument.js` at the top of your file.
// If you're using ECMAScript Modules (ESM) syntax, use `import "./instrument.js";`
require('./instrument.js');

// All other imports below
const Sentry = require("@sentry/node");
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // 1. Security
const compression = require('compression'); // 2. Gzip Compression
const NodeCache = require('node-cache'); // 3. Advanced Caching
const rateLimit = require('express-rate-limit'); // 4. Traffic Control
const webPush = require('web-push'); // 5. Push Notifications
const { MongoClient } = require('mongodb'); // 6. Database
const https = require('https');
const path = require('path'); // 9. Filesystem paths (PWA manifest / service worker)
const fs = require('fs');     // 10. Startup sanity checks
const axios = require('axios'); // 7. Robust HTTP Client
const axiosRetry = require('axios-retry').default; // 8. Automatic Retry with Backoff

// ══════════════════════════════════════════════════════════════
//  TMDB API CLIENT — Keep-Alive + Host Failover + Retry/Backoff
// ══════════════════════════════════════════════════════════════
//
//  WHY THE HOST FAILOVER EXISTS (the ECONNRESET storm):
//  Many ISPs (very common on Indian broadband/mobile) run SNI-based deep packet
//  inspection that fires a TCP RST while the TLS ClientHello for the hostname
//  "api.themoviedb.org" is still in flight. Measured behaviour from this network:
//    • ~60-75% of BRAND-NEW connections die with ECONNRESET after ~240ms
//    • the RST arrives before TLS completes, so it is not TMDB rate limiting
//    • an already-established keep-alive socket is never touched (~130ms replies)
//  "api.tmdb.org" is TMDB's own alias for the same /3 API (valid certificate,
//  identical JSON) but it carries a different SNI, so the filter ignores it.
//  Strategy: keep sockets alive aggressively, probe both hosts at boot, pin the
//  healthy one, flip hosts mid-retry on connection errors, and re-probe so we
//  return to the primary once the network behaves again.

const TMDB_HOSTS = ['api.themoviedb.org', 'api.tmdb.org'];
const HOST_PENALTY_MS = 5 * 60 * 1000;   // sideline a resetting host for 5 minutes
const HOST_REPROBE_MS = 10 * 60 * 1000;  // re-measure both hosts every 10 minutes
const HOST_FAIL_THRESHOLD = 2;           // connection errors before switching away

const buildBaseUrl = (host) => `https://${host}/3`;
const hostHealth = new Map(TMDB_HOSTS.map(h => [h, { fails: 0, penaltyUntil: 0 }]));
let activeHost = TMDB_HOSTS[0];

// Persistent HTTPS Agent — a live socket never gets reset, so hold on to them.
// 'lifo' reuses the hottest socket, which means far fewer new TLS handshakes
// (each handshake is another chance for the ISP filter to kill us).
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 12,
  maxFreeSockets: 12,
  timeout: 20000,
  scheduling: 'lifo'
});

// Create dedicated axios instance for TMDB
const tmdbClient = axios.create({
  baseURL: buildBaseUrl(activeHost),
  timeout: 15000,
  httpsAgent: keepAliveAgent,
  headers: {
    'User-Agent': 'MovieZone/1.0 (Premium Cinema App)',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive'
  }
});

function hostOfConfig(config) {
  try { return new URL(config?.baseURL || buildBaseUrl(activeHost)).hostname; }
  catch { return activeHost; }
}

const isHostUsable = (host) => (hostHealth.get(host)?.penaltyUntil ?? 0) <= Date.now();

// Pick the best alternative to `exclude`; falls back to any host rather than none.
function pickAlternateHost(exclude) {
  return TMDB_HOSTS.find(h => h !== exclude && isHostUsable(h))
      || TMDB_HOSTS.find(h => h !== exclude)
      || exclude;
}

function setActiveHost(host, reason) {
  if (activeHost === host) return;
  const from = activeHost;
  activeHost = host;
  tmdbClient.defaults.baseURL = buildBaseUrl(host);
  console.warn(`🔀 TMDB host switched: ${from} → ${host} (${reason})`);
}

function recordHostFailure(host) {
  const state = hostHealth.get(host);
  if (!state) return;
  state.fails += 1;
  if (state.fails < HOST_FAIL_THRESHOLD) return;
  state.fails = 0;
  state.penaltyUntil = Date.now() + HOST_PENALTY_MS;
  const alternate = pickAlternateHost(host);
  if (alternate !== host && activeHost === host) {
    setActiveHost(alternate, 'repeated connection resets');
  }
}

// Success only clears the error streak. Un-sidelining a host is the probe's job,
// otherwise one lucky retry drags us straight back onto a filtered hostname.
function recordHostSuccess(host) {
  const state = hostHealth.get(host);
  if (state) state.fails = 0;
}

tmdbClient.interceptors.response.use(
  (response) => { recordHostSuccess(hostOfConfig(response.config)); return response; },
  (error) => Promise.reject(error)
);

// Axios Retry Interceptor — fast first retries, host flip on connection errors
axiosRetry(tmdbClient, {
  retries: 6,
  shouldResetTimeout: true, // every attempt gets a full 15s, not a shared budget
  retryDelay: (retryCount, error) => {
    const retryAfter = Number(error?.response?.headers?.['retry-after']);
    if (error?.response?.status === 429 && Number.isFinite(retryAfter)) {
      return Math.min(retryAfter * 1000, 10000);
    }
    // Filtered connections die in ~240ms and the very next attempt usually
    // succeeds, so stay snappy early: 150ms, 300ms, 600ms, 1.2s, 2.4s, 4s.
    return Math.min(150 * Math.pow(2, retryCount - 1), 4000) + Math.random() * 150;
  },
  retryCondition: (error) => {
    if (!error.response) return true; // ECONNRESET / ETIMEDOUT / EPIPE / DNS
    return [408, 429, 500, 502, 503, 504].includes(error.response.status);
  },
  onRetry: (retryCount, error, requestConfig) => {
    const usedHost = hostOfConfig(requestConfig);
    if (!error.response) {
      recordHostFailure(usedHost);
      // Retry over the other hostname — a different SNI usually walks straight through.
      const alternate = pickAlternateHost(usedHost);
      if (alternate !== usedHost) requestConfig.baseURL = buildBaseUrl(alternate);
    }
    if (retryCount >= 4) {
      console.warn(`⚠️ TMDB retry ${retryCount}/6 via ${hostOfConfig(requestConfig)} (${error.code || error.message})`);
    }
  }
});

// Measures both hostnames with a few raw (un-retried) probes and pins the winner.
async function probeTmdbHosts({ samples = 3, quiet = false } = {}) {
  const token = process.env.TMDB_TOKEN;
  if (!token) return null;

  const scores = await Promise.all(TMDB_HOSTS.map(async (host) => {
    let ok = 0;
    let lastCode = null;
    for (let i = 0; i < samples; i++) {
      try {
        await axios.get(`${buildBaseUrl(host)}/configuration`, {
          timeout: 8000,
          httpsAgent: keepAliveAgent,
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'MovieZone/1.0 (health probe)' }
        });
        ok++;
      } catch (err) {
        lastCode = err.code || err.response?.status || err.message;
      }
    }
    return { host, ratio: ok / samples, lastCode };
  }));

  const best = scores.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const primary = scores[0];

  // Only leave the primary when it is clearly unhealthy and something better exists.
  const primaryState = hostHealth.get(primary.host);
  const bestState = hostHealth.get(best.host);
  if (primary.ratio >= 0.67) {
    if (primaryState) primaryState.penaltyUntil = 0;
    recordHostSuccess(primary.host);
    setActiveHost(primary.host, 'primary healthy again');
  } else if (best.ratio > primary.ratio) {
    if (primaryState) primaryState.penaltyUntil = Date.now() + HOST_PENALTY_MS;
    if (bestState) bestState.penaltyUntil = 0;
    recordHostSuccess(best.host);
    setActiveHost(best.host, `primary resets ${Math.round((1 - primary.ratio) * 100)}% of new connections`);
  }

  if (!quiet) {
    const summary = scores.map(s => `${s.host} ${Math.round(s.ratio * 100)}%${s.lastCode ? ` (${s.lastCode})` : ''}`).join(' | ');
    console.log(`🩺 TMDB reachability: ${summary} → using ${activeHost}`);
  }
  return { scores, activeHost };
}

// Simple wrapper to match previous fetchWithRetry interface
async function fetchWithRetry(url, options = {}) {
  const parsed = new URL(url);
  // Strip the /3 prefix — the axios baseURL already carries it (host-agnostic).
  let path = parsed.pathname + parsed.search;
  if (path.startsWith('/3/')) path = path.slice(2); // /3/trending -> /trending

  const response = await tmdbClient.get(path, {
    headers: options.headers || {}
  });
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.statusText,
    text: () => Promise.resolve(typeof response.data === 'string' ? response.data : JSON.stringify(response.data)),
    json: () => Promise.resolve(response.data)
  };
}

const app = express();
const PORT = process.env.PORT || 3001;

// Security Middleware: Secures Express apps by setting various HTTP headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled to allow images from TMDB and external video iframes
  crossOriginEmbedderPolicy: false
}));

// Compression Middleware: Compresses all responses (Gzip) for faster load times and less bandwidth usage
app.use(compression());

// Frontend se aane wali requests allow karne ke liye CORS (Render par ye explicitly CORS error fix karega)
app.use(cors({
  origin: '*', // Live me aap '*' ki jagah apna frontend URL (jaise 'https://yoursite.netlify.app') daal sakte hain
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── PWA asset resolution ───────────────────────────────────────────────────
// Files currently live in the project root, but resolve through a candidate list so
// moving them into public/ or dist/ later needs no code change.
const ASSET_DIRS = [__dirname, path.join(__dirname, 'public'), path.join(__dirname, 'dist')];

function resolveAsset(fileName) {
  for (const dir of ASSET_DIRS) {
    const root = path.resolve(dir);
    const candidate = path.resolve(root, fileName);
    // Never step outside the asset directory, whatever the caller passed in.
    if (candidate !== root && !candidate.startsWith(root + path.sep)) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Manifest/HTML asset references are URLs, not filenames — they routinely carry a
// cache-busting query ("/icon-192.png?v=2") or percent-encoding. Strip the URL parts
// before touching the filesystem, otherwise the file is reported missing when it exists.
// Returns null for anything not checkable on local disk (remote URLs, data:, traversal).
function assetPathFromUrl(src) {
  if (typeof src !== 'string' || !src.trim()) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src) || /^data:/i.test(src)) return null;

  let relative;
  try {
    // Dummy base makes relative and root-relative refs parse identically;
    // .pathname discards ?query and #hash for us.
    relative = decodeURIComponent(new URL(src, 'http://asset.local/').pathname);
  } catch {
    return null;
  }

  relative = relative.replace(/^\/+/, '');
  const segments = relative.split('/').filter(Boolean);
  if (!segments.length || segments.includes('..')) return null;
  return path.join(...segments);
}

// Last-resort manifest: served inline if manifest.json is missing, unreadable, or
// invalid, so Chrome never reports "No manifest detected" because of a bad file.
const FALLBACK_MANIFEST = {
  name: 'MovieZone - Premium Cinema',
  short_name: 'MovieZone',
  description: 'Your ultimate premium destination for movies and shows in HD, 4K quality',
  start_url: '/',
  scope: '/',
  id: '/',
  launch_handler: { client_mode: 'navigate-existing' },
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  background_color: '#03030a',
  theme_color: '#f5c518',
  orientation: 'any',
  lang: 'en',
  dir: 'ltr',
  icons: [
    { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ],
  categories: ['entertainment'],
  related_applications: [
    { platform: 'webapp', url: '/manifest.json', id: '/' }
  ],
  prefer_related_applications: false
};

const MANIFEST_REQUIRED = ['name', 'short_name', 'start_url', 'display', 'icons'];

// Reads + validates manifest.json, falling back to the inline copy on any problem.
async function loadManifest() {
  const file = resolveAsset('manifest.json');
  if (!file) {
    console.warn('⚠️  manifest.json not found in', ASSET_DIRS.join(' | '), '— serving inline fallback');
    return { manifest: FALLBACK_MANIFEST, source: 'inline-fallback' };
  }
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const missing = MANIFEST_REQUIRED.filter(k => !parsed[k]);
    if (missing.length) throw new Error('missing required field(s): ' + missing.join(', '));
    if (!Array.isArray(parsed.icons) || parsed.icons.length === 0) throw new Error('icons[] is empty');
    return { manifest: parsed, source: file };
  } catch (err) {
    console.warn(`⚠️  manifest.json unusable (${err.message}) — serving inline fallback`);
    return { manifest: FALLBACK_MANIFEST, source: 'inline-fallback' };
  }
}

// ── PWA: manifest + service worker MUST be served fresh, with exact MIME types ──
// These are declared BEFORE express.static so the static middleware's long
// `immutable` cache never applies to them (a cached/404'd manifest is what makes
// Chrome DevTools report "No manifest detected").
app.get(['/manifest.json', '/manifest.webmanifest'], async (req, res) => {
  const { manifest, source } = await loadManifest();
  res.set({
    'Content-Type': 'application/manifest+json; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'X-Manifest-Source': source === 'inline-fallback' ? 'inline-fallback' : 'disk'
  });
  res.status(200).send(JSON.stringify(manifest, null, 2));
});

app.get('/sw.js', (req, res) => {
  const file = resolveAsset('sw.js');
  res.type('application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!file) {
    console.error('❌ sw.js not found in', ASSET_DIRS.join(' | '));
    // A no-op worker keeps registration from throwing; PWA install still works
    // from the manifest alone once the real file is restored.
    return res.status(200).send('/* sw.js missing on server — no-op worker */\nself.addEventListener("fetch", () => {});');
  }
  res.sendFile(file, (err) => {
    if (err) {
      console.error('❌ sw.js could not be served:', err.message);
      if (!res.headersSent) res.status(500).send('// service worker unavailable');
    }
  });
});

// Frontend files (index.html, css, js) ko browser mein dikhane ke liye
app.use(express.static(__dirname, { 
  maxAge: '30d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // CSS/JS ko 5 min cache (allows SW updates)
    if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
    // PWA icons: short cache so logo updates reflect immediately
    if (/icon-\d+\.png|favicon-\d+\.png|apple-touch-icon\.png/.test(require('path').basename(filePath))) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
    // Other images ko 60 days cache
    else if (/\.(jpg|jpeg|png|gif|svg|webp|ico)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=5184000, immutable');
    }
    // HTML ko short cache (fresh content milta rahe)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
    // Manifest: correct MIME + always revalidate
    if (filePath.endsWith('manifest.json') || filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// If the frontend is ever moved into public/ or dist/, serve those roots too.
ASSET_DIRS.slice(1).forEach((dir) => {
  if (fs.existsSync(dir)) {
    console.log(`📁 Also serving static assets from ${path.basename(dir)}/`);
    app.use(express.static(dir, { maxAge: '30d', etag: true, lastModified: true }));
  }
});

// API Rate Limiter: Bura traffic aur DDOS attacks block karega (Luxury stability)
//
// Sized against what one real session actually costs. A single homepage view
// issues ~15 concurrent calls from loadMovies('all'), ~15 more from the
// background prefetch 800 ms later, plus the carousel, and an OTT platform tab
// adds another 10-20 for provider verification. So a handful of page views is
// already in the low hundreds of requests.
//
// The old 300 was therefore under one user's normal browsing, and the failure
// mode is bad: a 429 is not a slow response, it is no data at all, and users
// behind one carrier NAT (very common on Indian mobile networks) share the IP
// and would throttle each other. The proxy's own node-cache absorbs the
// upstream cost, so a higher per-IP ceiling does not translate into more TMDB
// traffic — it mostly serves cache hits.
//
// Override with API_RATE_LIMIT_MAX; the verification suites set it high because
// they legitimately make several hundred provider lookups in one run.
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX) || 1500;
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes window
  max: API_RATE_LIMIT_MAX,
  message: { error: 'Too many requests, please calm down and try again.' },
  standardHeaders: true,
});

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_TOKEN = process.env.TMDB_TOKEN;

// Set TMDB auth token on the axios client
if (TMDB_TOKEN) {
  tmdbClient.defaults.headers.common['Authorization'] = `Bearer ${TMDB_TOKEN}`;
}

// ── WEB PUSH NOTIFICATIONS SETUP ──
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@moviezone.app';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('🔔 Web Push configured successfully.');
}

// ── MONGODB CONNECTION ──
let db = null;
const MONGODB_URI = process.env.MONGODB_URI;

async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI not set. Notification persistence is unavailable.');
    return null;
  }

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('moviezone');
    await db.collection('push_subscriptions').createIndex({ endpoint: 1 }, { unique: true });
    await db.collection('notify_movies').dropIndex('userId_1_movieId_1').catch(err => {
      if (err.codeName !== 'IndexNotFound') console.warn('Old notify index cleanup failed:', err.message);
    });
    await db.collection('notify_movies').createIndex({ endpoint: 1, movieId: 1 }, { unique: true });
    await db.collection('notify_movies').createIndex({ active: 1, notifiedAt: 1, releaseDate: 1 });
    console.log('✅ MongoDB connected successfully.');
    return db;
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    return null;
  }
}

const dbReady = connectDB();

async function getDatabase() {
  if (db) return db;
  await dbReady;
  return db;
}

async function sendPushToSubscription(subscription, payload) {
  try {
    await webPush.sendNotification(subscription, JSON.stringify(payload));
    return { sent: true };
  } catch (err) {
    const expired = err.statusCode === 404 || err.statusCode === 410;
    if (expired) {
      const database = await getDatabase();
      if (database) {
        await database.collection('push_subscriptions').updateOne(
          { endpoint: subscription.endpoint },
          { $set: { active: false, expiredAt: new Date() } }
        );
      }
    }
    return { sent: false, expired, error: err.message };
  }
}

app.use(express.json({ limit: '100kb' }));

app.get('/api/push/vapid-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push notifications are not configured' });
  res.json({ publicKey: VAPID_PUBLIC });
});

// Save or refresh a browser push subscription.
app.post('/api/push/subscribe', async (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }

  try {
    const database = await getDatabase();
    if (!database) return res.status(503).json({ error: 'Database unavailable' });

    const now = new Date();
    await database.collection('push_subscriptions').updateOne(
      { endpoint: subscription.endpoint },
      {
        $set: {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime || null,
          keys: subscription.keys,
          active: true,
          updatedAt: now
        },
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );

    res.json({ success: true, endpoint: subscription.endpoint });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Could not save push subscription' });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Endpoint is required' });

  try {
    const database = await getDatabase();
    if (!database) return res.status(503).json({ error: 'Database unavailable' });
    await Promise.all([
      database.collection('push_subscriptions').updateOne(
        { endpoint },
        { $set: { active: false, updatedAt: new Date() } }
      ),
      database.collection('notify_movies').updateMany(
        { endpoint, active: true },
        { $set: { active: false, updatedAt: new Date() } }
      )
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not unsubscribe' });
  }
});

// Save a user's selected movie and send a targeted confirmation push.
app.post('/api/notify-movies', async (req, res) => {
  const { endpoint, movieId, title, releaseDate, url, confirm = true } = req.body || {};
  const numericMovieId = Number(movieId);
  if (!endpoint || !Number.isInteger(numericMovieId) || !title || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate || '')) {
    return res.status(400).json({ error: 'endpoint, movieId, title and a valid releaseDate are required' });
  }

  try {
    const database = await getDatabase();
    if (!database) return res.status(503).json({ error: 'Database unavailable' });

    const subscription = await database.collection('push_subscriptions').findOne({ endpoint, active: true });
    if (!subscription) return res.status(409).json({ error: 'Active push subscription not found' });

    const now = new Date();
    const notificationUrl = typeof url === 'string' && url.startsWith('/') ? url : '/#upcoming';
    await database.collection('notify_movies').updateOne(
      { endpoint, movieId: numericMovieId },
      {
        $set: {
          title: String(title).slice(0, 200),
          releaseDate,
          url: notificationUrl,
          active: true,
          notifiedAt: null,
          updatedAt: now
        },
        $setOnInsert: { endpoint, movieId: numericMovieId, createdAt: now }
      },
      { upsert: true }
    );

    let confirmationSent = false;
    if (confirm !== false) {
      const confirmation = await sendPushToSubscription(subscription, {
        title: 'MovieZone',
        body: `Notification set for ${String(title).slice(0, 120)} (${releaseDate}).`,
        url: notificationUrl,
        icon: '/icon-192.png?v=2',
        badge: '/icon-192.png?v=2',
        tag: `notify-confirm-${numericMovieId}`,
        type: 'notify-confirmation'
      });
      confirmationSent = confirmation.sent;
    }

    res.status(201).json({ success: true, saved: true, confirmationSent });
  } catch (err) {
    console.error('Notify movie save error:', err);
    res.status(500).json({ error: 'Could not save movie notification' });
  }
});

app.post('/api/notify-movies/remove', async (req, res) => {
  const { endpoint, movieId } = req.body || {};
  const numericMovieId = Number(movieId);
  if (!endpoint || !Number.isInteger(numericMovieId)) {
    return res.status(400).json({ error: 'endpoint and movieId are required' });
  }

  try {
    const database = await getDatabase();
    if (!database) return res.status(503).json({ error: 'Database unavailable' });
    const result = await database.collection('notify_movies').deleteOne({ endpoint, movieId: numericMovieId });
    res.json({ success: true, removed: result.deletedCount > 0 });
  } catch (err) {
    res.status(500).json({ error: 'Could not remove movie notification' });
  }
});

app.post('/api/notify-movies/list', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Endpoint is required' });

  try {
    const database = await getDatabase();
    if (!database) return res.status(503).json({ error: 'Database unavailable' });
    const movies = await database.collection('notify_movies')
      .find({ endpoint, active: true }, { projection: { _id: 0, endpoint: 0 } })
      .sort({ releaseDate: 1 })
      .toArray();
    res.json({ movies });
  } catch (err) {
    res.status(500).json({ error: 'Could not load movie notifications' });
  }
});

async function processDueNotifications() {
  const database = await getDatabase();
  if (!database) return { checked: 0, sent: 0, failed: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const dueMovies = await database.collection('notify_movies')
    .find({ active: true, notifiedAt: null, releaseDate: { $lte: today } })
    .limit(500)
    .toArray();

  let sent = 0;
  let failed = 0;
  for (const movie of dueMovies) {
    const subscription = await database.collection('push_subscriptions').findOne({ endpoint: movie.endpoint, active: true });
    if (!subscription) {
      failed++;
      continue;
    }

    const result = await sendPushToSubscription(subscription, {
      title: 'Now available on MovieZone',
      body: `${movie.title} has released. Tap to view details.`,
      url: movie.url || '/#upcoming',
      icon: '/icon-192.png?v=2',
      badge: '/icon-192.png?v=2',
      tag: `movie-release-${movie.movieId}`,
      type: 'movie-release'
    });

    if (result.sent) {
      sent++;
      await database.collection('notify_movies').updateOne(
        { _id: movie._id },
        { $set: { active: false, notifiedAt: new Date(), updatedAt: new Date() } }
      );
    } else {
      failed++;
    }
  }

  return { checked: dueMovies.length, sent, failed };
}

// Can be called by a deployment cron; the local Node server also runs it periodically.
app.get('/api/notifications/process-due', async (req, res) => {
  try {
    res.json({ success: true, ...(await processDueNotifications()) });
  } catch (err) {
    console.error('Due notification processing error:', err);
    res.status(500).json({ error: 'Could not process due notifications' });
  }
});

// Admin broadcast endpoint retained for manual announcements.
app.post('/api/push/send', async (req, res) => {
  const { title, body, url } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });

  try {
    const database = await getDatabase();
    if (!database) return res.status(503).json({ error: 'Database unavailable' });
    const subscriptions = await database.collection('push_subscriptions').find({ active: true }).toArray();
    let sent = 0;
    let failed = 0;

    for (const subscription of subscriptions) {
      const result = await sendPushToSubscription(subscription, {
        title,
        body,
        url: typeof url === 'string' && url.startsWith('/') ? url : '/',
        icon: '/icon-192.png?v=2',
        badge: '/icon-192.png?v=2',
        tag: `broadcast-${Date.now()}`
      });
      if (result.sent) sent++;
      else failed++;
    }

    res.json({ success: true, sent, failed, total: subscriptions.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});

app.get('/api/push/stats', async (req, res) => {
  try {
    const database = await getDatabase();
    if (!database) return res.status(503).json({ error: 'Database unavailable' });
    const [subscribers, movieAlerts] = await Promise.all([
      database.collection('push_subscriptions').countDocuments({ active: true }),
      database.collection('notify_movies').countDocuments({ active: true })
    ]);
    res.json({ subscribers, movieAlerts });
  } catch (err) {
    res.status(500).json({ error: 'Could not load notification stats' });
  }
});

/*  */// Backend Advanced Cache: Initialize NodeCache with a standard TTL of 2 hours (7200 seconds) for faster loads
const apiCache = new NodeCache({ stdTTL: 7200 });

// Stale-fallback cache: keeps the last known-good payload for 24h so a network
// hiccup (ISP resets, TMDB outage) degrades into slightly old data instead of a 503.
const staleCache = new NodeCache({ stdTTL: 86400 });

// In-flight request map: collapses duplicate concurrent requests for the same URL
// into a single upstream call. Fewer parallel TLS handshakes = fewer resets.
const inFlight = new Map();

function fetchTmdbOnce(url) {
  const pending = inFlight.get(url);
  if (pending) return pending;

  const task = (async () => {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`TMDB responded ${response.status}`);
      err.tmdbStatus = response.status;
      err.tmdbBody = errText;
      throw err;
    }
    return response.json();
  })().finally(() => inFlight.delete(url));

  inFlight.set(url, task);
  return task;
}

// Server-side only (never serialised to clients) — lets tests and diagnostics reach
// the cache/host state without exporting a public API surface.
app.locals.tmdbInternals = { apiCache, staleCache, inFlight, hostHealth, TMDB_HOSTS, probeTmdbHosts, setActiveHost };

// ══════════════════════════════════════════════════════════════
//  SEO: SERVER-RENDERED PAGES + DYNAMIC SITEMAPS
// ══════════════════════════════════════════════════════════════
//
//  The frontend is a hash-routed SPA, so before this the whole catalogue
//  was a single indexable URL. seo-ssr.js adds real crawlable pages
//  (/movie/550-fight-club, /movies/action, /sitemap.xml …), each with its
//  own title, description and schema.org payload.
//
//  Registered AFTER express.static on purpose: static passes through with
//  next() for paths that have no file on disk, so these routes only ever
//  see genuine misses, and a real /sitemap-static.xml file would still win.

/**
 * Cached TMDB reader for the SSR layer. Same three-tier behaviour as the
 * /api/tmdb proxy — fresh cache, coalesced upstream fetch, then the 24h
 * stale copy — because a crawler hitting a cold cache must not get a 5xx.
 */
async function tmdbForSsr(endpoint, params) {
  const query = params && Object.keys(params).length
    ? '?' + Object.entries(params)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&')
    : '';
  const url = `${TMDB_BASE_URL}${endpoint}${query}`;

  const hit = apiCache.get(url);
  if (hit) return hit;

  try {
    const data = await fetchTmdbOnce(url);
    apiCache.set(url, data);
    staleCache.set(url, data);
    return data;
  } catch (err) {
    const stale = staleCache.get(url);
    if (stale) {
      console.warn(`[seo-ssr] serving stale copy for ${endpoint} (${err.code || err.tmdbStatus || 'error'})`);
      return stale;
    }
    throw err;
  }
}

try {
  const { registerSeoRoutes } = require('./seo-ssr');
  registerSeoRoutes(app, { tmdb: tmdbForSsr, cache: apiCache });
} catch (err) {
  // A broken SEO layer must never stop the player from serving traffic.
  console.error('⚠️  SEO SSR routes could not be registered:', err.message);
}

// Health Check / Ping Endpoint: UptimeRobot ko server jagaye rakhne ke liye
app.get('/ping', (req, res) => {
  res.status(200).send('Pong! Server is awake.');
});

// TMDB connectivity diagnostics — shows which upstream host is in use and why.
app.get('/api/tmdb-health', (req, res) => {
  res.json({
    activeHost,
    hosts: TMDB_HOSTS.map(host => {
      const state = hostHealth.get(host) || { fails: 0, penaltyUntil: 0 };
      return {
        host,
        usable: state.penaltyUntil <= Date.now(),
        recentConnectionErrors: state.fails,
        sidelinedForMs: Math.max(0, state.penaltyUntil - Date.now())
      };
    }),
    cachedEntries: apiCache.keys().length,
    staleEntries: staleCache.keys().length,
    inFlight: inFlight.size
  });
});

// Serve favicon
app.get('/favicon.ico', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'favicon-32.png'));
});

// Log throttle for upstream 403s. Keyed on the endpoint family (ids collapsed) so
// /movie/550/watch/providers and /movie/680/watch/providers share one line, and
// capped so a long-running process cannot grow the map without bound.
const forbiddenLogSeen = new Map();
const FORBIDDEN_LOG_INTERVAL_MS = 60 * 1000;

function forbiddenLogKey(endpoint) {
  return String(endpoint).split('?')[0].split('/').filter(Boolean)
    .map(p => (/^\d+$/.test(p) ? ':id' : p)).slice(0, 4).join('/') || '(root)';
}

function shouldLogForbidden(endpoint) {
  const key = forbiddenLogKey(endpoint);
  const now = Date.now();
  const last = forbiddenLogSeen.get(key);
  if (last && now - last < FORBIDDEN_LOG_INTERVAL_MS) return false;
  forbiddenLogSeen.set(key, now);
  if (forbiddenLogSeen.size > 200) {
    for (const [k, t] of forbiddenLogSeen) if (now - t > FORBIDDEN_LOG_INTERVAL_MS) forbiddenLogSeen.delete(k);
  }
  return true;
}

// Proxy Endpoint: Frontend yahan request bhejega
app.use('/api/tmdb', apiLimiter, async (req, res) => {
  const safeUrl = req.url.replace(/^\/api\/tmdb/, '');
  const endpoint = safeUrl.startsWith('/') ? safeUrl : '/' + safeUrl;
  // Cache key stays on the canonical host so a host failover never splits the cache.
  const url = `${TMDB_BASE_URL}${endpoint}`;

  try {
    if (!TMDB_TOKEN) {
      console.error('CRITICAL ERROR: TMDB_TOKEN is missing in environment variables!');
      return res.status(500).json({ error: 'API token not configured' });
    }

    // Check if data is already in node-cache
    const cachedData = apiCache.get(url);
    if (cachedData) {
      res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400, stale-while-revalidate=86400');
      res.setHeader('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    // Coalesced fetch: parallel callers for the same URL share one upstream request
    const data = await fetchTmdbOnce(url);

    // CDN & Browser Caching (Only cache successful responses)
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400, stale-while-revalidate=86400');
    res.setHeader('X-Cache', 'MISS');

    // Naya data memory me save karo (TTL is automatically handled by node-cache)
    apiCache.set(url, data);
    staleCache.set(url, data); // long-lived copy for the fallback path below

    res.json(data);
  } catch (error) {
    const upstreamStatus = error.tmdbStatus || error.response?.status || null;
    const code = error.code || upstreamStatus || 'UNKNOWN';

    /*  403 is logged quietly and at most once a minute per endpoint family.
     *
     *  It is not a server fault: TMDB refuses individual endpoints the key has no
     *  access to, and its edge answers 403 instead of 429 for a rejected burst.
     *  At console.error level and one line per request, a handful of refused
     *  endpoints buried every genuine 5xx in the log. The client treats these the
     *  same way — see the FORBIDDEN section in moviezone.js.
     *
     *  Everything else keeps its original volume.
     */
    if (upstreamStatus === 403) {
      if (shouldLogForbidden(endpoint)) {
        console.warn(`TMDB refused [403]: ${endpoint} — endpoint not permitted for this key, or edge throttling. Serving cache/fallback.`);
      }
    } else {
      console.error(`TMDB Proxy Error [${code}]: ${error.message || 'Unknown error'} for ${endpoint}`);
    }

    // Serve slightly stale data rather than an error — the user never sees a dead page.
    const stale = staleCache.get(url);
    if (stale) {
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
      res.setHeader('X-Cache', 'STALE');
      res.setHeader('X-Stale-Reason', String(code));
      return res.json(stale);
    }

    if (upstreamStatus) {
      return res.status(upstreamStatus).json({ error: 'TMDB API error', detail: error.response?.statusText || 'Upstream error' });
    }

    const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT';
    const isNetwork = ['ECONNRESET', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(code);

    if (isTimeout) {
      return res.status(504).json({ error: 'TMDB request timed out. Please retry.' });
    }
    if (isNetwork) {
      return res.status(503).json({ error: 'TMDB temporarily unreachable. Please retry in a moment.' });
    }
    res.status(500).json({ error: 'Failed to fetch data from TMDB' });
  }
});

// ── CACHE WARMUP (PRE-FETCH) ──
// Server start hote hi sabse important data pehle se fetch karke RAM me rakh lega
// isse pehle aane wale user ko bhi 0ms "Instant" response milega. (Ultra Premium Speed)
async function warmupCache() {
  if (!TMDB_TOKEN) return;
  const trendingUrl = `${TMDB_BASE_URL}/trending/all/week?language=en-US&page=1`;
  try {
    const response = await fetchWithRetry(trendingUrl);
    if (response.ok) {
      const data = await response.json();
      apiCache.set(trendingUrl, data);
      staleCache.set(trendingUrl, data);
      console.log('🔥 Luxury Cache Warmup Complete: Trending movies loaded into memory instantly.');
    }
  } catch (err) { console.error('Cache warmup failed:', err.message); }
}

// PWA sanity check — a missing file here is exactly what makes Chrome DevTools
// report "No manifest detected", so surface it at boot instead of failing silently.
function verifyPwaAssets() {
  const required = ['manifest.json', 'sw.js', 'index.html', 'icon-192.png', 'icon-512.png'];
  const missing = required.filter(f => !resolveAsset(f));
  if (missing.length) {
    console.warn(`⚠️  PWA assets MISSING (searched: ${ASSET_DIRS.join(' | ')}): ${missing.join(', ')}`);
    return false;
  }
  try {
    const m = JSON.parse(fs.readFileSync(resolveAsset('manifest.json'), 'utf8'));
    const needed = ['name', 'short_name', 'start_url', 'display', 'icons'];
    const absent = needed.filter(k => !m[k]);
    if (absent.length) {
      console.warn(`⚠️  manifest.json is missing required fields: ${absent.join(', ')} — inline fallback will be served`);
      return false;
    }
    const badIcons = [...new Set(
      (m.icons || [])
        .filter(i => {
          const relative = assetPathFromUrl(i.src);
          return relative ? !resolveAsset(relative) : false; // remote icons aren't ours to verify
        })
        .map(i => i.src)
    )];
    if (badIcons.length) {
      console.warn(`⚠️  manifest icons not found on disk: ${badIcons.join(', ')}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('⚠️  manifest.json is not valid JSON:', err.message);
    return false;
  }
}

// Server-side only — lets tests exercise the asset resolution logic directly.
app.locals.pwaInternals = { resolveAsset, assetPathFromUrl, verifyPwaAssets, ASSET_DIRS };

// The error handler must be registered before any other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);

// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(res.sentry + "\n");
});

// Server ko start karne ke liye (Local + Render support)
if (require.main === module) {
  const server = app.listen(PORT, () => {
    const pwaOk = verifyPwaAssets();
    console.log(`🚀 Proxy server is running on port ${PORT} | Worker PID: ${process.pid}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ Features Active:`);
    console.log(`   🎬 Continue Watching    — Ready (localStorage)`);
    console.log(`   📱 PWA + Install        — ${pwaOk ? 'Ready (sw.js + manifest.json verified)' : 'CHECK WARNINGS ABOVE'}`);
    console.log(`   🔔 Notify Me            — Ready (Web Push + VAPID)`);
    console.log(`   🌓 Dark/Light Theme     — Ready (Toggle in Navbar)`);
    console.log(`   🎯 Collections          — Ready (10 Universes: MCU, DC, HP...)`);
    console.log(`   📺 TV Optimization      — Ready (D-Pad Navigation + Perf Boost)`);
    console.log(`   ⚡ Performance          — Gzip + Cache + Lazy Load + Rate Limit`);
    console.log(`   🔑 Push Subscribers     — MongoDB (permanent)`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🌐 Open: http://localhost:${PORT}`);
    // Measure both TMDB hostnames first, pin the healthy one, then warm the cache.
    probeTmdbHosts()
      .catch(err => console.warn('TMDB reachability probe failed:', err.message))
      .finally(() => warmupCache());
    setTimeout(() => processDueNotifications().catch(err => console.error('Initial notification check failed:', err)), 5000);
  });

  // Re-measure periodically so we hop back to the primary host once the ISP/network recovers.
  const hostProbeTimer = setInterval(() => {
    probeTmdbHosts({ samples: 2, quiet: true }).catch(() => {});
  }, HOST_REPROBE_MS);

  const notificationTimer = setInterval(() => {
    processDueNotifications().catch(err => console.error('Scheduled notification check failed:', err));
  }, 15 * 60 * 1000);

  // Graceful Shutdown: PM2 Zero-Downtime Reload ke liye
  process.on('SIGINT', () => {
    console.log(`🛑 PM2 stopping worker PID: ${process.pid}. Closing connections gracefully...`);
    clearInterval(notificationTimer);
    clearInterval(hostProbeTimer);
    server.close(() => {
      console.log('✅ Server gracefully shut down.');
      process.exit(0);
    });
  });
}

// Export app for Vercel Serverless
module.exports = app;