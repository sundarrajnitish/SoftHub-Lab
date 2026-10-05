// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Small shared utilities: errors, a seeded RNG, sortable ids, money, a clock.

/** An error that maps to an HTTP response. */
export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code machine-readable code, e.g. "cart.already_owned"
   * @param {string} message human-readable message
   * @param {object} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const badRequest = (code, msg, details) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Sign in required') => new AppError(401, 'auth.required', msg);
export const forbidden = (code = 'auth.forbidden', msg = 'Not allowed') => new AppError(403, code, msg);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code, msg, details) => new AppError(409, code, msg, details);

/** Mulberry32: tiny, fast, seedable PRNG (deterministic simulations and tests). */
export function createRng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    /** integer in [lo, hi] */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    /** standard normal via Box-Muller */
    normal: (mu = 0, sigma = 1) => {
      const u = Math.max(next(), 1e-12), v = next();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /** log-normal parametrised by its median and the sigma of log(x) */
    lognormal: (median, sigma) => median * Math.exp(sigma * rng.normal()),
    /** exponential inter-arrival with the given mean */
    exp: (mean) => -mean * Math.log(1 - next()),
    /** weighted pick: items = [[value, weight], ...] */
    weighted: (items) => {
      const total = items.reduce((a, [, w]) => a + w, 0);
      let r = next() * total;
      for (const [v, w] of items) { if ((r -= w) <= 0) return v; }
      return items[items.length - 1][0];
    },
  };
  return rng;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Time-sortable ids (ULID layout: 48-bit ms timestamp + 80 random bits, Crockford
 * base32). Sorting ids sorts by creation time, which the table design relies on
 * ("newest orders first" is a plain descending range query).
 */
export function createIdFactory(clock, random = Math.random) {
  let lastMs = -1;
  let lastRand = null;
  return function newId(prefix = '') {
    const ms = Math.floor(clock.now());
    let rand;
    if (ms === lastMs && lastRand) {
      // monotonic within one millisecond: increment the random part
      rand = lastRand.slice();
      for (let i = rand.length - 1; i >= 0; i--) {
        if (rand[i] < 31) { rand[i]++; break; }
        rand[i] = 0;
      }
    } else {
      rand = Array.from({ length: 16 }, () => Math.floor(random() * 32));
    }
    lastMs = ms; lastRand = rand;
    let t = '';
    let x = ms;
    for (let i = 0; i < 10; i++) { t = CROCKFORD[x % 32] + t; x = Math.floor(x / 32); }
    return prefix + t + rand.map((r) => CROCKFORD[r]).join('');
  };
}

export { CROCKFORD };

/** Wall clock, or a manual clock for simulations. */
export const systemClock = { now: () => Date.now() };
export function manualClock(start = Date.UTC(2026, 0, 5, 9)) {
  let t = start;
  return {
    now: () => t,
    set: (ms) => { t = ms; },
    advance: (ms) => { t += ms; return t; },
  };
}

/** Money is always integer cents. */
export function toCents(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new TypeError('amounts are integer cents');
}

export function formatCents(cents, currency = 'CAD') {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return `${sign}${currency === 'CAD' ? 'C$' : '$'}${s}`;
}

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Stable JSON stringify (sorted keys) — used for idempotency fingerprints. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

export const deepClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
