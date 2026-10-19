# MovieZone — Movie & TV Discovery Platform (PWA)

A performance-focused movie and TV discovery platform built on the TMDB API, shipped as an installable Progressive Web App with a dedicated TV interface, server-side SEO rendering, push notifications, and an automated performance and correctness test suite.

**🔗 Live Demo:** https://moviezonne.dev

---

📖 Overview

MovieZone is a movie and TV discovery front end built on the TMDB API. The browser never talks to TMDB directly: every upstream call passes through a proxy that adds an in-memory cache, request coalescing, retry with backoff, dual-hostname failover and a 24-hour stale fallback, so the UI stays usable when the upstream API is slow, throttled or unreachable.

The client is vanilla JavaScript — no framework, no bundler — shipped as an installable PWA with a service worker, web push and a separate TV module that takes over D-pad navigation. Because the app itself is a hash-routed SPA, a second server-rendered layer (seo-ssr.js) generates real crawlable URLs for every title, category and A–Z hub. Performance and correctness are enforced rather than assumed: the repository ships around thirty standalone Node checks that gate Core Web Vitals, asset cache invalidation, SSR output, sitemap sharding, feed pagination, TV layout parity, player health and upstream resilience.

✨ Key Features

Discovery & Browsing — Hero carousel plus a paginated poster feed over TMDB trending, popular, top-rated, now-playing and upcoming. Category tabs (Hollywood, Bollywood, South Indian, Web Series, Anime, Cartoons) with grouped genre and Tollywood dropdowns, plus provider-filtered OTT sections for Netflix, Prime Video, JioHotstar and Zee5 with All / Web Series / Movies sub-modes. A curated franchise hub covers 18 universes; Continue Watching and a local watchlist persist in localStorage.

Search — search-engine.js combines a 350 ms trailing debounce, token aliasing for the spellings users actually type, and MiniFuse: a self-contained Bitap fuzzy matcher that mirrors Fuse.js scoring in ~3 KB and defers to real Fuse.js when present. Strong fuzzy matches the strict scorer would discard are rescued back into the ranking.

Watch Experience — Detail modal with cast, genres, synopsis, related titles and hover trailers (trailer fetches deliberately omit a fixed language filter so non-English titles still return videos). Multi-server playback uses a learned server-health ranking that promotes fast providers, demotes dead ones and later forgives them, with an instant-play path that preconnects and prewarms, plus an AniList id bridge for anime and cartoon providers.

TV Mode — tv-mode.js detects real TV hardware from user-agent tokens, pointer capabilities or an explicit ?tv=1 — never from screen size — across Fire TV, Android TV, webOS, Tizen, VIDAA, Roku, Chromecast, tvOS, Bravia, HbbTV, PlayStation and Xbox, and owns arrow-key spatial navigation and media keys. Layout identity is a hard requirement: TV mode is a performance layer, so only motion and blur may differ from desktop.

PWA & Offline — Web app manifest with maskable icons, plus a validated inline fallback served if the file is ever unreadable. sw.js precaches the shell, serves versioned bundles cache-first and navigations network-first, and keeps a separate stale-while-revalidate TMDB image cache capped at 400 entries so a shell upgrade never discards hundreds of posters. The custom install prompt includes an inline QR generator for handing the URL to a phone.

Push Notifications — VAPID Web Push with subscribe/unsubscribe, per-title release reminders, a broadcast endpoint and subscriber stats. Under Node the crypto is handled by web-push with MongoDB storage; the Cloudflare Worker reimplements VAPID signing (RFC 8292) and payload encryption (RFC 8291 / RFC 8188) against Web Crypto and stores state in KV.

SEO — Server-rendered detail pages (/movie/550-fight-club), watch pages, category landings and A–Z browse hubs, each with a unique title, description and schema.org JSON-LD. A sharded sitemap index is built from sitemap-cache.json (5,003 movies and 3,259 series in the committed cache), and a build step bakes crawlable links into the otherwise client-rendered homepage. worker.js imports the same renderers, so both runtimes emit identical markup.

Performance — gzip compression, a two-hour node-cache layer, in-flight coalescing and cache warmup at boot. Edge batching collapses a cold homepage's ~26 TMDB calls into one /api/tmdb/batch request the Worker fans out, with silent fallback if unavailable. On the client, a stale-while-revalidate cache with deferred localStorage writes sits behind a request concurrency gate. asset-seal.js records each immutable bundle's SHA-256 against the ?v= it ships under, so a changed file that forgot its version bump fails the build instead of pinning every CDN and service-worker client to stale code.

