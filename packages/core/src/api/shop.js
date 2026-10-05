// Consumer flows: cart, checkout, orders, licences, downloads, reviews.

import { K } from '../keys.js';
import { validate, ID } from '../validate.js';
import { AppError, badRequest, conflict, forbidden, notFound, stableStringify } from '../util.js';
import { sha256, toHex } from '../crypto.js';
import { ConditionFailed } from '../store.js';
import { Response } from './router.js';
import { publicProduct, loadCatalogue, togetherCounts, ownedIds, publicReview } from './catalog.js';
import { analyseReview, reviewDeltas } from '../sentiment.js';
import { recommendForUser } from '../recommend.js';

export const CART_LIMIT = 15; // keeps the fulfilment transaction under DynamoDB's 100-item limit
export const ORDER_TTL_MS = 30 * 60_000;
export const IDEMPOTENCY_TTL_SEC = 24 * 3600;

const PID = { productId: ID };

// ------------------------------------------------------------------ cart

async function cartLines(deps, sub) {
  const page = await deps.table.query({ pk: `USER#${sub}`, sk: { beginsWith: 'CART#' }, limit: CART_LIMIT + 5, consistent: true });
  return page.items;
}

/** Cart lines joined with the *current* catalogue price (never a client price). */
async function pricedCart(deps, sub) {
  const lines = await cartLines(deps, sub);
  if (!lines.length) return { items: [], totalCents: 0, unavailable: [] };
  const products = await deps.table.batchGet(lines.map((l) => K.product(l.productId)));
  const byId = new Map(products.map((p) => [p.productId, p]));
  const owned = await ownedIds(deps, sub);
  const items = [], unavailable = [];
  for (const l of lines) {
    const p = byId.get(l.productId);
    if (!p || p.status !== 'PUBLISHED') unavailable.push({ productId: l.productId, reason: 'no longer sold' });
    else if (owned.has(l.productId)) unavailable.push({ productId: l.productId, reason: 'already owned' });
    else items.push({ ...publicProduct(p), addedAt: l.addedAt, providerSub: p.providerSub });
  }
  items.sort((a, b) => a.addedAt - b.addedAt);
  return { items, totalCents: items.reduce((a, i) => a + i.priceCents, 0), unavailable };
}

const stripProvider = ({ providerSub, ...rest }) => rest;

export async function getCart(ctx) {
  const c = await pricedCart(ctx.deps, ctx.principal.sub);
  return { ...c, items: c.items.map(stripProvider), currency: 'CAD' };
}

export async function addToCart(ctx) {
  const { productId } = validate(PID, ctx.params);
  const { deps, principal } = ctx;
  const p = await deps.table.get(K.product(productId));
  if (!p || p.status !== 'PUBLISHED') throw notFound('Product');
  if (p.providerSub === principal.sub) throw badRequest('cart.own_product', 'You cannot buy your own product');
  const owns = await deps.table.get(K.owns(principal.sub, productId));
  if (owns && owns.status === 'ACTIVE') throw conflict('cart.already_owned', 'You already own this product');
  const lines = await cartLines(deps, principal.sub);
  if (lines.some((l) => l.productId === productId)) return getCart(ctx); // idempotent
  if (lines.length >= CART_LIMIT) throw badRequest('cart.full', `A cart holds at most ${CART_LIMIT} products`);
  await deps.table.put({ ...K.cart(principal.sub, productId), type: 'CartLine', productId, addedAt: deps.clock.now() });
  ctx.log('cart.add', { productId });
  return getCart(ctx);
}

export async function removeFromCart(ctx) {
  const { productId } = validate(PID, ctx.params);
  await ctx.deps.table.delete(K.cart(ctx.principal.sub, productId));
  return getCart(ctx);
}

export async function clearCart(ctx) {
  const lines = await cartLines(ctx.deps, ctx.principal.sub);
  for (const l of lines) await ctx.deps.table.delete({ PK: l.PK, SK: l.SK });
  return getCart(ctx);
}

// -------------------------------------------------------------- checkout

const IDEM_KEY = { type: 'string', min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/ };

/**
 * POST /checkout  (Idempotency-Key header required)
 *
 * The server prices the cart from the catalogue, snapshots the lines into a
 * PENDING_PAYMENT order and creates the PaymentIntent with the order id in its
 * metadata. Nothing is granted here: licences are issued only by the signed
 * `payment_intent.succeeded` webhook. Replaying the same key returns the same
 * order and PaymentIntent instead of charging twice.
 */
