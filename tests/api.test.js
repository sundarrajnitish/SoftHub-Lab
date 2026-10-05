import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, buy, CARD } from './helpers.js';
import { signWebhook } from '../packages/core/src/payments.js';
import { verifyLicenseKey } from '../packages/core/src/license.js';
import { K } from '../packages/core/src/keys.js';

test('roles: the gateway and the router enforce who may call what', async () => {
  const w = await world();
  const anon = w.rt.client();
  const buyer = await w.as('buyer');
  const prov = await w.as('provider');
  assert.equal((await anon.get('/products')).status, 200);
  assert.equal((await anon.get('/cart')).status, 401);
  assert.equal((await anon.get('/cart')).trace.gateway, true, 'rejected before Lambda runs');
  assert.equal((await buyer.post('/provider/products', {})).status, 403);
  assert.equal((await prov.put(`/cart/${w.products.a.productId}`)).status, 403);
  assert.equal((await buyer.get('/admin/metrics')).status, 403);
  assert.equal((await (await w.as('admin')).get('/admin/metrics')).status, 200);
  assert.equal((await anon.get('/nope')).status, 404);
});

test('the server prices the cart; clients cannot send prices, owners or statuses', async () => {
  const w = await world();
  const buyer = await w.as('buyer');
  await buyer.put(`/cart/${w.products.b.productId}`);
  const tampered = await buyer.post('/checkout', { amount: 1, priceCents: 1 }, { 'Idempotency-Key': 'tamper-0001' });
  assert.equal(tampered.status, 400);
  assert.match(tampered.data.error.message, /amount|priceCents/);
  const co = await buyer.post('/checkout', {}, { 'Idempotency-Key': 'honest-0001' });
  assert.equal(co.data.amountCents, 4999);
  const prov = await w.as('provider');
  const smuggle = await prov.post('/provider/products', { name: 'X product', category: 'games', description: 'x'.repeat(30), developer: 'D', platforms: ['Windows'], priceCents: 999, providerSub: 'someone-else' });
  assert.equal(smuggle.status, 400);
});

test('checkout is idempotent: the same key never creates a second order or charge', async () => {
  const w = await world();
  const buyer = await w.as('buyer');
  await buyer.put(`/cart/${w.products.a.productId}`);
  const first = await buyer.post('/checkout', {}, { 'Idempotency-Key': 'retry-key-123' });
  const again = await buyer.post('/checkout', {}, { 'Idempotency-Key': 'retry-key-123' });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.data.replayed, true);
  assert.equal(again.data.orderId, first.data.orderId);
  assert.equal(again.data.paymentIntentId, first.data.paymentIntentId);
  assert.equal(w.rt.stripe._intents.size, 1);
  assert.equal((await buyer.post('/checkout', {}, {})).status, 400, 'key is required');
});

test('happy path: pay → webhook → licences, ledger, receipt e-mail; cart emptied', async () => {
  const w = await world();
  const { order, api } = await buy(w, 'buyer', ['a', 'b']);
  assert.equal(order.status, 'PAID');
  assert.equal(order.lines.length, 2);
  for (const l of order.lines) {
    assert.ok(verifyLicenseKey('local-licence-secret', l.licenseKey, { orderId: order.orderId, productId: l.productId, sub: w.subs.buyer }));
  }
  assert.equal((await api.get('/cart')).data.items.length, 0);
  const mail = w.rt.mailer.inbox('maya.chen@example.com');
  assert.equal(mail.length, 1);
  assert.match(mail[0].text, /SHUB-/);
  const dash = await (await w.as('provider')).get('/provider/dashboard');
  assert.equal(dash.data.totals.units, 2);
  assert.equal(dash.data.totals.revenueCents, 1999 + 4999);
  assert.equal(dash.data.totals.payoutCents, Math.round(1999 * 0.9) + Math.round(4999 * 0.9));
  const lib = await api.get('/library');
  assert.equal(lib.data.items.length, 2);
  // owned products cannot go back in the cart
  assert.equal((await api.put(`/cart/${w.products.a.productId}`)).status, 409);
});

