// Lab 1: the storefront, the persona switcher, the basket and the inbox.
import { h, $, mount, money, art, stars, chip, statusKind, int, flash } from './ui.js';
import { TEST_CARDS } from './core/payments.js';
import { CATEGORIES } from './core/keys.js';

let app;
const st = { cat: 'all', q: '', sort: 'popular', selected: null, products: [], checkout: null, order: null, payMsg: null, challenge: false, signup: null };

export function initStore(a) {
  app = a;
  renderPersona();
  renderShop();
  renderBasket();
  renderMail();
  app.on('persona', () => { st.selected = null; st.checkout = null; st.order = null; st.payMsg = null; renderPersona(); renderShop(); renderBasket(); renderMail(); });
  app.on('rt:email', () => renderMail());
  app.on('rt:request', ({ trace }) => {
    // a webhook just changed an order: refresh what the buyer sees
    if (trace.source === 'stripe' && st.order) refreshOrder();
  });
}

// ---------------------------------------------------------------- persona

function renderPersona() {
  const el = $('#persona');
  const keys = Object.keys(app.personas);
  const p = app.current();
  mount(el,
    h('p', { class: 'label' }, 'Browse as'),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Persona' }, keys.map((k) => h('button', {
      'aria-pressed': String(app.persona === k), onclick: () => app.setPersona(k),
    }, app.personas[k].label.split(' (')[0]))),
    h('p', { class: 'small muted' }, p.email
      ? [p.role, ' · ', h('code', {}, p.email)]
      : 'Not signed in. Public catalogue routes need no token.'),
    app.persona === 'visitor' ? signupForm() : null,
  );
}

function signupForm() {
  const box = h('form', { class: 'stack', style: { display: 'grid', gap: '6px' }, onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const email = String(f.get('email')).trim().toLowerCase();
    try {
      if (!st.signup) {
        await app.rt.identity.signUp({ email, password: String(f.get('password')), role: String(f.get('role')) });
        st.signup = { email, password: String(f.get('password')), role: String(f.get('role')) };
        msg.textContent = 'Code sent. It is in the inbox below.';
        renderPersona(); renderMail(email);
      } else {
        await app.rt.identity.confirm({ email: st.signup.email, code: String(f.get('code')) });
        app.personas.you = { label: `You (${st.signup.role.toLowerCase()})`, email: st.signup.email, password: st.signup.password, role: st.signup.role };
        st.signup = null;
        app.setPersona('you');
      }
    } catch (err) { msg.textContent = err.message; }
  } });
  const msg = h('p', { class: 'small', style: { color: 'var(--accent)' } });
  if (!st.signup) {
    box.append(
      h('p', { class: 'label', style: { marginTop: '6px' } }, 'Or create an account'),
      h('div', { class: 'row' },
        h('input', { type: 'email', name: 'email', id: 'su-email', placeholder: 'you@example.com', required: true, style: { flex: '1 1 140px', width: 'auto' } }),
        h('input', { type: 'text', name: 'password', id: 'su-pass', placeholder: 'Password1', required: true, style: { flex: '1 1 100px', width: 'auto' } })),
      h('div', { class: 'row' },
        h('select', { name: 'role', id: 'su-role', style: { flex: '1', width: 'auto' } }, h('option', { value: 'Consumer' }, 'Buyer'), h('option', { value: 'Provider' }, 'Provider'), h('option', { value: 'Admin' }, 'Admin (try it)')),
        h('button', { class: 'btn sm' }, 'Sign up')),
    );
  } else {
    box.append(
      h('p', { class: 'small' }, `Enter the 6-digit code sent to ${st.signup.email}.`),
      h('div', { class: 'row' }, h('input', { name: 'code', id: 'su-code', inputmode: 'numeric', placeholder: '000000', style: { flex: '1', width: 'auto' } }), h('button', { class: 'btn sm primary' }, 'Confirm')),
    );
  }
  box.append(msg);
  return box;
}

// ---------------------------------------------------------------- shop

