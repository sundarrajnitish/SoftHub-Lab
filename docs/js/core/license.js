// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Licence keys.
//
//   SHUB-7Q2KD-M9XWA-0RTZ4-HC81N
//        └────── 18 symbols ─────┘└┴ 2 check symbols
//
// The 18 payload symbols are the first 90 bits of
// HMAC-SHA256(secret, "orderId|productId|sub") in Crockford base32, so the key:
//   • is deterministic — fulfilling the same order twice (webhook retry) yields
//     the same key instead of a second, different one;
//   • cannot be forged without the secret, and is bound to one buyer + product;
//   • carries a position-weighted checksum (mod the prime 1021, written as two
//     symbols), so any single wrong character and any swap of two neighbouring
//     characters is caught offline, before any network call.
// Crockford base32 has no I, L, O or U and decodes 0/O and 1/I/L alike, which
// matters for keys people type in from an e-mail.

import { hmacSha256 } from './crypto.js';
import { CROCKFORD } from './util.js';

function bitsToSymbols(bytes, count) {
  let out = '';
  let acc = 0, bits = 0, i = 0;
  while (out.length < count) {
    if (bits < 5) { acc = (acc << 8) | bytes[i++]; bits += 8; }
    bits -= 5;
    out += CROCKFORD[(acc >> bits) & 31];
    acc &= (1 << bits) - 1;
  }
  return out;
}

const PAYLOAD = 18;
// A typo changes the weighted sum by w·d with 1 ≤ w ≤ 18 and 0 < |d| ≤ 31, i.e. by
// at most 558 — never a multiple of 1021, so it always changes the checksum. An
// adjacent swap changes it by ±d, likewise never 0 mod 1021.
const P = 1021;

export function checkSymbols(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += (i + 1) * CROCKFORD.indexOf(payload[i]);
  const c = sum % P;
  return CROCKFORD[c >> 5] + CROCKFORD[c & 31];
}

export function generateLicenseKey(secret, { orderId, productId, sub }) {
  const mac = hmacSha256(secret, `${orderId}|${productId}|${sub}`);
  const payload = bitsToSymbols(mac, PAYLOAD);
  const raw = payload + checkSymbols(payload);
  return `SHUB-${raw.match(/.{5}/g).join('-')}`;
}

/** Normalise user input: upper-case, strip separators, map look-alikes. */
export function normaliseKey(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.startsWith('SHUB') ? s.slice(4) : s;
}

/** Offline check: right length, alphabet and check symbol. */
export function isWellFormedKey(input) {
  const s = normaliseKey(input);
  if (s.length !== 20 || [...s].some((ch) => !CROCKFORD.includes(ch))) return false;
  return checkSymbols(s.slice(0, PAYLOAD)) === s.slice(PAYLOAD);
}

/** Full check against the purchase it claims to belong to. */
export function verifyLicenseKey(secret, input, purchase) {
  if (!isWellFormedKey(input)) return false;
  return normaliseKey(generateLicenseKey(secret, purchase)) === normaliseKey(input);
}
