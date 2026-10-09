// Small DOM and formatting helpers shared by the labs.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(tag === 'svg' || attrs.svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false || k === 'svg') continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function mount(el, ...children) { el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)); return el; }

export const money = (cents) => `C$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const int = (n) => Math.round(n).toLocaleString('en-CA');
export const pct = (x, d = 0) => `${(x * 100).toFixed(d)} %`;
export const ms = (x) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x < 10 ? x.toFixed(1) : Math.round(x)} ms`);

const GLYPHS = [
  'M8 20 L16 6 L24 20 Z', 'M6 13 h20 v6 h-20 Z', 'M16 5 a11 11 0 1 0 0.01 0 Z', 'M7 7 h18 v18 h-18 Z M12 12 h8 v8 h-8 Z',
  'M5 22 L12 10 L17 17 L21 12 L27 22 Z', 'M16 5 L27 16 L16 27 L5 16 Z', 'M6 9 h20 M6 16 h20 M6 23 h20', 'M9 6 v20 M16 6 v20 M23 6 v20',
];
let artSeq = 0;
/** Generated product artwork — every product's art is derived from its name. */
export function art(image, size = 38) {
  const img = image || { hue: 20, hue2: 200, glyph: 0, monogram: '?' };
  const id = `ga${++artSeq}`;
  return s('svg', { class: 'art', viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true' },
    s('defs', {}, s('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 },
      s('stop', { offset: 0, 'stop-color': `hsl(${img.hue} 68% 52%)` }),
      s('stop', { offset: 1, 'stop-color': `hsl(${img.hue2} 60% 30%)` }))),
    s('rect', { width: 32, height: 32, rx: 7, fill: `url(#${id})` }),
    s('path', { d: GLYPHS[img.glyph % GLYPHS.length], fill: 'none', stroke: 'rgba(255,255,255,.38)', 'stroke-width': 1.4 }),
    s('text', { x: 16, y: 19.5, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#fff', 'font-family': 'system-ui, sans-serif' }, img.monogram));
}

export function stars(v) {
  if (v === null || v === undefined) return h('span', { class: 'small muted' }, 'no ratings');
  const n = Math.round(v);
  return h('span', { class: 'stars', title: `${v} of 5` }, '★'.repeat(n), h('span', { style: { opacity: 0.25 } }, '★'.repeat(5 - n)), h('span', { class: 'small muted' }, ` ${v.toFixed(1)}`));
}

export function chip(text, kind = '') { return h('span', { class: `chip ${kind}` }, text); }

export function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

export const statusKind = (st) => ({ PAID: 'good', PENDING_PAYMENT: 'warn', CANCELLED: 'bad', REFUNDED: 'bad', PARTIALLY_REFUNDED: 'warn', ACTIVE: 'good', SUSPENDED: 'bad', PUBLISHED: 'good', DRAFT: 'warn' }[st] || '');

let coverSeq = 0;
/** Wide product cover (16:10), generated from the product's name. */
export function cover(image, name = '') {
  const img = image || { hue: 20, hue2: 200, glyph: 0, monogram: '?' };
  const id = `cv${++coverSeq}`;
  const g = GLYPHS[img.glyph % GLYPHS.length];
  const tiles = [];
  for (let i = 0; i < 5; i++) {
    tiles.push(s('path', { d: g, fill: 'none', stroke: 'rgba(255,255,255,.16)', 'stroke-width': 1.1, transform: `translate(${88 + i * 26 - (i % 2) * 8},${-6 + i * 14}) scale(${1.6 + i * 0.35}) rotate(${i * 9} 16 16)` }));
  }
  return s('svg', { class: 'cover', viewBox: '0 0 320 200', role: 'img', 'aria-label': name, preserveAspectRatio: 'xMidYMid slice' },
    s('defs', {}, s('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 },
      s('stop', { offset: 0, 'stop-color': `hsl(${img.hue} 66% 54%)` }),
      s('stop', { offset: 1, 'stop-color': `hsl(${img.hue2} 58% 28%)` }))),
    s('rect', { width: 320, height: 200, fill: `url(#${id})` }),
    ...tiles,
    s('text', { x: 22, y: 168, 'font-size': 54, 'font-weight': 800, fill: 'rgba(255,255,255,.95)', 'font-family': 'Bricolage Grotesque, system-ui, sans-serif', 'letter-spacing': -2 }, img.monogram),
    s('text', { x: 24, y: 36, 'font-size': 13, 'font-weight': 600, fill: 'rgba(255,255,255,.8)', 'font-family': 'Instrument Sans, system-ui, sans-serif' }, name.length > 30 ? `${name.slice(0, 29)}…` : name));
}

export function avatar(label, hue = 210) {
  const initials = label.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  return h('span', { class: 'avatar', style: { background: `hsl(${hue} 55% 45%)` } }, initials);
}

export function icon(name, size = 16) {
  const P = {
    check: 'M5 12l5 5 9-11', copy: 'M9 9h10v10H9z M5 15V5h10', down: 'M12 4v12m-5-5 5 5 5-5 M5 20h14',
    bolt: 'M13 3 5 14h6l-1 7 8-11h-6z', card: 'M3 6h18v12H3z M3 10h18', mail: 'M3 5h18v14H3z M3 7l9 6 9-6',
    key: 'M15 7a4 4 0 1 1-3.9 5H7v3H5v-3H3v-2h8.1A4 4 0 0 1 15 7z', store: 'M4 9h16l-1-5H5z M5 9v11h14V9',
  };
  return s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, s('path', { d: P[name] }));
}
