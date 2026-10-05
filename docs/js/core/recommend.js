// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// "You may also like" — item-to-item recommendations.
//
// Two signals, blended:
//   1. Co-purchase (collaborative): when an order is fulfilled, every pair of
//      products the buyer now owns gets +1 on an ALSO#<b> counter under
//      PRODUCT#<a>. Similarity is the cosine of the two products' buyer sets:
//          cos(a, b) = together(a, b) / sqrt(buyers(a) · buyers(b))
//      which stops best-sellers from being "similar" to everything.
//   2. Content: Jaccard overlap of tags, plus a bonus for the same category.
//      This carries new products that nobody has bought yet (cold start).
// The two are added, not averaged — co-purchase is extra evidence on top of
// what the listings say:
//          score = content + β · cos          (β = 0.5)
// β was chosen with the leave-last-out evaluation in sim/run.mjs (additive
// beat either signal alone and every convex blend we tried). With no
// purchases yet, cos = 0 and the ranking is pure content.
// Every recommendation carries a human-readable reason.

export const BETA = 0.5;

export function contentSimilarity(a, b) {
  const ta = new Set(a.tags || []), tb = new Set(b.tags || []);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jac = union ? inter / union : 0;
  return 0.7 * jac + (a.category === b.category ? 0.3 : 0);
}

export function sharedTags(a, b) {
  const tb = new Set(b.tags || []);
  return (a.tags || []).filter((t) => tb.has(t));
}

/**
 * @param anchor     the product being viewed
 * @param candidates all published products (anchor excluded by caller or here)
 * @param together   Map(productId → co-purchase count with anchor)
 * @param exclude    Set of product ids the viewer already owns
 */
export function relatedProducts(anchor, candidates, together, { exclude = new Set(), limit = 4, beta = BETA, useContent = true } = {}) {
  const buyersA = anchor.buyers || 0;
  const scored = [];
  for (const c of candidates) {
    if (c.productId === anchor.productId || exclude.has(c.productId) || c.status !== 'PUBLISHED') continue;
    const t = together.get(c.productId) || 0;
    const buyersB = c.buyers || 0;
    const cos = t && buyersA && buyersB ? t / Math.sqrt(buyersA * buyersB) : 0;
    const content = useContent ? contentSimilarity(anchor, c) : 0;
    const score = content + beta * cos;
    if (score <= 0) continue;
    const tags = sharedTags(anchor, c);
    const reasons = [];
    if (t >= 2) reasons.push(`${t} buyers own both`);
    if (tags.length) reasons.push(`shares ${tags.slice(0, 2).join(', ')}`);
    else if (c.category === anchor.category) reasons.push('same category');
    scored.push({ productId: c.productId, score: Math.round(score * 1000) / 1000, cos, content, together: t,
      reason: reasons.join(' · ') || 'similar' });
  }
  scored.sort((x, y) => y.score - x.score || (x.productId < y.productId ? -1 : 1));
  return scored.slice(0, limit);
}

/**
 * Personal recommendations: sum the related-scores of everything the user
 * owns. With an empty library fall back to best-rated popular products.
 */
export function recommendForUser(owned, catalogue, togetherOf, { limit = 6, ...opts } = {}) {
  const ownedSet = new Set(owned.map((p) => p.productId));
  const acc = new Map();
  for (const p of owned) {
    for (const r of relatedProducts(p, catalogue, togetherOf(p.productId), { exclude: ownedSet, limit: catalogue.length, ...opts })) {
      const cur = acc.get(r.productId) || { productId: r.productId, score: 0, because: [] };
      cur.score += r.score;
      cur.because.push(p.name);
      acc.set(r.productId, cur);
    }
  }
  if (!acc.size) {
    return catalogue
      .filter((p) => p.status === 'PUBLISHED' && !ownedSet.has(p.productId))
      .map((p) => ({ productId: p.productId, score: popularity(p), because: [], reason: 'popular right now' }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  return [...acc.values()]
    .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000, reason: `because you own ${r.because.slice(0, 2).join(' and ')}` }))
    .sort((a, b) => b.score - a.score || (a.productId < b.productId ? -1 : 1))
    .slice(0, limit);
}

/** Popularity prior: buyers, discounted by a Bayesian-averaged rating. */
export function popularity(p) {
  const n = p.reviewCount || 0;
  const avg = n ? p.ratingSum / n : 0;
  const bayes = (avg * n + 3.5 * 5) / (n + 5);
  return Math.log1p(p.buyers || 0) * (bayes / 5);
}
