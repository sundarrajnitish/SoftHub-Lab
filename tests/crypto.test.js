import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { sha256, hmacSha256, toHex, base64url, base64urlDecode, safeEqual } from '../packages/core/src/crypto.js';

test('sha256 matches node:crypto for many lengths', () => {
  for (let len = 0; len < 300; len += 7) {
    const buf = randomBytes(len);
    assert.equal(toHex(sha256(new Uint8Array(buf))), createHash('sha256').update(buf).digest('hex'));
  }
  assert.equal(toHex(sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('hmac-sha256 matches node:crypto, including keys longer than a block', () => {
  for (const keyLen of [0, 5, 32, 64, 65, 200]) {
    const key = randomBytes(keyLen);
    const msg = randomBytes(90);
    assert.equal(
      toHex(hmacSha256(new Uint8Array(key), new Uint8Array(msg))),
      createHmac('sha256', key).update(msg).digest('hex'),
    );
  }
});

test('base64url round-trips and matches Buffer', () => {
  for (let len = 0; len < 40; len++) {
    const buf = randomBytes(len);
    const enc = base64url(new Uint8Array(buf));
    assert.equal(enc, buf.toString('base64url'));
    assert.deepEqual(Buffer.from(base64urlDecode(enc)), buf);
  }
  assert.throws(() => base64urlDecode('ab$c'));
});

test('safeEqual', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
  assert.ok(!safeEqual('abc', undefined));
});
