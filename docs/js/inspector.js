// Request inspector: every call the in-page backend served, as a waterfall.
import { h, $, mount, ms, chip } from './ui.js';

let app;
const traces = [];
let selected = null;

export function initInspector(a) {
  app = a;
  app.on('rt:request', ({ trace }) => {
    traces.unshift(trace);
    if (traces.length > 300) traces.pop();
    renderList();
    if (!selected || selected === 'follow') show(trace, true);
  });
  $('#trace-clear').addEventListener('click', () => { traces.length = 0; selected = null; renderList(); mount($('#trace-detail'), h('p', { class: 'empty' }, 'Cleared.')); });
  renderList();
}

function renderList() {
  const list = $('#trace-list');
  mount(list, traces.slice(0, 120).map((t) => h('button', {
    class: 'trace-item', role: 'option', 'aria-current': String(selected === t), onclick: () => { selected = t; show(t); renderList(); },
  },
  h('span', { class: `m-${t.method}` }, t.source === 'stripe' ? 'STRIPE' : t.method),
  h('span', { class: 'path', title: t.path }, t.path),
  h('span', { class: `s-${String(t.status)[0]}` }, t.status),
  h('span', { class: 'num', style: { textAlign: 'right' } }, ms(t.totalMs || 0)))));
  $('#trace-count').textContent = `${traces.length} requests`;
  const warm = Object.values(app.rt.warmContainers()).reduce((a, p) => a + p.length, 0);
  $('#warm-count').textContent = `${warm} warm container${warm === 1 ? '' : 's'}`;
}

function show(t, follow = false) {
  if (follow) selected = 'follow';
  const total = Math.max(1, t.totalMs || 1);
  const rows = [];
  let at = 0;
  const bar = (label, start, dur, cls = '', note = '') => rows.push(h('div', { class: 'wf-row' },
    h('span', { class: 'lbl', title: label }, label),
    h('span', { class: 'wf-track' }, h('i', { class: cls, style: { left: `${(start / total) * 100}%`, width: `${Math.max(0.6, (dur / total) * 100)}%` } })),
    h('span', { class: 'num muted', style: { textAlign: 'right' } }, note || ms(dur))));
  if (t.source !== 'dynamodb-stream') { bar(t.gateway ? 'API Gateway (rejected)' : 'API Gateway + authorizer', 0, t.apiGatewayMs || 6, t.gateway ? 'fail' : 'gw'); at = t.apiGatewayMs || 6; }
  if (t.initMs) { bar(`cold start · ${t.container}`, at, t.initMs, 'init'); at += t.initMs; }
  if (!t.gateway) {
    let cur = at + 2.5;
    for (const op of t.ops) {
      const label = `${op.op}${op.index && op.index !== 'base' ? ` ${op.index}` : ''} ${op.pk || ''}`;
      bar(label, cur, op.ms || 5, op.failed ? 'fail' : '', `${ms(op.ms || 5)}`);
      cur += op.ms || 5;
    }
    for (const sc of t.stripe) { bar(`Stripe ${sc.call}`, cur, sc.ms || 280, 'stripe'); cur += sc.ms || 280; }
    if (t.source === 'dynamodb-stream') bar('SES SendEmail', cur, 60, 'stripe');
  }
  const rru = t.ops.reduce((a, o) => a + o.rru, 0), wru = t.ops.reduce((a, o) => a + o.wru, 0);
  const steps = t.steps.filter((x) => !['route', 'response'].includes(x.step));
  mount($('#trace-detail'),
    h('div', { class: 'row spread', style: { marginBottom: '8px' } },
      h('code', {}, `${t.method} ${t.path}`),
      h('span', { class: 'row' }, chip(String(t.status), t.status < 300 ? 'good' : 'bad'), t.fn ? chip(`λ ${t.fn} · ${t.cold ? 'cold' : 'warm'}`, t.cold ? 'warn' : 'flow') : chip('gateway', 'bad'), chip(ms(t.totalMs || 0)))),
    h('div', { class: 'waterfall' }, rows),
    h('dl', { class: 'kv', style: { marginTop: '10px' } },
      h('dt', {}, 'source'), h('dd', {}, t.source === 'stripe' ? 'Stripe webhook delivery' : t.source === 'dynamodb-stream' ? 'DynamoDB stream record' : 'browser'),
      h('dt', {}, 'capacity'), h('dd', {}, `${rru} read units · ${wru} write units`),
      t.ops.length ? [h('dt', {}, 'items'), h('dd', { style: { whiteSpace: 'pre-line' } }, t.ops.flatMap((o) => (o.keys || []).slice(0, 4).map((k) => `${k.PK} · ${k.SK}`)).slice(0, 6).join('\n'))] : null,
      steps.length ? [h('dt', {}, 'steps'), h('dd', {}, steps.map((x) => `${x.step}${x.code ? ` (${x.code})` : ''}${x.reason ? ` — ${x.reason}` : ''}${x.label ? ` ${x.label}` : ''}`).join(' → '))] : null),
    h('pre', { class: 'code', style: { marginTop: '10px' } }, JSON.stringify(t.response, null, 1)?.slice(0, 2400) || '(empty)'));
}
