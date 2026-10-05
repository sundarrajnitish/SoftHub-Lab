// Public catalogue: browse, search, product page, reviews, insights, related.

import { K, CATEGORIES, CATEGORY_SLUGS } from '../keys.js';
import { validate, ID } from '../validate.js';
import { notFound } from '../util.js';
import { summarise } from '../sentiment.js';
import { relatedProducts } from '../recommend.js';

export const CATALOGUE_TTL_MS = 60_000;

/** Public view of a product item: no keys, no internal counters. */
export function publicProduct(p) {
  if (!p) return null;
  const n = p.reviewCount || 0;
  return {
    productId: p.productId, name: p.name, category: p.category, description: p.description,
    developer: p.developer, platforms: p.platforms || [], priceCents: p.priceCents, currency: 'CAD',
    tags: p.tags || [], features: p.features || [], version: p.version || null, licenseType: p.licenseType || null,
    releaseDate: p.releaseDate || null, image: p.image || null, status: p.status,
    rating: n ? Math.round((p.ratingSum / n) * 10) / 10 : null, reviewCount: n, buyers: p.buyers || 0,
    updatedAt: p.updatedAt,
  };
}

/**
 * Published products, cached in the container for 60 s. A warm Lambda serves
 * most catalogue reads from memory; a cold one pays one Query per category.
 */
export async function loadCatalogue(deps, { fresh = false } = {}) {
  const c = deps.cache;
  const now = deps.clock.now();
  if (!fresh && c.catalogue && now - c.catalogue.at < CATALOGUE_TTL_MS) return c.catalogue.items;
  const items = [];
  for (const slug of CATEGORY_SLUGS) {
    let cursor = null;
    do {
      const page = await deps.table.query({ index: 'GSI1', pk: `CAT#${slug}`, limit: 100, cursor });
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
  }
  c.catalogue = { at: now, items };
  return items;
}

export const invalidateCatalogue = (deps) => { deps.cache.catalogue = null; };

const LIST_QUERY = {
  category: { type: 'string', enum: CATEGORY_SLUGS, optional: true },
  q: { type: 'string', max: 60, optional: true },
  minPrice: { type: 'int', min: 0, max: 10_000_000, optional: true },
  maxPrice: { type: 'int', min: 0, max: 10_000_000, optional: true },
  minRating: { type: 'int', min: 1, max: 5, optional: true },
  sort: { type: 'string', enum: ['name', 'price', '-price', 'rating', 'popular'], optional: true, default: 'popular' },
  limit: { type: 'int', min: 1, max: 60, optional: true, default: 24 },
};

export async function listProducts(ctx) {
  const q = validate(LIST_QUERY, ctx.query);
  let items;
  if (q.category) {
    // one partition: Query GSI1 CAT#<category> (cached with the rest)
    items = (await loadCatalogue(ctx.deps)).filter((p) => p.category === q.category);
  } else {
    items = await loadCatalogue(ctx.deps);
  }
  const terms = (q.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows = items.map(publicProduct).filter((p) => {
    if (q.minPrice !== undefined && p.priceCents < q.minPrice) return false;
    if (q.maxPrice !== undefined && p.priceCents > q.maxPrice) return false;
    if (q.minRating !== undefined && (p.rating ?? 0) < q.minRating) return false;
    if (terms.length) {
      const hay = `${p.name} ${p.developer} ${p.tags.join(' ')} ${p.category}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    price: (a, b) => a.priceCents - b.priceCents || a.name.localeCompare(b.name),
    '-price': (a, b) => b.priceCents - a.priceCents || a.name.localeCompare(b.name),
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount,
    popular: (a, b) => b.buyers - a.buyers || (b.rating ?? 0) - (a.rating ?? 0) || a.name.localeCompare(b.name),
  }[q.sort];
  rows.sort(by);
  ctx.log('catalogue', { matched: rows.length, cached: true });
  return { items: rows.slice(0, q.limit), total: rows.length };
}

export async function getProductItem(deps, productId) {
  return deps.table.get(K.product(productId));
}

export async function getProduct(ctx) {
  const { productId } = validate({ productId: ID }, ctx.params);
  const p = await getProductItem(ctx.deps, productId);
  if (!p || p.status !== 'PUBLISHED') throw notFound('Product'); // drafts are visible via /provider/products
  return publicProduct(p);
}

export async function listReviews(ctx) {
  const { productId } = validate({ productId: ID }, ctx.params);
  const q = validate({ cursor: { type: 'string', max: 400, optional: true }, limit: { type: 'int', min: 1, max: 25, optional: true, default: 10 } }, ctx.query);
  const page = await ctx.deps.table.query({ pk: `PRODUCT#${productId}`, sk: { beginsWith: 'REVIEW#' }, desc: true, limit: q.limit, cursor: q.cursor });
  return { items: page.items.map(publicReview), cursor: page.cursor };
}

export function publicReview(r) {
  return {
    reviewId: r.reviewId, productId: r.productId, author: r.author, stars: r.stars, text: r.text,
    createdAt: r.createdAt, editedAt: r.editedAt || null, verified: true,
    sentiment: { compound: r.compound, label: r.label, aspects: r.aspects || {} },
  };
}

export async function getInsights(ctx) {
  const { productId } = validate({ productId: ID }, ctx.params);
  const p = await getProductItem(ctx.deps, productId);
  if (!p || p.status !== 'PUBLISHED') throw notFound('Product');
  const recent = p.reviewCount
    ? (await ctx.deps.table.query({ pk: `PRODUCT#${productId}`, sk: { beginsWith: 'REVIEW#' }, desc: true, limit: 30 })).items
    : [];
  return summarise(p, recent);
}

/** Co-purchase counters for one product as Map(productId → n). */
export async function togetherCounts(deps, productId) {
  const m = new Map();
  let cursor = null;
  do {
    const page = await deps.table.query({ pk: `PRODUCT#${productId}`, sk: { beginsWith: 'ALSO#' }, limit: 100, cursor });
    for (const it of page.items) m.set(it.SK.slice(5), it.n || 0);
    cursor = page.cursor;
  } while (cursor);
  return m;
}

export async function getRelated(ctx) {
  const { productId } = validate({ productId: ID }, ctx.params);
  const anchor = await getProductItem(ctx.deps, productId);
  if (!anchor || anchor.status !== 'PUBLISHED') throw notFound('Product');
  // public + cacheable: personalisation (hiding owned items) lives in /me/recommendations
  const [catalogue, together] = await Promise.all([loadCatalogue(ctx.deps), togetherCounts(ctx.deps, productId)]);
  const recs = relatedProducts(anchor, catalogue, together, { limit: 4 });
  const byId = new Map(catalogue.map((p) => [p.productId, p]));
  return { items: recs.map((r) => ({ ...publicProduct(byId.get(r.productId)), score: r.score, reason: r.reason })) };
}

export async function ownedIds(deps, sub) {
  const s = new Set();
  let cursor = null;
  do {
    const page = await deps.table.query({ pk: `USER#${sub}`, sk: { beginsWith: 'OWNS#' }, limit: 100, cursor });
    for (const it of page.items) if (it.status === 'ACTIVE') s.add(it.productId);
    cursor = page.cursor;
  } while (cursor);
  return s;
}

export const listCategories = () => ({ items: CATEGORIES });
