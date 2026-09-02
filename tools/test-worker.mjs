// Exercise the worker's pure decision helpers against realistic inputs.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../worker/src/index.js', import.meta.url),'utf8');

// Pull out the pure helpers we want to test. The worker imports the web-push
// library (not needed here) and the shared text helpers (re-imported below by
// absolute URL, since a data: module can't resolve relative paths).
const textUrl = new URL('../js/text.js', import.meta.url).href;
const webpushUrl = new URL('../worker/src/webpush.js', import.meta.url).href;
const body = src
  .replace(/^import .*$/gm, '')
  .replace(/^export default \{[\s\S]*?\n\};$/m, '');
const mod = await import('data:text/javascript,' + encodeURIComponent(
  `import { htmlToText, isRelevantAlert } from '${textUrl}';\n` +
  `import { buildPushRequest } from '${webpushUrl}';\n` +
  body + '\nexport { checkWindow, parseEtaText, parseClock, fmt };'
));
const wp = await import(webpushUrl);

let pass=0, fail=0;
const ck=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`  ${ok?'PASS':'FAIL'}  ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};

console.log('\n== clock formatting ==');
ck('450 -> 7:30 AM', mod.fmt(450), '7:30 AM');
ck('720 -> 12:00 PM', mod.fmt(720), '12:00 PM');
ck('1005 -> 4:45 PM', mod.fmt(1005), '4:45 PM');
ck('0 -> 12:00 AM', mod.fmt(0), '12:00 AM');

console.log('\n== parseClock ==');
ck('7:30 AM', mod.parseClock('7:30 AM'), 450);
ck('12:40 PM', mod.parseClock('12:40 PM'), 760);
ck('junk', mod.parseClock('soon'), null);

console.log('\n== parseEtaText ==');
ck('24 min', mod.parseEtaText('24 min '), 24);
ck('1h 11min', mod.parseEtaText('1h 11min '), 71);
ck('--', mod.parseEtaText('--'), null);
ck('1-2 min → 1', mod.parseEtaText('1-2 min'), 1);

console.log('\n== service window (DST-safe, local NY time) ==');
// checkWindow(now).morning: Mon–Fri 06:45–11:15 New York time. Covers Route C
// (Mon–Thu) and Route E's Friday morning runs. Alerts relay at any hour.
const w = (iso) => mod.checkWindow(new Date(iso)).morning;
// 2026-09-02 is a Wednesday. 12:00 UTC = 8:00 AM EDT.
ck('Wed 8am EDT active',            w('2026-09-02T12:00:00Z'), true);
ck('Wed 6:30am EDT inactive',       w('2026-09-02T10:30:00Z'), false);
ck('Wed 6:45am EDT active (start)', w('2026-09-02T10:45:00Z'), true);
ck('Wed 11:15am EDT active (end)',  w('2026-09-02T15:15:00Z'), true);
ck('Wed 11:20am EDT inactive',      w('2026-09-02T15:20:00Z'), false);
ck('Tue 10pm EDT inactive',         w('2026-09-02T02:00:00Z'), false);
ck('Fri 8am active (Route E runs)', w('2026-09-04T12:00:00Z'), true);
ck('Sat 8am inactive',              w('2026-09-05T12:00:00Z'), false);
ck('Sun 8am inactive',              w('2026-09-06T12:00:00Z'), false);
// Winter: 2026-12-02 is a Wednesday. 13:00 UTC = 8:00 AM EST.
ck('Winter Wed 8am EST active',     w('2026-12-02T13:00:00Z'), true);
ck('Winter Wed 7am EST active',     w('2026-12-02T12:00:00Z'), true);
ck('Winter Wed 6am EST inactive',   w('2026-12-02T11:00:00Z'), false);
// The old summer-only cron range would have stopped at 15:00 UTC = 10:00 AM EST;
// the window must still be open at 11:00 AM EST = 16:00 UTC.
ck('Winter Wed 11am EST active',    w('2026-12-02T16:00:00Z'), true);

console.log('\n== RFC 8291 Appendix A test vector (aes128gcm) ==');
{
  const { b64u, encryptAes128gcm } = wp;
  const V = {
    plaintext: 'When I grow up, I want to be a watermelon',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    uaPublic:  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPublic:  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    auth:      'BTBZMqHH6r4Tts7J_aSIgg',
    salt:      'DGv6ra1nlYgDCS1FRnbzlw',
    expected:  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };
  const asPub = b64u.dec(V.asPublic);
  const asPriv = await crypto.subtle.importKey('jwk',
    { kty: 'EC', crv: 'P-256', x: b64u.enc(asPub.subarray(1, 33)), y: b64u.enc(asPub.subarray(33, 65)), d: V.asPrivate },
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const out = await encryptAes128gcm({
    plaintext: new TextEncoder().encode(V.plaintext), uaPublic: b64u.dec(V.uaPublic),
    authSecret: b64u.dec(V.auth), salt: b64u.dec(V.salt), asKeys: { privateKey: asPriv, publicRaw: asPub },
  });
  ck('ciphertext matches the RFC 8291 vector byte-for-byte', b64u.enc(out), V.expected);
  ck('body length 144 (21-byte header + 65-byte key + 42+1 plaintext + 16 tag)', out.length, 144);
}

console.log('\n== encrypt → decrypt round trip with a fresh subscriber key ==');
{
  const { b64u, encryptAes128gcm } = wp;
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = JSON.stringify({ title: 'Shuttle running 18 min late', body: 'Leave around 10:40.' });
  const body = await encryptAes128gcm({ plaintext: new TextEncoder().encode(msg), uaPublic, authSecret: auth });
  // decrypt as the browser would (RFC 8291 §3 from the subscriber side)
  const salt = body.subarray(0, 16), rs = (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19];
  const idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info },
    await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = new TextEncoder();
  const keyInfo = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hk(auth, secret, keyInfo, 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cekKey, ct));
  ck('record size header = 4096', rs, 4096);
  ck('key id length = 65', idlen, 65);
  ck('last-record delimiter 0x02', plain[plain.length - 1], 2);
  ck('plaintext round-trips', new TextDecoder().decode(plain.subarray(0, plain.length - 1)), msg);
}

console.log('\n== RFC 8292 VAPID authorization ==');
{
  const { b64u, vapidAuthorization, buildPushRequest } = wp;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubRaw = b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey));
  const d = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
  const endpoint = 'https://web.push.apple.com/QAbC123';
  const auth = await vapidAuthorization({ endpoint, subject: 'mailto:test@example.com', publicKey: pubRaw, privateKey: d, now: 1_700_000_000_000 });
  ck('header form is "vapid t=…, k=…"', /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/.test(auth), true);
  const jwt = /t=([^,]+)/.exec(auth)[1], [h, c, sig] = jwt.split('.');
  const hdr = JSON.parse(new TextDecoder().decode(b64u.dec(h))), claims = JSON.parse(new TextDecoder().decode(b64u.dec(c)));
  ck('alg ES256', [hdr.alg, hdr.typ], ['ES256', 'JWT']);
  ck('aud is the push service origin', claims.aud, 'https://web.push.apple.com');
  ck('exp = now + 12h', claims.exp, 1_700_000_000 + 12 * 3600);
  ck('sub is the mailto', claims.sub, 'mailto:test@example.com');
  const okSig = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, b64u.dec(sig), new TextEncoder().encode(`${h}.${c}`));
  ck('signature verifies with the public key', okSig, true);
  ck('k= is the same public key the app holds', /k=([^,]+)$/.exec(auth)[1], pubRaw);

  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sub = { endpoint, keys: { p256dh: b64u.enc(await crypto.subtle.exportKey('raw', ua.publicKey)), auth: b64u.enc(crypto.getRandomValues(new Uint8Array(16))) } };
  const req = await buildPushRequest({ subscription: sub, data: { title: 't' }, vapid: { subject: 'mailto:test@example.com', publicKey: pubRaw, privateKey: d }, ttl: 900, urgency: 'high' });
  ck('request headers are the RFC set', Object.keys(req.headers).sort(), ['Authorization', 'Content-Encoding', 'Content-Length', 'Content-Type', 'TTL', 'Urgency']);
  ck('content-encoding aes128gcm', req.headers['Content-Encoding'], 'aes128gcm');
  ck('no legacy Crypto-Key/Encryption headers', 'Crypto-Key' in req.headers || 'Encryption' in req.headers, false);
}

console.log(`\n${fail?'FAILURES':'ALL PASS'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
