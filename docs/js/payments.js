// Lab 4: chaos console for webhooks, state machine, audit, signature checks.
import { h, s, $, $$, mount, int } from './ui.js';
import { audit } from './core/invariants.js';
import { signWebhook } from './core/payments.js';

let app;
const run = { t0: 0, rows: new Map(), marks: [], active: false, n: 0, stats: { deliveries: 0, duplicates: 0, failed: 0, licences: 0 } };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function initPayments(a) {
  app = a;
  const upd = () => {
    const dup = +$('#c-dup').value / 100, drop = +$('#c-drop').value / 100, jit = +$('#c-jit').value;
    $('#v-dup').textContent = `${Math.round(dup * 100)} %`;
    $('#v-drop').textContent = `${Math.round(drop * 100)} %`;
    $('#v-jit').textContent = `${jit} s`;
    app.rt.stripe.setChaos({ duplicateRate: dup, dropFirstAttemptRate: drop, jitterMs: jit * 1000, latencyMs: 400 + jit * 500 });
  };
  for (const id of ['#c-dup', '#c-drop', '#c-jit']) $(id).addEventListener('input', upd);
  upd();
  $('#run-chaos').addEventListener('click', runBatch);
  $('#run-audit').addEventListener('click', doAudit);
  for (const b of $$('[data-sig]')) b.addEventListener('click', () => sig(b.dataset.sig));
  app.on('rt:stripe', ({ rec }) => onStripe(rec));
  app.on('rt:request', ({ trace }) => { if (trace.source === 'stripe') onWebhook(trace); });
  drawFsm();
  tally();
  draw();
  addEventListener('resize', draw);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
}

function piOfEvent(eventId) {
  return app.rt.stripe._events.find((e) => e.id === eventId)?.data.object.id;
}

function mark(pi, kind) {
  if (!run.active || !run.rows.has(pi)) return;
  run.marks.push({ row: run.rows.get(pi), t: performance.now() - run.t0, kind });
  draw();
}

function onStripe(rec) {
  if (rec.kind === 'api' && /confirm/.test(rec.call)) mark(rec.paymentIntent, rec.outcome === 'succeeds' || rec.outcome === 'requires_action' ? 'pay' : 'decline');
  if (rec.kind === 'delivery' && run.active) {
    const pi = piOfEvent(rec.eventId);
    if (!run.rows.has(pi)) return;
    run.stats.deliveries++;
    if (!rec.ok) { run.stats.failed++; mark(pi, 'fail'); }
    tally();
  }
}

function onWebhook(trace) {
  const r = trace.response || {};
  const evt = trace.steps.find((x) => x.step === 'webhook.verified');
  if (!evt || !run.active) { drawFsm(); return; }
  const pi = piOfEvent(evt.eventId);
  if (r.duplicate) { run.stats.duplicates++; mark(pi, 'dup'); }
  else if (r.fulfilled) { run.stats.licences += r.licences; mark(pi, 'ok'); }
  else if (r.failed) mark(pi, 'decline');
  tally();
  drawFsm();
}

