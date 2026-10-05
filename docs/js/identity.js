// Lab 2: the access token, a forgery attempt, and the route permission matrix.
import { h, $, mount, chip } from './ui.js';
import { ROUTES } from './core/api/app.js';
import { decodeJwt } from './core/auth.js';
import { base64url } from './core/crypto.js';

let app;

export function initIdentity(a) {
  app = a;
  app.on('persona', render);
  app.on('auth', render);
  render();
  renderMatrix();
  $('#forge').addEventListener('click', () => attempt(true));
  $('#honest').addEventListener('click', () => attempt(false));
}

async function render() {
  const p = app.current();
  $('#tok-who').textContent = p.email ? `${p.label}` : 'visitor';
  if (!p.email) {
    mount($('#jwt'), 'A visitor has no token. Pick Maya, the provider or the admin in the storefront.');
    mount($('#claims'));
    return;
  }
  const tok = await app.token();
  const [hh, pp, ss] = tok.split('.');
  mount($('#jwt'), h('span', { class: 'h' }, hh), '.', h('span', { class: 'p' }, pp), '.', h('span', { class: 's' }, ss));
  const c = decodeJwt(tok).payload;
  const rows = [['sub', c.sub], ['cognito:groups', JSON.stringify(c['cognito:groups'])], ['token_use', c.token_use], ['client_id', c.client_id], ['iss', c.iss], ['expires', new Date(c.exp * 1000).toLocaleTimeString('en-CA')]];
  mount($('#claims'), rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

async function attempt(forge) {
  const out = $('#forge-out');
  const p = app.current();
  if (!p.email) { out.textContent = 'Sign in as Maya or the provider first (storefront persona switcher).'; return; }
  let tok = await app.token();
  if (forge) {
    const t = decodeJwt(tok);
    const payload = base64url(JSON.stringify({ ...t.payload, 'cognito:groups': ['Admin'] }));
    tok = `${t.signingInput.split('.')[0]}.${payload}.${t.signature}`;
  }
  const r = await app.rt.request({ method: 'GET', path: '/admin/metrics', token: tok });
  out.textContent = `GET /admin/metrics  →  ${r.status}\n${JSON.stringify(r.data?.error || { totals: r.data?.totals }, null, 2)}\n\n${r.trace.gateway
    ? 'Stopped at API Gateway: no Lambda ran, no table read, nothing billed beyond the request.'
    : r.status === 403 ? 'The token is genuine, so it reached Lambda; the router refused because the groups claim does not include Admin.' : 'Allowed.'}`;
}

function renderMatrix() {
  const roles = ['Visitor', 'Consumer', 'Provider', 'Admin'];
  const allowed = (r, role) => (role === 'Visitor' ? !r.auth : !!r.auth && r.auth.includes(role)) || (!r.auth && role !== 'Visitor');
  mount($('#matrix'),
    h('thead', {}, h('tr', {}, h('th', {}, 'Route'), h('th', {}, 'What it does'), h('th', {}, 'Lambda'), roles.map((r) => h('th', { class: 'c' }, r)), h('th', {}, ''))),
    h('tbody', {}, ROUTES.map((r) => {
      const res = h('span', { class: 'small muted' });
      return h('tr', {},
        h('td', {}, h('code', {}, `${r.method} ${r.path}`)),
        h('td', {}, r.name),
        h('td', {}, r.fn),
        roles.map((role) => h('td', { class: `c ${allowed(r, role) ? 'yes' : 'no'}` }, allowed(r, role) ? '✓' : '·')),
        h('td', {}, r.method === 'GET' && !r.path.includes('{') ? h('button', { class: 'btn sm', onclick: async () => {
          const who = app.current().label.split(' (')[0];
          const x = await app.call('GET', r.path, { query: r.path === '/admin/users' ? { email: 'maya.chen@example.com' } : {} });
          mount(res, chip(`${who} → ${x.status}`, x.status < 300 ? 'good' : 'bad'));
        } }, 'call') : null, ' ', res));
    })));
}
