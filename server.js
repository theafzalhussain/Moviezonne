require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // 1. Security
const compression = require('compression'); // 2. Gzip Compression
const NodeCache = require('node-cache'); // 3. Advanced Caching
const rateLimit = require('express-rate-limit'); // 4. Traffic Control
const webPush = require('web-push'); // 5. Push Notifications
const { MongoClient } = require('mongodb'); // 6. Database

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

// Frontend files (index.html, css, js) ko browser mein dikhane ke liye
app.use(express.static(__dirname, { 
  maxAge: '30d',
  etag: true,
  lastModified: true,
  immutable: true,
  setHeaders: (res, path) => {
    // CSS/JS ko 5 min cache (allows SW updates)
    if (path.endsWith('.css') || path.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
    // Images ko 60 days cache
    if (/\.(jpg|jpeg|png|gif|svg|webp|ico)$/.test(path)) {
      res.setHeader('Cache-Control', 'public, max-age=5184000, immutable');
    }
    // HTML ko short cache (fresh content milta rahe)
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
  }
}));

// API Rate Limiter: Bura traffic aur DDOS attacks block karega (Luxury stability)
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes window
  max: 300, // Limit each IP to 300 API requests per 5 minutes
  message: { error: 'Too many requests, please calm down and try again.' },
  standardHeaders: true,
});

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_TOKEN = process.env.TMDB_TOKEN;

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
        icon: '/icon-192.svg',
        badge: '/icon-192.svg',
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
      icon: '/icon-192.svg',
      badge: '/icon-192.svg',
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
        icon: '/icon-192.svg',
        badge: '/icon-192.svg',
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

// Health Check / Ping Endpoint: UptimeRobot ko server jagaye rakhne ke liye
app.get('/ping', (req, res) => {
  res.status(200).send('Pong! Server is awake.');
});

// Ignore favicon requests to prevent 404 errors in the terminal/console
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Proxy Endpoint: Frontend yahan request bhejega
app.use('/api/tmdb', apiLimiter, async (req, res) => {
  try {
    if (!TMDB_TOKEN) {
      console.error('CRITICAL ERROR: TMDB_TOKEN is missing in environment variables!');
      return res.status(500).json({ error: 'API token not configured' });
    }

    // Request path aur query parameters extract karna
    // Bulletproof URL extraction (Handles all Vercel/Express rewrite behaviors)
    const safeUrl = req.url.replace(/^\/api\/tmdb/, '');
    const endpoint = safeUrl.startsWith('/') ? safeUrl : '/' + safeUrl;
    const url = `${TMDB_BASE_URL}${endpoint}`;

    // Check if data is already in node-cache
    const cachedData = apiCache.get(url);
    if (cachedData) {
      res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400, stale-while-revalidate=86400');
      return res.json(cachedData);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TMDB_TOKEN}` }
    });

    // Agar TMDB se error aaye, toh error bhejo aur cache headers mat lagao (bura data cache nahi hoga)
    if (!response.ok) {
      const errText = await response.text();
      console.error(`TMDB API Error: ${response.status} - ${errText} for URL: ${url}`);
      return res.status(response.status).json({ error: 'Failed to fetch data from TMDB' });
    }

    const data = await response.json();

    // CDN & Browser Caching (Only cache successful responses)
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400, stale-while-revalidate=86400');

    // Naya data memory me save karo (TTL is automatically handled by node-cache)
    apiCache.set(url, data);

    res.json(data);
  } catch (error) {
    console.error('TMDB Proxy Error:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// ── CACHE WARMUP (PRE-FETCH) ──
// Server start hote hi sabse important data pehle se fetch karke RAM me rakh lega
// isse pehle aane wale user ko bhi 0ms "Instant" response milega. (Ultra Premium Speed)
async function warmupCache() {
  if (!TMDB_TOKEN) return;
  const trendingUrl = `${TMDB_BASE_URL}/trending/all/week?language=en-US&page=1`;
  try {
    const response = await fetch(trendingUrl, { headers: { 'Authorization': `Bearer ${TMDB_TOKEN}` } });
    if (response.ok) {
      const data = await response.json();
      apiCache.set(trendingUrl, data);
      console.log('🔥 Luxury Cache Warmup Complete: Trending movies loaded into memory instantly.');
    }
  } catch (err) { console.error('Cache warmup failed:', err.message); }
}

// Server ko start karne ke liye (Local + Render support)
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Proxy server is running on port ${PORT} | Worker PID: ${process.pid}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ Features Active:`);
    console.log(`   🎬 Continue Watching    — Ready (localStorage)`);
    console.log(`   📱 PWA + Install        — Ready (sw.js + manifest.json)`);
    console.log(`   🔔 Notify Me            — Ready (Web Push + VAPID)`);
    console.log(`   🌓 Dark/Light Theme     — Ready (Toggle in Navbar)`);
    console.log(`   🎯 Collections          — Ready (10 Universes: MCU, DC, HP...)`);
    console.log(`   📺 TV Optimization      — Ready (D-Pad Navigation + Perf Boost)`);
    console.log(`   ⚡ Performance          — Gzip + Cache + Lazy Load + Rate Limit`);
    console.log(`   🔑 Push Subscribers     — MongoDB (permanent)`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🌐 Open: http://localhost:${PORT}`);
    warmupCache();
    setTimeout(() => processDueNotifications().catch(err => console.error('Initial notification check failed:', err)), 5000);
  });

  const notificationTimer = setInterval(() => {
    processDueNotifications().catch(err => console.error('Scheduled notification check failed:', err));
  }, 15 * 60 * 1000);

  // Graceful Shutdown: PM2 Zero-Downtime Reload ke liye
  process.on('SIGINT', () => {
    console.log(`🛑 PM2 stopping worker PID: ${process.pid}. Closing connections gracefully...`);
    clearInterval(notificationTimer);
    server.close(() => {
      console.log('✅ Server gracefully shut down.');
      process.exit(0);
    });
  });
}

// Export app for Vercel Serverless
module.exports = app;