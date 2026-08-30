# MovieZone — Movie & TV Discovery Platform (PWA)

A performance-focused movie and TV discovery platform built on the TMDB API, shipped as an installable Progressive Web App with a dedicated TV interface, server-side SEO rendering, push notifications, and an automated performance and correctness test suite.

**🔗 Live Demo:** https://moviezonne.dev

---

## Overview

MovieZone lets users browse trending and upcoming titles, watch trailers, search across the TMDB catalogue, and track where content is available to stream. It runs as an installable PWA with offline support, and ships a separate remote-friendly interface for television and large-screen use.

The project treats performance and SEO as first-class requirements rather than afterthoughts — asset budgets, Core Web Vitals, and search-engine rendering are all enforced by automated checks.

---

## Features

### Discovery
- Trending, upcoming, and category-based browsing backed by the TMDB API
- Full-catalogue search with a dedicated search engine module
- Curated collections driven by a catalogue configuration file
- OTT availability sections showing where titles can be streamed
- Trailer playback with multi-language track support
- Paginated infinite feeds with ranking logic
- Horizontally scrolling carousels with responsive fitting

### TV Mode
- Separate interface optimised for large screens and remote navigation
- Directional focus management for D-pad style input
- Dedicated end-to-end and performance test suites for the TV experience

### Progressive Web App
- Installable with a web app manifest and custom install prompt
- Service worker providing offline capability and asset caching
- Web push notifications for new and upcoming releases
- Platform icon sets including Apple touch icons

### SEO
- Server-side rendering for crawler-facing routes
- Sharded sitemap generation for large catalogues
- Crawl-depth verification so no page is buried too deep
- Automated link injection on the home page to improve internal linking
- Service-worker-aware SEO handling
- Scheduled sitemap refresh through a GitHub Actions workflow

### Performance
- CSS and JavaScript minification pipeline
- Asset sealing with integrity verification and version manifests
- Performance budget enforcement against a committed baseline
- Core Web Vitals measurement in the browser
- Real user monitoring in production
- Response compression and in-process API caching

### Reliability
- Automatic retry with backoff on upstream TMDB failures
- Stale-data fallbacks when the upstream API degrades
- Server-side error tracking
- Rate limiting and hardened security headers
- Player health checks
- Deployment verification run against the live site

---

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

Available for review as part of my development portfolio.
