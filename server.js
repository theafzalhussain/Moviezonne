require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // 1. Security
const compression = require('compression'); // 2. Gzip Compression
const NodeCache = require('node-cache'); // 3. Advanced Caching
const rateLimit = require('express-rate-limit'); // 4. Traffic Control

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use(express.static(__dirname, { maxAge: '30d', etag: true, lastModified: true })); // Extended caching for static assets

// API Rate Limiter: Bura traffic aur DDOS attacks block karega (Luxury stability)
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes window
  max: 300, // Limit each IP to 300 API requests per 5 minutes
  message: { error: 'Too many requests, please calm down and try again.' },
  standardHeaders: true,
});

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_TOKEN = process.env.TMDB_TOKEN;

// Backend Advanced Cache: Initialize NodeCache with a standard TTL of 1 hour (3600 seconds)
const apiCache = new NodeCache({ stdTTL: 3600 });

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
      res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400, stale-while-revalidate=604800');
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
    res.setHeader('Cache-Control', 'public, max-age=7200, s-maxage=86400, stale-while-revalidate=604800');

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
    warmupCache();
  });

  // Graceful Shutdown: PM2 Zero-Downtime Reload ke liye
  process.on('SIGINT', () => {
    console.log(`🛑 PM2 stopping worker PID: ${process.pid}. Closing connections gracefully...`);
    server.close(() => {
      console.log('✅ Server gracefully shut down.');
      process.exit(0);
    });
  });
}

// Export app for Vercel Serverless
module.exports = app;