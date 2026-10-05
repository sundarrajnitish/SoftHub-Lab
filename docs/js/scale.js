// Lab 7: launch-day charts, cold-start curve and a cost calculator.
import { $, mount, h, int } from './ui.js';
import { barChart, logLine, hbars } from './charts.js';

export function initScale(R) {
  const d = R.launchDay;
  barChart($('#ch-day'), {
    labels: d.hourly.map((x) => `${x.hour}h`), values: d.hourly.map((x) => x.requests), line: d.hourly.map((x) => x.p95), xEvery: 3,
    lineFmt: (v) => `${Math.round(v)}`,
  });
  logLine($('#ch-cold'), {
    points: R.coldStarts.map((c) => ({ x: c.perSecond, y: c.coldRate, note: `p95 ${c.p95} ms` })),
    xLabel: (x) => (x >= 1 ? `${x}/s` : x >= 1 / 60 ? `${+(x * 60).toFixed(1)}/min` : `${+(x * 3600).toFixed(1)}/h`),
  });
  const sess = $('#s-sess'), aov = $('#s-aov');
  const update = () => calc(R, +sess.value, +aov.value);
  sess.addEventListener('input', update);
  aov.addEventListener('input', update);
  update();
}

function calc(R, sessions, aovDollars) {
  const d = R.launchDay;
  const k = sessions / d.sessions;
  const day = d.cost.breakdownPerDay;
  const ordersPerDay = (d.orders / d.sessions) * sessions;
  const month = { Lambda: day.lambda * k * 30, 'API Gateway': day.api * k * 30, DynamoDB: day.ddb * k * 30, SES: day.ses * k * 30 };
  const infra = Object.values(month).reduce((a, b) => a + b, 0);
  const gmv = ordersPerDay * 30 * aovDollars;
  const stripe = ordersPerDay * 30 * (aovDollars * (R.prices.stripePercent / 100) + R.prices.stripeFixedCents / 100);
  $('#v-sess').textContent = int(sessions);
  $('#v-aov').textContent = `C$${aovDollars}`;
  mount($('#cost-kv'),
    h('dt', {}, 'orders / month'), h('dd', {}, int(ordersPerDay * 30)),
    h('dt', {}, 'requests / month'), h('dd', {}, int((d.requests / d.sessions) * sessions * 30)),
    h('dt', {}, 'AWS / month'), h('dd', {}, `US$${infra.toFixed(2)}`),
    h('dt', {}, 'AWS per order'), h('dd', {}, `US$${(infra / Math.max(1, ordersPerDay * 30)).toFixed(5)}`),
    h('dt', {}, 'card fees / month'), h('dd', {}, `C$${int(stripe)}`),
    h('dt', {}, 'gross sales / month'), h('dd', {}, `C$${int(gmv)}`));
  $('#cost-kv').className = 'kv';
  hbars($('#ch-cost'), {
    rows: [...Object.entries(month).map(([label, value]) => ({ label: `${label} (AWS)`, value })), { label: 'Card processing (Stripe)', value: stripe, cls: 'alt' }],
    fmt: (v) => (v >= 100 ? `$${int(v)}` : `$${v.toFixed(2)}`),
  });
  $('#cost-note').textContent = `At this volume card fees are ${int(stripe / Math.max(0.01, infra))}× the whole AWS bill. Serverless keeps idle cost near zero; the costs that matter are per transaction. AWS figures scale the measured launch day linearly (US list prices, October 2026, free tier ignored); card fees use Stripe Canada's 2.9 % + C$0.30 (the ratio ignores the CAD–USD difference).`;
}
