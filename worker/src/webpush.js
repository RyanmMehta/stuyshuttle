/**
 * Web Push, standards-exact, on WebCrypto only.
 *
 *   RFC 8291  Message Encryption for Web Push   (content-encoding: aes128gcm)
 *   RFC 8292  VAPID                              (Authorization: vapid t=…, k=…)
 *
 * Why hand-rolled: the library we first used emits the pre-standard `aesgcm`
 * encoding and the pre-standard `Authorization: WebPush …` header. Chrome and
 * Firefox tolerate those; Apple's push service (iPhone) does not. This module
 * is verified against the RFC 8291 Appendix A test vector in tools/test-worker.mjs.
 */

const te = new TextEncoder();

export const b64u = {
  enc(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** Import a raw 65-byte uncompressed P-256 point as an ECDH public key. */
const importUaPublic = (raw) =>
  crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

/**
 * Encrypt `plaintext` for the subscriber (RFC 8291 §3, single record).
 *
 * @param {object} o
 * @param {Uint8Array} o.plaintext
 * @param {Uint8Array} o.uaPublic     subscriber's p256dh (65 bytes)
 * @param {Uint8Array} o.authSecret   subscriber's auth (16 bytes)
 * @param {Uint8Array} [o.salt]       16 random bytes (fixed only in tests)
 * @param {{privateKey: CryptoKey, publicRaw: Uint8Array}} [o.asKeys]  fixed only in tests
 * @returns {Promise<Uint8Array>} aes128gcm body: salt | rs | idlen | as_public | ciphertext
 */
export async function encryptAes128gcm({ plaintext, uaPublic, authSecret, salt, asKeys }) {
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  let asPrivate, asPublic;
  if (asKeys) {
    asPrivate = asKeys.privateKey; asPublic = asKeys.publicRaw;
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }

  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importUaPublic(uaPublic) }, asPrivate, 256));

  // IKM = HKDF(salt=auth_secret, IKM=ecdh_secret, info="WebPush: info"||0||ua_public||as_public, 32)
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  // CEK / NONCE = HKDF(salt, IKM, "Content-Encoding: aes128gcm"||0 / "Content-Encoding: nonce"||0)
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  // RFC 8188: each record ends with a delimiter; 0x02 marks the last record.
  const padded = concat(plaintext, new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded));

  const rs = 4096;
  const header = concat(salt, new Uint8Array([rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

/**
 * RFC 8292 Authorization header: `vapid t=<JWT>, k=<public key>`.
 * `publicKey` is the base64url raw 65-byte point; `privateKey` is the JWK `d`.
 */
export async function vapidAuthorization({ endpoint, subject, publicKey, privateKey, expiresInSec = 12 * 3600, now = Date.now() }) {
  const pub = b64u.dec(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a raw uncompressed P-256 point');
  const key = await crypto.subtle.importKey('jwk',
    { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)), d: privateKey },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + expiresInSec, sub: subject,
  })));
  // WebCrypto ECDSA returns raw r||s (64 bytes) — exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u.enc(sig)}, k=${publicKey}`;
}

/**
 * Everything needed for `fetch(subscription.endpoint, request)`.
 * `data` is JSON-serialised; keep it under ~3.5 KB (single record).
 */
export async function buildPushRequest({ subscription, data, vapid, ttl = 60, urgency = 'normal', topic = null }) {
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error('subscription needs endpoint, keys.p256dh and keys.auth');
  }
  const plaintext = te.encode(typeof data === 'string' ? data : JSON.stringify(data));
  if (plaintext.length > 3800) throw new Error('payload too large for a single record');
  const body = await encryptAes128gcm({
    plaintext,
    uaPublic: b64u.dec(subscription.keys.p256dh),
    authSecret: b64u.dec(subscription.keys.auth),
  });
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.byteLength),
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidAuthorization({ endpoint: subscription.endpoint, ...vapid }),
  };
  if (topic) headers.Topic = topic;
  return { method: 'POST', headers, body };
}
