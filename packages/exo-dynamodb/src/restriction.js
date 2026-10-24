// @ts-check

/** @import { Field, Guard, Item, KeyRange, Operation, Restriction, Scalar, TableCatalog, TableEntry } from '../types.js' */

import { assertGuard, evaluateCondition, guardTerms } from './condition.js';
import { assertKeyRange, keySpaceContains } from './keys.js';
import { reject } from './results.js';
import { digest, sameValue } from './value.js';

/** @type {readonly Operation[]} */
export const allOperations = harden([
  'get',
  'put',
  'update',
  'delete',
  'query',
  'conditionCheck',
  'transactGet',
  'transactWrite',
]);

/** The outer ceilings a root restriction may narrow. */
export const rootLimits = harden({
  pageSize: 1000,
  transactionSize: 100,
  itemBytes: 400 * 1024,
  requestsPerSecond: Infinity,
});

/**
 * The effective restriction of one grant: the intersection of its own
 * restriction with every ancestor's. `undefined` means unrestricted.
 *
 * @typedef {{
 *   table: string,
 *   keySpace: readonly KeyRange[] | undefined,
 *   indexes: Readonly<Record<string, readonly KeyRange[] | undefined>>,
 *   shape: {
 *     readFields: readonly Field[] | undefined,
 *     writeFields: readonly Field[] | undefined,
 *     conditionFields: readonly Field[] | undefined,
 *     filterFields: readonly Field[] | undefined,
 *     fixed: Readonly<Record<Field, Scalar>>,
 *     guards: readonly Guard[],
 *   },
 *   operations: readonly Operation[],
 *   limits: {
 *     pageSize: number,
 *     transactionSize: number,
 *     itemBytes: number,
 *     requestsPerSecond: number,
 *   },
 * }} Effective
 */

/**
 * @param {unknown} value
 * @param {string} label
 */
const assertRecord = (value, label) => {
  (value !== null && typeof value === 'object' && !Array.isArray(value)) ||
    reject(`${label} must be a record`);
  return /** @type {Record<string, any>} */ (value);
};

/**
 * @param {Record<string, unknown>} record
 * @param {readonly string[]} allowed
 * @param {string} label
 */
const assertKeys = (record, allowed, label) => {
  for (const key of Object.keys(record)) {
    allowed.includes(key) || reject(`${label} has unexpected field ${key}`);
  }
};

/**
 * @param {unknown} list
 * @param {string} label
 * @returns {string[]}
 */
const assertNames = (list, label) => {
  (Array.isArray(list) &&
    list.every(entry => typeof entry === 'string' && entry !== '')) ||
    reject(`${label} must list names`);
  return [.../** @type {string[]} */ (list)];
};

/**
 * Narrow a list. Omitted inherits; a child that names anything outside the
 * parent's list is a widening request.
 *
 * @param {readonly string[] | undefined} parent
 * @param {unknown} child
 * @param {string} label
 */
const narrowList = (parent, child, label) => {
  if (child === undefined) return parent;
  const names = assertNames(child, label);
  if (parent !== undefined) {
    const allowed = new Set(parent);
    for (const name of names) {
      allowed.has(name) || reject(`${label} names ${name} outside the grant`);
    }
  }
  return harden([...new Set(names)]);
};

/**
 * @param {Effective} parent
 * @param {TableEntry} table
 */
const knownFields = (parent, table) => {
  const { readFields, writeFields } = parent.shape;
  if (readFields === undefined || writeFields === undefined) return undefined;
  return new Set([
    ...readFields,
    ...writeFields,
    ...Object.keys(parent.shape.fixed),
    table.partitionKey.name,
    ...(table.sortKey ? [table.sortKey.name] : []),
  ]);
};

/**
 * Compute a child's effective restriction, or throw a `RequestError` for a
 * malformed, unknown, conflicting, or widening request.
 *
 * @param {Effective} parent
 * @param {unknown} restriction
 * @param {TableEntry} table
 * @returns {Effective}
 */
