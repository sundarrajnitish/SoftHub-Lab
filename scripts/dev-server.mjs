// Local API server: the whole backend in one Node process, seeded with the
// demo marketplace. Same routes as AWS; a few /__local helpers stand in for
// the Cognito hosted sign-in and for Stripe.js in the browser.
//
//   npm run dev:api
//   curl localhost:8787/products?category=games
//   TOKEN=$(curl -s -XPOST localhost:8787/__local/signin -d '{"email":"maya.chen@example.com","password":"Demo-buyer-1"}' | jq -r .accessToken)
//   curl -H "authorization: Bearer $TOKEN" localhost:8787/library

import { createServer } from 'node:http';
import { createLocalRuntime, createShiftClock } from '../packages/core/src/runtime.js';
import { seedMarketplace } from '../packages/core/src/seedrun.js';
import { DEMO_ACCOUNTS } from '../packages/core/src/seed.js';

const port = Number(process.env.PORT || 8787);
const rt = createLocalRuntime({ clock: createShiftClock(), seed: 42 });
await seedMarketplace(rt);
rt.scheduler.setLive(true);
rt.onEvent((e) => {
  if (e.kind === 'request') {
    const t = e.trace;
    console.log(`${t.source.padEnd(15)} ${t.method.padEnd(6)} ${t.path} → ${t.status}  λ ${t.fn || '-'}${t.cold ? ' (cold)' : ''}  ${t.ops.length} table calls  ${Math.round(t.totalMs)} ms modelled`);
  }
  if (e.kind === 'email') console.log(`mail → ${e.mail.to}: ${e.mail.subject}`);
});

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (url.pathname === '/__local/signin') return json(res, 200, await rt.signIn(...Object.values(JSON.parse(body))));
    if (url.pathname === '/__local/pay') { const b = JSON.parse(body); return json(res, 200, await rt.pay(b.clientSecret, b.card)); }
    if (url.pathname === '/__local/mail') return json(res, 200, rt.mailer.all().slice(-20));
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
    const r = await rt.request({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body || undefined, token });
    json(res, r.status, r.data);
  } catch (e) {
    json(res, e.status || 500, { error: { message: e.message } });
  }
}).listen(port, () => {
  console.log(`SoftHub local API on http://localhost:${port}`);
  for (const [role, a] of Object.entries(DEMO_ACCOUNTS)) console.log(`  ${role.padEnd(9)} ${a.email} / ${a.password}`);
});