async function renderShop() {
  const p = app.current();
  if (p.role === 'Provider') return renderProvider();
  if (p.role === 'Admin') return renderAdmin();
  const el = $('#shop');
  const query = { sort: st.sort, limit: 60 };
  if (st.cat !== 'all') query.category = st.cat;
  if (st.q) query.q = st.q;
  const res = await app.call('GET', '/products', { query });
  st.products = res.data.items || [];
  if (!st.selected && st.products.length) st.selected = st.products[0].productId;
  mount(el,
    h('div', { class: 'shop-bar' },
      h('input', { type: 'search', id: 'shop-q', placeholder: 'Search name, studio or tag', value: st.q, onchange: (e) => { st.q = e.target.value; renderShop(); } }),
      h('select', { id: 'shop-sort', style: { width: 'auto' }, onchange: (e) => { st.sort = e.target.value; renderShop(); } },
        [['popular', 'Most bought'], ['rating', 'Best rated'], ['price', 'Price ↑'], ['-price', 'Price ↓'], ['name', 'A–Z']].map(([v, t]) => h('option', { value: v, selected: st.sort === v }, t)))),
    h('div', { class: 'cats', role: 'group', 'aria-label': 'Category' },
      [['all', 'All'], ...CATEGORIES.map((c) => [c.slug, c.title])].map(([v, t]) => h('button', { 'aria-pressed': String(st.cat === v), onclick: () => { st.cat = v; st.selected = null; renderShop(); } }, t))),
    h('div', { class: 'shelf' }, st.products.length ? st.products.map(tile) : h('p', { class: 'empty' }, 'Nothing matches.')),
    h('div', { class: 'detail', id: 'detail' }, h('p', { class: 'small muted' }, 'Loading product…')),
  );
  renderDetail();
}

function tile(p) {
  return h('button', { class: 'tile', 'aria-current': String(st.selected === p.productId), onclick: (e) => { st.selected = p.productId; for (const t of document.querySelectorAll('.shelf .tile')) t.setAttribute('aria-current', 'false'); e.currentTarget.setAttribute('aria-current', 'true'); renderDetail(); } },
    art(p.image, 38),
    h('span', {}, h('b', {}, p.name), h('small', {}, `${money(p.priceCents)} · ${p.buyers} bought`), h('br'), stars(p.rating)));
}

async function renderDetail() {
  const el = $('#detail');
  if (!el || !st.selected) return;
  const id = st.selected;
  const [prod, ins, rel, revs, lib] = await Promise.all([
    app.call('GET', `/products/${id}`),
    app.call('GET', `/products/${id}/insights`),
    app.call('GET', `/products/${id}/related`),
    app.call('GET', `/products/${id}/reviews`, { query: { limit: 3 } }),
    app.current().role === 'Consumer' ? app.call('GET', '/library') : Promise.resolve({ status: 200, data: { items: [] } }),
  ]);
  if (st.selected !== id) return;
  const p = prod.data;
  if (prod.status !== 200) return mount(el, h('p', { class: 'empty' }, 'This product is no longer listed.'));
  const owned = lib.status === 200 && lib.data.items.some((l) => l.productId === id && l.status === 'ACTIVE');
  const s = ins.data;
  const role = app.current().role;
  const action = owned ? chip('in your library', 'good')
    : role === 'Consumer' ? h('button', { class: 'btn primary sm', onclick: () => addToCart(id) }, 'Add to cart')
      : h('button', { class: 'btn sm', onclick: () => addToCart(id) }, 'Add to cart');
  mount(el,
    h('div', { class: 'detail-head' }, art(p.image, 64),
      h('div', {}, h('h3', {}, p.name), h('p', { class: 'small muted' }, `${p.developer} · ${p.platforms.join(', ')} · ${p.licenseType}`), stars(p.rating), h('span', { class: 'small muted' }, ` ${p.reviewCount} reviews`)),
      h('div', { style: { textAlign: 'right', display: 'grid', gap: '6px', justifyItems: 'end' } }, h('span', { class: 'price' }, money(p.priceCents)), action)),
    h('p', { class: 'small' }, p.description),
    h('div', {}, h('p', { class: 'label' }, 'What buyers say'), h('p', { class: 'small', style: { margin: '4px 0 6px' } }, s.headline),
      s.aspects?.length ? h('div', { class: 'aspects' }, s.aspects.slice(0, 4).map(aspectRow)) : null,
      s.highlights?.praise ? h('p', { class: 'quote', style: { marginTop: '6px' } }, `“${s.highlights.praise.text}”`) : null,
      s.highlights?.complaint ? h('p', { class: 'quote neg', style: { marginTop: '4px' } }, `“${s.highlights.complaint.text}”`) : null),
    revs.data.items.length ? h('div', {}, h('p', { class: 'label' }, 'Latest reviews'), revs.data.items.map((r) => h('p', { class: 'small', style: { marginTop: '4px' } },
      h('span', { class: 'stars' }, '★'.repeat(r.stars)), ' ', chip(`${r.sentiment.label} ${r.sentiment.compound}`, r.sentiment.label === 'positive' ? 'good' : r.sentiment.label === 'negative' ? 'bad' : 'warn'), ' ', r.text, h('span', { class: 'muted' }, ` — ${r.author}`)))) : null,
    owned ? reviewForm(id) : null,
    h('div', {}, h('p', { class: 'label' }, 'You may also like'), h('div', { class: 'row', style: { marginTop: '6px', alignItems: 'stretch' } },
      rel.data.items.slice(0, 3).map((r) => h('button', { class: 'tile', style: { flex: '1 1 150px' }, onclick: () => { st.selected = r.productId; renderDetail(); } }, art(r.image, 30), h('span', {}, h('b', {}, r.name), h('small', {}, r.reason)))))),
  );
}