test('exactly-once under chaos: every webhook delivered twice, plus a failing first attempt', async () => {
  const w = await world({ chaos: { duplicateRate: 1, dropFirstAttemptRate: 1 } });
  const { order } = await buy(w, 'buyer', ['a', 'c']);
  await w.rt.settle(3_600_000);
  assert.equal(order.status, 'PAID');
  const owns = await w.rt.table.query({ pk: `USER#${w.subs.buyer}`, sk: { beginsWith: 'OWNS#' } });
  assert.equal(owns.items.length, 2);
  const prodA = await w.rt.table.get(K.product(w.products.a.productId));
  assert.equal(prodA.buyers, 1, 'counted once');
  assert.equal(w.rt.mailer.inbox('maya.chen@example.com').length, 1, 'one receipt');
  const deliveries = w.rt.stripe._events.length;
  assert.ok(deliveries >= 1);
});

test('signature checks: forged, re-signed with the wrong secret, or replayed late → 400', async () => {
  const w = await world();
  const { co } = await buy(w, 'buyer', ['a']);
  const evt = w.rt.stripe._events.find((e) => e.type === 'payment_intent.succeeded');
  const raw = JSON.stringify({ ...evt, id: 'evt_forged' });
  const now = Math.floor(w.clock.now() / 1000);
  const send = (body, header) => w.rt.request({ method: 'POST', path: '/webhooks/stripe', body, headers: { 'stripe-signature': header } });
  assert.equal((await send(raw, signWebhook('whsec_wrong', raw, now))).status, 400);
  assert.equal((await send(raw, signWebhook(w.rt.stripe.webhookSecret, raw, now - 3600))).data.error.code, 'webhook.replay');
  assert.equal((await send(raw, 'garbage')).status, 400);
  // correctly signed replay of a processed event id: accepted, no effect
  const replay = JSON.stringify(evt);
  const r = await send(replay, signWebhook(w.rt.stripe.webhookSecret, replay, now));
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate, true);
  assert.ok(co);
});

test('a late payment_failed after success changes nothing (state machine)', async () => {
  const w = await world();
  const { order, co } = await buy(w, 'buyer', ['a']);
  const late = {
    id: 'evt_late_fail', type: 'payment_intent.payment_failed', created: 0, object: 'event',
    data: { object: { id: co.data.paymentIntentId, amount: 1999, metadata: { orderId: order.orderId }, last_payment_error: { code: 'card_declined' } } },
  };
  const raw = JSON.stringify(late);
  const r = await w.rt.request({ method: 'POST', path: '/webhooks/stripe', body: raw, headers: { 'stripe-signature': signWebhook(w.rt.stripe.webhookSecret, raw, Math.floor(w.clock.now() / 1000)) } });
  assert.equal(r.data.stale, true);
  const again = await (await w.as('buyer')).get(`/orders/${order.orderId}`);
  assert.equal(again.data.status, 'PAID');
});

test('declines are recorded, then a retry with another card succeeds; 3-D Secure', async () => {
  const w = await world();
  const buyer = await w.as('buyer');
  await buyer.put(`/cart/${w.products.a.productId}`);
  const co = await buyer.post('/checkout', {}, { 'Idempotency-Key': 'decline-flow-1' });
  const typo = await w.rt.pay(co.data.clientSecret, { number: '4242 4242 4242 4241', exp: '12/34', cvc: '1' });
  assert.equal(typo.error.type, 'validation_error', 'Luhn check happens in the browser, no event');
  const d = await w.rt.pay(co.data.clientSecret, CARD.decline);
  assert.equal(d.error.code, 'card_declined');
  await w.rt.advance(5_000);
  let o = await buyer.get(`/orders/${co.data.orderId}`);
  assert.deepEqual([o.data.status, o.data.failedAttempts, o.data.lastError], ['PENDING_PAYMENT', 1, 'card_declined']);
  const tds = await w.rt.pay(co.data.clientSecret, CARD.threeDS);
  assert.equal(tds.requiresAction, true);
  await w.rt.stripe.handleNextAction(co.data.clientSecret, true);
  await w.rt.advance(5_000);
  o = await buyer.get(`/orders/${co.data.orderId}`);
  assert.equal(o.data.status, 'PAID');
});

