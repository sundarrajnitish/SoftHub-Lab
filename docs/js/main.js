// SoftHub demo — boot, shared state, navigation, header, modals and toasts.
import { createLocalRuntime, createShiftClock } from './core/runtime.js';
import { seedMarketplace } from './core/seedrun.js';
import { DEMO_ACCOUNTS, STUDIOS } from './core/seed.js';
import { h, $, mount, avatar } from './ui.js';
import { initDiagram } from './diagram.js';
import { initScenes } from './scenes.js';
import { initGuide } from './guide.js';
import * as shop from './shop.js';
import * as studio from './studio.js';
import * as admin from './admin.js';
import * as about from './about.js';

const VIEWS = {
  home: shop.home, catalog: shop.catalog, product: shop.product, cart: shop.cart, order: shop.order, mine: shop.mine,
  studio: studio.dashboard, listing: studio.editor, admin: admin.platform, about: about.page,
};

export const app = {
  rt: null,
  ready: false,
  bus: new EventTarget(),
  persona: 'visitor',
  personas: {
    visitor: { label: 'Guest', email: null, role: null, hue: 220 },
    buyer: { label: 'Maya Chen', blurb: 'Buyer · owns two apps already', ...DEMO_ACCOUNTS.consumer, role: 'Consumer', hue: 18 },
    provider: { label: STUDIOS[0].name, blurb: 'Software studio · sells four products', ...DEMO_ACCOUNTS.provider, role: 'Provider', hue: 168 },
    admin: { label: 'Platform admin', blurb: 'Runs the marketplace', ...DEMO_ACCOUNTS.admin, role: 'Admin', hue: 262 },
  },
  tokens: {},
  view: { name: 'home', params: {} },
  history: [],
  cartCount: 0,
  unread: 0,
  scenesOpen: false,

  emit(type, detail) { app.bus.dispatchEvent(new CustomEvent(type, { detail })); },
  on(type, fn) { app.bus.addEventListener(type, (e) => fn(e.detail)); },
  current() { return app.personas[app.persona]; },
  role() { return app.current().role; },

  async token(who = app.persona) {
    const p = app.personas[who];
    if (!p.email) return null;
    const t = app.tokens[who];
    if (t && t.exp > Date.now() + 60_000) return t.accessToken;
    const fresh = await app.rt.signIn(p.email, p.password);
    app.tokens[who] = { ...fresh, exp: Date.now() + fresh.expiresIn * 1000 };
    app.emit('auth', { who, label: p.label });
    return fresh.accessToken;
  },
  /** Call the API as the current user. Returns {status, data, trace}. */
  async call(method, path, { query, body, headers } = {}) {
    let token = null;
    try { token = await app.token(); } catch (e) { app.emit('signin-refused', e.message); }
    return app.rt.request({ method, path, query: query || {}, body, headers: headers || {}, token });
  },

  async setPersona(key) {
    app.persona = key;
    app.unread = 0;
    if (key !== 'visitor') { try { await app.token(); } catch (e) { toast(`Sign-in refused: ${e.message}`); } }
    renderHeader();
    await refreshCart();
    app.emit('persona', key);
    const r = app.role();
    if (r === 'Provider') app.go('studio', {}, { replace: true });
    else if (r === 'Admin') app.go('admin', {}, { replace: true });
    else app.rerender();
  },

  go(name, params = {}, { replace = false } = {}) {
    if (!replace) app.history.push(app.view);
    app.view = { name, params };
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
  },
  back() {
    const prev = app.history.pop();
    app.view = prev || { name: 'home', params: {} };
    render();
  },
  rerender() { render(); },
  setCartCount(n) { app.cartCount = n; renderBadges(); },
};
globalThis.softhub = app; // handy from the browser console

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const view = $('#view');
  const fn = VIEWS[app.view.name] || VIEWS.home;
  renderNav();
  if (!app.ready && app.view.name !== 'about') return;
  try {
    const node = await fn(app, app.view.params);
    if (seq !== renderSeq) return; // a newer navigation won
    mount(view, node);
    view.classList.remove('view-enter'); void view.offsetWidth; view.classList.add('view-enter');
    app.emit('view', app.view);
  } catch (e) {
    console.error(e);
    mount(view, h('div', { class: 'empty' }, `Something went wrong: ${e.message}`));
  }
}

