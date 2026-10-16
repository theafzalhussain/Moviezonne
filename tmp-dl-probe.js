// Temporary: what does each download URL answer with, server-side?
// (status, final URL after redirects, content-type, size, and any links
// that look like real file / mirror links in the body)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const urls = process.argv.slice(2);
(async () => {
  for (const u of urls) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(u, { headers: { 'user-agent': UA, referer: 'https://moviezone.dev/' }, redirect: 'follow', signal: ctl.signal });
      clearTimeout(t);
      const type = r.headers.get('content-type') || '';
      let body = '';
      if (/json|html|text|javascript/.test(type)) body = await r.text();
      else { const b = await r.arrayBuffer(); body = '[binary ' + b.byteLength + ' bytes]'; }
      console.log('\n=== ' + u);
      console.log('  status ' + r.status + '  final ' + r.url + '\n  type ' + type + '  length ' + body.length);
      const title = (body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
      if (title) console.log('  title: ' + title.trim().slice(0, 120));
      if (/json/.test(type)) console.log('  json: ' + body.slice(0, 900));
      const links = [...new Set([...body.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)].map((m) => m[0]))]
        .filter((l) => /download|\.mkv|\.mp4|drive|gdrive|pixeldrain|hubcloud|gofile|mega|1fichier|\/dl\/|file/i.test(l))
        .slice(0, 12);
      if (links.length) console.log('  link-like: \n    ' + links.join('\n    '));
      const text = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && !/json/.test(type)) console.log('  text: ' + text.slice(0, 300));
    } catch (e) { console.log('\n=== ' + u + '\n  ERROR ' + e.message); }
  }
})();