test('two parallel orders for the same product: one licence, the duplicate line refunded', async () => {
  const w = await world();
  const buyer = await w.as('buyer');
  await buyer.put(`/cart/${w.products.a.productId}`);
  const co1 = await buyer.post('/checkout', {}, { 'Idempotency-Key': 'parallel-001' });
  const co2 = await buyer.post('/checkout', {}, { 'Idempotency-Key': 'parallel-002' }); // e.g. a second tab
  await w.rt.pay(co1.data.clientSecret, CARD.ok);
  await w.rt.pay(co2.data.clientSecret, CARD.ok);
  await w.rt.settle(60_000);
  const o2 = await buyer.get(`/orders/${co2.data.orderId}`);
  assert.equal(o2.data.refundedCents, 1999);
  assert.equal(o2.data.lines[0].status, 'REFUNDED_DUPLICATE');
  const prod = await w.rt.table.get(K.product(w.products.a.productId));
  assert.equal(prod.buyers, 1);
  assert.equal(w.rt.stripe.retrieve(co2.data.paymentIntentId).amount_refunded, 1999);
});

test('a full refund revokes the licence and the download', async () => {
  const w = await world();
  const { order, co, api } = await buy(w, 'buyer', ['a']);
  const dl = await api.get(`/orders/${order.orderId}/downloads/${w.products.a.productId}`);
  assert.equal(dl.status, 200);
  assert.ok(w.rt.objects.resolve(dl.data.url));
  w.clock.advance(301_000);
  assert.throws(() => w.rt.objects.resolve(dl.data.url), /expired/);
  await w.rt.stripe.refund({ paymentIntentId: co.data.paymentIntentId });
  await w.rt.advance(10_000);
  const after = await api.get(`/orders/${order.orderId}`);
  assert.equal(after.data.status, 'REFUNDED');
  assert.equal((await api.get(`/orders/${order.orderId}/downloads/${w.products.a.productId}`)).status, 403);
  assert.equal((await api.put(`/cart/${w.products.a.productId}`)).status, 200, 'can buy again after a refund');
});

test('reviews: buyers only, one each, edits adjust aggregates exactly', async () => {
  const w = await world();
  const stranger = await w.as('buyer2');
  const pid = w.products.a.productId;
  assert.equal((await stranger.post(`/products/${pid}/reviews`, { stars: 5, text: 'Never bought it but love it' })).status, 403);
  const { api } = await buy(w, 'buyer', ['a']);
  const r1 = await api.post(`/products/${pid}/reviews`, { stars: 2, text: 'Crashes constantly and the menus are confusing.' });
  assert.equal(r1.status, 201);
  assert.equal(r1.data.sentiment.label, 'negative');
  const r2 = await api.post(`/products/${pid}/reviews`, { stars: 5, text: 'After the update it is fast, stable and a joy to use.' });
  assert.equal(r2.status, 200, 'second post edits');
  const p = await w.rt.table.get(K.product(pid));
  assert.deepEqual([p.reviewCount, p.ratingSum, p.pos || 0, p.neg || 0], [1, 5, 1, 0]);
  assert.equal(p.sentSum, Math.round(r2.data.sentiment.compound * 1000));
  const list = await w.rt.client().get(`/products/${pid}/reviews`);
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].author, 'Maya C.');
  const insights = await w.rt.client().get(`/products/${pid}/insights`);
  assert.equal(insights.data.reviews, 1);
  assert.equal((await api.post(`/products/${pid}/reviews`, { stars: 6, text: 'x' })).status, 400);
});

