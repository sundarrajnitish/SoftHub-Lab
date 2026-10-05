import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLicenseKey, isWellFormedKey, verifyLicenseKey, normaliseKey } from '../packages/core/src/license.js';
import { CROCKFORD } from '../packages/core/src/util.js';

const P = { orderId: 'ord_01ABC', productId: 'prd_01XYZ', sub: 'user-1' };

test('keys are deterministic, well-formed and bound to the purchase', () => {
  const k = generateLicenseKey('s3cret', P);
  assert.match(k, /^SHUB-([0-9A-HJKMNP-TV-Z]{5}-){3}[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(generateLicenseKey('s3cret', P), k, 'webhook retries must yield the same key');
  assert.ok(isWellFormedKey(k));
  assert.ok(verifyLicenseKey('s3cret', k, P));
  assert.ok(!verifyLicenseKey('s3cret', k, { ...P, sub: 'user-2' }));
  assert.ok(!verifyLicenseKey('other', k, P));
  assert.ok(verifyLicenseKey('s3cret', k.toLowerCase().replace(/-/g, ' '), P), 'case and separators do not matter');
});

test('every single-character typo and every adjacent swap is detected offline', () => {
  for (let n = 0; n < 40; n++) {
    const key = normaliseKey(generateLicenseKey('s', { ...P, orderId: `ord_${n}` }));
    for (let i = 0; i < key.length; i++) {
      for (const ch of CROCKFORD) {
        if (ch === key[i]) continue;
        const bad = key.slice(0, i) + ch + key.slice(i + 1);
        assert.ok(!isWellFormedKey(bad), `substitution at ${i} → ${ch} undetected`);
      }
      if (i + 1 < key.length && key[i] !== key[i + 1]) {
        const swapped = key.slice(0, i) + key[i + 1] + key[i] + key.slice(i + 2);
        assert.ok(!isWellFormedKey(swapped), `swap at ${i} undetected`);
      }
    }
  }
});

test('look-alike characters are normalised (O→0, I/L→1)', () => {
  assert.equal(normaliseKey('shub-o1il-'), '0111');
});
