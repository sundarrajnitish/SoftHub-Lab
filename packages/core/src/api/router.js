// HTTP routing shared by every runtime.
//
// A request is a plain object {method, path, query, headers, body, principal}
// — API Gateway (HTTP API, payload v2) events, the local dev server and the
// in-browser runtime all convert to it. Handlers return plain data; the router
// owns status codes, JSON, CORS, security headers and error mapping, so no
// handler can leak a stack trace or forget a header.

import { AppError, forbidden, unauthorized } from '../util.js';
import { ConditionFailed } from '../store.js';

const SECURITY_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};

export function compile(routes) {
  return routes.map((r) => {
    const names = [];
    const re = new RegExp(`^${r.path.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; })}/?$`);
    return { ...r, re, names };
  });
}

export function match(compiled, method, path) {
  let pathMatched = false;
  for (const r of compiled) {
    const m = r.re.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

export class Response {
  constructor(status, body, headers = {}) { this.status = status; this.body = body; this.headers = headers; }
}
export const created = (body, headers) => new Response(201, body, headers);
export const accepted = (body) => new Response(202, body);

/**
 * Build a request handler.
 * @param routes   route table [{method, path, auth, handler, name}]
 * @param deps     ports and config
 * @param hooks    {authorize(principal, route, ctx)} extra checks (suspension)
 */
export function createRouter(routes, deps, hooks = {}) {
  const compiled = compile(routes);
  return async function handle(req) {
    const started = deps.clock.now();
    const requestId = req.requestId || deps.newId('req_');
    const log = (step, data) => { if (req.trace) req.trace({ step, ...data }); };
    const method = (req.method || 'GET').toUpperCase();
    const headers = lowerKeys(req.headers || {});
    const corsHeaders = cors(deps.config?.allowedOrigins, headers.origin);
    try {
      if (method === 'OPTIONS') return finish(new Response(204, null, corsHeaders));
      const m = match(compiled, method, req.path);
      if (!m) throw new AppError(404, 'route.not_found', `No route for ${req.path}`);
      if (m.methodNotAllowed) throw new AppError(405, 'route.method', `${method} not allowed on ${req.path}`);
      const { route, params } = m;
      log('route', { route: `${route.method} ${route.path}`, name: route.name });

      // public routes never see a principal (as with API Gateway: no authorizer on them)
      const principal = route.auth ? req.principal || null : null;
      if (route.auth) {
        if (!principal) throw unauthorized();
        if (Array.isArray(route.auth) && !route.auth.some((g) => principal.groups.includes(g))) {
          throw forbidden('auth.role', `Requires role ${route.auth.join(' or ')}`);
        }
        if (hooks.authorize) await hooks.authorize(principal, route, { log, scope: req.scope });
        log('authorized', { sub: principal.sub, groups: principal.groups });
      }

      let body = {};
      if (route.raw) {
        body = req.body ?? '';
      } else if (req.body !== undefined && req.body !== null && req.body !== '') {
        if (typeof req.body === 'string') {
          if (req.body.length > (route.maxBody || 64 * 1024)) throw new AppError(413, 'body.too_large', 'Request body too large');
          try { body = JSON.parse(req.body); } catch { throw new AppError(400, 'body.json', 'Body is not valid JSON'); }
        } else {
          body = req.body;
        }
      }
      // `scope` lets a runtime attach per-invocation instrumentation (tracing table)
      const d = req.scope ? { ...deps, ...req.scope } : deps;
      const ctx = { deps: d, principal, params, query: req.query || {}, headers, body, requestId, log };
      const result = await route.handler(ctx);
      const res = result instanceof Response ? result : new Response(method === 'POST' ? 201 : 200, result);
      res.headers = { ...corsHeaders, ...res.headers };
      return finish(res);
    } catch (err) {
      return finish(toErrorResponse(err, requestId, corsHeaders, log));
    }

    function finish(res) {
      const out = {
        status: res.status,
        headers: { ...SECURITY_HEADERS, 'x-request-id': requestId, ...res.headers },
        body: res.body === null || res.body === undefined ? '' : JSON.stringify(res.body),
      };
      log('response', { status: out.status, ms: deps.clock.now() - started });
      return out;
    }
  };
}

function toErrorResponse(err, requestId, corsHeaders, log) {
  if (err instanceof ConditionFailed) {
    log('error', { code: err.code });
    return new Response(409, { error: { code: 'conflict', message: 'The resource changed; retry', requestId } }, corsHeaders);
  }
  if (err instanceof AppError) {
    log('error', { code: err.code, status: err.status });
    const e = { code: err.code, message: err.message, requestId };
    if (err.details?.errors) e.fields = err.details.errors;
    const headers = { ...corsHeaders };
    if (err.status === 401) headers['www-authenticate'] = 'Bearer';
    return new Response(err.status, { error: e }, headers);
  }
  // Unexpected: log internally, return an opaque 500.
  log('error', { code: 'internal', message: String(err && err.message) });
  if (typeof console !== 'undefined' && !globalThis.__SOFTHUB_QUIET__) console.error(requestId, err);
  return new Response(500, { error: { code: 'internal', message: 'Something went wrong', requestId } }, corsHeaders);
}

function lowerKeys(h) {
  const o = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
}

function cors(allowed = ['*'], origin) {
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, content-type, idempotency-key',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    vary: 'origin',
  };
}
