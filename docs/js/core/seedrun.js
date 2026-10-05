// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Populate a runtime with a believable history — through the public API only.
// Used by the dev server, the tests and the website (deterministic per seed).

import { STUDIOS, CATALOGUE, DEMO_ACCOUNTS, generateReview, randomPerson } from './seed.js';
import { createRng } from './util.js';

const DAY = 86_400_000;
const GOOD_CARD = { number: '4242424242424242', exp: '12/34', cvc: '123' };
const DECLINE_CARD = { number: '4000000000000002', exp: '12/34', cvc: '123' };

async function ok(res, what) {
  if (res.status >= 400) throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

/**
 * @returns {Promise<{products: Map<name, productId>, tokens: object, shoppers: string[]}>}
 */
export async function seedMarketplace(rt, { days = 45, orders = 220, shoppers = 70, reviewRate = 0.4, seed = 7 } = {}) {
  const rng = createRng(seed);
  const start = rt.clock.now() - days * DAY;
  rt.clock.set ? rt.clock.set(start) : null;

  await rt.identity.seed({ ...DEMO_ACCOUNTS.admin });
  const studioTokens = {};
  for (const s of STUDIOS) {
    const password = s.key === 'northlight' ? DEMO_ACCOUNTS.provider.password : `Studio-${s.key}-9`;
    await rt.identity.seed({ email: s.email, password, group: 'Provider' });
    studioTokens[s.key] = (await rt.signIn(s.email, password)).accessToken;
  }
  // (studio tokens are used straight away, within their one-hour lifetime)

  // listings
  const products = new Map();
  const meta = new Map();
  for (const p of CATALOGUE) {
    const studio = STUDIOS.find((s) => s.key === p.studio);
    const res = await rt.client(studioTokens[p.studio]).post('/provider/products', {
      name: p.name, category: p.category, description: p.desc, developer: studio.name, platforms: p.platforms,
      priceCents: p.price, tags: p.tags, features: p.features, licenseType: p.license,
      version: `${1 + Math.floor(rng.next() * 4)}.${Math.floor(rng.next() * 10)}`,
      releaseDate: new Date(start - rng.int(30, 900) * DAY).toISOString().slice(0, 10), publish: true,
    });
    const created = await ok(res, `create ${p.name}`);
    products.set(p.name, created.productId);
    meta.set(created.productId, p);
  }

  // shoppers with category tastes → realistic co-purchase structure
  const categories = [...new Set(CATALOGUE.map((p) => p.category))];
  const people = [];
  for (let i = 0; i < shoppers; i++) {
    rt.clock.advance(rng.exp((days * DAY * 0.3) / shoppers));
    const email = randomPerson(rng, i);
    await rt.identity.seed({ email, password: 'Shopper-pass-1', group: 'Consumer' });
    const tastes = [rng.pick(categories), rng.pick(categories)];
    people.push({ email, tastes, owned: new Set() });
  }

  const pendingReviews = [];
  const end = start + days * DAY;
  const gap = (end - rt.clock.now()) / (orders + 1);
  for (let k = 0; k < orders; k++) {
    await rt.advance(rng.exp(gap));
    while (pendingReviews.length && pendingReviews[0].at <= rt.clock.now()) await postReview(rt, pendingReviews.shift());
    const who = rng.pick(people);
    const pool = [...meta.entries()].filter(([id]) => !who.owned.has(id));
    if (!pool.length) continue;
    const basket = new Set();
    const n = rng.weighted([[1, 6], [2, 3], [3, 1]]);
    for (let j = 0; j < n * 3 && basket.size < n; j++) {
      const [id] = rng.weighted(pool.map(([pid, p]) => [[pid, p], (who.tastes.includes(p.category) ? 6 : 1) * (p.q - 2.3)]));
      basket.add(id);
    }
    // tokens live an hour, so every shopping session signs in afresh
    const api = rt.client((await rt.signIn(who.email, 'Shopper-pass-1')).accessToken);
    for (const id of basket) await api.put(`/cart/${id}`);
    const res = await api.post('/checkout', {}, { 'Idempotency-Key': `seed-${k}-${rng.int(1e6, 9e6)}` });
    if (res.status >= 400) continue;
    const roll = rng.next();
    if (roll < 0.04) continue; // abandoned at the card form
    if (roll < 0.09) await rt.pay(res.data.clientSecret, DECLINE_CARD); // declined first, then retried
    await rt.pay(res.data.clientSecret, GOOD_CARD);
    await rt.advance(5_000); // webhooks and the receipt e-mail arrive
    for (const id of basket) {
      who.owned.add(id);
      if (rng.chance(reviewRate)) {
        pendingReviews.push({ at: rt.clock.now() + rng.exp(3 * DAY), email: who.email, productId: id, review: generateReview(meta.get(id), rng) });
        pendingReviews.sort((a, b) => a.at - b.at);
      }
    }
  }
  for (const r of pendingReviews.filter((x) => x.at <= end)) await postReview(rt, r);

  // the demo buyer owns two products and has reviewed one
  await rt.identity.seed({ ...DEMO_ACCOUNTS.consumer });
  const demo = (await rt.signIn(DEMO_ACCOUNTS.consumer.email, DEMO_ACCOUNTS.consumer.password)).accessToken;
  const dapi = rt.client(demo);
  for (const name of ['Quillwork Notes', 'Glasswing']) await dapi.put(`/cart/${products.get(name)}`);
  const co = await dapi.post('/checkout', {}, { 'Idempotency-Key': 'seed-demo-order-1' });
  await rt.pay(co.data.clientSecret, GOOD_CARD);
  await rt.advance(5_000);
  await dapi.post(`/products/${products.get('Glasswing')}/reviews`, {
    stars: 5, text: 'Calm, clever and beautiful. The later levels are tough but never unfair, and it runs smoothly on my old laptop.',
  });
  await rt.settle(60_000);
  if (rt.clock.resetToReal) rt.clock.resetToReal();
  return { products };
}

async function postReview(rt, r) {
  const token = (await rt.signIn(r.email, 'Shopper-pass-1')).accessToken;
  await rt.client(token).post(`/products/${r.productId}/reviews`, r.review);
}