async function runBatch() {
  const btn = $('#run-chaos');
  btn.disabled = true;
  Object.assign(run, { t0: performance.now(), rows: new Map(), marks: [], active: true, stats: { deliveries: 0, duplicates: 0, failed: 0, licences: 0 } });
  mount($('#checks'), h('p', { class: 'empty' }, 'Run the audit when the timeline settles.'));
  const mixed = $('#c-cards').value === 'mixed';
  const ids = [...app.rt.table._all().filter((r) => r.SK === 'META' && r.PK.startsWith('PRODUCT#') && r.status === 'PUBLISHED').map((r) => r.productId)];
  const status = $('#chaos-status');
  const jobs = [];
  for (let i = 0; i < 12; i++) {
    jobs.push((async () => {
      await new Promise((r) => setTimeout(r, i * 350));
      const email = `lab.${Date.now().toString(36)}.${i}@example.com`;
      await app.rt.identity.seed({ email, password: 'Lab-buyer-1', group: 'Consumer' });
      const token = (await app.rt.signIn(email, 'Lab-buyer-1')).accessToken;
      const api = app.rt.client(token);
      const pick = ids[(i * 7 + run.n) % ids.length];
      await api.put(`/cart/${pick}`);
      const co = await api.post('/checkout', {}, { 'Idempotency-Key': `lab-${Date.now().toString(36)}-${i}` });
      if (co.status !== 201) return;
      run.rows.set(co.data.paymentIntentId, i);
      const roll = mixed ? i % 6 : 0;
      const card = (n) => ({ number: n, exp: '12/34', cvc: '123' });
      if (roll === 1) { await app.rt.pay(co.data.clientSecret, card('4000000000000002')); await new Promise((r) => setTimeout(r, 900)); }
      if (roll === 2) { await app.rt.pay(co.data.clientSecret, card('4000002500003155')); await new Promise((r) => setTimeout(r, 600)); await app.rt.stripe.handleNextAction(co.data.clientSecret, true); return; }
      await app.rt.pay(co.data.clientSecret, card('4242424242424242'));
    })());
  }
  status.textContent = 'Checkouts running; webhooks arrive over the next seconds…';
  await Promise.all(jobs);
  run.n++;
  setTimeout(() => { btn.disabled = false; status.textContent = 'Done. Retries keep arriving for a few seconds; then run the audit.'; }, 6000);
}

function tally() {
  const st = run.stats;
  mount($('#tally'),
    h('div', {}, h('b', {}, int(st.deliveries)), h('span', {}, 'deliveries')),
    h('div', {}, h('b', {}, int(st.duplicates)), h('span', {}, 'duplicates absorbed')),
    h('div', {}, h('b', {}, int(st.failed)), h('span', {}, 'failed, retried')),
    h('div', {}, h('b', {}, int(st.licences)), h('span', {}, 'licences issued')));
}

function draw() {
  const cv = $('#lanes');
  if (!cv) return;
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth || 600, hh = cv.clientHeight || 260;
  cv.width = w * dpr; cv.height = hh * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, hh);
  const L = 54, R = 12, T = 10, B = 22;
  const span = Math.max(8000, ...run.marks.map((m) => m.t + 1500));
  const x = (t) => L + (t / span) * (w - L - R);
  const rowH = (hh - T - B) / 12;
  g.font = `10px ${css('--f-mono') || 'monospace'}`;
  g.fillStyle = css('--muted');
  g.strokeStyle = css('--line');
  for (let i = 0; i < 12; i++) {
    const y = T + i * rowH + rowH / 2;
    g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
    g.fillText(`order ${i + 1}`, 4, y + 3);
  }
  const step = span > 40000 ? 10000 : span > 16000 ? 5000 : 2000;
  for (let t = 0; t <= span; t += step) { g.fillText(`${t / 1000}s`, x(t) - 6, hh - 6); }
  const color = { pay: css('--flow'), ok: css('--good'), dup: css('--warn'), fail: css('--bad'), decline: css('--muted') };
  const seen = {};
  for (const m of run.marks) {
    const key = `${m.row}-${Math.round(m.t / 120)}`;
    const off = (seen[key] = (seen[key] || 0) + 1) - 1;
    const y = T + m.row * rowH + rowH / 2;
    g.fillStyle = color[m.kind];
    g.beginPath();
    if (m.kind === 'pay') g.rect(x(m.t) - 3, y - 6, 6, 12);
    else g.arc(x(m.t) + off * 7, y, 5, 0, Math.PI * 2);
    g.fill();
  }
  if (!run.marks.length) {
    g.fillStyle = css('--muted');
    g.font = `13px ${css('--f-body') || 'sans-serif'}`;
    g.fillText('Press "Run 12 checkouts" to fill the timeline.', L + 10, hh / 2);
  }
}

