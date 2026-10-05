// SoftHub simulator — runs the real API on the local runtime and measures it.
//
//   node sim/run.mjs            all experiments → results/*.json + docs/data/results.js
//   node sim/run.mjs --quick    smaller runs (CI)
//
// Experiments
//   1. launch day   — a day of shopping sessions with a launch-hour spike:
//                     latency per function, cold starts, capacity, cost per order
//   2. chaos        — fulfilment under duplicated, delayed, failing webhooks:
//                     full audit after every run + time from payment to licence
//   3. cold starts  — warm-container model swept over traffic levels
//   4. recommender  — leave-last-out hit-rate@5 on the purchase histories
//   5. sentiment    — held-out accuracy, star/text agreement on generated reviews

import { writeFileSync, mkdirSync } from 'node:fs';
import { createLocalRuntime } from '../packages/core/src/runtime.js';
import { seedMarketplace } from '../packages/core/src/seedrun.js';
import { audit } from '../packages/core/src/invariants.js';
import { createRng, manualClock } from '../packages/core/src/util.js';
import { MODEL, PRICES, monthlyCost, coldInit } from '../packages/core/src/latency.js';
import { relatedProducts, recommendForUser, popularity, contentSimilarity } from '../packages/core/src/recommend.js';
import { loadCatalogue, togetherCounts } from '../packages/core/src/api/catalog.js';
import { cardFee } from '../packages/core/src/payments.js';
import { evaluate } from './eval-sentiment.mjs';
import { readFileSync } from 'node:fs';
import { generateReview, CATALOGUE } from '../packages/core/src/seed.js';
import { analyseReview } from '../packages/core/src/sentiment.js';

globalThis.__SOFTHUB_QUIET__ = true;
const QUICK = process.argv.includes('--quick');
const HOUR = 3_600_000;
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const log = (...a) => console.log(...a);

// --------------------------------------------------------------- 1. launch day

