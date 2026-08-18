/* ═══════════════════════════════════════════════════════════════════════════
   worker-push.test.js — proves the Cloudflare Worker's Notify Me layer works.

   WHY THIS EXISTS
   Notify Me broke on the Cloudflare migration and nothing caught it. The Worker
   only carried over /api/push/subscribe and /api/push/unsubscribe; every other
   endpoint the browser calls fell through to the asset handler, which — with
   not_found_handling "single-page-application" — answers 200 with index.html.
   So the client saw a successful-looking response containing HTML and reported
   "Notification permission or push subscription is unavailable".

   Two classes of bug are guarded here, and only the second is obvious:

     1. ROUTING. Every path moviezone.js fetches must exist and must answer
        application/json — including the 404, because the client's servedSpaShell()
        check distinguishes "endpoint missing" from "endpoint broken" by content
        type.

     2. CRYPTO. web-push is not usable in a Worker, so VAPID signing and
        aes128gcm payload encryption are hand-rolled against Web Crypto. This is
        the dangerous part: a push service returns 201 Created for a payload the
        browser cannot decrypt. Nothing fails, nothing logs, the notification
        simply never appears. So the test acts as the user agent — it derives the
        same keys from the subscription's private half and DECRYPTS the body the
        Worker produced. If the delimiter, the header framing, the HKDF info
        strings or the key order are wrong, this fails loudly.

   worker.js is ESM and this package is commonjs, so it is imported through a
   data: URL — that runs the real module, unmodified, with real ESM semantics.

   Run: node worker-push.test.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const WORKER_FILE = path.join(__dirname, 'worker.js');
const TE = new TextEncoder();
const TD = new TextDecoder();

let failures = 0;
let checks = 0;

function check(label, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + label
    + (!pass && detail ? '\n          ' + detail : ''));
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── helpers shared with the module under test (re-implemented, not imported,
//    so a bug in the Worker's own helper cannot cancel itself out) ────────────

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value) {
  return new Uint8Array(Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function concat(...chunks) {
  return Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
}

async function hkdfBytes(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8
  ));
}

/** A KV namespace with just enough behaviour: get/put/delete plus prefix list. */
function fakeKV(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async put(key, value) { data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '', cursor } = {}) {
      const names = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + 1000);
      const end = start + page.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: end >= names.length,
        cursor: String(end)
      };
    }
  };
}

const req = (url, init) => new Request('https://moviezone.dev' + url, init);
const postJson = (url, body) => req(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

/** Drives routeApi the way the fetch handler does. */
function callApi(worker, env, request) {
  return worker.routeApi(request, env, { waitUntil() {} }, new URL(request.url));
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** A throwaway VAPID pair in the exact shape `web-push generate-vapid-keys` prints. */
async function makeVapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const point = concat(Uint8Array.of(0x04), fromB64url(jwk.x), fromB64url(jwk.y));
  return {
    publicKey: b64url(point),
    privateKey: jwk.d,
    jwkPublic: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }
  };
}

/** A browser-side subscription whose private half the test keeps, so it can decrypt. */
async function makeSubscriber(endpoint) {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicBytes,
    authSecret,
    subscription: {
      endpoint,
      expirationTime: null,
      keys: { p256dh: b64url(publicBytes), auth: b64url(authSecret) }
    }
  };
}

/*  The user agent's half of RFC 8291. Mirrors what a browser does on receipt:
 *  reparse the aes128gcm header, redo the ECDH and both HKDF passes from the
 *  subscription's private key, and open the AES-GCM record.
 */
async function decryptAsUserAgent(subscriber, body) {
  const bytes = new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const recordSize = new DataView(bytes.buffer, bytes.byteOffset + 16, 4).getUint32(0);
  const idLength = bytes[20];
  const asPublicBytes = bytes.slice(21, 21 + idLength);
  const ciphertext = bytes.slice(21 + idLength);

  const asPublicKey = await crypto.subtle.importKey(
    'raw', asPublicBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: asPublicKey }, subscriber.privateKey, 256
  ));

  const ikm = await hkdfBytes(
    shared,
    subscriber.authSecret,
    concat(TE.encode('WebPush: info'), Uint8Array.of(0), subscriber.publicBytes, asPublicBytes),
    32
  );
  const contentKey = await hkdfBytes(
    ikm, salt, concat(TE.encode('Content-Encoding: aes128gcm'), Uint8Array.of(0)), 16
  );
  const nonce = await hkdfBytes(
    ikm, salt, concat(TE.encode('Content-Encoding: nonce'), Uint8Array.of(0)), 12
  );

  const aesKey = await crypto.subtle.importKey('raw', contentKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const record = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, ciphertext
  ));

  return {
    recordSize,
    idLength,
    delimiter: record[record.length - 1],
    plaintext: TD.decode(record.slice(0, -1))
  };
}

