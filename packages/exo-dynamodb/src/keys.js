// @ts-check

/** @import { Condition, Key, KeyAttribute, KeyConstraint, KeyRange, KeySchema, Scalar } from '../types.js' */

import { reject } from './results.js';
import {
  compareScalars,
  isBytesLike,
  isNumeric,
  sameValue,
  startsWith,
} from './value.js';

/**
 * @param {unknown} value
 * @param {KeyAttribute['type']} type
 */
export const matchesKeyType = (value, type) => {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return isNumeric(value);
  return value instanceof Uint8Array;
};
harden(matchesKeyType);

/**
 * @param {unknown} constraint
 * @param {KeyAttribute} attribute
 * @param {'partition' | 'sort'} role
 * @returns {KeyConstraint}
 */
export const assertKeyConstraint = (constraint, attribute, role) => {
  (constraint !== null &&
    typeof constraint === 'object' &&
    !Array.isArray(constraint)) ||
    reject(`${role} constraint must be a record`);
  const record = /** @type {Record<string, unknown>} */ (constraint);
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'exact') {
    matchesKeyType(record.exact, attribute.type) ||
      reject(`${role} exact value has the wrong type`);
    return harden({ exact: /** @type {any} */ (record.exact) });
  }
  if (keys.length === 1 && keys[0] === 'prefix') {
    (attribute.type !== 'number' &&
      matchesKeyType(record.prefix, attribute.type)) ||
      reject(`${role} prefix requires a string or binary key`);
    return harden({ prefix: /** @type {any} */ (record.prefix) });
  }
  keys.every(key => key === 'min' || key === 'max') ||
    reject(`${role} constraint has unexpected fields`);
  (attribute.type === 'number' && role === 'sort') ||
    reject('an interval requires a numeric sort key');
  for (const key of keys) {
    isNumeric(record[key]) || reject(`interval ${key} must be a number`);
  }
  if (record.min !== undefined && record.max !== undefined) {
    /** @type {number} */ (compareScalars(record.min, record.max)) <= 0 ||
      reject('interval min exceeds max');
  }
  return harden({ ...record });
};
harden(assertKeyConstraint);

/**
 * @param {unknown} range
 * @param {KeySchema} schema
 * @returns {KeyRange}
 */
export const assertKeyRange = (range, schema) => {
  (range !== null && typeof range === 'object' && !Array.isArray(range)) ||
    reject('key range must be a record');
  const record = /** @type {Record<string, unknown>} */ (range);
  Object.keys(record).every(key => key === 'partition' || key === 'sort') ||
    reject('key range has unexpected fields');
  record.partition !== undefined || reject('key range requires a partition');
  const partition = assertKeyConstraint(
    record.partition,
    schema.partitionKey,
    'partition',
  );
  if (record.sort === undefined) return harden({ partition });
  schema.sortKey !== undefined || reject('this schema has no sort key');
  const sort = assertKeyConstraint(
    record.sort,
    /** @type {KeyAttribute} */ (schema.sortKey),
    'sort',
  );
  return harden({ partition, sort });
};
harden(assertKeyRange);

/**
 * @param {unknown} value
 * @param {KeyConstraint} constraint
 */
export const matchesConstraint = (value, constraint) => {
  if ('exact' in constraint) return sameValue(value, constraint.exact);
  if ('prefix' in constraint) {
    return isBytesLike(value) && startsWith(value, constraint.prefix);
  }
  if (!isNumeric(value)) return false;
  return (
    (constraint.min === undefined ||
      /** @type {number} */ (compareScalars(value, constraint.min)) >= 0) &&
    (constraint.max === undefined ||
      /** @type {number} */ (compareScalars(value, constraint.max)) <= 0)
  );
};
harden(matchesConstraint);

/**
 * Whether every value the child admits is admitted by the parent.
 *
 * @param {KeyConstraint} parent
 * @param {KeyConstraint} child
 */