Observability — Datadog Browser RUM, gated in index.html: crawlers are skipped, local and LAN hosts report development and sample nothing, weak devices and TVs keep errors but lose Session Replay, and a beforeSend filter drops only provably foreign errors. Sentry covers the server. /ping is a liveness probe and /api/tmdb-health reports the active upstream host, per-host penalty state, cache sizes and in-flight count.

🛠️ Tech Stack
Layer	Technology
Server	Node.js (CommonJS), Express 5, compression, cors, helmet, express-rate-limit
Edge runtime	Cloudflare Workers (worker.js) with Workers KV and a cron trigger
Data source	TMDB API v3 (v4 bearer token), accessed only server-side
HTTP client	axios + axios-retry over a keep-alive HTTPS agent
Caching	node-cache (2 h fresh + 24 h stale), in-flight coalescing, Workers KV
Database	MongoDB (mongodb 7.x) — push subscriptions and release reminders
Push	web-push under Node; Web Crypto VAPID/AES128GCM in the Worker
Client	Vanilla ES6+ JavaScript, HTML5, CSS3, self-hosted WOFF2 fonts
PWA	Web App Manifest, Service Worker, Web Push
Build	terser, clean-css-cli, sharp (dev)
Monitoring & ops	Datadog Browser RUM, Sentry Node, PM2, GitHub Actions
🏗️ Architecture

