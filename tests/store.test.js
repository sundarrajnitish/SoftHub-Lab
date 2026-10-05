import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTable, ConditionFailed, evaluateCondition } from '../packages/core/src/store.js';

const rows = (n, pk = 'P#1') => Array.from({ length: n }, (_, i) => ({ PK: pk, SK: `R#${String(i).padStart(3, '0')}`, i }));

test('conditional put: create-only and version checks', async () => {
  const t = createMemoryTable();
  await t.put({ PK: 'A', SK: 'M', ver: 1 }, { condition: { exists: false } });
  await assert.rejects(t.put({ PK: 'A', SK: 'M', ver: 1 }, { condition: { exists: false } }), ConditionFailed);
  await t.put({ PK: 'A', SK: 'M', ver: 2 }, { condition: { attr: 'ver', eq: 1 } });
  await assert.rejects(t.put({ PK: 'A', SK: 'M', ver: 3 }, { condition: { attr: 'ver', eq: 1 } }), ConditionFailed);
  assert.equal((await t.get({ PK: 'A', SK: 'M' })).ver, 2);
});

test('comparisons on a missing attribute are false, as in DynamoDB', () => {
  assert.equal(evaluateCondition({ attr: 'status', ne: 'ACTIVE' }, { PK: 'x' }), false);
  assert.equal(evaluateCondition({ any: [{ attr: 'status', missing: true }, { attr: 'status', ne: 'ACTIVE' }] }, { PK: 'x' }), true);
  assert.equal(evaluateCondition({ any: [{ exists: false }, { attr: 'status', ne: 'ACTIVE' }] }, null), true);
  assert.equal(evaluateCondition({ attr: 'status', in: ['A', 'B'] }, { status: 'B' }), true);
});

test('update ADD creates and increments atomically; SET/REMOVE', async () => {
  const t = createMemoryTable();
  await t.update({ PK: 'C', SK: 'N' }, { add: { n: 1 } });
  await t.update({ PK: 'C', SK: 'N' }, { add: { n: 2 }, set: { label: 'x' } });
  let it = await t.get({ PK: 'C', SK: 'N' });
  assert.deepEqual([it.n, it.label], [3, 'x']);
  await t.update({ PK: 'C', SK: 'N' }, { remove: ['label'] });
  it = await t.get({ PK: 'C', SK: 'N' });
  assert.equal(it.label, undefined);
  await assert.rejects(t.update({ PK: 'C', SK: 'Z' }, { set: { a: 1 }, condition: { exists: true } }), ConditionFailed);
});

test('transactions are all-or-nothing and report per-item reasons', async () => {
  const t = createMemoryTable();
  await t.put({ PK: 'O', SK: 'M', status: 'PAID' });
  await assert.rejects(
    t.transact([
      { put: { item: { PK: 'E', SK: 'M' } } },
      { update: { key: { PK: 'O', SK: 'M' }, set: { status: 'PAID' }, condition: { attr: 'status', eq: 'PENDING' } } },
    ]),
    (e) => e instanceof ConditionFailed && e.details.reasons[0].code === 'None' && e.details.reasons[1].code === 'ConditionalCheckFailed',
  );
  assert.equal(await t.get({ PK: 'E', SK: 'M' }), null, 'first write must not have been applied');
  await assert.rejects(t.transact([{ put: { item: { PK: 'X', SK: '1' } } }, { delete: { key: { PK: 'X', SK: '1' } } }]), /twice/);
  await assert.rejects(t.transact(Array.from({ length: 101 }, (_, i) => ({ put: { item: { PK: 'X', SK: `${i}` } } }))), /100/);
});

test('range queries: begins_with, between, descending, pagination with cursors', async () => {
  const t = createMemoryTable();
  t._load(rows(25));
  t._load(rows(3, 'P#2'));
  const all = [];
  let cursor = null;
  do {
    const page = await t.query({ pk: 'P#1', sk: { beginsWith: 'R#' }, limit: 10, cursor });
    all.push(...page.items.map((r) => r.i));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(all, [...Array(25).keys()]);
  const desc = await t.query({ pk: 'P#1', desc: true, limit: 3 });
  assert.deepEqual(desc.items.map((r) => r.i), [24, 23, 22]);
  const btw = await t.query({ pk: 'P#1', sk: { between: ['R#005', 'R#007'] } });
  assert.deepEqual(btw.items.map((r) => r.i), [5, 6, 7]);
  await assert.rejects(t.query({ pk: 'P#1', cursor: 'not-a-cursor' }), /Invalid cursor/);
});

test('GSIs are maintained on write, update and delete', async () => {
  const t = createMemoryTable();
  await t.put({ PK: 'PRODUCT#1', SK: 'META', GSI1PK: 'CAT#games', GSI1SK: 'b#1' });
  await t.put({ PK: 'PRODUCT#2', SK: 'META', GSI1PK: 'CAT#games', GSI1SK: 'a#2' });
  let q = await t.query({ index: 'GSI1', pk: 'CAT#games' });
  assert.deepEqual(q.items.map((r) => r.PK), ['PRODUCT#2', 'PRODUCT#1']);
  await t.update({ PK: 'PRODUCT#2', SK: 'META' }, { remove: ['GSI1PK', 'GSI1SK'] });
  q = await t.query({ index: 'GSI1', pk: 'CAT#games' });
  assert.deepEqual(q.items.map((r) => r.PK), ['PRODUCT#1']);
  await t.delete({ PK: 'PRODUCT#1', SK: 'META' });
  assert.equal((await t.query({ index: 'GSI1', pk: 'CAT#games' })).items.length, 0);
  await assert.rejects(t.query({ index: 'GSI1', pk: 'CAT#games', consistent: true }), /eventually consistent/);
});

test('capacity accounting follows DynamoDB rules', async () => {
  const ops = [];
  const t = createMemoryTable({ listener: (r) => ops.push(r) });
  await t.put({ PK: 'A', SK: '1', blob: 'x'.repeat(2500) });     // ~2.5 KB → 3 WRU
  await t.get({ PK: 'A', SK: '1' });                             // eventually consistent → 0.5 RRU
  await t.get({ PK: 'A', SK: '1' }, { consistent: true });       // strongly consistent → 1 RRU
  await t.transact([{ put: { item: { PK: 'B', SK: '1' } } }]);    // transactional → 2× WRU
  assert.deepEqual(ops.map((o) => [o.op, o.wru, o.rru]), [
    ['PutItem', 3, 0], ['GetItem', 0, 0.5], ['GetItem', 0, 1], ['TransactWriteItems', 2, 0],
  ]);
  await assert.rejects(t.put({ PK: 'A', SK: '2', blob: 'x'.repeat(410 * 1024) }), /400 KB/);
});

test('streams publish after commit only', async () => {
  const recs = [];
  const t = createMemoryTable({ stream: (r) => recs.push(r) });
  await t.put({ PK: 'A', SK: '1' });
  await t.update({ PK: 'A', SK: '1' }, { set: { x: 1 } });
  await assert.rejects(t.transact([{ put: { item: { PK: 'B', SK: '1' } } }, { put: { item: { PK: 'A', SK: '1' }, condition: { exists: false } } }]));
  await t.delete({ PK: 'A', SK: '1' });
  assert.deepEqual(recs.map((r) => r.eventName), ['INSERT', 'MODIFY', 'REMOVE']);
});
