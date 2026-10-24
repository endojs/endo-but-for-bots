// @ts-check

import { makeDynamoControl, makeMemoryCursorSealer } from '../index.js';
import { makeFakeDynamoDB } from './_fake-dynamodb.js';

/** @import { TableCatalog } from '../types.js' */

/** @type {TableCatalog} */
export const catalog = harden({
  app: harden({
    tableName: 'app-physical',
    partitionKey: harden({ name: 'pk', type: 'string' }),
    sortKey: harden({ name: 'sk', type: 'string' }),
    indexes: harden({
      byKind: harden({
        indexName: 'gsi-kind',
        partitionKey: harden({ name: 'kind', type: 'string' }),
        sortKey: harden({ name: 'sk', type: 'string' }),
      }),
      byVisible: harden({
        indexName: 'lsi-visible',
        global: false,
        partitionKey: harden({ name: 'pk', type: 'string' }),
        sortKey: harden({ name: 'visible', type: 'string' }),
      }),
    }),
  }),
  events: harden({
    tableName: 'events-physical',
    partitionKey: harden({ name: 'stream', type: 'string' }),
    sortKey: harden({ name: 'seq', type: 'number' }),
  }),
  coupons: harden({
    tableName: 'coupons-physical',
    partitionKey: harden({ name: 'pk', type: 'string' }),
    indexes: harden({
      queue: harden({
        indexName: 'queue-gsi',
        partitionKey: harden({ name: 'queue', type: 'string' }),
        sortKey: harden({ name: 'due', type: 'number' }),
      }),
    }),
  }),
});

/** Physical schemas for the fake, keyed by physical names. */
export const physicalSchemas = Object.fromEntries(
  Object.values(catalog).map(entry => [
    entry.tableName,
    {
      partitionKey: entry.partitionKey,
      ...(entry.sortKey ? { sortKey: entry.sortKey } : {}),
      indexes: Object.fromEntries(
        Object.values(entry.indexes ?? {}).map(index => [
          index.indexName,
          {
            global: index.global !== false,
            partitionKey: index.partitionKey,
            ...(index.sortKey ? { sortKey: index.sortKey } : {}),
          },
        ]),
      ),
    },
  ]),
);

/**
 * @param {{ generation?: string, now?: () => number, grantStore?: any, tombstones?: Iterable<string>, fake?: ReturnType<typeof makeFakeDynamoDB>, client?: any }} [options]
 */
export const makeHarness = (options = {}) => {
  const fake = options.fake ?? makeFakeDynamoDB(physicalSchemas);
  /** @type {any[]} */
  const events = [];
  let cursorNumber = 0;
  const sealer = makeMemoryCursorSealer({
    random: () => `cursor-${(cursorNumber += 1)}`,
  });
  const powers = {
    client: options.client ?? fake.client,
    catalog,
    audit: harden({
      record(event) {
        events.push(event);
      },
      hashKey(key) {
        return `hash:${Object.keys(key).length}`;
      },
    }),
    sealCursor: sealer,
    generation: options.generation ?? 'generation-1',
    now: options.now ?? (() => 1000),
    log: (message, error) => {
      if (process.env.EXO_DYNAMODB_DEBUG) console.error(message, error);
    },
    ...(options.grantStore ? { grantStore: options.grantStore } : {}),
    ...(options.tombstones ? { tombstones: options.tombstones } : {}),
  };
  const control = makeDynamoControl(powers);
  return { fake, calls: fake.calls, events, control, powers, sealer };
};

/**
 * Unwrap an ok result, failing the test otherwise.
 *
 * @template T
 * @param {import('ava').ExecutionContext} t
 * @param {import('../types.js').Result<T>} result
 * @returns {any}
 */
export const expectOk = (t, result) => {
  if (result.type !== 'ok') {
    t.fail(`expected ok, got ${JSON.stringify(result)}`);
    throw Error('unreachable');
  }
  return result.value;
};

/** A broad root restriction over the `app` table. */
export const appRoot = harden({
  table: 'app',
  keySpace: harden([
    harden({
      partition: harden({ prefix: 'tenant#' }),
      sort: harden({ prefix: 'item#' }),
    }),
  ]),
  indexes: harden({
    byKind: harden([harden({ partition: harden({ exact: 'coupon' }) })]),
    byVisible: harden([harden({ partition: harden({ prefix: 'tenant#' }) })]),
  }),
  shape: harden({
    readFields: harden(['pk', 'sk', 'visible', 'secret', 'kind', 'count']),
    writeFields: harden(['pk', 'sk', 'visible', 'secret', 'kind', 'count']),
    conditionFields: harden(['pk', 'sk', 'visible', 'count']),
    filterFields: harden(['visible', 'count']),
    fixed: harden({ kind: 'coupon' }),
  }),
  limits: harden({ pageSize: 10, transactionSize: 4, itemBytes: 4096 }),
});