async function launchDay({ sessions = QUICK ? 600 : 2400, seed = 3 } = {}) {
  const t0 = Date.UTC(2026, 9, 14, 4); // 00:00 in Montréal
  const clock = manualClock(t0 - 40 * 86_400_000);
  const rt = createLocalRuntime({ clock, seed, modelConcurrency: true, chaos: { duplicateRate: 0.02, dropFirstAttemptRate: 0.01 } });
  const shiftShim = { ...rt, clock: { ...clock, set: clock.set } };
  const { products } = await seedMarketplace(shiftShim, { orders: QUICK ? 80 : 160, shoppers: 60, days: 38, seed });
  clock.set(t0);
  // reset the meters: we measure the day only
  Object.assign(rt.usage, { requests: 0, lambdaMs: 0, gbSeconds: 0, rru: 0, wru: 0, emails: 0, coldStarts: 0, byFn: {} });
  for (const k of Object.keys(rt.pools)) rt.pools[k].length = 0;

  const rng = createRng(seed * 7);
  const ids = [...products.values()];
  const cats = [...new Set(CATALOGUE.map((p) => p.category))];
  // hourly profile (Montréal evening peak) and a launch spike 19:00–20:00
  const profile = [0.3, 0.2, 0.15, 0.12, 0.12, 0.2, 0.4, 0.7, 0.9, 1, 1, 1.05, 1.1, 1.05, 1, 1, 1.1, 1.3, 1.6, 4.0, 2.0, 1.4, 0.9, 0.5];
  const totalW = profile.reduce((a, b) => a + b, 0);
  const traces = [];
  const off = rt.onEvent((e) => { if (e.kind === 'request') traces.push(e.trace); });
  const shoppers = [];
  for (let i = 0; i < 400; i++) {
    const email = `day.shopper${i}@example.com`;
    await rt.identity.seed({ email, password: 'Shopper-pass-1', group: 'Consumer' });
    shoppers.push(email);
  }
  let orders = 0, checkouts = 0;
  const sleep = (ms) => rt.scheduler.sleep(ms);
  const session = async () => {
    const api = rt.client();
    await api.get('/products', { category: rng.pick(cats) });
    const views = rng.int(1, 4);
    let last = null;
    for (let v = 0; v < views; v++) {
      await sleep(rng.lognormal(8000, 0.6));
      last = rng.pick(ids);
      await api.get(`/products/${last}`);
      if (rng.chance(0.7)) await api.get(`/products/${last}/insights`);
      if (rng.chance(0.5)) await api.get(`/products/${last}/reviews`);
      if (rng.chance(0.6)) await api.get(`/products/${last}/related`);
    }
    if (!rng.chance(0.22)) return;
    const token = (await rt.signIn(rng.pick(shoppers), 'Shopper-pass-1')).accessToken;
    const me = rt.client(token);
    await sleep(rng.lognormal(5000, 0.5));
    const add = await me.put(`/cart/${last}`);
    if (add.status !== 200) return;
    await me.get('/cart');
    if (!rng.chance(0.55)) return;
    await sleep(rng.lognormal(6000, 0.5));
    const co = await me.post('/checkout', {}, { 'Idempotency-Key': `day-${rng.int(1e8, 9e8)}` });
    if (co.status !== 201) return;
    checkouts++;
    await sleep(rng.lognormal(20_000, 0.4)); // typing the card
    const card = rng.chance(0.93) ? '4242424242424242' : '4000000000000002';
    const pay = await rt.pay(co.data.clientSecret, { number: card, exp: '12/34', cvc: '123' });
    if (pay.error) { await sleep(15_000); await rt.pay(co.data.clientSecret, { number: '4242424242424242', exp: '12/34', cvc: '123' }); }
    for (let i = 0; i < 4; i++) {
      await sleep(1500);
      const o = await me.get(`/orders/${co.data.orderId}`);
      if (o.data.status === 'PAID') { orders++; break; }
    }
  };

  // schedule session starts
  const starts = [];
  for (let s = 0; s < sessions; s++) {
    let r = rng.next() * totalW, h = 0;
    while ((r -= profile[h]) > 0) h++;
    starts.push(t0 + h * HOUR + rng.next() * HOUR);
  }
  starts.sort((a, b) => a - b);
  for (const at of starts) rt.scheduler.schedule(at - clock.now(), () => { session(); });
  // drive: sessions interleave because each sleeps on scheduler time
  await rt.scheduler.settle(26 * HOUR, { concurrent: true });
  off();

  const byFn = {};
  for (const t of traces) {
    const f = (byFn[t.fn || 'gateway'] ||= { n: 0, cold: 0, ms: [], coldMs: [] });
    f.n++;
    if (t.cold) { f.cold++; f.coldMs.push(t.totalMs); }
    f.ms.push(t.totalMs);
  }
  const fnStats = Object.fromEntries(Object.entries(byFn).map(([fn, f]) => [fn, {
    requests: f.n, coldStarts: f.cold, coldRate: r3(f.cold / f.n), p50: r1(pct(f.ms, 50)), p95: r1(pct(f.ms, 95)), p99: r1(pct(f.ms, 99)),
  }]));
  const hourly = Array.from({ length: 24 }, (_, h) => {
    const ts = traces.filter((t) => t.startedAt >= t0 + h * HOUR && t.startedAt < t0 + (h + 1) * HOUR);
    return { hour: h, requests: ts.length, cold: ts.filter((t) => t.cold).length, p95: r1(pct(ts.map((t) => t.totalMs), 95)) };
  });
  const u = rt.usage;
  const day = monthlyCost({ lambdaGbSeconds: u.gbSeconds, lambdaRequests: u.requests, apiRequests: traces.filter((t) => t.source !== 'dynamodb-stream').length, wru: u.wru, rru: u.rru, emails: u.emails, storageGb: 0.05 / 30 });
  const gmv = traces.filter((t) => t.path === '/checkout' && t.status === 201).reduce((a, t) => a + (t.response?.amountCents || 0), 0);
  const a = audit(rt);
  return {
    sessions, requests: traces.length, checkouts, orders, gmvCents: gmv,
    functions: fnStats, hourly,
    coldStartRate: r3(traces.filter((t) => t.cold).length / traces.length),
    capacity: { rru: r1(u.rru), wru: u.wru },
    cost: { perDayUsd: r3(day.total), perMonthUsd: r1(day.total * 30), breakdownPerDay: Object.fromEntries(Object.entries(day).map(([k, v]) => [k, r3(v)])), infraPerOrderUsd: Math.round((day.total / Math.max(1, orders)) * 1e6) / 1e6, stripeFeesCad: r1(traces.filter((t) => t.path === '/checkout' && t.status === 201).reduce((a2, t) => a2 + cardFee(t.response.amountCents), 0) / 100) },
    audit: { ok: a.ok, checks: a.checks.map(({ name, ok, checked }) => ({ name, ok, checked })) },
  };
}

