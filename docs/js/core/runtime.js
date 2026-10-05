// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Local runtime: the whole cloud, in one process.
//
// Wires the real API (`createApp`) to in-memory stand-ins for every managed
// service and models what AWS would add around it:
//   API Gateway   route match + JWT authorizer (401 before Lambda runs)
//   Lambda        one container pool per function; cold start when no warm,
//                 idle container exists; containers expire after idling
//   DynamoDB      createMemoryTable (+ Streams → mailer function)
//   Cognito       createLocalIdentity (post-confirmation trigger → profile)
//   Stripe        createFakeStripe (signed, asynchronous, chaotic webhooks)
//   SES / S3      memory mailer / presigning object store
// Every request produces a trace: gateway → authorizer → container (cold or
// warm) → each table call with its keys and capacity → Stripe calls → status,
// with modelled latency. The website draws it; tests assert on it.

import { createApp, ROUTES } from './api/app.js';
import { match, compile } from './api/router.js';
import { createMemoryTable } from './store.js';
import { createLocalIdentity, principalFromClaims } from './auth.js';
import { createFakeStripe } from './adapters/fake-stripe.js';
import { createMemoryMailer, createMemoryObjects } from './adapters/memory.js';
import { createRng, createIdFactory, AppError } from './util.js';
import { MODEL, ddbLatency, coldInit } from './latency.js';
import { base64url } from './crypto.js';

const COMPILED = compile(ROUTES);

/** Clock that runs at real time but can be shifted (seeding history "in the past"). */
export function createShiftClock(startMs = null) {
  let offset = startMs === null ? 0 : startMs - Date.now();
  return {
    now: () => Date.now() + offset,
    advance(ms) { offset += ms; return Date.now() + offset; },
    set(ms) { offset = ms - Date.now(); },
    resetToReal() { offset = 0; },
  };
}

// Let other in-flight work (e.g. concurrent simulated sessions) reach its next
// await before the clock moves again.
const yieldTurn = typeof setImmediate === 'function'
  ? () => new Promise((r) => setImmediate(r))
  : () => new Promise((r) => setTimeout(r, 0));

/** Task queue: either drained manually (tests, seeding, simulation) or pumped in real time. */
export function createScheduler(clock) {
  const q = [];
  let seq = 0;
  let live = false;
  let timer = null;
  const sched = {
    schedule(delayMs, fn) {
      q.push({ at: Math.round(clock.now() + delayMs), seq: seq++, fn });
      q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (live) arm();
    },
    /** Run every task due now (does not move the clock). */
    async runDue() {
      while (q.length && q[0].at <= clock.now()) await q.shift().fn();
    },
    /** Advance the clock task by task until the queue is empty (or a horizon). */
    async settle(maxMs = 7 * 86_400_000, { concurrent = false } = {}) {
      const end = clock.now() + maxMs;
      while (q.length && q[0].at <= end) {
        const t = q.shift();
        if (t.at > clock.now()) clock.advance(t.at - clock.now());
        await t.fn();
        if (concurrent) await yieldTurn();
      }
    },
    /** Resolve after `ms` of scheduler time (for concurrent simulated actors). */
    sleep(ms) { return new Promise((res) => sched.schedule(ms, res)); },
    async advance(ms) {
      const end = clock.now() + ms;
      while (q.length && q[0].at <= end) {
        const t = q.shift();
        if (t.at > clock.now()) clock.advance(t.at - clock.now());
        await t.fn();
      }
      if (clock.now() < end) clock.advance(end - clock.now());
    },
    pending: () => q.length,
    setLive(on, timeScale = 1) {
      live = on;
      sched.timeScale = timeScale;
      if (on) arm(); else if (timer) { clearTimeout(timer); timer = null; }
    },
    timeScale: 1,
  };
  function arm() {
    if (timer) clearTimeout(timer);
    if (!q.length) return;
    const wait = Math.max(0, (q[0].at - clock.now()) / sched.timeScale);
    timer = setTimeout(async () => {
      timer = null;
      const t = q.shift();
      if (t) {
        // in live mode modelled time may run ahead of the wall clock (time-scale)
        if (t.at > clock.now()) clock.advance(t.at - clock.now());
        try { await t.fn(); } catch (e) { if (!globalThis.__SOFTHUB_QUIET__) console.error(e); }
      }
      arm();
    }, wait);
  }
  return sched;
}

