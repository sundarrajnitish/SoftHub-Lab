// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// A faithful, in-memory stand-in for the parts of Stripe the marketplace uses.
//
// Server side (secret key):  paymentIntents create / cancel, refunds.
// Browser side (publishable): confirmCardPayment + 3-D Secure next action.
// Webhooks: every state change becomes an event, signed exactly like Stripe
// (t=…,v1=HMAC) and delivered asynchronously to registered endpoints — with
// configurable latency, duplicate deliveries, out-of-order arrival and
// retries with back-off when the endpoint fails. That is the behaviour the
// fulfilment design has to survive, so the simulator and the website's
// payments lab can switch each one on.

import { signWebhook, luhnValid } from '../payments.js';
import { AppError, stableStringify } from '../util.js';

const OUTCOME_BY_CARD = {
  '4242424242424242': 'succeeds',
  '4000002500003155': 'requires_action',
  '4000000000000002': 'card_declined',
  '4000000000009995': 'insufficient_funds',
  '4000000000000069': 'expired_card',
};

const DECLINE_MESSAGES = {
  card_declined: 'Your card was declined.',
  insufficient_funds: 'Your card has insufficient funds.',
  expired_card: 'Your card has expired.',
};

export const RETRY_SCHEDULE_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];

export function createFakeStripe({
  clock, rng, schedule, webhookSecret = 'whsec_local',
  chaos = {}, // {duplicateRate, latencyMs, jitterMs, dropFirstAttemptRate}
  listener = null, // (record) → trace of API calls, events and deliveries
}) {
  const intents = new Map();
  const bySecret = new Map();
  const idem = new Map(); // idempotency key → {fingerprint, id}
  const endpoints = [];
  const events = [];
  let seq = 0;
  const id = (p) => `${p}_${(++seq).toString(36).padStart(6, '0')}${Math.floor(rng.next() * 36 ** 6).toString(36).padStart(6, '0')}`;
  const cfg = () => ({ duplicateRate: 0, latencyMs: 400, jitterMs: 300, dropFirstAttemptRate: 0, ...chaos });
  const log = (rec) => listener && listener({ at: clock.now(), ...rec });

  function snapshot(pi) {
    return {
      id: pi.id, object: 'payment_intent', amount: pi.amount, currency: pi.currency, status: pi.status,
      metadata: { ...pi.metadata }, created: Math.floor(pi.created / 1000),
      last_payment_error: pi.lastError ? { code: pi.lastError, message: DECLINE_MESSAGES[pi.lastError] } : null,
      amount_received: pi.status === 'succeeded' ? pi.amount : 0, amount_refunded: pi.refunded || 0,
    };
  }

  function emit(type, pi) {
    const evt = {
      id: id('evt'), object: 'event', type, api_version: '2024-06-20', created: Math.floor(clock.now() / 1000),
      livemode: false, data: { object: snapshot(pi) },
    };
    events.push(evt);
    log({ kind: 'event', type, eventId: evt.id, paymentIntent: pi.id });
    for (const ep of endpoints) {
      const c = cfg();
      const delay = Math.max(20, c.latencyMs + (rng.next() * 2 - 1) * c.jitterMs);
      schedule(delay, () => deliver(ep, evt, 0));
      if (rng.chance(c.duplicateRate)) {
        schedule(delay + 200 + rng.next() * 4000, () => deliver(ep, evt, 0, true));
      }
    }
    return evt;
  }

  async function deliver(ep, evt, attempt, duplicate = false) {
    const raw = JSON.stringify(evt);
    const header = signWebhook(webhookSecret, raw, Math.floor(clock.now() / 1000));
    let status;
    if (attempt === 0 && rng.chance(cfg().dropFirstAttemptRate)) {
      status = 'timeout';
    } else {
      try {
        const res = await ep.handler(raw, { 'stripe-signature': header, 'content-type': 'application/json' });
        status = res.status;
      } catch (e) {
        status = 500;
      }
    }
    const ok = typeof status === 'number' && status >= 200 && status < 300;
    log({ kind: 'delivery', eventId: evt.id, type: evt.type, attempt: attempt + 1, status, duplicate, ok });
    if (!ok && attempt < RETRY_SCHEDULE_MS.length) {
      schedule(RETRY_SCHEDULE_MS[attempt], () => deliver(ep, evt, attempt + 1, duplicate));
    }
  }

  const api = {
    webhookSecret,
    addEndpoint(handler) { endpoints.push({ handler }); },
    setChaos(next) { Object.assign(chaos, next); },

    // ------------------------------------------------ server-side API
    async createPaymentIntent({ amount, currency = 'cad', metadata = {}, idempotencyKey, description }) {
      if (!Number.isInteger(amount) || amount < 50) {
        throw new AppError(400, 'stripe.amount_too_small', 'Amount must be at least 50 cents');
      }
      const fp = stableStringify({ amount, currency, metadata });
      if (idempotencyKey && idem.has(idempotencyKey)) {
        const prev = idem.get(idempotencyKey);
        if (prev.fingerprint !== fp) {
          throw new AppError(400, 'stripe.idempotency_error', 'Keys for idempotent requests can only be used with the same parameters');
        }
        const pi = intents.get(prev.id);
        log({ kind: 'api', call: 'POST /v1/payment_intents', idempotent: true, paymentIntent: pi.id });
        return pub(pi);
      }
      const pi = {
        id: id('pi'), amount, currency, metadata: { ...metadata }, description, status: 'requires_payment_method',
        created: clock.now(), lastError: null, refunded: 0,
      };
      pi.clientSecret = `${pi.id}_secret_${Math.floor(rng.next() * 36 ** 8).toString(36)}`;
      intents.set(pi.id, pi);
      bySecret.set(pi.clientSecret, pi);
      if (idempotencyKey) idem.set(idempotencyKey, { fingerprint: fp, id: pi.id });
      log({ kind: 'api', call: 'POST /v1/payment_intents', paymentIntent: pi.id, amount });
      return pub(pi);
    },

    async cancel(paymentIntentId) {
      const pi = intents.get(paymentIntentId);
      if (!pi) throw new AppError(404, 'stripe.no_such_intent', 'No such payment intent');
      if (pi.status === 'succeeded') throw new AppError(400, 'stripe.cannot_cancel', 'Payment already succeeded');
      if (pi.status !== 'canceled') { pi.status = 'canceled'; emit('payment_intent.canceled', pi); }
      return pub(pi);
    },

    async refund({ paymentIntentId, amount, reason = 'requested_by_customer' }) {
      const pi = intents.get(paymentIntentId);
      if (!pi || pi.status !== 'succeeded') throw new AppError(400, 'stripe.not_refundable', 'Nothing to refund');
      const amt = amount ?? pi.amount - pi.refunded;
      if (amt <= 0 || pi.refunded + amt > pi.amount) throw new AppError(400, 'stripe.refund_amount', 'Refund exceeds charge');
      pi.refunded += amt;
      log({ kind: 'api', call: 'POST /v1/refunds', paymentIntent: pi.id, amount: amt, reason });
      emit('charge.refunded', pi);
      return { id: id('re'), amount: amt };
    },

    // ------------------------------------------------ browser side (Stripe.js)
    async confirmCardPayment(clientSecret, card) {
      const pi = bySecret.get(clientSecret);
      if (!pi) return { error: { type: 'invalid_request_error', message: 'No such payment intent' } };
      if (pi.status === 'succeeded') return { paymentIntent: snapshot(pi) };
      if (pi.status === 'canceled') return { error: { type: 'invalid_request_error', message: 'This payment was cancelled' } };
      const number = String(card?.number || '').replace(/\D/g, '');
      if (!luhnValid(number)) return { error: { type: 'validation_error', code: 'incorrect_number', message: 'Your card number is invalid.' } };
      if (!/^\d{3,4}$/.test(String(card?.cvc || ''))) return { error: { type: 'validation_error', code: 'incomplete_cvc', message: "Your card's security code is incomplete." } };
      const exp = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(card?.exp || ''));
      const expEnd = exp ? Date.UTC(2000 + Number(exp[2]), Number(exp[1]), 1) : 0;
      if (!exp || Number(exp[1]) < 1 || Number(exp[1]) > 12 || expEnd <= clock.now()) {
        return { error: { type: 'validation_error', code: 'invalid_expiry', message: "Your card's expiration date is invalid." } };
      }
      const outcome = OUTCOME_BY_CARD[number] || 'succeeds';
      log({ kind: 'api', call: 'POST /v1/payment_intents/:id/confirm', paymentIntent: pi.id, outcome });
      if (outcome === 'succeeds') return succeed(pi);
      if (outcome === 'requires_action') {
        pi.status = 'requires_action';
        return { paymentIntent: snapshot(pi), requiresAction: true };
      }
      return decline(pi, outcome);
    },

    /** Resolve 3-D Secure: the cardholder approves or fails the challenge. */
    async handleNextAction(clientSecret, approve) {
      const pi = bySecret.get(clientSecret);
      if (!pi || pi.status !== 'requires_action') return { error: { message: 'Nothing to authenticate' } };
      log({ kind: 'api', call: '3-D Secure challenge', paymentIntent: pi.id, approved: approve });
      return approve ? succeed(pi) : decline(pi, 'authentication_failed');
    },

    retrieve: (piId) => (intents.has(piId) ? snapshot(intents.get(piId)) : null),
    _events: events,
    _intents: intents,
  };

  function succeed(pi) {
    pi.status = 'succeeded';
    pi.lastError = null;
    emit('payment_intent.succeeded', pi);
    return { paymentIntent: snapshot(pi) };
  }
  function decline(pi, code) {
    pi.status = 'requires_payment_method';
    pi.lastError = code;
    emit('payment_intent.payment_failed', pi);
    return { error: { type: 'card_error', code, message: DECLINE_MESSAGES[code] || 'Authentication failed.' }, paymentIntent: snapshot(pi) };
  }
  const pub = (pi) => ({ id: pi.id, clientSecret: pi.clientSecret, status: pi.status, amount: pi.amount, currency: pi.currency });
  return api;
}
