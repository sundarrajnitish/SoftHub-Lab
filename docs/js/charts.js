// Minimal SVG charts drawn to one scale, colours from the theme tokens.
import { s } from './ui.js';

const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
// tick count that keeps every step a round number
const ticksFor = (max) => { const m = max / 10 ** Math.floor(Math.log10(max)); return Math.abs(m - 2) < 1e-9 ? 4 : 5; };
const fmt = (v) => (Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(v < 1 && v !== 0 ? 2 : 0)}`);

/**
 * Vertical bars with optional second series drawn as a line on a right axis.
 * opts: {w, h, labels, values, line, lineLabel, xEvery, valueFmt, lineFmt, classes}
 */
export function barChart(svg, { w = svg.clientWidth || 640, h = 220, labels, values, line = null, xEvery = 1, valueFmt = fmt, lineFmt = fmt, classes = [] }) {
  const m = { l: 40, r: line ? 44 : 10, t: 12, b: 26 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const ymax = niceMax(Math.max(...values));
  const y = (v) => m.t + ih - (v / ymax) * ih;
  const bw = iw / values.length;
  const g = [];
  const nt = ticksFor(ymax);
  for (let i = 0; i <= nt; i++) {
    const v = (ymax / nt) * i;
    g.push(s('line', { class: 'grid', x1: m.l, x2: w - m.r, y1: y(v), y2: y(v) }), s('text', { x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, valueFmt(v)));
  }
  values.forEach((v, i) => {
    g.push(s('rect', { class: `bar-m ${classes[i] || ''}`, x: m.l + i * bw + bw * 0.14, y: y(v), width: bw * 0.72, height: Math.max(0, m.t + ih - y(v)), rx: 1.5 }, s('title', {}, `${labels[i]}: ${valueFmt(v)}`)));
    if (i % xEvery === 0) g.push(s('text', { x: m.l + i * bw + bw / 2, y: h - 8, 'text-anchor': 'middle' }, labels[i]));
  });
  if (line) {
    const lmax = niceMax(Math.max(...line));
    const ly = (v) => m.t + ih - (v / lmax) * ih;
    const pts = line.map((v, i) => `${m.l + i * bw + bw / 2},${ly(v)}`).join(' ');
    g.push(s('polyline', { class: 'ln alt', points: pts }));
    line.forEach((v, i) => g.push(s('circle', { class: 'dot', cx: m.l + i * bw + bw / 2, cy: ly(v), r: 2.4 }, s('title', {}, `${labels[i]}: ${lineFmt(v)}`))));
    const lt = ticksFor(lmax);
    for (let i = 0; i <= lt; i++) g.push(s('text', { x: w - m.r + 6, y: ly((lmax / lt) * i) + 3 }, lineFmt((lmax / lt) * i)));
  }
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.replaceChildren(...g);
}

/** Line chart on a log-x axis. points: [{x, y}] with y in 0..1 (share). */
export function logLine(svg, { w = svg.clientWidth || 640, h = 220, points, xLabel = (x) => x, yFmt = (v) => `${Math.round(v * 100)} %`, ymax = 1, second = null }) {
  const m = { l: 44, r: 12, t: 12, b: 30 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const lx = points.map((p) => Math.log10(p.x));
  const x0 = Math.min(...lx), x1 = Math.max(...lx);
  const x = (v) => m.l + ((Math.log10(v) - x0) / (x1 - x0)) * iw;
  const y = (v) => m.t + ih - (v / ymax) * ih;
  const g = [];
  for (let i = 0; i <= 4; i++) g.push(s('line', { class: 'grid', x1: m.l, x2: w - m.r, y1: y((ymax / 4) * i), y2: y((ymax / 4) * i) }), s('text', { x: m.l - 6, y: y((ymax / 4) * i) + 3, 'text-anchor': 'end' }, yFmt((ymax / 4) * i)));
  for (let e = Math.ceil(x0); e <= Math.floor(x1); e++) g.push(s('line', { class: 'grid', x1: x(10 ** e), x2: x(10 ** e), y1: m.t, y2: m.t + ih }), s('text', { x: x(10 ** e), y: h - 10, 'text-anchor': 'middle' }, xLabel(10 ** e)));
  const pts = points.map((p) => `${x(p.x)},${y(p.y)}`).join(' ');
  g.push(s('polygon', { class: 'area', points: `${x(points[0].x)},${y(0)} ${pts} ${x(points.at(-1).x)},${y(0)}` }), s('polyline', { class: 'ln', points: pts }));
  points.forEach((p) => g.push(s('circle', { class: 'dot', cx: x(p.x), cy: y(p.y), r: 2.6 }, s('title', {}, `${xLabel(p.x)}: ${yFmt(p.y)}${p.note ? ` · ${p.note}` : ''}`))));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.replaceChildren(...g);
}

/** Horizontal bars, one per row. rows: [{label, value, cls}] */
export function hbars(svg, { w = svg.clientWidth || 640, rows, max = null, fmt: f = (v) => v, rowH = 26 }) {
  const m = { l: Math.min(230, w * 0.42), r: 64, t: 6, b: 6 };
  const h = m.t + m.b + rows.length * rowH;
  const vmax = max ?? Math.max(...rows.map((r) => r.value));
  const iw = w - m.l - m.r;
  const g = [];
  rows.forEach((r, i) => {
    const yy = m.t + i * rowH;
    g.push(
      s('text', { x: m.l - 8, y: yy + rowH / 2 + 3, 'text-anchor': 'end', style: 'font-size:11px' }, r.label),
      s('rect', { class: 'grid', x: m.l, y: yy + 5, width: iw, height: rowH - 10, rx: 3, fill: 'none' }),
      s('rect', { class: `bar-m ${r.cls || ''}`, x: m.l, y: yy + 5, width: Math.max(1, (r.value / vmax) * iw), height: rowH - 10, rx: 3 }),
      s('text', { x: m.l + (r.value / vmax) * iw + 6, y: yy + rowH / 2 + 3, style: 'font-size:11px' }, f(r.value)),
    );
  });
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.replaceChildren(...g);
}
