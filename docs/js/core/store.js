// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Table port + an in-memory DynamoDB emulator.
//
// The marketplace keeps everything in ONE DynamoDB table (single-table design).
// Handlers talk to the table through the small, explicit API below; the same
// calls are translated to DynamoDB expressions by services/aws/src/dynamo.js.
//
//   get(key, {consistent})                         → item | null
//   put(item, {condition})                         → item
//   update(key, {set, add, remove, condition})     → item (ALL_NEW)
//   delete(key, {condition})                       → old item | null
//   query({index, pk, sk, desc, limit, cursor})    → {items, cursor}
//   batchGet(keys)                                 → items (missing keys skipped)
//   transact([{put}|{update}|{delete}|{check}])    → all-or-nothing, ≤ 100 items
//
// Conditions are lists of clauses (AND):
//   {exists: false}                 attribute_not_exists(PK)  (item must be new)
//   {exists: true}                  attribute_exists(PK)
//   {attr, eq|ne|lt|lte|gt|gte: v}  comparison
//   {attr, in: [..]}                IN
//   {attr, missing: true}           attribute_not_exists(attr)
//   {any: [clause, ...]}            OR of clauses
// As in DynamoDB, a comparison on a missing attribute is false (even `ne`).
//
// The emulator reproduces the parts of DynamoDB the design depends on:
// conditional writes, atomic ADD counters, transactions that fail as a unit with
// per-item cancellation reasons, sorted range queries on the base table and two
// GSIs, 1 MB-free pagination with opaque cursors, the 400 KB item limit, and
// read/write capacity accounting (1 KB per WRU, 4 KB per RRU, ×2 transactional,
// ×0.5 eventually-consistent reads) so costs can be measured.

import { AppError, deepClone } from './util.js';
import { base64url, base64urlDecode, bytesToString } from './crypto.js';

export class ConditionFailed extends AppError {
  constructor(reasons) {
    super(409, 'store.condition_failed', 'Conditional check failed', { reasons });
    this.name = 'ConditionFailed';
  }
}

export const INDEXES = {
  base: { pk: 'PK', sk: 'SK' },
  GSI1: { pk: 'GSI1PK', sk: 'GSI1SK' },
  GSI2: { pk: 'GSI2PK', sk: 'GSI2SK' },
};

const MAX_ITEM_BYTES = 400 * 1024;

export function itemSize(item) {
  // DynamoDB counts UTF-8 bytes of attribute names and values; JSON length is a
  // close, slightly conservative stand-in.
  return new TextEncoder().encode(JSON.stringify(item)).length;
}

const wruFor = (bytes) => Math.max(1, Math.ceil(bytes / 1024));
const rruFor = (bytes) => Math.max(1, Math.ceil(bytes / 4096));

/** Evaluate a condition (list of clauses) against an item (or null). */
export function evaluateCondition(condition, item) {
  if (!condition) return true;
  const clauses = Array.isArray(condition) ? condition : [condition];
  return clauses.every((c) => {
    if (c.any) return c.any.some((sub) => evaluateCondition(sub, item));
    if ('exists' in c) return c.exists ? !!item : !item;
    const v = item ? item[c.attr] : undefined;
    if (c.missing) return v === undefined;
    if (v === undefined) return false;
    if ('eq' in c) return v === c.eq;
    if ('ne' in c) return v !== c.ne;
    if ('in' in c) return c.in.includes(v);
    if ('lt' in c) return v < c.lt;
    if ('lte' in c) return v <= c.lte;
    if ('gt' in c) return v > c.gt;
    if ('gte' in c) return v >= c.gte;
    throw new Error(`bad condition clause ${JSON.stringify(c)}`);
  });
}

