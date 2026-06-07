require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // 1. Security
const compression = require('compression'); // 2. Gzip Compression
const NodeCache = require('node-cache'); // 3. Advanced Caching

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
app.use(express.static(__dirname));

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_TOKEN = process.env.TMDB_TOKEN;

// Backend Advanced Cache: Initialize NodeCache with a standard TTL of 1 hour (3600 seconds)
const apiCache = new NodeCache({ stdTTL: 3600 });

// Health Check / Ping Endpoint: UptimeRobot ko server jagaye rakhne ke liye
app.get('/ping', (req, res) => {
  res.status(200).send('Pong! Server is awake.');
});

// Proxy Endpoint: Frontend yahan request bhejega
app.use('/api/tmdb', async (req, res) => {
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
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200');
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
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200');

    // Naya data memory me save karo (TTL is automatically handled by node-cache)
    apiCache.set(url, data);

    res.json(data);
  } catch (error) {
    console.error('TMDB Proxy Error:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// Server ko start karne ke liye (Local + Render support)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Proxy server is running on port ${PORT}`);
  });
}

// Export app for Vercel Serverless
module.exports = app;