// ------------------------------------------------------------------ 2. chaos

async function chaosRuns() {
  const levels = [
    { name: 'calm', duplicateRate: 0, dropFirstAttemptRate: 0, jitterMs: 300 },
    { name: '10 % duplicates', duplicateRate: 0.1, dropFirstAttemptRate: 0, jitterMs: 300 },
    { name: 'every event twice', duplicateRate: 1, dropFirstAttemptRate: 0, jitterMs: 300 },
    { name: 'endpoint down on first try', duplicateRate: 0, dropFirstAttemptRate: 1, jitterMs: 300 },
    { name: 'storm (dupes + failures + 20 s jitter)', duplicateRate: 0.5, dropFirstAttemptRate: 0.3, jitterMs: 20_000 },
  ];
  const out = [];
  for (const [i, lvl] of levels.entries()) {
    const rt = createLocalRuntime({ clock: manualClock(Date.UTC(2026, 8, 1)), seed: 100 + i, chaos: lvl, stochasticLatency: false });
    const deliveries = [];
    rt.onEvent((e) => { if (e.kind === 'stripe' && e.rec.kind === 'delivery') deliveries.push(e.rec); });
    const grantedAt = new Map();
    rt.onEvent((e) => {
      if (e.kind === 'request' && e.trace.path === '/webhooks/stripe' && e.trace.response?.fulfilled) {
        const pi = e.trace.steps.find((s) => s.step === 'webhook.verified');
        if (pi) grantedAt.set(pi.eventId, e.trace.startedAt);
      }
    });
    await seedMarketplace(rt, { orders: QUICK ? 60 : 200, shoppers: 50, seed: 9 + i });
    await rt.settle(7 * 24 * HOUR);
    const events = rt.stripe._events;
    const lag = [];
    for (const ev of events.filter((e) => e.type === 'payment_intent.succeeded')) {
      const g = grantedAt.get(ev.id);
      if (g !== undefined) lag.push((g - ev.created * 1000) / 1000);
    }
    const a = audit(rt);
    const dl = deliveries.filter((d) => d.type);
    out.push({
      level: lvl.name, chaos: lvl,
      events: events.length,
      deliveries: dl.length,
      duplicatesAbsorbed: dl.filter((d) => d.duplicate).length,
      failedAttempts: dl.filter((d) => !d.ok).length,
      paidOrders: a.counts.paid,
      licences: a.counts.licences,
      receipts: rt.mailer.all().filter((m) => m.kind === 'receipt').length,
      secondsToLicence: { p50: r1(pct(lag, 50)), p95: r1(pct(lag, 95)), max: r1(Math.max(0, ...lag)) },
      auditPassed: a.ok,
      checks: a.checks.length,
      failedChecks: a.checks.filter((c) => !c.ok).map((c) => c.name),
    });
    log(`  chaos "${lvl.name}": ${a.ok ? 'audit OK' : 'AUDIT FAILED'} — ${dl.length} deliveries, ${dl.filter((d) => d.duplicate).length} duplicates, ${dl.filter((d) => !d.ok).length} failed attempts`);
  }
  return out;
}

