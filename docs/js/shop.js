// The storefront: discover, browse, product, cart, checkout, orders, library,
// inbox and accounts.
import { h, $, mount, money, cover, stars, chip, statusKind, avatar, icon } from './ui.js';
import { openModal, modalHead, toast } from './main.js';
import { CATEGORIES } from './core/keys.js';
import { TEST_CARDS } from './core/payments.js';
import { analyseReview } from './core/sentiment.js';

const catTitle = (slug) => CATEGORIES.find((c) => c.slug === slug)?.title || slug;
const paidHere = new Set(); // orders whose card was confirmed in this tab
const revealed = new Set(); // keys already animated in
let watching = null, watcherOn = false;

// ------------------------------------------------------------------ pieces

export function productCard(app, p, why) {
  return h('button', { type: 'button', class: 'pcard', onclick: () => app.go('product', { id: p.productId }) },
    cover(p.image, p.name),
    h('span', { class: 'body' },
      h('b', {}, p.name),
      h('span', { class: 'studio' }, `${p.developer} · ${catTitle(p.category)}`),
      why ? h('span', { class: 'why' }, why) : null,
      h('span', { class: 'foot' }, p.rating ? stars(p.rating) : h('span', { class: 'muted small' }, 'New'), h('span', { class: 'price' }, money(p.priceCents)))));
}

function grid(app, items, why) {
  return items.length ? h('div', { class: 'grid' }, items.map((p) => productCard(app, p, why ? why(p) : null))) : h('p', { class: 'empty' }, 'Nothing here yet.');
}

function back(app, label = 'Back') {
  return h('button', { type: 'button', class: 'back', onclick: () => app.back() }, `← ${label}`);
}

async function addToCart(app, id, { quiet = false } = {}) {
  if (app.role() !== 'Consumer') { accountModal(app, 'Choose a buyer account to shop. Maya is ready to go.'); return false; }
  const r = await app.call('PUT', `/cart/${id}`);
  if (r.status >= 400) { toast(r.data.error.message); return false; }
  app.setCartCount(r.data.items.length);
  app.emit('did', 'cart');
  if (!quiet) toast('Added to your cart.', { label: 'View cart', run: () => app.go('cart') });
  return true;
}

// ------------------------------------------------------------------ discover

export async function home(app) {
  const [pop, top, cats] = await Promise.all([
    app.call('GET', '/products', { query: { sort: 'popular', limit: 8 } }),
    app.call('GET', '/products', { query: { sort: 'rating', limit: 4 } }),
    app.call('GET', '/products', { query: { limit: 60 } }),
  ]);
  const all = cats.data.items;
  const count = (slug) => all.filter((p) => p.category === slug).length;
  const feat = pop.data.items.slice(0, 3);
  const mine = app.role() === 'Consumer' ? await app.call('GET', '/me/recommendations') : null;
  const p = app.current();
  return h('div', {},
    h('section', { class: 'hero' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Software marketplace'),
        h('h1', {}, 'Buy once. Your licence key is in your ', h('em', {}, 'inbox'), ' in seconds.'),
        h('p', { class: 'lede' }, 'Apps, games and subscriptions from independent studios. Pay by card, get your key by e-mail, download any time from your library.'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => app.go('catalog') }, 'Browse all software'),
          app.role() === 'Consumer' ? h('button', { type: 'button', class: 'btn', onclick: () => app.go('mine') }, 'My software')
            : h('button', { type: 'button', class: 'btn', onclick: () => app.setPersona('buyer') }, 'Shop as Maya'),
          h('button', { type: 'button', class: 'btn ghost', onclick: () => app.emit('open-guide') }, 'Take the 7-step tour')),
        h('div', { class: 'facts' },
          h('span', {}, h('b', {}, all.length), 'products'),
          h('span', {}, h('b', {}, '6'), 'studios'),
          h('span', {}, h('b', {}, 'Instant'), 'licence keys'))),
      h('div', { class: 'showcase', 'aria-label': 'Featured' }, feat.map((f, i) => h('button', {
        type: 'button', class: 'cover-card', onclick: () => app.go('product', { id: f.productId }),
        style: { left: `${[0, 21, 42][i]}%`, top: `${[30, 0, 50][i]}px`, transform: `rotate(${[-4, 2, 5][i]}deg)`, zIndex: [1, 2, 3][i] },
      }, cover(f.image, f.name), h('span', { class: 'meta' }, h('b', { class: 'small' }, f.name), h('span', { class: 'small muted' }, `${money(f.priceCents)} · ${f.buyers} owners`)))))),
    mine && mine.data.items?.length ? h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, `Picked for you, ${p.label.split(' ')[0]}`), h('span', { class: 'small muted' }, 'from what you own and what owners of it also bought')),
      grid(app, mine.data.items.slice(0, 4), (x) => x.reason)) : null,
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Categories')),
      h('div', { class: 'cats' }, CATEGORIES.map((c) => h('button', { type: 'button', class: 'cat', onclick: () => app.go('catalog', { cat: c.slug }) },
        h('b', {}, c.title), h('span', {}, `${count(c.slug)} products · ${c.blurb}`))))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Most popular'), h('button', { type: 'button', class: 'btn sm ghost', onclick: () => app.go('catalog', { sort: 'popular' }) }, 'See all →')),
      grid(app, pop.data.items)),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Loved by buyers'), h('span', { class: 'small muted' }, 'highest rated by verified owners')),
      grid(app, top.data.items)),
    h('section', { class: 'section sell' },
      h('div', {}, h('h2', {}, 'Make software? Sell it here.'), h('p', {}, 'List a product in a minute, get paid per sale, and see what buyers say about each part of your app.')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => app.setPersona('provider') }, `Open ${app.personas.provider.label}'s studio`)),
  );
}

