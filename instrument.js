// instrument.js must be loaded BEFORE any other module.
// Load .env here so SENTRY_DSN is available at init time.
require('dotenv').config();

const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN || "https://025855870f9d4bf13596871fb889c1d0@o4510951293976576.ingest.us.sentry.io/4511873489633280",
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
});