export const narrow = (parent, restriction, table) => {
  const local = assertRecord(restriction, 'restriction');
  assertKeys(
    local,
    ['keySpace', 'indexes', 'shape', 'operations', 'limits'],
    'restriction',
  );

  let keySpace = parent.keySpace;
  if (local.keySpace !== undefined) {
    Array.isArray(local.keySpace) || reject('keySpace must be a list');
    const ranges = harden(
      local.keySpace.map(range => assertKeyRange(range, table)),
    );
    keySpaceContains(parent.keySpace, ranges) ||
      reject('keySpace is outside the grant');
    keySpace = ranges;
  }

  let indexes = parent.indexes;
  if (local.indexes !== undefined) {
    const requested = assertRecord(local.indexes, 'indexes');
    /** @type {Record<string, readonly KeyRange[]>} */
    const next = {};
    for (const [name, ranges] of Object.entries(requested)) {
      (Object.hasOwn(parent.indexes, name) &&
        table.indexes?.[name] !== undefined) ||
        reject(`index ${name} is outside the grant`);
      Array.isArray(ranges) || reject(`index ${name} ranges must be a list`);
      const schema = /** @type {NonNullable<TableEntry['indexes']>} */ (
        table.indexes
      )[name];
      const checked = harden(
        ranges.map(range => assertKeyRange(range, schema)),
      );
      keySpaceContains(parent.indexes[name], checked) ||
        reject(`index ${name} ranges are outside the grant`);
      next[name] = checked;
    }
    indexes = harden(next);
  }

  const shape = assertRecord(local.shape ?? {}, 'shape');
  assertKeys(
    shape,
    [
      'readFields',
      'writeFields',
      'conditionFields',
      'filterFields',
      'fixed',
      'guard',
    ],
    'shape',
  );
  const readFields = narrowList(
    parent.shape.readFields,
    shape.readFields,
    'readFields',
  );
  const writeFields = narrowList(
    parent.shape.writeFields,
    shape.writeFields,
    'writeFields',
  );
  const conditionFields = narrowList(
    parent.shape.conditionFields,
    shape.conditionFields,
    'conditionFields',
  );
  const filterFields = narrowList(
    parent.shape.filterFields,
    shape.filterFields,
    'filterFields',
  );

  const known = knownFields(parent, table);
  let guards = parent.shape.guards;
  if (shape.guard !== undefined) {
    assertGuard(shape.guard, field => {
      known === undefined ||
        known.has(field) ||
        reject(`guard names unknown field ${field}`);
    });
    guards = harden([...guards, harden(shape.guard)]);
  }

  const fixed = { ...parent.shape.fixed };
  if (shape.fixed !== undefined) {
    const requested = assertRecord(shape.fixed, 'fixed');
    for (const [field, value] of Object.entries(requested)) {
      value === null ||
        ['string', 'number', 'bigint', 'boolean'].includes(typeof value) ||
        value instanceof Uint8Array ||
        reject(`fixed field ${field} must be a scalar`);
      if (Object.hasOwn(fixed, field)) {
        sameValue(fixed[field], value) ||
          reject(`fixed field ${field} conflicts with the grant`);
      }
      parent.shape.writeFields === undefined ||
        parent.shape.writeFields.includes(field) ||
        reject(`fixed field ${field} is not writable`);
      for (const guard of guards) {
        for (const { field: termField, term } of guardTerms(guard)) {
          if (termField === field) {
            evaluateCondition(term, harden({ [field]: value })) ||
              reject(`fixed field ${field} fails a guard`);
          }
        }
      }
      fixed[field] = value;
    }
  }

  const operations =
    local.operations === undefined
      ? parent.operations
      : /** @type {readonly Operation[]} */ (
          narrowList(parent.operations, local.operations, 'operations')
        );

  const limits = { ...parent.limits };
  if (local.limits !== undefined) {
    const requested = assertRecord(local.limits, 'limits');
    assertKeys(requested, Object.keys(rootLimits), 'limits');
    for (const [name, value] of Object.entries(requested)) {
      const integer = name !== 'requestsPerSecond';
      (typeof value === 'number' &&
        value > 0 &&
        (integer ? Number.isSafeInteger(value) : !Number.isNaN(value))) ||
        reject(`limit ${name} must be a positive number`);
      const ceiling = /** @type {number} */ (parent.limits[name]);
      /** @type {number} */ (value) <= ceiling ||
        reject(`limit ${name} exceeds the grant`);
      limits[name] = value;
    }
  }

  return harden({
    table: parent.table,
    keySpace,
    indexes,
    shape: harden({
      readFields,
      writeFields,
      conditionFields,
      filterFields,
      fixed: harden(fixed),
      guards,
    }),
    operations,
    limits: harden(limits),
  });
};
harden(narrow);

/**
 * Normalize a root restriction against the host catalog.
 *
 * @param {TableCatalog} catalog
 * @param {unknown} restriction
 * @returns {{ effective: Effective, table: TableEntry }}
 */
export const narrowRoot = (catalog, restriction) => {
  const { table: alias, ...rest } = assertRecord(restriction, 'restriction');
  typeof alias === 'string' || reject('a root restriction must select a table');
  Object.hasOwn(catalog, alias) || reject(`unknown logical table ${alias}`);
  const table = catalog[alias];
  /** @type {Effective} */
  const unrestricted = harden({
    table: alias,
    keySpace: undefined,
    indexes: harden(
      Object.fromEntries(
        Object.keys(table.indexes ?? {}).map(name => [name, undefined]),
      ),
    ),
    shape: harden({
      readFields: undefined,
      writeFields: undefined,
      conditionFields: undefined,
      filterFields: undefined,
      fixed: harden({}),
      guards: harden([]),
    }),
    operations: allOperations,
    limits: rootLimits,
  });
  return harden({
    effective: narrow(unrestricted, harden(rest), table),
    table,
  });
};
harden(narrowRoot);

/** @param {Effective} effective */
export const effectiveDigest = effective => digest(effective);
harden(effectiveDigest);

/**
 * @param {Item} item
 * @param {readonly Field[] | undefined} fields undefined keeps every field
 */
export const projectItem = (item, fields) => {
  if (fields === undefined) return harden({ ...item });
  return harden(
    Object.fromEntries(
      fields
        .filter(field => Object.hasOwn(item, field))
        .map(field => [field, item[field]]),
    ),
  );
};
harden(projectItem);
