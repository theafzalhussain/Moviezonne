
/*  MovieZone — Cloudflare Worker
 *
 *  WHY THE PUSH LAYER LIVES HERE
 *  Notify Me used to be served by server.js on Render: Express routes backed by
 *  MongoDB, with the `web-push` npm package doing the crypto. The Cloudflare
 *  migration brought over /api/push/subscribe and /api/push/unsubscribe and
 *  nothing else, so every other endpoint the browser calls fell through to the
 *  asset handler. With assets.not_found_handling set to "single-page-application"
 *  that fall-through answers 200 with index.html, which is why the failure
 *  surfaced as the opaque
 *      Notification permission or push subscription is unavailable
 *  rather than a 404: subscribeToPush() asked for /api/push/vapid-key, got the
 *  SPA shell, and returned null.
 *
 *  `web-push` cannot run here — it needs Node's crypto and its own HTTP stack —
 *  so the two things it did are implemented directly against Web Crypto:
 *    • VAPID request signing (RFC 8292): an ES256 JWT plus the public key.
 *    • Payload encryption (RFC 8291): ECDH P-256 → HKDF-SHA256 → AES128GCM,
 *      serialised in the aes128gcm content coding of RFC 8188.
 *  Both are pure Web Crypto, so they also run unchanged under Node 18+, which
 *  is what worker-push.test.js exercises.
 */

/*  ── WHY THE SSR LAYER ALSO LIVES HERE ──────────────────────────────────────
 *  server.js calls registerSeoRoutes(app, …) from seo-ssr.js, which is what
 *  renders /movies/prime-video, /movie/<id>-<slug> and their siblings on
 *  localhost. The Cloudflare migration never brought those routes over, so on
 *  moviezone.dev every one of them fell through to the asset handler and
 *  not_found_handling: "single-page-application" answered 200 with index.html:
 *  the URL stayed /movies/prime-video while the homepage rendered, and crawlers
 *  saw the homepage <title> and canonical on every category and detail URL.
 *
 *  Express is not available here, so ssrResponse() below is the same routing
 *  table expressed against Request/Response. The page renderers themselves are
 *  imported from seo-ssr.js rather than reimplemented — they are pure
 *  (data in, HTML string out), so both runtimes serve byte-identical markup and
 *  seo-ssr.test.js keeps covering them.
 */
import seo from './seo-ssr.js';

/*  Per-platform OTT charts. Imported the same way seo-ssr.js is — a CommonJS
 *  module that the bundler resolves — so one implementation serves both the
 *  Express server and this Worker and the two deployments cannot drift. */
import ottCharts from './ott-charts.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** RFC 8188 record size. One record is always enough for these payloads. */
const RECORD_SIZE = 4096;

/** How long a push service should hold an undelivered message. 4 weeks. */
const PUSH_TTL_SECONDS = 2419200;

/** VAPID JWTs must not exceed 24h of validity; 12h leaves room for clock skew. */
const VAPID_TTL_SECONDS = 43200;

/** Matches express.json({ limit: '100kb' }) from the server this replaces. */
const MAX_BODY_BYTES = 100 * 1024;

/** Ceiling on one process-due pass, mirroring the old .limit(500). */
const MAX_DUE_PER_RUN = 500;

const DEFAULT_VAPID_SUBJECT = 'mailto:admin@moviezone.dev';
const NOTIFY_ICON = '/icon-192.png?v=2';

const TE = new TextEncoder();

/*  ══════════════════════════════════════════════════════════════════════════
 *  TUNABLES
 *  ══════════════════════════════════════════════════════════════════════════
 *  Timeouts and cache lifetimes are read from env, so they can be changed from
 *  wrangler.jsonc "vars" or the dashboard without a code deploy. That matters
 *  most in exactly the situation you would want to change them: the site is
 *  timing out and you need the timeout shorter NOW, not after a build.
 *
 *  Every read goes through envInt(), which means:
 *    • a missing var falls back to the compiled-in default, so the Worker cannot
 *      be broken by forgetting to set one;
 *    • a malformed var ("5s", "", "abc") falls back too, rather than turning a
 *      timeout into NaN — which would disable it silently;
 *    • the value is clamped, so a typo of 60000 cannot reintroduce the hang this
 *      whole layer exists to prevent.
 */
function envInt(env, name, fallback, min, max) {
  const raw = env && env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// ── Small helpers ───────────────────────────────────────────────────────────

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    // These answers are per-subscriber; a shared cache must never hold them.
    'cache-control': 'no-store'
  }
});

function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/*  base64url in both directions.
 *
 *  Every key on the wire — the VAPID pair, the subscription's p256dh and auth,
 *  and the JWT segments — is base64url, and browsers hand them over unpadded.
 *  atob() requires padding, so it is added back on the way in and stripped on
 *  the way out.
 */
function b64urlToBytes(value) {
  const normalised = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/*  KV key derivation.
 *
 *  The first version of this file used the raw endpoint URL as the KV key. That
 *  works until it does not: endpoints are opaque, vendor-controlled URLs with no
 *  length guarantee, KV caps keys at 512 bytes, and a raw URL cannot carry the
 *  `sub:` / `notify:` prefixes that list() needs to walk one subscriber's rows
 *  without scanning the namespace. A truncated SHA-256 gives a fixed-width,
 *  prefix-safe id; the full endpoint is kept inside the stored record because
 *  that is what the push service must be POSTed to.
 */
async function endpointId(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', TE.encode(endpoint));
  return bytesToHex(digest).slice(0, 32);
}

const subKey = (id) => `sub:${id}`;
const notifyKey = (id, movieId) => `notify:${id}:${movieId}`;
const notifyPrefix = (id) => `notify:${id}:`;

function isCalendarDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/*  Constrains the notification's deep link to this origin.
 *
 *  sw.js resolves this with `new URL(url, self.location.origin)`, so the check
 *  cannot just be startsWith('/') — the Express version this replaces used
 *  exactly that, and "//evil.example" satisfies it while resolving to
 *  https://evil.example. A notification tap would then leave the site. Reject a
 *  second leading slash, and reject "/\" too, which some URL parsers treat the
 *  same way.
 */
function safeNotifyUrl(url) {
  if (typeof url !== 'string') return '/#upcoming';
  if (!url.startsWith('/')) return '/#upcoming';
  if (/^\/[/\\]/.test(url)) return '/#upcoming';
  return url;
}

/** Rejects oversized bodies before parsing, then parses defensively. */
async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return { error: 'Request body is too large' };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'Request body is too large' };
  if (!text) return { value: {} };
  try {
    const value = JSON.parse(text);
    return { value: value && typeof value === 'object' ? value : {} };
  } catch (e) {
    return { error: 'Invalid JSON body' };
  }
}

// ── VAPID (RFC 8292) ────────────────────────────────────────────────────────

function vapidConfigured(env) {
  return Boolean(env && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/*  Rebuilds the signing key as a JWK.
 *
 *  `npx web-push generate-vapid-keys` prints the public key as a 65-byte
 *  uncompressed P-256 point (0x04 ‖ X ‖ Y) and the private key as the bare
 *  32-byte scalar. Web Crypto will not import that pair as raw bytes, but the
 *  JWK form is just those same numbers relabelled: x and y are sliced out of the
 *  public point and d is the scalar.
 */
async function importVapidSigningKey(publicKey, privateKey) {
  const point = b64urlToBytes(publicKey);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a base64url 65-byte uncompressed P-256 point');
  }
  const scalar = b64urlToBytes(privateKey);
  if (scalar.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a base64url 32-byte P-256 scalar');
  }

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: bytesToB64url(point.slice(1, 33)),
      y: bytesToB64url(point.slice(33, 65)),
      d: bytesToB64url(scalar),
      ext: true
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/*  Builds the `Authorization: vapid t=<jwt>, k=<publicKey>` header.
 *
 *  `aud` is the push service's origin, not our own — the JWT proves to Mozilla
 *  or Google that the request came from the key the subscription was created
 *  with. Web Crypto's ECDSA output is already the raw r‖s pair JWS wants, so no
 *  DER unwrapping is needed.
 */
async function vapidAuthorization(endpoint, env) {
  const header = bytesToB64url(TE.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(TE.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + VAPID_TTL_SECONDS,
    sub: env.VAPID_EMAIL || DEFAULT_VAPID_SUBJECT
  })));

  const signingInput = `${header}.${claims}`;
  const key = await importVapidSigningKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    TE.encode(signingInput)
  );

  // The k= parameter must be the unpadded base64url form, whatever the secret
  // was pasted as.
  const publicKey = bytesToB64url(b64urlToBytes(env.VAPID_PUBLIC_KEY));
  return `vapid t=${signingInput}.${bytesToB64url(signature)}, k=${publicKey}`;
}

// ── Payload encryption (RFC 8291 / RFC 8188) ────────────────────────────────

async function hkdf(ikm, salt, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

/*  Encrypts one push payload into an aes128gcm body.
 *
 *  Sequence, straight from RFC 8291 §3.4:
 *    1. a fresh ECDH keypair per message (the "as" key) — never reused,
 *    2. ECDH against the subscription's p256dh to get the shared secret,
 *    3. HKDF with the subscription's auth secret as salt and
 *       "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public as info → the IKM,
 *    4. HKDF again, per message salt, to split out the 16-byte content key and
 *       the 12-byte nonce,
 *    5. AES-GCM over plaintext ‖ 0x02 (the single-record padding delimiter).
 *
 *  The body is then the RFC 8188 header — salt ‖ record size ‖ key length ‖
 *  as_public — followed by the ciphertext. Getting the delimiter or the header
 *  field order wrong is silent: the push service accepts the POST with 201 and
 *  the browser drops the message when it cannot decrypt, so this is the part
 *  worker-push.test.js decrypts back.
 */
async function encryptPushPayload(plaintext, p256dh, auth) {
  const uaPublicBytes = b64urlToBytes(p256dh);
  if (uaPublicBytes.length !== 65 || uaPublicBytes[0] !== 0x04) {
    throw new Error('Subscription p256dh is not an uncompressed P-256 point');
  }
  const authSecret = b64urlToBytes(auth);
  if (authSecret.length !== 16) {
    throw new Error('Subscription auth secret must be 16 bytes');
  }

  const uaPublicKey = await crypto.subtle.importKey(
    'raw', uaPublicBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPublicKey }, ephemeral.privateKey, 256
  ));

  const keyInfo = concatBytes(
    TE.encode('WebPush: info'), Uint8Array.of(0), uaPublicBytes, asPublicBytes
  );
  const ikm = await hkdf(sharedSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(
    ikm, salt, concatBytes(TE.encode('Content-Encoding: aes128gcm'), Uint8Array.of(0)), 16
  );
  const nonce = await hkdf(
    ikm, salt, concatBytes(TE.encode('Content-Encoding: nonce'), Uint8Array.of(0)), 12
  );

  const record = concatBytes(TE.encode(plaintext), Uint8Array.of(0x02));
  if (record.length + 16 > RECORD_SIZE) {
    throw new Error('Push payload does not fit in a single record');
  }

  const aesKey = await crypto.subtle.importKey('raw', contentKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, record
  ));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);

  return concatBytes(
    salt,
    recordSize,
    Uint8Array.of(asPublicBytes.length),
    asPublicBytes,
    ciphertext
  );
}

/*  Delivers one notification.
 *
 *  Never throws: a single dead endpoint must not fail the caller's request or
 *  abort a process-due sweep. 404/410 is the push service telling us the
 *  subscription is permanently gone, which is the one error worth acting on —
 *  see the callers, which drop the record.
 */
/** How long a push service gets to accept one message. */
const PUSH_TIMEOUT_MS = 8000;

async function sendPushToSubscription(subscription, payload, env) {
  if (!vapidConfigured(env)) {
    return { sent: false, expired: false, error: 'Push notifications are not configured' };
  }
  const keys = (subscription && subscription.keys) || {};
  if (!subscription || !subscription.endpoint || !keys.p256dh || !keys.auth) {
    return { sent: false, expired: false, error: 'Incomplete push subscription' };
  }

  try {
    const body = await encryptPushPayload(JSON.stringify(payload), keys.p256dh, keys.auth);
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      /*  THE LAST UNBOUNDED FETCH IN THIS FILE.
       *
       *  Without this, a push service that accepts the connection and then stalls
       *  holds the whole request open with nothing to end it. That is not a
       *  background-only concern: POST /api/notify-movies sends its confirmation
       *  push INLINE, so a user tapping "Notify Me" would sit on a spinner until
       *  the platform gave up on the Worker — a 504 the user caused by using a
       *  feature. It also meant one dead endpoint could stall a process-due sweep
       *  and every reminder queued behind it. */
      signal: AbortSignal.timeout(envInt(env, 'PUSH_TIMEOUT_MS', PUSH_TIMEOUT_MS, 1000, 20000)),
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, env),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: 'normal'
      },
      body
    });

    if (response.ok) return { sent: true, expired: false, status: response.status };
    return {
      sent: false,
      expired: response.status === 404 || response.status === 410,
      status: response.status,
      error: `Push service responded ${response.status}`
    };
  } catch (err) {
    return { sent: false, expired: false, error: err.message };
  }
}

// ── KV access ───────────────────────────────────────────────────────────────

function subsStore(env) {
  return env && env.PUSH_SUBS ? env.PUSH_SUBS : null;
}