// ------------------------------------------------------------- 3. cold starts

function coldStartSweep() {
  // One function, Poisson arrivals, warm pool with idle reaping; ~120 ms handler.
  const rates = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  const rows = [];
  for (const rate of rates) {
    const rng = createRng(Math.round(rate * 1e4) + 1);
    const horizon = Math.max(6 * HOUR, (3000 / rate) * 1000);
    let t = 0, cold = 0, n = 0;
    const pool = [];
    const lat = [];
    while (t < horizon && n < 60_000) {
      t += rng.exp(1000 / rate);
      for (let i = pool.length - 1; i >= 0; i--) if (pool[i].warmUntil < t) pool.splice(i, 1);
      let c = pool.find((x) => x.busyUntil <= t);
      let ms = rng.lognormal(25, 0.35);
      if (!c) { c = { busyUntil: 0, warmUntil: 0 }; pool.push(c); ms += coldInit(rng); cold++; }
      c.busyUntil = t + ms; c.warmUntil = t + ms + MODEL.idleTimeoutMs;
      lat.push(ms + MODEL.apiGatewayMs); n++;
    }
    rows.push({ perSecond: rate, perDay: Math.round(rate * 86400), coldRate: r3(cold / n), p50: r1(pct(lat, 50)), p95: r1(pct(lat, 95)), p99: r1(pct(lat, 99)), containers: pool.length });
  }
  return rows;
}

// ---------------------------------------------------------- 4. recommender

async function recommenderEval(seed) {
  const rt = createLocalRuntime({ clock: manualClock(Date.UTC(2026, 8, 1)), seed, stochasticLatency: false });
  await seedMarketplace(rt, { orders: QUICK ? 200 : 600, shoppers: 120, seed, reviewRate: 0.1 });
  const deps = { ...rt.deps, cache: {} };
  const catalogue = await loadCatalogue(deps, { fresh: true });
  const byId = new Map(catalogue.map((p) => [p.productId, p]));
  const rows = rt.table._all().filter((r) => r.SK.startsWith('OWNS#') && r.status === 'ACTIVE');
  const users = new Map();
  for (const r of rows) (users.get(r.PK) || users.set(r.PK, []).get(r.PK)).push(r);
  // co-purchase counts rebuilt WITHOUT each user's held-out item would be ideal;
  // we subtract the held-out pair contributions to avoid leakage.
  const together = new Map();
  for (const p of catalogue) together.set(p.productId, await togetherCounts(deps, p.productId));
  const methods = { 'content + co-purchase (shipped)': 0, 'content only': 0, 'co-purchase only': 0, popularity: 0, random: 0 };
  let n = 0;
  const rng = createRng(5);
  for (const [, owned] of users) {
    if (owned.length < 2) continue;
    owned.sort((a, b) => a.since - b.since);
    const held = owned[owned.length - 1].productId;
    const history = owned.slice(0, -1).map((o) => byId.get(o.productId)).filter(Boolean);
    const hist = new Set(history.map((p) => p.productId));
    // leakage guard: remove this user's own contribution of (held, h) pairs and the held buyer
    const adj = (pid) => {
      const m = new Map(together.get(pid));
      if (pid === held) for (const h of hist) m.set(h, Math.max(0, (m.get(h) || 0) - 1));
      else if (hist.has(pid)) m.set(held, Math.max(0, (m.get(held) || 0) - 1));
      return m;
    };
    const cat = catalogue.map((p) => (p.productId === held ? { ...p, buyers: Math.max(0, p.buyers - 1) } : p));
    const top = (list) => list.slice(0, 5).map((r) => r.productId);
    if (top(recommendForUser(history, cat, adj, { limit: 5 })).includes(held)) methods['content + co-purchase (shipped)']++;
    if (top(recommendForUser(history, cat, adj, { limit: 5, beta: 0 })).includes(held)) methods['content only']++;
    if (top(recommendForUser(history, cat, adj, { limit: 5, useContent: false })).includes(held)) methods['co-purchase only']++;
    if (cat.filter((p) => !hist.has(p.productId)).sort((a, b) => popularity(b) - popularity(a)).slice(0, 5).some((p) => p.productId === held)) methods.popularity++;
    const pool = cat.filter((p) => !hist.has(p.productId));
    const pick = new Set();
    while (pick.size < Math.min(5, pool.length)) pick.add(rng.pick(pool).productId);
    if (pick.has(held)) methods.random++;
    n++;
  }
  return { users: n, catalogue: catalogue.length, hitRateAt5: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, r3(v / n)])) };
}