/** Apply an UpdateItem-style change. Returns the new item. */
export function applyUpdate(existing, key, { set = {}, add = {}, remove = [] } = {}) {
  const item = existing ? { ...existing } : { ...key };
  for (const [k, v] of Object.entries(set)) {
    if (k === 'PK' || k === 'SK') throw new Error('cannot update key attributes');
    if (v === undefined) continue;
    item[k] = deepClone(v);
  }
  for (const [k, n] of Object.entries(add)) {
    if (typeof n !== 'number') throw new Error('ADD needs a number');
    const cur = item[k] ?? 0;
    if (typeof cur !== 'number') throw new Error(`ADD on non-number ${k}`);
    item[k] = cur + n;
  }
  for (const k of remove) delete item[k];
  return item;
}

function skMatches(sk, cond) {
  if (!cond) return true;
  if (sk === undefined) return false;
  if (cond.eq !== undefined) return sk === cond.eq;
  if (cond.beginsWith !== undefined) return sk.startsWith(cond.beginsWith);
  if (cond.between) return sk >= cond.between[0] && sk <= cond.between[1];
  if (cond.gte !== undefined) return sk >= cond.gte;
  if (cond.lte !== undefined) return sk <= cond.lte;
  if (cond.gt !== undefined) return sk > cond.gt;
  if (cond.lt !== undefined) return sk < cond.lt;
  return true;
}

export const encodeCursor = (key) => (key ? base64url(JSON.stringify(key)) : null);
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const k = JSON.parse(bytesToString(base64urlDecode(cursor)));
    if (!k || typeof k.PK !== 'string' || typeof k.SK !== 'string') throw new Error();
    return k;
  } catch {
    throw new AppError(400, 'validation', 'Invalid cursor');
  }
}

const keyOf = (pk, sk) => `${pk}\u0000${sk}`;

/**
 * In-memory table. `listener(op)` receives one record per operation:
 *   {op, index, pk, keys, items, rru, wru}
 * which the website turns into the "under the hood" trace and the simulator
 * turns into a bill.
 */