async function readJson(store, key) {
  const raw = await store.get(key, { cacheTtl: 300 });

  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** Walks every entry under a prefix, following the list cursor. Each entry is
 *  `{ name, metadata }` - KV list() returns metadata with the key, and a list is
 *  one operation however many keys it returns, where reading each value is one
 *  metered read per key. */
async function listEntries(store, prefix, limit = Infinity) {
  const entries = [];
  let cursor;
  do {
    const page = await store.list({ prefix, cursor });
    for (const entry of page.keys) {
      entries.push(entry);
      if (entries.length >= limit) return entries;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return entries;
}

/** Walks every key under a prefix, following the list cursor. */
async function listKeys(store, prefix, limit = Infinity) {
  return (await listEntries(store, prefix, limit)).map((entry) => entry.name);
}

/*  ── A REMINDER'S SCHEDULE TRAVELS WITH ITS KEY ──
 *  The hourly cron used to read EVERY notify:* row, due or not - up to 500 metered
 *  reads an hour, 12,000 a day, to find the handful released today. The release
 *  date (and what the list endpoint shows) now rides in the key's metadata, which
 *  list() hands back for free, so a run reads only the rows that are actually due.
 *  KV caps metadata at 1024 bytes; the display fields are dropped before that is
 *  reached, and a row without them is simply read the old way. */
const NOTIFY_META_MAX_BYTES = 1000;

function notifyMeta(record) {
  const meta = { d: record.releaseDate, m: record.movieId };
  const full = Object.assign({}, meta, {
    t: String(record.title || '').slice(0, 200),
    u: record.url,
    c: record.createdAt
  });
  return TE.encode(JSON.stringify(full)).length <= NOTIFY_META_MAX_BYTES ? full : meta;
}

/** The list endpoint's view of a row, straight from its metadata when complete. */
function notifyFromMeta(meta) {
  if (!meta || !isCalendarDate(meta.d) || !Number.isInteger(meta.m)
      || typeof meta.t !== 'string' || typeof meta.u !== 'string') return null;
  return { movieId: meta.m, title: meta.t, releaseDate: meta.d, url: meta.u, createdAt: meta.c };
}

async function loadActiveSubscription(store, id) {
  const record = await readJson(store, subKey(id));
  if (!record || record.active === false) return null;
  return record;
}

/** A dead endpoint is worth nothing to us; drop it and its movie rows. */
async function dropSubscription(store, id) {
  const notifyKeys = await listKeys(store, notifyPrefix(id));
  await Promise.all([
    store.delete(subKey(id)),
    ...notifyKeys.map((key) => store.delete(key))
  ]);
}

// ── Route handlers ──────────────────────────────────────────────────────────

function handleVapidKey(env) {
  if (!env.VAPID_PUBLIC_KEY) {
    return json({ error: 'Push notifications are not configured' }, 503);
  }
  return json({ publicKey: env.VAPID_PUBLIC_KEY });
}

async function handleSubscribe(request, env) {
  const store = subsStore(env);
  if (!store) return json({ error: 'Subscription storage is unavailable' }, 503);

  const { value, error } = await readJsonBody(request);
  if (error) return json({ error }, 400);

  // The browser POSTs PushSubscription.toJSON() directly; older callers wrapped
  // it in { subscription }. Accept both.
  const subscription = value.subscription && typeof value.subscription === 'object'
    ? value.subscription
    : value;

  const keys = subscription.keys || {};
  if (!subscription.endpoint || !keys.p256dh || !keys.auth) {
    return json({ error: 'Invalid push subscription' }, 400);
  }
  if (!/^https:\/\//.test(subscription.endpoint)) {
    return json({ error: 'Invalid push subscription' }, 400);
  }

  const id = await endpointId(subscription.endpoint);
  const existing = await readJson(store, subKey(id));

  /*  No write when nothing changed.
   *
   *  The client re-POSTs its subscription on every page load, and it is right to:
   *  a browser can rotate or drop an endpoint at any time and only the server can
   *  notice. But writing unconditionally turned every single page view by every
   *  subscribed visitor into a KV write, and Cloudflare's KV free plan allows
   *  1,000 writes per day. That is exactly how this endpoint started answering
   *  500 in production: once the daily quota is spent, put() throws, and nothing
   *  here caught it. A no-op re-subscribe now costs one read and zero writes.
   */
  const unchanged = existing && existing.active === true
    && existing.endpoint === subscription.endpoint
    && existing.keys
    && existing.keys.p256dh === keys.p256dh
    && existing.keys.auth === keys.auth;
  if (unchanged) {
    return json({ success: true, endpoint: subscription.endpoint, unchanged: true });
  }

  const now = new Date().toISOString();

  /*  A storage failure is not a bad request, so it must not be a 500. 503 is what
   *  it is — the store is temporarily unable to accept the write (quota spent, or
   *  KV having a moment) — and the client already treats a non-OK response as
   *  "push is unavailable here" and carries on. The cause is logged so
   *  observability still shows it instead of it vanishing into a generic 500. */
  try {
    await store.put(subKey(id), JSON.stringify({
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime || null,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      active: true,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now
    }));
  } catch (err) {
    console.error('[push] could not store subscription:', (err && err.message) || err);
    return json({ error: 'Subscription storage is temporarily unavailable' }, 503);
  }

  return json({ success: true, endpoint: subscription.endpoint });
}

async function handleUnsubscribe(request, env) {
  const store = subsStore(env);
  if (!store) return json({ error: 'Subscription storage is unavailable' }, 503);

  const { value, error } = await readJsonBody(request);
  if (error) return json({ error }, 400);
  if (!value.endpoint) return json({ error: 'Endpoint is required' }, 400);

  await dropSubscription(store, await endpointId(value.endpoint));
  return json({ success: true });
}

async function handleNotifyMovieSave(request, env) {
  const store = subsStore(env);
  if (!store) return json({ error: 'Subscription storage is unavailable' }, 503);

  const { value, error } = await readJsonBody(request);
  if (error) return json({ error }, 400);

  const { endpoint, title, releaseDate, url, confirm = true } = value;
  const movieId = Number(value.movieId);
  if (!endpoint || !Number.isInteger(movieId) || !title || !isCalendarDate(releaseDate)) {
    return json({ error: 'endpoint, movieId, title and a valid releaseDate are required' }, 400);
  }

  const id = await endpointId(endpoint);
  const subscription = await loadActiveSubscription(store, id);
  if (!subscription) return json({ error: 'Active push subscription not found' }, 409);

  const now = new Date().toISOString();
  const existing = await readJson(store, notifyKey(id, movieId));
  const notifyUrl = safeNotifyUrl(url);
  const safeTitle = String(title).slice(0, 200);

  // ✅ Skip write if already saved — saves KV write quota
  if (existing && existing.active === true && existing.movieId === movieId
      && existing.endpoint === subscription.endpoint) {
    return json({ success: true, saved: true, confirmationSent: false, unchanged: true }, 200);
  }

  try {
    const record = {
      endpoint: subscription.endpoint,
      endpointId: id,
      movieId,
      title: safeTitle,
      releaseDate,
      url: notifyUrl,
      active: true,
      notifiedAt: null,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now
    };
    // metadata: the cron and the list endpoint read the schedule from list()
    // instead of reading every row (see notifyMeta).
    await store.put(notifyKey(id, movieId), JSON.stringify(record), { metadata: notifyMeta(record) });
  } catch (err) {
    console.error('[push] could not store movie notification:', (err && err.message) || err);
    return json({ error: 'Could not save movie notification' }, 503);
  }

  let confirmationSent = false;
  if (confirm !== false) {
    const confirmation = await sendPushToSubscription(subscription, {
      title: 'MovieZone',
      body: `Notification set for ${safeTitle.slice(0, 120)} (${releaseDate}).`,
      url: notifyUrl,
      icon: NOTIFY_ICON,
      badge: NOTIFY_ICON,
      tag: `notify-confirm-${movieId}`,
      type: 'notify-confirmation'
    }, env);
    confirmationSent = confirmation.sent;
    if (confirmation.expired) await dropSubscription(store, id);
  }

  return json({ success: true, saved: true, confirmationSent }, 201);
}


async function handleNotifyMovieRemove(request, env) {
  const store = subsStore(env);
  if (!store) return json({ error: 'Subscription storage is unavailable' }, 503);

  const { value, error } = await readJsonBody(request);
  if (error) return json({ error }, 400);

  const movieId = Number(value.movieId);
  if (!value.endpoint || !Number.isInteger(movieId)) {
    return json({ error: 'endpoint and movieId are required' }, 400);
  }

  const id = await endpointId(value.endpoint);
  const key = notifyKey(id, movieId);
  const existed = Boolean(await store.get(key, { cacheTtl: 300 }));
  if (existed) await store.delete(key);

  return json({ success: true, removed: existed });
}

async function handleNotifyMovieList(request, env) {
  const store = subsStore(env);
  if (!store) return json({ error: 'Subscription storage is unavailable' }, 503);

  const { value, error } = await readJsonBody(request);
  if (error) return json({ error }, 400);
  if (!value.endpoint) return json({ error: 'Endpoint is required' }, 400);

  const id = await endpointId(value.endpoint);
  const entries = await listEntries(store, notifyPrefix(id));
  // Rows saved since the schedule moved into metadata need no read at all.
  const records = await Promise.all(entries.map((entry) => {
    const fromMeta = notifyFromMeta(entry.metadata);
    return fromMeta ? Object.assign({ active: true }, fromMeta) : readJson(store, entry.name);
  }));

  const movies = records
    .filter((record) => record && record.active !== false)
    .map(({ movieId, title, releaseDate, url, createdAt }) =>
      ({ movieId, title, releaseDate, url, createdAt }))
    .sort((a, b) => String(a.releaseDate).localeCompare(String(b.releaseDate)));

  return json({ movies });
}

/*  Sends everything whose release date has arrived.
 *
 *  Driven by the cron trigger in wrangler.jsonc, and reachable over HTTP for a
 *  manual run. On Render this was a setInterval inside a long-lived process;
 *  a Worker has no such process, which is why the trigger exists.
 *
 *  ── WHY THIS IS NOT ONE SEQUENTIAL LOOP ANY MORE ──
 *  It used to await, per reminder: one KV read for the record, one KV read for
 *  the subscription, and one POST to the push service. At MAX_DUE_PER_RUN that is
 *  1500 round-trips end to end — and since the push POST had no timeout, a single
 *  unresponsive push service stalled every reminder queued behind it. A busy
 *  release day would simply never finish, and because the sweep dies partway the
 *  reminders it did not reach are silently carried to the next hour.
 *
 *  The records are now read in one Promise.all (they are independent), and the
 *  sends run in small fixed-size waves. Bounded rather than unbounded on purpose:
 *  firing hundreds of simultaneous POSTs at Mozilla's or Google's push service is
 *  how you get rate-limited, and Workers caps concurrent subrequests anyway.
 *  Counting is unchanged — same checked/sent/failed semantics, same drop-on-410
 *  behaviour — so this is a scheduling change, not a behavioural one.
 */
const PUSH_WAVE_SIZE = 10;

/*  Push POSTs per run. They are external subrequests, and Workers Free allows 50
 *  per invocation; whatever is still due waits for the next hourly run. */
const PUSH_SENDS_PER_RUN = 40;

/*  Rows written before the schedule moved into metadata have none, so they must
 *  be read once to learn their date - and are then rewritten WITH it, so they are
 *  never read by the cron again. Bounded, because each rewrite is one of the
 *  free plan's 1,000 daily KV writes. */
const NOTIFY_MIGRATE_PER_RUN = 25;

async function processDueNotifications(env) {
  const store = subsStore(env);
  if (!store) return { checked: 0, sent: 0, failed: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const entries = await listEntries(store, 'notify:', MAX_DUE_PER_RUN);

  /*  One list() instead of a read per row: a row whose metadata says it is not
   *  due yet costs nothing. Only due rows - and a bounded number of legacy rows
   *  with no metadata - are read. */
  const dueKeys = [];
  const legacyKeys = [];
  for (const entry of entries) {
    const date = entry.metadata && entry.metadata.d;
    if (isCalendarDate(date)) {
      if (date <= today) dueKeys.push(entry.name);
    } else if (legacyKeys.length < NOTIFY_MIGRATE_PER_RUN) {
      legacyKeys.push(entry.name);
    }
  }

  const legacy = new Set(legacyKeys);
  const records = await Promise.all(dueKeys.concat(legacyKeys)
    .map(async (key) => ({ key, record: await readJson(store, key), legacy: legacy.has(key) })));

  // Legacy rows that are not due yet get their metadata now, once.
  await Promise.all(records.map(async ({ key, record, legacy: isLegacy }) => {
    if (!isLegacy || !record || !isCalendarDate(record.releaseDate) || record.releaseDate <= today) return;
    try {
      await store.put(key, JSON.stringify(record), { metadata: notifyMeta(record) });
    } catch (err) {
      // Quota or a transient fault: the row is simply read again next run.
    }
  }));

  const due = records.filter(({ record }) =>
    record
    && record.active !== false
    && !record.notifiedAt
    && isCalendarDate(record.releaseDate)
    && record.releaseDate <= today)
    .slice(0, envInt(env, 'PUSH_SENDS_PER_RUN', PUSH_SENDS_PER_RUN, 1, 900));

  const checked = due.length;
  let sent = 0;
  let failed = 0;

  async function deliver({ key, record }) {
    const id = record.endpointId || await endpointId(record.endpoint);
    const subscription = await loadActiveSubscription(store, id);
    if (!subscription) {
      /*  The subscription is gone (unsubscribed, or dropped after a 404/410), so
       *  this reminder can never be delivered. It used to stay behind and cost
       *  two KV reads every hour, forever. */
      failed++;
      await store.delete(key).catch(() => {});
      return;
    }

    const result = await sendPushToSubscription(subscription, {
      title: 'Now available on MovieZone',
      body: `${record.title} has released. Tap to view details.`,
      url: safeNotifyUrl(record.url),
      icon: NOTIFY_ICON,
      badge: NOTIFY_ICON,
      tag: `movie-release-${record.movieId}`,
      type: 'movie-release'
    }, env);

    if (result.sent) {
      sent++;
      // ✅ Delete instead of write-back — saves a KV write
      await store.delete(key);
    } else {
      failed++;
      if (result.expired) await dropSubscription(store, id);
    }
  }

  for (let i = 0; i < due.length; i += PUSH_WAVE_SIZE) {
    await Promise.all(due.slice(i, i + PUSH_WAVE_SIZE).map(deliver));
  }

  return { checked, sent, failed };
}

/*  Guards the manual trigger.
 *
 *  Without this, anyone could drain every pending reminder early. The cron path
 *  does not go through here — scheduled() is only callable by Cloudflare.
 */
function cronAuthorised(request, env) {
  if (!env.CRON_SECRET) return true;
  const url = new URL(request.url);
  const supplied = request.headers.get('x-cron-secret')
    || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    || url.searchParams.get('secret');
  return supplied === env.CRON_SECRET;
}

/*  ── TMDB PROXY ─────────────────────────────────────────────────────────────
 *  Fetches one TMDB path, edge-cached (memory + caches.default; never KV).
 *
 *  `path` is everything after /api/tmdb, query string included, e.g.
 *  "/movie/popular?language=en-US&page=1". The cache key is deliberately the
 *  full public path — "/api/tmdb" + path — so a title fetched individually and
 *  the same title fetched inside a batch share one cache entry instead of
 *  storing the response twice.
 */
/*  ══════════════════════════════════════════════════════════════════════════
 *  NOBODY WAITS FOR TMDB TWICE
 *  ══════════════════════════════════════════════════════════════════════════
 *  A cache entry used to be a plain expiry: fresh until the TTL, then gone. So
 *  every TTL boundary handed one unlucky visitor the full upstream round-trip —
 *  ~136ms on a good day, seconds when TMDB is slow — and there was no timeout at
 *  all, so a connection that opened and then stalled held the request open
 *  indefinitely and the section it fed never resolved.
 *
 *  Three changes, all of them about who is made to wait:
 *
 *  1. STALE-WHILE-REVALIDATE. An entry is kept far longer than it is considered
 *     fresh, and its store timestamp travels beside the body (the x-mz-stored
 *     header in caches.default, the memo's `t`) so the body stays byte-identical.
 *     Past the freshness window we answer with the copy we already have and
 *     refresh behind the response via waitUntil. After the very first fill of a
 *     path in a location, no visitor there is blocked on TMDB again. Freshness is
 *     unchanged: the same 3h/7d windows decide when a refresh is triggered.
 *
 *  2. SINGLE-FLIGHT, WITHIN ONE REQUEST. A cold plan fans out 16-24 paths, and
 *     callers inside one invocation share one upstream call per path. It used to
 *     be one promise per path per ISOLATE, shared across visitors - and that is
 *     what hung the site; see IN-FLIGHT WORK IS SHARED INSIDE ONE REQUEST below.
 *
 *  3. A HARD TIMEOUT, so a stalled upstream fails in 8s instead of hanging.
 */

/** How much longer than its freshness window an entry is kept, for the SWR read. */
const TMDB_STALE_MULT = 8;

/** Hard ceiling on retention, so the 7-day paths do not sit in the cache for two months. */
const TMDB_MAX_RETENTION = 2592000;   // 30 days

/** A stalled upstream connection must fail, not hang. This is only the compiled-in
 *  fallback: wrangler.jsonc sets TMDB_TIMEOUT_MS, and envInt() clamps it. */
const TMDB_UPSTREAM_TIMEOUT_MS = 6000;

/*  ── THE SECOND ATTEMPT IS SHORTER WHEN THE FIRST ONE TIMED OUT ──
 *  A 5xx or a reset connection is worth an immediate full-length retry: TMDB
 *  answered, just badly, and a fresh connection usually lands in ~150 ms. A
 *  TIMEOUT means the upstream is slow right now, and waiting the whole budget a
 *  second time is how one slow path became a 10 s batch (2 x TMDB_TIMEOUT_MS) that
 *  landed exactly on the browser's own 10 s batch abort - the page threw the
 *  answer away and re-requested every path one by one. After a timeout the retry
 *  gets this much instead, so the worst case is 5 s + 3 s. */
const TMDB_RETRY_AFTER_TIMEOUT_MS = 3000;

/*  ══════════════════════════════════════════════════════════════════════════
 *  IN-FLIGHT WORK IS SHARED INSIDE ONE REQUEST, NEVER ACROSS REQUESTS
 *  ══════════════════════════════════════════════════════════════════════════
 *  Upstream calls used to be collapsed through MODULE-LEVEL maps: one pending
 *  promise per TMDB path (and per batch plan, OTT chart and SEO catalogue) per
 *  isolate, joined by every request that asked for the same key. On Workers that
 *  is not a cache, it is a trap. A promise belongs to the I/O context of the
 *  request that created it. When that request's client disconnects - a tab
 *  closed mid-load, a reload, the browser aborting a fetch - workerd cancels its
 *  pending I/O, AbortSignal timer included, and the promise never settles. The
 *  map entry was only deleted on settle, so it stayed, and every later request
 *  for that key in that isolate awaited it forever: no answer, no error, no
 *  timeout, until Cloudflare recycled the isolate.
 *
 *  Measured on production, 27 Sep 2026: /api/tmdb/trending/movie/day?language=
 *  en-US&page=2 (the Top 10 rail's second page) never answered from the DEL
 *  location - curl gave up at 90 s - while the same query with its parameters
 *  swapped answered in ~1 s. Every homepage load waited out the browser's 15 s
 *  per-attempt timeout on it, the rail sat on its skeleton, and Datadog RUM,
 *  which counts an in-flight fetch as "still loading", booked those views at
 *  15-21 s (the 21157 ms P50/P95). A deploy recycles the isolate, which is why
 *  each fix looked like it worked until the next abandoned cold fetch.
 *
 *  So the maps are keyed on the invocation's `ctx` now. Callers inside one
 *  request (the paths of one batch plan, one SSR page, the two catalogue reads of
 *  a sitemap index) still share one upstream call, and no request can wait on I/O
 *  another request owns. Two visitors on the same cold path at the same moment
 *  each make their own bounded fetch; the location cache absorbs every one after
 *  that. No ctx - a caller outside any request - means no sharing, the safe
 *  default.
 */
const _inFlightByRequest = new WeakMap();

/** The `kind` in-flight map private to the request that owns `ctx`, or null. */
function requestInFlight(ctx, kind) {
  if (!ctx || typeof ctx !== 'object') return null;
  let kinds = _inFlightByRequest.get(ctx);
  if (!kinds) {
    kinds = new Map();
    _inFlightByRequest.set(ctx, kinds);
  }
  let map = kinds.get(kind);
  if (!map) {
    map = new Map();
    kinds.set(kind, map);
  }
  return map;
}

/** Drops `key` from `map` once `settled` does, unless `entry` was replaced. */
function clearWhenSettled(map, key, entry, settled) {
  (settled || entry).then(() => {}, () => {}).then(() => {
    if (map.get(key) === entry) map.delete(key);
  });
}

/*  A 200 is only cacheable if the body is JSON.
 *
 *  TMDB always answers JSON, but anything in front of it can answer 200 with an
 *  HTML error page - and the batch endpoint now splices cached bodies into its
 *  response verbatim instead of parsing and re-serialising them (see batchBody).
 *  One non-JSON body in the cache would make every batch that contains it
 *  unparseable for its whole freshness window. So it is checked once, here, at
 *  the only place bytes enter the cache: a structural check on the first and last
 *  non-blank characters, which is free, instead of a JSON.parse, which costs about
 *  1 ms per 100 KB against the free plan's 10 ms CPU budget. */
function looksLikeJson(text) {
  if (typeof text !== 'string' || !text) return false;
  let start = 0;
  let end = text.length - 1;
  while (start <= end && text.charCodeAt(start) <= 32) start++;
  while (end >= start && text.charCodeAt(end) <= 32) end--;
  if (start > end) return false;
  const first = text.charCodeAt(start);
  const last = text.charCodeAt(end);
  return (first === 123 && last === 125) || (first === 91 && last === 93);   // {...} or [...]
}

async function tmdbUpstream(path, env, budget) {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${env.TMDB_TOKEN}`);
  headers.set('accept', 'application/json');

  const timeout = envInt(env, 'TMDB_TIMEOUT_MS', TMDB_UPSTREAM_TIMEOUT_MS, 1000, 20000);

  let lastError = null;
  let attemptTimeout = timeout;
  for (let attempt = 0; attempt < 2; attempt++) {
    /*  The first attempt was paid for by tmdbOnce(). A retry is a second
     *  subrequest, so inside a fan-out it is only made while it leaves every
     *  other path's reserved fetch intact (see SUBREQUEST BUDGET). */
    if (attempt > 0 && !budgetOptional(budget)) break;
    try {
      const response = await fetch(`https://api.themoviedb.org/3${path}`, {
        headers,
        signal: AbortSignal.timeout(attemptTimeout),
        cf: { cacheEverything: true, cacheTtl: 300 }
      });
      /*  One immediate retry for a 5xx, because a retry HERE costs the ~130ms
       *  TMDB takes while a retry from the browser costs a full round-trip plus
       *  its 500ms backoff. 429 is deliberately NOT retried — being told to slow
       *  down and immediately asking again is how a rate limit turns into a ban —
       *  and 4xx is an answer, not a fault. */
      if (attempt === 0 && response.status >= 500) {
        lastError = new Error('TMDB responded ' + response.status);
        // Release the connection instead of leaving an unread body behind.
        try { if (response.body) response.body.cancel().catch(() => {}); } catch (e) { /* already consumed */ }
        continue;
      }
      const text = await response.text();
      if (response.status === 200 && !looksLikeJson(text)) {
        return { status: 502, text: '{"error":"upstream returned a non-JSON body"}' };
      }
      return { status: response.status, text };
    } catch (err) {
      // Timeout or transport fault. Worth exactly one more try.
      lastError = err;
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        attemptTimeout = Math.min(timeout, TMDB_RETRY_AFTER_TIMEOUT_MS);
      }
    }
  }
  throw lastError || new Error('TMDB request abandoned');
}

/** One upstream request per path per REQUEST (see IN-FLIGHT WORK above).
 *  Only the caller that actually starts the request pays for it; a caller in
 *  the same request that joins one already in flight hands its reservation back. */
function tmdbOnce(path, env, ctx, budget) {
  const inFlight = requestInFlight(ctx, 'tmdb');
  const pending = inFlight && inFlight.get(path);
  if (pending) {
    budgetRelease(budget);
    return pending;
  }
  if (!budgetRequire(budget)) return Promise.reject(budgetError());
  const started = tmdbUpstream(path, env, budget);
  if (inFlight) {
    inFlight.set(path, started);
    // Cleared on both outcomes: a failure must not pin a rejected promise as the
    // answer for a later caller in this request.
    clearWhenSettled(inFlight, path, started);
  }
  return started;
}

/*  ══════════════════════════════════════════════════════════════════════════
 *  NO KV ON THE TMDB PATH — memory, then the location cache, then TMDB
 *  ══════════════════════════════════════════════════════════════════════════
 *  TMDB data used to be read from and written to KV (TMDB_CACHE) as a third,
 *  "global" layer. On the free plan that is the wrong tool for a cache, and the
 *  dashboards showed exactly how:
 *
 *    • READ QUOTA. KV allows 100,000 reads a day, account-wide, and EVERY get()
 *      counts - hit, miss or hot local copy alike (cacheTtl changes latency, not
 *      the count). Every edge miss, every batch part (fan-outs skipped the edge
 *      and read each path from KV), every OTT chart request, and every crawler
 *      hit on an SSR page was one or more metered reads. With ~10 human visitors
 *      a day the namespace still ran out, because crawlers and fan-outs, not
 *      people, were spending it.
 *    • WRITE QUOTA. 1,000 writes a day. Once spent, put() throws, KV stays cold,
 *      and every later read is a counted miss - the two quotas fed each other.
 *    • COLD READS. At this traffic level a KV read almost never found a warm
 *      local copy, so it was a round trip to the central store on the request
 *      path - slower than the location cache it was supposed to back up.
 *
 *  So a read now goes
 *    L1  isolate memory   microseconds, small LRU, per isolate
 *    L2  caches.default   ~1-3 ms, per location, free, unmetered, no daily quota
 *    L3  TMDB             the origin, single-flight per path per isolate
 *  and an upstream answer is written to L1 + L2. Freshness is the stored-at stamp
 *  against the path's soft TTL (3 h for "what is out now" lists, 7 days for a
 *  title's own record), so a stale copy is answered instantly and refreshed
 *  behind the response. The cost of dropping KV is that each Cloudflare location
 *  fills its own cache once per freshness window - a handful of TMDB requests per
 *  location per hour, which TMDB does not meter.
 *
 *  KV is still used, but only for data that is not a cache: push subscriptions
 *  (PUSH_SUBS) and the nightly SEO catalogue/sitemaps, both behind the edge.
 */