export const constraintContains = (parent, child) => {
  if ('exact' in child) return matchesConstraint(child.exact, parent);
  if ('exact' in parent) return false;
  if ('prefix' in parent) {
    return 'prefix' in child && startsWith(child.prefix, parent.prefix);
  }
  if ('prefix' in child) return false;
  const lowOk =
    parent.min === undefined ||
    (child.min !== undefined &&
      /** @type {number} */ (compareScalars(child.min, parent.min)) >= 0);
  const highOk =
    parent.max === undefined ||
    (child.max !== undefined &&
      /** @type {number} */ (compareScalars(child.max, parent.max)) <= 0);
  return lowOk && highOk;
};
harden(constraintContains);

/**
 * @param {KeyRange} parent
 * @param {KeyRange} child
 */
export const rangeContains = (parent, child) =>
  constraintContains(parent.partition, child.partition) &&
  (parent.sort === undefined ||
    (child.sort !== undefined && constraintContains(parent.sort, child.sort)));
harden(rangeContains);

/**
 * Whether a key space (undefined means unrestricted) admits every range of a
 * child key space.
 *
 * @param {readonly KeyRange[] | undefined} parent
 * @param {readonly KeyRange[]} child
 */
export const keySpaceContains = (parent, child) =>
  parent === undefined ||
  child.every(range => parent.some(outer => rangeContains(outer, range)));
harden(keySpaceContains);

/**
 * Validate the structure and types of a complete base-table key.
 *
 * @param {unknown} key
 * @param {KeySchema} schema
 * @returns {Key}
 */
export const assertKey = (key, schema) => {
  (key !== null && typeof key === 'object' && !Array.isArray(key)) ||
    reject('key must be a record');
  const record = /** @type {Record<string, unknown>} */ (key);
  const parts = [
    schema.partitionKey,
    ...(schema.sortKey ? [schema.sortKey] : []),
  ];
  Object.keys(record).length === parts.length ||
    reject('key has unexpected fields');
  for (const part of parts) {
    Object.hasOwn(record, part.name) || reject(`key is missing ${part.name}`);
    matchesKeyType(record[part.name], part.type) ||
      reject(`key field ${part.name} has the wrong type`);
  }
  return /** @type {Key} */ (record);
};
harden(assertKey);

/**
 * Extract a schema's key from an item, or undefined if any part is absent or
 * mistyped.
 *
 * @param {Record<string, unknown>} item
 * @param {KeySchema} schema
 * @returns {Key | undefined}
 */
export const keyOf = (item, schema) => {
  const parts = [
    schema.partitionKey,
    ...(schema.sortKey ? [schema.sortKey] : []),
  ];
  /** @type {Record<string, Scalar>} */
  const key = {};
  for (const part of parts) {
    const value = item[part.name];
    if (!matchesKeyType(value, part.type)) return undefined;
    key[part.name] = /** @type {Scalar} */ (value);
  }
  return harden(key);
};
harden(keyOf);

/**
 * @param {Key} key
 * @param {KeySchema} schema
 * @param {readonly KeyRange[] | undefined} ranges undefined is unrestricted
 */
export const keyAllowed = (key, schema, ranges) =>
  ranges === undefined ||
  ranges.some(
    range =>
      matchesConstraint(key[schema.partitionKey.name], range.partition) &&
      (range.sort === undefined ||
        (schema.sortKey !== undefined &&
          matchesConstraint(key[schema.sortKey.name], range.sort))),
  );
harden(keyAllowed);

/**
 * A normalized set of sort-key values: an optional byte prefix and optional
 * bounds. Bounds compare by value for numbers and by bytes otherwise.
 *
 * @typedef {{ value: Scalar, inclusive: boolean }} Bound
 * @typedef {{ prefix?: string | Uint8Array, low?: Bound, high?: Bound }} SortSet
 */

/**
 * @param {Bound | undefined} left
 * @param {Bound | undefined} right
 * @param {1 | -1} direction 1 keeps the larger (low bounds), -1 the smaller
 */
