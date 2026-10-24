// @ts-check

/** @import { DynamoScalar, DynamoValue, Item, Key, KeyConstraint, KeyRange, Operation, Restriction, TableCatalog } from '../types.js' */

import { Fail, q } from '@endo/errors';
import { encodeHex } from '@endo/hex';
import { mustMatch } from '@endo/patterns';
import { sha256 } from '@endo/sha256';
import { encodeUtf8 } from '@endo/utf8';

/** @type {readonly Operation[]} */
const allOperations = harden([
  'get',
  'put',
  'update',
  'delete',
  'query',
  'conditionCheck',
  'transactGet',
  'transactWrite',
]);

/**
 * @param {unknown} left
 * @param {unknown} right
 */
export const sameValue = (left, right) => {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return (
      left.length === right.length &&
      left.every((byte, index) => byte === right[index])
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object'
  ) {
    return digest(left) === digest(right);
  }
  return Object.is(left, right);
};
harden(sameValue);

/**
 * @param {string | Uint8Array} value
 * @param {string | Uint8Array} prefix
 */
const startsWith = (value, prefix) => {
  if (typeof value === 'string' && typeof prefix === 'string') {
    return value.startsWith(prefix);
  }
  if (value instanceof Uint8Array && prefix instanceof Uint8Array) {
    return (
      value.length >= prefix.length &&
      prefix.every((byte, index) => value[index] === byte)
    );
  }
  return false;
};

/**
 * @param {DynamoScalar} value
 * @param {KeyConstraint} constraint
 */
export const matchesConstraint = (value, constraint) =>
  'exact' in constraint
    ? sameValue(value, constraint.exact)
    : (typeof value === 'string' || value instanceof Uint8Array) &&
      startsWith(value, constraint.prefix);
harden(matchesConstraint);

/**
 * @template T
 * @param {readonly T[] | undefined} parent
 * @param {readonly T[] | undefined} child
 * @returns {readonly T[] | undefined}
 */
const intersect = (parent, child) => {
  if (parent === undefined)
    return child === undefined ? undefined : harden([...new Set(child)]);
  if (child === undefined) return parent;
  const childSet = new Set(child);
  return harden(parent.filter(value => childSet.has(value)));
};

/**
 * @param {unknown} value
 * @returns {string}
 */
