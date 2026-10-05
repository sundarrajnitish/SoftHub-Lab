// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Identity: roles, JWTs and a local stand-in for the Cognito user pool.
//
// In AWS, Cognito issues RS256 tokens and the API Gateway JWT authorizer
// verifies them before Lambda runs; the handler only reads the verified claims.
// Locally (dev server, tests and the website) `createLocalIdentity` plays the
// user pool: same sign-up → confirm → sign-in flow, same claim names
// (`sub`, `cognito:groups`, `token_use`, `client_id`), HS256 signatures so it
// runs synchronously in a browser.
//
// Roles are Cognito *groups*, assigned server-side by the post-confirmation
// trigger. A user can ask to be a Consumer or a Provider at sign-up; nobody can
// make themselves an Admin, and the role is never read from a user-writable
// attribute.

import { hmacSha256, base64url, base64urlDecode, bytesToString, safeEqual, sha256, toHex } from './crypto.js';
import { AppError, unauthorized, badRequest, conflict } from './util.js';

export const ROLES = ['Consumer', 'Provider', 'Admin'];
export const SELF_SERVICE_ROLES = ['Consumer', 'Provider'];

/** Map verified JWT claims to the principal handlers see. */
export function principalFromClaims(claims) {
  if (!claims || !claims.sub) return null;
  let groups = claims['cognito:groups'] ?? [];
  if (typeof groups === 'string') {
    // API Gateway passes list claims as "[a b]" strings
    groups = groups.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  }
  return { sub: claims.sub, groups: groups.filter((g) => ROLES.includes(g)), email: claims.email || null };
}

export const hasRole = (principal, role) => !!principal && principal.groups.includes(role);

// ---------------------------------------------------------------- JWT (HS256)

export function signJwt(payload, secret, header = { alg: 'HS256', typ: 'JWT' }) {
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const sig = base64url(hmacSha256(secret, `${h}.${p}`));
  return `${h}.${p}.${sig}`;
}

export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw unauthorized('Malformed token');
  try {
    return {
      header: JSON.parse(bytesToString(base64urlDecode(parts[0]))),
      payload: JSON.parse(bytesToString(base64urlDecode(parts[1]))),
      signature: parts[2],
      signingInput: `${parts[0]}.${parts[1]}`,
    };
  } catch {
    throw unauthorized('Malformed token');
  }
}

/**
 * Verify an HS256 token the way the API Gateway JWT authorizer verifies an
 * RS256 one: algorithm pinned, signature, issuer, audience/client, token_use,
 * expiry and not-before with a small clock-skew allowance.
 */
export function verifyJwt(token, { secret, issuer, clientId, now, skewSec = 30 }) {
  const t = decodeJwt(token);
  if (t.header.alg !== 'HS256') throw unauthorized('Unexpected token algorithm');
  const expected = base64url(hmacSha256(secret, t.signingInput));
  if (!safeEqual(expected, t.signature)) throw unauthorized('Bad token signature');
  const c = t.payload;
  const nowSec = Math.floor(now / 1000);
  if (c.iss !== issuer) throw unauthorized('Wrong issuer');
  if (c.token_use !== 'access') throw unauthorized('An access token is required');
  if (c.client_id !== clientId) throw unauthorized('Token was issued to another app');
  if (typeof c.exp !== 'number' || nowSec > c.exp + skewSec) throw unauthorized('Token expired');
  if (typeof c.nbf === 'number' && nowSec + skewSec < c.nbf) throw unauthorized('Token not yet valid');
  return c;
}

// ---------------------------------------------------------- local user pool

export const PASSWORD_POLICY = { minLength: 8, upper: true, lower: true, digit: true };

