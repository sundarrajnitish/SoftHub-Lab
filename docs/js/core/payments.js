// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Payment provider port + webhook signatures.
//
// Port (implemented by services/aws/src/stripe.js and adapters/fake-stripe.js):
//   createPaymentIntent({amount, currency, metadata, idempotencyKey, description})
//       → {id, clientSecret, status, amount, currency}
//   refund({paymentIntentId, amount, reason})  → {id, amount}
//   cancel(paymentIntentId)                     → {id, status}
//
// Stripe signs every webhook: header `Stripe-Signature: t=<unix>,v1=<hex>` with
//   v1 = HMAC-SHA256(endpointSecret, "<t>.<raw request body>")
// The handler must verify against the *raw* body (re-serialised JSON would not
// match) and reject timestamps outside a tolerance window to stop replays.

import { hmacSha256, toHex, safeEqual } from './crypto.js';
import { AppError } from './util.js';

export const SIGNATURE_TOLERANCE_SEC = 300;

export function signWebhook(secret, rawBody, timestampSec) {
  const v1 = toHex(hmacSha256(secret, `${timestampSec}.${rawBody}`));
  return `t=${timestampSec},v1=${v1}`;
}

export function verifyWebhook(secret, rawBody, header, nowMs, tolerance = SIGNATURE_TOLERANCE_SEC) {
  if (!header || typeof header !== 'string') {
    throw new AppError(400, 'webhook.signature', 'Missing Stripe-Signature header');
  }
  const parts = Object.create(null);
  const v1s = [];
  for (const kv of header.split(',')) {
    const [k, v] = kv.split('=');
    if (k === 'v1') v1s.push(v); else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !v1s.length) throw new AppError(400, 'webhook.signature', 'Malformed signature header');
  const expected = toHex(hmacSha256(secret, `${t}.${rawBody}`));
  if (!v1s.some((s) => safeEqual(s, expected))) throw new AppError(400, 'webhook.signature', 'Signature mismatch');
  if (Math.abs(nowMs / 1000 - t) > tolerance) throw new AppError(400, 'webhook.replay', 'Timestamp outside tolerance');
  return JSON.parse(rawBody);
}

/** Stripe's standard Canadian card pricing (stripe.com/en-ca/pricing, Oct 2026). */
export const CARD_FEE = { percent: 2.9, fixedCents: 30 };
export const cardFee = (amountCents) => Math.round((amountCents * CARD_FEE.percent) / 100) + CARD_FEE.fixedCents;

/** Platform commission on each sale (business rule of this marketplace). */
export const PLATFORM_COMMISSION = 0.1;

export const TEST_CARDS = [
  { number: '4242 4242 4242 4242', outcome: 'succeeds', label: 'Visa — succeeds' },
  { number: '4000 0025 0000 3155', outcome: 'requires_action', label: 'Visa — asks for 3-D Secure' },
  { number: '4000 0000 0000 0002', outcome: 'card_declined', label: 'Visa — generic decline' },
  { number: '4000 0000 0000 9995', outcome: 'insufficient_funds', label: 'Visa — insufficient funds' },
  { number: '4000 0000 0000 0069', outcome: 'expired_card', label: 'Visa — expired card' },
];

export function luhnValid(number) {
  const digits = String(number).replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
