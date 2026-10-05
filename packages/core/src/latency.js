// Latency + cost model shared by the simulator and the website.
//
// Numbers are modelling assumptions, not measurements of a live deployment:
// typical published figures for Node.js 24 Lambda on arm64 with a small
// bundle, DynamoDB single-digit-millisecond reads, and Stripe API calls of a
// few hundred milliseconds. Every figure the site shows that depends on them
// is labelled "modelled".

export const MODEL = {
  apiGatewayMs: 6,          // HTTP API overhead incl. cached JWT authorizer
  coldInitMedianMs: 240,    // Node 24 arm64, ~150 KB bundle (init phase)
  coldInitSigma: 0.25,
  handlerBaseMs: 2.5,       // JSON, validation, routing
  ddb: {                    // median ms per call
    GetItem: 4, BatchGetItem: 6, PutItem: 6, UpdateItem: 6, DeleteItem: 6, Query: 6,
    TransactWriteItems: 14, perTransactItemMs: 0.6,
  },
  ddbSigma: 0.35,
  stripeApiMs: 280,
  stripeSigma: 0.3,
  idleTimeoutMs: 7 * 60_000, // container kept warm after last request (observed 5–15 min)
};

// List prices, us-east-1, as published October 2026 (see README "Cost model").
export const PRICES = {
  lambdaGbSecond: 0.0000133334,    // arm64
  lambdaPerMillionRequests: 0.20,
  httpApiPerMillion: 1.00,
  ddbPerMillionWru: 0.625,          // on-demand, Standard table class
  ddbPerMillionRru: 0.125,
  ddbStorageGbMonth: 0.25,
  sesPer1000: 0.10,
  stripePercent: 2.9,               // Canada, domestic cards
  stripeFixedCents: 30,
};

export function ddbLatency(rng, rec) {
  const base = MODEL.ddb[rec.op] ?? 6;
  const extra = rec.op === 'TransactWriteItems' ? (rec.keys?.length || 1) * MODEL.ddb.perTransactItemMs : 0;
  return rng ? rng.lognormal(base, MODEL.ddbSigma) + extra : base + extra;
}

export function coldInit(rng) {
  return rng ? rng.lognormal(MODEL.coldInitMedianMs, MODEL.coldInitSigma) : MODEL.coldInitMedianMs;
}

/** Monthly bill for a usage summary. All results in US dollars. */
export function monthlyCost(u) {
  const lambda = u.lambdaGbSeconds * PRICES.lambdaGbSecond + (u.lambdaRequests / 1e6) * PRICES.lambdaPerMillionRequests;
  const api = (u.apiRequests / 1e6) * PRICES.httpApiPerMillion;
  const ddb = (u.wru / 1e6) * PRICES.ddbPerMillionWru + (u.rru / 1e6) * PRICES.ddbPerMillionRru + (u.storageGb || 0) * PRICES.ddbStorageGbMonth;
  const ses = (u.emails / 1000) * PRICES.sesPer1000;
  return { lambda, api, ddb, ses, total: lambda + api + ddb + ses };
}
