export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // TMDB API proxy with KV caching
    if (url.pathname.startsWith('/api/tmdb/')) {
      const tmdbPath = url.pathname.replace('/api/tmdb/', '');
      const targetUrl = `https://api.themoviedb.org/3/${tmdbPath}${url.search}`;
      
      // Cache key = full path + query string
      const cacheKey = url.pathname + url.search;
      
      // 1. Pehle cache check karo
      if (env.TMDB_CACHE) {
        const cached = await env.TMDB_CACHE.get(cacheKey);
        if (cached) {
          return new Response(cached, {
            status: 200,
            headers: { 
              'content-type': 'application/json',
              'x-cache': 'HIT'
            }
          });
        }
      }
      
      // 2. Cache miss — TMDB se fetch karo
      const headers = new Headers();
      headers.set('Authorization', `Bearer ${env.TMDB_TOKEN}`);
      headers.set('accept', 'application/json');
      
      const response = await fetch(targetUrl, { headers, method: request.method });
      const data = await response.text();
      
      // 3. Response cache mein save karo (TTL = 1 hour = 3600 seconds)
      if (env.TMDB_CACHE && response.status === 200) {
        ctx.waitUntil(env.TMDB_CACHE.put(cacheKey, data, { expirationTtl: 3600 }));
      }
      
      return new Response(data, {
        status: response.status,
        headers: { 
          'content-type': 'application/json',
          'x-cache': 'MISS'
        }
      });
    }

    // Baaki sab — static assets se serve karo
    return env.ASSETS.fetch(request);
  }
};
