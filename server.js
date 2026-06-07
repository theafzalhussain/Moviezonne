require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Backend Memory Cache (TMDB api calls kam karne aur response fast karne ke liye)
const apiCache = new Map();

// Proxy Endpoint: Frontend yahan request bhejega
app.use('/api/tmdb', async (req, res) => {
  try {
    // Request path aur query parameters extract karna
    const endpoint = req.originalUrl.replace('/api/tmdb', '');
    const url = `${TMDB_BASE_URL}${endpoint}`;

    // CDN & Browser Caching (Netlify/Vercel is data ko apne duniya bhar ke servers par cache kar lenge)
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200');

    // Agar Render server ki memory me pehle se data hai, toh TMDB ko call mat karo (Speed x100)
    if (apiCache.has(url)) {
      return res.json(apiCache.get(url));
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TMDB_TOKEN}` }
    });

    const data = await response.json();

    // Naya data memory me save karo 1 ghante ke liye (3600000 ms) taaki agle user ko instantly mile
    apiCache.set(url, data);
    setTimeout(() => apiCache.delete(url), 3600000);

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