const stableStringify = value => {
  if (typeof value === 'bigint') return JSON.stringify({ bigint: `${value}` });
  if (value instanceof Uint8Array) return JSON.stringify({ bytes: [...value] });
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

/** @param {unknown} value */
export const digest = value => {
  const text = stableStringify(value);
  return encodeHex(sha256(encodeUtf8(text)));
};
harden(digest);

/**
 * @param {Restriction | undefined} parent
 * @param {Restriction} child
 * @returns {Restriction}
 */
export const attenuate = (parent, child) => {
  if (parent !== undefined && child.table !== undefined) {
    Fail`A child restriction cannot select a table`;
  }
  const fixed = { ...(parent?.fixed ?? {}) };
  for (const [field, value] of Object.entries(child.fixed ?? {})) {
    if (field in fixed && !sameValue(fixed[field], value)) {
      Fail`Fixed field ${q(field)} conflicts with its parent`;
    }
    fixed[field] = value;
  }
  const minLimit = (name, fallback) => {
    const left = parent?.limits?.[name];
    const right = child.limits?.[name];
    if (left === undefined) return right ?? fallback;
    if (right === undefined) return left;
    return Math.min(left, right);
  };
  return harden({
    table: parent?.table ?? child.table,
    ranges:
      parent?.ranges === undefined
        ? child.ranges
        : child.ranges === undefined
          ? parent.ranges
          : child.ranges,
    indexes: intersect(parent?.indexes, child.indexes),
    readFields: intersect(parent?.readFields, child.readFields),
    writeFields: intersect(parent?.writeFields, child.writeFields),
    conditionFields: intersect(parent?.conditionFields, child.conditionFields),
    filterFields: intersect(parent?.filterFields, child.filterFields),
    fixed: harden(fixed),
    itemShape: child.itemShape ?? parent?.itemShape,
    operations: intersect(
      parent?.operations ?? allOperations,
      child.operations,
    ),
    limits: harden({
      pageSize: minLimit('pageSize', 100),
      transactionSize: minLimit('transactionSize', 25),
      itemSize: minLimit('itemSize', 400 * 1024),
      ratePerSecond: minLimit('ratePerSecond', Infinity),
    }),
  });
};
harden(attenuate);

/**
 * @param {DynamoScalar} value
 * @param {'string' | 'number' | 'binary'} type
 */
const matchesKeyType = (value, type) => {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number')
    return typeof value === 'number' || typeof value === 'bigint';
  return value instanceof Uint8Array;
};

/**
 * @param {Key} key
 * @param {any} table
 */
export const assertKeyShape = (key, table) => {
  const expected = [
    table.partitionKey,
    ...(table.sortKey ? [table.sortKey] : []),
  ];
  Object.keys(key).length === expected.length ||
    Fail`Key has unexpected fields`;
  for (const part of expected) {
    part.name in key || Fail`Key is missing ${q(part.name)}`;
    matchesKeyType(key[part.name], part.type) ||
      Fail`Key field ${q(part.name)} has the wrong type`;
  }
};
harden(assertKeyShape);

/**
 * @param {Key} key
 * @param {any} table
 * @param {readonly KeyRange[] | undefined} ranges
 */
export const keyAllowed = (key, table, ranges) => {
  if (ranges === undefined) return true;
  return ranges.some(range => {
    if (!matchesConstraint(key[table.partitionKey.name], range.partition))
      return false;
    if (range.sort === undefined) return true;
    return (
      table.sortKey !== undefined &&
      matchesConstraint(key[table.sortKey.name], range.sort)
    );
  });
};
harden(keyAllowed);

/**
 * @param {Item} item
 * @param {Restriction} restriction
 */
export const applyFixed = (item, restriction) => {
  const result = { ...item };
  for (const [field, value] of Object.entries(restriction.fixed ?? {})) {
    if (field in result && !sameValue(result[field], value)) {
      Fail`Field ${q(field)} conflicts with a fixed value`;
    }
    result[field] = value;
  }
  return harden(result);
};
harden(applyFixed);

/**
 * @param {Item} item
 * @param {Restriction} restriction
 * @param {'read' | 'write'} direction
 */
export const assertItem = (item, restriction, direction) => {
  const fields =
    direction === 'read' ? restriction.readFields : restriction.writeFields;
  for (const [field, value] of Object.entries(restriction.fixed ?? {})) {
    (field in item && sameValue(item[field], value)) ||
      Fail`Item does not satisfy fixed field ${q(field)}`;
  }
  if (direction === 'write' && fields !== undefined) {
    const allowed = new Set(fields);
    for (const field of Object.keys(item)) {
      allowed.has(field) ||
        field in (restriction.fixed ?? {}) ||
        Fail`Field ${q(field)} is not writable`;
    }
  }
  if (restriction.itemShape !== undefined)
    mustMatch(item, restriction.itemShape);
};
harden(assertItem);

/**
 * @param {Item} item
 * @param {readonly string[] | undefined} fields
 */
export const projectItem = (item, fields) => {
  if (fields === undefined) return harden({ ...item });
  return harden(
    Object.fromEntries(
      fields.filter(field => field in item).map(field => [field, item[field]]),
    ),
  );
};
harden(projectItem);

/**
 * @param {Operation} operation
 * @param {Restriction} restriction
 */
export const operationAllowed = (operation, restriction) =>
  restriction.operations?.includes(operation) ?? true;
harden(operationAllowed);

/**
 * @param {TableCatalog} catalog
 * @param {Restriction} restriction
 */
export const resolveTable = (catalog, restriction) => {
  const alias = restriction.table;
  if (alias === undefined) return Fail`A root restriction must select a table`;
  const table = catalog[alias];
  table !== undefined || Fail`Unknown logical table ${q(alias)}`;
  return table;
};
harden(resolveTable);