export function createLocalRuntime({
  clock = createShiftClock(), seed = 42, chaos = {}, config = {}, stochasticLatency = true,
  modelConcurrency = false, // true: a container stays busy for the modelled duration (simulator)
} = {}) {
  const rng = createRng(seed);
  const newId = createIdFactory(clock, rng.next);
  const scheduler = createScheduler(clock);
  const listeners = new Set();
  const emit = (ev) => { for (const l of listeners) l(ev); };
  let active = null; // trace collecting the current synchronous service call

  const usage = { requests: 0, lambdaMs: 0, gbSeconds: 0, rru: 0, wru: 0, emails: 0, coldStarts: 0, byFn: {} };

  const table = createMemoryTable({
    listener: (rec) => {
      usage.rru += rec.rru; usage.wru += rec.wru;
      if (active) active.ops.push(rec);
    },
    stream: (record) => {
      if (record.eventName === 'INSERT' && record.keys.PK.startsWith('OUTBOX#')) {
        scheduler.schedule(250 + rng.next() * 400, () => invokeStream(record));
      }
    },
  });
  const mailer = createMemoryMailer({ clock, listener: (m) => { usage.emails++; emit({ kind: 'email', mail: m }); } });
  const objects = createMemoryObjects({ clock });
  const webhookSecret = config.webhookSecret || 'whsec_local_demo';
  const stripe = createFakeStripe({
    clock, rng, schedule: scheduler.schedule, webhookSecret, chaos,
    listener: (rec) => { if (active && rec.kind === 'api') active.stripe.push(rec); emit({ kind: 'stripe', rec }); },
  });
  const cfg = {
    licenseSecret: 'local-licence-secret', webhookSecret, appUrl: 'https://softhub.local', allowedOrigins: ['*'], ...config,
  };

  const deps = { table, payments: stripe, mailer, objects, clock, newId, config: cfg };
  // Lambda containers: fn → [{id, app, busyUntil, warmUntil, invocations}]
  const pools = {};
  let containerSeq = 0;

  const identity = createLocalIdentity({
    clock, random: rng.next, mailer,
    onConfirmed: (u) => container('shop').app.onUserConfirmed(u),
  });
  deps.directory = { setEnabled: (sub, on) => identity.adminSetEnabled(sub, on) };

  function container(fn, at = clock.now()) {
    const pool = (pools[fn] ||= []);
    for (let i = pool.length - 1; i >= 0; i--) if (pool[i].warmUntil < at) pool.splice(i, 1); // reaped
    let c = pool.find((x) => x.busyUntil <= at);
    let cold = false;
    if (!c) {
      c = { id: `${fn}-${(++containerSeq).toString(36)}`, app: createApp({ ...deps, cache: {} }, { fn: fn === 'mailer' ? null : fn }), busyUntil: 0, warmUntil: 0, invocations: 0 };
      pool.push(c);
      cold = true;
    }
    return { ...c, ref: c, cold };
  }

  function modelDuration(trace, cold) {
    const r = stochasticLatency ? rng : null;
    const init = cold ? coldInit(r) : 0;
    let work = MODEL.handlerBaseMs;
    for (const op of trace.ops) { op.ms = ddbLatency(r, op); work += op.ms; }
    for (const s of trace.stripe) { s.ms = r ? r.lognormal(MODEL.stripeApiMs, MODEL.stripeSigma) : MODEL.stripeApiMs; work += s.ms; }
    return { initMs: init, handlerMs: work };
  }

  /** Invoke an HTTP route as API Gateway + Lambda would. */
  async function request({ method = 'GET', path, query = {}, body, headers = {}, token = null, source = 'browser' }) {
    const startedAt = clock.now();
    const trace = { id: newId('t_'), source, method, path, query, startedAt, steps: [], ops: [], stripe: [], status: 0 };
    const m = match(COMPILED, method.toUpperCase(), path);
    let principal = null;
    // ---- API Gateway JWT authorizer
    if (m?.route?.auth) {
      if (!token) return gatewayReject(trace, 401, 'auth.required', 'Missing bearer token');
      try {
        const claims = identity.verify(token);
        principal = principalFromClaims(claims);
        trace.steps.push({ step: 'authorizer', ok: true, sub: principal.sub, groups: principal.groups });
      } catch (e) {
        trace.steps.push({ step: 'authorizer', ok: false, reason: e.message });
        return gatewayReject(trace, 401, 'auth.invalid', e.message);
      }
    }
    const fn = m?.route?.fn || 'catalog';
    const c = container(fn, startedAt);
    trace.fn = fn; trace.container = c.id; trace.cold = c.cold;
    if (c.cold) usage.coldStarts++;
    const scopedTable = tracingTable(trace);
    const scopedPayments = tracingPayments(trace);
    const res = await c.ref.app.handle({
      method, path, query, headers, principal, requestId: newId('req_'),
      body: typeof body === 'string' || body === undefined ? body : JSON.stringify(body),
      scope: { table: scopedTable, payments: scopedPayments },
      trace: (s) => trace.steps.push(s),
    });
    const { initMs, handlerMs } = modelDuration(trace, c.cold);
    const totalMs = MODEL.apiGatewayMs + initMs + handlerMs;
    c.ref.busyUntil = modelConcurrency ? startedAt + totalMs : startedAt;
    c.ref.warmUntil = startedAt + totalMs + MODEL.idleTimeoutMs;
    c.ref.invocations++;
    Object.assign(trace, { status: res.status, initMs, handlerMs, totalMs, apiGatewayMs: MODEL.apiGatewayMs });
    account(fn, initMs + handlerMs);
    let data = null;
    try { data = res.body ? JSON.parse(res.body) : null; } catch { data = res.body; }
    trace.response = data;
    emit({ kind: 'request', trace });
    return { status: res.status, headers: res.headers, data, trace };
  }

  function gatewayReject(trace, status, code, message) {
    Object.assign(trace, { status, gateway: true, totalMs: MODEL.apiGatewayMs, initMs: 0, handlerMs: 0, response: { error: { code, message } } });
    usage.requests++;
    emit({ kind: 'request', trace });
    return { status, headers: {}, data: trace.response, trace };
  }

  function account(fn, ms) {
    usage.requests++;
    const mem = fn === 'admin' || fn === 'mailer' ? 256 : 512;
    const billed = Math.ceil(ms);
    usage.lambdaMs += billed;
    usage.gbSeconds += (billed / 1000) * (mem / 1024);
    const f = (usage.byFn[fn] ||= { invocations: 0, ms: 0 });
    f.invocations++; f.ms += billed;
  }

  async function invokeStream(record) {
    const trace = { id: newId('t_'), source: 'dynamodb-stream', method: 'STREAM', path: `INSERT ${record.keys.PK}`, startedAt: clock.now(), steps: [], ops: [], stripe: [], status: 200 };
    const c = container('mailer');
    trace.fn = 'mailer'; trace.container = c.id; trace.cold = c.cold;
    const prev = active; active = trace;
    try {
      await c.ref.app.processStreamRecord(record);
    } finally { active = prev; }
    const { initMs, handlerMs } = modelDuration(trace, c.cold);
    const sesMs = 60;
    Object.assign(trace, { initMs, handlerMs: handlerMs + sesMs, totalMs: initMs + handlerMs + sesMs });
    c.ref.busyUntil = modelConcurrency ? trace.startedAt + trace.totalMs : trace.startedAt;
    c.ref.warmUntil = trace.startedAt + trace.totalMs + MODEL.idleTimeoutMs;
    account('mailer', initMs + handlerMs + sesMs);
    emit({ kind: 'request', trace });
  }

  function tracingTable(trace) {
    const wrap = (name) => async (...args) => {
      const prev = active; active = trace;
      try { return await table[name](...args); } finally { active = prev; }
    };
    return {
      name: table.name, get: wrap('get'), batchGet: wrap('batchGet'), put: wrap('put'), update: wrap('update'),
      delete: wrap('delete'), query: wrap('query'), transact: wrap('transact'),
    };
  }
  function tracingPayments(trace) {
    const wrap = (name) => async (...args) => {
      const prev = active; active = trace;
      try { return await stripe[name](...args); } finally { active = prev; }
    };
    return { createPaymentIntent: wrap('createPaymentIntent'), refund: wrap('refund'), cancel: wrap('cancel') };
  }

  // Stripe → our webhook endpoint (through the gateway like any other request)
  stripe.addEndpoint(async (raw, headers) => {
    const r = await request({ method: 'POST', path: '/webhooks/stripe', body: raw, headers, source: 'stripe' });
    return { status: r.status };
  });

  const runtime = {
    clock, rng, scheduler, table, identity, stripe, mailer, objects, deps, usage, pools,
    request,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** A tiny client bound to a token, mirroring web/src/api.js. */
    client(token = null) {
      const call = (method, path, body, extra = {}) => request({ method, path, body, token, ...extra });
      return {
        get: (path, query) => call('GET', path, undefined, { query: query || {} }),
        put: (path, body) => call('PUT', path, body),
        post: (path, body, headers) => call('POST', path, body, { headers: headers || {} }),
        del: (path) => call('DELETE', path),
      };
    },
    async signIn(email, password) {
      return identity.signIn({ email, password });
    },
    /** Browser side of a checkout: confirm the PaymentIntent with a card. */
    async pay(clientSecret, card) {
      return stripe.confirmCardPayment(clientSecret, card);
    },
    async settle(ms) { return scheduler.settle(ms); },
    async advance(ms) { return scheduler.advance(ms); },
    newIdempotencyKey: () => base64url(Array.from({ length: 12 }, () => Math.floor(rng.next() * 256))).replace(/[^A-Za-z0-9_-]/g, 'x'),
    warmContainers() {
      const now = clock.now();
      return Object.fromEntries(Object.entries(pools).map(([fn, p]) => [fn, p.filter((c) => c.warmUntil >= now).map((c) => ({ id: c.id, invocations: c.invocations, idleForMs: Math.max(0, now - c.busyUntil) }))]));
    },
  };
  return runtime;
}

export { AppError };
