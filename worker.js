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
  const raw = await store.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** Walks every key under a prefix, following the list cursor. */
async function listKeys(store, prefix, limit = Infinity) {
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ prefix, cursor });
    for (const entry of page.keys) {
      keys.push(entry.name);
      if (keys.length >= limit) return keys;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
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
  const now = new Date().toISOString();

  await store.put(subKey(id), JSON.stringify({
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime || null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    active: true,
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now
  }));

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

  await store.put(notifyKey(id, movieId), JSON.stringify({
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
  }));

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

  // 201 and { saved } are what the old Express route returned; the client reads
  // confirmationSent to choose its toast copy.
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
  const existed = Boolean(await store.get(key));
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
  const keys = await listKeys(store, notifyPrefix(id));
  const records = await Promise.all(keys.map((key) => readJson(store, key)));

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
 */
async function processDueNotifications(env) {
  const store = subsStore(env);
  if (!store) return { checked: 0, sent: 0, failed: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const keys = await listKeys(store, 'notify:', MAX_DUE_PER_RUN);

  let checked = 0;
  let sent = 0;
  let failed = 0;

  for (const key of keys) {
    const record = await readJson(store, key);
    if (!record || record.active === false) continue;
    if (record.notifiedAt) continue;
    if (!isCalendarDate(record.releaseDate) || record.releaseDate > today) continue;

    checked++;

    const id = record.endpointId || await endpointId(record.endpoint);
    const subscription = await loadActiveSubscription(store, id);
    if (!subscription) {
      failed++;
      continue;
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
      const now = new Date().toISOString();
      await store.put(key, JSON.stringify({
        ...record, active: false, notifiedAt: now, updatedAt: now
      }));
    } else {
      failed++;
      if (result.expired) await dropSubscription(store, id);
    }
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
 *  Fetches one TMDB path, KV-cached.
 *
 *  `path` is everything after /api/tmdb, query string included, e.g.
 *  "/movie/popular?language=en-US&page=1". The cache key is deliberately the
 *  full public path — "/api/tmdb" + path — so a title fetched individually and
 *  the same title fetched inside a batch share one KV entry instead of storing
 *  the response twice.
 */
async function fetchTmdbJson(path, env, ctx) {
  const cacheKey = '/api/tmdb' + path;

  if (env.TMDB_CACHE) {
    const cached = await env.TMDB_CACHE.get(cacheKey);
    if (cached) return { status: 200, text: cached, cache: 'HIT' };
  }

  const headers = new Headers();
  headers.set('Authorization', `Bearer ${env.TMDB_TOKEN}`);
  headers.set('accept', 'application/json');

  const response = await fetch(`https://api.themoviedb.org/3${path}`, { headers });
  const text = await response.text();

  if (env.TMDB_CACHE && response.status === 200) {
    ctx.waitUntil(env.TMDB_CACHE.put(cacheKey, text, { expirationTtl: TMDB_CACHE_TTL }));
  }

  return { status: response.status, text, cache: 'MISS' };
}

async function handleTmdbProxy(request, env, ctx, url) {
  const path = url.pathname.replace('/api/tmdb', '') + url.search;
  const result = await fetchTmdbJson(path, env, ctx);

  return new Response(result.text, {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      'x-cache': result.cache,
      'cache-control': 'public, max-age=3600'
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
 *  and its KV cache, so the 26 fetches cost one client round-trip in total.
 *
 *  It also fixes the scaling shape, which matters more than the single-visitor
 *  win. The plan is identical for every visitor on a given day — the date
 *  windows in it are derived from today's date — so the assembled response is
 *  cached under a hash of the plan. The first visitor of the hour pays the
 *  fan-out; everyone after them is answered by ONE KV read. Traffic can grow
 *  without TMDB seeing more requests.
 *
 *  SECURITY: this takes a caller-supplied list of paths, so it must not become
 *  an open proxy. Paths are matched against a strict allowlist, the count is
 *  capped, and the TMDB base URL and bearer token are always applied here —
 *  never taken from input.
 */
const MAX_BATCH_PATHS = 40;
const TMDB_CACHE_TTL = 3600;
const BATCH_CACHE_TTL = 1800;

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
 *  actually makes this scale is the KV entry keyed on the plan hash below — and
 *  that works identically for POST. On the client side the individual endpoints
 *  are already held in memory and in a 12h localStorage copy, which is a better
 *  cache than an HTTP-cached blob would be.
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

  if (env.TMDB_CACHE) {
    const cached = await env.TMDB_CACHE.get(planKey);
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-cache': 'HIT',
          'x-batch-size': String(paths.length),
          'cache-control': 'no-store'
        }
      });
    }
  }

  const settled = await Promise.all(paths.map(async (path) => {
    try {
      const result = await fetchTmdbJson(path, env, ctx);
      if (result.status !== 200) {
        return { status: 'rejected', reason: `TMDB responded ${result.status}` };
      }
      return { status: 'fulfilled', value: JSON.parse(result.text) };
    } catch (err) {
      // One dead source must never fail the whole first screen. This mirrors the
      // Promise.allSettled the client used to do itself, which is why the shape
      // is preserved exactly.
      return { status: 'rejected', reason: err.message };
    }
  }));

  const body = JSON.stringify({ results: settled });

  // Only cache a batch that actually worked. Caching a half-empty first screen
  // for 30 minutes would turn one bad moment into a lasting one.
  const allOk = settled.every((r) => r.status === 'fulfilled');
  if (env.TMDB_CACHE && allOk) {
    ctx.waitUntil(env.TMDB_CACHE.put(planKey, body, { expirationTtl: BATCH_CACHE_TTL }));
  }

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-cache': 'MISS',
      // Whether this plan was worth remembering. Surfaced because a batch that
      // keeps reporting "no" means a source is persistently failing, and the
      // symptom on the client — a slightly thin feed — is easy to miss.
      'x-batch-stored': allOk ? 'yes' : 'no',
      'x-batch-size': String(paths.length),
      // The response is per-plan and served over POST; the KV entry above is the
      // shared cache, so nothing downstream should hold a copy.
      'cache-control': 'no-store'
    }
  });
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

  if (pathname.startsWith('/api/tmdb/')) {
    return handleTmdbProxy(request, env, ctx, url);
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
const SSR_CATEGORY_CACHE = 'public, max-age=900, s-maxage=21600, stale-while-revalidate=86400';
// Shorter than the detail page: embed hosts rotate, and a stale player frame is
// worse than a slightly slower page.
const SSR_WATCH_CACHE = 'public, max-age=300, s-maxage=900';

/** The append_to_response the detail template needs; same list as server.js. */
const SSR_DETAIL_APPEND = 'credits,similar,recommendations,videos,watch/providers,'
  + 'release_dates,content_ratings';

/**
 * Adapts the KV-cached TMDB proxy to the `tmdb(path, params)` contract the
 * seo-ssr renderers were written against, including the `tmdbStatus` property
 * their 404 handling looks for.
 */
function ssrTmdb(env, ctx) {
  return async (apiPath, params) => {
    const query = new URLSearchParams(params || {}).toString();
    const result = await fetchTmdbJson(apiPath + (query ? '?' + query : ''), env, ctx);
    if (result.status !== 200) {
      const err = new Error('TMDB responded ' + result.status);
      err.tmdbStatus = result.status;
      throw err;
    }
    return JSON.parse(result.text);
  };
}

function ssrHtml(html, cacheControl, robots) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': cacheControl
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
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // SEO: www → non-www 301 redirect
    if (url.hostname === 'www.moviezone.dev') {
      return Response.redirect(`https://moviezone.dev${url.pathname}${url.search}`, 301);
    }

    const apiResponse = await routeApi(request, env, ctx, url);
    if (apiResponse) return apiResponse;

    /*  Server-rendered pages come before the asset handler on purpose. The
     *  fallback below answers 200 with index.html for anything that is not a
     *  file, so a category or detail URL reaching it would render the homepage
     *  under the right address instead of the page that was asked for.
     */
    let ssr = null;
    try {
      ssr = await ssrResponse(request, env, ctx, url);
    } catch (err) {
      // A renderer throwing must not take the URL down: fall through to the SPA,
      // which can still fetch and render the same content client-side.
      console.error('[ssr] ' + url.pathname + ' failed:', err && err.stack);
    }
    if (ssr) return ssr;

    // ─── Static Assets with SEO Headers ────────────────────────
    const assetResponse = await env.ASSETS.fetch(request);

    const newHeaders = new Headers(assetResponse.headers);
    newHeaders.set('X-Content-Type-Options', 'nosniff');
    newHeaders.set('X-Frame-Options', 'SAMEORIGIN');
    newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (url.pathname.endsWith('.html') || url.pathname === '/') {
      newHeaders.set('Cache-Control', 'public, max-age=3600');
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers: newHeaders
    });
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
  concatBytes,
  encryptPushPayload,
  endpointId,
  hkdf,
  importVapidSigningKey,
  isCalendarDate,
  processDueNotifications,
  routeApi,
  ssrResponse,
  safeNotifyUrl,
  sendPushToSubscription,
  vapidAuthorization,
  validBatchPath,
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
