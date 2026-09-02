#!/usr/bin/env node
/**
 * Generates the VAPID keypair that identifies this push service.
 * Run once:  node gen-vapid.mjs
 *
 * The PUBLIC key goes in the web app (js/push.js).
 * The PRIVATE key is a secret:  npx wrangler secret put VAPID_PRIVATE_KEY
 */
import { webcrypto as crypto } from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
);
const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

console.log('\nVAPID keypair generated.\n');
console.log('PUBLIC KEY  (paste into js/push.js as VAPID_PUBLIC_KEY):');
console.log(b64url(pub));
console.log('\nPRIVATE KEY (keep secret — npx wrangler secret put VAPID_PRIVATE_KEY):');
console.log(jwk.d);
console.log('\nPKCS8 (if a tool asks for it):');
console.log(b64url(priv));
console.log('');
