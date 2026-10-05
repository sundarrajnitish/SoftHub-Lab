// The SoftHub API: route table + composition.
//
// `createApp(deps)` is what every runtime instantiates — one instance per
// Lambda container (so `deps.cache` is that container's memory), one per local
// dev server, one per browser tab on the website.

import { createRouter } from './router.js';
import * as catalog from './catalog.js';
import * as shop from './shop.js';
import * as provider from './provider.js';
import * as users from './users.js';
import * as fulfil from './fulfil.js';

const C = ['Consumer'];
const P = ['Provider', 'Admin'];
const A = ['Admin'];
const ANY = ['Consumer', 'Provider', 'Admin'];

/**
 * fn: which Lambda function serves the route (infra/template.yaml groups them
 * so read-heavy public routes scale and cold-start independently of checkout).
 */
export const ROUTES = [
  { method: 'GET', path: '/categories', auth: null, fn: 'catalog', name: 'List categories', handler: catalog.listCategories },
  { method: 'GET', path: '/products', auth: null, fn: 'catalog', name: 'Browse and search products', handler: catalog.listProducts },
  { method: 'GET', path: '/products/{productId}', auth: null, fn: 'catalog', name: 'Product details', handler: catalog.getProduct },
  { method: 'GET', path: '/products/{productId}/reviews', auth: null, fn: 'catalog', name: 'Reviews, newest first', handler: catalog.listReviews },
  { method: 'GET', path: '/products/{productId}/insights', auth: null, fn: 'catalog', name: 'Review sentiment summary', handler: catalog.getInsights },
  { method: 'GET', path: '/products/{productId}/related', auth: null, fn: 'catalog', name: 'Related products', handler: catalog.getRelated },

  { method: 'GET', path: '/me', auth: ANY, fn: 'shop', name: 'My profile', handler: users.me },
  { method: 'GET', path: '/me/recommendations', auth: C, fn: 'shop', name: 'Recommended for me', handler: shop.myRecommendations },
  { method: 'GET', path: '/cart', auth: C, fn: 'shop', name: 'View cart', handler: shop.getCart },
  { method: 'DELETE', path: '/cart', auth: C, fn: 'shop', name: 'Empty cart', handler: shop.clearCart },
  { method: 'PUT', path: '/cart/{productId}', auth: C, fn: 'shop', name: 'Add to cart', handler: shop.addToCart },
  { method: 'DELETE', path: '/cart/{productId}', auth: C, fn: 'shop', name: 'Remove from cart', handler: shop.removeFromCart },
  { method: 'POST', path: '/checkout', auth: C, fn: 'shop', name: 'Start checkout (Idempotency-Key)', handler: shop.checkout },
  { method: 'GET', path: '/orders', auth: C, fn: 'shop', name: 'My orders', handler: shop.listOrders },
  { method: 'GET', path: '/orders/{orderId}', auth: ['Consumer', 'Admin'], fn: 'shop', name: 'One order with licence keys', handler: shop.getOrder },
  { method: 'GET', path: '/orders/{orderId}/downloads/{productId}', auth: C, fn: 'shop', name: 'Presigned installer download', handler: shop.getDownload },
  { method: 'GET', path: '/library', auth: C, fn: 'shop', name: 'My licences', handler: shop.getLibrary },
  { method: 'POST', path: '/products/{productId}/reviews', auth: C, fn: 'shop', name: 'Write or edit my review', handler: shop.postReview },

  { method: 'GET', path: '/provider/products', auth: P, fn: 'provider', name: 'My listings', handler: provider.myProducts },
  { method: 'POST', path: '/provider/products', auth: P, fn: 'provider', name: 'Create listing', handler: provider.createProduct },
  { method: 'PUT', path: '/provider/products/{productId}', auth: P, fn: 'provider', name: 'Edit listing (optimistic lock)', handler: provider.updateProduct },
  { method: 'DELETE', path: '/provider/products/{productId}', auth: P, fn: 'provider', name: 'Archive listing', handler: provider.archiveProduct },
  { method: 'POST', path: '/provider/products/{productId}/uploads', auth: P, fn: 'provider', name: 'Presigned upload URL', handler: provider.uploadUrl },
  { method: 'GET', path: '/provider/dashboard', auth: P, fn: 'provider', name: 'Sales and sentiment dashboard', handler: provider.dashboard },

  { method: 'GET', path: '/admin/users', auth: A, fn: 'admin', name: 'Find a user by e-mail', handler: users.findUser },
  { method: 'PUT', path: '/admin/users/{sub}/status', auth: A, fn: 'admin', name: 'Suspend or reinstate', handler: users.setUserStatus },
  { method: 'GET', path: '/admin/metrics', auth: A, fn: 'admin', name: 'Platform metrics', handler: users.platformMetrics },

  { method: 'POST', path: '/webhooks/stripe', auth: null, raw: true, fn: 'webhook', name: 'Stripe events (signed)', handler: fulfil.stripeWebhook },
];

export const FUNCTIONS = {
  catalog: { memoryMb: 512, description: 'Public catalogue reads' },
  shop: { memoryMb: 512, description: 'Cart, checkout, orders, reviews' },
  provider: { memoryMb: 512, description: 'Listings and dashboards' },
  admin: { memoryMb: 256, description: 'Admin tools' },
  webhook: { memoryMb: 512, description: 'Stripe webhook → fulfilment' },
  mailer: { memoryMb: 256, description: 'Stream → SES receipts' },
};

/**
 * @param deps {table, payments, mailer, objects, directory, clock, newId, config}
 * @param opts {fn} restrict to one Lambda function's routes
 */
export function createApp(deps, { fn = null } = {}) {
  const d = { cache: {}, ...deps };
  const routes = fn ? ROUTES.filter((r) => r.fn === fn) : ROUTES;
  const handle = createRouter(routes, d, {
    authorize: (principal, route, { log, scope }) => users.checkNotSuspended(scope ? { ...d, ...scope } : d, principal, log),
  });
  return {
    handle,
    deps: d,
    onUserConfirmed: (u) => users.onUserConfirmed(d, u),
    processStreamRecord: (r) => fulfil.processStreamRecord(d, r),
  };
}

/** OpenAPI 3.1 description generated from the route table (docs/openapi.json). */
export function openApi() {
  const paths = {};
  for (const r of ROUTES) {
    const p = (paths[r.path] ||= {});
    p[r.method.toLowerCase()] = {
      summary: r.name,
      tags: [r.fn],
      ...(r.auth ? { security: [{ cognito: [] }], 'x-roles': r.auth } : {}),
      parameters: [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      responses: { 200: { description: 'OK' }, 400: { description: 'Validation error' }, ...(r.auth ? { 401: { description: 'Sign in required' }, 403: { description: 'Wrong role or suspended' } } : {}) },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'SoftHub API', version: '1.0.0', description: 'Serverless software marketplace API' },
    components: { securitySchemes: { cognito: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}