// ------------------------------------------------------------------ header

function renderHeader() {
  const p = app.current();
  const btn = $('#account-btn');
  mount(btn, avatar(p.label, p.hue), h('span', { class: 'txt' }, p.email ? p.label : 'Sign in'));
  renderNav();
  renderBadges();
}

function renderNav() {
  const r = app.role();
  const items = [['home', 'Discover'], ['catalog', 'All software']];
  if (r === 'Consumer') items.push(['mine', 'My software']);
  if (r === 'Provider') items.push(['studio', 'Studio'], ['listing', 'New listing']);
  if (r === 'Admin') items.push(['admin', 'Platform']);
  items.push(['about', 'How it works']);
  mount($('#navrow'), items.map(([name, label]) => h('button', {
    type: 'button', 'aria-current': String(app.view.name === name), onclick: () => app.go(name),
  }, label)));
}

function renderBadges() {
  const c = $('#cart-n'), i = $('#inbox-n');
  c.hidden = !app.cartCount; c.textContent = app.cartCount;
  i.hidden = !app.unread; i.textContent = app.unread;
}

async function refreshCart() {
  if (app.role() !== 'Consumer') return app.setCartCount(0);
  const r = await app.call('GET', '/cart');
  app.setCartCount(r.status === 200 ? r.data.items.length : 0);
}

// ------------------------------------------------------------------ modals & toasts

export function openModal(build, { wide = false, onClose } = {}) {
  const root = $('#modal-root');
  const close = () => { mount(root); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } }, box);
  mount(root, back);
  document.addEventListener('keydown', esc);
  const fill = (...nodes) => { mount(box, ...nodes); const f = box.querySelector('input, button:not(.x)'); if (f) f.focus(); };
  build({ fill, close, box });
  return close;
}

export function modalHead(title, close, eyebrow) {
  return h('div', { class: 'modal-head' }, h('div', {}, eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null, h('h2', {}, title)), h('button', { type: 'button', class: 'x', 'aria-label': 'Close', onclick: close }, '×'));
}

export function toast(text, action) {
  const t = h('div', { class: 'toast', role: 'status' }, h('span', {}, text),
    action ? h('button', { type: 'button', onclick: () => { action.run(); t.remove(); } }, action.label) : null);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), action ? 7000 : 4200);
}

// ------------------------------------------------------------------ boot

$('#home-link').addEventListener('click', () => app.go('home'));
$('#ribbon-about').addEventListener('click', () => app.go('about'));
$('#foot-about').addEventListener('click', () => app.go('about'));
$('#cart-btn').addEventListener('click', () => (app.role() === 'Consumer' ? app.go('cart') : shop.accountModal(app, 'Sign in as a buyer to use the cart.')));
$('#inbox-btn').addEventListener('click', () => shop.inboxModal(app));
$('#account-btn').addEventListener('click', () => shop.accountModal(app));
$('#search').addEventListener('submit', (e) => { e.preventDefault(); app.go('catalog', { q: $('#q').value.trim() }); });
renderHeader();
initGuide(app);

async function boot() {
  const rt = createLocalRuntime({ clock: createShiftClock(), seed: 42 });
  app.rt = rt;
  await seedMarketplace(rt, { orders: 200, shoppers: 60, reviewRate: 0.5, seed: 7 });
  rt.scheduler.setLive(true);
  rt.onEvent((e) => app.emit(`rt:${e.kind}`, e));
  app.on('rt:email', ({ mail }) => {
    if (mail.to === app.current().email || mail.to === app.pendingSignup) {
      app.unread++;
      renderBadges();
      toast(mail.kind === 'receipt' ? 'Your receipt and licence keys just arrived.' : `Verification code sent to ${mail.to}.`, { label: 'Open inbox', run: () => shop.inboxModal(app) });
    }
  });
  // fulfilment empties the buyer's cart on the server: keep the badge honest
  app.on('rt:request', ({ trace }) => { if (trace.source === 'stripe' && trace.response?.fulfilled) refreshCart(); });
  app.ready = true;
  $('#boot-dot').classList.add('live');
  initDiagram(app);
  initScenes(app);
  render();
}

boot().catch((e) => {
  console.error(e);
  mount($('#view'), h('div', { class: 'empty' }, `The in-page backend failed to start: ${e.message}`));
});