export function createMemoryTable({ name = 'softhub', listener = null, stream = null } = {}) {
  const items = new Map(); // primary key → item
  const parts = { base: new Map(), GSI1: new Map(), GSI2: new Map() }; // pk → Set(primary key)
  let failNext = null; // fault injection: (opName) => Error | null

  const emit = (rec) => { if (listener) listener({ table: name, ...rec }); };
  // DynamoDB Streams emulation: change records are buffered during an operation
  // and published after it commits (a failed transaction publishes nothing).
  let pending = [];
  const publish = () => {
    const recs = pending; pending = [];
    if (stream) for (const r of recs) stream(r);
  };

  function index(item, add) {
    for (const [idx, def] of Object.entries(INDEXES)) {
      const pk = item[def.pk];
      if (pk === undefined || item[def.sk] === undefined) continue;
      let set = parts[idx].get(pk);
      if (add) {
        if (!set) parts[idx].set(pk, (set = new Set()));
        set.add(keyOf(item.PK, item.SK));
      } else if (set) {
        set.delete(keyOf(item.PK, item.SK));
        if (!set.size) parts[idx].delete(pk);
      }
    }
  }

  function write(item) {
    const k = keyOf(item.PK, item.SK);
    const old = items.get(k);
    if (old) index(old, false);
    const size = itemSize(item);
    if (size > MAX_ITEM_BYTES) throw new AppError(400, 'store.item_too_large', 'Item exceeds 400 KB');
    const copy = deepClone(item);
    items.set(k, copy);
    index(copy, true);
    pending.push({ eventName: old ? 'MODIFY' : 'INSERT', keys: { PK: item.PK, SK: item.SK },
      newImage: deepClone(copy), oldImage: old ? deepClone(old) : null });
    return Math.max(size, old ? itemSize(old) : 0);
  }

  function remove(key) {
    const k = keyOf(key.PK, key.SK);
    const old = items.get(k);
    if (old) {
      index(old, false); items.delete(k);
      pending.push({ eventName: 'REMOVE', keys: { PK: key.PK, SK: key.SK }, newImage: null, oldImage: deepClone(old) });
    }
    return old;
  }

  function checkKey(key) {
    if (!key || typeof key.PK !== 'string' || typeof key.SK !== 'string' || !key.PK || !key.SK) {
      throw new Error(`invalid key ${JSON.stringify(key)}`);
    }
  }

  function maybeFail(op) {
    if (!failNext) return;
    const err = failNext(op);
    if (err) throw err;
  }

  const api = {
    name,
    async get(key, { consistent = false } = {}) {
      checkKey(key);
      maybeFail('get');
      const it = items.get(keyOf(key.PK, key.SK));
      const rru = rruFor(it ? itemSize(it) : 1) * (consistent ? 1 : 0.5);
      emit({ op: 'GetItem', pk: key.PK, keys: [key], items: it ? 1 : 0, rru, wru: 0 });
      return it ? deepClone(it) : null;
    },

    async batchGet(keys) {
      maybeFail('batchGet');
      const out = [];
      let bytes = 0;
      for (const key of keys) {
        checkKey(key);
        const it = items.get(keyOf(key.PK, key.SK));
        if (it) { out.push(deepClone(it)); bytes += rruFor(itemSize(it)) * 0.5; } else bytes += 0.5;
      }
      emit({ op: 'BatchGetItem', pk: keys[0]?.PK, keys, items: out.length, rru: bytes, wru: 0 });
      return out;
    },

    async put(item, { condition } = {}) {
      checkKey(item);
      maybeFail('put');
      const old = items.get(keyOf(item.PK, item.SK)) || null;
      if (!evaluateCondition(condition, old)) {
        emit({ op: 'PutItem', pk: item.PK, keys: [pick(item)], items: 0, rru: 0, wru: 1, failed: true });
        throw new ConditionFailed([{ key: pick(item), code: 'ConditionalCheckFailed' }]);
      }
      const size = write(item);
      emit({ op: 'PutItem', pk: item.PK, keys: [pick(item)], items: 1, rru: 0, wru: wruFor(size) });
      publish();
      return deepClone(item);
    },

    async update(key, spec = {}) {
      checkKey(key);
      maybeFail('update');
      const old = items.get(keyOf(key.PK, key.SK)) || null;
      if (!evaluateCondition(spec.condition, old)) {
        emit({ op: 'UpdateItem', pk: key.PK, keys: [key], items: 0, rru: 0, wru: 1, failed: true });
        throw new ConditionFailed([{ key, code: 'ConditionalCheckFailed' }]);
      }
      const next = applyUpdate(old, pick(key), spec);
      const size = write(next);
      emit({ op: 'UpdateItem', pk: key.PK, keys: [key], items: 1, rru: 0, wru: wruFor(size) });
      publish();
      return deepClone(next);
    },

    async delete(key, { condition } = {}) {
      checkKey(key);
      maybeFail('delete');
      const old = items.get(keyOf(key.PK, key.SK)) || null;
      if (!evaluateCondition(condition, old)) {
        emit({ op: 'DeleteItem', pk: key.PK, keys: [key], items: 0, rru: 0, wru: 1, failed: true });
        throw new ConditionFailed([{ key, code: 'ConditionalCheckFailed' }]);
      }
      remove(key);
      emit({ op: 'DeleteItem', pk: key.PK, keys: [key], items: old ? 1 : 0, rru: 0, wru: wruFor(old ? itemSize(old) : 1) });
      publish();
      return old ? deepClone(old) : null;
    },

    async query({ index: idx = 'base', pk, sk, desc = false, limit = 50, cursor = null, consistent = false }) {
      const def = INDEXES[idx];
      if (!def) throw new Error(`unknown index ${idx}`);
      if (typeof pk !== 'string') throw new Error('query needs a partition key');
      if (idx !== 'base' && consistent) throw new Error('GSIs only support eventually consistent reads');
      maybeFail('query');
      const set = parts[idx].get(pk);
      let rows = set ? [...set].map((k) => items.get(k)).filter((it) => skMatches(it[def.sk], sk)) : [];
      rows.sort((a, b) => cmp(a[def.sk], b[def.sk]) || cmp(a.PK, b.PK) || cmp(a.SK, b.SK));
      if (desc) rows.reverse();
      const after = decodeCursor(cursor);
      if (after) {
        const pos = rows.findIndex((r) => r.PK === after.PK && r.SK === after.SK);
        rows = pos >= 0 ? rows.slice(pos + 1) : rows.filter((r) => (desc
          ? cmp(r[def.sk], after[def.sk] ?? after.SK) < 0
          : cmp(r[def.sk], after[def.sk] ?? after.SK) > 0));
      }
      const page = rows.slice(0, limit);
      const more = rows.length > limit;
      const bytes = page.reduce((a, r) => a + itemSize(r), 0);
      const rru = Math.max(1, Math.ceil(bytes / 4096)) * (consistent ? 1 : 0.5);
      emit({ op: 'Query', index: idx, pk, sk, keys: page.map(pick), items: page.length, rru, wru: 0 });
      const last = page[page.length - 1];
      const nextCursor = more && last ? encodeCursor({ PK: last.PK, SK: last.SK, [def.sk]: last[def.sk] }) : null;
      return { items: page.map(deepClone), cursor: nextCursor };
    },

    async transact(ops) {
      if (!ops.length) return;
      if (ops.length > 100) throw new AppError(400, 'store.too_many', 'Transactions are limited to 100 items');
      maybeFail('transact');
      const seen = new Set();
      const reasons = [];
      const plans = [];
      for (const op of ops) {
        const kind = Object.keys(op)[0];
        const body = op[kind];
        const key = kind === 'put' ? pick(body.item) : body.key;
        checkKey(key);
        const k = keyOf(key.PK, key.SK);
        if (seen.has(k)) throw new AppError(400, 'store.duplicate_key', 'A transaction cannot touch one item twice');
        seen.add(k);
        const old = items.get(k) || null;
        const ok = evaluateCondition(body.condition, old);
        reasons.push(ok ? { key, code: 'None' } : { key, code: 'ConditionalCheckFailed' });
        // validate the resulting item up front so a commit can never half-apply
        const next = kind === 'put' ? body.item : kind === 'update' ? applyUpdate(old, key, body) : null;
        if (next && itemSize(next) > MAX_ITEM_BYTES) throw new AppError(400, 'store.item_too_large', 'Item exceeds 400 KB');
        plans.push({ kind, body, key, old, next });
      }
      if (reasons.some((r) => r.code !== 'None')) {
        emit({ op: 'TransactWriteItems', pk: plans[0].key.PK, keys: plans.map((p) => p.key), items: 0, rru: 0, wru: 2 * plans.length, failed: true, reasons });
        throw new ConditionFailed(reasons);
      }
      let wru = 0;
      for (const p of plans) {
        if (p.kind === 'put' || p.kind === 'update') wru += 2 * wruFor(write(p.next));
        else if (p.kind === 'delete') { remove(p.key); wru += 2 * wruFor(p.old ? itemSize(p.old) : 1); }
        else if (p.kind === 'check') wru += 0; // ConditionCheck costs a read
      }
      const rru = plans.filter((p) => p.kind === 'check').length * 2;
      emit({ op: 'TransactWriteItems', pk: plans[0].key.PK, keys: plans.map((p) => p.key), items: plans.length, rru, wru });
      publish();
    },

    // ---- test / simulation helpers (not part of the port) ----
    _all: () => [...items.values()].map(deepClone),
    _size: () => items.size,
    _failWith(fn) { failNext = fn; },
    _setListener(fn) { listener = fn; },
    _setStream(fn) { stream = fn; },
    _load(rows) { for (const r of rows) write(r); pending = []; },
  };
  return api;
}

const pick = (item) => ({ PK: item.PK, SK: item.SK });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
