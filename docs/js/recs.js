// Lab 6: recommendations decomposed into content and co-purchase parts.
import { h, $, mount, art, money } from './ui.js';
import { relatedProducts, BETA } from './core/recommend.js';
import { loadCatalogue, togetherCounts } from './core/api/catalog.js';
import { hbars } from './charts.js';

let app, catalogue = [], together = new Map();
const lib = new Set();

export function initRecs(a, R) {
  app = a;
  evalChart(R);
  load();
  app.on('rt:request', (e) => { if (e.trace.source === 'stripe' && e.trace.response?.fulfilled) { clearTimeout(load.t); load.t = setTimeout(load, 800); } });
}

async function load() {
  const deps = { ...app.rt.deps, cache: {} };
  catalogue = (await loadCatalogue(deps, { fresh: true })).sort((x, y) => (x.category + x.name).localeCompare(y.category + y.name));
  together = new Map();
  for (const p of catalogue) together.set(p.productId, await togetherCounts(deps, p.productId));
  if (!lib.size) for (const n of ['Lumen Cut Pro', 'Quillwork Notes']) { const p = catalogue.find((x) => x.name === n); if (p) lib.add(p.productId); }
  chips();
  recommend();
  heat();
}

function chips() {
  mount($('#lib'), catalogue.map((p) => h('button', { 'aria-pressed': String(lib.has(p.productId)), onclick: () => { lib.has(p.productId) ? lib.delete(p.productId) : lib.add(p.productId); chips(); recommend(); } }, p.name)));
}

function recommend() {
  const owned = catalogue.filter((p) => lib.has(p.productId));
  const acc = new Map();
  for (const p of owned) {
    for (const r of relatedProducts(p, catalogue, together.get(p.productId) || new Map(), { exclude: lib, limit: catalogue.length })) {
      const cur = acc.get(r.productId) || { content: 0, co: 0, reasons: [] };
      cur.content += r.content; cur.co += BETA * r.cos;
      if (r.together >= 2) cur.reasons.push(`${r.together} own it and ${p.name}`);
      acc.set(r.productId, cur);
    }
  }
  const byId = new Map(catalogue.map((p) => [p.productId, p]));
  const top = [...acc.entries()].map(([id, v]) => ({ p: byId.get(id), ...v, score: v.content + v.co })).sort((a, b) => b.score - a.score).slice(0, 6);
  const max = Math.max(0.01, ...top.map((t) => t.score));
  mount($('#rec-out'), owned.length ? top.map((t) => h('div', { class: 'rec' }, art(t.p.image, 34),
    h('div', {}, h('b', { class: 'small' }, t.p.name), h('span', { class: 'small muted' }, ` · ${t.p.category.replace('-', ' ')} · ${money(t.p.priceCents)}`),
      h('div', { class: 'stack-bar', style: { marginTop: '4px', width: `${(t.score / max) * 100}%` } },
        h('i', { class: 'c', style: { width: `${(t.content / t.score) * 100}%` } }), h('i', { class: 'p', style: { width: `${(t.co / t.score) * 100}%` } })),
      h('span', { class: 'small muted' }, t.reasons[0] || 'similar tags and category')),
    h('span', { class: 'small num', style: { textAlign: 'right' } }, `${t.content.toFixed(2)} + ${t.co.toFixed(2)}`)))
    : h('p', { class: 'empty' }, 'Pick at least one product. With an empty library the store falls back to popular, well-rated products.'));
}

function heat() {
  const cv = $('#heat');
  const n = catalogue.length;
  const g = cv.getContext('2d');
  const cell = Math.floor(cv.width / n);
  const vals = [];
  let max = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = catalogue[i], b = catalogue[j];
    const t = i === j ? 0 : together.get(a.productId)?.get(b.productId) || 0;
    const c = t && a.buyers && b.buyers ? t / Math.sqrt(a.buyers * b.buyers) : 0;
    vals.push(c); max = Math.max(max, c);
  }
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e2560a';
  const base = getComputedStyle(document.documentElement).getPropertyValue('--panel-2').trim() || '#eee';
  g.clearRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = vals[i * n + j] / (max || 1);
    g.fillStyle = base; g.globalAlpha = 1; g.fillRect(j * cell, i * cell, cell - 1, cell - 1);
    g.fillStyle = accent; g.globalAlpha = v; g.fillRect(j * cell, i * cell, cell - 1, cell - 1);
  }
  g.globalAlpha = 1;
  cv.onmousemove = (e) => {
    const r = cv.getBoundingClientRect();
    const j = Math.floor(((e.clientX - r.left) / r.width) * cv.width / cell), i = Math.floor(((e.clientY - r.top) / r.height) * cv.height / cell);
    if (i < 0 || j < 0 || i >= n || j >= n) return;
    $('#heat-note').textContent = `${catalogue[i].name} × ${catalogue[j].name}: cosine ${vals[i * n + j].toFixed(2)} (${together.get(catalogue[i].productId)?.get(catalogue[j].productId) || 0} buyers own both). Rows and columns are grouped by category.`;
  };
}

function evalChart(R) {
  const rec = R.recommender;
  const rows = Object.entries(rec.hitRateAt5).map(([label, value]) => ({ label, value, cls: label.includes('shipped') ? 'alt' : label === 'random' ? 'dim' : '' }));
  hbars($('#ch-recs'), { rows, max: Math.max(...rows.map((r) => r.value)) * 1.15, fmt: (v) => `${(v * 100).toFixed(1)} %` });
  $('#rec-blurb').textContent = `${rec.users} simulated shoppers on fresh seeds; hide each one's last purchase and ask for 5 products`;
}