export function checkPassword(pw) {
  const problems = [];
  if (typeof pw !== 'string' || pw.length < PASSWORD_POLICY.minLength) problems.push('at least 8 characters');
  if (!/[A-Z]/.test(pw || '')) problems.push('an upper-case letter');
  if (!/[a-z]/.test(pw || '')) problems.push('a lower-case letter');
  if (!/[0-9]/.test(pw || '')) problems.push('a digit');
  return problems;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function hashPassword(password, salt) {
  // Simulator only: iterated, salted SHA-256. Real passwords never leave Cognito (SRP).
  let h = sha256(`${salt}:${password}`);
  for (let i = 0; i < 64; i++) h = sha256(h);
  return toHex(h);
}

/**
 * A local user pool. `onConfirmed(user)` is the post-confirmation trigger;
 * `mailer.send()` delivers verification codes.
 */
export function createLocalIdentity({
  clock, random = Math.random, secret = 'local-dev-signing-key', issuer = 'https://local.softhub/pool',
  clientId = 'softhub-web', mailer = null, onConfirmed = null, accessTtlSec = 3600,
}) {
  const users = new Map(); // email → user
  const bySub = new Map();
  const uuid = () => {
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 32; i++) s += hex[Math.floor(random() * 16)];
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20)}`;
  };

  function issue(user) {
    const iat = Math.floor(clock.now() / 1000);
    const groups = [...user.groups];
    const access = signJwt({
      sub: user.sub, 'cognito:groups': groups, iss: issuer, client_id: clientId, token_use: 'access',
      scope: 'aws.cognito.signin.user.admin', auth_time: iat, iat, exp: iat + accessTtlSec, jti: uuid(),
    }, secret);
    const id = signJwt({
      sub: user.sub, email: user.email, email_verified: true, 'cognito:groups': groups, iss: issuer,
      aud: clientId, token_use: 'id', auth_time: iat, iat, exp: iat + accessTtlSec,
    }, secret);
    return { accessToken: access, idToken: id, expiresIn: accessTtlSec, tokenType: 'Bearer' };
  }

  const api = {
    issuer, clientId,
    async signUp({ email, password, role = 'Consumer' }) {
      const e = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(e)) throw badRequest('auth.email', 'Enter a valid e-mail address');
      const problems = checkPassword(password);
      if (problems.length) throw badRequest('auth.password', `Password needs ${problems.join(', ')}`);
      if (!SELF_SERVICE_ROLES.includes(role)) throw badRequest('auth.role', 'Choose Consumer or Provider');
      if (users.has(e)) throw conflict('auth.exists', 'An account with this e-mail already exists');
      const salt = uuid();
      const code = String(Math.floor(random() * 1e6)).padStart(6, '0');
      const user = {
        sub: uuid(), email: e, salt, hash: hashPassword(password, salt), confirmed: false,
        code, requestedRole: role, groups: [], enabled: true, created: clock.now(),
      };
      users.set(e, user);
      bySub.set(user.sub, user);
      if (mailer) {
        await mailer.send({
          to: e, subject: 'Your SoftHub verification code', kind: 'verify',
          text: `Your verification code is ${code}`, code,
        });
      }
      return { sub: user.sub, confirmed: false, delivery: 'EMAIL' };
    },

    async confirm({ email, code }) {
      const user = users.get(String(email || '').trim().toLowerCase());
      if (!user) throw badRequest('auth.unknown', 'No such account');
      if (user.confirmed) return { confirmed: true };
      if (String(code) !== user.code) throw badRequest('auth.code', 'Wrong verification code');
      user.confirmed = true;
      // post-confirmation trigger: put the user in the group they asked for
      user.groups = [user.requestedRole];
      if (onConfirmed) await onConfirmed({ sub: user.sub, email: user.email, group: user.requestedRole });
      return { confirmed: true };
    },

    async signIn({ email, password }) {
      const user = users.get(String(email || '').trim().toLowerCase());
      // Same error for unknown user and wrong password: no account enumeration.
      if (!user || user.hash !== hashPassword(String(password || ''), user.salt)) {
        throw new AppError(401, 'auth.credentials', 'Incorrect e-mail or password');
      }
      if (!user.confirmed) throw new AppError(403, 'auth.unconfirmed', 'Confirm your e-mail first');
      if (!user.enabled) throw new AppError(403, 'auth.disabled', 'This account is suspended');
      return issue(user);
    },

    verify(token) {
      return verifyJwt(token, { secret, issuer, clientId, now: clock.now() });
    },

    // admin side (AdminAddUserToGroup / AdminDisableUser equivalents)
    async adminAddToGroup(sub, group) {
      const u = bySub.get(sub);
      if (!u) throw badRequest('auth.unknown', 'No such user');
      if (!u.groups.includes(group)) u.groups.push(group);
    },
    async adminSetEnabled(sub, enabled) {
      const u = bySub.get(sub);
      if (u) u.enabled = enabled;
    },
    /** Seed a confirmed user directly (demo accounts, tests). */
    async seed({ email, password, group, sub }) {
      const salt = uuid();
      const user = {
        sub: sub || uuid(), email, salt, hash: hashPassword(password, salt), confirmed: true,
        code: null, requestedRole: group, groups: [group], enabled: true, created: clock.now(),
      };
      users.set(email, user);
      bySub.set(user.sub, user);
      if (onConfirmed) await onConfirmed({ sub: user.sub, email, group });
      return user.sub;
    },
    _user: (email) => users.get(email),
    _secret: secret,
  };
  return api;
}
