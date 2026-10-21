#!/usr/bin/env node
/*  Tells IndexNow (Bing, Yandex, Seznam, Naver; Bing also feeds DuckDuckGo,
 *  Yahoo and ChatGPT search) which MovieZone URLs exist or changed, so they are
 *  recrawled within hours instead of whenever the crawler next passes.
 *
 *  Google does not take IndexNow; it reads the sitemap, which robots.txt
 *  advertises. Run daily by the SEO refresh workflow. Never fails the job.
 *
 *  The key is public by design: IndexNow proves ownership by fetching
 *  https://moviezone.dev/<key>.txt and comparing its contents.
 */
'use strict';
const seo = require('../seo-ssr.js');

const KEY = 'd673808e4bb9e7fade86702d212149c1';
const HOST = 'moviezone.dev';
const SITE = 'https://' + HOST;

const urls = new Set([SITE + '/', SITE + seo.FRANCHISE_INDEX_PATH, SITE + '/browse']);
seo.FRANCHISES.forEach((f) => urls.add(SITE + seo.franchisePath(f)));
const staticXml = seo.buildStaticSitemap();
for (const m of staticXml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1]);

const body = { host: HOST, key: KEY, keyLocation: SITE + '/' + KEY + '.txt', urlList: [...urls].slice(0, 10000) };

(async () => {
  if (process.argv.includes('--dry-run')) {
    console.log('IndexNow dry run: ' + body.urlList.length + ' URLs, key file ' + body.keyLocation);
    return;
  }
  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });
    // 200 = accepted, 202 = accepted, key validation pending.
    console.log('IndexNow: HTTP ' + res.status + ' for ' + body.urlList.length + ' URLs');
  } catch (err) {
    console.log('::warning::IndexNow ping failed: ' + (err && err.message));
  }
})();
