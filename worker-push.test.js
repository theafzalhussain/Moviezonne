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

  const source = fs.readFileSync(WORKER_FILE, 'utf8');
  const worker = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );

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
  equal('record size field matches RECORD_SIZE', opened.recordSize, worker.RECORD_SIZE);
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

  globalThis.fetch = realFetch;

  console.log('\n' + '-'.repeat(74));
  console.log('  ' + checks + ' checks, ' + (failures ? failures + ' FAILED' : 'all passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('\nworker-push.test.js crashed:', err);
  process.exit(1);
});
