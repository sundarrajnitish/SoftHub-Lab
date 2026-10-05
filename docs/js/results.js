// Findings tables and the headline numbers, straight from sim/run.mjs.
import { h, $, mount, int } from './ui.js';

export function initResults(R) {
  const deliveries = R.chaos.reduce((a, c) => a + c.deliveries, 0);
  $('#st-dupes').textContent = int(deliveries);
  $('#st-cost').textContent = `$${R.launchDay.cost.perMonthUsd.toFixed(2)}`;
  $('#st-cold').textContent = `${(R.launchDay.coldStartRate * 100).toFixed(1)} %`;
  $('#st-sent').textContent = `${(R.sentiment.test.accuracy * 100).toFixed(1)} %`;

  mount($('#chaos-table'),
    h('caption', { class: 'label', style: { textAlign: 'left', paddingBottom: '8px' } }, 'Fulfilment under webhook chaos (about 200 orders per run, full audit after each)'),
    h('thead', {}, h('tr', {}, ['Scenario', 'Deliveries', 'Duplicates absorbed', 'Failed attempts (retried)', 'Paid orders', 'Licences', 'Receipts', 'Seconds to licence p50 / p95', 'Audit'].map((x) => h('th', {}, x)))),
    h('tbody', {}, R.chaos.map((c) => h('tr', {},
      h('td', {}, c.level), h('td', { class: 'n' }, int(c.deliveries)), h('td', { class: 'n' }, int(c.duplicatesAbsorbed)), h('td', { class: 'n' }, int(c.failedAttempts)),
      h('td', { class: 'n' }, int(c.paidOrders)), h('td', { class: 'n' }, int(c.licences)), h('td', { class: 'n' }, int(c.receipts)),
      h('td', { class: 'n' }, `${c.secondsToLicence.p50} / ${c.secondsToLicence.p95}`),
      h('td', {}, c.auditPassed ? `✓ ${c.checks}/${c.checks} checks` : `✗ ${c.failedChecks.join(', ')}`)))));

  const fns = R.launchDay.functions;
  mount($('#fn-table'),
    h('caption', { class: 'label', style: { textAlign: 'left', paddingBottom: '8px' } }, `Launch day: ${int(R.launchDay.sessions)} sessions, ${int(R.launchDay.requests)} requests, ${int(R.launchDay.orders)} orders (modelled latency)`),
    h('thead', {}, h('tr', {}, ['Function', 'Requests', 'Cold starts', 'p50', 'p95', 'p99'].map((x) => h('th', {}, x)))),
    h('tbody', {}, Object.entries(fns).sort((a, b) => b[1].requests - a[1].requests).map(([fn, f]) => h('tr', {},
      h('td', {}, fn === 'gateway' ? 'rejected at gateway' : `λ ${fn}`), h('td', { class: 'n' }, int(f.requests)), h('td', { class: 'n' }, `${int(f.coldStarts)} (${(f.coldRate * 100).toFixed(1)} %)`),
      h('td', { class: 'n' }, `${f.p50} ms`), h('td', { class: 'n' }, `${f.p95} ms`), h('td', { class: 'n' }, `${f.p99} ms`)))));

  const rec = R.recommender.hitRateAt5;
  const shipped = Object.entries(rec).find(([k]) => k.includes('shipped'))[1];
  const rows = [
    ['Exactly-once fulfilment', `${int(deliveries)} deliveries across five chaos levels, ${int(R.chaos.reduce((a, c) => a + c.duplicatesAbsorbed, 0))} of them duplicates and ${int(R.chaos.reduce((a, c) => a + c.failedAttempts, 0))} failed first attempts: every order paid once, one licence per line, one receipt per order.`, 'Event id recorded in the same DynamoDB transaction as the effect, guarded by the order state.'],
    ['Payment to licence', `p50 ${R.chaos[0].secondsToLicence.p50} s calm; p95 ${R.chaos.at(-1).secondsToLicence.p95} s in the storm (retries back off 5 s, 30 s, 2 min…).`, 'Licences come only from the signed webhook; the browser never grants anything.'],
    ['Latency', `Catalogue p50 ${fns.catalog.p50} ms, checkout path p95 ${fns.shop.p95} ms (includes the Stripe call).`, 'Modelled DynamoDB and Stripe latencies; every read is a key lookup or one-partition query.'],
    ['Cold starts', `${(R.launchDay.coldStartRate * 100).toFixed(1)} % of launch-day requests. In the sweep, most calls are cold at a few requests an hour and almost none from about one a minute.`, 'Read-heavy routes live in their own function, so checkout warmth does not depend on browsing.'],
    ['Cost', `US$${R.launchDay.cost.perDayUsd.toFixed(3)} per day of AWS for ${int(R.launchDay.orders)} orders (about US$${R.launchDay.cost.infraPerOrderUsd.toFixed(5)} per order), against C$${int(R.launchDay.cost.stripeFeesCad)} of card fees.`, 'On-demand everything; no idle servers.'],
    ['Sentiment', `${(R.sentiment.test.accuracy * 100).toFixed(1)} % accuracy on ${R.sentiment.test.n} held-out reviews (baseline ${(R.sentiment.test.majorityBaseline * 100).toFixed(1)} %).`, 'Lexicon + rules, sub-millisecond, explainable.'],
    ['Recommendations', `Hit rate @ 5: ${(shipped * 100).toFixed(1)} % for content + co-purchase, ${(rec['content only'] * 100).toFixed(1)} % content only, ${(rec['co-purchase only'] * 100).toFixed(1)} % co-purchase only, ${(rec.popularity * 100).toFixed(1)} % popularity, ${(rec.random * 100).toFixed(1)} % random.`, 'Counters maintained at fulfilment; no batch job.'],
  ];
  mount($('#findings'),
    h('caption', { class: 'label', style: { textAlign: 'left', paddingBottom: '8px' } }, 'Summary'),
    h('thead', {}, h('tr', {}, ['Question', 'Result', 'Mechanism'].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map(([a, b, c]) => h('tr', {}, h('td', {}, h('b', {}, a)), h('td', {}, b), h('td', { class: 'muted' }, c)))));

  const decisions = [
    ['Prices come from the catalogue at checkout', 'The client sends no amount; the order snapshots line prices, so later price edits never touch an open order.'],
    ['Licences are issued by the signed webhook', 'Closing the tab, a lost network response or a forged "payment succeeded" from the browser cannot grant or lose a licence.'],
    ['Idempotency keys on checkout', 'A double click or a retry returns the same order and PaymentIntent, never a second charge.'],
    ['One transaction per fulfilment', 'Order status, licences, ownership, cart, counters, sales ledger and the e-mail outbox commit together or not at all (≤ 100 items, hence the 15-item cart).'],
    ['Outbox + table stream for e-mail', 'The receipt is sent if and only if the order is paid, and retried by the stream on failure.'],
    ['Roles are Cognito groups set server-side', 'Sign-up can request Consumer or Provider only; Admin is granted by hand. Suspension is checked on every call.'],
    ['One table, keys from access patterns', 'Every page is one GetItem or Query; GSI1 serves categories, user orders and e-mail lookup, GSI2 provider listings.'],
    ['Optimistic locking on listings', 'Two editors cannot silently overwrite each other; the second save gets 409.'],
    ['Archive instead of delete', 'Buyers keep licences and order history when a listing is withdrawn.'],
    ['Presigned S3 URLs for files', 'Installers and images never pass through Lambda; download links expire after 5 minutes and need an active licence.'],
    ['Deterministic licence keys', 'HMAC of order, product and buyer: a retried fulfilment yields the same key, and a typo is caught by the checksum before any network call.'],
    ['Template generated from routes', 'infra/template.yaml is produced from the route table and checked in CI.'],
  ];
  mount($('#decisions'),
    h('caption', { class: 'label', style: { textAlign: 'left', paddingBottom: '8px' } }, 'Design decisions'),
    h('thead', {}, h('tr', {}, h('th', {}, 'Decision'), h('th', {}, 'Why'))),
    h('tbody', {}, decisions.map(([a, b]) => h('tr', {}, h('td', {}, h('b', {}, a)), h('td', {}, b)))));
}