const tighter = (left, right, direction) => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const order = /** @type {number} */ (compareScalars(left.value, right.value));
  if (order === 0) return left.inclusive ? right : left;
  return order * direction > 0 ? left : right;
};

/**
 * @param {SortSet} left
 * @param {SortSet} right
 * @returns {SortSet | undefined} undefined when the prefixes are disjoint
 */
const intersectSortSets = (left, right) => {
  let prefix = left.prefix;
  if (right.prefix !== undefined) {
    if (prefix === undefined || startsWith(right.prefix, prefix)) {
      prefix = right.prefix;
    } else if (!startsWith(prefix, right.prefix)) {
      return undefined;
    }
  }
  return harden({
    ...(prefix === undefined ? {} : { prefix }),
    ...(tighter(left.low, right.low, 1) === undefined
      ? {}
      : { low: tighter(left.low, right.low, 1) }),
    ...(tighter(left.high, right.high, -1) === undefined
      ? {}
      : { high: tighter(left.high, right.high, -1) }),
  });
};

/**
 * @param {SortSet | undefined} set
 */
const isEmptySortSet = set => {
  if (set === undefined) return true;
  const { prefix, low, high } = set;
  if (low !== undefined && high !== undefined) {
    const order = /** @type {number} */ (compareScalars(low.value, high.value));
    if (order > 0 || (order === 0 && !(low.inclusive && high.inclusive))) {
      return true;
    }
  }
  if (prefix !== undefined) {
    for (const bound of [low, high]) {
      if (
        bound !== undefined &&
        compareScalars(bound.value, prefix) === undefined
      ) {
        return true;
      }
    }
    if (high !== undefined && !isBytesLike(high.value)) return true;
    if (
      high !== undefined &&
      !startsWith(/** @type {any} */ (high.value), prefix)
    ) {
      // Every value with the prefix is at least the prefix.
      const order = /** @type {number} */ (compareScalars(high.value, prefix));
      if (order < 0) return true;
    }
    if (
      low !== undefined &&
      !startsWith(/** @type {any} */ (low.value), prefix) &&
      /** @type {number} */ (compareScalars(low.value, prefix)) > 0
    ) {
      // The low bound sorts after every value with the prefix.
      return true;
    }
  }
  return false;
};

/**
 * @param {KeyConstraint} constraint
 * @returns {SortSet}
 */
const constraintSortSet = constraint => {
  if ('exact' in constraint) {
    const bound = harden({ value: constraint.exact, inclusive: true });
    return harden({ low: bound, high: bound });
  }
  if ('prefix' in constraint) return harden({ prefix: constraint.prefix });
  return harden({
    ...(constraint.min === undefined
      ? {}
      : { low: harden({ value: constraint.min, inclusive: true }) }),
    ...(constraint.max === undefined
      ? {}
      : { high: harden({ value: constraint.max, inclusive: true }) }),
  });
};

/**
 * Translate a caller's sort-key condition into a sort set.
 *
 * @param {Condition | undefined} condition
 * @param {KeyAttribute} attribute
 * @returns {SortSet}
 */