// ── main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\nWorker push layer — VAPID, aes128gcm and the /api routes the client calls');
  console.log('-'.repeat(74));

  /*  worker.js now imports the SSR renderers from ./seo-ssr.js. A data: URL has
   *  no base to resolve a relative specifier against, so the specifier is
   *  rewritten to an absolute file: URL before the module is evaluated. The code
   *  under test is otherwise untouched, and the import it gets is the real file.
   */
  const source = fs.readFileSync(WORKER_FILE, 'utf8')
    .replace(/from '\.\/([\w.-]+)'/g,
      (_m, file) => "from '" + pathToFileURL(path.join(__dirname, file)).href + "'");
  const worker = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  /*  RECORD_SIZE and MAX_BATCH_PATHS come back from a function now: a Worker
   *  entrypoint may only export handlers and classes, and the runtime refuses to
   *  start a module that exports plain numbers. */
  const limits = worker.pushLimits();

  const vapid = await makeVapidKeys();
  const baseEnv = {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_EMAIL: 'mailto:test@moviezone.dev'
  };

  // ── 1. base64url plumbing ─────────────────────────────────────────────────
  console.log('\n1. key encoding');
  const sample = crypto.getRandomValues(new Uint8Array(65));
  check('base64url round-trips 65 raw bytes',
    Buffer.compare(Buffer.from(worker.b64urlToBytes(worker.bytesToB64url(sample))), Buffer.from(sample)) === 0);
  check('bytesToB64url emits unpadded, URL-safe output',
    !/[+/=]/.test(worker.bytesToB64url(sample)));
  check('b64urlToBytes accepts the unpadded keys browsers hand over',
    worker.b64urlToBytes(vapid.publicKey).length === 65);

  // ── 2. VAPID signing ─────────────────────────────────────────────────────
  console.log('\n2. VAPID (RFC 8292)');
  const header = await worker.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', baseEnv);
  const parsed = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  check('Authorization is "vapid t=<jwt>, k=<publicKey>"', Boolean(parsed), header);

  if (parsed) {
    const [, jwt, sentKey] = parsed;
    equal('k= carries the configured public key', sentKey, vapid.publicKey);

    const [h, p, s] = jwt.split('.');
    const jwtHeader = JSON.parse(TD.decode(fromB64url(h)));
    const claims = JSON.parse(TD.decode(fromB64url(p)));
    equal('JWT alg is ES256', jwtHeader.alg, 'ES256');
    equal('aud is the push service origin, not our own',
      claims.aud, 'https://fcm.googleapis.com');
    equal('sub carries VAPID_EMAIL', claims.sub, 'mailto:test@moviezone.dev');
    const lifetime = claims.exp - Math.floor(Date.now() / 1000);
    check('exp is inside the 24h limit RFC 8292 sets',
      lifetime > 0 && lifetime <= 86400, 'lifetime=' + lifetime + 's');

    // The real proof: the signature must verify against the public key we
    // advertise in k=. A wrong JWK import produces a well-formed, unverifiable
    // token, and the push service would answer 401.
    const verifyKey = await crypto.subtle.importKey(
      'jwk', vapid.jwkPublic, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, verifyKey, fromB64url(s), TE.encode(h + '.' + p)
    );
    check('ES256 signature verifies against the advertised public key', valid);
    equal('raw r||s signature is 64 bytes', fromB64url(s).length, 64);
  }

  check('a malformed public key is rejected rather than signing garbage',
    await worker.importVapidSigningKey('bm90LWEta2V5', vapid.privateKey)
      .then(() => false, () => true));

  // ── 3. payload encryption ────────────────────────────────────────────────
  console.log('\n3. aes128gcm payload (RFC 8291 / RFC 8188)');
  const subscriber = await makeSubscriber('https://fcm.googleapis.com/fcm/send/decrypt-me');
  const payload = JSON.stringify({
    title: 'Now available on MovieZone',
    body: 'Spider-Man: Brand New Day has released. Tap to view details.',
    url: '/#upcoming'
  });
  const encrypted = await worker.encryptPushPayload(
    payload, subscriber.subscription.keys.p256dh, subscriber.subscription.keys.auth
  );

  equal('body starts with a 16-byte salt then rs then idlen', encrypted[20], 65);
  check('body is header(21) + as_public(65) + ciphertext(>=17)',
    encrypted.length === 21 + 65 + (TE.encode(payload).length + 1 + 16),
    'length=' + encrypted.length);

  const opened = await decryptAsUserAgent(subscriber, encrypted);
  equal('a user agent decrypts the payload byte-for-byte', opened.plaintext, payload);
  equal('record size field matches RECORD_SIZE', opened.recordSize, limits.RECORD_SIZE);
  equal('single record is terminated with the 0x02 delimiter', opened.delimiter, 0x02);

  const second = await worker.encryptPushPayload(
    payload, subscriber.subscription.keys.p256dh, subscriber.subscription.keys.auth
  );
  check('a fresh ephemeral key and salt are used per message',
    Buffer.compare(Buffer.from(encrypted), Buffer.from(second)) !== 0);

  for (const [label, p256dh, auth] of [
    ['p256dh that is not an uncompressed point', b64url(new Uint8Array(32)), subscriber.subscription.keys.auth],
    ['auth secret of the wrong length', subscriber.subscription.keys.p256dh, b64url(new Uint8Array(8))]
  ]) {
    check('rejects ' + label,
      await worker.encryptPushPayload('{}', p256dh, auth).then(() => false, () => true));
  }

  // ── 4. delivery ──────────────────────────────────────────────────────────
  console.log('\n4. delivery to the push service');
  const realFetch = globalThis.fetch;
  let lastPush = null;
  globalThis.fetch = async (url, init) => {
    lastPush = { url: String(url), init };
    return new Response(null, { status: 201 });
  };

  const delivery = await worker.sendPushToSubscription(
    subscriber.subscription, { title: 'MovieZone', body: 'hi' }, baseEnv
  );
  check('sendPushToSubscription reports sent', delivery.sent === true, JSON.stringify(delivery));
  equal('POSTs to the subscription endpoint', lastPush.url, subscriber.subscription.endpoint);
  equal('Content-Encoding is aes128gcm', lastPush.init.headers['Content-Encoding'], 'aes128gcm');
  equal('Content-Type is application/octet-stream',
    lastPush.init.headers['Content-Type'], 'application/octet-stream');
  check('TTL is sent so the service can queue the message',
    Number(lastPush.init.headers.TTL) > 0);
  check('the POSTed body is the encrypted record, decryptable by the subscriber',
    (await decryptAsUserAgent(subscriber, lastPush.init.body)).plaintext
      === JSON.stringify({ title: 'MovieZone', body: 'hi' }));

  globalThis.fetch = async () => new Response(null, { status: 410 });
  const gone = await worker.sendPushToSubscription(
    subscriber.subscription, { title: 'x' }, baseEnv
  );
  check('410 Gone is reported as expired, not as a generic failure',
    gone.sent === false && gone.expired === true, JSON.stringify(gone));

  globalThis.fetch = async () => { throw new Error('network down'); };
  const offline = await worker.sendPushToSubscription(
    subscriber.subscription, { title: 'x' }, baseEnv
  );
  check('a network error never throws out of sendPushToSubscription',
    offline.sent === false && offline.error === 'network down');

  const unconfigured = await worker.sendPushToSubscription(
    subscriber.subscription, { title: 'x' }, {}
  );
  check('missing VAPID secrets are refused, not silently attempted',
    unconfigured.sent === false && /not configured/.test(unconfigured.error));

  // ── 5. routing ───────────────────────────────────────────────────────────
  console.log('\n5. the /api routes moviezone.js fetches');
  globalThis.fetch = async () => new Response(null, { status: 201 });

  const store = fakeKV();
  const env = { ...baseEnv, PUSH_SUBS: store };

  const isJson = (res) =>
    (res.headers.get('content-type') || '').includes('application/json');

  // 5a. vapid-key — the exact call that was returning index.html.
  const keyRes = await callApi(worker, env, req('/api/push/vapid-key'));
  equal('GET /api/push/vapid-key -> 200', keyRes.status, 200);
  check('GET /api/push/vapid-key answers application/json', isJson(keyRes));
  equal('publicKey matches the configured key',
    (await keyRes.json()).publicKey, vapid.publicKey);

  const noVapid = await callApi(worker, { PUSH_SUBS: store }, req('/api/push/vapid-key'));
  equal('vapid-key without secrets -> 503, so the client skips quietly', noVapid.status, 503);

  // 5b. an unimplemented API path must be a JSON 404, never the SPA shell.
  const missing = await callApi(worker, env, req('/api/does-not-exist'));
  equal('unknown /api path -> 404', missing.status, 404);
  check('unknown /api path answers application/json, not the SPA shell', isJson(missing));

  const wrongMethod = await callApi(worker, env, req('/api/notify-movies'));
  equal('GET on a POST-only route -> 405', wrongMethod.status, 405);

  // 5c. subscribe
  const badSub = await callApi(worker, env, postJson('/api/push/subscribe', { endpoint: 'https://x/y' }));
  equal('subscribe without keys -> 400', badSub.status, 400);

  const subRes = await callApi(worker, env,
    postJson('/api/push/subscribe', subscriber.subscription));
  equal('POST /api/push/subscribe -> 200', subRes.status, 200);
  check('subscription is stored under a prefixed, fixed-width key',
    [...store.data.keys()].some((k) => /^sub:[0-9a-f]{32}$/.test(k)),
    [...store.data.keys()].join(', '));

  const storedId = await worker.endpointId(subscriber.subscription.endpoint);
  const storedSub = JSON.parse(store.data.get('sub:' + storedId));
  equal('stored record keeps the full endpoint URL',
    storedSub.endpoint, subscriber.subscription.endpoint);
  equal('stored record keeps p256dh', storedSub.keys.p256dh, subscriber.subscription.keys.p256dh);

  const createdAt = storedSub.createdAt;
  await callApi(worker, env, postJson('/api/push/subscribe', subscriber.subscription));
  equal('re-subscribing preserves createdAt instead of duplicating the row',
    JSON.parse(store.data.get('sub:' + storedId)).createdAt, createdAt);
  equal('re-subscribing does not add a second subscription',
    [...store.data.keys()].filter((k) => k.startsWith('sub:')).length, 1);

  // 5d. notify-movies save
  const noSubSave = await callApi(worker, env, postJson('/api/notify-movies', {
    endpoint: 'https://fcm.googleapis.com/fcm/send/never-subscribed',
    movieId: 1, title: 'Ghost', releaseDate: '2026-09-01'
  }));
  equal('saving against an unknown subscription -> 409', noSubSave.status, 409);

  const badDate = await callApi(worker, env, postJson('/api/notify-movies', {
    endpoint: subscriber.subscription.endpoint,
    movieId: 1, title: 'Ghost', releaseDate: 'soon'
  }));
  equal('a non-calendar releaseDate -> 400', badDate.status, 400);

  const saveRes = await callApi(worker, env, postJson('/api/notify-movies', {
    endpoint: subscriber.subscription.endpoint,
    movieId: 1061474,
    title: 'Superman',
    releaseDate: '2026-12-25',
    url: '/#upcoming',
    confirm: true
  }));
  equal('POST /api/notify-movies -> 201', saveRes.status, 201);
  const saveBody = await saveRes.json();
  check('save reports saved + confirmationSent',
    saveBody.saved === true && saveBody.confirmationSent === true, JSON.stringify(saveBody));
  check('the movie row is keyed by subscriber and movie id',
    store.data.has(`notify:${storedId}:1061474`), [...store.data.keys()].join(', '));

  const openAttack = await callApi(worker, env, postJson('/api/notify-movies', {
    endpoint: subscriber.subscription.endpoint,
    movieId: 2, title: 'Redirect', releaseDate: '2026-12-25',
    url: 'https://evil.example/phish'
  }));
  equal('an absolute notification url is refused -> 201 with a safe url', openAttack.status, 201);
  equal('the stored url is rewritten to a same-origin path',
    JSON.parse(store.data.get(`notify:${storedId}:2`)).url, '/#upcoming');

  // 5e. list
  const listRes = await callApi(worker, env,
    postJson('/api/notify-movies/list', { endpoint: subscriber.subscription.endpoint }));
  equal('POST /api/notify-movies/list -> 200', listRes.status, 200);
  const { movies } = await listRes.json();
  equal('list returns both saved movies', movies.length, 2);
  check('list rows carry the fields the client reads',
    movies.every((m) => Number.isInteger(m.movieId) && m.title && m.releaseDate),
    JSON.stringify(movies));

  const otherList = await callApi(worker, env,
    postJson('/api/notify-movies/list', { endpoint: 'https://fcm.googleapis.com/fcm/send/someone-else' }));
  equal('list is scoped to one subscriber', (await otherList.json()).movies.length, 0);

  // 5f. remove
  const removeRes = await callApi(worker, env, postJson('/api/notify-movies/remove', {
    endpoint: subscriber.subscription.endpoint, movieId: 2
  }));
  equal('POST /api/notify-movies/remove -> 200', removeRes.status, 200);
  equal('remove reports removed', (await removeRes.json()).removed, true);
  check('the row is gone from KV', !store.data.has(`notify:${storedId}:2`));

  const removeAgain = await callApi(worker, env, postJson('/api/notify-movies/remove', {
    endpoint: subscriber.subscription.endpoint, movieId: 2
  }));
  equal('removing twice is idempotent, reporting removed:false',
    (await removeAgain.json()).removed, false);

  // 5g. unsubscribe clears the movie rows too
  const unsubEnv = { ...baseEnv, PUSH_SUBS: fakeKV() };
  await callApi(worker, unsubEnv, postJson('/api/push/subscribe', subscriber.subscription));
  await callApi(worker, unsubEnv, postJson('/api/notify-movies', {
    endpoint: subscriber.subscription.endpoint,
    movieId: 7, title: 'Dune', releaseDate: '2026-12-25'
  }));
  await callApi(worker, unsubEnv,
    postJson('/api/push/unsubscribe', { endpoint: subscriber.subscription.endpoint }));
  equal('unsubscribe leaves no orphaned rows behind', unsubEnv.PUSH_SUBS.data.size, 0);

  // ── 6. process-due ───────────────────────────────────────────────────────
  console.log('\n6. release-day delivery (cron)');
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

  const dueEnv = { ...baseEnv, PUSH_SUBS: fakeKV() };
  await callApi(worker, dueEnv, postJson('/api/push/subscribe', subscriber.subscription));
  await callApi(worker, dueEnv, postJson('/api/notify-movies', {
    endpoint: subscriber.subscription.endpoint,
    movieId: 100, title: 'Out Today', releaseDate: today, confirm: false
  }));
  await callApi(worker, dueEnv, postJson('/api/notify-movies', {
    endpoint: subscriber.subscription.endpoint,
    movieId: 200, title: 'Out Later', releaseDate: future, confirm: false
  }));

  const sentPayloads = [];
  globalThis.fetch = async (url, init) => {
    sentPayloads.push(await decryptAsUserAgent(subscriber, init.body));
    return new Response(null, { status: 201 });
  };

  const dueResult = await worker.processDueNotifications(dueEnv);
  equal('only the released title is checked', dueResult.checked, 1);
  equal('one notification is sent', dueResult.sent, 1);
  equal('nothing failed', dueResult.failed, 0);
  const dueDoc = JSON.parse(sentPayloads[0].plaintext);
  check('the release notification names the movie',
    /Out Today/.test(dueDoc.body), sentPayloads[0].plaintext);
  equal('it deep-links into the upcoming section', dueDoc.url, '/#upcoming');
  check('the unreleased title is untouched',
    JSON.parse(dueEnv.PUSH_SUBS.data.get(`notify:${storedId}:200`)).notifiedAt === null);

  const secondPass = await worker.processDueNotifications(dueEnv);
  equal('a second pass does not send the same notification again', secondPass.sent, 0);

  // A dead subscription must be reaped, not retried forever.
  const deadEnv = { ...baseEnv, PUSH_SUBS: fakeKV() };
  await callApi(worker, deadEnv, postJson('/api/push/subscribe', subscriber.subscription));
  await callApi(worker, deadEnv, postJson('/api/notify-movies', {
    endpoint: subscriber.subscription.endpoint,
    movieId: 300, title: 'Reap Me', releaseDate: today, confirm: false
  }));
  globalThis.fetch = async () => new Response(null, { status: 410 });
  const reaped = await worker.processDueNotifications(deadEnv);
  equal('a 410 counts as failed', reaped.failed, 1);
  equal('a 410 drops the subscription and its rows', deadEnv.PUSH_SUBS.data.size, 0);

  // ── 7. the manual trigger is guarded ─────────────────────────────────────
  console.log('\n7. process-due over HTTP');
  globalThis.fetch = async () => new Response(null, { status: 201 });

  const openEnv = { ...baseEnv, PUSH_SUBS: fakeKV() };
  const openRun = await callApi(worker, openEnv, req('/api/notifications/process-due'));
  equal('with no CRON_SECRET configured the route runs', openRun.status, 200);

  const guarded = { ...baseEnv, PUSH_SUBS: fakeKV(), CRON_SECRET: 's3cret' };
  equal('without the secret -> 403',
    (await callApi(worker, guarded, req('/api/notifications/process-due'))).status, 403);
  equal('with the wrong secret -> 403',
    (await callApi(worker, guarded, req('/api/notifications/process-due?secret=nope'))).status, 403);
  equal('with the secret in the query string -> 200',
    (await callApi(worker, guarded, req('/api/notifications/process-due?secret=s3cret'))).status, 200);
  equal('with the secret in x-cron-secret -> 200',
    (await callApi(worker, guarded, req('/api/notifications/process-due',
      { headers: { 'x-cron-secret': 's3cret' } }))).status, 200);

  // ── 8. storage outage ────────────────────────────────────────────────────
  console.log('\n8. missing KV binding');
  for (const [label, request] of [
    ['subscribe', postJson('/api/push/subscribe', subscriber.subscription)],
    ['notify-movies', postJson('/api/notify-movies', {
      endpoint: subscriber.subscription.endpoint, movieId: 1, title: 'x', releaseDate: today
    })],
    ['notify-movies/list', postJson('/api/notify-movies/list',
      { endpoint: subscriber.subscription.endpoint })]
  ]) {
    const res = await callApi(worker, baseEnv, request);
    equal(label + ' without the PUSH_SUBS binding -> 503', res.status, 503);
  }

  // ── 9. small guards ──────────────────────────────────────────────────────
  console.log('\n9. input helpers');
  check('isCalendarDate accepts YYYY-MM-DD only',
    worker.isCalendarDate('2026-12-25') && !worker.isCalendarDate('25-12-2026')
      && !worker.isCalendarDate('') && !worker.isCalendarDate(20261225));
  equal('safeNotifyUrl keeps a same-origin path', worker.safeNotifyUrl('/movie/123'), '/movie/123');
  equal('safeNotifyUrl rewrites an absolute url',
    worker.safeNotifyUrl('https://evil.example'), '/#upcoming');
  equal('safeNotifyUrl rewrites a protocol-relative url',
    worker.safeNotifyUrl('//evil.example'), '/#upcoming');
  equal('safeNotifyUrl rewrites the backslash variant some parsers accept',
    worker.safeNotifyUrl('/\\evil.example'), '/#upcoming');
  equal('safeNotifyUrl falls back when no url is given',
    worker.safeNotifyUrl(undefined), '/#upcoming');

  const malformed = await callApi(worker, env, req('/api/push/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json'
  }));
  equal('a malformed JSON body -> 400, not a 500', malformed.status, 400);

  // ── 10. edge batching ────────────────────────────────────────────────────
  console.log('\n10. /api/tmdb/batch — the 26-request homepage in one round-trip');

  const batchEnv = () => ({ ...baseEnv, TMDB_TOKEN: 'test-token', TMDB_CACHE: fakeKV() });
  // What the client sends: the plan in a POST body.
  const batchReq = (paths) => postJson('/api/tmdb/batch', { paths });
  // The hand-inspection route, kept for curl.
  const batchGet = (paths) =>
    req('/api/tmdb/batch?r=' + encodeURIComponent(JSON.stringify(paths)));

  const HOME_PLAN = [
    '/movie/now_playing?language=en-US&page=1',
    '/trending/movie/week?language=en-US&page=1',
    '/movie/popular?language=en-US&page=1'
  ];

  let upstreamCalls = [];
  const stubTmdb = (handler) => {
    upstreamCalls = [];
    globalThis.fetch = async (url, init) => {
      upstreamCalls.push(String(url));
      return handler(String(url), init);
    };
  };
  const okPage = (title) => new Response(
    JSON.stringify({ page: 1, results: [{ id: 1, title }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

  stubTmdb((url) => okPage('from ' + new URL(url).pathname));
  const bEnv = batchEnv();
  const bRes = await callApi(worker, bEnv, batchReq(HOME_PLAN));
  equal('a valid batch -> 200', bRes.status, 200);
  check('batch answers application/json', isJson(bRes));
  const bBody = await bRes.json();
  check('the response is an allSettled-shaped array',
    Array.isArray(bBody.results) && bBody.results.length === 3, JSON.stringify(bBody).slice(0, 200));
  check('every entry carries status + value',
    bBody.results.every((r) => r.status === 'fulfilled' && r.value && r.value.results),
    JSON.stringify(bBody.results).slice(0, 200));
  equal('order is preserved, because callers index into it',
    bBody.results[1].value.results[0].title, 'from /3/trending/movie/week');
  equal('one client request fans out to every path', upstreamCalls.length, 3);
  check('the Authorization header is applied by the Worker, never by the caller',
    upstreamCalls.every((u) => u.startsWith('https://api.themoviedb.org/3/')),
    upstreamCalls.join(', '));

  // The scaling property: the second visitor must not re-run the fan-out.
  stubTmdb(() => { throw new Error('upstream must not be touched on a cached batch'); });
  const cachedRes = await callApi(worker, bEnv, batchReq(HOME_PLAN));
  equal('an identical plan is served from cache -> 200', cachedRes.status, 200);
  equal('a cached batch reports x-cache HIT', cachedRes.headers.get('x-cache'), 'HIT');
  equal('a cached batch makes zero upstream calls', upstreamCalls.length, 0);
  equal('the cached body is identical', JSON.stringify(await cachedRes.json()), JSON.stringify(bBody));

  // Per-endpoint entries are shared with /api/tmdb/*, so a single fetch of the
  // same path must not re-hit TMDB either.
  stubTmdb(() => { throw new Error('should have been served from the per-endpoint cache'); });
  const singleRes = await callApi(worker, bEnv,
    req('/api/tmdb/movie/popular?language=en-US&page=1'));
  equal('a single request reuses the entry the batch stored', singleRes.status, 200);
  equal('and reports a cache HIT', singleRes.headers.get('x-cache'), 'HIT');

  // A different plan must be a different cache entry.
  stubTmdb((url) => okPage('from ' + new URL(url).pathname));
  const otherPlan = await callApi(worker, bEnv, batchReq(['/movie/top_rated?page=1']));
  equal('a different plan is a cache miss', otherPlan.headers.get('x-cache'), 'MISS');

  // One dead source must not empty the whole first screen.
  stubTmdb((url) => url.includes('now_playing')
    ? new Response('upstream exploded', { status: 500 })
    : okPage('ok'));
  const partialEnv = batchEnv();
  const partial = await callApi(worker, partialEnv, batchReq(HOME_PLAN));
  equal('a partial failure still answers 200', partial.status, 200);
  const partialBody = await partial.json();
  equal('the failed source is reported as rejected', partialBody.results[0].status, 'rejected');
  equal('the healthy sources still return data', partialBody.results[1].status, 'fulfilled');
  equal('a partial batch reports that it was not stored',
    partial.headers.get('x-batch-stored'), 'no');
  equal('and nothing was written to KV, so one bad moment cannot persist',
    [...partialEnv.TMDB_CACHE.data.keys()].filter((k) => k.startsWith('batch:')).length, 0);

  stubTmdb((url) => okPage('recovered ' + new URL(url).pathname));
  equal('the next request retries instead of serving the partial result',
    (await callApi(worker, partialEnv, batchReq(HOME_PLAN))).headers.get('x-cache'), 'MISS');

  // ── 11. the batch endpoint is not an open proxy ───────────────────────────
  console.log('\n11. batch input validation');
  const rejected = [
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative host', '//evil.example/steal'],
    ['a path traversal', '/movie/../../admin'],
    ['a double slash', '/movie//popular'],
    ['a backslash', '/movie\\popular'],
    ['an empty path', ''],
    ['a non-string entry', 42]
  ];
  for (const [label, path] of rejected) {
    const res = await callApi(worker, batchEnv(), batchReq([path]));
    equal('rejects ' + label + ' -> 400', res.status, 400);
  }
  check('validBatchPath accepts a normal TMDB path with a query',
    worker.validBatchPath('/discover/movie?with_original_language=ko&page=1'));

  const tooMany = await callApi(worker, batchEnv(),
    batchReq(Array(limits.MAX_BATCH_PATHS + 1).fill('/movie/popular?page=1')));
  equal('a batch over the cap -> 400', tooMany.status, 400);
  check('the cap leaves room for the 26-request homepage',
    limits.MAX_BATCH_PATHS >= 26, 'cap is ' + limits.MAX_BATCH_PATHS);

  equal('a missing plan -> 400', (await callApi(worker, batchEnv(), req('/api/tmdb/batch'))).status, 400);
  equal('a malformed plan -> 400',
    (await callApi(worker, batchEnv(), req('/api/tmdb/batch?r=notjson'))).status, 400);
  equal('an empty plan -> 400', (await callApi(worker, batchEnv(), batchReq([]))).status, 400);

  // "batch" must not be forwarded to TMDB as a resource path.
  stubTmdb(() => { throw new Error('/api/tmdb/batch leaked into the generic proxy'); });
  equal('the batch path is never proxied to TMDB as a resource',
    (await callApi(worker, batchEnv(), req('/api/tmdb/batch'))).status, 400);

  // ── 12. the client/worker seam ────────────────────────────────────────────
  /*  The batch only helps if the Worker ACCEPTS what the client sends. If one
   *  real path failed validBatchPath the endpoint would answer 400, tmdbBatch
   *  would swallow it and fall back to 26 individual requests — the site would
   *  work and simply never get faster, with nothing in the logs. So the actual
   *  plan is rebuilt here, using a byte-copy of moviezone.js's _mzTmdbUrl, and
   *  pushed through the real validator.
   */
  console.log('\n12. the real homepage plan survives the worker allowlist');

  const BASE_PATH = '/api/tmdb';
  const clientTmdbUrl = (endpoint, params) => {
    params = params || {};
    let qs = '';
    if (Object.keys(params).length) {
      qs = '?' + Object.entries(params).map(([k, v]) =>
        encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    }
    return BASE_PATH + endpoint + qs;
  };

  const day = (offset) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
  const datedWindow = (extra) => ({
    sort_by: 'popularity.desc',
    'primary_release_date.gte': day(35),
    'primary_release_date.lte': day(0),
    'vote_count.gte': '5',
    page: '1',
    language: 'en-US',
    ...extra
  });

  // Mirrors loadCarousel() (10) + loadMovies('all') (16).
  const REAL_PLAN = [
    ['/trending/movie/week', { language: 'en-US', page: '1' }],
    ['/trending/movie/day', { language: 'en-US', page: '1' }],
    ['/movie/popular', { language: 'en-US', page: '1' }],
    ['/movie/top_rated', { language: 'en-US', page: '1' }],
    ['/movie/now_playing', { language: 'en-US', page: '1' }],
    ['/discover/movie', { with_original_language: 'hi', sort_by: 'popularity.desc', language: 'en-US', page: '1' }],
    ['/discover/movie', { with_original_language: 'ta', sort_by: 'popularity.desc', language: 'en-US', page: '1' }],
    ['/discover/movie', { with_original_language: 'te', sort_by: 'popularity.desc', language: 'en-US', page: '1' }],
    ['/discover/movie', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc', language: 'en-US', page: '1' }],
    ['/discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc', language: 'en-US', page: '1' }],
    ['/discover/movie', datedWindow()],
    ['/discover/movie', datedWindow({ 'vote_count.gte': '20' })],
    ['/discover/movie', datedWindow({ with_origin_country: 'IN' })],
    ['/discover/movie', datedWindow({ with_original_language: 'hi' })],
    ['/discover/movie', { with_origin_country: 'IN', sort_by: 'popularity.desc', 'primary_release_date.lte': day(35), page: '1', language: 'en-US' }],
    ['/discover/tv', { sort_by: 'popularity.desc', 'first_air_date.gte': day(35), 'first_air_date.lte': day(0), page: '1', language: 'en-US' }],
    ['/discover/tv', { with_genres: '16', sort_by: 'popularity.desc', 'first_air_date.gte': day(35), page: '1', language: 'en-US' }],
    ['/trending/tv/week', { language: 'en-US', page: '1' }],
    // Comma and pipe lists are how TMDB takes multi-value filters; both survive
    // encodeURIComponent as %2C / %7C and must survive the allowlist too.
    ['/discover/tv', { with_networks: '213,1024,2739', without_genres: '99,10763', page: '1', language: 'en-US' }],
    ['/discover/movie', { with_watch_providers: '8|119|122', watch_region: 'IN', page: '1', language: 'en-US' }]
  ];

  const realPaths = REAL_PLAN.map(([endpoint, params]) =>
    clientTmdbUrl(endpoint, params).slice(BASE_PATH.length));

  const refused = realPaths.filter((p) => !worker.validBatchPath(p));
  check('every path the homepage builds is accepted by the worker',
    refused.length === 0, 'refused:\n          ' + refused.join('\n          '));

  check('the real plan fits under the batch cap',
    realPaths.length <= limits.MAX_BATCH_PATHS,
    realPaths.length + ' paths vs cap ' + limits.MAX_BATCH_PATHS);

  stubTmdb((url) => okPage(new URL(url).pathname));
  const realEnv = batchEnv();
  const realRes = await callApi(worker, realEnv, batchReq(realPaths));
  equal('the real plan is answered 200', realRes.status, 200);
  const realBody = await realRes.json();
  equal('one request returns one result per source', realBody.results.length, realPaths.length);
  check('every source resolved', realBody.results.every((r) => r.status === 'fulfilled'),
    JSON.stringify(realBody.results.filter((r) => r.status !== 'fulfilled')).slice(0, 300));
  equal('the whole first screen cost the client exactly one request', upstreamCalls.length, realPaths.length);

  stubTmdb(() => { throw new Error('the warmed plan must not re-hit TMDB'); });
  equal('the next visitor is served entirely from KV',
    (await callApi(worker, realEnv, batchReq(realPaths))).headers.get('x-cache'), 'HIT');

  // ── 13. transport ─────────────────────────────────────────────────────────
  /*  The plan travels in a POST body because it does not fit in a URL. Measured
   *  on this 20-path plan, both query-string encodings clear the 2048-character
   *  limit some intermediaries enforce — and a 414 would be swallowed by
   *  tmdbBatch's fallback, quietly leaving the homepage on 26 requests. The
   *  numbers are asserted so nobody "simplifies" this back to a GET.
   */
  console.log('\n13. the plan travels in a body, because it does not fit in a URL');

  const asJsonQuery = '/api/tmdb/batch?r=' + encodeURIComponent(JSON.stringify(realPaths));
  const asBase64Query = '/api/tmdb/batch?r=' + Buffer.from(realPaths.join('\n'))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  check('a JSON query string would be too long', asJsonQuery.length > 2048,
    asJsonQuery.length + ' chars');
  check('base64url would be longer still — it inflates by a third',
    asBase64Query.length > asJsonQuery.length,
    'base64 ' + asBase64Query.length + ' vs json ' + asJsonQuery.length);

  stubTmdb((url) => okPage(new URL(url).pathname));
  const bodyEnv = batchEnv();
  const viaBody = await callApi(worker, bodyEnv, batchReq(realPaths));
  equal('the same plan in a POST body -> 200', viaBody.status, 200);
  equal('and returns one result per path',
    (await viaBody.json()).results.length, realPaths.length);

  // The GET form must describe the same plan, or hand-debugging would warm a
  // different cache entry than production uses.
  stubTmdb(() => { throw new Error('GET and POST disagreed on the cache key'); });
  equal('GET ?r= resolves to the identical cache entry',
    (await callApi(worker, bodyEnv, batchGet(realPaths))).headers.get('x-cache'), 'HIT');

  equal('a POST without a paths array -> 400',
    (await callApi(worker, batchEnv(), postJson('/api/tmdb/batch', { nope: 1 }))).status, 400);
  equal('a malformed POST body -> 400',
    (await callApi(worker, batchEnv(), req('/api/tmdb/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops'
    }))).status, 400);
  equal('DELETE on the batch endpoint -> 405',
    (await callApi(worker, batchEnv(), req('/api/tmdb/batch', { method: 'DELETE' }))).status, 405);

  globalThis.fetch = realFetch;

  console.log('\n' + '-'.repeat(74));
  console.log('  ' + checks + ' checks, ' + (failures ? failures + ' FAILED' : 'all passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('\nworker-push.test.js crashed:', err);
  process.exit(1);
});