/** Longest body kept in isolate memory; a detail payload with credits fits. */
const TMDB_MEMO_MAX_CHARS = 262144;
/** Entries kept in isolate memory (~2-4 MB typical, 16 MB worst case). */
const TMDB_MEMO_MAX = 64;
/** A path refreshed in the background is not refreshed again for this long. */
const TMDB_REFRESH_COOLDOWN_MS = 60000;

/** Stored-at stamp on every entry this Worker puts into caches.default. */
const TMDB_STORED_HEADER = 'x-mz-stored';

/*  L2 keys are built on the public site origin. The Cache API is zone-scoped and
 *  silently drops an off-zone key (see batchCacheKey), and moviezone.dev is the
 *  zone this Worker is routed on. The path under /api/tmdb is the same one the
 *  proxy serves, so one entry answers the proxy, the batch, SSR and the hero. */
const TMDB_EDGE_ORIGIN = seo.SITE_URL;

/*  ══════════════════════════════════════════════════════════════════════════
 *  THE SUBREQUEST BUDGET — why a fan-out can use the edge cache
 *  ══════════════════════════════════════════════════════════════════════════
 *  Workers Free allows 50 subrequests per invocation, and Cache API match/put
 *  calls share that quota with fetch() (KV has a separate one). That is the only
 *  reason the fan-outs - a batch plan, an OTT chart, the sitemap live build -
 *  used to skip the per-path edge layer and read every path from KV instead.
 *
 *  A fan-out now carries a budget instead. A TMDB fetch is REQUIRED, and one is
 *  reserved for every path up front (plus the plan's own cache write). Edge
 *  lookups, edge writes and retries are OPTIONAL: they are made only while they
 *  leave every reservation intact. So a warm plan is answered from the location
 *  cache, a cold 24-path plan degrades to "TMDB only" for its last few paths
 *  instead of dying with "Too many subrequests", and nothing touches KV.
 *
 *  Budgets are per invocation and never shared across requests. A caller with no
 *  budget (a single proxy GET: at most match + fetch + put) is unlimited.
 *  SUBREQUEST_LIMIT (wrangler vars) raises the ceiling on Workers Paid.
 */
const SUBREQUEST_LIMIT_FREE = 50;
/** Kept back for anything not counted below, e.g. a redirect in a subrequest chain. */
const SUBREQUEST_HEADROOM = 5;

function subrequestBudget(env, reserved) {
  const limit = envInt(env, 'SUBREQUEST_LIMIT', SUBREQUEST_LIMIT_FREE, 10, 10000);
  return { left: limit - SUBREQUEST_HEADROOM, reserve: Math.max(0, reserved || 0) };
}

/** A call the answer depends on. Draws on the reservation made for it. */
function budgetRequire(budget) {
  if (!budget) return true;
  if (budget.left <= 0) return false;
  budget.left--;
  if (budget.reserve > 0) budget.reserve--;
  return true;
}

/** A call that only makes a later request faster. Never eats a reservation. */
function budgetOptional(budget) {
  if (!budget) return true;
  if (budget.left - 1 < budget.reserve) return false;
  budget.left--;
  return true;
}

/** A path answered without its reserved fetch hands the reservation back. */
function budgetRelease(budget) {
  if (budget && budget.reserve > 0) budget.reserve--;
}

function budgetError() {
  const err = new Error('edge subrequest budget spent for this request');
  err.name = 'SubrequestBudgetError';
  return err;
}

/** How long an entry is kept past its freshness window, for the SWR read. */
function tmdbRetention(softTtl) {
  return Math.min(softTtl * TMDB_STALE_MULT, TMDB_MAX_RETENTION);
}

/*  Per-isolate cache state, keyed on `env` for the same reason sitemapMemo is:
 *  env is one stable object per isolate in production, and keying on it means two
 *  test environments can never read each other's entries. */
const _tmdbStateByEnv = new WeakMap();

function tmdbState(env) {
  if (!env || typeof env !== 'object') return null;
  let state = _tmdbStateByEnv.get(env);
  if (!state) {
    state = {
      memo: new Map(),
      refreshedAt: new Map(),
      batchRefreshedAt: new Map(),
      ottFailedAt: new Map(),
      homeRefreshedAt: 0
    };
    _tmdbStateByEnv.set(env, state);
  }
  return state;
}

function memoGet(state, path) {
  if (!state) return null;
  const entry = state.memo.get(path);
  if (!entry) return null;
  // Re-inserted so the Map's insertion order doubles as least-recently-used.
  state.memo.delete(path);
  state.memo.set(path, entry);
  return entry;
}

function memoPut(state, path, text, storedAt) {
  if (!state || typeof text !== 'string' || text.length > TMDB_MEMO_MAX_CHARS) return;
  state.memo.delete(path);
  state.memo.set(path, { text, t: storedAt });
  while (state.memo.size > TMDB_MEMO_MAX) state.memo.delete(state.memo.keys().next().value);
}

/** Records a cooldown slot for `key`; false when one was taken too recently. */
function takeCooldown(map, key, windowMs) {
  const now = Date.now();
  if (now - (map.get(key) || 0) < windowMs) return false;
  map.set(key, now);
  if (map.size > 1024) map.delete(map.keys().next().value);
  return true;
}

/*  Hands background work to the runtime and makes sure it can never surface as an
 *  unhandled rejection: a cache write is an optimisation, and a failed one must
 *  not show up as an error in the log used to diagnose real faults. */
function waitFor(ctx, work) {
  const guarded = Promise.resolve(work).catch((err) => {
    console.log('[cache] background work failed: ' + (err && err.message));
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(guarded);
  return guarded;
}

/** `work`'s outcome, or `fallback` if it has not settled within `ms`. Timed in
 *  the CALLER's request, so it fires even when the work is stuck on I/O that
 *  belongs to nobody any more. */
function settleWithin(work, ms, fallback) {
  let timer = null;
  return Promise.race([
    work,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
  ]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

function tmdbEdgeKey(path) {
  return new Request(TMDB_EDGE_ORIGIN + '/api/tmdb' + path, { method: 'GET' });
}

/*  A location-cache read is a local lookup that answers in a few milliseconds.
 *  It is bounded anyway, because it sits in front of every TMDB path: if a read
 *  ever stopped answering, the path would stop answering with it. Past this the
 *  read is abandoned and the path is treated as a miss, whose fresh answer then
 *  rewrites the entry. */
const TMDB_EDGE_READ_TIMEOUT_MS = 1500;
const EDGE_READ_TIMED_OUT = Symbol('edge read timed out');

/** The location copy of one path as { text, t } (t = stored-at, 0 if unstamped), or null. */
async function readTmdbEdge(colo, path) {
  const hit = await colo.match(tmdbEdgeKey(path));
  if (!hit) return null;
  const text = await hit.text();
  return { text, t: Number(hit.headers.get(TMDB_STORED_HEADER)) || 0 };
}

function tmdbEdgeEntry(text, storedAt, softTtl) {
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Retention only; freshness is the stored-at stamp.
      'cache-control': 'public, s-maxage=' + tmdbRetention(softTtl),
      [TMDB_STORED_HEADER]: String(storedAt)
    }
  });
}

/** Writes an upstream answer to memory and - budget permitting - the location cache. */
function storeTmdb(path, text, softTtl, storedAt, env, ctx, budget) {
  memoPut(tmdbState(env), path, text, storedAt);
  const colo = coloCache();
  if (colo && budgetOptional(budget)) {
    waitFor(ctx, colo.put(tmdbEdgeKey(path), tmdbEdgeEntry(text, storedAt, softTtl)));
  }
}

/** Fetches a fresh copy and stores it. Resolves null on a non-200 answer. */
async function refreshTmdbNow(path, softTtl, env, ctx, budget) {
  const res = await tmdbOnce(path, env, ctx, budget);
  if (res.status !== 200) return null;
  const storedAt = Date.now();
  storeTmdb(path, res.text, softTtl, storedAt, env, ctx, budget);
  return { status: 200, text: res.text, cache: 'MISS', layer: 'origin', storedAt };
}

/*  Background refresh for a stale entry. Never throws: the stale copy has already
 *  gone out, so a failed refresh just means a later request tries again - but not
 *  sooner than TMDB_REFRESH_COOLDOWN_MS, so a burst of visitors on a stale path is
 *  one upstream request, not one each. */
function scheduleTmdbRefresh(path, softTtl, env, ctx, budget) {
  const state = tmdbState(env);
  if (state && !takeCooldown(state.refreshedAt, path, TMDB_REFRESH_COOLDOWN_MS)) {
    budgetRelease(budget);
    return;
  }
  waitFor(ctx, refreshTmdbNow(path, softTtl, env, ctx, budget).catch((err) => {
    console.log('[tmdb] background refresh failed for ' + path + ': ' + (err && err.message));
  }));
}

/**
 * One TMDB path through L1 (memory) -> L2 (caches.default) -> TMDB. No KV.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.revalidate] wait for a fresh copy instead of answering
 *        stale. Only for work that runs BEHIND a response (refreshBatch), where
 *        waiting costs the visitor nothing and a rebuilt plan must not be
 *        assembled from the same stale bodies it is replacing.
 * @param {object} [opts.budget] the invocation's subrequest budget, for fan-outs
 *        (see SUBREQUEST BUDGET). Without one, every layer is used.
 * @param {boolean} [opts.edge] false = skip L2 entirely.
 * @returns {Promise<{status:number, text:string, cache:string, layer:string, storedAt:number}>}
 *        `cache` keeps its old vocabulary (HIT / STALE / MISS); `layer` says
 *        which layer answered.
 */
async function fetchTmdbJson(path, env, ctx, opts) {
  const options = opts || {};
  const budget = options.budget || null;
  const softTtl = tmdbCacheTtl(path, env);
  const freshMs = softTtl * 1000;
  const state = tmdbState(env);
  const now = Date.now();

  let stale = null;
  const consider = (text, t, layer) => { if (!stale || t > stale.t) stale = { text, t, layer }; };

  // L1 — this isolate's memory. Free, so it is always asked first.
  const memo = memoGet(state, path);
  if (memo) {
    if (now - memo.t < freshMs) {
      budgetRelease(budget);
      return { status: 200, text: memo.text, cache: 'HIT', layer: 'memo', storedAt: memo.t };
    }
    consider(memo.text, memo.t, 'memo');
  }

  // L2 — this location's cache. Inside a fan-out the lookup is optional: it is
  // skipped when it would eat a TMDB fetch another path has reserved.
  const colo = options.edge === false ? null : coloCache();
  if (colo && budgetOptional(budget)) {
    try {
      const hit = await settleWithin(readTmdbEdge(colo, path), TMDB_EDGE_READ_TIMEOUT_MS, EDGE_READ_TIMED_OUT);
      if (hit === EDGE_READ_TIMED_OUT) {
        console.log(JSON.stringify({ message: 'tmdb edge read timed out', path, ms: TMDB_EDGE_READ_TIMEOUT_MS }));
      } else if (hit) {
        const { text, t } = hit;
        if (looksLikeJson(text)) {
          /*  An entry without a stamp predates this layer: the old generic edge
           *  put stored only non-stale proxy answers, for at most s-maxage, so it
           *  is treated as fresh. */
          if (!t || now - t < freshMs) {
            const storedAt = t || now;
            memoPut(state, path, text, storedAt);
            budgetRelease(budget);
            return { status: 200, text, cache: 'HIT', layer: 'edge', storedAt };
          }
          consider(text, t, 'edge');
        }
      }
    } catch (err) {
      // An edge lookup must never fail the request — fall through to TMDB.
      console.log('[tmdb] edge read failed for ' + path + ': ' + (err && err.message));
    }
  }

  if (stale) {
    if (options.revalidate) {
      const fresh = await refreshTmdbNow(path, softTtl, env, ctx, budget).catch(() => null);
      if (fresh) return fresh;
    } else {
      scheduleTmdbRefresh(path, softTtl, env, ctx, budget);
    }
    return { status: 200, text: stale.text, cache: 'STALE', layer: stale.layer, storedAt: stale.t };
  }

  // L3 — TMDB, collapsed to one request per path within this request.
  const res = await tmdbOnce(path, env, ctx, budget);
  const storedAt = Date.now();
  if (res.status === 200) storeTmdb(path, res.text, softTtl, storedAt, env, ctx, budget);
  return { status: res.status, text: res.text, cache: 'MISS', layer: 'origin', storedAt };
}

/*  Browser-facing freshness for a TMDB path.
 *
 *  max-age is the browser's own copy. s-maxage and stale-while-revalidate are for
 *  shared caches; stale-if-error is the outage behaviour the Express
 *  implementation had: a week-old body beats an error page. The edge copy this
 *  Worker keeps for itself is described separately, by tmdbEdgeEntry(). */
function tmdbCacheControl(path) {
  const volatile = isVolatileTmdbPath(path);
  return 'public'
    + ', max-age=' + (volatile ? 1800 : 21600)
    + ', s-maxage=' + (volatile ? 3600 : 86400)
    + ', stale-while-revalidate=' + (volatile ? 86400 : 604800)
    + ', stale-if-error=604800';
}

/*  A STALE answer is already being refreshed behind the response, so the browser
 *  is told to come back in a minute rather than pin the old body for 30. */
const TMDB_STALE_BROWSER_CACHE = 'public, max-age=60, stale-if-error=604800';

/*  ── THE PROXY ALWAYS ANSWERS ──
 *  Every upstream call below is bounded (TMDB_TIMEOUT_MS, then the shorter
 *  retry), and that was also true of the request that hung for 90 s: the bound
 *  lived inside I/O that had been cancelled along with another visitor's request
 *  (see IN-FLIGHT WORK IS SHARED INSIDE ONE REQUEST). So the handler keeps its
 *  own clock, in its own request. Whatever the layers below are doing, the
 *  browser gets an answer by this deadline - a 503 it already knows how to
 *  retry, never cached - instead of sitting out its own 15 s abort, which
 *  Datadog RUM books as page load time. The work itself carries on under
 *  waitUntil and still fills the caches if it lands. 9 s clears the default
 *  upstream worst case (5 s + 3 s) and stays under the browser's 15 s
 *  per-attempt timeout; TMDB_PROXY_DEADLINE_MS overrides it. */
const TMDB_PROXY_DEADLINE_MS = 9000;

async function handleTmdbProxy(request, env, ctx, url) {
  const path = url.pathname.replace('/api/tmdb', '') + url.search;
  const deadlineMs = envInt(env, 'TMDB_PROXY_DEADLINE_MS', TMDB_PROXY_DEADLINE_MS, 100, 14000);

  const work = fetchTmdbJson(path, env, ctx);
  // Rejections are answered below; this only keeps a late answer's cache writes alive.
  waitFor(ctx, work.catch(() => null));

  let result;
  try {
    result = await settleWithin(work, deadlineMs, null);
  } catch (err) {
    /*  Reachable now that the upstream fetch has a timeout. Answered explicitly
     *  rather than left to become a 500, and never cached, so the retry the
     *  client makes a moment later is not served this same body. */
    return json({ error: 'upstream unavailable', detail: String(err && err.message).slice(0, 120) }, 503);
  }
  if (!result) {
    console.log(JSON.stringify({ message: 'tmdb proxy deadline', path, deadlineMs }));
    return json({ error: 'upstream unavailable', detail: 'no answer within ' + deadlineMs + 'ms' }, 503);
  }

  const ok = result.status === 200;
  return new Response(result.text, {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      'x-cache': result.cache,
      'x-cache-layer': result.layer || 'origin',
      'cache-control': !ok
        ? 'no-store'
        : (result.cache === 'STALE' ? TMDB_STALE_BROWSER_CACHE : tmdbCacheControl(path))
    }
  });
}


/*  ── BATCH ──────────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 *  A cold homepage used to send 26 requests before the first card painted:
 *  loadCarousel() 10 and loadMovies('all') 16. The client gates itself to a few
 *  lanes, so those 26 became ~7 sequential rounds — and on mobile every round
 *  pays the full radio round-trip, not just the 136ms the API takes. That is
 *  where mobile P50 1.8s / P95 8.4s came from; it was never the images, which
 *  have been lazy with a proper srcset for a while.
 *
 *  Here the fan-out happens at the edge instead. The Worker sits next to TMDB
 *  and the location cache, so the 26 fetches cost one client round-trip in total.
 *
 *  It also fixes the scaling shape, which matters more than the single-visitor
 *  win. The plan is identical for every visitor on a given day — the date
 *  windows in it are derived from today's date — so the assembled response is
 *  cached under a hash of the plan. The first visitor of the window in a
 *  location pays the fan-out; everyone after them is answered by ONE location
 *  cache read (no KV, no quota). Traffic can grow without TMDB seeing more
 *  requests.
 *
 *  SECURITY: this takes a caller-supplied list of paths, so it must not become
 *  an open proxy. Paths are matched against a strict allowlist, the count is
 *  capped, and the TMDB base URL and bearer token are always applied here —
 *  never taken from input.
 */
/*  ── THE CAP, AND WHY IT IS NOT 40 ANY MORE ──
 *
 *  A batch is assembled in one invocation: runBatchPlan fans the paths out with
 *  Promise.all, parses every JSON body and re-serialises one combined answer. So
 *  the cap is really a ceiling on peak CPU and peak memory for a single request,
 *  and at 40 paths that peak was roughly 800 KB of JSON through one isolate.
 *
 *  24 rather than 20. The largest plan the client can build is the 16-path ALL
 *  feed (_mzCatPlan('all') in moviezone.js); cartoon-all is 13 and the carousel
 *  12. 20 would work today and leave four paths of headroom, which is not enough
 *  for a file whose own comments record sources being traded in and out of that
 *  plan repeatedly - the first plan to reach 21 would be silently rejected and
 *  degrade to individual requests with nothing but a console.debug to say so.
 *  24 keeps 50% headroom over the real maximum and still cuts peak batch size by
 *  40%.
 *
 *  MZ_BATCH_CHUNK in moviezone.js MUST NOT EXCEED THIS. _ottPrimeBatch slices its
 *  provider-verification waves at that constant and posts the slices in parallel,
 *  so with the two in agreement a 40-path wave becomes two parallel POSTs of 20 -
 *  same single round trip, half the peak per invocation. With the two in
 *  disagreement, every oversized wave 400s and falls back to ~20 individual
 *  requests through the 8-lane gate, which is three sequential round trips and
 *  strictly worse than before. worker-perf-check.js asserts they agree.
 */
const MAX_BATCH_PATHS = 24;
const TMDB_CACHE_TTL = 604800;  // 7 days — a title's own record rarely changes