export async function checkout(ctx) {
  const { deps, principal } = ctx;
  const key = validate({ key: IDEM_KEY }, { key: ctx.headers['idempotency-key'] }).key;
  validate({}, ctx.body || {});
  const idemKey = K.idempotency('checkout', `${principal.sub}#${key}`);

  const prior = await deps.table.get(idemKey, { consistent: true });
  if (prior) {
    ctx.log('idempotency.replay', { key });
    return new Response(200, { ...prior.response, replayed: true });
  }

  const cart = await pricedCart(deps, principal.sub);
  if (!cart.items.length) {
    throw badRequest('checkout.empty', cart.unavailable.length ? 'Nothing in your cart can be bought' : 'Your cart is empty');
  }
  const now = deps.clock.now();
  const orderId = deps.newId('ord_');
  const amount = cart.totalCents;
  const lines = cart.items.map((i) => ({ productId: i.productId, name: i.name, priceCents: i.priceCents, providerSub: i.providerSub }));
  const fingerprint = toHex(sha256(stableStringify(lines))).slice(0, 16);

  const pi = await deps.payments.createPaymentIntent({
    amount, currency: 'cad', idempotencyKey: `order-${orderId}`,
    metadata: { orderId, sub: principal.sub }, description: `SoftHub order ${orderId}`,
  });
  ctx.log('payment_intent.created', { paymentIntentId: pi.id, amount });

  const response = {
    orderId, status: 'PENDING_PAYMENT', amountCents: amount, currency: 'CAD',
    paymentIntentId: pi.id, clientSecret: pi.clientSecret, lines: lines.map(({ providerSub, ...l }) => l),
    expiresAt: now + ORDER_TTL_MS,
  };
  const ops = [
    { put: { item: { ...idemKey, type: 'Idempotency', response, fingerprint, ttl: Math.floor(now / 1000) + IDEMPOTENCY_TTL_SEC }, condition: { exists: false } } },
    { put: { item: {
      ...K.order(orderId), type: 'Order', orderId, sub: principal.sub, status: 'PENDING_PAYMENT', amountCents: amount,
      currency: 'CAD', paymentIntentId: pi.id, lineCount: lines.length, createdAt: now, expiresAt: now + ORDER_TTL_MS,
      failedAttempts: 0, GSI1PK: `USER#${principal.sub}`, GSI1SK: `ORDER#${orderId}`,
    }, condition: { exists: false } } },
    ...lines.map((l) => ({ put: { item: { ...K.orderLine(orderId, l.productId), type: 'OrderLine', orderId, ...l } } })),
  ];
  try {
    await deps.table.transact(ops);
  } catch (e) {
    if (e instanceof ConditionFailed) {
      // a concurrent request with the same key won the race: return its order, drop ours
      await deps.payments.cancel(pi.id).catch(() => {});
      const winner = await deps.table.get(idemKey, { consistent: true });
      if (winner) return new Response(200, { ...winner.response, replayed: true });
    }
    throw e;
  }
  ctx.log('order.created', { orderId, lines: lines.length, amount });
  return new Response(201, response);
}

// ---------------------------------------------------------------- orders

function publicOrder(meta, lines = []) {
  return {
    orderId: meta.orderId, status: meta.status, amountCents: meta.amountCents, currency: meta.currency,
    createdAt: meta.createdAt, paidAt: meta.paidAt || null, refundedCents: meta.refundedCents || 0,
    failedAttempts: meta.failedAttempts || 0, lastError: meta.lastError || null,
    lines: lines.map((l) => ({
      productId: l.productId, name: l.name, priceCents: l.priceCents,
      licenseKey: meta.status === 'PAID' || meta.status === 'PARTIALLY_REFUNDED' ? l.licenseKey || null : null,
      status: l.status || (meta.status === 'PAID' ? 'ACTIVE' : null),
    })),
  };
}

export async function listOrders(ctx) {
  const q = validate({ cursor: { type: 'string', max: 400, optional: true } }, ctx.query);
  const page = await ctx.deps.table.query({ index: 'GSI1', pk: `USER#${ctx.principal.sub}`, sk: { beginsWith: 'ORDER#' }, desc: true, limit: 20, cursor: q.cursor });
  return { items: page.items.map((m) => publicOrder(m)), cursor: page.cursor };
}

export async function loadOrder(deps, orderId, { consistent = true } = {}) {
  const page = await deps.table.query({ pk: `ORDER#${orderId}`, limit: 100, consistent });
  const meta = page.items.find((i) => i.SK === 'META');
  if (!meta) return null;
  return { meta, lines: page.items.filter((i) => i.SK.startsWith('LINE#')) };
}

export async function getOrder(ctx) {
  const { orderId } = validate({ orderId: ID }, ctx.params);
  const o = await loadOrder(ctx.deps, orderId);
  if (!o || (o.meta.sub !== ctx.principal.sub && !ctx.principal.groups.includes('Admin'))) throw notFound('Order');
  return publicOrder(o.meta, o.lines);
}

export async function getDownload(ctx) {
  const { orderId, productId } = validate({ orderId: ID, productId: ID }, ctx.params);
  const owns = await ctx.deps.table.get(K.owns(ctx.principal.sub, productId), { consistent: true });
  if (!owns || owns.status !== 'ACTIVE' || owns.orderId !== orderId) throw forbidden('download.not_owner', 'You do not own this product');
  const url = await ctx.deps.objects.presignGet(`installers/${productId}/latest`, 300);
  ctx.log('download.presigned', { productId, ttl: 300 });
  return { url, expiresInSec: 300 };
}

