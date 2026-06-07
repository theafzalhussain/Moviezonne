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

// Proxy Endpoint: Frontend yahan request bhejega
app.use('/api/tmdb', async (req, res) => {
  try {
    // Request path aur query parameters extract karna
    const endpoint = req.originalUrl.replace('/api/tmdb', '');
    const url = `${TMDB_BASE_URL}${endpoint}`;

    // CDN & Browser Caching (Netlify/Vercel is data ko apne duniya bhar ke servers par cache kar lenge)
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200');

    // Check if data is already in node-cache
    const cachedData = apiCache.get(url);
    if (cachedData) {
      return res.json(cachedData);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TMDB_TOKEN}` }
    });

    const data = await response.json();

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