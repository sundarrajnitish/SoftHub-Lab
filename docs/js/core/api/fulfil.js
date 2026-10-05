// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Stripe webhook → exactly-once fulfilment; DynamoDB stream → e-mail.
//
// Stripe delivers events at least once, possibly late, duplicated or out of
// order, and retries for days when we answer non-2xx. The handler therefore:
//   1. verifies the signature on the raw body (and the timestamp window);
//   2. applies the effect and records the event id in ONE transaction, with a
//      state-machine condition on the order — so a duplicate, a replay, or a
//      late `payment_failed` after `succeeded` changes nothing;
//   3. writes the receipt e-mail to an outbox row inside that same
//      transaction; a stream consumer sends it. The e-mail is sent if and only
//      if the order was paid.

import { K } from '../keys.js';
import { verifyWebhook, cardFee, PLATFORM_COMMISSION } from '../payments.js';
import { ConditionFailed } from '../store.js';
import { generateLicenseKey } from '../license.js';
import { formatCents, isoDay } from '../util.js';
import { Response } from './router.js';
import { loadOrder } from './shop.js';
import { invalidateCatalogue } from './catalog.js';

const EVENT_TTL_SEC = 30 * 24 * 3600;

/** Order state machine: which event may move an order from which state. */
export const TRANSITIONS = {
  'payment_intent.succeeded': { from: ['PENDING_PAYMENT', 'CANCELLED'], to: 'PAID' },
  'payment_intent.payment_failed': { from: ['PENDING_PAYMENT'], to: 'PENDING_PAYMENT' },
  'payment_intent.canceled': { from: ['PENDING_PAYMENT'], to: 'CANCELLED' },
  'charge.refunded': { from: ['PAID', 'PARTIALLY_REFUNDED'], to: 'REFUNDED' },
};

export async function stripeWebhook(ctx) {
  const { deps } = ctx;
  const event = verifyWebhook(deps.config.webhookSecret, ctx.body, ctx.headers['stripe-signature'], deps.clock.now());
  ctx.log('webhook.verified', { eventId: event.id, type: event.type });
  const pi = event.data?.object;
  const orderId = pi?.metadata?.orderId;
  if (!TRANSITIONS[event.type] || !orderId) {
    ctx.log('webhook.ignored', { type: event.type });
    return new Response(200, { received: true, ignored: true });
  }
  const result = await applyEvent(deps, event, ctx.log);
  return new Response(200, { received: true, ...result });
}

export async function applyEvent(deps, event, log = () => {}) {
  const pi = event.data.object;
  const orderId = pi.metadata.orderId;
  const seen = await deps.table.get(K.event(event.id), { consistent: true });
  if (seen) { log('webhook.duplicate', { eventId: event.id }); return { duplicate: true }; }
  const order = await loadOrder(deps, orderId);
  if (!order) { log('webhook.unknown_order', { orderId }); return { unknownOrder: true }; }
  const { meta } = order;
  if (meta.paymentIntentId !== pi.id) { log('webhook.mismatch', { orderId }); return { mismatch: true }; }
  const rule = TRANSITIONS[event.type];
  if (!rule.from.includes(meta.status)) {
    // e.g. payment_failed arriving after succeeded: record the event, change nothing
    await markSeen(deps, event).catch(() => {});
    log('webhook.stale', { status: meta.status, type: event.type });
    return { stale: true, status: meta.status };
  }
  try {
    switch (event.type) {
      case 'payment_intent.succeeded': return await fulfil(deps, event, order, log);
      case 'payment_intent.payment_failed': return await failed(deps, event, meta, log);
      case 'payment_intent.canceled': return await cancelled(deps, event, meta, log);
      case 'charge.refunded': return await refunded(deps, event, order, log);
      default: return { ignored: true };
    }
  } catch (e) {
    if (e instanceof ConditionFailed) {
      const eventReason = e.details.reasons.find((r) => r.key.PK === `EVENT#${event.id}`);
      if (eventReason && eventReason.code !== 'None') { log('webhook.duplicate', { eventId: event.id, race: true }); return { duplicate: true }; }
      log('webhook.conflict', { reasons: e.details.reasons.filter((r) => r.code !== 'None').map((r) => r.key) });
    }
    throw e; // 5xx → Stripe retries later
  }
}

const markSeen = (deps, event) => deps.table.put(
  { ...K.event(event.id), type: 'StripeEvent', eventType: event.type, ttl: Math.floor(deps.clock.now() / 1000) + EVENT_TTL_SEC },
  { condition: { exists: false } },
);

