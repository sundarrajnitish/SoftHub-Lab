// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// A small, dependency-free validator for request bodies and query strings.
//
// Every handler validates its input against a schema before touching the
// table. Unknown fields are rejected (so a client can never smuggle in
// `price`, `providerId`, `status` or `role`), strings are trimmed and
// length-limited, and numbers are range-checked integers.

import { badRequest } from './util.js';

/**
 * Field spec:
 *  { type: 'string', min, max, pattern, enum, optional, trim=true }
 *  { type: 'int', min, max, optional }        // also accepts numeric strings (query params)
 *  { type: 'bool', optional }
 *  { type: 'array', of: spec, min, max, unique, optional }
 *  { type: 'object', fields: {...}, optional }
 */
export function validate(schema, input, path = '') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('validation', `${path || 'body'} must be an object`);
  }
  const out = {};
  const errors = [];
  for (const key of Object.keys(input)) {
    if (!(key in schema)) errors.push({ field: path + key, error: 'unknown field' });
  }
  for (const [key, spec] of Object.entries(schema)) {
    const v = input[key];
    if (v === undefined || v === null || v === '') {
      if (spec.optional) { if (spec.default !== undefined) out[key] = spec.default; continue; }
      errors.push({ field: path + key, error: 'required' });
      continue;
    }
    try {
      out[key] = checkValue(spec, v, path + key);
    } catch (e) {
      errors.push(...(e.details?.errors || [{ field: path + key, error: e.message }]));
    }
  }
  if (errors.length) {
    throw badRequest('validation', `Invalid ${errors.map((e) => e.field).join(', ')}`, { errors });
  }
  return out;
}

function checkValue(spec, v, field) {
  switch (spec.type) {
    case 'string': {
      if (typeof v !== 'string') throw new Error('must be a string');
      // single-line fields collapse runs of whitespace; multiline keep line breaks
      const text = spec.multiline
        ? v.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
        : v.trim().replace(/\s+/g, ' ');
      if (spec.min !== undefined && text.length < spec.min) throw new Error(`at least ${spec.min} characters`);
      if (spec.max !== undefined && text.length > spec.max) throw new Error(`at most ${spec.max} characters`);
      if (spec.enum && !spec.enum.includes(text)) throw new Error(`one of ${spec.enum.join(', ')}`);
      if (spec.pattern && !spec.pattern.test(text)) throw new Error('has an invalid format');
      return text;
    }
    case 'int': {
      const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new Error('must be an integer');
      if (spec.min !== undefined && n < spec.min) throw new Error(`must be ≥ ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) throw new Error(`must be ≤ ${spec.max}`);
      return n;
    }
    case 'bool': {
      if (v === true || v === 'true') return true;
      if (v === false || v === 'false') return false;
      throw new Error('must be true or false');
    }
    case 'array': {
      if (!Array.isArray(v)) throw new Error('must be a list');
      if (spec.min !== undefined && v.length < spec.min) throw new Error(`needs at least ${spec.min} items`);
      if (spec.max !== undefined && v.length > spec.max) throw new Error(`at most ${spec.max} items`);
      const items = v.map((x, i) => checkValue(spec.of, x, `${field}[${i}]`));
      if (spec.unique) return [...new Set(items)];
      return items;
    }
    case 'object':
      return validate(spec.fields, v, field + '.');
    default:
      throw new Error(`unknown spec type ${spec.type}`);
  }
}

export const ID = { type: 'string', min: 6, max: 40, pattern: /^[A-Za-z0-9_-]+$/ };