const STATES = [
  { id: 'PENDING_PAYMENT', x: 10, y: 74 }, { id: 'PAID', x: 170, y: 20 }, { id: 'CANCELLED', x: 170, y: 132 },
  { id: 'REFUNDED', x: 310, y: 20 }, { id: 'PARTIALLY_REFUNDED', x: 262, y: 88 },
];
function drawFsm() {
  const svg = $('#fsm');
  if (!svg || !app?.rt) return;
  const counts = {};
  for (const r of app.rt.table._all()) if (r.SK === 'META' && r.PK.startsWith('ORDER#')) counts[r.status] = (counts[r.status] || 0) + 1;
  const box = (st) => ({ w: st.id.length * 7 + 20, h: 40 });
  const ctr = (id, side) => { const st = STATES.find((q) => q.id === id); const b = box(st); return side === 'r' ? [st.x + b.w, st.y + b.h / 2] : side === 'l' ? [st.x, st.y + b.h / 2] : side === 'b' ? [st.x + b.w / 2, st.y + b.h] : [st.x + b.w / 2, st.y]; };
  const edge = (a, b, label, sa = 'r', sb = 'l') => {
    const [x1, y1] = ctr(a, sa), [x2, y2] = ctr(b, sb);
    return [s('path', { class: 'ed', d: `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`, 'marker-end': 'url(#arr)' }),
      s('text', { class: 'ed-l', x: (x1 + x2) / 2 - 20, y: (y1 + y2) / 2 - 4 }, label)];
  };
  svg.replaceChildren(
    s('defs', {}, s('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'currentColor', class: 'ed-l' }))),
    ...edge('PENDING_PAYMENT', 'PAID', 'succeeded'),
    ...edge('PENDING_PAYMENT', 'CANCELLED', 'canceled'),
    ...edge('PAID', 'REFUNDED', 'refunded'),
    ...edge('PAID', 'PARTIALLY_REFUNDED', 'part refund', 'b', 'l'),
    ...STATES.map((st) => {
      const b = box(st);
      return s('g', { class: `st${counts[st.id] ? ' on' : ''}` },
        s('rect', { x: st.x, y: st.y, width: b.w, height: b.h, rx: 8 }),
        s('text', { x: st.x + 10, y: st.y + 17 }, st.id.replace('_', ' ').toLowerCase()),
        s('text', { class: 'n', x: st.x + 10, y: st.y + 32 }, int(counts[st.id] || 0)));
    }),
    s('text', { class: 'ed-l', x: 10, y: 182 }, 'payment_failed keeps it pending · stale events are ignored'),
  );
}

function doAudit() {
  const a = audit(app.rt);
  mount($('#checks'), a.checks.map((c) => h('div', { class: 'check' },
    h('span', { class: c.ok ? 'ok' : 'ko' }, c.ok ? '✓' : '✗'), h('span', {}, c.name), h('span', { class: 'small muted num' }, int(c.checked)))));
}

async function sig(kind) {
  const out = $('#sig-out');
  const evt = [...app.rt.stripe._events].reverse().find((e) => e.type === 'payment_intent.succeeded');
  if (!evt) { out.textContent = 'No payment yet: buy something in the storefront first.'; return; }
  const now = Math.floor(app.rt.clock.now() / 1000);
  const secret = app.rt.stripe.webhookSecret;
  let body = JSON.stringify(evt);
  let header = signWebhook(secret, body, now);
  if (kind === 'tamper') { const t = JSON.parse(body); t.data.object.amount = 1; body = JSON.stringify(t); }
  if (kind === 'old') header = signWebhook(secret, body, now - 3600);
  if (kind === 'wrong') header = signWebhook('whsec_attacker', body, now);
  const r = await app.rt.request({ method: 'POST', path: '/webhooks/stripe', body, headers: { 'stripe-signature': header }, source: 'stripe' });
  const why = { valid: 'Signature valid, but the event id was already processed: accepted (200) so Stripe stops retrying, and nothing changes.', tamper: 'One changed byte in the body breaks the HMAC.', old: 'A correctly signed but old message is refused, so a captured request cannot be replayed later.', wrong: 'Only Stripe and this endpoint know the secret.' }[kind];
  out.textContent = `Stripe-Signature: ${header.slice(0, 60)}…\n→ ${r.status} ${JSON.stringify(r.data)}\n\n${why}`;
}

