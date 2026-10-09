// Hero: the architecture as a live diagram. Every request the in-page backend
// serves sends a packet along the wires it actually used.
import { s, $ } from './ui.js';

const N = {
  cognito: { x: 16, y: 34, w: 118, h: 44, t: 'Cognito', sub: 'user pool' },
  browser: { x: 16, y: 150, w: 118, h: 58, t: 'Your browser', sub: 'React storefront' },
  s3: { x: 172, y: 34, w: 124, h: 44, t: 'S3', sub: 'presigned URLs' },
  apigw: { x: 172, y: 150, w: 124, h: 58, t: 'API Gateway', sub: 'HTTP API · JWT' },
  stripe: { x: 172, y: 296, w: 124, h: 50, t: 'Stripe', sub: 'cards · webhooks', ext: true },
  catalog: { x: 336, y: 24, w: 118, h: 40, t: 'λ catalog', sub: 'public reads' },
  shop: { x: 336, y: 82, w: 118, h: 40, t: 'λ shop', sub: 'cart · checkout' },
  provider: { x: 336, y: 140, w: 118, h: 40, t: 'λ provider', sub: 'listings · sales' },
  admin: { x: 336, y: 198, w: 118, h: 40, t: 'λ admin', sub: 'accounts' },
  webhook: { x: 336, y: 256, w: 118, h: 40, t: 'λ webhook', sub: 'fulfilment' },
  ddb: { x: 498, y: 118, w: 126, h: 74, t: 'DynamoDB', sub: 'one table · 2 GSIs' },
  mailer: { x: 498, y: 238, w: 126, h: 40, t: 'λ mailer', sub: 'stream consumer' },
  ses: { x: 498, y: 300, w: 126, h: 40, t: 'SES', sub: 'receipts · codes' },
};
const R = (n) => ({ l: [n.x, n.y + n.h / 2], r: [n.x + n.w, n.y + n.h / 2], t: [n.x + n.w / 2, n.y], b: [n.x + n.w / 2, n.y + n.h] });
const curve = ([x1, y1], [x2, y2]) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;

const W = {};
function wires() {
  const p = Object.fromEntries(Object.entries(N).map(([k, n]) => [k, R(n)]));
  W['browser-apigw'] = `M${p.browser.r[0]},${p.browser.r[1]} L${p.apigw.l[0]},${p.apigw.l[1]}`;
  for (const fn of ['catalog', 'shop', 'provider', 'admin', 'webhook']) {
    W[`apigw-${fn}`] = curve(p.apigw.r, p[fn].l);
    W[`${fn}-ddb`] = curve(p[fn].r, p.ddb.l);
  }
  W['browser-cognito'] = `M${p.browser.t[0]},${p.browser.t[1]} L${p.cognito.b[0]},${p.cognito.b[1]}`;
  W['browser-s3'] = curve([p.browser.r[0], p.browser.r[1] - 18], [p.s3.l[0], p.s3.l[1]]);
  W['browser-stripe'] = `M${p.browser.b[0] + 20},${p.browser.b[1]} L${p.browser.b[0] + 20},${p.stripe.l[1]} L${p.stripe.l[0]},${p.stripe.l[1]}`;
  W['stripe-apigw'] = `M${p.stripe.t[0]},${p.stripe.t[1]} L${p.apigw.b[0]},${p.apigw.b[1]}`;
  W['lambda-stripe'] = curve([N.webhook.x, N.webhook.y + 30], [p.stripe.r[0], p.stripe.r[1]]);
  W['ddb-mailer'] = `M${p.ddb.b[0]},${p.ddb.b[1]} L${p.mailer.t[0]},${p.mailer.t[1]}`;
  W['mailer-ses'] = `M${p.mailer.b[0]},${p.mailer.b[1]} L${p.ses.t[0]},${p.ses.t[1]}`;
  W['ses-browser'] = `M${p.ses.b[0]},${p.ses.b[1]} L${p.ses.b[0]},368 L40,368 L40,${p.browser.b[1]}`;
}

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let svg, layer;
let nodeEls = {}, wireEls = {};

