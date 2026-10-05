import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { createLocalRuntime, createShiftClock } from '../packages/core/src/runtime.js';
import { seedMarketplace } from '../packages/core/src/seedrun.js';
import { audit } from '../packages/core/src/invariants.js';

for (const chaos of [{}, { duplicateRate: 0.3, dropFirstAttemptRate: 0.2, jitterMs: 3000 }]) {
  test(`seeded marketplace passes the full audit (chaos: ${JSON.stringify(chaos)})`, async () => {
    const rt = createLocalRuntime({ clock: createShiftClock(), seed: 11, chaos });
    await seedMarketplace(rt, { orders: 120, shoppers: 40, seed: 5 });
    await rt.settle(24 * 3600_000);
    const a = audit(rt);
    for (const c of a.checks) assert.ok(c.ok, `${c.name}: ${JSON.stringify(c.detail)}`);
    assert.ok(a.counts.paid > 90);
    assert.ok(a.counts.reviews > 20);
  });
}
