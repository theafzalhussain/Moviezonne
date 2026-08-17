export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // SEO: www → non-www 301 redirect
    if (url.hostname === 'www.moviezone.dev') {
      const redirectUrl = `https://moviezone.dev${url.pathname}${url.search}`;
      return Response.redirect(redirectUrl, 301);
    }

    // TMDB API proxy with KV caching
    if (url.pathname.startsWith('/api/tmdb/')) {
      const tmdbPath = url.pathname.replace('/api/tmdb/', '');
      const targetUrl = `https://api.themoviedb.org/3/${tmdbPath}${url.search}`;
      
      const cacheKey = url.pathname + url.search;
      
      if (env.TMDB_CACHE) {
        const cached = await env.TMDB_CACHE.get(cacheKey);
        if (cached) {
          return new Response(cached, {
            status: 200,
            headers: { 
              'content-type': 'application/json',
              'x-cache': 'HIT',
              'cache-control': 'public, max-age=3600'
            }
          });
        }
      }
      
      const headers = new Headers();
      headers.set('Authorization', `Bearer ${env.TMDB_TOKEN}`);
      headers.set('accept', 'application/json');
      
      const response = await fetch(targetUrl, { headers, method: request.method });
      const data = await response.text();
      
      if (env.TMDB_CACHE && response.status === 200) {
        ctx.waitUntil(env.TMDB_CACHE.put(cacheKey, data, { expirationTtl: 3600 }));
      }
      
      return new Response(data, {
        status: response.status,
        headers: { 
          'content-type': 'application/json',
          'x-cache': 'MISS',
          'cache-control': 'public, max-age=3600'
        }
      });
    }

    // Static assets serve karo with SEO headers
    const assetResponse = await env.ASSETS.fetch(request);
    
    // SEO: security + caching headers add karo
    const newHeaders = new Headers(assetResponse.headers);
    newHeaders.set('X-Content-Type-Options', 'nosniff');
    newHeaders.set('X-Frame-Options', 'SAMEORIGIN');
    newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // HTML files ke liye cache-control
    if (url.pathname.endsWith('.html') || url.pathname === '/') {
      newHeaders.set('Cache-Control', 'public, max-age=3600');
    }
    
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers: newHeaders
    });
  }
};