/*  ── AUTO-UPDATE: THE TTL HAS TO KNOW WHAT IT IS CACHING ──
 *
 *  One TTL for every TMDB path was the reason a new release could take a week to
 *  reach the home page. 7 days is a sensible number for /movie/{id} — runtime,
 *  cast and overview do not change — and an actively harmful one for
 *  /trending/movie/week, /movie/now_playing and the /discover queries the hero
 *  and the feeds are assembled from. Those ARE the "what is out right now"
 *  answer, so caching them for a week freezes the site's front page for a week:
 *  a Friday release would first appear the following Friday.
 *
 *  Discovery lists therefore expire in 3 hours and everything else keeps 7 days.
 *  Cost is bounded and small: the discovery plan is shared by every visitor, so
 *  this is at most 8 fan-outs a day for the whole site, and the per-title
 *  requests — the overwhelming majority — are unchanged.
 *
 *  The batch entry moves for the same reason. It holds the assembled first screen
 *  and is keyed on the plan, so leaving it at 24h would have kept serving a
 *  day-old hero no matter how fresh the individual entries behind it were: the
 *  shortest TTL in the chain is the only one that matters, and the batch sits in
 *  front of all of them.
 */
const TMDB_VOLATILE_CACHE_TTL = 10800;   // 3 hours — release-sensitive lists
const BATCH_CACHE_TTL = 10800;           // 3 hours — matches the lists inside it

/*  /movie/top_rated is deliberately not here: it is an all-time ranking and
 *  barely moves, so it keeps the long TTL. Anchored at the start of the path so
 *  a title id can never be mistaken for a list name. */
const VOLATILE_TMDB_PATH_RE = /^\/(?:trending|discover)\/|^\/movie\/(?:popular|now_playing|upcoming)\b|^\/tv\/(?:popular|airing_today|on_the_air)\b/;

function isVolatileTmdbPath(path) {
  return VOLATILE_TMDB_PATH_RE.test(String(path || ''));
}

/** KV lifetime for one TMDB path. */
function tmdbCacheTtl(path, env) {
  /*  TWO NUMBERS, NOT ONE — ON PURPOSE.
   *
   *  A single TMDB_CACHE_TTL is the obvious config knob and the wrong one. Set it
   *  short and /movie/{id} — runtime, cast, overview, none of which change — gets
   *  re-fetched all day for nothing, which is the TMDB load you were trying to
   *  reduce. Set it long and /trending, /movie/now_playing and the /discover
   *  queries the home page is assembled from freeze, so a Friday release first
   *  appears the following Friday. Both halves are overridable, separately. */
  return isVolatileTmdbPath(path)
    ? envInt(env, 'TMDB_VOLATILE_CACHE_TTL', TMDB_VOLATILE_CACHE_TTL, 60, 604800)
    : envInt(env, 'TMDB_CACHE_TTL', TMDB_CACHE_TTL, 60, TMDB_MAX_RETENTION);
}



/*  A relative TMDB path with an optional query string, and nothing else.
 *  Rejects "http://…", "//host", "/../", backslashes and anything that could
 *  steer the request off api.themoviedb.org.
 */
const SAFE_TMDB_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._\-/]*(\?[A-Za-z0-9._~%\-=&+,|:]*)?$/;

function validBatchPath(path) {
  return typeof path === 'string'
    && path.length <= 512
    && SAFE_TMDB_PATH.test(path)
    && !path.includes('..')
    && !path.includes('//');
}

/*  Reads the request plan.
 *
 *  POST with {"paths": [...]} is what the client ships, for one reason: URL
 *  length. The 16-path ALL feed is ~1.9k of raw path text. As a JSON array
 *  through encodeURIComponent that measured 2332 characters, because every
 *  quote, comma, "?" and "&" becomes a three-character escape; base64url of the
 *  same plan measured 2520, since base64 inflates everything by a third. Both are
 *  past the 2048-character limit plenty of intermediaries still enforce, and
 *  blowing it means a 414 that tmdbBatch swallows — leaving the homepage
 *  permanently back on 26 requests with nothing in the logs. A body has no such
 *  limit, so the whole failure class disappears.
 *
 *  Losing GET costs no caching that matters here. run_worker_first sends every
 *  /api/* request to this Worker regardless of the HTTP cache, so the thing that
 *  actually makes this scale is the location-cache entry keyed on the plan hash
 *  below — and that works identically for POST. On the client side the
 *  individual endpoints are already held in memory and in a localStorage copy,
 *  which is a better cache than an HTTP-cached blob would be.
 *
 *  GET ?r=<json array> is kept so a live batch can still be inspected by hand.
 */
async function readBatchPlan(request, url) {
  if (request.method === 'POST') {
    const { value, error } = await readJsonBody(request);
    if (error) throw new Error(error);
    if (!Array.isArray(value.paths)) throw new Error('body must be {"paths": [...]}');
    return value.paths;
  }

  const raw = url.searchParams.get('r');
  if (!raw) throw new Error('r (request plan) is required');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('r must be a JSON array');
  return parsed;
}

/*  ══════════════════════════════════════════════════════════════════════════
 *  THE BATCH NO LONGER PARSES ANYTHING
 *  ══════════════════════════════════════════════════════════════════════════
 *  runBatchPlan used to JSON.parse every path's body, and the handler then
 *  JSON.stringify'd the combined { results } object. For the 16-path ALL plan
 *  that is sixteen parses of 20-50 KB each plus one ~0.5 MB serialise - all to
 *  produce a string made of the very bytes it started from. Against the free
 *  plan's 10 ms CPU budget that was most of an invocation, and it was paid on
 *  every cold plan AND every background refresh, because waitUntil work is billed
 *  to the request that started it. It is the single largest CPU cost this Worker
 *  had.
 *
 *  The bodies are already JSON - TMDB wrote them and looksLikeJson() checked them
 *  on the way into the cache - so they are now spliced into the response as they
 *  are. The client receives byte-for-byte the same document and parses it once,
 *  exactly as before.
 */

/** One path of a plan, as a raw JSON fragment. Never throws. The per-path edge
 *  layer is used within the invocation's subrequest budget (opts.budget), so a
 *  re-assemble - or a different visitor's plan over the same titles - is served
 *  from the location cache instead of TMDB. `stale` marks a body that could not
 *  be refreshed; a path the budget could not cover is reported as rejected and
 *  the client fetches just that one on its own. */
async function batchPart(path, env, ctx, opts) {
  try {
    const result = await fetchTmdbJson(path, env, ctx, opts);
    if (result.status !== 200) return { ok: false, reason: `TMDB responded ${result.status}` };
    return { ok: true, text: result.text, stale: result.cache === 'STALE', storedAt: result.storedAt };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err || 'unavailable') };
  }
}

/** `{"results":[...]}` in Promise.allSettled's shape, built by concatenation. */
function batchBody(parts) {
  let body = '{"results":[';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i) body += ',';
    body += part && part.ok
      ? '{"status":"fulfilled","value":' + part.text + '}'
      : '{"status":"rejected","reason":' + JSON.stringify(String((part && part.reason) || 'unavailable')) + '}';
  }
  return body + ']}';
}

/*  The fan-out itself, lifted out of handleTmdbBatch so the background refresh
 *  below can reuse it verbatim. One dead source must never fail the whole first
 *  screen, which is why every path is individually caught and the
 *  Promise.allSettled shape the client used to build itself is preserved exactly.
 *
 *  Returns the combined promise AND a live array that fills in as paths settle:
 *  the array is what lets handleTmdbBatch answer at its deadline with whatever
 *  has already arrived instead of waiting on the slowest path.
 */
function runBatchPlan(paths, env, ctx, opts) {
  const parts = new Array(paths.length).fill(null);
  // Share the complete cache operation only within this assemble. Sharing just
  // upstream fetches still repeats edge reads, writes and budget accounting.
  const byPath = new Map();
  const all = Promise.all(paths.map((path, i) => {
    if (!byPath.has(path)) byPath.set(path, batchPart(path, env, ctx, opts));
    return byPath.get(path).then((part) => { parts[i] = part; return part; });
  }));
  return { parts, all };
}

/** A stale plan is rebuilt at most this often per isolate. */
const BATCH_REFRESH_COOLDOWN_MS = 30000;
/** ...and after a rebuild TMDB could not complete, at most this often. */
const BATCH_RETRY_AFTER_FAIL_MS = 300000;

/*  Rebuilds a stale plan after its stale copy has already been sent, and rewrites
 *  the location's copy. It has to rewrite that copy: the location cache is what
 *  answers the next request, so refreshing anything else would leave the stale
 *  entry answering every request here until its retention window expired.
 *
 *  `budget` is the invoking request's subrequest budget - background work is
 *  billed to the invocation that started it, so it must fit in the same 50.
 */
async function refreshBatch(paths, planKey, env, ctx, planCacheKey, budget) {
  try {
    /*  revalidate: the per-path entries inside a stale plan are normally stale
     *  too - they were written by the same assemble - and without it the rebuilt
     *  plan was put together from those same stale bodies and then stored as
     *  FRESH, so a list could reach a visitor two freshness windows old. This runs
     *  behind a response that has already gone out, so waiting for TMDB here costs
     *  the visitor nothing. */
    const run = runBatchPlanOnce(planKey, paths, env, ctx, { revalidate: true, budget });
    const parts = await run.all;
    if (parts.every((p) => p && p.ok && !p.stale)) {
      await putBatchColo(planCacheKey, batchBody(parts), planStoredAt(parts), budget);
    } else {
      /*  TMDB could not refresh part of the plan. Storing it anyway would stamp
       *  the old bodies as fresh for another BATCH_CACHE_TTL (pre-outage data
       *  served as current for hours after TMDB recovers), and retrying every
       *  30 s would hammer an upstream that is already failing. The stale copy
       *  keeps being served; the next attempt waits BATCH_RETRY_AFTER_FAIL_MS. */
      const state = tmdbState(env);
      if (state) {
        state.batchRefreshedAt.set(planKey,
          Date.now() + BATCH_RETRY_AFTER_FAIL_MS - BATCH_REFRESH_COOLDOWN_MS);
      }
    }
  } catch (err) {
    console.log('[batch] background refresh failed: ' + (err && err.message));
  }
}

/** Starts a plan refresh unless this isolate started one moments ago. */
function scheduleBatchRefresh(paths, planKey, env, ctx, planCacheKey, budget) {
  const state = tmdbState(env);
  if (state && !takeCooldown(state.batchRefreshedAt, planKey, BATCH_REFRESH_COOLDOWN_MS)) return;
  ctx.waitUntil(refreshBatch(paths, planKey, env, ctx, planCacheKey, budget));
}

/*  ══════════════════════════════════════════════════════════════════════════
 *  THE LOCATION CACHE IS THE BATCH'S ONLY SHARED LAYER
 *  ══════════════════════════════════════════════════════════════════════════
 *  The batch entry IS the first screen. It used to be backed by a KV copy of the
 *  assembled plan (plus KV copies of every part), which made every colo miss a
 *  metered KV read - and plan refreshes a metered KV write - against quotas of
 *  100,000 reads and 1,000 writes a day. `caches.default` is a local read in the
 *  location that served the request, costs no quota, and at this site's traffic
 *  level was faster than KV even when KV hit.
 *
 *  The generic edge-cache layer in fetch() cannot hold it: the batch is a POST
 *  and the Cache API rejects a non-GET key. So the plan is stored under a
 *  SYNTHETIC key: the plan hash is already a content address, so
 *  `/api/tmdb/batch/<planKey>` as a GET on this same origin is a perfectly good
 *  cache key for a POST body's answer. Built on `url.origin` rather than an
 *  invented hostname on purpose — the Cache API is zone-scoped, and an off-zone
 *  key is silently unstorable, which would look exactly like a cache that never
 *  hits while still costing a put on every request.
 *
 *  Freshness is decided by the stored-at header rather than by cache expiry, so
 *  a stale copy can still be served instantly with a refresh running behind it.
 *  The cache TTL is only the RETENTION bound.
 */
const BATCH_STORED_HEADER = 'x-mz-stored';

/*  The colo cache, or null where there is no Cache API.
 *
 *  Not paranoia: worker-push.test.js runs this module under Node and calls
 *  routeApi() directly, where `caches` is simply not defined — so an unguarded
 *  `caches.default` here turns the batch endpoint into a ReferenceError in the
 *  one harness that covers it. Treating the layer as optional is also the honest
 *  model of what it is: a best-effort accelerator, never the source of truth.
 */
function coloCache() {
  return (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
}

/** The synthetic, on-zone GET key a plan's assembled answer is cached under. */
function batchCacheKey(url, planKey) {
  return new Request(url.origin + '/api/tmdb/batch/' + planKey, { method: 'GET' });
}

/** The cacheable twin of a batch response: same body, colo-storable headers. */
function batchCacheEntry(body, storedAt) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Retention only. Freshness is the stored-at header below, so this is
      // deliberately the full stale window and not BATCH_CACHE_TTL.
      'cache-control': 'public, s-maxage='
        + Math.min(BATCH_CACHE_TTL * TMDB_STALE_MULT, TMDB_MAX_RETENTION),
      [BATCH_STORED_HEADER]: String(storedAt)
    }
  });
}

/*  Stores an assembled plan in the location cache. Uses the reservation the
 *  batch made for exactly this write. Never rejects: a cache write is an
 *  optimisation, and a failed one must never surface as an unhandled rejection. */
function putBatchColo(planCacheKey, body, storedAt, budget) {
  const colo = coloCache();
  if (!colo || !planCacheKey || !budgetRequire(budget)) return Promise.resolve();
  return Promise.resolve()
    .then(() => colo.put(planCacheKey, batchCacheEntry(body, storedAt)))
    .catch((err) => { console.log('[batch] cache write failed: ' + (err && err.message)); });
}

/*  When an assembled plan counts as stored. A plan put together from a STALE
 *  part is stored as already stale, so the next request serves it instantly AND
 *  rebuilds it (revalidating that part) instead of pinning an old body as fresh
 *  for a whole BATCH_CACHE_TTL. */
function planStoredAt(parts) {
  const now = Date.now();
  // Reassembly must not renew a still-fresh part's original freshness window.
  const oldest = parts.reduce((t, part) => Math.min(t,
    part && Number.isFinite(part.storedAt) && part.storedAt > 0
      ? part.storedAt : now - BATCH_CACHE_TTL * 1000), now);
  return parts.some((part) => part && part.stale)
    ? Math.min(oldest, now - BATCH_CACHE_TTL * 1000) : oldest;
}

/*  Per-PLAN in-flight map, scoped to the request (see IN-FLIGHT WORK IS SHARED
 *  INSIDE ONE REQUEST). This one was per isolate too, so visitors arriving
 *  together on a cold plan shared one assemble - and a plan whose assemble had
 *  joined a dead per-path promise never settled, which made every later request
 *  for that plan wait out BATCH_DEADLINE_MS and answer with those paths
 *  rejected. Concurrent cold visitors now each assemble; the first plan that
 *  lands in the location cache answers everyone after it.
 */
function runBatchPlanOnce(planKey, paths, env, ctx, opts) {
  const inFlight = requestInFlight(ctx, 'batch');
  const pending = inFlight && inFlight.get(planKey);
  if (pending) return pending;
  const run = runBatchPlan(paths, env, ctx, opts);
  if (inFlight) {
    inFlight.set(planKey, run);
    // Cleared once settled, so a finished run is never the answer for a later
    // caller in this request.
    clearWhenSettled(inFlight, planKey, run, run.all);
  }
  return run;
}

/*  ── THE EDGE ANSWERS BEFORE THE BROWSER GIVES UP ──
 *  tmdbBatch in moviezone.js aborts the batch POST at MZ_BATCH_TIMEOUT_MS (10 s)
 *  and falls back to one request per path. A cold assemble waits on its slowest
 *  path, and one slow TMDB path could take that whole budget - so the Worker kept
 *  working on an answer the browser had already thrown away, and the fallback
 *  then sent every path again. Now the assemble answers at this deadline with
 *  everything that has arrived; a path still in flight is reported as rejected
 *  (the client fetches just that one), keeps running under waitUntil, and fills
 *  the caches for the next visitor. */
const BATCH_DEADLINE_MS = 7000;

async function handleTmdbBatch(request, env, ctx, url) {
  let paths;
  try {
    paths = await readBatchPlan(request, url);
  } catch (e) {
    return json({ error: 'invalid request plan: ' + e.message }, 400);
  }

  if (!Array.isArray(paths) || !paths.length) {
    return json({ error: 'r must be a non-empty array' }, 400);
  }
  if (paths.length > MAX_BATCH_PATHS) {
    return json({ error: `a batch may hold at most ${MAX_BATCH_PATHS} paths` }, 400);
  }
  const bad = paths.find((p) => !validBatchPath(p));
  if (bad !== undefined) {
    return json({ error: 'unsupported path in batch: ' + String(bad).slice(0, 120) }, 400);
  }

  // Order is part of the contract — the client indexes the response array — so
  // the key is built from the plan as given, not from a sorted copy.
  const planKey = 'batch:' + bytesToHex(
    await crypto.subtle.digest('SHA-256', TE.encode(paths.join('\n')))
  ).slice(0, 32);

  const planCacheKey = batchCacheKey(url, planKey);

  /*  One budget for this invocation. The plan lookup is required; a stale hit
   *  or a miss then reserves one TMDB fetch per path plus the plan's own write
   *  before anything optional (per-path edge lookups/writes, retries) runs. */
  const budget = subrequestBudget(env, 0);
  const reserveForAssemble = () => { budget.reserve = new Set(paths).size + 1; };
  // Include the assembled-cache lookup in the foreground work deadline.
  const deadlineAt = Date.now() + envInt(env, 'BATCH_DEADLINE_MS', BATCH_DEADLINE_MS, 100, 9000);

  const batchHeaders = (cacheState) => ({
    'content-type': 'application/json',
    'x-cache': cacheState,
    'x-batch-size': String(paths.length),
    // The assembled copy lives in the location cache under the plan hash;
    // nothing downstream of here should hold a per-visitor copy.
    'cache-control': 'no-store'
  });

  /*  LAYER 1 — the location cache. No quota, no Worker-side assemble, and it is
   *  the layer that answers the overwhelming majority of homepage loads once a
   *  location is warm. */
  const colo = coloCache();
  if (colo && budgetRequire(budget)) {
    try {
      const cached = await settleWithin(colo.match(planCacheKey),
        Math.min(TMDB_EDGE_READ_TIMEOUT_MS, Math.max(0, deadlineAt - Date.now())), null);
      if (cached) {
        const storedAt = Number(cached.headers.get(BATCH_STORED_HEADER)) || 0;
        const fresh = !storedAt || Date.now() - storedAt < BATCH_CACHE_TTL * 1000;
        if (!fresh) {
          reserveForAssemble();
          scheduleBatchRefresh(paths, planKey, env, ctx, planCacheKey, budget);
        }
        return new Response(cached.body, {
          status: 200,
          headers: batchHeaders(fresh ? 'EDGE-HIT' : 'EDGE-STALE')
        });
      }
    } catch (err) {
      // A lookup must never be able to fail the request — assemble instead.
      console.log('[batch] colo lookup failed: ' + (err && err.message));
    }
  }

  // LAYER 2 — assemble, collapsed to one run per plan per request, bounded by
  // BATCH_DEADLINE_MS. Parts come from memory, the location cache or TMDB.
  reserveForAssemble();
  const run = runBatchPlanOnce(planKey, paths, env, ctx, { budget });
  // Keeps every path alive past a deadline answer, so its cache writes still land.
  waitFor(ctx, run.all);

  let timer = null;
  // Overridable like the other tunables (and so the deadline is testable).
  const deadlineMs = Math.max(0, deadlineAt - Date.now());
  const finished = await Promise.race([
    run.all.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), deadlineMs); })
  ]);
  if (timer !== null) clearTimeout(timer);

  const parts = finished
    ? run.parts
    : run.parts.map((part) => part || { ok: false, reason: 'still loading at the edge' });
  const body = batchBody(parts);

  // Only cache a batch that actually worked. Caching a half-empty first screen
  // for 3 hours would turn one bad moment into a lasting one.
  const allOk = finished && parts.every((part) => part && part.ok);
  if (allOk) {
    waitFor(ctx, putBatchColo(planCacheKey, body, planStoredAt(parts), budget));
  } else if (!finished) {
    // The plan is stored once the slow paths land, so the NEXT visitor gets it
    // whole in one read instead of repeating this assemble.
    waitFor(ctx, run.all.then((late) => (late.every((part) => part && part.ok)
      ? putBatchColo(planCacheKey, batchBody(late), planStoredAt(late), budget)
      : null)));
  }

  return new Response(body, {
    status: 200,
    headers: Object.assign(batchHeaders('MISS'), {
      // Whether this plan was worth remembering. Surfaced because a batch that
      // keeps reporting "no" means a source is persistently failing, and the
      // symptom on the client — a slightly thin feed — is easy to miss.
      'x-batch-stored': allOk ? 'yes' : 'no'
    })
  });
}

