// One interface, two backends.
//
//   AWS mode    (VITE_API_URL set)  fetch → API Gateway, Cognito user pool, Stripe.js
//   Local mode  (no VITE_API_URL)   the same core API running in this tab, seeded
//                                   with a demo marketplace; nothing leaves the browser
//
// Pages only ever call `backend.api`, `backend.auth` and `backend.pay`.

const env = import.meta.env;
export const MODE = env.VITE_API_URL ? 'aws' : 'local';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.fields = body?.error?.fields;
  }
}

function toQuery(q = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ------------------------------------------------------------------ AWS

async function awsBackend() {
  const { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserAttribute } = await import('amazon-cognito-identity-js');
  const pool = new CognitoUserPool({ UserPoolId: env.VITE_USER_POOL_ID, ClientId: env.VITE_USER_POOL_CLIENT_ID });
  let session = null;

  const currentSession = () => new Promise((resolve) => {
    const u = pool.getCurrentUser();
    if (!u) return resolve(null);
    u.getSession((err, s) => resolve(err || !s?.isValid() ? null : s)); // refreshes when needed
  });

  async function token() {
    session = await currentSession();
    return session ? session.getAccessToken().getJwtToken() : null;
  }

  async function request(method, path, { query, body, headers = {} } = {}) {
    const t = await token();
    const res = await fetch(`${env.VITE_API_URL}${path}${toQuery(query)}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  const user = (email) => new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool });
  const cb = (resolve, reject) => (err, r) => (err ? reject(new ApiError(400, { error: { message: err.message } })) : resolve(r));

  const auth = {
    async current() {
      const s = await currentSession();
      if (!s) return null;
      const p = s.getIdToken().decodePayload();
      return { sub: p.sub, email: p.email, groups: p['cognito:groups'] || [] };
    },
    signUp: ({ email, password, role }) => new Promise((resolve, reject) => {
      sessionStorage.setItem('softhub.role', role); // passed to the post-confirmation trigger at confirm time
      pool.signUp(email.trim().toLowerCase(), password, [new CognitoUserAttribute({ Name: 'email', Value: email.trim().toLowerCase() })], null, cb(resolve, reject));
    }),
    confirm: ({ email, code }) => new Promise((resolve, reject) => {
      user(email).confirmRegistration(code, true, cb(resolve, reject), { role: sessionStorage.getItem('softhub.role') || 'Consumer' });
    }),
    signIn: ({ email, password }) => new Promise((resolve, reject) => {
      user(email).authenticateUser(new AuthenticationDetails({ Username: email.trim().toLowerCase(), Password: password }), {
        onSuccess: () => resolve(auth.current()),
        onFailure: (err) => reject(new ApiError(401, { error: { message: err.message } })),
      });
    }),
    async signOut() { pool.getCurrentUser()?.signOut(); },
    async token() { return token(); },
  };

  const { loadStripe } = await import('@stripe/stripe-js');
  const stripePromise = loadStripe(env.VITE_STRIPE_PUBLISHABLE_KEY);
  return { mode: 'aws', request, auth, stripePromise };
}

// ---------------------------------------------------------------- local

async function localBackend() {
  const { createLocalRuntime, createShiftClock } = await import('@core/runtime.js');
  const { seedMarketplace } = await import('@core/seedrun.js');
  const { DEMO_ACCOUNTS } = await import('@core/seed.js');
  const rt = createLocalRuntime({ clock: createShiftClock(), seed: 42 });
  await seedMarketplace(rt, { orders: 200, shoppers: 60, reviewRate: 0.5 });
  rt.scheduler.setLive(true); // webhooks and e-mails now arrive in real time
  let tokens = null;
  let me = null;

  async function request(method, path, { query, body, headers = {} } = {}) {
    const r = await rt.request({ method, path, query: query || {}, body, headers, token: tokens?.accessToken });
    if (r.status >= 400) throw new ApiError(r.status, r.data);
    return r.data;
  }
  const claims = (t) => JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const auth = {
    async current() { return me; },
    signUp: (x) => rt.identity.signUp(x),
    confirm: (x) => rt.identity.confirm(x),
    async signIn(x) {
      tokens = await rt.identity.signIn(x);
      const p = claims(tokens.idToken);
      me = { sub: p.sub, email: p.email, groups: p['cognito:groups'] };
      return me;
    },
    async signOut() { tokens = null; me = null; },
    async token() { return tokens?.accessToken || null; },
  };
  return { mode: 'local', request, auth, runtime: rt, demoAccounts: DEMO_ACCOUNTS };
}

let backendPromise = null;
export function getBackend() {
  return (backendPromise ||= MODE === 'aws' ? awsBackend() : localBackend());
}

/** Fresh idempotency key per checkout attempt (reused on retries of that attempt). */
export function newIdempotencyKey() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const money = (cents) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
