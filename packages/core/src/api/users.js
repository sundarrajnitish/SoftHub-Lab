// Profiles, the post-confirmation trigger, and admin tools.

import { K } from '../keys.js';
import { validate } from '../validate.js';
import { AppError, badRequest, forbidden, notFound, isoDay } from '../util.js';
import { Response } from './router.js';

/** Cognito post-confirmation trigger: create the profile row (idempotent). */
export async function onUserConfirmed(deps, { sub, email, group }) {
  const now = deps.clock.now();
  try {
    await deps.table.transact([
      { put: { item: {
        ...K.profile(sub), type: 'Profile', sub, email: email.toLowerCase(), role: group, status: 'ACTIVE', createdAt: now,
        GSI1PK: `EMAIL#${email.toLowerCase()}`, GSI1SK: 'USER',
      }, condition: { exists: false } } },
      { update: { key: K.platformDay(isoDay(now)), set: { type: 'PlatformDay', day: isoDay(now) }, add: { signups: 1 } } },
    ]);
  } catch (e) {
    if (e.code !== 'store.condition_failed') throw e; // retried trigger: profile already there
  }
}

const SUSPENSION_CACHE_MS = 30_000;

/**
 * Called by the router for every authenticated route. A suspended account is
 * refused even while its token is still valid (cached for 30 s per container).
 */
export async function checkNotSuspended(deps, principal, log) {
  const cache = (deps.cache.status ||= new Map());
  const hit = cache.get(principal.sub);
  const now = deps.clock.now();
  let status = hit && now - hit.at < SUSPENSION_CACHE_MS ? hit.status : null;
  if (!status) {
    const p = await deps.table.get(K.profile(principal.sub));
    status = p?.status || 'ACTIVE';
    cache.set(principal.sub, { status, at: now });
  } else if (log) log('profile.cached', { status });
  if (status === 'SUSPENDED') throw forbidden('account.suspended', 'This account is suspended');
}

export async function me(ctx) {
  const p = await ctx.deps.table.get(K.profile(ctx.principal.sub));
  return { sub: ctx.principal.sub, email: p?.email || null, groups: ctx.principal.groups, status: p?.status || 'ACTIVE', since: p?.createdAt || null };
}

export async function findUser(ctx) {
  const q = validate({ email: { type: 'string', min: 3, max: 254 } }, ctx.query);
  const page = await ctx.deps.table.query({ index: 'GSI1', pk: `EMAIL#${q.email.toLowerCase()}`, limit: 1 });
  const p = page.items[0];
  if (!p) throw notFound('User');
  return { sub: p.sub, email: p.email, role: p.role, status: p.status, createdAt: p.createdAt, statusReason: p.statusReason || null };
}

export async function setUserStatus(ctx) {
  const sub = validate({ sub: { type: 'string', min: 6, max: 64, pattern: /^[A-Za-z0-9-]+$/ } }, ctx.params).sub;
  const body = validate({
    status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] },
    reason: { type: 'string', min: 3, max: 200 },
  }, ctx.body);
  if (sub === ctx.principal.sub) throw badRequest('admin.self', 'You cannot change your own status');
  const now = ctx.deps.clock.now();
  try {
    await ctx.deps.table.update(K.profile(sub), {
      set: { status: body.status, statusReason: body.reason, statusBy: ctx.principal.sub, statusAt: now },
      condition: { exists: true },
    });
  } catch (e) {
    if (e.code === 'store.condition_failed') throw notFound('User');
    throw e;
  }
  // also disable sign-in at the identity provider (AdminDisableUser / AdminEnableUser)
  if (ctx.deps.directory) await ctx.deps.directory.setEnabled(sub, body.status === 'ACTIVE');
  ctx.deps.cache.status?.delete(sub);
  ctx.log('admin.status', { sub, status: body.status });
  return new Response(200, { sub, status: body.status });
}

export async function platformMetrics(ctx) {
  const today = isoDay(ctx.deps.clock.now());
  const q = validate({
    from: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, optional: true },
    to: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, optional: true, default: today },
  }, ctx.query);
  const from = q.from || isoDay(Date.parse(q.to) - 29 * 86_400_000);
  if (from > q.to) throw new AppError(400, 'validation', 'from must be before to');
  const page = await ctx.deps.table.query({ pk: 'PLATFORM', sk: { between: [`DAY#${from}`, `DAY#${q.to}`] }, limit: 400 });
  const fields = ['orders', 'gmvCents', 'feesCents', 'units', 'signups', 'failedPayments', 'reviews', 'refundsCents'];
  const totals = Object.fromEntries(fields.map((f) => [f, 0]));
  const days = page.items.map((d) => {
    const row = { day: d.day || d.SK.slice(4) };
    for (const f of fields) { row[f] = d[f] || 0; totals[f] += row[f]; }
    return row;
  });
  const attempts = totals.orders + totals.failedPayments;
  return {
    from, to: q.to, days, totals,
    paymentSuccessRate: attempts ? Math.round((1000 * totals.orders) / attempts) / 10 : null,
    commissionCents: Math.round(totals.gmvCents * 0.1),
  };
}
