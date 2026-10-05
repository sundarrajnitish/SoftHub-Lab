// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Provider flows: own listings, uploads, sales dashboard.

import { K, CATEGORY_SLUGS } from '../keys.js';
import { validate, ID } from '../validate.js';
import { badRequest, forbidden, notFound } from '../util.js';
import { sha256 } from '../crypto.js';
import { Response, created } from './router.js';
import { publicProduct, invalidateCatalogue } from './catalog.js';
import { summarise } from '../sentiment.js';

const TAG = { type: 'string', min: 2, max: 24, pattern: /^[a-z0-9][a-z0-9 +#.-]*$/ };
const PRODUCT_FIELDS = {
  name: { type: 'string', min: 2, max: 60 },
  category: { type: 'string', enum: CATEGORY_SLUGS },
  description: { type: 'string', min: 20, max: 2000, multiline: true },
  developer: { type: 'string', min: 2, max: 60 },
  platforms: { type: 'array', of: { type: 'string', enum: ['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'Web'] }, min: 1, max: 6, unique: true },
  priceCents: { type: 'int', min: 99, max: 500_000 },
  tags: { type: 'array', of: TAG, max: 8, unique: true, optional: true, default: [] },
  features: { type: 'array', of: { type: 'string', min: 2, max: 80 }, max: 10, optional: true, default: [] },
  version: { type: 'string', max: 20, optional: true },
  licenseType: { type: 'string', enum: ['Perpetual', 'Subscription (1 year)', 'Subscription (1 month)', 'Freemium'], optional: true, default: 'Perpetual' },
  releaseDate: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, optional: true },
  publish: { type: 'bool', optional: true, default: false },
};

/** Deterministic artwork for a product (no stock images, no logos). */
export function productArt(name) {
  const h = sha256(name.toLowerCase());
  return { hue: Math.round((h[0] / 255) * 360), hue2: Math.round((h[1] / 255) * 360), glyph: h[2] % 8, monogram: name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() };
}

function catalogueKeys(p) {
  return p.status === 'PUBLISHED'
    ? { GSI1PK: `CAT#${p.category}`, GSI1SK: `${p.name.toLowerCase()}#${p.productId}` }
    : {};
}

function providerView(p) {
  return {
    ...publicProduct(p), ver: p.ver, unitsSold: p.unitsSold || 0, revenueCents: p.revenueCents || 0,
    createdAt: p.createdAt,
  };
}

export async function myProducts(ctx) {
  const page = await ctx.deps.table.query({ index: 'GSI2', pk: `PROVIDER#${ctx.principal.sub}`, sk: { beginsWith: 'PRODUCT#' }, desc: true, limit: 100 });
  return { items: page.items.filter((p) => p.status !== 'ARCHIVED').map(providerView) };
}

export async function createProduct(ctx) {
  const body = validate(PRODUCT_FIELDS, ctx.body);
  const { deps, principal } = ctx;
  const now = deps.clock.now();
  const productId = deps.newId('prd_');
  const { publish, ...fields } = body;
  const p = {
    ...K.product(productId), type: 'Product', productId, ...fields, providerSub: principal.sub,
    status: publish ? 'PUBLISHED' : 'DRAFT', image: productArt(fields.name), createdAt: now, updatedAt: now, ver: 1,
    buyers: 0, unitsSold: 0, revenueCents: 0, reviewCount: 0, ratingSum: 0, sentSum: 0, pos: 0, neg: 0, mismatch: 0,
    GSI2PK: `PROVIDER#${principal.sub}`, GSI2SK: `PRODUCT#${productId}`,
  };
  Object.assign(p, catalogueKeys(p));
  await deps.table.put(p, { condition: { exists: false } });
  invalidateCatalogue(deps);
  ctx.log('product.created', { productId, status: p.status });
  return created(providerView(p));
}

async function ownedProduct(ctx, productId) {
  const p = await ctx.deps.table.get(K.product(productId), { consistent: true });
  if (!p || p.status === 'ARCHIVED') throw notFound('Product');
  if (p.providerSub !== ctx.principal.sub && !ctx.principal.groups.includes('Admin')) {
    throw forbidden('product.not_owner', 'You can only change your own products');
  }
  return p;
}

/**
 * PUT /provider/products/{id} with optimistic concurrency: the body carries
 * the `ver` the editor started from; a concurrent edit makes the write fail
 * with 409 instead of silently overwriting it. Price changes apply to future
 * checkouts only — open orders keep their snapshot.
 */
export async function updateProduct(ctx) {
  const { productId } = validate({ productId: ID }, ctx.params);
  const fields = Object.fromEntries(Object.entries(PRODUCT_FIELDS).map(([k, v]) => [k, { ...v, optional: true, default: undefined }]));
  const body = validate({ ...fields, ver: { type: 'int', min: 1 } }, ctx.body);
  const p = await ownedProduct(ctx, productId);
  const { ver, publish, ...changes } = body;
  const next = { ...p, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
  if (publish !== undefined) next.status = publish ? 'PUBLISHED' : 'DRAFT';
  if (changes.name) next.image = productArt(changes.name);
  next.updatedAt = ctx.deps.clock.now();
  next.ver = ver + 1;
  delete next.GSI1PK; delete next.GSI1SK;
  Object.assign(next, catalogueKeys(next));
  await ctx.deps.table.put(next, { condition: { attr: 'ver', eq: ver } });
  invalidateCatalogue(ctx.deps);
  return new Response(200, providerView(next));
}

/** Archive, never delete: buyers keep their licences and order history. */
export async function archiveProduct(ctx) {
  const { productId } = validate({ productId: ID }, ctx.params);
  const p = await ownedProduct(ctx, productId);
  await ctx.deps.table.update(K.product(productId), {
    set: { status: 'ARCHIVED', updatedAt: ctx.deps.clock.now() }, remove: ['GSI1PK', 'GSI1SK'],
    add: { ver: 1 }, condition: { attr: 'ver', eq: p.ver },
  });
  invalidateCatalogue(ctx.deps);
  return new Response(200, { productId, status: 'ARCHIVED' });
}

const UPLOAD = {
  kind: { type: 'string', enum: ['image', 'installer'] },
  contentType: { type: 'string', max: 100 },
  bytes: { type: 'int', min: 1, max: 4 * 1024 ** 3 },
};
const UPLOAD_RULES = {
  image: { types: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 5 * 1024 ** 2 },
  installer: { types: ['application/octet-stream', 'application/zip', 'application/x-msdownload', 'application/x-apple-diskimage'], maxBytes: 4 * 1024 ** 3 },
};

/**
 * Files go straight from the browser to S3 with a presigned PUT; they never
 * pass through Lambda (6 MB payload limit) or get base64-encoded into JSON.
 */
export async function uploadUrl(ctx) {
  const { productId } = validate({ productId: ID }, ctx.params);
  const body = validate(UPLOAD, ctx.body);
  await ownedProduct(ctx, productId);
  const rule = UPLOAD_RULES[body.kind];
  if (!rule.types.includes(body.contentType)) throw badRequest('upload.type', `Allowed types: ${rule.types.join(', ')}`);
  if (body.bytes > rule.maxBytes) throw badRequest('upload.size', `Maximum ${Math.round(rule.maxBytes / 1024 ** 2)} MB`);
  const key = body.kind === 'image' ? `images/${productId}/${ctx.deps.newId('img_')}` : `installers/${productId}/latest`;
  const signed = await ctx.deps.objects.presignPut(key, { contentType: body.contentType, maxBytes: rule.maxBytes, ttlSec: 600 });
  return created({ key, ...signed });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** GET /provider/dashboard?from&to — one Query over the sales ledger. */
export async function dashboard(ctx) {
  const { deps, principal } = ctx;
  const today = new Date(deps.clock.now()).toISOString().slice(0, 10);
  const q = validate({
    from: { type: 'string', pattern: DAY, optional: true },
    to: { type: 'string', pattern: DAY, optional: true, default: today },
  }, ctx.query);
  const to = q.to;
  const from = q.from || new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) throw badRequest('validation', 'from must be before to');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw badRequest('validation', 'At most one year');

  const rows = [];
  let cursor = null;
  do {
    const page = await deps.table.query({ pk: `PROVIDER#${principal.sub}`, sk: { between: [`SALES#${from}`, `SALES#${to}~`] }, limit: 500, cursor });
    rows.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  const products = (await deps.table.query({ index: 'GSI2', pk: `PROVIDER#${principal.sub}`, limit: 100 })).items;
  const byDay = new Map();
  for (let d = Date.parse(from); d <= Date.parse(to); d += 86_400_000) {
    byDay.set(new Date(d).toISOString().slice(0, 10), { day: new Date(d).toISOString().slice(0, 10), units: 0, revenueCents: 0, payoutCents: 0 });
  }
  const byProduct = new Map();
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (d) { d.units += r.units; d.revenueCents += r.revenueCents; d.payoutCents += r.payoutCents; }
    const p = byProduct.get(r.productId) || { units: 0, revenueCents: 0 };
    p.units += r.units; p.revenueCents += r.revenueCents;
    byProduct.set(r.productId, p);
  }
  const series = [...byDay.values()];
  const totals = series.reduce((a, d) => ({ units: a.units + d.units, revenueCents: a.revenueCents + d.revenueCents, payoutCents: a.payoutCents + d.payoutCents }), { units: 0, revenueCents: 0, payoutCents: 0 });
  return {
    from, to, totals, series,
    products: products.filter((p) => p.status !== 'ARCHIVED').map((p) => {
      const s = summarise(p, []);
      return {
        productId: p.productId, name: p.name, status: p.status, priceCents: p.priceCents, image: p.image,
        units: byProduct.get(p.productId)?.units || 0, revenueCents: byProduct.get(p.productId)?.revenueCents || 0,
        rating: s.averageStars ?? null, reviews: s.reviews, sentiment: s.sentiment ?? null, mood: s.mood || null,
        aspects: s.aspects, mismatches: s.mismatches || 0, buyers: p.buyers || 0,
      };
    }).sort((a, b) => b.revenueCents - a.revenueCents),
  };
}
