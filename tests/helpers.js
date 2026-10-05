import { createLocalRuntime } from '../packages/core/src/runtime.js';
import { manualClock } from '../packages/core/src/util.js';

globalThis.__SOFTHUB_QUIET__ = true;

export const CARD = {
  ok: { number: '4242 4242 4242 4242', exp: '12/34', cvc: '123' },
  decline: { number: '4000 0000 0000 0002', exp: '12/34', cvc: '123' },
  funds: { number: '4000 0000 0000 9995', exp: '12/34', cvc: '123' },
  threeDS: { number: '4000 0025 0000 3155', exp: '12/34', cvc: '123' },
};

const PRODUCT = (name, extra = {}) => ({
  name, category: 'games', description: 'A perfectly reasonable description of this product.', developer: 'Test Studio',
  platforms: ['Windows'], priceCents: 1999, tags: ['puzzle', 'indie'], publish: true, ...extra,
});

/** A small marketplace: one provider with three products, a buyer, an admin. */
export async function world({ chaos = {}, seed = 1 } = {}) {
  const clock = manualClock(Date.UTC(2026, 9, 1, 12));
  const rt = createLocalRuntime({ clock, seed, chaos, stochasticLatency: false });
  const users = {
    provider: { email: 'studio@example.com', password: 'Studio-pass-1', group: 'Provider' },
    provider2: { email: 'other@example.com', password: 'Studio-pass-2', group: 'Provider' },
    buyer: { email: 'maya.chen@example.com', password: 'Buyer-pass-1', group: 'Consumer' },
    buyer2: { email: 'leo@example.com', password: 'Buyer-pass-2', group: 'Consumer' },
    admin: { email: 'admin@example.com', password: 'Admin-pass-1', group: 'Admin' },
  };
  const subs = {};
  for (const [k, u] of Object.entries(users)) subs[k] = await rt.identity.seed(u);
  const token = async (who) => (await rt.signIn(users[who].email, users[who].password)).accessToken;
  const as = async (who) => rt.client(await token(who));
  const prov = await as('provider');
  const products = {};
  for (const [k, extra] of Object.entries({ a: {}, b: { priceCents: 4999, tags: ['puzzle', 'relaxing'] }, c: { category: 'productivity', priceCents: 990, tags: ['notes'] } })) {
    const r = await prov.post('/provider/products', PRODUCT(`Product ${k.toUpperCase()}`, extra));
    if (r.status !== 201) throw new Error(JSON.stringify(r.data));
    products[k] = r.data;
  }
  return { rt, clock, users, subs, token, as, products };
}

export async function buy(w, who, productKeys, { card = CARD.ok, key = null } = {}) {
  const api = await w.as(who);
  for (const k of productKeys) await api.put(`/cart/${w.products[k].productId}`);
  const co = await api.post('/checkout', {}, { 'Idempotency-Key': key || `key-${Math.random().toString(36).slice(2, 12)}` });
  if (co.status >= 300) return { co };
  const pay = await w.rt.pay(co.data.clientSecret, card);
  await w.rt.advance(10_000);
  const order = await api.get(`/orders/${co.data.orderId}`);
  return { api, co, pay, order: order.data };
}
