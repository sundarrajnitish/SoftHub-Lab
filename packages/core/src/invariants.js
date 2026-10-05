// Whole-system audit: recompute everything from first principles and compare
// with what the system stored, sent and charged. Used by the tests, by the
// simulator after every run, and by the "Audit" button on the website.

import { verifyLicenseKey } from './license.js';

export function audit(rt) {
  const rows = rt.table._all();
  const by = (prefix, sk) => rows.filter((r) => r.PK.startsWith(prefix) && (sk === undefined || (typeof sk === 'string' ? r.SK === sk : sk(r.SK))));
  const orders = by('ORDER#', 'META');
  const lines = by('ORDER#', (s) => s.startsWith('LINE#'));
  const owns = by('USER#', (s) => s.startsWith('OWNS#'));
  const carts = by('USER#', (s) => s.startsWith('CART#'));
  const products = by('PRODUCT#', 'META');
  const reviews = by('PRODUCT#', (s) => s.startsWith('REVIEW#'));
  const sales = by('PROVIDER#', (s) => s.startsWith('SALES#'));
  const outbox = by('OUTBOX#');
  const linesOf = new Map();
  for (const l of lines) (linesOf.get(l.orderId) || linesOf.set(l.orderId, []).get(l.orderId)).push(l);

  const checks = [];
  const check = (name, bad, total, detail) => checks.push({ name, ok: bad.length === 0, checked: total, failures: bad.length, detail: bad.slice(0, 3).map(detail) });

  const paid = orders.filter((o) => ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(o.status));
  check('Paid orders: line totals equal the amount charged', paid.filter((o) => (linesOf.get(o.orderId) || []).reduce((a, l) => a + l.priceCents, 0) !== o.amountCents), paid.length, (o) => o.orderId);

  const granted = lines.filter((l) => l.status === 'ACTIVE');
  const orderById = new Map(orders.map((o) => [o.orderId, o]));
  check('Every granted line has a valid licence key bound to its buyer',
    granted.filter((l) => !verifyLicenseKey(rt.deps.config.licenseSecret, l.licenseKey || '', { orderId: l.orderId, productId: l.productId, sub: orderById.get(l.orderId)?.sub })),
    granted.length, (l) => `${l.orderId}/${l.productId}`);

  const ownsKey = new Set(owns.filter((o) => o.status === 'ACTIVE').map((o) => `${o.PK.slice(5)}|${o.productId}|${o.orderId}`));
  check('Every granted line has exactly one ownership record',
    granted.filter((l) => !ownsKey.has(`${orderById.get(l.orderId).sub}|${l.productId}|${l.orderId}`)), granted.length, (l) => l.orderId);

  const activeOwns = owns.filter((o) => o.status === 'ACTIVE');
  const pairs = new Set();
  const dupes = activeOwns.filter((o) => { const k = `${o.PK}|${o.productId}`; if (pairs.has(k)) return true; pairs.add(k); return false; });
  check('Nobody owns the same product twice', dupes, activeOwns.length, (o) => o.PK);
  check('Ownership only from paid orders', activeOwns.filter((o) => orderById.get(o.orderId)?.status !== 'PAID' && orderById.get(o.orderId)?.status !== 'PARTIALLY_REFUNDED'), activeOwns.length, (o) => o.orderId);

  const buyersOf = new Map();
  for (const o of activeOwns) buyersOf.set(o.productId, (buyersOf.get(o.productId) || 0) + 1);
  check('Product buyer counters equal ownership records', products.filter((p) => (p.buyers || 0) !== (buyersOf.get(p.productId) || 0)), products.length, (p) => `${p.name}: ${p.buyers} vs ${buyersOf.get(p.productId) || 0}`);

  const agg = new Map();
  for (const r of reviews) {
    const a = agg.get(r.productId) || { n: 0, stars: 0, sent: 0, pos: 0, neg: 0 };
    a.n++; a.stars += r.stars; a.sent += Math.round(r.compound * 1000);
    if (r.label === 'positive') a.pos++; if (r.label === 'negative') a.neg++;
    agg.set(r.productId, a);
  }
  check('Rating and sentiment aggregates equal a recount of the reviews', products.filter((p) => {
    const a = agg.get(p.productId) || { n: 0, stars: 0, sent: 0, pos: 0, neg: 0 };
    return (p.reviewCount || 0) !== a.n || (p.ratingSum || 0) !== a.stars || (p.sentSum || 0) !== a.sent || (p.pos || 0) !== a.pos || (p.neg || 0) !== a.neg;
  }), products.length, (p) => p.name);

  const ledger = new Map();
  for (const s of sales) ledger.set(s.productId, (ledger.get(s.productId) || 0) + s.units);
  const grantedEver = new Map();
  for (const l of lines.filter((x) => x.status === 'ACTIVE' || x.status === 'REVOKED')) grantedEver.set(l.productId, (grantedEver.get(l.productId) || 0) + 1);
  check('Provider sales ledger equals licences granted', products.filter((p) => (ledger.get(p.productId) || 0) !== (grantedEver.get(p.productId) || 0)), products.length, (p) => p.name);

  const intents = [...rt.stripe._intents.values()];
  const succeeded = intents.filter((pi) => pi.status === 'succeeded');
  const piOrder = new Map(orders.map((o) => [o.paymentIntentId, o]));
  check('Every successful charge belongs to a paid order', succeeded.filter((pi) => !['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(piOrder.get(pi.id)?.status)), succeeded.length, (pi) => pi.id);
  const charged = succeeded.reduce((a, pi) => a + pi.amount - pi.refunded, 0);
  const booked = paid.reduce((a, o) => a + o.amountCents - (o.refundedCents || 0), 0);
  check('Money kept (charges − refunds) equals paid orders net of refunds', charged === booked ? [] : [{ charged, booked }], 1, (x) => `${x.charged} vs ${x.booked}`);

  const receipts = new Map();
  for (const m of rt.mailer.all().filter((x) => x.kind === 'receipt')) receipts.set(m.orderId, (receipts.get(m.orderId) || 0) + 1);
  const fulfilledWithEmail = paid.filter((o) => granted.some((l) => l.orderId === o.orderId) || o.status === 'REFUNDED');
  check('Exactly one receipt e-mail per paid order', fulfilledWithEmail.filter((o) => receipts.get(o.orderId) !== 1), fulfilledWithEmail.length, (o) => `${o.orderId}: ${receipts.get(o.orderId) || 0}`);
  check('Outbox drained (no unsent e-mail)', outbox, outbox.length, (o) => o.PK);

  const ownedSet = new Set(activeOwns.map((o) => `${o.PK}|${o.productId}`));
  check('No cart holds a product its owner already has', carts.filter((c) => ownedSet.has(`${c.PK}|${c.productId}`)), carts.length, (c) => c.PK);

  return { ok: checks.every((c) => c.ok), checks, counts: { orders: orders.length, paid: paid.length, licences: granted.length, reviews: reviews.length, items: rows.length } };
}