const eventPut = (deps, event) => ({ put: { item: {
  ...K.event(event.id), type: 'StripeEvent', eventType: event.type,
  ttl: Math.floor(deps.clock.now() / 1000) + EVENT_TTL_SEC,
}, condition: { exists: false } } });

async function fulfil(deps, event, order, log) {
  const { meta, lines } = order;
  const pi = event.data.object;
  const now = deps.clock.now();
  const day = isoDay(now);
  const sub = meta.sub;

  // Lines the buyer already owns (bought in a parallel order) are refunded, not duplicated.
  const ownedChecks = await deps.table.batchGet(lines.map((l) => K.owns(sub, l.productId)));
  const alreadyOwned = new Set(ownedChecks.filter((o) => o.status === 'ACTIVE').map((o) => o.productId));
  const grant = lines.filter((l) => !alreadyOwned.has(l.productId));
  const refundCents = lines.filter((l) => alreadyOwned.has(l.productId)).reduce((a, l) => a + l.priceCents, 0);
  const profile = await deps.table.get(K.profile(sub));
  const email = profile?.email;

  const keys = new Map(grant.map((l) => [l.productId, generateLicenseKey(deps.config.licenseSecret, { orderId: meta.orderId, productId: l.productId, sub })]));
  const salesByKey = new Map();
  for (const l of grant) {
    const k = `${l.providerSub}|${l.productId}`;
    salesByKey.set(k, { providerSub: l.providerSub, productId: l.productId, units: 1, revenue: l.priceCents });
  }
  const fee = cardFee(pi.amount);
  const ops = [
    eventPut(deps, event),
    { update: { key: K.order(meta.orderId), set: {
      status: 'PAID', paidAt: now, feeCents: fee, refundedCents: refundCents,
    }, condition: [{ attr: 'status', in: TRANSITIONS[event.type].from }, { attr: 'amountCents', eq: pi.amount }] } },
    ...lines.map((l) => ({ update: { key: K.orderLine(meta.orderId, l.productId), set: alreadyOwned.has(l.productId)
      ? { status: 'REFUNDED_DUPLICATE' } : { status: 'ACTIVE', licenseKey: keys.get(l.productId) } } })),
    ...grant.map((l) => ({ put: { item: {
      ...K.owns(sub, l.productId), type: 'Ownership', productId: l.productId, name: l.name, orderId: meta.orderId,
      licenseKey: keys.get(l.productId), status: 'ACTIVE', since: now,
    }, condition: { any: [{ exists: false }, { attr: 'status', ne: 'ACTIVE' }] } } })),
    ...lines.map((l) => ({ delete: { key: K.cart(sub, l.productId) } })),
    ...grant.map((l) => ({ update: { key: K.product(l.productId), add: { buyers: 1, unitsSold: 1, revenueCents: l.priceCents } } })),
    ...[...salesByKey.values()].map((s) => ({ update: { key: K.sales(s.providerSub, day, s.productId), set: { type: 'Sales', day, productId: s.productId },
      add: { units: s.units, revenueCents: s.revenue, payoutCents: Math.round(s.revenue * (1 - PLATFORM_COMMISSION)) } } })),
    { update: { key: K.platformDay(day), set: { type: 'PlatformDay', day }, add: { orders: 1, gmvCents: pi.amount - refundCents, feesCents: fee, units: grant.length } } },
    ...(email ? [{ put: { item: { ...K.outbox(meta.orderId), type: 'Outbox', kind: 'receipt', to: email, orderId: meta.orderId,
      lines: grant.map((l) => ({ name: l.name, priceCents: l.priceCents, licenseKey: keys.get(l.productId), productId: l.productId })),
      amountCents: pi.amount - refundCents, createdAt: now } } }] : []),
  ];
  await deps.table.transact(ops);
  log('order.paid', { orderId: meta.orderId, licences: grant.length, items: ops.length });

  // After commit, best-effort side effects (each safe to lose, none safe to duplicate money on)
  if (refundCents > 0) {
    await deps.payments.refund({ paymentIntentId: pi.id, amount: refundCents, reason: 'duplicate' });
    log('refund.duplicate_lines', { amount: refundCents });
  }
  await bumpCoPurchases(deps, sub, grant.map((l) => l.productId));
  invalidateCatalogue(deps);
  return { fulfilled: true, licences: grant.length, refundedCents: refundCents };
}