/** Draw the architecture into an <svg>; returns the node and wire elements. */
export function drawDiagram(target) {
  if (!Object.keys(W).length) wires();
  const nodes = {}, ws = {};
  const g = [];
  for (const [id, d] of Object.entries(W)) g.push(ws[id] = s('path', { class: 'wire', d }));
  for (const [id, n] of Object.entries(N)) {
    g.push(nodes[id] = s('g', { class: `node${n.ext ? ' ext' : ''}` },
      s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 9 }),
      s('text', { x: n.x + 10, y: n.y + (n.h > 44 ? 24 : 18) }, n.t),
      s('text', { class: 'sub', x: n.x + 10, y: n.y + (n.h > 44 ? 40 : 32) }, n.sub)));
  }
  const lay = s('g', {});
  g.push(lay);
  target.replaceChildren(...g);
  return { nodes, wires: ws, layer: lay };
}

function draw() {
  const d = drawDiagram(svg);
  nodeEls = d.nodes; wireEls = d.wires; layer = d.layer;
}

function pulse(id) {
  const el = nodeEls[id];
  if (!el) return;
  el.classList.add('hot');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('hot'), 650);
}

const queue = [];
let running = 0;
let travel = function travel(route, cls = '') {
  if (reduce) { for (const [w] of route) { const [a, b] = w.split('-'); pulse(a); pulse(b); } return; }
  if (running > 6) { queue.push([route, cls]); if (queue.length > 12) queue.shift(); return; }
  running++;
  const dot = s('circle', { r: 4.2, class: `packet ${cls}` });
  layer.append(dot);
  let i = 0;
  const step = () => {
    if (i >= route.length) { dot.remove(); running--; if (queue.length) travel(...queue.shift()); return; }
    const [wid, reverse] = route[i];
    const path = wireEls[wid];
    if (!path) { i++; step(); return; }
    const len = path.getTotalLength();
    const dur = Math.max(260, Math.min(700, len * 2.4));
    const [a, b] = wid.split('-');
    pulse(reverse ? b : a);
    path.classList.add('hot');
    const t0 = performance.now();
    const frame = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const pt = path.getPointAtLength((reverse ? 1 - k : k) * len);
      dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
      if (k < 1) requestAnimationFrame(frame);
      else { path.classList.remove('hot'); pulse(reverse ? a : b); i++; step(); }
    };
    requestAnimationFrame(frame);
  };
  step();
}

export function initDiagram(app) {
  svg = $('#arch');
  draw();
  // animate only while the drawer is open
  const travelReal = travel;
  // eslint-disable-next-line no-func-assign
  travel = (route, cls) => { if (app.scenesOpen) travelReal(route, cls); };
  app.on('rt:request', ({ trace }) => {
    const fn = trace.fn;
    if (trace.source === 'dynamodb-stream') {
      travel([['ddb-mailer'], ['mailer-ses'], ['ses-browser']], 'stream');
      return;
    }
    const start = trace.source === 'stripe' ? [['stripe-apigw']] : [['browser-apigw']];
    if (trace.gateway) {
      travel(start, 'err');
      return;
    }
    const route = [...start, [`apigw-${fn}`]];
    if (trace.ops.length) route.push([`${fn}-ddb`]);
    if (trace.stripe.length) route.push(['lambda-stripe']);
    travel(route, trace.source === 'stripe' ? 'stripe' : trace.status >= 400 ? 'err' : '');
  });
  app.on('rt:stripe', ({ rec }) => {
    if (rec.kind === 'api' && /confirm|3-D/.test(rec.call)) travel([['browser-stripe']], 'stripe');
  });
  app.on('auth', () => travel([['browser-cognito']]));
  app.on('download', () => travel([['browser-s3']]));
}