export const sortConditionSet = (condition, attribute) => {
  if (condition === undefined) return harden({});
  const node = /** @type {Record<string, any>} */ (condition);
  node.field === attribute.name ||
    reject('sort condition must name the sort key');
  const operators = Object.keys(node).filter(key => key !== 'field');
  operators.length === 1 || reject('sort condition needs one operator');
  const [operator] = operators;
  const operand = node[operator];
  /** @param {unknown} value */
  const typed = value => {
    matchesKeyType(value, attribute.type) ||
      reject('sort condition value has the wrong type');
    return /** @type {Scalar} */ (value);
  };
  /**
   * @param {unknown} value
   * @param {boolean} inclusive
   */
  const bound = (value, inclusive) =>
    harden({ value: typed(value), inclusive });
  switch (operator) {
    case 'eq':
      return harden({ low: bound(operand, true), high: bound(operand, true) });
    case 'lt':
      return harden({ high: bound(operand, false) });
    case 'lte':
      return harden({ high: bound(operand, true) });
    case 'gt':
      return harden({ low: bound(operand, false) });
    case 'gte':
      return harden({ low: bound(operand, true) });
    case 'between':
      (Array.isArray(operand) && operand.length === 2) ||
        reject('between requires a pair');
      return harden({
        low: bound(operand[0], true),
        high: bound(operand[1], true),
      });
    case 'beginsWith':
      attribute.type !== 'number' ||
        reject('beginsWith requires a string or binary sort key');
      return harden({ prefix: /** @type {any} */ (typed(operand)) });
    default:
      return reject('unsupported sort condition');
  }
};
harden(sortConditionSet);

/**
 * Narrow a query's sort set by one grant's ranges for the queried schema
 * (section 3.2, rule 6). The partition must lie in an allowed range, and the
 * sort set is intersected with the one range it selects.
 *
 * @param {SortSet} set
 * @param {unknown} partition
 * @param {readonly KeyRange[] | undefined} ranges undefined is unrestricted
 * @returns {SortSet}
 */
export const narrowSortSet = (set, partition, ranges) => {
  if (ranges === undefined) return set;
  const matching = ranges.filter(range =>
    matchesConstraint(partition, range.partition),
  );
  matching.length > 0 || reject('query partition is outside the grant');
  if (matching.some(range => range.sort === undefined)) return set;
  /** @type {SortSet[]} */
  const candidates = [];
  for (const range of matching) {
    const narrowed = intersectSortSets(
      set,
      constraintSortSet(/** @type {KeyConstraint} */ (range.sort)),
    );
    if (!isEmptySortSet(narrowed)) {
      candidates.push(/** @type {SortSet} */ (narrowed));
    }
  }
  candidates.length > 0 || reject('sort condition is outside the grant');
  const [first, ...rest] = candidates;
  rest.every(candidate => sameValue(candidate, first)) ||
    reject('query must select one allowed sort range');
  return first;
};
harden(narrowSortSet);

/**
 * @param {SortSet} set
 * @param {unknown} value
 */
export const sortSetAdmits = (set, value) => {
  const { prefix, low, high } = set;
  if (
    prefix !== undefined &&
    !(isBytesLike(value) && startsWith(value, prefix))
  ) {
    return false;
  }
  if (low !== undefined) {
    const order = compareScalars(value, low.value);
    if (order === undefined || order < 0 || (order === 0 && !low.inclusive)) {
      return false;
    }
  }
  if (high !== undefined) {
    const order = compareScalars(value, high.value);
    if (order === undefined || order > 0 || (order === 0 && !high.inclusive)) {
      return false;
    }
  }
  return true;
};
harden(sortSetAdmits);

/**
 * The tightest single DynamoDB sort-key condition that contains a sort set.
 * Values outside the set but inside this condition are removed by
 * `sortSetAdmits` after the read.
 *
 * @param {SortSet} set
 * @param {string} field
 * @returns {Condition | undefined}
 */
export const sortSetCondition = (set, field) => {
  const { prefix, low, high } = set;
  if (
    low !== undefined &&
    high !== undefined &&
    compareScalars(low.value, high.value) === 0
  ) {
    return harden({ field, eq: low.value });
  }
  if (prefix !== undefined) return harden({ field, beginsWith: prefix });
  if (low !== undefined && high !== undefined) {
    return harden({
      field,
      between: harden([/** @type {any} */ (low.value), high.value]),
    });
  }
  if (low !== undefined) {
    return harden(
      low.inclusive ? { field, gte: low.value } : { field, gt: low.value },
    );
  }
  if (high !== undefined) {
    return harden(
      high.inclusive ? { field, lte: high.value } : { field, lt: high.value },
    );
  }
  return undefined;
};
harden(sortSetCondition);