/*  ── PER-PLATFORM OTT CHARTS  (/api/ott/charts) ─────────────────────────────
 *
 *  Parity with the Express handler in server.js, and it has to exist here or the
 *  Cloudflare deployment would answer the JSON 404 at the bottom of routeApi()
 *  for every platform click — which the client treats as "no chart", so the OTT
 *  tabs would silently keep the old global-popularity ordering on production
 *  while looking correct locally. That divergence is the whole reason this block
 *  is not optional.
 *
 *  Same two-stage shape as fetchTmdbJson: the chart is read from memory or the
 *  location cache when fresh, served stale while a refresh runs in the
 *  background, and hydrated into TMDB cards HERE rather than on the client,
 *  because 24 detail calls would eat most of the client's 30-per-10s budget on
 *  ordering alone. It used to be read from KV on EVERY request - one metered
 *  read per platform click, plus up to 24 more when a stale chart re-hydrated
 *  without any cooldown - and it is now KV-free.
 *
 *  The reasoning for JustWatch as the source — including why each platform's own
 *  site is not usable, and the proof that JustWatch's packageId IS TMDB's
 *  provider id — is at the top of ott-charts.js.
 */

/** Fresh window for a platform chart. Matches OTT_CHART_TTL_SECONDS in server.js. */
const OTT_CHART_TTL = 7200;            // 2 hours
/** How long a chart is kept past freshness, to be served stale on an outage. */
const OTT_CHART_STALE_MULT = 12;       // 24 hours of fallback
/** Chart entries returned. The chart is the grid's HEAD, not the whole grid. */
const OTT_CHART_HEAD = 24;

/*  Trimmed to the fields the card renderer, the language balancer and the anime
 *  detector actually read. A raw /movie/{id} is ~4 KB; 24 of them would be a
 *  ~100 KB response for a 24-card rail. `genres` is flattened back to
 *  `genre_ids` because that is the shape every discover result already has. */
function slimChartCard(detail, mediaType) {
  if (!detail || !detail.id) return null;
  return {
    id: detail.id,
    media_type: mediaType,
    title: detail.title || detail.name || '',
    name: detail.name || detail.title || '',
    overview: detail.overview || '',
    poster_path: detail.poster_path || null,
    backdrop_path: detail.backdrop_path || null,
    release_date: detail.release_date || '',
    first_air_date: detail.first_air_date || '',
    vote_average: detail.vote_average || 0,
    vote_count: detail.vote_count || 0,
    popularity: detail.popularity || 0,
    original_language: detail.original_language || 'en',
    genre_ids: Array.isArray(detail.genres)
      ? detail.genres.map((g) => g && g.id).filter(Boolean)
      : (detail.genre_ids || [])
  };
}

/*  Chart ids -> renderable cards, in chart order.
 *
 *  Each detail read goes through fetchTmdbJson, so it inherits the location
 *  cache, the single-flight collapse and the timeout the proxy already has, and
 *  all of them share the invocation's subrequest budget (24 detail reads plus
 *  JustWatch must fit the Free plan's 50). A title that fails to hydrate, or has
 *  no poster, is DROPPED rather than rendered blank: loadMovies filters
 *  posterless titles on the client anyway, so passing one would waste a rank. */
async function hydrateOttChart(order, env, ctx, budget) {
  const settled = await Promise.allSettled(
    order.map((entry) => fetchTmdbJson(
      '/' + entry.media_type + '/' + entry.id + '?language=en-US', env, ctx, { budget }))
  );

  const cards = [];
  settled.forEach((result, i) => {
    if (result.status !== 'fulfilled' || result.value.status !== 200) return;
    let detail;
    try {
      detail = JSON.parse(result.value.text);
    } catch (err) {
      return;
    }
    const card = slimChartCard(detail, order[i].media_type);
    if (!card || !card.poster_path) return;
    card._chartRank = cards.length + 1;
    card._chartSource = order[i].chartSource;
    cards.push(card);
  });
  return cards;
}

/** JustWatch calls one chart build makes (trending + newly), see ott-charts.js. */
const OTT_CHART_UPSTREAM_CALLS = 2;

/** Fetch + hydrate one platform chart. Throws if it would be empty. */
async function buildOttChart(platform, region, env, ctx, budget) {
  // JustWatch and the chart's own cache write are reserved before any optional
  // per-title edge lookup can spend the budget.
  if (budget) budget.reserve += OTT_CHART_UPSTREAM_CALLS + 1;
  for (let i = 0; i < OTT_CHART_UPSTREAM_CALLS; i++) budgetRequire(budget);
  const chart = await ottCharts.fetchPlatformChart(platform, { region });
  const order = ottCharts.mergeChartOrder(chart, OTT_CHART_HEAD);
  if (budget) budget.reserve += order.length;
  const items = await hydrateOttChart(order, env, ctx, budget);

  /*  Throwing on empty is deliberate: a transient JustWatch failure that
   *  hydrated to nothing must not be STORED as a successful answer, or the
   *  platform would be pinned to no chart for the whole fresh window. */
  if (!items.length) throw new Error('chart hydrated to zero cards');

  return {
    platform,
    region,
    provider: chart.provider,
    package: chart.package,
    source: 'justwatch',
    fetchedAt: chart.fetchedAt,
    counts: { trending: chart.trending.length, newly: chart.newly.length },
    items
  };
}

/** How long the location cache keeps a chart: the fresh window plus a day of fallback. */
const OTT_CHART_RETENTION = OTT_CHART_TTL * OTT_CHART_STALE_MULT;
/** A stale chart is rebuilt at most this often per isolate. */
const OTT_CHART_REFRESH_COOLDOWN_MS = 60000;
/** After a failed build, this isolate answers "no chart" for this long instead of
 *  repeating JustWatch + 24 hydrations on every click against a failing upstream. */
const OTT_CHART_FAILURE_HOLD_MS = 60000;

const ottChartMemoKey = (platform, region) => 'ott-chart:' + platform + ':' + region;

/*  Synthetic, on-zone GET key. /__mz/* is not in run_worker_first, so no public
 *  request can ever reach this Worker at that path and overwrite the entry. */
function ottChartCacheKey(platform, region) {
  return new Request(TMDB_EDGE_ORIGIN + '/__mz/ott-chart/' + encodeURIComponent(platform)
    + '/' + encodeURIComponent(region), { method: 'GET' });
}

function ottChartEntry(body, storedAt) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Retention only; freshness is the stored-at stamp, as everywhere else.
      'cache-control': 'public, s-maxage=' + OTT_CHART_RETENTION,
      [TMDB_STORED_HEADER]: String(storedAt)
    }
  });
}

function ottChartResponse(body, cacheState) {
  const fresh = cacheState !== 'STALE';
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-cache': cacheState,
      'cache-control': fresh
        ? 'public, max-age=1800, s-maxage=7200, stale-while-revalidate=86400'
        : 'public, max-age=60, must-revalidate'
    }
  });
}

/*  One build per platform/region per REQUEST (see IN-FLIGHT WORK IS SHARED INSIDE
 *  ONE REQUEST - this map was per isolate and could be poisoned the same way).
 *  The finished chart goes to memory and the location cache - never KV. */
function buildOttChartOnce(platform, region, env, ctx, budget) {
  const memoKey = ottChartMemoKey(platform, region);
  const inFlight = requestInFlight(ctx, 'ott-chart');
  const pending = inFlight && inFlight.get(memoKey);
  if (pending) return pending;
  const started = (async () => {
    const payload = await buildOttChart(platform, region, env, ctx, budget);
    const body = JSON.stringify(payload);
    const storedAt = Date.now();
    memoPut(tmdbState(env), memoKey, body, storedAt);
    const colo = coloCache();
    if (colo && budgetRequire(budget)) {
      waitFor(ctx, colo.put(ottChartCacheKey(platform, region), ottChartEntry(body, storedAt)));
    }
    return body;
  })();
  if (inFlight) {
    inFlight.set(memoKey, started);
    // Cleared on both outcomes, so a failure never becomes the pinned answer.
    clearWhenSettled(inFlight, memoKey, started);
  }
  return started;
}

/** The empty-but-valid answer: the tab keeps its provider-gated ordering. */
function ottChartUnavailable(platform, region) {
  return new Response(JSON.stringify({
    platform, region, source: 'justwatch', fetchedAt: Date.now(),
    unavailable: true, counts: { trending: 0, newly: 0 }, items: []
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-cache': 'MISS',
      'cache-control': 'public, max-age=60, must-revalidate'
    }
  });
}

async function handleOttCharts(request, env, ctx, url) {
  const platform = String(url.searchParams.get('platform') || '').trim().toLowerCase();
  const region = String(url.searchParams.get('region') || 'IN').trim().toUpperCase().slice(0, 2);

  if (!ottCharts.isKnownChartPlatform(platform)) {
    return json({ error: 'Unknown platform', platforms: ottCharts.chartPlatforms() }, 400);
  }
  if (!/^[A-Z]{2}$/.test(region)) {
    return json({ error: 'region must be a two-letter country code' }, 400);
  }

  const state = tmdbState(env);
  const memoKey = ottChartMemoKey(platform, region);
  const freshMs = OTT_CHART_TTL * 1000;
  const budget = subrequestBudget(env, 0);
  const now = Date.now();
  let stale = null;

  // L1 — this isolate's memory.
  const memo = memoGet(state, memoKey);
  if (memo) {
    if (now - memo.t < freshMs) return ottChartResponse(memo.text, 'HIT');
    stale = { text: memo.text, t: memo.t };
  }

  // L2 — this location's cache (another isolate may hold a fresher copy).
  const colo = coloCache();
  if (colo && budgetRequire(budget)) {
    try {
      const hit = await colo.match(ottChartCacheKey(platform, region));
      if (hit) {
        const text = await hit.text();
        const t = Number(hit.headers.get(TMDB_STORED_HEADER)) || 0;
        if (looksLikeJson(text) && (!stale || t > stale.t)) {
          if (t && now - t < freshMs) {
            memoPut(state, memoKey, text, t);
            return ottChartResponse(text, 'HIT');
          }
          stale = { text, t };
        }
      }
    } catch (err) {
      console.log('[ott-charts] edge read failed for ' + memoKey + ': ' + (err && err.message));
    }
  }

  if (stale) {
    // Served at once; rebuilt behind the response, at most once a minute here.
    if (!state || takeCooldown(state.refreshedAt, memoKey, OTT_CHART_REFRESH_COOLDOWN_MS)) {
      waitFor(ctx, buildOttChartOnce(platform, region, env, ctx, budget).catch((err) => {
        console.log('[ott-charts] refresh failed for ' + platform + '/' + region
          + ': ' + (err && err.message));
      }));
    }
    return ottChartResponse(stale.text, 'STALE');
  }

  if (state && now - (state.ottFailedAt.get(memoKey) || 0) < OTT_CHART_FAILURE_HOLD_MS) {
    return ottChartUnavailable(platform, region);
  }

  let body;
  try {
    body = await buildOttChartOnce(platform, region, env, ctx, budget);
  } catch (err) {
    /*  200 with an empty list, NOT a 5xx.
     *
     *  The client reads a chart as "reorder the pool if you have one", so an
     *  empty chart is a complete answer: the platform tab falls back to the
     *  provider-gated ordering it had before this endpoint existed. A 5xx would
     *  be logged as a site error when nothing is broken for the user, and would
     *  make the client retry against an upstream already known to be down. */
    console.log('[ott-charts] ' + platform + '/' + region + ' unavailable: '
      + (err && err.message));
    if (state) {
      state.ottFailedAt.set(memoKey, Date.now());
      if (state.ottFailedAt.size > 256) state.ottFailedAt.delete(state.ottFailedAt.keys().next().value);
    }
    return ottChartUnavailable(platform, region);
  }

  return ottChartResponse(body, 'MISS');
}

/*  Dispatch for /api/*.
 *
 *  Returns null when the path is not an API route so the caller can fall through
 *  to assets. Anything under /api/ that is not matched gets an explicit JSON 404
 *  instead — the SPA fallback would otherwise answer 200 with index.html, and
 *  the client would have to guess whether it was looking at data or the shell.
 */
async function routeApi(request, env, ctx, url) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/')) return null;

  // Checked before the /api/tmdb/ prefix below, or "batch" would be forwarded
  // to TMDB as if it were a resource path.
  if (pathname === '/api/tmdb/batch') {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }
    return handleTmdbBatch(request, env, ctx, url);
  }

  /*  `/api/tmdb/batch/<planKey>` is the SYNTHETIC colo cache key an assembled
   *  plan is stored under (see batchCacheKey). It is not a real endpoint, and it
   *  is answered 404 here for a specific reason rather than left to fall through:
   *
   *  the generic edge layer in fetch() stores any 200 it sees for a GET under
   *  /api/tmdb/. If this path fell through to the TMDB proxy — or worse, to the
   *  SPA fallback — a single GET to a guessed plan key could overwrite that
   *  plan's cached batch body with a TMDB error or with index.html, and the next
   *  homepage load would read HTML where it expected its first screen. A
   *  non-200 is never stored, so answering 404 makes that unreachable.
   */
  if (pathname.startsWith('/api/tmdb/batch/')) {
    return json({ error: 'Not an endpoint' }, 404);
  }

  if (pathname.startsWith('/api/tmdb/')) {
    return handleTmdbProxy(request, env, ctx, url);
  }

  /*  Per-platform OTT chart. GET-only and read-only: the platform key is matched
   *  against ott-charts.js's own table before anything is fetched, so this can
   *  never be turned into a proxy for an arbitrary upstream. */
  if (pathname === '/api/ott/charts') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return handleOttCharts(request, env, ctx, url);
  }

  const post = request.method === 'POST';

  if (pathname === '/api/push/vapid-key') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return handleVapidKey(env);
  }
  if (pathname === '/api/push/subscribe' && post) return handleSubscribe(request, env);
  if (pathname === '/api/push/unsubscribe' && post) return handleUnsubscribe(request, env);
  if (pathname === '/api/notify-movies' && post) return handleNotifyMovieSave(request, env);
  if (pathname === '/api/notify-movies/remove' && post) return handleNotifyMovieRemove(request, env);
  if (pathname === '/api/notify-movies/list' && post) return handleNotifyMovieList(request, env);

  if (pathname === '/api/notifications/process-due') {
    if (!cronAuthorised(request, env)) return json({ error: 'Forbidden' }, 403);
    try {
      return json({ success: true, ...(await processDueNotifications(env)) });
    } catch (err) {
      return json({ error: 'Could not process due notifications' }, 500);
    }
  }

  if (
    pathname === '/api/push/subscribe' || pathname === '/api/push/unsubscribe'
    || pathname === '/api/notify-movies' || pathname === '/api/notify-movies/remove'
    || pathname === '/api/notify-movies/list'
  ) {
    return json({ error: 'Method not allowed' }, 405);
  }

  return json({ error: `Unknown API endpoint: ${pathname}` }, 404);
}

/*  ── SERVER-RENDERED PAGES ──────────────────────────────────────────────────
 *  One function per route family, mirroring seo-ssr.js's Express handlers.
 *
 *  Returning null means "not mine": the caller then falls through to the asset
 *  handler, which is exactly what Express's next() did. So an unknown category
 *  slug or a malformed id still lands on the SPA instead of an SSR 404.
 */

/** Cache-Control values, kept identical to the Express handlers. */
const SSR_DETAIL_CACHE = 'public, max-age=1800, s-maxage=86400, stale-while-revalidate=604800';
const SSR_CATEGORY_CACHE = 'public, max-age=1800, s-maxage=86400, stale-while-revalidate=604800';
// Shorter than the detail page: embed hosts rotate, and a stale player frame is
// worse than a slightly slower page.
const SSR_WATCH_CACHE = 'public, max-age=300, s-maxage=900';

/** The append_to_response the detail template needs; same list as server.js. */
const SSR_DETAIL_APPEND = 'credits,similar,recommendations,videos,watch/providers';


/**
 * Adapts the edge-cached TMDB path (fetchTmdbJson) to the `tmdb(path, params)`
 * contract the seo-ssr renderers were written against, including the
 * `tmdbStatus` property their 404 handling looks for.
 */
function ssrTmdb(env, ctx, opts) {
  return async (apiPath, params) => {
    const query = new URLSearchParams(params || {}).toString();
    const result = await fetchTmdbJson(apiPath + (query ? '?' + query : ''), env, ctx, opts);
    if (result.status !== 200) {
      const err = new Error('TMDB responded ' + result.status);
      err.tmdbStatus = result.status;
      throw err;
    }
    return JSON.parse(result.text);
  };
}

/*  ── CONDITIONAL REQUESTS ───────────────────────────────────────────────────
 *  Nothing here used to emit a validator, so a returning visitor whose max-age
 *  had lapsed re-downloaded the entire document — 30-90 KB of HTML for a page
 *  that had not changed. That is the single biggest lever on p75/p95, because
 *  the tail of the distribution is returning users on slow mobile links, not
 *  first-time visitors: a 304 is ~150 bytes and needs no decompression, no
 *  parse and no re-layout of the shell.
 *
 *  A synchronous hash is required. crypto.subtle.digest is stronger but async,
 *  and ssrHtml/xmlResponse are called from a dozen plain `return` statements;
 *  turning all of them into awaits to buy collision resistance we do not need
 *  (this is a cache validator, not a signature) is the wrong trade. Two
 *  independent 32-bit accumulators plus the length give a validator whose
 *  accidental-collision odds are far below the rate at which we would notice.
 *
 *  MEASURED, so the next person does not have to guess:
 *    throughput            ~11 us per KB of body
 *    detail page  (35 KB)  ~0.39 ms   <- the overwhelming majority of SSR traffic
 *    browse index (22 KB)  ~0.25 ms
 *    browse letter (162 KB) ~1.8 ms   <- the largest, and the rarest
 *  Against a 10 ms free-tier CPU budget, and paid ONLY on a cold render: an edge
 *  cache hit returns the stored response with its stored ETag and recomputes
 *  nothing. Collision-checked over 67k adversarial inputs (same-length
 *  single-field edits, transpositions, single-char edits deep in a 90 KB body):
 *  zero collisions.
 */
function weakEtag(text) {
  const str = String(text);
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = (((h2 + c) >>> 0) * 0x85ebca6b) >>> 0;
  }
  return 'W/"' + str.length.toString(36) + '-' + h1.toString(36) + h2.toString(36) + '"';
}

/*  Answers 304 when the client already holds this exact body, else null.
 *
 *  Compares on the bare tag rather than the raw header: our validator is weak
 *  (`W/`), and Cloudflare appends `-gzip`/`-br` to entity tags on compressed
 *  responses, so a byte comparison of the header would never match and the
 *  whole mechanism would silently do nothing. */