// ------------------------------------------------------------------ catalogue

export async function catalog(app, params = {}) {
  const state = { cat: params.cat || '', q: params.q || '', sort: params.sort || 'popular', maxPrice: '', minRating: '' };
  const body = h('div', {});
  const list = h('div', {});
  const draw = async () => {
    const query = { sort: state.sort, limit: 60 };
    if (state.cat) query.category = state.cat;
    if (state.q) query.q = state.q;
    if (state.maxPrice) query.maxPrice = state.maxPrice;
    if (state.minRating) query.minRating = state.minRating;
    const r = await app.call('GET', '/products', { query });
    if (state.q || state.cat) app.emit('did', 'browse');
    mount(list,
      h('div', { class: 'section-head' }, h('h1', { style: { fontSize: '1.8rem' } }, state.q ? `Results for “${state.q}”` : state.cat ? catTitle(state.cat) : 'All software'),
        h('span', { class: 'muted small' }, `${r.data.total} product${r.data.total === 1 ? '' : 's'}`)),
      r.data.items.length ? grid(app, r.data.items) : h('p', { class: 'empty' }, 'No software matches. Try another search or clear the filters.'));
    filters();
  };
  const opt = (key, value, label) => h('button', { type: 'button', class: 'opt', 'aria-pressed': String(state[key] === value), onclick: () => { state[key] = value; draw(); } }, label);
  const side = h('aside', { class: 'filters' });
  const filters = () => mount(side,
    h('div', {}, h('p', { class: 'label' }, 'Category'), h('div', { class: 'opts' }, opt('cat', '', 'Everything'), CATEGORIES.map((c) => opt('cat', c.slug, c.title)))),
    h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', {}, 'Sort by'), h('select', { id: 'f-sort', onchange: (e) => { state.sort = e.target.value; draw(); } },
        [['popular', 'Most bought'], ['rating', 'Best rated'], ['price', 'Price: low to high'], ['-price', 'Price: high to low'], ['name', 'Name']].map(([v, t]) => h('option', { value: v, selected: state.sort === v }, t)))),
      h('label', { class: 'field' }, h('span', {}, 'Price'), h('select', { id: 'f-price', onchange: (e) => { state.maxPrice = e.target.value; draw(); } },
        [['', 'Any price'], ['2000', 'Under C$20'], ['5000', 'Under C$50'], ['10000', 'Under C$100']].map(([v, t]) => h('option', { value: v, selected: state.maxPrice === v }, t)))),
      h('label', { class: 'field' }, h('span', {}, 'Rating'), h('select', { id: 'f-rating', onchange: (e) => { state.minRating = e.target.value; draw(); } },
        [['', 'Any rating'], ['4', '4 stars and up'], ['3', '3 stars and up']].map(([v, t]) => h('option', { value: v, selected: state.minRating === v }, t))))),
    state.q ? h('button', { type: 'button', class: 'btn sm', onclick: () => { state.q = ''; $('#q').value = ''; draw(); } }, 'Clear search') : null);
  await draw();
  mount(body, h('div', { class: 'catalog' }, side, list));
  return body;
}

