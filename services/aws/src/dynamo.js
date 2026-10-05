// DynamoDB adapter: the table port (packages/core/src/store.js) on AWS.
//
// Conditions and updates are written as small data structures in the core;
// this module turns them into DynamoDB expression strings with placeholder
// names/values, so attribute names never collide with reserved words and no
// value is ever spliced into an expression.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand,
  BatchGetCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionFailed, INDEXES, encodeCursor, decodeCursor } from '../../../packages/core/src/store.js';

/** Collects #n / :v placeholders for one expression set. */
export function createExpr() {
  const names = {};
  const values = {};
  let n = 0, v = 0;
  return {
    name(attr) {
      const found = Object.entries(names).find(([, a]) => a === attr);
      if (found) return found[0];
      const k = `#n${n++}`; names[k] = attr; return k;
    },
    value(val) { const k = `:v${v++}`; values[k] = val; return k; },
    names, values,
  };
}

const OPS = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

export function conditionExpression(condition, ex) {
  if (!condition) return undefined;
  const clauses = Array.isArray(condition) ? condition : [condition];
  const parts = clauses.map((c) => {
    if (c.any) return `(${c.any.map((s) => conditionExpression(s, ex)).join(' OR ')})`;
    if ('exists' in c) return c.exists ? `attribute_exists(${ex.name('PK')})` : `attribute_not_exists(${ex.name('PK')})`;
    const a = ex.name(c.attr);
    if (c.missing) return `attribute_not_exists(${a})`;
    if ('in' in c) return `${a} IN (${c.in.map((x) => ex.value(x)).join(', ')})`;
    for (const [op, sym] of Object.entries(OPS)) if (op in c) return `${a} ${sym} ${ex.value(c[op])}`;
    throw new Error(`unsupported clause ${JSON.stringify(c)}`);
  });
  return parts.join(' AND ');
}

export function updateExpression({ set = {}, add = {}, remove = [] }, ex) {
  const sets = Object.entries(set).filter(([, v]) => v !== undefined).map(([k, v]) => `${ex.name(k)} = ${ex.value(v)}`);
  const adds = Object.entries(add).map(([k, v]) => `${ex.name(k)} ${ex.value(v)}`);
  const rems = remove.map((k) => ex.name(k));
  return [
    sets.length ? `SET ${sets.join(', ')}` : '',
    adds.length ? `ADD ${adds.join(', ')}` : '',
    rems.length ? `REMOVE ${rems.join(', ')}` : '',
  ].filter(Boolean).join(' ');
}

export function keyCondition(def, pk, sk, ex) {
  let expr = `${ex.name(def.pk)} = ${ex.value(pk)}`;
  if (sk) {
    const s = ex.name(def.sk);
    if (sk.eq !== undefined) expr += ` AND ${s} = ${ex.value(sk.eq)}`;
    else if (sk.beginsWith !== undefined) expr += ` AND begins_with(${s}, ${ex.value(sk.beginsWith)})`;
    else if (sk.between) expr += ` AND ${s} BETWEEN ${ex.value(sk.between[0])} AND ${ex.value(sk.between[1])}`;
    else for (const [op, sym] of Object.entries(OPS)) if (op in sk && op !== 'ne') expr += ` AND ${s} ${sym} ${ex.value(sk[op])}`;
  }
  return expr;
}

const attach = (params, ex) => {
  if (Object.keys(ex.names).length) params.ExpressionAttributeNames = ex.names;
  if (Object.keys(ex.values).length) params.ExpressionAttributeValues = ex.values;
  return params;
};

function translate(err, keys) {
  if (err.name === 'ConditionalCheckFailedException') return new ConditionFailed([{ key: keys[0], code: 'ConditionalCheckFailed' }]);
  if (err.name === 'TransactionCanceledException') {
    const reasons = (err.CancellationReasons || []).map((r, i) => ({ key: keys[i], code: r.Code || 'None' }));
    if (reasons.some((r) => r.code === 'ConditionalCheckFailed')) return new ConditionFailed(reasons);
  }
  return err;
}

