export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // TMDB API proxy
    if (url.pathname.startsWith('/api/tmdb/')) {
      const tmdbPath = url.pathname.replace('/api/tmdb/', '');
      const targetUrl = `https://api.themoviedb.org/3/${tmdbPath}${url.search}`;
      
      const headers = new Headers();
      headers.set('Authorization', `Bearer ${env.TMDB_TOKEN}`);
      headers.set('accept', 'application/json');
      
      const response = await fetch(targetUrl, { headers, method: request.method });
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json' }
      });
    }

    // Baaki sab — static assets se serve karo
    return env.ASSETS.fetch(request);
  }
};