function aspectRow(a) {
  const w = `${Math.min(50, Math.abs(a.score) * 50)}%`;
  return h('div', { class: 'aspect' }, h('span', {}, a.label),
    h('span', { class: 'bar center' }, h('i', { class: a.score >= 0 ? 'pos' : 'neg', style: { width: w } })),
    h('span', { class: 'small muted num' }, a.mentions));
}

function reviewForm(productId) {
  const out = h('span', { class: 'small muted' });
  return h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await app.call('POST', `/products/${productId}/reviews`, { body: { stars: Number(f.get('stars')), text: String(f.get('text')) } });
    out.textContent = r.status < 300 ? `Saved: read as ${r.data.sentiment.label} (${r.data.sentiment.compound}).` : r.data.error.message;
    if (r.status < 300) setTimeout(renderDetail, 400);
  } },
  h('select', { name: 'stars', id: 'rv-stars', style: { width: 'auto' } }, [5, 4, 3, 2, 1].map((n) => h('option', { value: n }, '★'.repeat(n)))),
  h('input', { type: 'text', name: 'text', id: 'rv-mine', placeholder: 'Your review (verified buyers only)', minlength: 10, required: true, style: { flex: '1 1 200px', width: 'auto' } }),
  h('button', { class: 'btn sm' }, 'Post'), out);
}

async function addToCart(id) {
  const r = await app.call('PUT', `/cart/${id}`);
  if (r.status >= 400) { st.payMsg = { kind: 'bad', text: `${r.status}: ${r.data.error.message}` }; }
  else st.payMsg = null;
  renderBasket();
}

// ---------------------------------------------------------------- basket