const ETAG_SUFFIX_RE = /-(?:gzip|br|df)$/;
function bareEtag(tag) {
  return String(tag).trim().replace(/^W\//, '').replace(/^"|"$/g, '').replace(ETAG_SUFFIX_RE, '');
}

/*  Headers RFC 9110 §15.4.5 says a 304 must carry: the caching and validator
 *  set, plus the ones a client needs to reuse the stored body correctly. */
const NOT_MODIFIED_HEADERS = ['cache-control', 'content-type', 'etag', 'link', 'vary', 'x-robots-tag'];

function notModified(request, response) {
  if (!response || response.status !== 200 || request.method !== 'GET') return null;
  const etag = response.headers.get('etag');
  const inm = request.headers.get('if-none-match');
  if (!etag || !inm) return null;

  const want = bareEtag(etag);
  const candidates = inm.split(',');
  let matched = false;
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed === '*' || bareEtag(trimmed) === want) { matched = true; break; }
  }
  if (!matched) return null;

  const headers = new Headers();
  for (const name of NOT_MODIFIED_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(null, { status: 304, headers });
}

/*  Every SSR document's LCP element is a TMDB backdrop, and the connection to
 *  that host cannot start until the browser has parsed far enough into <head>
 *  to see the <link rel=preconnect>. As a response header it is available the
 *  moment the headers land — and Cloudflare Early Hints can promote it into a
 *  103 that arrives *before* the HTML does, so the TLS handshake overlaps the
 *  TMDB fetch and the render instead of queueing behind them.
 *
 *  The static-asset branch in fetch() has had this header all along; the SSR
 *  responses were the ones missing it.
 *
 *  NO `crossorigin`. The backdrops and posters are plain <img> / <link
 *  rel=preload as=image> requests - no-cors, credentialed - and a crossorigin
 *  preconnect opens a socket in the OTHER (anonymous) connection pool, which
 *  those requests can never use. With the attribute, the hint bought nothing and
 *  the LCP image still paid a full DNS+TCP+TLS setup. */
const SSR_EARLY_HINT_LINK = '<https://image.tmdb.org>; rel=preconnect';

/*  ══════════════════════════════════════════════════════════════════════════
 *  WHAT THE BROWSER IS TOLD ON AN EDGE HIT
 *  ══════════════════════════════════════════════════════════════════════════
 *  Measured on production (Sep 2026): a response answered from caches.default
 *  comes back with its max-age REWRITTEN. "/" was stored with max-age=300 and
 *  served as `public, max-age=86400, s-maxage=86400, ...`; /movies/popular was
 *  stored with max-age=1800 and served with max-age=86400. So every edge hit
 *  told the browser to keep the HTML for a DAY. After a deploy, a returning
 *  visitor kept running yesterday's document - its markup and its ?v= bundle
 *  URLs - and because the asset router ignores ?v=, any bundle that browser no
 *  longer held came back as TODAY's code under yesterday's URL: old HTML with
 *  new JS. That is the "every fix adds new errors" pattern.
 *
 *  So the policy meant for the browser travels on the stored copy in its own
 *  header (x-mz-cc) and is put back on every edge hit. Entries stored before
 *  this change carry no such header; an HTML one gets "always revalidate".
 */
const BROWSER_CC_HEADER = 'x-mz-cc';
const LEGACY_EDGE_HTML_CC = 'public, max-age=0, must-revalidate';

/** The copy that goes into caches.default: the same response plus its browser policy. */
function forEdgeStore(response) {
  const copy = new Response(response.body, response);
  copy.headers.set(BROWSER_CC_HEADER, response.headers.get('cache-control') || '');
  return copy;
}

/** An edge hit as the browser should see it: the stored policy restored. */
function fromEdgeStore(cached) {
  if (!cached) return cached;
  const stored = cached.headers.get(BROWSER_CC_HEADER);
  const isHtml = /text\/html/i.test(cached.headers.get('content-type') || '');
  const policy = stored || (isHtml ? LEGACY_EDGE_HTML_CC : '');
  if (!policy && stored === null) return cached;
  const res = new Response(cached.body, cached);
  if (policy) res.headers.set('cache-control', policy);
  res.headers.delete(BROWSER_CC_HEADER);
  return res;
}

function ssrHtml(html, cacheControl, robots) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': cacheControl,
    'etag': weakEtag(html),
    'link': SSR_EARLY_HINT_LINK
  };
  if (robots) headers['x-robots-tag'] = robots;
  return new Response(html, { status: 200, headers });
}

/** One canonical URL per title: a wrong or absent slug is redirected, not served. */
function ssrRedirect(location, cacheControl) {
  return new Response(null, {
    status: 301,
    headers: { location, 'cache-control': cacheControl }
  });
}

/** TMDB titles are `title` on movies and `name` on TV. */
function ssrTitleOf(item) {
  return String((item && (item.title || item.name)) || '').trim();
}

async function ssrCategoryPage(family, rawSlug, url, env, ctx) {
  const slug = rawSlug.toLowerCase();
  const cat = seo.CATEGORIES[slug];
  if (!cat || cat.family !== family) return null;

  let page = parseInt(url.searchParams.get('page'), 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.min(page, 25); // beyond this the data thins out and adds no SEO value

  let results = [];
  let totalPages = 1;
  try {
    const data = await ssrTmdb(env, ctx)(cat.endpoint, Object.assign(
      { language: 'en-US', page: String(page) },
      cat.params || {}
    ));
    results = ((data && data.results) || []).filter((r) => r && r.id && r.poster_path);
    totalPages = Math.max(1, Math.min(parseInt(data && data.total_pages, 10) || 1, 25));
  } catch (err) {
    // Still render: the copy, schema and internal links are the SEO payload, and
    // an empty grid beats a 500 for both users and crawlers.
    console.warn('[ssr] category ' + slug + ' failed:', err && err.message);
  }

  return ssrHtml(
    seo.renderCategoryPage(slug, cat, results, page, totalPages),
    SSR_CATEGORY_CACHE,
    'index, follow'
  );
}

async function ssrDetailPage(kind, rawSlug, env, ctx) {
  const parsed = seo.parseIdSlug(rawSlug);
  if (!parsed) return null;

  let item;
  try {
    item = await ssrTmdb(env, ctx)('/' + kind + '/' + parsed.id, {
      language: 'en-US',
      append_to_response: SSR_DETAIL_APPEND
    });
  } catch (err) {
    if (err && err.tmdbStatus === 404) return null;
    console.warn('[ssr] ' + kind + '/' + parsed.id + ' failed:', err && err.message);
    return null;
  }
  if (!item || !item.id) return null;

  const title = ssrTitleOf(item);
  if (!title) return null;

  const wantSlug = seo.slugify(title);
  if (wantSlug && parsed.slug !== wantSlug) {
    return ssrRedirect(seo.detailPath(kind, item), SSR_DETAIL_CACHE);
  }

  return ssrHtml(seo.renderDetailPage(item, kind), SSR_DETAIL_CACHE, 'index, follow');
}

async function ssrWatchPage(kind, rawSlug, url, env, ctx) {
  const parsed = seo.parseIdSlug(rawSlug);
  if (!parsed) return null;

  let item;
  try {
    item = await ssrTmdb(env, ctx)('/' + kind + '/' + parsed.id, { language: 'en-US' });
  } catch (err) {
    if (err && err.tmdbStatus === 404) return null;
    console.warn('[ssr] watch ' + kind + '/' + parsed.id + ' failed:', err && err.message);
    return null;
  }
  if (!item || !item.id) return null;

  const title = ssrTitleOf(item);
  if (!title) return null;

  const wantSlug = seo.slugify(title);
  if (wantSlug && parsed.slug !== wantSlug) {
    return ssrRedirect(
      seo.detailPath(kind, item) + '/watch' + (url.search || ''),
      SSR_DETAIL_CACHE
    );
  }

  const html = seo.renderWatchPage(item, kind, {
    source: url.searchParams.get('s'),
    season: url.searchParams.get('season'),
    episode: url.searchParams.get('episode')
  });

  // noindex at the header level too: the player page has no unique content of
  // its own and must not compete with the detail page it belongs to.
  return ssrHtml(html, SSR_WATCH_CACHE, 'noindex, follow');
}

/** One day. Long enough that a live build is rare, short enough to stay fresh. */
const SITEMAP_KV_TTL = 86400;

/*  How long a colo may serve its own copy of a sitemap/catalogue KV value.
 *
 *  These reads were passing no `cacheTtl` at all, which means the 60 s default —
 *  on values that are rewritten once a night and on routes the CDN holds for a
 *  day. An hour is what the sitemap XML read already asks for; matching it here
 *  removes ~59 out of every 60 origin KV round-trips on the browse and sitemap
 *  paths without changing how fresh the data can be in practice.
 *
 *  Deliberately NOT applied to the TMDB proxy reads: those sit behind a
 *  freshness check that a long colo TTL would mask (see the note at fetchTmdbJson). */
const SITEMAP_KV_CACHE_TTL = 3600;

/*  MUST equal SITEMAP_CHUNK_SIZE in seo-ssr.js. Sharding here and sharding
 *  there have to agree, or the two runtimes advertise different shard sets for
 *  the same catalogue. worker-seo.test.js asserts they match. */
const SITEMAP_CHUNK = 2000;

/** Pages pulled per endpoint when there is no catalogue to read. */
const SITEMAP_LIVE_PAGES = 3;

const SITEMAP_CATALOG_KV_KEY = 'sitemap:catalog';

// Same values the Express handlers set, so both runtimes cache identically.
const SITEMAP_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
const SSR_BROWSE_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

/*  Parsing a 500 KB catalogue on every sitemap and browse request is wasted CPU
 *  on a route the CDN holds for a day anyway, so a live isolate keeps the parsed
 *  list. Short-lived on purpose: an isolate can survive for hours, and a
 *  refreshed catalogue should not have to wait for one to be recycled.
 *
 *  Keyed on `env` rather than on the kind alone. env is a single stable object
 *  per isolate in production, so the effect is the same there — but it also means
 *  two different environments (which is what every test case is) can never read
 *  each other's memo. */
const SITEMAP_MEMO_MS = 300000;
const sitemapMemo = new WeakMap();

function sitemapMemoFor(env) {
  if (!env || typeof env !== 'object') return null;
  let byKind = sitemapMemo.get(env);
  if (!byKind) { byKind = new Map(); sitemapMemo.set(env, byKind); }
  return byKind;
}

function seoStore(env) {
  // A dedicated namespace if one is ever bound; otherwise the general cache.
  return (env && (env.SEO_CACHE || env.TMDB_CACHE)) || null;
}

function xmlResponse(xml, cacheControl) {
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': cacheControl || SITEMAP_CACHE,
      /*  Crawlers are the heaviest repeat consumers of these URLs and they do
       *  send If-None-Match. A 304 saves them, and us, the full shard body —
       *  sitemap-movies-N.xml is the largest document this Worker produces. */
      'etag': weakEtag(xml)
    }
  });
}

/** Reads a published asset as JSON. Returns null rather than throwing. */
async function assetJson(pathname, env) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  try {
    const res = await env.ASSETS.fetch(new Request(seo.SITE_URL + pathname));
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/*  Curated franchise ids. seo-ssr.js reads these with fs; collections-catalog.json
 *  is published (the browser loads it), so here it comes from the asset binding
 *  and the live fallback keeps the same floor of titles it has under Express. */
async function collectionsCatalogItems(kind, env) {
  const data = await assetJson('/collections-catalog.json', env);
  const universes = (data && data.universes) || {};
  const out = [];
  for (const key of Object.keys(universes)) {
    const universe = universes[key] || {};
    const list = (kind === 'tv' ? universe.tv : universe.movies) || [];
    for (const item of list) if (item && item.id) out.push(item);
  }
  return out;
}

/*  ══════════════════════════════════════════════════════════════════════════
 *  THE CATALOGUE: KV AT MOST ONCE PER LOCATION PER SIX HOURS
 *  ══════════════════════════════════════════════════════════════════════════
 *  sitemap:catalog is real data, not a cache: the nightly seo-refresh workflow
 *  uploads it and nothing in the Worker can rebuild it, so it stays in KV. But it
 *  used to be READ from KV on every sitemap and browse edge miss - up to three
 *  times per cold isolate (movie and tv in parallel, then browse) - and crawlers
 *  generate a lot of edge misses across /browse/<letter>?page=N. Every one was a
 *  metered read of a ~500 KB value.
 *
 *  Now the raw value sits in the location cache for six hours and the parsed one
 *  in isolate memory for thirty minutes, with one in-flight read per request, so
 *  KV is asked roughly four times a day per Cloudflare location that sees a
 *  crawler - a few dozen reads a day in total. A catalogue uploaded tonight
 *  reaches every location within six hours, which is well inside the sitemap's
 *  own s-maxage of a day.
 */
const SITEMAP_CATALOG_MEMO_KEY = 'sitemap:catalog';
const SITEMAP_CATALOG_MEMO_MS = 1800000;          // 30 min, parsed, per isolate
const SITEMAP_CATALOG_EDGE_RETENTION = 21600;     // 6 h, raw, per location
/** "No catalogue uploaded" is remembered this long, so a missing key is not a KV read per request. */
const SITEMAP_CATALOG_MISS_MS = SITEMAP_MEMO_MS;

/** Synthetic on-zone key for Worker-internal SEO data. /__mz/* never reaches the Worker. */
function seoEdgeKey(name) {
  return new Request(TMDB_EDGE_ORIGIN + '/__mz/seo/' + name, { method: 'GET' });
}

/** The parsed nightly catalogue ({ movie:[], tv:[], generated }), or null. Never throws.
 *  One read per REQUEST, not per isolate: a crawler that hung up mid-read used to
 *  leave a dead promise here that every later SSR page and sitemap awaited forever
 *  (see IN-FLIGHT WORK IS SHARED INSIDE ONE REQUEST). The parsed memo below is
 *  what spares KV across requests. */
function readSitemapCatalog(env, ctx) {
  const memoStore = sitemapMemoFor(env);
  const memo = memoStore && memoStore.get(SITEMAP_CATALOG_MEMO_KEY);
  if (memo && memo.expires > Date.now()) return Promise.resolve(memo.value);

  const inFlight = requestInFlight(ctx, 'seo-catalog');
  const pending = inFlight && inFlight.get(SITEMAP_CATALOG_MEMO_KEY);
  if (pending) return pending;

  const work = (async () => {
    const colo = coloCache();
    const edgeKey = seoEdgeKey('catalog');
    let raw = null;
    let fromKv = false;

    if (colo) {
      try {
        const hit = await colo.match(edgeKey);
        if (hit) raw = await hit.text();
      } catch (err) {
        console.log('[ssr] catalogue edge read failed: ' + (err && err.message));
      }
    }

    if (!raw) {
      const store = seoStore(env);
      if (store) {
        try {
          raw = await store.get(SITEMAP_CATALOG_KV_KEY, { cacheTtl: SITEMAP_KV_CACHE_TTL });
          fromKv = Boolean(raw);
        } catch (err) {
          console.warn('[ssr] sitemap catalogue unreadable:', err && err.message);
        }
      }
    }

    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn('[ssr] sitemap catalogue is not valid JSON:', err && err.message);
      }
    }
    if (parsed && typeof parsed !== 'object') parsed = null;

    if (parsed && fromKv && colo) {
      waitFor(ctx, colo.put(edgeKey, new Response(raw, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, s-maxage=' + SITEMAP_CATALOG_EDGE_RETENTION
        }
      })));
    }

    if (memoStore) {
      memoStore.set(SITEMAP_CATALOG_MEMO_KEY, {
        expires: Date.now() + (parsed ? SITEMAP_CATALOG_MEMO_MS : SITEMAP_CATALOG_MISS_MS),
        value: parsed
      });
    }
    return parsed;
  })();

  if (inFlight) {
    inFlight.set(SITEMAP_CATALOG_MEMO_KEY, work);
    clearWhenSettled(inFlight, SITEMAP_CATALOG_MEMO_KEY, work);
  }
  return work;
}

/** TMDB paths collectSitemapItems() in seo-ssr.js fetches per kind, per page. */
const SITEMAP_LIVE_ENDPOINTS = { movie: 4, tv: 3 };

/**
 * The catalogue for one kind, with the date to stamp the sitemap index with.
 *
 * @param {object} [budget] a subrequest budget shared with sibling calls in the
 *        same invocation (the index builds movie and tv side by side).
 * @returns {Promise<{items: object[], generated: string, source: string}>}
 */
async function getSitemapItems(kind, env, ctx, budget) {
  const wanted = kind === 'tv' ? 'tv' : 'movie';
  const memoStore = sitemapMemoFor(env);
  const memo = memoStore && memoStore.get(wanted);
  if (memo && memo.expires > Date.now()) return memo.value;

  let result = null;

  // 1. the full nightly catalogue, if it has been uploaded
  const parsed = await readSitemapCatalog(env, ctx);
  const catalogItems = parsed && Array.isArray(parsed[wanted]) ? parsed[wanted] : null;
  if (catalogItems && catalogItems.length) {
    const generated = String((parsed && parsed.generated) || '').slice(0, 10);
    result = {
      items: catalogItems,
      generated: /^\d{4}-\d{2}-\d{2}$/.test(generated) ? generated : seo.SITEMAP_FALLBACK_DATE,
      source: 'kv-catalog'
    };
  }

  // 2. a previous live build, kept in this location's cache (never KV)
  const colo = coloCache();
  const liveKey = seoEdgeKey('items-' + wanted);
  if (!result && colo) {
    try {
      const hit = await colo.match(liveKey);
      const items = hit ? JSON.parse(await hit.text()) : null;
      if (Array.isArray(items) && items.length) {
        result = { items, generated: seo.SITEMAP_FALLBACK_DATE, source: 'edge-live' };
      }
    } catch (err) {
      console.warn('[ssr] sitemap live cache unreadable:', err && err.message);
    }
  }

  // 3. build one now, bounded, and keep it for a day
  if (!result) {
    const liveBudget = budget || subrequestBudget(env, 0);
    liveBudget.reserve += SITEMAP_LIVE_PAGES * SITEMAP_LIVE_ENDPOINTS[wanted];
    let items = [];
    try {
      items = await seo.collectSitemapItems(ssrTmdb(env, ctx, { budget: liveBudget }), wanted, SITEMAP_LIVE_PAGES);
    } catch (err) {
      console.warn('[ssr] sitemap ' + wanted + ' live build failed:', err && err.message);
    }

    // collectSitemapItems() reaches for the franchise catalogue with fs and gets
    // nothing here, so it is merged in explicitly. De-duped by id: the popular
    // and trending feeds already carry most of these.
    const seen = new Set(items.map((item) => String(item && item.id)));
    for (const item of await collectionsCatalogItems(wanted, env)) {
      if (!seen.has(String(item.id))) { seen.add(String(item.id)); items.push(item); }
    }

    result = { items, generated: seo.SITEMAP_FALLBACK_DATE, source: 'live' };

    if (colo && items.length && budgetOptional(liveBudget)) {
      waitFor(ctx, colo.put(liveKey, new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=' + SITEMAP_KV_TTL }
      })));
    }
  }

  if (memoStore) {
    memoStore.set(wanted, { expires: Date.now() + SITEMAP_MEMO_MS, value: result });
  }
  return result;
}

/**
 * The shard paths for a catalogue of `count` titles.
 *
 * Mirrors sitemapChunkPaths() in seo-ssr.js, including the part that matters
 * most: shard 1 keeps the original /sitemap-movies.xml name, because that URL is
 * already submitted in Search Console.
 */
function sitemapShardPaths(kind, count) {
  const plural = kind === 'tv' ? 'tv' : 'movies';
  const first = '/sitemap-' + plural + '.xml';
  if (!count) return [first];
  const shards = Math.ceil(count / SITEMAP_CHUNK);
  const out = [first];
  for (let i = 2; i <= shards; i++) out.push('/sitemap-' + plural + '-' + i + '.xml');
  return out;
}

