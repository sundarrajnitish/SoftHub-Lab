import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalIdentity, signJwt, verifyJwt, decodeJwt, principalFromClaims, checkPassword } from '../packages/core/src/auth.js';
import { createMemoryMailer } from '../packages/core/src/adapters/memory.js';
import { manualClock, createRng } from '../packages/core/src/util.js';
import { base64url } from '../packages/core/src/crypto.js';

function pool() {
  const clock = manualClock();
  const mailer = createMemoryMailer({ clock });
  const confirmed = [];
  const id = createLocalIdentity({ clock, random: createRng(3).next, mailer, onConfirmed: (u) => confirmed.push(u) });
  return { clock, mailer, id, confirmed };
}

test('sign-up → e-mail code → confirm → sign-in, with the requested self-service group', async () => {
  const { id, mailer, confirmed } = pool();
  await id.signUp({ email: 'Ana@Example.com', password: 'Passw0rdX', role: 'Provider' });
  await assert.rejects(id.signIn({ email: 'ana@example.com', password: 'Passw0rdX' }), /Confirm your e-mail/);
  const code = mailer.inbox('ana@example.com')[0].code;
  await assert.rejects(id.confirm({ email: 'ana@example.com', code: '000000' === code ? '111111' : '000000' }), /Wrong verification code/);
  await id.confirm({ email: 'ana@example.com', code });
  assert.deepEqual(confirmed.map((u) => u.group), ['Provider']);
  const tokens = await id.signIn({ email: 'ANA@example.com', password: 'Passw0rdX' });
  const claims = id.verify(tokens.accessToken);
  assert.deepEqual(principalFromClaims(claims).groups, ['Provider']);
});

test('nobody can sign themselves up as Admin; weak passwords are refused', async () => {
  const { id } = pool();
  await assert.rejects(id.signUp({ email: 'x@example.com', password: 'Passw0rdX', role: 'Admin' }), /Consumer or Provider/);
  await assert.rejects(id.signUp({ email: 'x@example.com', password: 'short', role: 'Consumer' }), /Password needs/);
  assert.deepEqual(checkPassword('alllowercase1'), ['an upper-case letter']);
});

test('unknown user and wrong password give the same error (no enumeration)', async () => {
  const { id } = pool();
  await id.seed({ email: 'a@example.com', password: 'Passw0rdX', group: 'Consumer' });
  const e1 = await id.signIn({ email: 'nobody@example.com', password: 'x' }).catch((e) => e);
  const e2 = await id.signIn({ email: 'a@example.com', password: 'wrong' }).catch((e) => e);
  assert.equal(e1.message, e2.message);
  assert.equal(e1.status, 401);
});

test('token verification: tampering, algorithm swap, expiry, audience, token_use', async () => {
  const { id, clock } = pool();
  await id.seed({ email: 'b@example.com', password: 'Passw0rdX', group: 'Consumer' });
  const { accessToken, idToken } = await id.signIn({ email: 'b@example.com', password: 'Passw0rdX' });
  assert.ok(id.verify(accessToken));

  // privilege escalation attempt: edit the groups claim, keep the signature
  const t = decodeJwt(accessToken);
  const forged = `${t.signingInput.split('.')[0]}.${base64url(JSON.stringify({ ...t.payload, 'cognito:groups': ['Admin'] }))}.${t.signature}`;
  assert.throws(() => id.verify(forged), /signature/);

  // "alg: none"
  const none = `${base64url(JSON.stringify({ alg: 'none' }))}.${base64url(JSON.stringify(t.payload))}.`;
  assert.throws(() => id.verify(none), /algorithm|Malformed/);

  // an ID token is not an access token
  assert.throws(() => id.verify(idToken), /access token/);

  // signed with another key / for another client
  const opts = { secret: 'local-dev-signing-key', issuer: id.issuer, clientId: id.clientId, now: clock.now() };
  assert.throws(() => verifyJwt(signJwt({ ...t.payload, client_id: 'evil' }, opts.secret), opts), /another app/);

  clock.advance(2 * 3600_000);
  assert.throws(() => id.verify(accessToken), /expired/);
});

test('API Gateway passes list claims as strings; principal parsing handles both', () => {
  assert.deepEqual(principalFromClaims({ sub: 's', 'cognito:groups': '[Consumer Provider]' }).groups, ['Consumer', 'Provider']);
  assert.deepEqual(principalFromClaims({ sub: 's', 'cognito:groups': ['Admin', 'Hacker'] }).groups, ['Admin']);
  assert.equal(principalFromClaims({}), null);
});