async function renderBasket() {
  const el = $('#basket');
  const role = app.current().role;
  if (role !== 'Consumer') {
    return mount(el, h('p', { class: 'label' }, 'Cart'), h('p', { class: 'small muted', style: { marginTop: '6px' } },
      role ? `A ${role.toLowerCase()} account has no cart. Try "Add to cart" anyway: the router answers 403 because the route needs the Consumer group.` : 'Sign in as Maya to buy. "Add to cart" as a visitor is stopped by API Gateway with 401 before any Lambda runs.'),
    st.payMsg ? h('p', { class: 'small', style: { color: 'var(--bad)', marginTop: '6px' } }, st.payMsg.text) : null);
  }
  const [cart, lib] = await Promise.all([app.call('GET', '/cart'), app.call('GET', '/library')]);
  if (cart.status >= 400) {
    return mount(el, h('p', { class: 'label' }, 'Cart'), h('p', { class: 'small', style: { color: 'var(--bad)', marginTop: '6px' } }, `${cart.status} ${cart.data.error.code}: ${cart.data.error.message}`),
      h('p', { class: 'small muted' }, 'Reinstate the account as Admin to shop again.'));
  }
  const c = cart.data;
  const parts = [h('div', { class: 'row spread' }, h('p', { class: 'label' }, 'Cart'), h('span', { class: 'price' }, money(c.totalCents)))];
  if (!c.items.length && !st.checkout && !st.order) parts.push(h('p', { class: 'empty', style: { marginTop: '6px' } }, 'Empty. Add something from the shelf.'));
  parts.push(h('div', { class: 'cart-lines', style: { marginTop: '6px' } }, c.items.map((p) => h('div', { class: 'cart-line' }, art(p.image, 22), p.name, h('span', { class: 'price' }, money(p.priceCents)),
    h('button', { class: 'btn sm', 'aria-label': `Remove ${p.name}`, onclick: async () => { await app.call('DELETE', `/cart/${p.productId}`); renderBasket(); } }, '×')))));
  if (st.payMsg) parts.push(h('p', { class: 'small', style: { color: st.payMsg.kind === 'bad' ? 'var(--bad)' : 'var(--good)', marginTop: '6px' } }, st.payMsg.text));
  if (c.items.length && !st.checkout) parts.push(h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn primary', onclick: startCheckout }, 'Checkout'), h('span', { class: 'small muted' }, 'creates a pending order + PaymentIntent')));
  if (st.checkout) parts.push(payForm());
  if (st.order) parts.push(orderView());
  const owned = lib.data.items;
  if (owned.length) parts.push(h('p', { class: 'label', style: { marginTop: '12px' } }, `Library · ${owned.length}`), h('div', { class: 'cart-lines' }, owned.map((l) => h('div', { class: 'cart-line' }, art(l.image, 22), l.name, h('code', { class: 'small', style: { marginLeft: 'auto', color: 'var(--accent)' } }, l.licenseKey || l.status.toLowerCase())))));
  mount(el, parts);
}

async function startCheckout() {
  const key = crypto.getRandomValues(new Uint32Array(3)).join('-');
  const r = await app.call('POST', '/checkout', { headers: { 'Idempotency-Key': `site-${key}` }, body: {} });
  if (r.status >= 400) { st.payMsg = { kind: 'bad', text: r.data.error.message }; return renderBasket(); }
  st.checkout = r.data; st.order = null; st.payMsg = null;
  renderBasket();
}

function payForm() {
  const sel = h('select', { id: 'pay-card' }, TEST_CARDS.map((c) => h('option', { value: c.number }, `${c.number.slice(-4)} · ${c.label}`)));
  const box = h('div', { class: 'challenge', style: { marginTop: '10px', borderColor: 'var(--line)' } },
    h('div', { class: 'row spread' }, h('span', { class: 'small' }, `Order ${st.checkout.orderId.slice(-8)}`), chip('PENDING_PAYMENT', 'warn')),
    h('label', { class: 'field' }, h('span', {}, 'Test card (Stripe.js stand-in)'), sel),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => pay(sel.value) }, `Pay ${money(st.checkout.amountCents)}`),
      h('button', { class: 'btn sm', onclick: () => { st.checkout = null; renderBasket(); } }, 'Back')));
  if (st.challenge) {
    box.append(h('div', { class: 'challenge' }, h('b', { class: 'small' }, 'Your bank asks you to confirm this payment (3-D Secure).'),
      h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: () => resolve3ds(true) }, 'Approve'), h('button', { class: 'btn sm', onclick: () => resolve3ds(false) }, 'Fail'))));
  }
  return box;
}