export async function getLibrary(ctx) {
  const page = await ctx.deps.table.query({ pk: `USER#${ctx.principal.sub}`, sk: { beginsWith: 'OWNS#' }, limit: 100 });
  const products = page.items.length ? await ctx.deps.table.batchGet(page.items.map((o) => K.product(o.productId))) : [];
  const byId = new Map(products.map((p) => [p.productId, p]));
  return {
    items: page.items.map((o) => ({
      productId: o.productId, name: byId.get(o.productId)?.name || o.name, orderId: o.orderId,
      licenseKey: o.status === 'ACTIVE' ? o.licenseKey : null, status: o.status, since: o.since,
      image: byId.get(o.productId)?.image || null,
    })),
  };
}

// --------------------------------------------------------------- reviews

const REVIEW_BODY = {
  stars: { type: 'int', min: 1, max: 5 },
  text: { type: 'string', min: 10, max: 2000, multiline: true },
};

/**
 * POST /products/{id}/reviews — verified buyers only, one review per buyer
 * (a second POST edits it). Sentiment is computed here, once, and the product
 * aggregates are adjusted by exact integer deltas in the same transaction.
 */
export async function postReview(ctx) {
  const { productId } = validate(PID, ctx.params);
  const body = validate(REVIEW_BODY, ctx.body);
  const { deps, principal } = ctx;
  const owns = await deps.table.get(K.owns(principal.sub, productId), { consistent: true });
  if (!owns || owns.status !== 'ACTIVE') throw forbidden('review.not_owner', 'Only buyers can review this product');
  const analysis = analyseReview(body.text);
  ctx.log('sentiment', { compound: analysis.compound, label: analysis.label, aspects: analysis.aspects });
  const now = deps.clock.now();
  const profile = await deps.table.get(K.profile(principal.sub));
  const author = displayName(profile?.email || principal.email || 'buyer');
  const marker = await deps.table.get(K.reviewer(productId, principal.sub), { consistent: true });

  if (!marker) {
    const reviewId = deps.newId('rev_');
    const review = {
      ...K.review(productId, reviewId), type: 'Review', reviewId, productId, sub: principal.sub, author,
      stars: body.stars, text: body.text, compound: analysis.compound, label: analysis.label,
      aspects: analysis.aspects, createdAt: now, ver: 1,
    };
    await deps.table.transact([
      { put: { item: { ...K.reviewer(productId, principal.sub), type: 'ReviewMarker', reviewId }, condition: { exists: false } } },
      { put: { item: review } },
      { update: { key: K.product(productId), add: reviewDeltas(body.stars, analysis), condition: { exists: true } } },
      { update: { key: K.platformDay(isoDay(now)), add: { reviews: 1 } } },
    ]);
    return publicReview(review);
  }

  const old = await deps.table.get(K.review(productId, marker.reviewId), { consistent: true });
  const undo = reviewDeltas(old.stars, { compound: old.compound, label: old.label, aspects: old.aspects || {} }, -1);
  const redo = reviewDeltas(body.stars, analysis, 1);
  const delta = { ...undo };
  for (const [k, v] of Object.entries(redo)) delta[k] = (delta[k] || 0) + v;
  for (const k of Object.keys(delta)) if (delta[k] === 0) delete delta[k];
  const updated = {
    ...old, stars: body.stars, text: body.text, compound: analysis.compound, label: analysis.label,
    aspects: analysis.aspects, editedAt: now, ver: old.ver + 1,
  };
  await deps.table.transact([
    { put: { item: updated, condition: { attr: 'ver', eq: old.ver } } },
    ...(Object.keys(delta).length ? [{ update: { key: K.product(productId), add: delta, condition: { exists: true } } }] : []),
  ]);
  ctx.log('review.edited', { reviewId: old.reviewId });
  return new Response(200, publicReview(updated));
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function displayName(email) {
  // "maya.chen@…" → "Maya C."; never the full address
  const parts = String(email).split('@')[0].split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const first = (parts[0] || 'buyer').slice(0, 12);
  const name = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  return parts[1] ? `${name} ${parts[1][0].toUpperCase()}.` : name;
}

// ------------------------------------------------------- recommendations

export async function myRecommendations(ctx) {
  const { deps, principal } = ctx;
  const catalogue = await loadCatalogue(deps);
  const owned = await ownedIds(deps, principal.sub);
  const byId = new Map(catalogue.map((p) => [p.productId, p]));
  const ownedProducts = [...owned].map((id) => byId.get(id)).filter(Boolean).slice(0, 10);
  const together = new Map();
  for (const p of ownedProducts) together.set(p.productId, await togetherCounts(deps, p.productId));
  const recs = recommendForUser(ownedProducts, catalogue, (id) => together.get(id) || new Map(), { limit: 6 });
  return { items: recs.map((r) => ({ ...publicProduct(byId.get(r.productId)), score: r.score, reason: r.reason })) };
}

export { AppError };
