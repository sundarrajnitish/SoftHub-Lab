// Provider studio: sales dashboard, listings, and the listing editor.
import { h, mount, money, int, cover, chip, stars, statusKind } from './ui.js';
import { barChart } from './charts.js';
import { toast } from './main.js';
import { CATEGORIES } from './core/keys.js';
import { productArt } from './core/api/provider.js';

const PLATFORMS = ['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'Web'];
const LICENSES = ['Perpetual', 'Subscription (1 year)', 'Subscription (1 month)', 'Freemium'];

export async function dashboard(app) {
  if (app.role() !== 'Provider') return h('p', { class: 'empty' }, 'The studio is for software providers. Switch to Northlight Software from the account menu.');
  const [dash, mine] = await Promise.all([app.call('GET', '/provider/dashboard'), app.call('GET', '/provider/products')]);
  const d = dash.data;
  const chart = h('svg', { svg: true, class: 'chart', viewBox: '0 0 640 220', role: 'img', 'aria-label': 'Revenue per day' });
  const byId = new Map(d.products.map((p) => [p.productId, p]));
  const body = h('div', { class: 'stack', style: { gap: '22px' } },
    h('div', { class: 'row spread' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Studio'), h('h1', {}, app.current().label)),
      h('button', { type: 'button', class: 'btn primary', onclick: () => app.go('listing') }, 'New listing')),
    h('div', { class: 'kpis' },
      kpi(money(d.totals.revenueCents), 'Sales, last 30 days'),
      kpi(money(d.totals.payoutCents), 'Your payout (90 %)'),
      kpi(int(d.totals.units), 'Licences sold'),
      kpi(int(d.products.filter((p) => p.status === 'PUBLISHED').length), 'Live listings')),
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('p', { class: 'label' }, 'Sales per day'), h('span', { class: 'small muted' }, `${d.from} → ${d.to}`)), chart),
    h('div', { class: 'card' },
      h('p', { class: 'label', style: { marginBottom: '6px' } }, 'Your listings'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
        h('thead', {}, h('tr', {}, ['Product', 'Live', 'Price', 'Sold (30 d)', 'Rating', 'What buyers say', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, mine.data.items.map((p) => row(app, p, byId.get(p.productId))))))));
  requestAnimationFrame(() => barChart(chart, {
    labels: d.series.map((x) => x.day.slice(5)), values: d.series.map((x) => x.revenueCents / 100), xEvery: 5,
    valueFmt: (v) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v)}`,
  }));
  return body;
}

const kpi = (v, label) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, label));

function row(app, p, stat) {
  const input = h('input', { type: 'number', id: `price-${p.productId}`, min: '0.99', step: '0.01', value: (p.priceCents / 100).toFixed(2), 'aria-label': `Price of ${p.name}` });
  const live = p.status === 'PUBLISHED';
  const save = async (changes) => {
    const r = await app.call('PUT', `/provider/products/${p.productId}`, { body: { ver: p.ver, ...changes } });
    if (r.status === 200) { toast(changes.priceCents ? `${p.name} now costs ${money(r.data.priceCents)} for new orders.` : `${p.name} is ${r.data.status === 'PUBLISHED' ? 'live in the store' : 'hidden from the store'}.`); app.rerender(); }
    else toast(r.status === 409 ? 'Someone saved this listing meanwhile. Reloaded the latest version.' : r.data.error.message);
    if (r.status === 409) app.rerender();
  };
  const top = stat?.aspects?.[0];
  return h('tr', {},
    h('td', {}, h('span', { class: 'pname' }, cover(p.image, p.name), h('b', {}, p.name))),
    h('td', {}, h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(live), 'aria-label': `${p.name} live`, onclick: () => save({ publish: !live }) })),
    h('td', {}, h('form', { class: 'price-edit', onsubmit: (e) => { e.preventDefault(); save({ priceCents: Math.round(Number(input.value) * 100) }); } }, input, h('button', { class: 'btn sm' }, 'Save'))),
    h('td', { class: 'n' }, `${stat?.units || 0} · ${money(stat?.revenueCents || 0)}`),
    h('td', {}, stat?.reviews ? stars(stat.rating) : h('span', { class: 'small muted' }, 'no reviews')),
    h('td', { class: 'small' }, stat?.reviews ? [chip(stat.mood, stat.sentiment >= 0.2 ? 'good' : stat.sentiment <= -0.05 ? 'bad' : 'warn'), top ? h('span', { class: 'muted' }, ` most said about ${top.label} (${top.score >= 0 ? 'liked' : 'disliked'})`) : null] : '—'),
    h('td', {}, h('button', { type: 'button', class: 'btn sm ghost', onclick: () => app.go('listing', { id: p.productId }) }, 'Edit')));
}

// ------------------------------------------------------------------ editor

export async function editor(app, { id } = {}) {
  if (app.role() !== 'Provider') return h('p', { class: 'empty' }, 'Switch to a provider account to create listings.');
  let existing = null;
  if (id) existing = (await app.call('GET', '/provider/products')).data.items.find((p) => p.productId === id);
  const f = existing ? {
    name: existing.name, category: existing.category, description: existing.description, developer: existing.developer, platforms: [...existing.platforms],
    price: (existing.priceCents / 100).toFixed(2), tags: existing.tags.join(', '), features: existing.features.join('\n'), licenseType: existing.licenseType || 'Perpetual', publish: existing.status === 'PUBLISHED',
  } : {
    name: 'Inkwell Sketch', category: 'productivity', developer: app.current().label, platforms: ['Windows', 'macOS'], price: '24.99', licenseType: 'Perpetual', publish: true,
    description: 'An infinite canvas for sketching ideas, wireframes and diagrams, with pressure-sensitive pens and layers.',
    tags: 'drawing, notes, design', features: 'Infinite canvas\nPressure-sensitive pens\nLayers and export to PDF',
  };
  const preview = h('div', {});
  const msg = h('p', { class: 'small', style: { color: 'var(--bad)' } });
  const drawPreview = () => mount(preview,
    h('p', { class: 'label', style: { marginBottom: '8px' } }, 'Preview in the store'),
    h('div', { class: 'pcard', style: { cursor: 'default' } }, cover(productArt(f.name || '?'), f.name || 'Untitled'),
      h('span', { class: 'body' }, h('b', {}, f.name || 'Untitled'), h('span', { class: 'studio' }, `${f.developer} · ${CATEGORIES.find((c) => c.slug === f.category)?.title}`),
        h('span', { class: 'foot' }, h('span', { class: 'small muted' }, 'New'), h('span', { class: 'price' }, money(Math.round(Number(f.price || 0) * 100)))))),
    h('p', { class: 'small muted', style: { marginTop: '10px' } }, 'Cover art is generated from the product name. ', f.publish ? 'Publishing puts it in the catalogue immediately.' : 'Saved as a draft: only you can see it.'));
  const bind = (k) => (e) => { f[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; drawPreview(); };
  drawPreview();
  const submit = async (e) => {
    e.preventDefault();
    const body = {
      name: f.name, category: f.category, description: f.description, developer: f.developer, platforms: f.platforms,
      priceCents: Math.round(Number(f.price) * 100), licenseType: f.licenseType, publish: f.publish,
      tags: f.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean), features: f.features.split('\n').map((t) => t.trim()).filter(Boolean),
    };
    const r = existing
      ? await app.call('PUT', `/provider/products/${existing.productId}`, { body: { ...body, ver: existing.ver } })
      : await app.call('POST', '/provider/products', { body });
    if (r.status >= 400) { msg.textContent = r.data.error.fields ? r.data.error.fields.map((x) => `${x.field}: ${x.error}`).join(' · ') : r.data.error.message; return; }
    app.emit('did', 'listing');
    toast(existing ? 'Listing saved.' : f.publish ? `${f.name} is live in the store.` : 'Draft saved.', r.data.status === 'PUBLISHED' ? { label: 'View', run: () => app.go('product', { id: r.data.productId }) } : null);
    app.go('studio');
  };
  const archive = async () => {
    const r = await app.call('DELETE', `/provider/products/${existing.productId}`);
    if (r.status === 200) { toast(`${existing.name} archived. Its owners keep their licences.`); app.go('studio'); }
  };
  return h('div', {},
    h('button', { type: 'button', class: 'back', onclick: () => app.back() }, '← Studio'),
    h('h1', { style: { marginBottom: '18px' } }, existing ? `Edit ${existing.name}` : 'New listing'),
    h('div', { class: 'editor' },
      h('form', { class: 'card stack', onsubmit: submit },
        h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', id: 'l-name', value: f.name, maxlength: 60, required: true, oninput: bind('name') })),
        h('div', { class: 'row' },
          h('label', { class: 'field', style: { flex: '1 1 160px' } }, h('span', {}, 'Category'), h('select', { id: 'l-cat', onchange: bind('category') }, CATEGORIES.map((c) => h('option', { value: c.slug, selected: c.slug === f.category }, c.title)))),
          h('label', { class: 'field', style: { flex: '1 1 120px' } }, h('span', {}, 'Price (C$)'), h('input', { type: 'number', id: 'l-price', min: '0.99', step: '0.01', value: f.price, required: true, oninput: bind('price') }))),
        h('label', { class: 'field' }, h('span', {}, 'Description'), h('textarea', { id: 'l-desc', rows: 4, required: true, minlength: 20, oninput: bind('description') }, f.description)),
        h('div', { class: 'field' }, h('span', {}, 'Platforms'), h('div', { class: 'checks' }, PLATFORMS.map((p) => h('label', {},
          h('input', { type: 'checkbox', checked: f.platforms.includes(p), onchange: (e) => { f.platforms = e.target.checked ? [...f.platforms, p] : f.platforms.filter((x) => x !== p); } }), p)))),
        h('div', { class: 'row' },
          h('label', { class: 'field', style: { flex: '1 1 160px' } }, h('span', {}, 'Licence'), h('select', { id: 'l-lic', onchange: bind('licenseType') }, LICENSES.map((l) => h('option', { selected: l === f.licenseType }, l)))),
          h('label', { class: 'field', style: { flex: '1 1 160px' } }, h('span', {}, 'Tags (comma-separated)'), h('input', { type: 'text', id: 'l-tags', value: f.tags, oninput: bind('tags') }))),
        h('label', { class: 'field' }, h('span', {}, 'Features (one per line)'), h('textarea', { id: 'l-feat', rows: 3, oninput: bind('features') }, f.features)),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', id: 'l-pub', checked: f.publish, onchange: bind('publish') }), h('span', {}, 'Publish in the store')),
        h('div', { class: 'row' }, h('button', { class: 'btn primary' }, existing ? 'Save changes' : 'Create listing'),
          existing ? h('button', { type: 'button', class: 'btn danger', onclick: archive }, 'Archive') : null),
        msg),
      preview));
}

export { statusKind };