async function pay(number) {
  const r = await app.rt.pay(st.checkout.clientSecret, { number, exp: '12/34', cvc: '123' });
  if (r.requiresAction) { st.challenge = true; return renderBasket(); }
  afterPay(r);
}
async function resolve3ds(ok) {
  st.challenge = false;
  afterPay(await app.rt.stripe.handleNextAction(st.checkout.clientSecret, ok));
}
function afterPay(r) {
  if (r.error) { st.payMsg = { kind: 'bad', text: `${r.error.message} The order stays pending; try another card.` }; return renderBasket(); }
  st.order = { orderId: st.checkout.orderId, status: 'PENDING_PAYMENT', lines: [] };
  st.checkout = null;
  st.payMsg = { kind: 'good', text: 'Card accepted by Stripe. Waiting for the signed webhook to issue licences…' };
  renderBasket();
}

async function refreshOrder() {
  const r = await app.call('GET', `/orders/${st.order.orderId}`);
  if (r.status !== 200) return;
  st.order = r.data;
  if (r.data.status === 'PAID') st.payMsg = { kind: 'good', text: 'Paid. Licences issued by the webhook; the receipt e-mail follows from the table stream.' };
  renderBasket();
  if (r.data.status === 'PAID') renderDetail();
}

function orderView() {
  const o = st.order;
  return h('div', { style: { marginTop: '10px' } },
    h('div', { class: 'row spread' }, h('span', { class: 'small' }, `Order ${o.orderId.slice(-8)}`), chip(o.status, statusKind(o.status))),
    o.lines.map((l) => h('div', { class: 'cart-line small', style: { marginTop: '4px' } }, l.name, l.licenseKey ? h('code', { style: { marginLeft: 'auto', color: 'var(--accent)' } }, l.licenseKey) : null,
      l.licenseKey ? h('button', { class: 'btn sm', onclick: async () => { const d = await app.call('GET', `/orders/${o.orderId}/downloads/${l.productId}`); app.emit('download'); st.payMsg = { kind: 'good', text: `Presigned link (expires in 5 min): ${d.data.url.slice(0, 64)}…` }; renderBasket(); } }, 'Download') : null)));
}

// ---------------------------------------------------------------- inbox

function renderMail(addr) {
  const el = $('#mailbox');
  const email = addr || st.signup?.email || app.current().email;
  const mails = email ? app.rt.mailer.inbox(email).slice().reverse() : [];
  mount(el, h('div', { class: 'row spread' }, h('p', { class: 'label' }, 'Inbox'), h('span', { class: 'small muted' }, email || 'no address')),
    h('div', { class: 'inbox', style: { marginTop: '6px' } }, mails.length ? mails.slice(0, 8).map((m) => h('div', { class: 'mail' },
      h('b', {}, m.subject), h('span', { class: 'muted' }, ` · ${new Date(m.at).toLocaleTimeString('en-CA')}`), h('pre', {}, m.text))) : h('p', { class: 'empty' }, email ? 'No mail yet.' : 'Sign in or sign up to get mail.')));
  const first = el.querySelector('.mail');
  if (first && Date.now() - mails[0].at < 3000) flash(first);
}

// ---------------------------------------------------------------- provider

