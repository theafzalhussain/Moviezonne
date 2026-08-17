export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // SEO: www → non-www 301 redirect
    if (url.hostname === 'www.moviezone.dev') {
      const redirectUrl = `https://moviezone.dev${url.pathname}${url.search}`;
      return Response.redirect(redirectUrl, 301);
    }

    // ─── Push: Subscribe ───────────────────────────────────────
    if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
      try {
        const body = await request.json();

        // Agar MongoDB Data API available hai to save karo
        if (env.MONGODB_DATA_API_URL && env.MONGODB_DATA_API_KEY) {
          const mongoRes = await fetch(`${env.MONGODB_DATA_API_URL}/action/insertOne`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': env.MONGODB_DATA_API_KEY
            },
            body: JSON.stringify({
              collection: 'push_subscriptions',
              database: 'moviezone',
              dataSource: 'Cluster0',
              document: {
                subscription: body.subscription || body,
                movieId: body.movieId || null,
                movieTitle: body.movieTitle || null,
                releaseDate: body.releaseDate || null,
                createdAt: new Date().toISOString(),
                notified: false
              }
            })
          });

          const mongoData = await mongoRes.json();

          if (mongoData.insertedId) {
            return new Response(JSON.stringify({
              success: true,
              message: 'Subscription saved! You will be notified.'
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          } else {
            return new Response(JSON.stringify({
              success: false,
              error: 'Database error'
            }), {
              status: 500,
              headers: { 'content-type': 'application/json' }
            });
          }
        }

        // Agar MongoDB Data API set nahi hai, sirf acknowledge karo
        return new Response(JSON.stringify({
          success: true,
          message: 'Subscription received (MongoDB not configured)'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid request: ' + e.message
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
    }

    // ─── Push: Unsubscribe ─────────────────────────────────────
    if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') {
      try {
        const body = await request.json();

        if (env.MONGODB_DATA_API_URL && env.MONGODB_DATA_API_KEY) {
          await fetch(`${env.MONGODB_DATA_API_URL}/action/deleteOne`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': env.MONGODB_DATA_API_KEY
            },
            body: JSON.stringify({
              collection: 'push_subscriptions',
              database: 'moviezone',
              dataSource: 'Cluster0',
              filter: {
                'subscription.endpoint': body.endpoint
              }
            })
          });
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Unsubscribed successfully'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          success: false,
          error: e.message
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
    }

    // ─── TMDB API Proxy with KV Caching ─────────────────────────
    if (url.pathname.startsWith('/api/tmdb/')) {
      const tmdbPath = url.pathname.replace('/api/tmdb/', '');
      const targetUrl = `https://api.themoviedb.org/3/${tmdbPath}${url.search}`;

      const cacheKey = url.pathname + url.search;

      // 1. Pehle cache check karo
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
          'x-cache': 'MISS',
          'cache-control': 'public, max-age=3600'
        }
      });
    }

    // ─── Static Assets with SEO Headers ────────────────────────
    const assetResponse = await env.ASSETS.fetch(request);

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
