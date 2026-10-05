// Lab 3: run each access pattern against the live table.
import { h, $, mount, int } from './ui.js';
import { ACCESS_PATTERNS } from './core/keys.js';
import { itemSize } from './core/store.js';
import { DEMO_ACCOUNTS, STUDIOS } from './core/seed.js';

let app, current = 'category';

export function initTableLab(a) {
  app = a;
  renderPatterns();
  run();
  app.on('rt:request', (e) => { if (e.trace.ops.some((o) => o.wru)) scheduleRerun(); });
}

let timer = null;
function scheduleRerun() { clearTimeout(timer); timer = setTimeout(run, 600); }

function renderPatterns() {
  mount($('#patterns'), ACCESS_PATTERNS.map((p) => h('button', { class: 'pattern', 'aria-pressed': String(current === p.id), onclick: () => { current = p.id; renderPatterns(); run(); } },
    h('b', { class: 'small' }, p.name), h('code', {}, `${p.call} · ${p.key}`))));
}

function ctx() {
  const rt = app.rt;
  const maya = rt.identity._user(DEMO_ACCOUNTS.consumer.email).sub;
  const studio = rt.identity._user(STUDIOS[0].email).sub;
  const all = rt.table._all();
  const products = all.filter((r) => r.SK === 'META' && r.PK.startsWith('PRODUCT#')).sort((x, y) => (y.reviewCount || 0) - (x.reviewCount || 0));
  const order = all.filter((r) => r.SK === 'META' && r.PK.startsWith('ORDER#') && r.sub === maya)[0];
  const today = new Date(rt.clock.now()).toISOString().slice(0, 10);
  const from = new Date(rt.clock.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  return { maya, studio, all, product: products[0], order, today, from };
}

function spec(id, c) {
  const pid = c.product.productId;
  return {
    product: { get: { PK: `PRODUCT#${pid}`, SK: 'META' }, partition: `PRODUCT#${pid}` },
    category: { q: { index: 'GSI1', pk: 'CAT#games' } },
    reviews: { q: { pk: `PRODUCT#${pid}`, sk: { beginsWith: 'REVIEW#' }, desc: true, limit: 10 }, partition: `PRODUCT#${pid}` },
    also: { q: { pk: `PRODUCT#${pid}`, sk: { beginsWith: 'ALSO#' } }, partition: `PRODUCT#${pid}` },
    cart: { q: { pk: `USER#${c.maya}`, sk: { beginsWith: 'CART#' } }, partition: `USER#${c.maya}` },
    library: { q: { pk: `USER#${c.maya}`, sk: { beginsWith: 'OWNS#' } }, partition: `USER#${c.maya}` },
    orders: { q: { index: 'GSI1', pk: `USER#${c.maya}`, sk: { beginsWith: 'ORDER#' }, desc: true } },
    order: { q: { pk: `ORDER#${c.order?.orderId}` }, partition: `ORDER#${c.order?.orderId}` },
    myproducts: { q: { index: 'GSI2', pk: `PROVIDER#${c.studio}` } },
    sales: { q: { pk: `PROVIDER#${c.studio}`, sk: { between: [`SALES#${c.from}`, `SALES#${c.today}~`] } }, partition: `PROVIDER#${c.studio}` },
    email: { q: { index: 'GSI1', pk: `EMAIL#${DEMO_ACCOUNTS.consumer.email}` } },
    platform: { q: { pk: 'PLATFORM', sk: { between: [`DAY#${c.from}`, `DAY#${c.today}`] } }, partition: 'PLATFORM' },
  }[id];
}

const short = (v) => (typeof v === 'string' ? v.replace(/([0-9a-f]{8})-[0-9a-f-]{27}/g, '$1…').replace(/(prd_|ord_|rev_)([0-9A-Z]{6})[0-9A-Z]{20}/g, '$1$2…') : v);

async function run() {
  const c = ctx();
  const p = ACCESS_PATTERNS.find((x) => x.id === current);
  const sp = spec(current, c);
  let rows = [];
  const t = app.rt.table;
  if (sp.get) { const it = await t.get(sp.get); rows = it ? [it] : []; }
  else rows = (await t.query({ limit: 100, ...sp.q })).items;
  // DynamoDB bills a read by the bytes it returns: 4 KB per unit, halved for eventually consistent reads
  const rru = Math.max(1, Math.ceil(rows.reduce((a, r) => a + itemSize(r), 0) / 4096)) * 0.5;
  const hit = new Set(rows.map((r) => `${r.PK}|${r.SK}`));
  const scanBytes = c.all.reduce((a, r) => a + itemSize(r), 0);
  const scanRru = Math.ceil(scanBytes / 4096) * 0.5;
  $('#q-call').textContent = p.call;
  $('#q-key').textContent = sp.get ? `PK=${short(sp.get.PK)}, SK=META` : `${sp.q.index && sp.q.index !== 'base' ? `${sp.q.index}PK` : 'PK'}=${short(sp.q.pk)}${sp.q.sk ? `, SK ${Object.keys(sp.q.sk)[0]} ${short(JSON.stringify(Object.values(sp.q.sk)[0]))}` : ''}${sp.q.desc ? ' (newest first)' : ''}`;
  $('#q-rows').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} read`;
  const max = scanRru;
  mount($('#q-meter'),
    h('div', { class: 'meter-row' }, h('span', { class: 'small' }, 'this call'), h('span', { class: 'bar' }, h('i', { style: { width: `${Math.max(0.5, (rru / max) * 100)}%` } })), h('span', { class: 'small num' }, `${rru} RRU`)),
    h('div', { class: 'meter-row' }, h('span', { class: 'small' }, 'full scan'), h('span', { class: 'bar scan' }, h('i', { style: { width: '100%' } })), h('span', { class: 'small num' }, `${int(scanRru)} RRU`)));
  // show the partition the call reads (base table), or just the matches (GSI)
  const shown = sp.partition ? c.all.filter((r) => r.PK === sp.partition).sort((a, b) => (a.SK < b.SK ? -1 : 1)) : rows;
  const gsi = sp.q?.index;
  const cols = ['PK', 'SK', ...(gsi ? [`${gsi}PK`, `${gsi}SK`] : []), 'type', 'attributes'];
  mount($('#items'),
    h('thead', {}, h('tr', {}, cols.map((x) => h('th', {}, x)))),
    h('tbody', {}, shown.slice(0, 80).map((r) => h('tr', { class: hit.has(`${r.PK}|${r.SK}`) ? 'hit' : '' },
      h('td', {}, short(r.PK)), h('td', {}, short(r.SK)),
      gsi ? [h('td', {}, short(r[`${gsi}PK`])), h('td', {}, short(r[`${gsi}SK`]))] : null,
      h('td', {}, r.type || ''),
      h('td', { title: JSON.stringify(r) }, summary(r))))));
  $('#table-size').textContent = `The table holds ${int(c.all.length)} items (${int(scanBytes / 1024)} KB). ${sp.partition ? `Shown: the whole ${short(sp.partition)} item collection; highlighted rows are the ones this call reads.` : `Shown: the rows the ${gsi} query returns, sorted by ${gsi}SK.`}`;
}

function summary(r) {
  const skip = new Set(['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'type', 'image', 'description', 'features', 'lines', 'response']);
  return Object.entries(r).filter(([k]) => !skip.has(k) && !k.startsWith('a_')).slice(0, 7).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 24) : short(String(v)).slice(0, 28)}`).join('  ');
}