// -------------------------------------------------------------- 5. sentiment

function sentimentEval() {
  const load = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const strip = ({ errors, ...r }) => r;
  const test = evaluate(load('reviews_test.jsonl'));
  const dev = evaluate(load('reviews_dev.jsonl'));
  // star/text agreement on generated marketplace reviews
  const rng = createRng(77);
  let agree = 0, n = 0;
  const byStars = {};
  for (let i = 0; i < 2000; i++) {
    const p = rng.pick(CATALOGUE);
    const r = generateReview(p, rng);
    const a = analyseReview(r.text);
    const expected = r.stars >= 4 ? 'positive' : r.stars <= 2 ? 'negative' : null;
    (byStars[r.stars] ||= []).push(a.compound);
    if (expected) { n++; if (a.label === expected) agree++; }
  }
  return {
    test: strip(test), dev: strip(dev),
    starAgreement: r3(agree / n),
    meanCompoundByStars: Object.fromEntries(Object.entries(byStars).map(([s, xs]) => [s, r3(xs.reduce((a, b) => a + b, 0) / xs.length)])),
    reviewsByStars: Object.fromEntries(Object.entries(byStars).map(([s, xs]) => [s, xs.length])),
  };
}

// --------------------------------------------------------------------- main

const t0 = Date.now();
log('1/5 launch day …');
const day = await launchDay();
log(`    ${day.requests} requests, ${day.orders} orders, cold-start rate ${day.coldStartRate}, ~$${day.cost.perMonthUsd}/month, audit ${day.audit.ok ? 'OK' : 'FAILED'}`);
log('2/5 chaos …');
const chaos = await chaosRuns();
log('3/5 cold-start sweep …');
const cold = coldStartSweep();
log('4/5 recommender …');
// seed 21 was used to choose β; seeds 33, 45, 57 are fresh histories
const recRuns = [];
for (const s of QUICK ? [33] : [33, 45, 57]) recRuns.push(await recommenderEval(s));
const recs = {
  users: recRuns.reduce((a, r) => a + r.users, 0), catalogue: recRuns[0].catalogue, seeds: QUICK ? [33] : [33, 45, 57],
  hitRateAt5: Object.fromEntries(Object.keys(recRuns[0].hitRateAt5).map((k) => [k, r3(recRuns.reduce((a, r) => a + r.hitRateAt5[k] * r.users, 0) / recRuns.reduce((a, r) => a + r.users, 0))])),
};
log(`    hit-rate@5 ${JSON.stringify(recs.hitRateAt5)} over ${recs.users} users`);
log('5/5 sentiment …');
const sentiment = sentimentEval();
log(`    test accuracy ${sentiment.test.accuracy}, macro-F1 ${sentiment.test.macroF1}; star agreement ${sentiment.starAgreement}`);

const results = { generatedAt: new Date().toISOString().slice(0, 10), quick: QUICK, model: MODEL, prices: PRICES, launchDay: day, chaos, coldStarts: cold, recommender: recs, sentiment };
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(new URL('../results/summary.json', import.meta.url), JSON.stringify(results, null, 2));
if (!QUICK) {
  mkdirSync(new URL('../docs/data/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../docs/data/results.js', import.meta.url), `// generated by sim/run.mjs\nexport const RESULTS = ${JSON.stringify(results)};\n`);
}
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (!day.audit.ok || chaos.some((c) => !c.auditPassed)) process.exit(1);
