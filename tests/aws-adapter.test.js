import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createExpr, conditionExpression, updateExpression, keyCondition, createDynamoTable } from '../services/aws/src/dynamo.js';
import { ConditionFailed, INDEXES } from '../packages/core/src/store.js';
import { ROUTES } from '../packages/core/src/api/app.js';

test('conditions become placeholder expressions (no values spliced in)', () => {
  const ex = createExpr();
  const expr = conditionExpression([{ attr: 'status', in: ['PENDING_PAYMENT', 'CANCELLED'] }, { attr: 'amountCents', eq: 1999 }, { any: [{ exists: false }, { attr: 'status', ne: 'ACTIVE' }] }], ex);
  assert.equal(expr, '#n0 IN (:v0, :v1) AND #n1 = :v2 AND (attribute_not_exists(#n2) OR #n0 <> :v3)');
  assert.deepEqual(ex.names, { '#n0': 'status', '#n1': 'amountCents', '#n2': 'PK' });
  assert.deepEqual(Object.values(ex.values), ['PENDING_PAYMENT', 'CANCELLED', 1999, 'ACTIVE']);
});

test('updates: SET, ADD and REMOVE clauses', () => {
  const ex = createExpr();
  assert.equal(updateExpression({ set: { status: 'PAID', skip: undefined }, add: { buyers: 1 }, remove: ['GSI1PK'] }, ex),
    'SET #n0 = :v0 ADD #n1 :v1 REMOVE #n2');
});

test('key conditions for base table and GSIs', () => {
  const ex = createExpr();
  assert.equal(keyCondition(INDEXES.GSI1, 'USER#1', { beginsWith: 'ORDER#' }, ex), '#n0 = :v0 AND begins_with(#n1, :v1)');
  const ex2 = createExpr();
  assert.equal(keyCondition(INDEXES.base, 'PROVIDER#1', { between: ['SALES#a', 'SALES#b'] }, ex2), '#n0 = :v0 AND #n1 BETWEEN :v1 AND :v2');
});

test('the adapter sends the right commands and maps cancellations to ConditionFailed', async () => {
  const sent = [];
  const fake = {
    async send(cmd) {
      sent.push(cmd);
      if (cmd.constructor.name === 'TransactWriteCommand') {
        const err = new Error('cancelled');
        err.name = 'TransactionCanceledException';
        err.CancellationReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }];
        throw err;
      }
      if (cmd.constructor.name === 'QueryCommand') return { Items: [{ PK: 'a', SK: 'b' }], LastEvaluatedKey: { PK: 'a', SK: 'b' } };
      return {};
    },
  };
  const t = createDynamoTable({ tableName: 'T', client: fake });
  const page = await t.query({ index: 'GSI1', pk: 'CAT#games', desc: true, limit: 5 });
  assert.equal(sent[0].input.IndexName, 'GSI1');
  assert.equal(sent[0].input.ScanIndexForward, false);
  assert.ok(page.cursor);
  await assert.rejects(
    t.transact([{ put: { item: { PK: 'E', SK: 'M' }, condition: { exists: false } } }, { update: { key: { PK: 'O', SK: 'M' }, set: { s: 1 } } }]),
    (e) => e instanceof ConditionFailed && e.details.reasons[1].code === 'ConditionalCheckFailed',
  );
  const tx = sent.at(-1).input.TransactItems;
  assert.equal(tx[0].Put.ConditionExpression, 'attribute_not_exists(#n0)');
  assert.equal(tx[1].Update.UpdateExpression, 'SET #n0 = :v0');
});

test('infra/template.yaml is generated from the route table and up to date', () => {
  execFileSync(process.execPath, ['scripts/gen-template.mjs', '--check'], { cwd: new URL('..', import.meta.url) });
  for (const r of ROUTES) assert.ok(['catalog', 'shop', 'provider', 'admin', 'webhook'].includes(r.fn), r.path);
});