export function createDynamoTable({ tableName, client = null, region = process.env.AWS_REGION } = {}) {
  const doc = client || DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  return {
    name: tableName,
    async get(key, { consistent = false } = {}) {
      const r = await doc.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: consistent }));
      return r.Item || null;
    },
    async batchGet(keys) {
      const out = [];
      for (let i = 0; i < keys.length; i += 100) {
        let request = { [tableName]: { Keys: keys.slice(i, i + 100) } };
        for (let attempt = 0; request && Object.keys(request).length && attempt < 5; attempt++) {
          const r = await doc.send(new BatchGetCommand({ RequestItems: request }));
          out.push(...(r.Responses?.[tableName] || []));
          request = r.UnprocessedKeys && Object.keys(r.UnprocessedKeys).length ? r.UnprocessedKeys : null;
          if (request) await new Promise((res) => setTimeout(res, 2 ** attempt * 25));
        }
      }
      return out;
    },
    async put(item, { condition } = {}) {
      const ex = createExpr();
      const params = attach({ TableName: tableName, Item: item, ConditionExpression: conditionExpression(condition, ex) }, ex);
      try { await doc.send(new PutCommand(params)); } catch (e) { throw translate(e, [{ PK: item.PK, SK: item.SK }]); }
      return item;
    },
    async update(key, spec = {}) {
      const ex = createExpr();
      const params = attach({
        TableName: tableName, Key: key, UpdateExpression: updateExpression(spec, ex),
        ConditionExpression: conditionExpression(spec.condition, ex), ReturnValues: 'ALL_NEW',
      }, ex);
      try { return (await doc.send(new UpdateCommand(params))).Attributes; } catch (e) { throw translate(e, [key]); }
    },
    async delete(key, { condition } = {}) {
      const ex = createExpr();
      const params = attach({ TableName: tableName, Key: key, ConditionExpression: conditionExpression(condition, ex), ReturnValues: 'ALL_OLD' }, ex);
      try { return (await doc.send(new DeleteCommand(params))).Attributes || null; } catch (e) { throw translate(e, [key]); }
    },
    async query({ index = 'base', pk, sk, desc = false, limit = 50, cursor = null, consistent = false }) {
      const def = INDEXES[index];
      const ex = createExpr();
      const params = attach({
        TableName: tableName, IndexName: index === 'base' ? undefined : index,
        KeyConditionExpression: keyCondition(def, pk, sk, ex), ScanIndexForward: !desc, Limit: limit,
        ConsistentRead: index === 'base' ? consistent : undefined, ExclusiveStartKey: decodeCursor(cursor) || undefined,
      }, ex);
      const r = await doc.send(new QueryCommand(params));
      return { items: r.Items || [], cursor: r.LastEvaluatedKey ? encodeCursor(r.LastEvaluatedKey) : null };
    },
    async transact(ops) {
      const keys = [];
      const items = ops.map((op) => {
        const ex = createExpr();
        if (op.put) {
          keys.push({ PK: op.put.item.PK, SK: op.put.item.SK });
          return { Put: attach({ TableName: tableName, Item: op.put.item, ConditionExpression: conditionExpression(op.put.condition, ex) }, ex) };
        }
        if (op.update) {
          keys.push(op.update.key);
          return { Update: attach({ TableName: tableName, Key: op.update.key, UpdateExpression: updateExpression(op.update, ex), ConditionExpression: conditionExpression(op.update.condition, ex) }, ex) };
        }
        if (op.delete) {
          keys.push(op.delete.key);
          return { Delete: attach({ TableName: tableName, Key: op.delete.key, ConditionExpression: conditionExpression(op.delete.condition, ex) }, ex) };
        }
        keys.push(op.check.key);
        return { ConditionCheck: attach({ TableName: tableName, Key: op.check.key, ConditionExpression: conditionExpression(op.check.condition, ex) }, ex) };
      });
      try { await doc.send(new TransactWriteCommand({ TransactItems: items })); } catch (e) { throw translate(e, keys); }
    },
  };
}