test('providers: optimistic locking, ownership, archive keeps buyers whole', async () => {
  const w = await world();
  const prov = await w.as('provider');
  const other = await w.as('provider2');
  const pid = w.products.a.productId;
  assert.equal((await other.put(`/provider/products/${pid}`, { ver: 1, priceCents: 199 })).status, 403);
  const ok = await prov.put(`/provider/products/${pid}`, { ver: 1, priceCents: 2499 });
  assert.equal(ok.status, 200);
  const stale = await prov.put(`/provider/products/${pid}`, { ver: 1, priceCents: 2999 });
  assert.equal(stale.status, 409, 'edit based on an old version is refused');
  const { order } = await buy(w, 'buyer', ['a']);
  assert.equal(order.amountCents, 2499);
  assert.equal((await prov.del(`/provider/products/${pid}`)).status, 200);
  assert.equal((await w.rt.client().get(`/products/${pid}`)).status, 404);
  const listed = await w.rt.client().get('/products', { category: 'games' });
  assert.ok(!listed.data.items.some((p) => p.productId === pid));
  const lib = await (await w.as('buyer')).get('/library');
  assert.equal(lib.data.items[0].status, 'ACTIVE');
  const up = await prov.post(`/provider/products/${w.products.b.productId}/uploads`, { kind: 'image', contentType: 'image/png', bytes: 10_000_000 });
  assert.equal(up.status, 400);
});

test('admin suspension takes effect even while the token is still valid', async () => {
  const w = await world();
  const buyerToken = await w.token('buyer');
  const admin = await w.as('admin');
  const found = await admin.get('/admin/users', { email: 'MAYA.CHEN@example.com' });
  assert.equal(found.data.sub, w.subs.buyer);
  assert.equal((await admin.put(`/admin/users/${w.subs.admin}/status`, { status: 'SUSPENDED', reason: 'test' })).status, 400);
  assert.equal((await admin.put(`/admin/users/${w.subs.buyer}/status`, { status: 'SUSPENDED', reason: 'chargeback abuse' })).status, 200);
  w.clock.advance(31_000); // past the per-container status cache
  const r = await w.rt.client(buyerToken).get('/cart');
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'account.suspended');
  await assert.rejects(w.rt.signIn(w.users.buyer.email, w.users.buyer.password), /suspended/);
});

test('catalogue search, filters, sorting; related products explain themselves', async () => {
  const w = await world();
  const anon = w.rt.client();
  assert.equal((await anon.get('/products', { q: 'product b' })).data.items[0].name, 'Product B');
  assert.deepEqual((await anon.get('/products', { category: 'games', sort: '-price' })).data.items.map((p) => p.name), ['Product B', 'Product A']);
  assert.equal((await anon.get('/products', { maxPrice: '1000' })).data.items.length, 1);
  assert.equal((await anon.get('/products', { category: 'nope' })).status, 400);
  await buy(w, 'buyer', ['a', 'b']);
  await buy(w, 'buyer2', ['a', 'b']);
  const rel = await anon.get(`/products/${w.products.a.productId}/related`);
  assert.equal(rel.data.items[0].name, 'Product B');
  assert.match(rel.data.items[0].reason, /2 buyers own both/);
});

test('traces model the platform: cold then warm containers, capacity per call', async () => {
  const w = await world();
  const anon = w.rt.client();
  const first = await anon.get('/categories');
  const second = await anon.get('/categories');
  assert.equal(first.trace.cold, true);
  assert.equal(second.trace.cold, false);
  assert.ok(first.trace.totalMs > second.trace.totalMs);
  const p = await anon.get(`/products/${w.products.a.productId}`);
  assert.deepEqual(p.trace.ops.map((o) => o.op), ['GetItem']);
  assert.equal(p.trace.ops[0].rru, 0.5);
});
