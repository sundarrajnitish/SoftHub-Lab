// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Single-table design: every entity, its keys, and the access pattern each
// key serves. The API never scans; every read below is a GetItem or a Query on
// one partition. (docs/ renders this table in the "Data" lab.)

export const pad = (n, width = 10) => String(Math.max(0, Math.floor(n))).padStart(width, '0');

export const K = {
  // Product (catalogue entry + live aggregates)
  //   PK PRODUCT#<id>  SK META
  //   GSI1 CAT#<category> / <nameLower>#<id>          → browse a category A–Z
  //   GSI2 PROVIDER#<sub> / PRODUCT#<createdAt id>      → provider's own products
  product: (id) => ({ PK: `PRODUCT#${id}`, SK: 'META' }),
  productGsi1: (category, name, id, status) => (status === 'PUBLISHED'
    ? { GSI1PK: `CAT#${category}`, GSI1SK: `${name.toLowerCase()}#${id}` }
    : { GSI1PK: undefined, GSI1SK: undefined }),
  productGsi2: (providerSub, id) => ({ GSI2PK: `PROVIDER#${providerSub}`, GSI2SK: `PRODUCT#${id}` }),

  // Review — newest first under the product; one per (product, user)
  //   PK PRODUCT#<id>  SK REVIEW#<reviewId>   (reviewId is time-sortable)
  //   PK PRODUCT#<id>  SK REVIEWER#<sub>      (uniqueness marker → points at reviewId)
  review: (productId, reviewId) => ({ PK: `PRODUCT#${productId}`, SK: `REVIEW#${reviewId}` }),
  reviewer: (productId, sub) => ({ PK: `PRODUCT#${productId}`, SK: `REVIEWER#${sub}` }),

  // Co-purchase counter used by recommendations
  //   PK PRODUCT#<a>  SK ALSO#<b>   {n}
  also: (a, b) => ({ PK: `PRODUCT#${a}`, SK: `ALSO#${b}` }),

  // User profile, cart lines, owned licences
  //   PK USER#<sub>  SK PROFILE        GSI1 EMAIL#<email> / USER   → admin lookup by e-mail
  //   PK USER#<sub>  SK CART#<productId>
  //   PK USER#<sub>  SK OWNS#<productId>  → {orderId, licenseKey}
  profile: (sub) => ({ PK: `USER#${sub}`, SK: 'PROFILE' }),
  cart: (sub, productId) => ({ PK: `USER#${sub}`, SK: `CART#${productId}` }),
  owns: (sub, productId) => ({ PK: `USER#${sub}`, SK: `OWNS#${productId}` }),

  // Order — canonical item; user's orders via GSI1, newest first
  //   PK ORDER#<orderId>  SK META     GSI1 USER#<sub> / ORDER#<orderId>
  //   PK ORDER#<orderId>  SK LINE#<productId>
  order: (orderId) => ({ PK: `ORDER#${orderId}`, SK: 'META' }),
  orderLine: (orderId, productId) => ({ PK: `ORDER#${orderId}`, SK: `LINE#${productId}` }),

  // Provider sales ledger, one counter row per (day, product)
  //   PK PROVIDER#<sub>  SK SALES#<yyyy-mm-dd>#<productId>   {units, revenue}
  sales: (providerSub, day, productId) => ({ PK: `PROVIDER#${providerSub}`, SK: `SALES#${day}#${productId}` }),

  // Platform-wide daily counters (admin dashboard)
  //   PK PLATFORM  SK DAY#<yyyy-mm-dd>   {orders, gmv, signups, failedPayments, reviews}
  platformDay: (day) => ({ PK: 'PLATFORM', SK: `DAY#${day}` }),

  // Exactly-once plumbing
  //   PK IDEMP#<scope>#<key>  SK META     → stored response of a POST (24 h TTL)
  //   PK EVENT#<stripeEventId> SK META    → webhook event already processed (30 d TTL)
  //   PK OUTBOX#<orderId>     SK EMAIL    → e-mail to send, written in the fulfilment transaction
  idempotency: (scope, key) => ({ PK: `IDEMP#${scope}#${key}`, SK: 'META' }),
  event: (eventId) => ({ PK: `EVENT#${eventId}`, SK: 'META' }),
  outbox: (orderId) => ({ PK: `OUTBOX#${orderId}`, SK: 'EMAIL' }),
};

/** Human-readable description of the access patterns (rendered on the site). */
export const ACCESS_PATTERNS = [
  { id: 'product', name: 'Product page', call: 'GetItem', key: 'PK=PRODUCT#<id>, SK=META' },
  { id: 'category', name: 'Browse a category A–Z', call: 'Query GSI1', key: 'GSI1PK=CAT#<category>' },
  { id: 'reviews', name: 'Reviews, newest first', call: 'Query (desc)', key: 'PK=PRODUCT#<id>, SK begins_with REVIEW#' },
  { id: 'also', name: 'Bought together', call: 'Query', key: 'PK=PRODUCT#<id>, SK begins_with ALSO#' },
  { id: 'cart', name: 'My cart', call: 'Query', key: 'PK=USER#<sub>, SK begins_with CART#' },
  { id: 'library', name: 'My licences', call: 'Query', key: 'PK=USER#<sub>, SK begins_with OWNS#' },
  { id: 'orders', name: 'My orders, newest first', call: 'Query GSI1 (desc)', key: 'GSI1PK=USER#<sub>, GSI1SK begins_with ORDER#' },
  { id: 'order', name: 'One order + lines', call: 'Query', key: 'PK=ORDER#<id>' },
  { id: 'myproducts', name: "Provider's products", call: 'Query GSI2', key: 'GSI2PK=PROVIDER#<sub>' },
  { id: 'sales', name: 'Provider sales by date range', call: 'Query', key: 'PK=PROVIDER#<sub>, SK BETWEEN SALES#<from> AND SALES#<to>~' },
  { id: 'email', name: 'Admin: find user by e-mail', call: 'Query GSI1', key: 'GSI1PK=EMAIL#<email>' },
  { id: 'platform', name: 'Admin: platform metrics', call: 'Query', key: 'PK=PLATFORM, SK BETWEEN DAY#<from> AND DAY#<to>' },
];

export const CATEGORIES = [
  { slug: 'productivity', title: 'Productivity', blurb: 'Office suites, notes, planning and PDF tools' },
  { slug: 'video-editors', title: 'Video editors', blurb: 'Editing, colour and motion graphics' },
  { slug: 'games', title: 'Games', blurb: 'Indie and strategy titles with instant keys' },
  { slug: 'streaming-services', title: 'Streaming services', blurb: 'Music, film and learning subscriptions' },
  { slug: 'developer-tools', title: 'Developer tools', blurb: 'Editors, databases and API clients' },
  { slug: 'security', title: 'Security', blurb: 'Password managers, VPNs and backup' },
];
export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);
