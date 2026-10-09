// Platform console for the admin.
import { h, mount, money, int, chip, statusKind } from './ui.js';
import { barChart } from './charts.js';
import { toast } from './main.js';

export async function platform(app) {
  if (app.role() !== 'Admin') return h('p', { class: 'empty' }, 'The platform console is for admins. Choose the admin account from the account menu.');
  const m = (await app.call('GET', '/admin/metrics')).data;
  const chart = h('svg', { svg: true, class: 'chart', viewBox: '0 0 640 220', role: 'img', 'aria-label': 'Orders per day' });
  const found = h('div', {});
  const lookup = async (email) => {
    const r = await app.call('GET', '/admin/users', { query: { email } });
    if (r.status !== 200) return mount(found, h('p', { class: 'empty' }, `No account for ${email}.`));
    showUser(r.data);
  };
  const showUser = (u) => {
    const reason = h('input', { type: 'text', id: 'adm-reason', placeholder: 'Reason (required)', value: u.status === 'ACTIVE' ? 'Chargeback abuse under review' : 'Review complete' });
    mount(found, h('div', { class: 'card stack' },
      h('div', { class: 'row spread' }, h('span', {}, h('b', {}, u.email), h('br'), h('span', { class: 'small muted' }, `${u.role} · joined ${new Date(u.createdAt).toLocaleDateString('en-CA')}`)), chip(u.status.toLowerCase(), statusKind(u.status))),
      u.statusReason ? h('p', { class: 'small muted' }, `Last change: ${u.statusReason}`) : null,
      h('div', { class: 'row' }, reason,
        h('button', { type: 'button', class: `btn ${u.status === 'ACTIVE' ? 'danger' : 'primary'}`, onclick: async () => {
          const next = u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
          const r = await app.call('PUT', `/admin/users/${u.sub}/status`, { body: { status: next, reason: reason.value } });
          if (r.status !== 200) return toast(r.data.error.message);
          toast(next === 'SUSPENDED' ? `${u.email} is suspended: sign-in is blocked and their next request is refused, even with a token they already hold.` : `${u.email} is active again.`);
          app.emit('did', 'admin');
          showUser({ ...u, status: next, statusReason: reason.value });
        } }, u.status === 'ACTIVE' ? 'Suspend' : 'Reinstate'))));
  };
  const body = h('div', { class: 'stack', style: { gap: '22px' } },
    h('div', {}, h('p', { class: 'eyebrow' }, 'Platform console'), h('h1', {}, 'SoftHub, last 30 days')),
    h('div', { class: 'kpis' },
      kpi(int(m.totals.orders), 'Orders'), kpi(money(m.totals.gmvCents), 'Sales'),
      kpi(money(m.commissionCents), 'Commission (10 %)'), kpi(`${m.paymentSuccessRate ?? '—'} %`, 'Payments approved')),
    h('div', { class: 'kpis' },
      kpi(int(m.totals.units), 'Licences issued'), kpi(int(m.totals.signups), 'New accounts'),
      kpi(int(m.totals.reviews), 'Reviews written'), kpi(money(m.totals.feesCents), 'Card processing fees')),
    h('div', { class: 'card' }, h('p', { class: 'label' }, 'Orders per day'), chart),
    h('div', { class: 'card stack' },
      h('p', { class: 'label' }, 'Accounts'),
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); lookup(new FormData(e.target).get('email')); } },
        h('input', { type: 'email', name: 'email', id: 'adm-email', value: 'maya.chen@example.com', style: { flex: '1 1 220px', width: 'auto' }, 'aria-label': 'E-mail' }),
        h('button', { class: 'btn' }, 'Find account')),
      found));
  requestAnimationFrame(() => barChart(chart, { labels: m.days.map((d) => d.day.slice(5)), values: m.days.map((d) => d.orders), xEvery: 5 }));
  return body;
}

const kpi = (v, label) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, label));
