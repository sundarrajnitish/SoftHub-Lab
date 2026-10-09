// "Behind the scenes": a drawer that tells, in plain words, what each click
// made the cloud do, with the live diagram and an optional timing breakdown.
import { h, $, mount, ms, money, chip } from './ui.js';

let app;
const items = [];

export function initScenes(a) {
  app = a;
  $('#scenes-btn').addEventListener('click', () => toggle(!app.scenesOpen));
  $('#drawer-close').addEventListener('click', () => toggle(false));
  $('#scrim').addEventListener('click', () => toggle(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && app.scenesOpen) toggle(false); });
  app.on('open-scenes', () => toggle(true));
  app.on('rt:request', ({ trace }) => add(fromTrace(trace)));
  app.on('rt:stripe', ({ rec }) => {
    if (rec.kind !== 'api') return;
    if (/confirm/.test(rec.call)) {
      const say = { succeeds: 'Your card went straight to Stripe and the bank approved it. SoftHub never saw the card number.',
        requires_action: 'Your bank asked for 3-D Secure, so Stripe showed the approval step.' }[rec.outcome]
        || `Stripe and your bank declined the card (${String(rec.outcome).replace(/_/g, ' ')}).`;
      add({ say, kind: 'stripe', meta: ['browser → Stripe'] });
    }
    if (/3-D/.test(rec.call)) add({ say: rec.approved ? 'You approved the payment with your bank.' : 'The bank check failed, so the payment was declined.', kind: 'stripe', meta: ['browser → Stripe'] });
  });
  app.on('auth', ({ label }) => add({ say: `Signed in as ${label}. Cognito issued a short-lived token that lists the account's role.`, kind: '', meta: ['browser → Cognito'], minor: true }));
}

function toggle(open) {
  app.scenesOpen = open;
  $('#drawer').classList.toggle('open', open);
  $('#drawer').setAttribute('aria-hidden', String(!open));
  $('#scrim').hidden = !open || innerWidth > 1100;
  $('#scenes-btn').setAttribute('aria-pressed', String(open));
  document.body.style.paddingRight = open && innerWidth > 1100 ? '460px' : '';
  if (open) app.emit('did', 'scenes');
}

function add(entry) {
  if (!entry) return;
  items.unshift(entry);
  if (items.length > 80) items.pop();
  draw();
}

function draw() {
  mount($('#feed'), items.map((e, i) => {
    const more = e.trace ? h('button', { type: 'button', class: 'more', onclick: () => { e.open = !e.open; draw(); } }, e.open ? 'Hide timing' : 'Show timing') : null;
    return h('div', { class: `event${e.minor ? ' minor' : ''} ${e.kind ? `k-${e.kind}` : ''}` },
      h('p', { class: 'say' }, e.say),
      e.meta ? h('div', { class: 'meta' }, e.meta.map((m) => h('span', {}, m)), more) : null,
      e.open ? waterfall(e.trace) : null);
  }));
}

// ------------------------------------------------------------------ narration