/** ALSO#<b> counters for every (new, owned) pair — feeds recommendations. */
async function bumpCoPurchases(deps, sub, newIds) {
  const owned = await deps.table.query({ pk: `USER#${sub}`, sk: { beginsWith: 'OWNS#' }, limit: 100 });
  const all = owned.items.map((o) => o.productId);
  const done = new Set();
  for (const a of newIds) {
    for (const b of all) {
      if (a === b) continue;
      const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (done.has(pair)) continue;
      done.add(pair);
      await deps.table.update(K.also(a, b), { add: { n: 1 } });
      await deps.table.update(K.also(b, a), { add: { n: 1 } });
    }
  }
}

async function failed(deps, event, meta, log) {
  const pi = event.data.object;
  await deps.table.transact([
    eventPut(deps, event),
    { update: { key: K.order(meta.orderId), add: { failedAttempts: 1 }, set: { lastError: pi.last_payment_error?.code || 'declined' },
      condition: { attr: 'status', eq: 'PENDING_PAYMENT' } } },
    { update: { key: K.platformDay(isoDay(deps.clock.now())), set: { type: 'PlatformDay', day: isoDay(deps.clock.now()) }, add: { failedPayments: 1 } } },
  ]);
  log('order.payment_failed', { orderId: meta.orderId, code: pi.last_payment_error?.code });
  return { failed: true };
}

async function cancelled(deps, event, meta, log) {
  await deps.table.transact([
    eventPut(deps, event),
    { update: { key: K.order(meta.orderId), set: { status: 'CANCELLED', cancelledAt: deps.clock.now() }, condition: { attr: 'status', eq: 'PENDING_PAYMENT' } } },
  ]);
  log('order.cancelled', { orderId: meta.orderId });
  return { cancelled: true };
}

async function refunded(deps, event, order, log) {
  const { meta, lines } = order;
  const pi = event.data.object;
  const total = pi.amount_refunded || 0;
  // duplicate-line refunds are already accounted for at fulfilment
  if (total <= (meta.refundedCents || 0)) { await markSeen(deps, event).catch(() => {}); return { stale: true }; }
  const full = total >= meta.amountCents;
  const now = deps.clock.now();
  const active = lines.filter((l) => l.status === 'ACTIVE');
  await deps.table.transact([
    eventPut(deps, event),
    { update: { key: K.order(meta.orderId), set: { status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', refundedCents: total },
      condition: { attr: 'status', in: TRANSITIONS[event.type].from } } },
    ...(full ? active.flatMap((l) => [
      { update: { key: K.owns(meta.sub, l.productId), set: { status: 'REVOKED', revokedAt: now } } },
      { update: { key: K.orderLine(meta.orderId, l.productId), set: { status: 'REVOKED' } } },
      { update: { key: K.product(l.productId), add: { buyers: -1, revenueCents: -l.priceCents } } },
    ]) : []),
    { update: { key: K.platformDay(isoDay(now)), set: { type: 'PlatformDay', day: isoDay(now) }, add: { refundsCents: total - (meta.refundedCents || 0) } } },
  ]);
  log('order.refunded', { orderId: meta.orderId, full });
  return { refunded: true, full };
}

// ------------------------------------------------------------ outbox

/**
 * DynamoDB stream consumer: an INSERT of OUTBOX#… sends the receipt, then
 * deletes the row (conditionally, so two consumers cannot both delete it).
 */
export async function processStreamRecord(deps, record) {
  if (record.eventName !== 'INSERT' || !record.keys.PK.startsWith('OUTBOX#')) return { skipped: true };
  const m = record.newImage;
  const lines = m.lines.map((l) => `• ${l.name} — ${formatCents(l.priceCents)}\n  Licence key: ${l.licenseKey}`).join('\n');
  await deps.mailer.send({
    to: m.to, kind: 'receipt', orderId: m.orderId,
    subject: `Your SoftHub order ${m.orderId.slice(-8)} — licence keys inside`,
    text: `Thanks for your purchase.\n\n${lines}\n\nTotal charged: ${formatCents(m.amountCents)}\n`
      + `Downloads: ${deps.config.appUrl || ''}/orders/${m.orderId}`,
    lines: m.lines,
  });
  try {
    await deps.table.delete({ PK: m.PK, SK: m.SK }, { condition: { exists: true } });
  } catch (e) {
    if (!(e instanceof ConditionFailed)) throw e;
  }
  return { sent: true };
}
