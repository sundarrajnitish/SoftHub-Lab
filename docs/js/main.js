// Boot: start the in-page backend, seed it, then wire every lab to it.
import { createLocalRuntime, createShiftClock } from './core/runtime.js';
import { seedMarketplace } from './core/seedrun.js';
import { DEMO_ACCOUNTS, STUDIOS } from './core/seed.js';
import { RESULTS } from '../data/results.js';
import { $, $$ } from './ui.js';
import { initDiagram } from './diagram.js';
import { initStore } from './store.js';
import { initInspector } from './inspector.js';
import { initIdentity } from './identity.js';
import { initTableLab } from './tablelab.js';
import { initPayments } from './payments.js';
import { initReviews } from './reviews.js';
import { initRecs } from './recs.js';
import { initScale } from './scale.js';
import { initResults } from './results.js';

/** Shared state for all labs. */
export const app = {
  rt: null,
  ready: false,
  bus: new EventTarget(),
  persona: 'visitor',
  personas: {
    visitor: { label: 'Visitor', email: null, password: null, role: null },
    buyer: { label: 'Maya (buyer)', ...DEMO_ACCOUNTS.consumer, role: 'Consumer' },
    provider: { label: `${STUDIOS[0].name} (provider)`, ...DEMO_ACCOUNTS.provider, role: 'Provider' },
    admin: { label: 'Admin', ...DEMO_ACCOUNTS.admin, role: 'Admin' },
  },
  tokens: {},
  emit(type, detail) { app.bus.dispatchEvent(new CustomEvent(type, { detail })); },
  on(type, fn) { app.bus.addEventListener(type, (e) => fn(e.detail)); },
  current() { return app.personas[app.persona]; },

  async token(who = app.persona) {
    const p = app.personas[who];
    if (!p.email) return null;
    const t = app.tokens[who];
    if (t && t.exp > Date.now() + 60_000) return t.accessToken;
    const fresh = await app.rt.signIn(p.email, p.password);
    app.emit('auth', who);
    app.tokens[who] = { ...fresh, exp: Date.now() + fresh.expiresIn * 1000 };
    return fresh.accessToken;
  },
  /** Call the API as the current persona. Returns {status, data, trace}. */
  async call(method, path, { query, body, headers, who } = {}) {
    let token;
    try {
      token = await app.token(who || app.persona);
    } catch (e) {
      // e.g. the account was suspended, so Cognito refuses to sign it in:
      // carry on without a token, protected routes then answer 401
      token = null;
      app.emit('signin-refused', e.message);
    }
    return app.rt.request({ method, path, query: query || {}, body, headers: headers || {}, token });
  },
  setPersona(p) {
    app.persona = p;
    app.emit('persona', p);
  },
};

// Things that need no backend render immediately.
globalThis.softhub = app; // handy from the browser console
initResults(RESULTS);
initScale(RESULTS);
initDiagram(app);

async function boot() {
  const rt = createLocalRuntime({ clock: createShiftClock(), seed: 42 });
  app.rt = rt;
  await seedMarketplace(rt, { orders: 200, shoppers: 60, reviewRate: 0.5, seed: 7 });
  rt.scheduler.setLive(true);
  rt.onEvent((e) => app.emit(`rt:${e.kind}`, e));
  app.ready = true;
  const dot = $('#live-dot');
  dot.classList.add('live');
  dot.title = 'Backend running in this tab';
  // the receipt in the hero shows the demo buyer's real order
  const lib = await app.call('GET', '/library', { who: 'buyer' });
  const first = lib.data.items?.find((l) => l.name === 'Quillwork Notes');
  if (first) { $('#slip-order').textContent = `${first.orderId.slice(0, 12)}…`; $('#slip-key').textContent = first.licenseKey; }
  initInspector(app);
  initStore(app);
  initIdentity(app);
  initTableLab(app);
  initPayments(app);
  initReviews(app, RESULTS);
  initRecs(app, RESULTS);
  app.emit('ready');
}

boot().catch((e) => {
  console.error(e);
  const shop = $('#shop');
  if (shop) shop.textContent = `The in-page backend failed to start: ${e.message}`;
});

// highlight the section in view
const links = $$('.top nav a');
const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    for (const a of links) a.classList.toggle('on', a.getAttribute('href') === `#${en.target.id}`);
  }
}, { rootMargin: '-45% 0px -50% 0px' });
for (const sec of $$('main section[id]')) io.observe(sec);