The same page renderers run in two runtimes: server.js mounts them on Express, while worker.js expresses the same routing table against Request/Response and imports the renderers from seo-ssr.js unchanged. TMDB credentials never leave the server, and every upstream response is written to both a fresh cache and a long-lived stale cache, so a crawler or a user hitting a cold cache during an outage still receives data.

   Browser / PWA / Smart TV  ·  index.html + moviezone.js + tv-mode.js
   Service Worker cache · Web Push · localStorage SWR
                       ▼
   ┌────────────────────────────────────────────────┐
   │  server.js (Express 5)   or   worker.js (CF)   │
   │  helmet · compression · cors · rate limit      │
   │  /api/tmdb        proxy + cache + coalescing   │
   │  /api/tmdb/batch  edge fan-out (Worker only)   │
   │  /api/push/*      subscriptions + broadcast    │
   │  /api/notify-*    release reminders            │
   │  seo-ssr.js       SSR pages + sitemaps         │
   └────────────────────────────────────────────────┘
          │                  │                 │
          ▼                  ▼                 ▼
   TMDB API (dual      MongoDB / KV     sitemap-cache.json
   host + retry)       subscriptions    collections-catalog.json

Two details worth calling out. The TMDB client probes both api.themoviedb.org and api.tmdb.org at boot, pins the healthier hostname, flips mid-retry on connection errors and re-probes every ten minutes — a documented workaround for SNI-based interception that resets new TLS connections. And the SSR routes are registered after express.static, so a real file on disk always wins and only genuine misses reach the renderers; the homepage handler is the deliberate exception, registered before it.

🚀 Getting Started
Prerequisites

Node.js 18 or newer (CI runs Node 22) and a TMDB API v4 read access token — a v3 API key also works for the SEO scripts. MongoDB and a VAPID key pair (npx web-push generate-vapid-keys) are optional, needed only for push subscriptions and release reminders.

Installation & Environment Setup
bash
git clone https://github.com/theafzalhussain/Moviezonne.git
cd Moviezonne
npm install
cp .env.example .env     # fill in at minimum TMDB_TOKEN

The server starts without MongoDB and without VAPID keys — persistence and push simply report themselves as unavailable.

Running Locally
bash
npm run dev     # node server.js

It listens on PORT, defaulting to 3001. On boot it verifies the PWA assets, probes both TMDB hostnames, warms the trending cache and schedules the reminder sweep.

Production Build
bash
npm run build         # minify CSS + JS into the .min bundles
npm run assets:seal   # re-seal hashes after bumping ?v= in index.html and sw.js
npm test              # gate the build

For a long-running deployment, ecosystem.config.js defines a single-instance PM2 fork process (moviezone-pro) with a 384 MB restart ceiling and graceful SIGINT shutdown.

🔑 Environment Variables
Variable	Description	Required
TMDB_TOKEN	TMDB v4 read access token, sent as a bearer by the proxy and SSR layer	Yes
TMDB_API_KEY	TMDB v3 key, accepted as an alternative by the SEO build scripts	No
MONGODB_URI	MongoDB connection string for push subscriptions and reminders	No
VAPID_PUBLIC_KEY	Web Push public key served to browsers	No
VAPID_PRIVATE_KEY	Web Push private key used to sign pushes — keep secret	No
VAPID_EMAIL	mailto: contact for push services (RFC 8292 subject)	No
CRON_SECRET	Cloudflare Worker only — when set, /api/notifications/process-due requires it	No
SENTRY_DSN	Sentry DSN for server-side error tracking	No
PORT	HTTP port; defaults to 3001	No
SITE_URL	Canonical origin for the SEO layer; defaults to https://moviezone.dev	No
API_RATE_LIMIT_MAX	Per-IP /api/tmdb ceiling per 5-minute window; defaults to 1500	No
SITEMAP_LASTMOD	Fallback lastmod date for sitemap entries	No
SITEMAP_DISCOVER_PAGES	Discover pages walked by the sitemap builder; defaults to 60	No
SITEMAP_LIST_PAGES	List pages walked by the sitemap builder; defaults to 15	No
SITEMAP_ALLOW_SHRINK	Allows a sitemap rebuild to write a smaller catalogue	No
MZ_CWV_PAGE_PORT	Port the CWV and resilience checks target; defaults to 3001	No
📜 Available Scripts
Development, Build & Assets
Script	Description
npm run dev / npm start	Start server.js
npm run build	Minify moviezone, tv-mode, search-engine and pwa-install CSS/JS
npm run assets:seal	Rewrite asset-versions.json after a legitimate ?v= bump
Testing
Script	Description
npm test	Full suite — 27 chained checks
npm run test:offline	19 checks that need no network or live TMDB access
npm run test:tv	TV detection, key mapping, spatial geometry, browser harness
npm run test:tabs, test:tabs:mobile	Category tab behaviour, desktop and mobile
npm run test:ranking, test:pager	Home feed ranking order and feed pagination
npm run test:ott, test:trailers	OTT platform ids against live TMDB; trailer language handling
npm run test:ads, test:push	Ad gating and pre-paint reservation; Worker push crypto
npm run test:perf, test:cwv	Asset seal and budgets, player health; Core Web Vitals in headless Chrome
npm run test:seo	SSR output, sitemap sharding, crawl depth, Worker SEO
npm run test:resilience	Upstream failure and retry-storm handling
SEO & Verification
Script	Description
npm run sitemap:build	Walk TMDB once and write sitemap-cache.json atomically
npm run home:inject	Bake the crawlable homepage link block into index.html
npm run seo:refresh	Both of the above
npm run verify:deploy	Read the live site and report which changes actually shipped
npm run verify:seo	Boot the real server and smoke-test every SSR route end to end
npm run verify:tv	Drive headless Chrome as a Smart TV and assert layout identity
npm run perf:tv	Measure TV-mode load, scroll and fetch cost under CPU throttling
📂 Project Structure
Moviezonne/
├── server.js                   Express 5 app: TMDB proxy, push API, PWA + SSR wiring
├── worker.js                   Cloudflare Worker: same API surface, KV-backed
├── seo-ssr.js                  SSR pages, sitemaps, browse hubs, ad slots
├── instrument.js               Sentry init (loaded first)
├── index.html                  App shell, RUM gate, ad gate, critical CSS
├── moviezone.js / .css         Feeds, OTT sections, search UI, player, modals
├── tv-mode.js / .css           TV detection, D-pad navigation, TV perf policy
├── search-engine.js            Debounce, MiniFuse fuzzy matcher, ranking
├── pwa-install.js              Install prompt, iOS guide, inline QR generator
├── sw.js / manifest.json       Service worker (shell cache, image SWR, push) + PWA manifest
├── *.min.js / *.min.css        Build output — what production actually ships
├── collections-catalog.json    18 curated franchise universes
├── sitemap-cache.json          Pre-built catalogue for sitemaps and browse hubs
├── asset-versions.json         Sealed SHA-256 ↔ ?v= map
├── perf-baseline.json          Committed TV performance baseline
├── scripts/                    build-sitemap-cache.js, inject-home-links.js
├── *-check.js                  19 guard scripts (CWV, assets, ads, SEO, TV, OTT)
├── *.test.js                   13 tests (SSR, push, player, RUM filter, PWA)
├── *.browser.test.js / .html   Headless-Chrome harnesses
├── .github/workflows/          Scheduled SEO refresh
├── vercel.json                 Vercel serverless + static build and headers
├── wrangler.jsonc              Cloudflare Worker, KV bindings, cron trigger
├── netlify.toml                Netlify static hosting and TMDB proxy redirects
├── ecosystem.config.js         PM2 process definition
├── .vercelignore / .assetsignore    Publish exclusion lists (asserted by tests)
└── robots.txt                  Crawl rules, content signals, sitemap pointer
🧪 Testing & Quality Gates

There is no test framework — each check is a standalone Node script that exits non-zero on failure, which keeps them runnable individually and in CI. npm test chains 27 of them.

Category	What it protects
Asset integrity (asset-seal, asset-perf-check)	A changed bundle that kept its ?v= stays pinned in CDN and service-worker caches for a year; the seal fails the build instead
Core Web Vitals (cwv-check, carousel-fit-check)	LCP element choice, font readiness, layout shift and hero-rail geometry, measured in a real browser at a mobile viewport
SEO / SSR (seo-ssr.test, worker-seo.test, sitemap-shard-check, browse-depth-check, seo-live-check)	Unique titles and descriptions, valid JSON-LD, stable sitemap shard counts, every title within two clicks of the homepage
Feeds (feed-pager-check, all-feed-ranking, cat-tabs*)	The feed pages instead of growing forever, ranking order holds, tabs work on desktop and mobile
TV mode (tv-mode.test, tv-e2e-check, tv-perf-check)	Detection never misfires on desktops, layout matches desktop exactly, long tasks and dropped frames stay within the committed baseline
Playback (player-health.test, watch-page-check, trailer-langs-check)	Server ranking demotes dead providers and forgives recovered ones; posters are not stretched; trailers work outside Hollywood
Resilience (tmdb-resilience-check, tmdb-403-check, tmdb-stale, tmdb-e2e)	Bounded retries instead of a retry storm, quiet handling of intermittent upstream 403s, X-Cache: STALE rather than a 503
PWA & push (pwa-assets.test, worker-push.test)	Manifest icons with cache-busting queries resolve on disk; every push endpoint the client calls exists in the Worker
Ads (ad-gate-check)	Nothing third-party is parser-blocking, dev hosts / crawlers / TVs are excluded, the slot reserves height before paint, ad hosts bypass the service worker
Observability (rum-filter.test, rum-gate.browser.test)	The RUM beforeSend filter cannot start hiding first-party errors
Deploy hygiene (vercelignore-check, assetsignore-check, deploy-verify-check)	Test files are never published, runtime files are never excluded, the live site really has the change
OTT accuracy (ott-check, ott-sections-check)	Every card under a platform tab is verified against that title's own watch-provider record
🚢 Deployment

The repository carries working configuration for four targets, and the SSR layer is written to behave identically on all of them. .vercelignore and .assetsignore keep test harnesses, build scripts and internal JSON out of published output — and both lists are themselves asserted by tests, in both directions.

Target	Configuration	Notes
Vercel	vercel.json	server.js as an @vercel/node function in bom1; static assets served directly; rewrites hand /api, /movie, /tv, /movies, /series, /browse and the sitemaps to the function
Cloudflare Workers	wrangler.jsonc, worker.js	Assets served from the repo root with run_worker_first for API and SSR paths; KV namespaces TMDB_CACHE and PUSH_SUBS; hourly cron (15 * * * *) drives release reminders; secrets via wrangler secret put
Netlify	netlify.toml	Static hosting plus TMDB API and image proxy redirects, with immutable cache headers for fonts, bundles and icons
Long-running Node	ecosystem.config.js	PM2 fork mode, single instance, 384 MB restart ceiling, NODE_ENV=production

CI/CD — .github/workflows/seo-refresh.yml runs daily at 20:00 UTC and on demand. It rebuilds sitemap-cache.json, refreshes the homepage link block, optionally uploads the catalogue to the Worker's KV namespace, runs the SEO tests as a gate, and commits only if something changed.

🖼️ Screenshots
<!-- Replace with your screenshot: docs/screenshots/home.png --> <!-- Replace with your screenshot: docs/screenshots/detail-modal.png --> <!-- Replace with your screenshot: docs/screenshots/tv-mode.png --> <!-- Replace with your screenshot: docs/screenshots/pwa-install.png -->
🗺️ Roadmap
Re-enable a real Content Security Policy — helmet's CSP is currently disabled to allow TMDB images and third-party player frames, and needs an explicit allowlist instead.
Move the client assets into public/; server.js already resolves through a candidate directory list specifically so this needs no code change.
Consolidate the standalone checks behind one runner with shared reporting, and wire the full suite into CI alongside the existing SEO workflow.
Converge on a single primary deployment target, archive the unused configurations, and extend the committed TV performance baseline to more device tiers.
🤝 Contributing

Issues and pull requests are welcome. Fork the repository, branch from main, then:

Run npm test after your change — or npm run test:offline when you have no TMDB credentials to hand.
If you touched moviezone.js, moviezone.css, tv-mode.*, search-engine.js or pwa-install.js: run npm run build, bump the matching ?v= in both index.html and sw.js, bump CACHE_NAME, then run npm run assets:seal. asset-seal.js fails the build if these drift apart.
Keep new behaviour covered by a check script, matching the existing convention.
📄 License

Licensed under the ISC License, as declared in package.json. No standalone LICENSE file is currently present in the repository.

👤 Author

Afzal Hussain

GitHub: @theafzalhussain
Portfolio: afzalhussain.tech
Email: theafzalhussain786@gmail.com
⚠️ Disclaimer

MovieZone is a metadata discovery interface. All catalogue information — titles, artwork, cast, ratings and watch-provider availability — comes from the public TMDB API. This project hosts, stores and serves no media files of its own; the watch page renders third-party embed players that are not affiliated with or operated by this project, and it does not index, upload or distribute any content. This product uses the TMDB API but is not endorsed or certified by TMDB.---

## Tech Stack

**Frontend**
| Area | Technology |
|---|---|
| Core | Vanilla JavaScript (ES6+), HTML5, CSS3 |
| PWA | Web App Manifest, Service Worker, Web Push |
| Monitoring | Datadog RUM, Core Web Vitals |
| Build | Terser, clean-css |

**Backend**
| Area | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express |
| Data | MongoDB |
| Caching | node-cache |
| HTTP | Axios with axios-retry, undici |
| Push | web-push |
| Security | Helmet, CORS, express-rate-limit |
| Monitoring | Sentry |
| Process management | PM2 |

**External API**
- TMDB (The Movie Database)

**Deployment**
- Vercel

---

## Architecture

```
Browser / TV client
   │
   │  HTTP  ·  Service Worker cache  ·  Web Push
   ▼
Express server
   ├── SSR routes for crawlers
   ├── TMDB proxy with retry + cache
   ├── Push subscription endpoints
   └── Sitemap + SEO endpoints
         │
         ├──► TMDB API   (upstream catalogue)
         └──► MongoDB    (subscriptions, cached data)
```

TMDB is never called directly from the browser. All upstream requests pass through the server, which adds caching, retries, and stale-data fallbacks so the UI stays usable even when the upstream API is slow or failing.

---

## Getting Started

### Prerequisites
- Node.js
- A TMDB API key
- MongoDB instance (for push subscriptions and cached data)

### Installation

```bash
git clone https://github.com/theafzalhussain/Moviezonne.git
cd Moviezonne
npm install
```

### Environment Variables

Copy the provided example file and fill in your own values:

```bash
cp .env.example .env
```

```env
TMDB_API_KEY=your_tmdb_api_key
MONGODB_URI=your_mongodb_connection_string
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
PORT=3000
```

### Running Locally

```bash
npm run dev
```

Open `http://localhost:3000`.

### Building Assets

```bash
npm run build        # Minify CSS and JavaScript
npm run assets:seal  # Regenerate the asset integrity manifest
```

---

## Testing

The project ships an extensive automated suite covering correctness, performance, SEO, and resilience.

```bash
npm test              # Full suite
npm run test:offline  # Suite excluding tests that need network access
```

Targeted runs:

```bash
npm run test:tv          # TV mode behaviour and browser tests
npm run test:tabs        # Category tab navigation (desktop + mobile)
npm run test:ranking     # Feed ranking logic
npm run test:pager       # Feed pagination
npm run test:perf        # Asset budgets and player health
npm run test:cwv         # Core Web Vitals
npm run test:seo         # SSR, sitemap, crawl depth, worker SEO
npm run test:ott         # OTT availability sections
npm run test:trailers    # Trailer language handling
npm run test:ads         # Ad gating rules
npm run test:push        # Push notification worker
npm run test:resilience  # Upstream failure handling
```

Live verification against a deployed instance:

```bash
npm run verify:deploy
npm run verify:seo
npm run verify:tv
npm run perf:tv
```

---

## SEO Maintenance

```bash
npm run sitemap:build  # Rebuild the sharded sitemap cache
npm run home:inject    # Refresh internal links on the home page
npm run seo:refresh    # Both of the above
```

A GitHub Actions workflow (`.github/workflows/seo-refresh.yml`) runs this on a schedule.

---

## Attribution

Movie and TV metadata is provided by [TMDB](https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB.

---

## Author

**Afzal Hussain** — Frontend Developer

- Portfolio: https://afzalhussain.tech
- GitHub: https://github.com/theafzalhussain
- Email: theafzalhussain786@gmail.com

---

## License
ISC License

Copyright (c) 2026 Afzal Hussain

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