async function renderProvider() {
  const el = $('#shop');
  const [dash, mine] = await Promise.all([app.call('GET', '/provider/dashboard'), app.call('GET', '/provider/products')]);
  const d = dash.data;
  const max = Math.max(1, ...d.series.map((x) => x.revenueCents));
  mount(el,
    h('div', { class: 'row spread' }, h('h3', {}, 'Sales, last 30 days'), h('span', { class: 'small muted' }, 'one Query over PROVIDER#…/SALES#')),
    h('div', { class: 'tally', style: { marginTop: '10px' } },
      h('div', {}, h('b', {}, money(d.totals.revenueCents)), h('span', {}, 'gross sales')),
      h('div', {}, h('b', {}, money(d.totals.payoutCents)), h('span', {}, 'payout after 10 %')),
      h('div', {}, h('b', {}, int(d.totals.units)), h('span', {}, 'licences sold')),
      h('div', {}, h('b', {}, d.products.length), h('span', {}, 'live listings'))),
    h('div', { style: { display: 'flex', alignItems: 'end', gap: '2px', height: '80px', marginTop: '12px' }, 'aria-label': 'Revenue per day' },
      d.series.map((x) => h('span', { title: `${x.day}: ${money(x.revenueCents)}`, style: { flex: '1', background: 'var(--accent)', borderRadius: '2px 2px 0 0', height: `${Math.max(2, (x.revenueCents / max) * 100)}%`, opacity: x.revenueCents ? 1 : 0.2 } }))),
    h('p', { class: 'label', style: { marginTop: '14px' } }, 'Your listings · change a price (optimistic lock on ver)'),
    h('div', { class: 'cart-lines', style: { marginTop: '6px' } }, mine.data.items.map((p) => {
      const inp = h('input', { type: 'text', id: `price-${p.productId}`, value: (p.priceCents / 100).toFixed(2), style: { width: '6em' } });
      const out = h('span', { class: 'small muted' });
      return h('div', { class: 'cart-line', style: { flexWrap: 'wrap' } }, art(p.image, 24), h('span', { style: { flex: '1 1 140px' } }, p.name, h('br'), h('span', { class: 'small muted' }, `${p.unitsSold} sold · ${stars(p.rating).textContent} · ver ${p.ver}`)),
        inp, h('button', { class: 'btn sm', onclick: async () => {
          const r = await app.call('PUT', `/provider/products/${p.productId}`, { body: { ver: p.ver, priceCents: Math.round(Number(inp.value) * 100) } });
          out.textContent = r.status === 200 ? `saved (ver ${r.data.ver})` : `${r.status}: ${r.data.error.message}`;
          if (r.status === 200) setTimeout(renderProvider, 700);
        } }, 'Save'),
        h('button', { class: 'btn sm', title: 'Save again with the old version number', onclick: async () => {
          const r = await app.call('PUT', `/provider/products/${p.productId}`, { body: { ver: Math.max(1, p.ver - 1), priceCents: p.priceCents } });
          out.textContent = `${r.status}: ${r.data.error?.message || 'saved'}`;
        } }, 'Stale save'), out);
    })),
  );
}

// ---------------------------------------------------------------- admin

async function renderAdmin() {
  const el = $('#shop');
  const m = (await app.call('GET', '/admin/metrics')).data;
  const out = h('div', { style: { marginTop: '8px' } });
  mount(el,
    h('div', { class: 'row spread' }, h('h3', {}, 'Platform, last 30 days'), h('span', { class: 'small muted' }, 'PK=PLATFORM, SK BETWEEN DAY#…')),
    h('div', { class: 'tally', style: { marginTop: '10px' } },
      h('div', {}, h('b', {}, int(m.totals.orders)), h('span', {}, 'orders')),
      h('div', {}, h('b', {}, money(m.totals.gmvCents)), h('span', {}, 'gross sales')),
      h('div', {}, h('b', {}, `${m.paymentSuccessRate} %`), h('span', {}, 'payment success')),
      h('div', {}, h('b', {}, int(m.totals.reviews)), h('span', {}, 'reviews'))),
    h('p', { class: 'label', style: { marginTop: '14px' } }, 'Suspend an account'),
    h('form', { class: 'row', style: { marginTop: '6px' }, onsubmit: async (e) => {
      e.preventDefault();
      const email = new FormData(e.target).get('email');
      const r = await app.call('GET', '/admin/users', { query: { email } });
      if (r.status !== 200) return mount(out, h('p', { class: 'small muted' }, r.data.error.message));
      const u = r.data;
      mount(out, h('div', { class: 'row' }, h('code', { class: 'small' }, u.email), chip(u.role), chip(u.status, statusKind(u.status)),
        h('button', { class: 'btn sm', onclick: async () => {
          const next = u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
          const x = await app.call('PUT', `/admin/users/${u.sub}/status`, { body: { status: next, reason: 'set from the lab' } });
          mount(out, h('p', { class: 'small' }, x.status === 200 ? `${u.email} is now ${next}. Their next API call (after the 30 s per-container cache) gets 403, even with a valid token.` : x.data.error.message));
        } }, u.status === 'ACTIVE' ? 'Suspend' : 'Reinstate')));
    } }, h('input', { type: 'email', name: 'email', id: 'adm-email', value: 'maya.chen@example.com', style: { flex: '1 1 200px', width: 'auto' } }), h('button', { class: 'btn sm' }, 'Find')),
    out,
  );
}