/*  The sitemap index, built from the counts this Worker will actually serve.
 *
 *  seo.buildSitemapIndex() is not used: it calls readSitemapCache(), which is an
 *  fs read that always fails here, so it would advertise one shard per kind
 *  while /sitemap-movies-2.xml and -3.xml sit unlisted — 4,000 of the 4,593
 *  movie URLs never submitted.
 */
async function buildSitemapIndexXml(env, ctx) {
  // One budget: both kinds may fall back to a live build in this invocation.
  const budget = subrequestBudget(env, 0);
  const [movie, tv] = await Promise.all([
    getSitemapItems('movie', env, ctx, budget),
    getSitemapItems('tv', env, ctx, budget)
  ]);

  const lastmod = movie.generated || tv.generated || seo.SITEMAP_FALLBACK_DATE;
  const children = ['/sitemap-static.xml', '/sitemap-browse.xml']
    .concat(sitemapShardPaths('movie', movie.items.length))
    .concat(sitemapShardPaths('tv', tv.items.length));

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + children.map((child) => '<sitemap><loc>' + seo.escXml(seo.SITE_URL + child) + '</loc>'
      + '<lastmod>' + seo.escXml(lastmod) + '</lastmod></sitemap>').join('\n')
    + '\n</sitemapindex>\n';
}

/**
 * One media shard. `chunkStr` is the "2" in /sitemap-movies-2.xml, or undefined.
 */
/*  ── THE ONE PLACE WHERE CACHING RENDERED OUTPUT PAYS FOR ITSELF ────────────
 *  Measured on a laptop core (so pessimistic against an edge box):
 *
 *      renderDetailPage .................  0.58 ms
 *      renderCategoryPage ...............  0.65 ms
 *      buildMediaSitemap, one shard ..... 26.16 ms   <-- 2000 URLs of XML
 *      JSON.parse(catalogue, 506 KB) ....  6.16 ms
 *
 *  A free-plan Worker gets 10ms of CPU per invocation and is killed with Error
 *  1102 past it. So the HTML renderers have 15-100x of headroom and caching their
 *  output would buy nothing, while a cold sitemap shard is ~32ms — over budget on
 *  its own, and by far the heaviest thing this Worker does.
 *
 *  Caching THIS in KV is cheap in exactly the way caching detail pages is not.
 *  There are 5003 movies + 3259 series, which is 3 movie shards + 2 TV shards —
 *  about 8 sitemap URLs in total against 8262 detail URLs. So this costs ~8 KV
 *  writes a day, against a free-plan allowance of 1000, while per-page HTML
 *  caching would need ~8262 per refresh cycle and would take the TMDB cache down
 *  with it when the quota ran out.
 *
 *  Keyed on the shard AND the catalogue's generated stamp, so a rebuilt catalogue
 *  invalidates every shard by simply not matching any more — no purge step to
 *  forget, and no chance of serving a shard that disagrees with the index.
 */
const SITEMAP_XML_KV_TTL = 86400;

async function serveMediaSitemap(kind, chunkStr, env, ctx) {
  const { items, generated } = await getSitemapItems(kind, env, ctx);

  /*  No catalogue and no live data. 503 rather than an empty <urlset>: sitemap.xsd
   *  requires at least one <url>, so an empty file is invalid XML and reported as
   *  a worse error than a fetch failure — that exact substitution was tried and
   *  reverted on the Express side. Returning null is not an option either; the
   *  SPA fallback would answer 200 with index.html for a .xml URL. */
  if (!items.length) {
    return new Response(null, {
      status: 503,
      headers: { 'retry-after': '3600', 'cache-control': 'no-store' }
    });
  }

  const shards = Math.max(1, Math.ceil(items.length / SITEMAP_CHUNK));
  const index = chunkStr === undefined || chunkStr === null || chunkStr === ''
    ? 1
    : parseInt(chunkStr, 10);

  // 404 is how a shard is retired, and the only URLs that reach it are ones the
  // index never advertised.
  if (!Number.isFinite(index) || index < 1 || index > shards) {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  const store = seoStore(env);
  const xmlKey = 'sitemap:xml:' + kind + ':' + index + ':' + shards + ':' + (generated || 'live');
  if (store) {
    try {
      const cachedXml = await store.get(xmlKey, { type: 'text', cacheTtl: 3600 });
      if (cachedXml) return xmlResponse(cachedXml);
    } catch (err) {
      // A KV read failure must not lose the sitemap — fall through and build it.
      console.log('[sitemap] xml cache read failed: ' + (err && err.message));
    }
  }

  const slice = shards > 1
    ? items.slice((index - 1) * SITEMAP_CHUNK, index * SITEMAP_CHUNK)
    : items;

  const xml = seo.buildMediaSitemap(slice, kind);

  // waitUntil, so the crawler is never made to wait on the write that only helps
  // the NEXT request. Guarded: a spent write quota must not surface as an
  // unhandled rejection in the logs used to diagnose real faults.
  if (store) waitFor(ctx, store.put(xmlKey, xml, { expirationTtl: SITEMAP_XML_KV_TTL }));

  return xmlResponse(xml);
}

/** Every catalogue entry, tagged with the kind its detail URL needs. */
async function browseEntries(env, ctx) {
  // Same memo / location cache / single KV read as the sitemaps (readSitemapCatalog).
  const parsed = await readSitemapCatalog(env, ctx);
  if (parsed) {
    const movies = Array.isArray(parsed.movie) ? parsed.movie : [];
    const tv = Array.isArray(parsed.tv) ? parsed.tv : [];
    return movies.map((m) => Object.assign({ media_type: 'movie' }, m))
      .concat(tv.map((t) => Object.assign({ media_type: 'tv' }, t)));
  }
  const budget = subrequestBudget(env, 0);
  const [movie, tv] = await Promise.all([
    getSitemapItems('movie', env, ctx, budget),
    getSitemapItems('tv', env, ctx, budget)
  ]);
  return movie.items.map((m) => Object.assign({ media_type: 'movie' }, m))
    .concat(tv.items.map((t) => Object.assign({ media_type: 'tv' }, t)));
}

/*  ── BROWSE INDEX ───────────────────────────────────────────────────────────
 *  /browse and /browse/<letter> used to redo the entire pipeline on every single
 *  request: a ~500 KB catalogue read, a ~6 ms JSON.parse, ~8000 Object.assign
 *  allocations to tag media_type, an O(n) letter tally for the hub, and — per
 *  letter — a full-catalogue filter plus a localeCompare sort.
 *
 *  getSitemapItems has had an isolate memo for precisely this reason since it was
 *  written, but browseEntries reached straight past it, so the browse routes were
 *  the only pages paying that cost raw. Against a 10 ms CPU budget the parse
 *  alone was well over half of it.
 *
 *  Bucketing by letter once and memoising the result turns every later request in
 *  the isolate into a Map lookup plus one Array.slice. The localeCompare sort is
 *  the expensive half, and it is now amortised across the memo window instead of
 *  being repeated for each visitor.
 */
const BROWSE_MEMO_KEY = 'browse:index';

/*  One collator for the whole sort. `a.localeCompare(b, 'en')` resolves a locale
 *  and builds collation state on EVERY comparison; an ~8,000-title catalogue sorts
 *  in ~100k comparisons, which made this the most CPU-hungry cold path the Worker
 *  had after the sitemap XML. Intl.Collator('en').compare produces the identical
 *  order - it is what localeCompare uses underneath - with the setup paid once. */
const BROWSE_COLLATOR = (typeof Intl !== 'undefined' && Intl.Collator)
  ? new Intl.Collator('en')
  : null;

function browseIndexFrom(entries) {
  const counts = {};
  const byLetter = new Map();
  for (const entry of entries) {
    const letter = seo.browseLetterOf(ssrTitleOf(entry));
    counts[letter] = (counts[letter] || 0) + 1;
    let bucket = byLetter.get(letter);
    if (!bucket) { bucket = []; byLetter.set(letter, bucket); }
    bucket.push(entry);
  }
  /*  Sorted here, once per memo window, rather than inside serveBrowseLetter
   *  once per request. Same comparator and same locale, so the published page
   *  order is unchanged. Titles are read once per entry, not once per compare. */
  const compare = BROWSE_COLLATOR
    ? BROWSE_COLLATOR.compare
    : (a, b) => a.localeCompare(b, 'en');
  for (const [letter, bucket] of byLetter) {
    const keyed = bucket.map((entry) => [ssrTitleOf(entry), entry]);
    keyed.sort((a, b) => compare(a[0], b[0]));
    byLetter.set(letter, keyed.map((pair) => pair[1]));
  }
  return { total: entries.length, counts, byLetter };
}

async function browseIndex(env, ctx) {
  const memoStore = sitemapMemoFor(env);
  const memo = memoStore && memoStore.get(BROWSE_MEMO_KEY);
  if (memo && memo.expires > Date.now()) return memo.value;

  const value = browseIndexFrom(await browseEntries(env, ctx));

  // An empty catalogue is deliberately NOT memoised: that is the transient
  // "nothing uploaded yet" state, and pinning it would keep /browse falling
  // through to the SPA for the whole window after the catalogue lands.
  if (memoStore && value.total) {
    memoStore.set(BROWSE_MEMO_KEY, { expires: Date.now() + SITEMAP_MEMO_MS, value });
  }
  return value;
}
function browseHtml(html) {
  return ssrHtml(html, SSR_BROWSE_CACHE, 'index, follow');
}

async function serveBrowseIndex(env, ctx) {
  const { total, counts } = await browseIndex(env, ctx);
  // Express answered next() here; the equivalent is falling through to the SPA
  // rather than publishing an A-Z hub with no letters behind it.
  if (!total) return null;

  return browseHtml(seo.renderBrowseIndexPage(counts));
}

async function serveBrowseLetter(letter, url, env, ctx) {
  if (seo.BROWSE_LETTERS.indexOf(letter) === -1) return null;

  const { total, byLetter } = await browseIndex(env, ctx);
  if (!total) return null;

  // Already filtered and sorted by browseIndexFrom().
  const entries = byLetter.get(letter) || [];

  const perPage = seo.BROWSE_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(entries.length / perPage));

  let page = parseInt(url.searchParams.get('page'), 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  // One URL per page that exists: ?page=99 must not become a thin duplicate.
  if (page > totalPages) return ssrRedirect('/browse/' + letter, SSR_BROWSE_CACHE);

  const slice = entries.slice((page - 1) * perPage, page * perPage);
  return browseHtml(seo.renderBrowseLetterPage(letter, slice, page, totalPages));
}

/**
 * The SSR routing table. Runs after /api/* and before the asset handler.
 *
 * @returns {Promise<Response|null>} null when no SSR route claims the URL
 */
async function ssrResponse(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  // Express matched /movies/action and /movies/action/ identically; keep that.
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname === '/' || pathname === '') return null;

  // Bare family URLs are useful entry points; send them to the best default.
  if (pathname === '/movies') return ssrRedirect('/movies/popular', SSR_CATEGORY_CACHE);
  if (pathname === '/series') return ssrRedirect('/series/web-series', SSR_CATEGORY_CACHE);

  /*  Sitemaps. Matched before the page routes because they are exact paths and
   *  cheap to rule out, and because /sitemap.xml also exists as a stale static
   *  file in the repo root — whichever answer this Worker gives has to win. */
  if (pathname === '/sitemap.xml') {
    return xmlResponse(await buildSitemapIndexXml(env, ctx));
  }
  if (pathname === '/sitemap-static.xml') return xmlResponse(seo.buildStaticSitemap());
  if (pathname === '/sitemap-browse.xml') return xmlResponse(seo.buildBrowseSitemap());

  // /sitemap-movies.xml, /sitemap-tv.xml and their numbered shards.
  const mediaSitemap = /^\/sitemap-(movies|tv)(?:-(\d+))?\.xml$/.exec(pathname);
  if (mediaSitemap) {
    return serveMediaSitemap(
      mediaSitemap[1] === 'tv' ? 'tv' : 'movie', mediaSitemap[2], env, ctx
    );
  }

  // A-Z browse hubs.
  if (pathname === '/browse') return serveBrowseIndex(env, ctx);
  const browseLetter = /^\/browse\/([^/]+)$/.exec(pathname);
  if (browseLetter) {
    return serveBrowseLetter(
      decodeURIComponent(browseLetter[1]).toLowerCase(), url, env, ctx
    );
  }

  const category = /^\/(movies|series)\/([^/]+)$/.exec(pathname);
  if (category) {
    return ssrCategoryPage(category[1], decodeURIComponent(category[2]), url, env, ctx);
  }

  const watch = /^\/(movie|tv)\/([^/]+)\/watch$/.exec(pathname);
  if (watch) {
    return ssrWatchPage(watch[1], decodeURIComponent(watch[2]), url, env, ctx);
  }

  const detail = /^\/(movie|tv)\/([^/]+)$/.exec(pathname);
  if (detail) {
    return ssrDetailPage(detail[1], decodeURIComponent(detail[2]), env, ctx);
  }

  return null;
}

// ── Worker entry points ─────────────────────────────────────────────────────

/*  ══════════════════════════════════════════════════════════════════════════
 *  ONE CACHE ENTRY PER PAGE, NOT ONE PER CAMPAIGN LINK
 *  ══════════════════════════════════════════════════════════════════════════
 *  caches.default keys on the full URL, so
 *
 *      /movie/680-pulp-fiction
 *      /movie/680-pulp-fiction?utm_source=google&utm_medium=cpc
 *      /movie/680-pulp-fiction?fbclid=IwAR...
 *
 *  were three separate entries for one identical response. Every ad click, every
 *  Facebook or Instagram referral and every WhatsApp forward arrived with its own
 *  tracking tail and therefore its own MISS — and since those are exactly the
 *  links that bring first-time visitors, the traffic least likely to be warm was
 *  guaranteed to be cold. Dropping the tracking tail collapses them onto one.
 *
 *  ── WHY THIS IS A DENYLIST AND NOT `search = ''` ──
 *  Blanket-stripping the query string is the obvious version and it breaks two
 *  things, both silently:
 *
 *    • page — ssrCategoryPage reads it (worker.js: `url.searchParams.get('page')`).
 *      /movies/action?page=2 would be answered with page 1's cached HTML, and
 *      every paginated category URL in the sitemap would serve the same document.
 *    • v — the asset seal. /moviezone.min.js?v=13.1 and ?v=13.0 are DIFFERENT
 *      bytes by construction, which is the entire point of asset-seal.js. Collapse
 *      them and the first version cached wins for a month under `immutable`, so a
 *      deploy ships new HTML pointing at a stale bundle.
 *
 *  Also `r` (the batch plan) and `secret` (the cron guard) carry meaning. So an
 *  unknown parameter is assumed to matter and is kept; only names known to be
 *  pure attribution are removed.
 */
const CACHE_NOISE_PARAM = /^(?:utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|ttclid|twclid|igshid|igsh|mc_eid|mc_cid|_ga|_gl|ref_src|ref_url|si|at_medium|at_campaign|campaign_id|ad_id|adset_id)$/i;

function edgeCacheKey(request, url) {
  //  Under /api/ the query string IS the upstream path — /movie/popular?page=2 is
  //  a different resource, not the same one with a label on it.
  if (url.pathname.startsWith('/api/')) return request;
  if (!url.search) return request;

  const clean = new URL(url);          // a copy: the redirect in ssrWatchPage
  let dropped = false;                 // still needs the caller's original search
  for (const name of [...clean.searchParams.keys()]) {
    if (CACHE_NOISE_PARAM.test(name)) {
      clean.searchParams.delete(name);
      dropped = true;
    }
  }
  if (!dropped) return request;

  //  Built explicitly rather than `new Request(clean, request)`: only the method
  //  and headers are wanted, and this is only ever reached for GET.
  return new Request(clean.toString(), { method: request.method, headers: request.headers });
}

/*  ══════════════════════════════════════════════════════════════════════════
 *  HOMEPAGE HERO PRELOAD — RESOLVED AT THE EDGE, NOT PINNED IN THE FILE
 *  ══════════════════════════════════════════════════════════════════════════
 *  index.html ships a hard-coded hero preload, written into the delimited
 *  MZ_PERF_HEAD block by heroPreloadTag() in seo-ssr.js and refreshed by the
 *  nightly seo-refresh workflow. Two separate things make that insufficient, and
 *  both were verified rather than assumed:
 *
 *    1. THE WORKFLOW HAS NEVER COMMITTED. There is not one seo-refresh[bot]
 *       commit in the history, so the shipped value is whatever was last written
 *       by hand — it has never been refreshed by anything.
 *    2. EVEN IF IT RAN, it would be a once-a-day commit against an endpoint that
 *       reorders continuously, served on top of s-maxage=3600.
 *
 *  Measured against the live API: the backdrop in the file,
 *  /1CIaRYKf3zg2Xyce1CSfCMg2Vfw.jpg, is not in /trending/movie/week any more —
 *  not at [0], not anywhere on the page. So the preload was doing the exact
 *  opposite of its job, in two compounding ways:
 *
 *    • 80-160 KB fetched at fetchpriority=high, on a mobile radio, for an image
 *      no slide will ever display — in direct competition with the stylesheet,
 *      the bundle and the real LCP image; and
 *    • pinPreloadedHero() could not find that backdrop among the candidates, so
 *      slide 0 fell through to the editorial pin — a DIFFERENT image, which
 *      could not even be requested until the bundle had parsed and the batch had
 *      come back.
 *
 *  The LCP element was therefore never the preloaded one. The preload was pure
 *  competition for it. That is the single largest LCP cost on a cold visit, and
 *  it cannot be fixed durably in the file, because the file is a build artefact
 *  of a job that is not running.
 *
 *  So it is resolved here instead, from the same endpoint the client pins to,
 *  out of the KV copy the Worker already holds — then the two <link rel=preload>
 *  hints and <meta name="mz-hero-backdrop"> are rewritten to match. The client's
 *  heroBackdropMetaPath() now pins slide 0 to an image the browser has already
 *  started — or finished — downloading before the bundle even parsed.
 *
 *  THIS IS NOT PER-REQUEST WORK. The rewritten document is what gets stored in
 *  caches.default, so the KV read and the rewrite are paid once per cache
 *  generation and every other visitor is served the finished bytes from the
 *  edge. On a miss or a fault the document is passed through untouched and the
 *  response is deliberately NOT cached, so the stale preload can never be
 *  pinned at the edge for an hour — see the put guard in fetch().
 */
const HERO_TRENDING_PATH = '/trending/movie/week?language=en-US&page=1';
const TMDB_IMG_PREFIX = 'https://image.tmdb.org/t/p/';

/*  Kept byte-identical to WIDE_MQ/MOBILE_MQ in seo-ssr.js and HERO_WIDE_MQ in
 *  moviezone.js. All three branch on the same axis and a drift between them
 *  means the browser preloads one width and the client renders the other, which
 *  is a double download rather than a cache hit. */
const HERO_WIDE_MQ = '(min-width: 1025px)';
const HERO_MOBILE_MQ = '(max-width: 1024px)';

/*  How long the homepage will wait for the hero before shipping without it.
 *
 *  The normal path is a KV read behind `cacheTtl: 60`, i.e. single-digit ms. The
 *  budget exists for the cold-cold case — empty KV plus a TMDB round trip, which
 *  TMDB_TIMEOUT_MS alone allows 3s for. Nobody's homepage should wait 3s for a
 *  preload hint, so that request ships un-rewritten and uncached while the fetch
 *  continues under waitUntil; the next request finds KV warm and gets the real
 *  thing. */