// ------------------------------------------------------------------ product

export async function product(app, { id }) {
  const [prod, ins, rel, revs, lib] = await Promise.all([
    app.call('GET', `/products/${id}`),
    app.call('GET', `/products/${id}/insights`),
    app.call('GET', `/products/${id}/related`),
    app.call('GET', `/products/${id}/reviews`, { query: { limit: 6 } }),
    app.role() === 'Consumer' ? app.call('GET', '/library') : Promise.resolve({ status: 200, data: { items: [] } }),
  ]);
  if (prod.status !== 200) return h('div', {}, back(app), h('p', { class: 'empty' }, 'This product is no longer listed.'));
  app.emit('did', 'product');
  const p = prod.data, s = ins.data;
  const owned = lib.status === 200 && lib.data.items.some((l) => l.productId === id && l.status === 'ACTIVE');
  const buy = owned
    ? h('div', { class: 'row' }, chip('In your library', 'good'), h('button', { type: 'button', class: 'btn', onclick: () => app.go('mine') }, 'Open library'))
    : h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', onclick: async () => { if (await addToCart(app, id, { quiet: true })) startCheckout(app); } }, h('span', {}, icon('bolt')), 'Buy now'),
      h('button', { type: 'button', class: 'btn', onclick: () => addToCart(app, id) }, 'Add to cart'));
  return h('div', {},
    back(app),
    h('section', { class: 'product' },
      cover(p.image, p.name),
      h('div', { class: 'buybox' },
        h('p', { class: 'eyebrow' }, catTitle(p.category)),
        h('h1', {}, p.name),
        h('p', { class: 'muted' }, `by ${p.developer}`),
        h('div', { class: 'row' }, p.rating ? stars(p.rating) : chip('New'), h('span', { class: 'small muted' }, `${p.reviewCount} reviews · ${p.buyers} owners`)),
        h('div', { class: 'price' }, money(p.priceCents)),
        buy,
        h('p', {}, p.description),
        h('dl', { class: 'specs' },
          h('dt', {}, 'Platforms'), h('dd', {}, p.platforms.join(', ')),
          h('dt', {}, 'Licence'), h('dd', {}, p.licenseType || 'Perpetual'),
          p.version ? [h('dt', {}, 'Version'), h('dd', {}, p.version)] : null,
          p.releaseDate ? [h('dt', {}, 'Released'), h('dd', {}, p.releaseDate)] : null,
          h('dt', {}, 'Delivery'), h('dd', {}, 'Licence key by e-mail, installer from your library')),
        p.features.length ? h('ul', { class: 'ticks' }, p.features.map((f) => h('li', {}, f))) : null,
        h('div', { class: 'tags' }, p.tags.map((t) => h('span', { class: 'tag' }, t))))),
    h('section', { class: 'two' },
      h('div', { class: 'card says' },
        h('p', { class: 'label' }, 'What buyers say'),
        h('p', { class: 'headline' }, s.headline),
        s.aspects?.length ? h('div', { class: 'aspects' }, s.aspects.slice(0, 5).map(aspectRow)) : null,
        s.highlights?.praise ? h('p', { class: 'quote' }, `“${s.highlights.praise.text}”`) : null,
        s.highlights?.complaint ? h('p', { class: 'quote neg' }, `“${s.highlights.complaint.text}”`) : null,
        s.reviews ? h('p', { class: 'small muted', style: { marginTop: '10px' } }, 'Summarised from verified buyers’ reviews. Each review is read for tone and for what it talks about: price, speed, stability, ease of use, installation, support and features.') : null),
      h('div', { class: 'card' },
        h('div', { class: 'row spread', style: { marginBottom: '10px' } }, h('p', { class: 'label' }, `Reviews · ${p.reviewCount}`), owned ? chip('You own this', 'good') : null),
        owned ? composer(app, id) : null,
        revs.data.items.length ? h('div', { class: 'reviews' }, revs.data.items.map(reviewItem)) : h('p', { class: 'empty' }, 'No reviews yet. Owners can write the first one.'))),
    rel.data.items.length ? h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'You may also like')),
      grid(app, rel.data.items, (x) => x.reason)) : null);
}