function fromTrace(t) {
  const meta = [];
  if (t.gateway) meta.push('API Gateway');
  else meta.push(`λ ${t.fn}${t.cold ? ' · cold start' : ''}`);
  if (t.ops.length) meta.push(`${t.ops.length} database call${t.ops.length > 1 ? 's' : ''}`);
  if (t.totalMs) meta.push(ms(t.totalMs));
  const base = { trace: t, meta };
  const r = t.response || {};
  const err = r.error?.code;

  if (t.source === 'dynamodb-stream') return { ...base, kind: 'mail', say: 'Your receipt was e-mailed. Writing it to the database triggered the mailer function, which sent it through SES.' };
  if (t.source === 'stripe') {
    if (t.status === 400) return { ...base, kind: 'bad', say: 'A payment notice with a bad signature was turned away.' };
    if (r.fulfilled) return { ...base, kind: 'good', say: `Stripe confirmed the payment to SoftHub. After checking the signature, one transaction marked the order paid, issued ${r.licences} licence key${r.licences === 1 ? '' : 's'}, emptied the cart and queued the receipt.` };
    if (r.duplicate) return { ...base, kind: 'stripe', say: 'Stripe sent the same notice again. SoftHub had already recorded it, so nothing changed.' };
    if (r.failed) return { ...base, kind: 'stripe', say: 'Stripe reported the decline. The order stays open so another card can be tried.' };
    if (r.stale) return { ...base, kind: 'stripe', minor: true, say: 'A late notice arrived for an order that had already moved on; it was noted and ignored.' };
    return { ...base, kind: 'stripe', minor: true, say: 'Stripe sent a notice SoftHub does not need; it was acknowledged.' };
  }
  if (t.gateway) return { ...base, kind: 'bad', say: 'Stopped at the front door: this needs a signed-in account. No code ran and nothing was read.' };
  if (err === 'account.suspended') return { ...base, kind: 'bad', say: 'This account is suspended, so the request was refused even though its token is still valid.' };
  if (t.status === 403) return { ...base, kind: 'bad', say: `Refused: ${r.error.message.toLowerCase()}.` };

  const route = (t.steps.find((s) => s.step === 'route') || {}).route || '';
  const ok = t.status < 400;
  const S = {
    'GET /products': () => ({ minor: true, say: t.ops.length ? 'Loaded the catalogue from the database (one query per category) and kept it in memory for a minute.' : 'Listed products from the function’s in-memory copy of the catalogue: no database reads.' }),
    'GET /products/{productId}': () => ({ minor: true, say: 'Loaded the product with a single key lookup.' }),
    'GET /products/{productId}/insights': () => ({ minor: true, say: 'Summarised what buyers say from the product’s running totals and its latest reviews.' }),
    'GET /products/{productId}/reviews': () => ({ minor: true, say: 'Loaded the newest reviews, already sorted by the way they are stored.' }),
    'GET /products/{productId}/related': () => ({ minor: true, say: 'Found related products from shared tags and from what owners bought together.' }),
    'GET /me/recommendations': () => ({ minor: true, say: 'Picked products for you from what you own.' }),
    'PUT /cart/{productId}': () => ({ say: ok ? 'Added to your cart, after checking you don’t already own it.' : `Not added: ${r.error.message.toLowerCase()}.`, kind: ok ? '' : 'bad' }),
    'DELETE /cart/{productId}': () => ({ say: 'Removed from your cart.' }),
    'GET /cart': () => ({ minor: true, say: 'Loaded your cart at today’s prices.' }),
    'POST /checkout': () => (r.replayed
      ? { say: 'That checkout had already started, so the same order came back instead of a second charge.' }
      : ok ? { say: `Checkout started. The server priced your cart at ${money(r.amountCents)}, created a pending order and asked Stripe to prepare the payment.` }
        : { kind: 'bad', say: r.error.message }),
    'GET /orders/{orderId}': () => ({ minor: true, say: `Checked the order: ${String(r.status || '').replace(/_/g, ' ').toLowerCase()}.` }),
    'GET /orders': () => ({ minor: true, say: 'Loaded your orders, newest first.' }),
    'GET /library': () => ({ minor: true, say: 'Loaded your library and licence keys.' }),
    'GET /orders/{orderId}/downloads/{productId}': () => ({ say: 'Made a private download link that expires in five minutes.' }),
    'POST /products/{productId}/reviews': () => (ok ? { kind: 'good', say: `Saved your review and read it as ${r.sentiment.label}. The product’s rating and summary were updated in the same step.` } : { kind: 'bad', say: 'The review was not saved; it needs a few more words.' }),
    'GET /provider/products': () => ({ minor: true, say: 'Loaded your listings.' }),
    'GET /provider/dashboard': () => ({ minor: true, say: 'Totalled 30 days of sales from your daily sales ledger in one query.' }),
    'POST /provider/products': () => (ok ? { kind: 'good', say: `Created “${r.name}”${r.status === 'PUBLISHED' ? ' and published it to the catalogue' : ' as a draft'}.` } : { kind: 'bad', say: 'The listing was not saved; check the highlighted fields.' }),
    'PUT /provider/products/{productId}': () => (t.status === 409
      ? { kind: 'bad', say: 'Someone saved this listing first, so the change was refused instead of overwriting theirs.' }
      : ok ? { say: `Saved “${r.name}”. Open orders keep the price they were placed at.` } : { kind: 'bad', say: r.error.message }),
    'DELETE /provider/products/{productId}': () => ({ say: 'Archived the listing. Everyone who bought it keeps their key.' }),
    'GET /admin/metrics': () => ({ minor: true, say: 'Read 30 days of platform totals in one query.' }),
    'GET /admin/users': () => ({ minor: true, say: 'Found the account by e-mail.' }),
    'PUT /admin/users/{sub}/status': () => ({ kind: ok ? 'good' : 'bad', say: ok ? `Account ${r.status === 'SUSPENDED' ? 'suspended: sign-in is blocked and its open sessions are refused' : 'reinstated'}.` : r.error.message }),
    'GET /me': () => ({ minor: true, say: 'Loaded your profile.' }),
  };
  const f = S[route];
  const said = f ? f() : { minor: true, say: `${t.method} ${t.path} → ${t.status}` };
  return { ...base, ...said };
}

function waterfall(t) {
  const total = Math.max(1, t.totalMs || 1);
  const rows = [];
  let at = 0;
  const bar = (label, start, dur, cls = '') => rows.push(h('div', { class: 'wf-row' },
    h('span', { class: 'lbl', title: label }, label),
    h('span', { class: 'wf-track' }, h('i', { class: cls, style: { left: `${(start / total) * 100}%`, width: `${Math.max(0.8, (dur / total) * 100)}%` } })),
    h('span', { class: 'num', style: { textAlign: 'right' } }, ms(dur))));
  if (t.source !== 'dynamodb-stream') { bar(t.gateway ? 'gateway (refused)' : 'gateway + token check', 0, t.apiGatewayMs || 6, t.gateway ? 'fail' : 'gw'); at = t.apiGatewayMs || 6; }
  if (t.initMs) { bar('cold start', at, t.initMs, 'init'); at += t.initMs; }
  let cur = at + 2.5;
  for (const op of t.ops) { bar(`${op.op}${op.index && op.index !== 'base' ? ` ${op.index}` : ''}`, cur, op.ms || 5, op.failed ? 'fail' : ''); cur += op.ms || 5; }
  for (const sc of t.stripe) { bar('Stripe API', cur, sc.ms || 280, 'stripe'); cur += sc.ms || 280; }
  if (t.source === 'dynamodb-stream') bar('SES send', cur, 60, 'stripe');
  const keys = t.ops.flatMap((o) => (o.keys || []).slice(0, 3).map((k) => `${o.op === 'Query' || o.op.startsWith('Get') || o.op.startsWith('Batch') ? 'read ' : 'write'} ${k.PK.replace(/(#.{8}).+/, '$1…')} · ${k.SK.replace(/(#.{8}).+/, '$1…')}`)).slice(0, 8);
  return h('div', {},
    h('div', { class: 'waterfall' }, rows),
    keys.length ? h('div', { class: 'keys-list' }, keys.join('\n')) : null,
    h('p', { class: 'small muted', style: { marginTop: '4px' } }, 'Modelled timings; database keys as stored in the single SoftHub table.'));
}

export { chip };