const HERO_RESOLVE_BUDGET_MS = 400;

/** The current hero backdrop path, or '' if it cannot be resolved cheaply. */
async function heroBackdropPath(env, ctx) {
  try {
    const result = await fetchTmdbJson(HERO_TRENDING_PATH, env, ctx);
    if (result.status !== 200) return '';
    const first = (JSON.parse(result.text).results || [])[0];
    const path = first && first.backdrop_path;
    /*  Validated, not trusted. This value is interpolated into a URL in a
     *  response header and into an attribute in the document, so it is held to
     *  the shape TMDB actually returns rather than to "it is a string". */
    return (typeof path === 'string' && /^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path))
      ? path
      : '';
  } catch (err) {
    console.log('[hero] resolve failed: ' + (err && err.message));
    return '';
  }
}

/*  Rewrites the shipped hero hints AND the server-rendered slide 0 in place.
 *
 *  BOTH, and that pairing is the whole point. scripts/inject-home-links.js writes
 *  the preload and the slide-0 <picture> from the same heroUrl, precisely so the
 *  preload is consumed by the element that renders - heroPreloadTag() documents
 *  the Chrome warning that appeared when they disagreed. Rewriting only the hint
 *  would put them back into disagreement and make things WORSE than the stale
 *  state it is fixing: the browser would preload the live backdrop, paint the
 *  stale one as LCP, and then download the live one again when buildCarousel()
 *  replaced the slide. Two backdrops and a visible swap.
 *
 *  Attribute-matched rather than string-replaced: the shape of these blocks is
 *  owned by heroPreloadTag() and injectHeroSlide() in seo-ssr.js, and a rewrite
 *  keyed on their exact formatting would silently become a no-op the next time
 *  either template is touched. Streaming, so the 128 KB document is never
 *  buffered.
 */
function rewriteHeroPreload(response, backdropPath) {
  const mobile = TMDB_IMG_PREFIX + 'w780' + backdropPath;
  const wide = TMDB_IMG_PREFIX + 'w1280' + backdropPath;
  /** w1280 for the wide branch, w780 for everything else - see heroPreloadTag(). */
  const forMedia = (media) => (media === HERO_WIDE_MQ ? wide : mobile);

  return new HTMLRewriter()
    .on('link[rel="preload"][as="image"]', {
      element(el) {
        /*  This selector also matches the /moviezone-logo.webp preload, which is
         *  a local 7 KB file and must be left exactly as it is. Only the TMDB
         *  backdrop hints are ours to rewrite. */
        const href = el.getAttribute('href') || '';
        if (href.indexOf(TMDB_IMG_PREFIX) !== 0) return;
        el.setAttribute('href', forMedia(el.getAttribute('media')));
      }
    })
    .on('meta[name="mz-hero-backdrop"]', {
      element(el) { el.setAttribute('content', backdropPath); }
    })
    /*  Slide 0, emitted statically by injectHeroSlide() so the parser has an LCP
     *  element to consume immediately. Scoped to [data-mz-hero-ssr] so no other
     *  <source>/<img> on the page can be caught by this. */
    .on('[data-mz-hero-ssr] source', {
      element(el) {
        if ((el.getAttribute('srcset') || '').indexOf(TMDB_IMG_PREFIX) !== 0) return;
        el.setAttribute('srcset', forMedia(el.getAttribute('media')));
      }
    })
    .on('[data-mz-hero-ssr] img', {
      element(el) {
        /*  The <img> is the fallback inside <picture>, and injectHeroSlide() emits
         *  it at w1280 - it is only reached when neither <source> matches. Keeping
         *  that width means the rewritten markup is byte-for-byte the shape the
         *  generator would have produced for this backdrop. */
        if ((el.getAttribute('src') || '').indexOf(TMDB_IMG_PREFIX) !== 0) return;
        el.setAttribute('src', wide);
      }
    })
    .transform(response);
}

/** The media-scoped Early Hint pair for a resolved hero, in <link> header form. */
function heroEarlyHints(backdropPath) {
  /*  Media-scoped exactly like the tags, for the reason documented on
   *  heroPreloadTag(): `sizes` resolves against device pixels, so a DPR2 phone
   *  asks for ~820px and gets upgraded to the 116 KB w1280 copy where the app
   *  intends the 45 KB one. A media query is evaluated on CSS pixels, the same
   *  axis the client branches on, so the two cannot disagree. */
  return [
    '<' + TMDB_IMG_PREFIX + 'w780' + backdropPath + '>; rel=preload; as=image; '
      + 'media="' + HERO_MOBILE_MQ + '"; fetchpriority=high',
    '<' + TMDB_IMG_PREFIX + 'w1280' + backdropPath + '>; rel=preload; as=image; '
      + 'media="' + HERO_WIDE_MQ + '"; fetchpriority=high'
  ];
}

/*  ══════════════════════════════════════════════════════════════════════════
 *  THE HOMEPAGE IS ANSWERED FROM THE EDGE AND REBUILT BEHIND THE RESPONSE
 *  ══════════════════════════════════════════════════════════════════════════
 *  "/" is the most-requested document on the site, and since the hero rewrite
 *  landed every edge miss did real work in front of the visitor: an env.ASSETS
 *  read, a TMDB lookup for the hero (a KV read, usually a COLD one at this site's
 *  traffic level), a race of up to HERO_RESOLVE_BUDGET_MS against it, and an
 *  HTMLRewriter pass over ~133 KB. And it missed often: caches.default is
 *  per-location, the entry lived for s-maxage (1 h), and a request whose hero lost
 *  the race was deliberately not stored - so on a quiet location the next visitor
 *  paid the whole thing again. That is up to 400 ms on the TTFB of the document
 *  every other metric on the page waits for.
 *
 *  It is now stale-while-revalidate at the edge, the scheme the batch endpoint
 *  already uses. The rendered document is kept for a day under a synthetic key,
 *  freshness is its stored-at stamp (HOME_FRESH_MS), and a stale copy is answered
 *  at once while the rebuild runs under waitUntil. Only the first request a
 *  location sees - or the first after a deploy - renders inline.
 *
 *  The key carries the deployed version (version_metadata in wrangler.jsonc), so
 *  a new deploy never serves an old document that points at old ?v= bundles.
 *  Without the binding it degrades to one key that HOME_FRESH_MS keeps recent.
 *  Every query string shares the entry: env.ASSETS ignores the query for "/", so
 *  ?utm_*, ?fbclid and ?search= variants are byte-identical documents anyway.
 *
 *  The rewritten document also gets a real validator now. It used to ship with
 *  none (the asset's ETag no longer described the bytes), so every returning
 *  visitor re-downloaded the whole document. The new ETag is derived from the
 *  asset's own tag AND the hero path, so it changes whenever either does - which
 *  is exactly the property the old "drop it" rule was protecting.
 */
const HOME_FRESH_MS = 5 * 60 * 1000;
const HOME_EDGE_RETENTION = 86400;
const HOME_STORED_HEADER = 'x-mz-stored';
/*  The BROWSER always revalidates the homepage (max-age=0 + ETag = a ~150-byte
 *  304 when nothing changed); only the edge keeps it (s-maxage). The document
 *  pins the ?v= bundle URLs, so a browser-cached copy is exactly how a returning
 *  visitor ended up on an old document with new code after a deploy. */
const HOME_CACHE_CONTROL = 'public, max-age=0, must-revalidate, s-maxage=' + HOME_EDGE_RETENTION;
/** One background rebuild per isolate per this window, however many visitors. */
const HOME_REFRESH_COOLDOWN_MS = 60000;

/*  "/" only. The asset router answers /index.html with a redirect to "/", and
 *  sharing the home entry would hand /index.html a duplicate 200 instead. */
function isHomePath(pathname) {
  return pathname === '/';
}

/** The deployed version id, or '' where the binding is absent (tests, dev). */
function deployVersion(env) {
  const meta = env && env.CF_VERSION_METADATA;
  return String((meta && (meta.id || meta.tag)) || '');
}

function homeEdgeKey(url, env) {
  const version = deployVersion(env);
  return new Request(url.origin + '/__mz/home'
    + (version ? '?v=' + encodeURIComponent(version) : ''), { method: 'GET' });
}

/*  Renders the homepage: the asset, its headers, and - when it resolves inside
 *  the budget - the live hero. `cacheable` is false when the hero did not
 *  resolve, for the reason worker-hero-check.js pins: storing the pass-through
 *  would pin the stale hard-coded preload at the edge. */
async function renderHome(request, env, ctx) {
  /*  A plain GET, not the visitor's request: its conditional headers must not
   *  turn the render into a 304 from env.ASSETS that then gets treated as the
   *  document. */
  const assetResponse = await env.ASSETS.fetch(new Request(request.url, { method: 'GET' }));

  const headers = new Headers(assetResponse.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Cache-Control', HOME_CACHE_CONTROL);
  /*  Consumed by Cloudflare Early Hints: the browser can open the TLS connection
   *  to the poster/backdrop host while the HTML is still on its way. */
  headers.append('Link', '<https://image.tmdb.org>; rel=preconnect');

  if (assetResponse.status !== 200) {
    return {
      response: new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers
      }),
      cacheable: false
    };
  }

  /*  ── THE HERO HINT ──
   *  See heroBackdropPath() for why the value in the file cannot be trusted.
   *  heroWork is kept alive past the response on purpose: when the race times out
   *  it is the fetch that fills the caches, and without waitUntil it would be
   *  cancelled with the request. With the L1/L2 layers in fetchTmdbJson this is
   *  normally an in-memory or same-location read, well inside the budget. */
  const heroWork = heroBackdropPath(env, ctx);
  ctx.waitUntil(heroWork.catch(() => {}));
  let timer = null;
  const heroPath = await Promise.race([
    heroWork,
    new Promise((resolve) => { timer = setTimeout(() => resolve(''), HERO_RESOLVE_BUDGET_MS); })
  ]);
  if (timer !== null) clearTimeout(timer);

  if (heroPath) {
    for (const hint of heroEarlyHints(heroPath)) headers.append('Link', hint);
    // The asset's validator describes bytes that are no longer being sent.
    const assetTag = assetResponse.headers.get('ETag') || '';
    headers.delete('ETag');
    headers.delete('Last-Modified');
    // The deploy is part of the validator too: a Worker-only change to the
    // rewritten bytes must not revalidate into a 304 for the old ones.
    if (assetTag) {
      headers.set('ETag', weakEtag(bareEtag(assetTag) + '|' + heroPath + '|' + deployVersion(env)));
    }
    headers.set(HOME_STORED_HEADER, String(Date.now()));
  }

  let response = new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers
  });
  if (heroPath) response = rewriteHeroPreload(response, heroPath);
  return { response, cacheable: Boolean(heroPath) };
}

/** Rebuilds the stored homepage behind a stale answer. Never throws. */
async function refreshHome(request, env, ctx, colo, key) {
  try {
    const { response, cacheable } = await renderHome(request, env, ctx);
    if (cacheable) {
      await colo.put(key, forEdgeStore(response));
    } else if (response.body) {
      await response.body.cancel();
    }
  } catch (err) {
    console.log('[home] background rebuild failed: ' + (err && err.message));
  }
}

async function serveHome(request, env, ctx, url) {
  const colo = coloCache();
  const key = homeEdgeKey(url, env);

  if (colo) {
    try {
      const cached = await colo.match(key);
      if (cached) {
        const storedAt = Number(cached.headers.get(HOME_STORED_HEADER)) || 0;
        const state = tmdbState(env);
        if (Date.now() - storedAt > HOME_FRESH_MS
            && (!state || Date.now() - state.homeRefreshedAt > HOME_REFRESH_COOLDOWN_MS)) {
          if (state) state.homeRefreshedAt = Date.now();
          ctx.waitUntil(refreshHome(request, env, ctx, colo, key));
        }
        // The browser policy is restored BEFORE the 304 check, which copies it.
        const hit = fromEdgeStore(cached);
        return notModified(request, hit) || hit;
      }
    } catch (err) {
      // An edge lookup must never fail the homepage — render it instead.
      console.log('[home] edge lookup failed: ' + (err && err.message));
    }
  }

  const { response, cacheable } = await renderHome(request, env, ctx);
  if (colo && cacheable) waitFor(ctx, colo.put(key, forEdgeStore(response.clone())));
  /*  Stored as the full 200 above, answered as a 304 below when the visitor
   *  already holds these bytes — caching the 304 would poison the entry. */
  return notModified(request, response) || response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // SEO: www → non-www 301 redirect
    if (url.hostname === 'www.moviezone.dev') {
      return Response.redirect(`https://moviezone.dev${url.pathname}${url.search}`, 301);
    }

    /*  /api/* is decided entirely inside routeApi. The TMDB proxy runs its own
     *  edge layer inside fetchTmdbJson (so the proxy, the batch, SSR and the hero
     *  share ONE cache entry per path), the batch has its plan-level colo layer,
     *  and the push endpoints are per-subscriber and must never be shared. The
     *  generic edge match that used to run here first found nothing for any of
     *  them except the proxy, and cost every /api request a cache lookup. */
    if (url.pathname.startsWith('/api/')) {
      return routeApi(request, env, ctx, url);
    }

    if (request.method === 'GET' && isHomePath(url.pathname)) {
      return serveHome(request, env, ctx, url);
    }

    /*  ✅ Edge Cache: checked before any expensive work (FREE, no KV quota).
     *  The key is computed ONCE and reused by every put below — a match and a put
     *  that disagree is worse than no cache at all, because it never hits and
     *  writes an entry per request. */
    const edgeCache = coloCache();
    const cacheKey = request.method === 'GET' ? edgeCacheKey(request, url) : request;
    if (edgeCache && request.method === 'GET') {
      let cached = null;
      try {
        cached = await edgeCache.match(cacheKey);
      } catch (err) {
        // A cache lookup must never be able to fail the page — render it instead.
        console.log('[edge] lookup failed for ' + url.pathname + ': ' + (err && err.message));
      }
      if (cached) {
        /*  The revalidation check belongs HERE, not only on freshly rendered
         *  responses. An edge hit is the common case for a returning visitor, so
         *  checking only the render path would have left the 304 unreachable for
         *  almost everyone who could benefit from it. The browser policy is
         *  restored first (see WHAT THE BROWSER IS TOLD ON AN EDGE HIT). */
        const hit = fromEdgeStore(cached);
        return notModified(request, hit) || hit;
      }
    }

    let ssr = null;
    try {
      ssr = await ssrResponse(request, env, ctx, url);
    } catch (err) {
      console.error('[ssr] ' + url.pathname + ' failed:', err && err.stack);
    }
    if (ssr) {
      /*  ✅ Cache SSR pages (200 only).
       *  The method guard matters: run_worker_first hands /movies/*, /movie/* and
       *  friends to this Worker for EVERY method, and the Cache API rejects a
       *  non-GET key — which would surface as an unhandled waitUntil rejection in
       *  the observability logs, i.e. noise in the one place you look when
       *  diagnosing errors. */
      if (edgeCache && ssr.status === 200 && request.method === 'GET') {
        waitFor(ctx, edgeCache.put(cacheKey, forEdgeStore(ssr.clone())));
      }
      /*  Store the full 200 above, hand the client a 304 below. Doing it in that
       *  order matters: caching the 304 instead would poison the entry for every
       *  subsequent visitor who has no copy to revalidate against. */
      const ssrFresh = notModified(request, ssr);
      return ssrFresh || ssr;
    }

    // ─── Static Assets with SEO Headers ────────────────────────
    const assetResponse = await env.ASSETS.fetch(request);

    const newHeaders = new Headers(assetResponse.headers);
    newHeaders.set('X-Content-Type-Options', 'nosniff');
    newHeaders.set('X-Frame-Options', 'SAMEORIGIN');
    newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    const path = url.pathname;

    if (path === '/sw.js') {
      /*  MUST come before the .js branch below, which was giving the service
       *  worker `max-age=2592000, immutable`. The browser is shielded from that
       *  by updateViaCache:'none' in the registration, but the Cloudflare cache
       *  is not — so a deployed worker update could sit behind a month-old copy
       *  at the edge and never reach anyone. */
      newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      newHeaders.set('Service-Worker-Allowed', '/');
    } else if (path === '/manifest.json' || path === '/manifest.webmanifest') {
      newHeaders.set('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (/\.(js|css|woff2|woff|png|jpg|jpeg|webp|avif|svg|ico)$/.test(path)) {
      /*  A year, not a month, for anything whose URL cannot change meaning.
       *
       *  asset-seal.js already guarantees that every ?v= bundle is byte-stable
       *  for its version — that is the whole point of the seal — and the font
       *  files are content-final. Those are exactly the conditions `immutable`
       *  describes. Unversioned assets keep the month, since their bytes can
       *  change. (Only requests that reach this Worker get these headers; the
       *  files the asset router serves directly are covered by _headers.) */
      const stable = url.searchParams.has('v') || path.startsWith('/fonts/');
      newHeaders.set('Cache-Control', stable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=2592000, immutable');
    } else if (path.endsWith('.html') || path === '/') {
      /*  HEAD / and any other document that reaches here. GET / never does: it
       *  is answered by serveHome() above. */
      newHeaders.set('Cache-Control', HOME_CACHE_CONTROL);
      newHeaders.append('Link', '<https://image.tmdb.org>; rel=preconnect');
    }

    const finalResponse = new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers: newHeaders
    });

    // ✅ Cache static assets (200 only)
    if (edgeCache && request.method === 'GET' && finalResponse.status === 200 && path !== '/sw.js') {
      waitFor(ctx, edgeCache.put(cacheKey, forEdgeStore(finalResponse.clone())));
    }

    return finalResponse;
  },


  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDueNotifications(env).then(
      (result) => console.log('[MovieZone] process-due', JSON.stringify(result)),
      (err) => console.error('[MovieZone] process-due failed:', err && err.message)
    ));
  }
};

/*  Exported for worker-push.test.js, which runs this file under Node.
 *  Node 18+ ships the same Web Crypto surface, so the crypto path under test is
 *  byte-for-byte the one that runs in production.
 */
export {
  b64urlToBytes,
  bytesToB64url,
  buildSitemapIndexXml,
  concatBytes,
  edgeCacheKey,
  encryptPushPayload,
  endpointId,
  getSitemapItems,
  hkdf,
  importVapidSigningKey,
  isCalendarDate,
  processDueNotifications,
  routeApi,
  seoLimits,
  serveBrowseIndex,
  serveBrowseLetter,
  serveMediaSitemap,
  sitemapShardPaths,
  ssrResponse,
  safeNotifyUrl,
  sendPushToSubscription,
  vapidAuthorization,
  validBatchPath,
  xmlResponse,
  pushLimits
};

/*  Named exports of a Worker entrypoint must be handlers or classes.
 *
 *  RECORD_SIZE and MAX_BATCH_PATHS used to be exported directly for
 *  worker-push.test.js, and the runtime now refuses to start such a module:
 *      Incorrect type for map entry 'MAX_BATCH_PATHS':
 *      the provided value is not of type 'function or ExportedHandler'
 *  The deployed copy predates that check, so the failure would only have
 *  appeared on the next deploy — as a Worker that boots nowhere. Handing the two
 *  numbers back from a function keeps the test honest and the module loadable.
 */
function pushLimits() {
  return { RECORD_SIZE, MAX_BATCH_PATHS };
}

/*  Same reason as pushLimits(): SITEMAP_CHUNK has to be readable by
 *  worker-seo.test.js — it must equal SITEMAP_CHUNK_SIZE in seo-ssr.js or the two
 *  runtimes advertise different shard sets — and a named number export makes the
 *  module unloadable. */
function seoLimits() {
  return { SITEMAP_CHUNK, SITEMAP_KV_TTL, SITEMAP_LIVE_PAGES };
}