function aspectRow(a) {
  return h('div', { class: 'aspect' }, h('span', {}, a.label),
    h('span', { class: 'meter' }, h('i', { class: a.score >= 0 ? 'pos' : 'neg', style: { width: `${Math.min(50, Math.abs(a.score) * 50)}%` } })),
    h('span', { class: 'small muted num' }, a.mentions));
}

function reviewItem(r) {
  const k = r.sentiment.label === 'positive' ? 'good' : r.sentiment.label === 'negative' ? 'bad' : 'warn';
  return h('div', { class: 'review' },
    h('div', { class: 'row spread' }, h('span', { class: 'stars' }, '★'.repeat(r.stars), h('span', { style: { opacity: 0.25 } }, '★'.repeat(5 - r.stars))), chip(r.sentiment.label, k)),
    h('p', {}, r.text),
    h('p', { class: 'small muted' }, `${r.author} · verified owner · ${new Date(r.createdAt).toLocaleDateString('en-CA')}${r.editedAt ? ' · edited' : ''}`));
}

/** Review composer with a live reading of the text as you type. */
function composer(app, productId) {
  let starsVal = 5;
  const reading = h('div', { class: 'reading' });
  const ta = h('textarea', { id: 'review-text', rows: 3, placeholder: 'What do you like? What could be better?', maxlength: 2000 });
  const pick = h('span', { class: 'star-pick', role: 'radiogroup', 'aria-label': 'Your rating' });
  const drawStars = () => mount(pick, [1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', class: n <= starsVal ? 'on' : '', 'aria-label': `${n} stars`, onclick: () => { starsVal = n; drawStars(); } }, '★')));
  drawStars();
  const read = () => {
    const t = ta.value.trim();
    if (t.length < 3) return mount(reading, h('span', {}, 'As you type, SoftHub reads the tone and the topics of your review.'));
    const a = analyseReview(t);
    const k = a.label === 'positive' ? 'good' : a.label === 'negative' ? 'bad' : 'warn';
    mount(reading, h('span', {}, 'Reads as'), chip(`${a.label} ${a.compound >= 0 ? '+' : ''}${a.compound.toFixed(2)}`, k),
      Object.keys(a.aspects).length ? [h('span', {}, '· talks about'), Object.entries(a.aspects).map(([asp, v]) => chip(asp, v >= 0 ? 'good' : 'bad'))] : null);
  };
  ta.addEventListener('input', read);
  read();
  const out = h('span', { class: 'small muted' });
  return h('form', { class: 'composer', onsubmit: async (e) => {
    e.preventDefault();
    const r = await app.call('POST', `/products/${productId}/reviews`, { body: { stars: starsVal, text: ta.value } });
    if (r.status >= 400) { out.textContent = r.data.error.fields ? 'Write at least 10 characters.' : r.data.error.message; return; }
    app.emit('did', 'review');
    toast(r.status === 201 ? 'Review posted. Thanks!' : 'Review updated.');
    app.rerender();
  } },
  h('div', { class: 'row spread' }, h('b', {}, 'Rate and review'), pick),
  ta, reading,
  h('div', { class: 'row' }, h('button', { class: 'btn primary sm' }, 'Post review'), out));
}

// ------------------------------------------------------------------ cart & checkout

export async function cart(app) {
  const r = await app.call('GET', '/cart');
  if (r.status >= 400) return h('div', { class: 'page-narrow' }, h('h1', {}, 'Your cart'), h('p', { class: 'empty' }, r.data.error.message));
  const c = r.data;
  app.setCartCount(c.items.length);
  return h('div', { class: 'page-narrow' },
    h('h1', { style: { marginBottom: '18px' } }, 'Your cart'),
    c.items.length ? h('div', { class: 'lines' }, c.items.map((p) => h('div', { class: 'line' },
      cover(p.image, p.name),
      h('div', {}, h('b', {}, p.name), h('p', { class: 'small muted' }, `${p.developer} · ${p.licenseType}`)),
      h('span', { class: 'price' }, money(p.priceCents)),
      h('button', { type: 'button', class: 'btn sm ghost rm', onclick: async () => { const x = await app.call('DELETE', `/cart/${p.productId}`); app.setCartCount(x.data.items.length); app.rerender(); } }, 'Remove'))))
      : h('div', { class: 'empty' }, 'Your cart is empty. ', h('button', { type: 'button', class: 'btn sm', onclick: () => app.go('catalog') }, 'Find something')),
    c.unavailable.length ? h('p', { class: 'small muted', style: { marginTop: '10px' } }, `${c.unavailable.length} item(s) can't be bought (${c.unavailable.map((u) => u.reason).join(', ')}) and will be skipped.`) : null,
    c.items.length ? h('div', { class: 'summary' },
      h('div', { class: 'row spread' }, h('span', {}, `Total · ${c.items.length} item${c.items.length > 1 ? 's' : ''}`), h('b', { class: 'price' }, money(c.totalCents))),
      h('p', { class: 'small muted' }, 'Keys are delivered by e-mail as soon as your bank confirms the payment.'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => startCheckout(app) }, h('span', {}, icon('card')), 'Checkout')) : null);
}

async function startCheckout(app) {
  const key = `web-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
  const r = await app.call('POST', '/checkout', { headers: { 'Idempotency-Key': key }, body: {} });
  if (r.status >= 400) { toast(r.data.error.message); return; }
  app.emit('did', 'checkout');
  payModal(app, r.data);
}

function payModal(app, order) {
  let cardNo = TEST_CARDS[0].number;
  openModal(({ fill, close }) => {
    const msg = h('p', { class: 'small', style: { color: 'var(--bad)' } });
    const form = () => fill(
      modalHead(`Pay ${money(order.amountCents)}`, close, 'Secure checkout'),
      h('div', { class: 'lines' }, order.lines.map((l) => h('div', { class: 'row spread small' }, h('span', {}, l.name), h('span', { class: 'price' }, money(l.priceCents))))),
      h('form', { class: 'cardbox', onsubmit: async (e) => { e.preventDefault(); await pay(); } },
        h('p', { class: 'label' }, 'Card (Stripe test cards)'),
        h('div', { class: 'testcards', role: 'radiogroup' }, TEST_CARDS.map((c) => h('label', {},
          h('input', { type: 'radio', name: 'card', value: c.number, checked: c.number === cardNo, onchange: () => { cardNo = c.number; } }),
          h('span', {}, h('code', {}, c.number), h('br'), h('span', { class: 'small muted' }, c.label.replace(/^Visa — /, '')))))),
        h('div', { class: 'row' },
          h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'Expiry'), h('input', { type: 'text', id: 'exp', value: '12/34' })),
          h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'CVC'), h('input', { type: 'text', id: 'cvc', value: '123' }))),
        h('button', { class: 'btn primary' }, `Pay ${money(order.amountCents)}`),
        msg,
        h('p', { class: 'small muted' }, 'The card goes straight to Stripe; SoftHub only ever sees the payment result.')));
    const wait = (text) => fill(h('div', { class: 'loading' }, h('span', { class: 'spin' }), text));
    async function pay() {
      wait('Confirming with your bank…');
      await new Promise((r) => setTimeout(r, 450));
      const res = await app.rt.pay(order.clientSecret, { number: cardNo, exp: $('#exp')?.value || '12/34', cvc: $('#cvc')?.value || '123' });
      if (res.requiresAction) return challenge();
      done(res);
    }
    function challenge() {
      fill(h('div', { class: 'bank' },
        h('div', { class: 'shield' }, '✓'), h('h2', {}, 'Confirm it’s you'),
        h('p', { class: 'muted' }, `Your bank asks you to approve a payment of ${money(order.amountCents)} to SoftHub.`),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', onclick: async () => { wait('Approving…'); done(await app.rt.stripe.handleNextAction(order.clientSecret, true)); } }, 'Approve'),
          h('button', { type: 'button', class: 'btn', onclick: async () => { done(await app.rt.stripe.handleNextAction(order.clientSecret, false)); } }, 'Decline'))));
    }
    function done(res) {
      if (res.error) { form(); msg.textContent = `${res.error.message} Try another card; your order is kept.`; return; }
      paidHere.add(order.orderId);
      close();
      app.go('order', { id: order.orderId });
    }
    form();
  });
}

// ------------------------------------------------------------------ order

export async function order(app, { id }) {
  const wrap = h('div', { class: 'page-narrow' });
  const draw = async () => {
    const r = await app.call('GET', `/orders/${id}`);
    if (r.status !== 200) return mount(wrap, h('p', { class: 'empty' }, 'Order not found.'));
    const o = r.data;
    const keys = o.lines.filter((l) => l.licenseKey);
    const mailed = app.rt.mailer.all().some((m) => m.kind === 'receipt' && m.orderId === id);
    const steps = [
      ['Order placed', `Priced on the server: ${money(o.amountCents)}`, true],
      ['Card confirmed', 'Your bank approved the payment with Stripe', paidHere.has(id) || o.status === 'PAID'],
      ['Payment confirmed to SoftHub', 'Stripe sent a signed notice; SoftHub checked its signature', o.status === 'PAID'],
      ['Licence keys issued', keys.length ? `${keys.length} key${keys.length > 1 ? 's' : ''}, unique to you` : 'One key per product', keys.length > 0],
      ['Receipt e-mailed', mailed ? `Sent to ${app.current().email}` : 'With your keys and download links', mailed],
    ];
    const now = steps.findIndex((x) => !x[2]);
    if (o.status === 'PAID' && mailed) app.emit('did', 'paid');
    mount(wrap,
      back(app),
      h('div', { class: 'row spread' }, h('h1', {}, o.status === 'PAID' ? 'Thanks for your order!' : 'Finishing your order…'), chip(o.status.replace(/_/g, ' ').toLowerCase(), statusKind(o.status))),
      h('p', { class: 'muted', style: { marginTop: '6px' } }, `Order ${o.orderId.slice(-8)} · ${new Date(o.createdAt).toLocaleString('en-CA')}`),
      h('div', { class: 'timeline' }, steps.map(([t, d, ok], i) => h('div', { class: `tstep${ok ? ' done' : i === now ? ' now' : ''}` },
        h('span', { class: 'tdot' }, ok ? '✓' : i + 1), h('div', {}, h('b', {}, t), h('p', {}, d))))),
      o.lastError && o.status !== 'PAID' ? h('p', { class: 'small', style: { color: 'var(--bad)' } }, `Last attempt: ${o.lastError.replace(/_/g, ' ')}.`) : null,
      keys.length ? h('div', { class: 'stack' }, h('h2', {}, 'Your licence keys'), o.lines.map((l) => keyLine(app, o, l))) : null,
      o.lines.some((l) => l.status === 'REFUNDED_DUPLICATE') ? h('p', { class: 'small muted' }, 'You already owned one of these, so that line was refunded automatically.') : null,
      o.status === 'PAID' ? h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', { type: 'button', class: 'btn', onclick: () => inboxModal(app) }, h('span', {}, icon('mail')), 'Open inbox'), h('button', { type: 'button', class: 'btn ghost', onclick: () => app.go('mine') }, 'Go to my library')) : null);
    for (const k of wrap.querySelectorAll('.key')) if (!revealed.has(k.textContent)) { revealed.add(k.textContent); k.classList.add('reveal'); }
  };
  await draw();
  // live: re-draw when Stripe's notice or the e-mail lands
  watching = { id, draw };
  if (!watcherOn) {
    watcherOn = true;
    app.on('rt:request', ({ trace }) => {
      if (!watching || app.view.name !== 'order' || app.view.params.id !== watching.id) return;
      if (trace.source === 'stripe' || trace.source === 'dynamodb-stream') setTimeout(watching.draw, 120);
    });
  }
  return wrap;
}

function keyLine(app, o, l) {
  if (!l.licenseKey) return h('div', { class: 'keyline' }, h('span', {}), h('span', { class: 'muted' }, `${l.name}: ${l.status === 'REFUNDED_DUPLICATE' ? 'refunded, already owned' : 'pending'}`), h('span', {}));
  return h('div', { class: 'keyline' },
    h('span', { style: { color: 'var(--accent)' } }, icon('key', 26)),
    h('div', {}, h('b', {}, l.name), h('div', { class: 'key' }, l.licenseKey)),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn sm', onclick: () => navigator.clipboard?.writeText(l.licenseKey).then(() => toast('Key copied.'), () => toast('Select the key to copy it.')) }, icon('copy'), 'Copy'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => download(app, o.orderId, l) }, icon('down'), 'Download')));
}

async function download(app, orderId, l) {
  const r = await app.call('GET', `/orders/${orderId}/downloads/${l.productId}`);
  app.emit('download');
  if (r.status !== 200) return toast(r.data.error.message);
  toast(`Download link for ${l.name} ready: valid for 5 minutes, only for you.`);
}

// ------------------------------------------------------------------ my software

export async function mine(app, { tab = 'library' } = {}) {
  if (app.role() !== 'Consumer') return h('p', { class: 'empty' }, 'Sign in as a buyer to see your software.');
  const [lib, ords] = await Promise.all([app.call('GET', '/library'), app.call('GET', '/orders')]);
  const body = h('div', {});
  const show = (t) => {
    tab = t;
    mount(body,
      h('h1', { style: { marginBottom: '14px' } }, 'My software'),
      h('div', { class: 'tabs', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'library'), onclick: () => show('library') }, `Library · ${lib.data.items.length}`),
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'orders'), onclick: () => show('orders') }, `Orders · ${ords.data.items.length}`)),
      tab === 'library'
        ? (lib.data.items.length ? h('div', { class: 'stack' }, lib.data.items.map((l) => h('div', { class: 'keyline' },
          h('span', { style: { cursor: 'pointer' }, onclick: () => app.go('product', { id: l.productId }) }, cover(l.image, l.name)),
          h('div', {}, h('b', {}, l.name), l.licenseKey ? h('div', { class: 'key' }, l.licenseKey) : chip(l.status.toLowerCase(), 'bad')),
          h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn sm', onclick: () => app.go('product', { id: l.productId }) }, 'Review'),
            l.licenseKey ? h('button', { type: 'button', class: 'btn sm', onclick: () => download(app, l.orderId, l) }, icon('down'), 'Download') : null))))
          : h('p', { class: 'empty' }, 'Nothing here yet.'))
        : h('div', { class: 'olist' }, ords.data.items.map((o) => h('button', { type: 'button', class: 'orow', onclick: () => app.go('order', { id: o.orderId }) },
          h('span', {}, h('b', {}, `Order ${o.orderId.slice(-8)}`), h('br'), h('span', { class: 'small muted' }, new Date(o.createdAt).toLocaleString('en-CA'))),
          chip(o.status.replace(/_/g, ' ').toLowerCase(), statusKind(o.status)), h('span', { class: 'price' }, money(o.amountCents))))));
  };
  show(tab);
  return body;
}

// ------------------------------------------------------------------ inbox

export function inboxModal(app) {
  const email = app.current().email || app.pendingSignup;
  app.unread = 0;
  app.emit('inbox');
  document.querySelector('#inbox-n').hidden = true;
  openModal(({ fill, close }) => {
    const mails = email ? app.rt.mailer.inbox(email).slice().reverse() : [];
    let sel = mails[0];
    const draw = () => fill(
      modalHead('Inbox', close, email || 'no address'),
      mails.length ? h('div', { class: 'mail-app' },
        h('div', { class: 'mail-list' }, mails.map((m) => h('button', { type: 'button', 'aria-current': String(m === sel), onclick: () => { sel = m; draw(); } },
          h('b', {}, m.kind === 'receipt' ? 'SoftHub receipts' : 'SoftHub accounts'), h('span', {}, m.subject), h('span', {}, new Date(m.at).toLocaleString('en-CA'))))),
        h('div', { class: 'mail-read' }, h('p', { class: 'small muted' }, `From orders@softhub.example · To ${sel.to}`), h('h3', {}, sel.subject), h('pre', {}, sel.text)))
        : h('p', { class: 'empty' }, email ? 'No mail yet. Buy something and your receipt lands here.' : 'Sign in to see your mail.'));
    draw();
    if (mails.some((m) => m.kind === 'receipt')) app.emit('did', 'inbox');
  }, { wide: true });
}

// ------------------------------------------------------------------ accounts

export function accountModal(app, note) {
  openModal(({ fill, close }) => {
    const people = Object.entries(app.personas).filter(([k]) => k !== 'visitor');
    const choose = async (k) => { close(); await app.setPersona(k); toast(`Signed in as ${app.personas[k].label}.`); };
    const signupForm = () => {
      const msg = h('p', { class: 'small', style: { color: 'var(--bad)' } });
      fill(modalHead('Create an account', close, 'Sign up'),
        h('form', { class: 'stack', onsubmit: async (e) => {
          e.preventDefault();
          const f = new FormData(e.target);
          const email = String(f.get('email')).trim().toLowerCase();
          try {
            await app.rt.identity.signUp({ email, password: String(f.get('password')), role: String(f.get('role')) });
            app.pendingSignup = email;
            confirmForm({ email, password: String(f.get('password')), role: String(f.get('role')) });
          } catch (err) { msg.textContent = err.message; }
        } },
        h('label', { class: 'field' }, h('span', {}, 'E-mail'), h('input', { type: 'email', name: 'email', id: 'su-email', required: true, placeholder: 'you@example.com' })),
        h('label', { class: 'field' }, h('span', {}, 'Password (8+ characters, upper and lower case, a digit)'), h('input', { type: 'password', name: 'password', id: 'su-pass', required: true, value: 'Softhub2026' })),
        h('label', { class: 'field' }, h('span', {}, 'I want to'), h('select', { name: 'role', id: 'su-role' }, h('option', { value: 'Consumer' }, 'Buy software'), h('option', { value: 'Provider' }, 'Sell my software'))),
        h('button', { class: 'btn primary' }, 'Send my verification code'), msg));
    };
    const confirmForm = (acct) => {
      const msg = h('p', { class: 'small', style: { color: 'var(--bad)' } });
      const code = app.rt.mailer.inbox(acct.email).filter((m) => m.kind === 'verify').at(-1)?.code;
      fill(modalHead('Check your inbox', close, 'Verify e-mail'),
        h('p', { class: 'muted' }, `We sent a 6-digit code to ${acct.email}.`),
        h('div', { class: 'cardbox' }, h('p', { class: 'small muted' }, 'Demo inbox'), h('p', {}, 'Your verification code is ', h('b', { class: 'key' }, code))),
        h('form', { class: 'stack', onsubmit: async (e) => {
          e.preventDefault();
          try {
            await app.rt.identity.confirm({ email: acct.email, code: new FormData(e.target).get('code') });
            app.personas.you = { label: acct.email.split('@')[0], blurb: acct.role === 'Consumer' ? 'Your new buyer account' : 'Your new studio account', email: acct.email, password: acct.password, role: acct.role, hue: 300 };
            app.pendingSignup = null;
            choose('you');
          } catch (err) { msg.textContent = err.message; }
        } },
        h('label', { class: 'field' }, h('span', {}, 'Code'), h('input', { type: 'text', name: 'code', id: 'su-code', inputmode: 'numeric', required: true })),
        h('button', { class: 'btn primary' }, 'Verify and sign in'), msg));
    };
    fill(modalHead('Who are you today?', close, 'Sign in'),
      note ? h('p', { class: 'muted' }, note) : null,
      h('div', { class: 'stack' }, people.map(([k, p]) => h('button', { type: 'button', class: 'persona-btn', onclick: () => choose(k) },
        avatar(p.label, p.hue), h('span', {}, h('b', {}, p.label), h('br'), h('span', { class: 'small muted' }, p.blurb)), app.persona === k ? chip('signed in', 'good') : h('span', { class: 'small muted' }, p.role)))),
      h('div', { class: 'row spread' },
        h('button', { type: 'button', class: 'btn sm', onclick: signupForm }, 'Create a new account'),
        app.persona !== 'visitor' ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { close(); app.setPersona('visitor'); } }, 'Sign out') : null));
  });
}
