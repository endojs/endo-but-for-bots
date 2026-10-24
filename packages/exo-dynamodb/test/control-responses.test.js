// @ts-check

import '@endo/init';

import test from 'ava';

import { makeDynamoControl, makeMemoryCursorSealer } from '../index.js';

/** @import { FieldCondition, Restriction, TableCatalog, TransactionWrite } from '../types.js' */

const row = harden({
  pk: harden({ S: 'tenant#a' }),
  sk: harden({ S: 'item#1' }),
  visible: harden({ S: 'yes' }),
  secret: harden({ S: 'hidden' }),
  kind: harden({ S: 'coupon' }),
});

/** @type {TableCatalog} */
const catalog = harden({
  app: harden({
    tableName: 'physical-table',
    partitionKey: harden({ name: 'pk', type: 'string' }),
    sortKey: harden({ name: 'sk', type: 'string' }),
    indexes: harden({
      byKind: harden({
        indexName: 'gsi-kind',
        partitionKey: harden({ name: 'kind', type: 'string' }),
        sortKey: harden({ name: 'sk', type: 'string' }),
      }),
      flat: harden({
        indexName: 'gsi-flat',
        partitionKey: harden({ name: 'kind', type: 'string' }),
      }),
    }),
  }),
});

/** @type {Restriction} */
const rootRestriction = harden({
  table: 'app',
  ranges: harden([
    harden({
      partition: harden({ prefix: 'tenant#' }),
      sort: harden({ prefix: 'item#' }),
    }),
  ]),
  indexes: harden(['byKind', 'flat']),
  readFields: harden(['pk', 'sk', 'visible', 'kind']),
  writeFields: harden(['pk', 'sk', 'visible', 'kind']),
  conditionFields: harden(['pk', 'sk', 'visible']),
  filterFields: harden(['visible']),
  fixed: harden({ kind: 'coupon' }),
  operations: harden([
    'get',
    'put',
    'update',
    'delete',
    'query',
    'conditionCheck',
    'transactGet',
    'transactWrite',
  ]),
  limits: harden({ pageSize: 10, transactionSize: 4, itemSize: 4096 }),
});

/**
 * @param {(call: { operation: string, input: any }) => any} respond
 * @param {{ now?: () => number }} [options]
 */
const makeHarness = (respond, options = {}) => {
  /** @type {{ operation: string, input: any }[]} */
  const calls = [];
  /** @type {Record<string, unknown>[]} */
  const events = [];
  let grantNumber = 0;
  const control = makeDynamoControl({
    client: harden({
      async send(call) {
        calls.push(call);
        return respond(call);
      },
    }),
    audit: harden({
      record(event) {
        events.push(event);
      },
      hashKey: key => `key:${key.pk}`,
    }),
    generation: 'generation-1',
    makeGrantId: () => `grant-${(grantNumber += 1)}`,
    sealCursor: makeMemoryCursorSealer({ random: () => 'cursor' }),
    now: options.now ?? (() => 1000),
    catalog,
  });
  return { calls, events, control };
};

test('update and delete return attributes projected through the grant', async t => {
  const { calls, control } = makeHarness(() => harden({ Attributes: row }));
  const root = control.derive(rootRestriction, { name: 'root' });
  await null;
  const key = harden({ pk: 'tenant#a', sk: 'item#1' });
  const expected = {
    type: 'ok',
    value: { pk: 'tenant#a', sk: 'item#1', visible: 'yes', kind: 'coupon' },
  };
  t.deepEqual(
    await root.update(key, harden({ set: harden({ visible: 'yes' }) })),
    expected,
  );
  t.deepEqual(
    await root.delete(
      key,
      harden({ condition: harden({ op: 'exists', field: 'visible' }) }),
    ),
    expected,
  );
  t.is(calls[1].operation, 'deleteItem');
  t.is(calls[1].input.ReturnValues, 'ALL_OLD');
  t.is(calls[1].input.ConditionExpression, 'attribute_exists(#n0)');
});

test('query items are key-checked and projected to the requested fields', async t => {
  let items = harden([row]);
  const { calls, control } = makeHarness(() => harden({ Items: items }));
  const root = control.derive(rootRestriction, { name: 'root' });
  await null;
  t.deepEqual(
    await root.query(
      harden({
        partition: 'tenant#a',
        fields: harden(['visible', 'secret']),
        reverse: true,
        filter: harden({ op: 'eq', field: 'visible', value: 'yes' }),
      }),
    ),
    { type: 'ok', value: { items: [{ visible: 'yes' }] } },
  );
  t.is(calls[0].input.ScanIndexForward, false);
  t.truthy(calls[0].input.FilterExpression);
  t.is(calls[0].input.Limit, 10);

  // A provider that returns a row outside the grant must not leak it.
  items = harden([harden({ ...row, pk: harden({ S: 'other#a' }) })]);
  t.deepEqual(await root.query(harden({ partition: 'tenant#a' })), {
    type: 'invalid-request',
    reason: 'Key is outside the grant',
  });
});

test('query sort ranges narrow, inject, and reject sort conditions', async t => {
  const { calls, control } = makeHarness(() => harden({ Items: [] }));
  const root = control.derive(rootRestriction, { name: 'root' });
  const exact = await root.derive(
    harden({
      ranges: harden([
        harden({
          partition: harden({ exact: 'tenant#a' }),
          sort: harden({ exact: 'item#1' }),
        }),
      ]),
    }),
    harden({}),
  );

  t.is((await exact.query(harden({ partition: 'tenant#a' }))).type, 'ok');
  t.deepEqual(Object.values(calls[0].input.ExpressionAttributeValues), [
    { S: 'tenant#a' },
    { S: 'item#1' },
  ]);
  t.is(
    (
      await exact.query(
        harden({
          partition: 'tenant#a',
          sort: harden({ op: 'eq', field: 'sk', value: 'item#1' }),
        }),
      )
    ).type,
    'ok',
  );
  t.deepEqual(
    await exact.query(
      harden({
        partition: 'tenant#a',
        sort: harden({ op: 'eq', field: 'sk', value: 'item#2' }),
      }),
    ),
    { type: 'invalid-request', reason: 'Sort condition exceeds the grant' },
  );

  t.is(
    (
      await root.query(
        harden({
          partition: 'tenant#a',
          sort: harden({ op: 'begins-with', field: 'sk', value: 'item#9' }),
        }),
      )
    ).type,
    'ok',
  );
  t.deepEqual(
    await root.query(
      harden({
        partition: 'tenant#a',
        sort: harden({ op: 'begins-with', field: 'sk', value: 'other' }),
      }),
    ),
    { type: 'invalid-request', reason: 'Sort condition exceeds the grant' },
  );
  t.deepEqual(
    await root.query(harden({ partition: 'tenant#a', index: 'flat' })),
    {
      type: 'invalid-request',
      reason:
        'A sort-restricted grant cannot query an index without a sort key',
    },
  );
  t.deepEqual(await root.query(harden({ partition: 'tenant#a', limit: 11 })), {
    type: 'limit-exceeded',
  });
  t.is(calls.length, 3);
});

test('transactGet projects each member through its requested fields', async t => {
  const { control } = makeHarness(() =>
    harden({ Responses: harden([harden({ Item: row }), harden({})]) }),
  );
  const root = control.derive(rootRestriction, { name: 'root' });
  await null;
  t.deepEqual(
    await root.transactGet(
      harden([
        harden({
          key: harden({ pk: 'tenant#a', sk: 'item#1' }),
          fields: harden(['sk']),
        }),
        harden({ key: harden({ pk: 'tenant#a', sk: 'item#2' }) }),
      ]),
    ),
    { type: 'ok', value: [{ sk: 'item#1' }, undefined] },
  );
  t.deepEqual(await root.transactGet(harden([])), { type: 'limit-exceeded' });
});

test('transactWrite compiles every member kind with a grant-bound token', async t => {
  const { calls, control } = makeHarness(() => harden({}));
  const root = control.derive(rootRestriction, { name: 'root' });
  await null;
  const key = harden({ pk: 'tenant#a', sk: 'item#1' });
  /** @type {FieldCondition} */
  const condition = harden({ op: 'exists', field: 'visible' });
  /** @type {TransactionWrite[]} */
  const requests = harden([
    harden({
      operation: 'put',
      item: harden({ pk: 'tenant#a', sk: 'item#2', visible: 'yes' }),
      condition,
    }),
    harden({
      operation: 'update',
      key,
      patch: harden({ set: harden({ visible: 'no' }) }),
    }),
    harden({ operation: 'delete', key: harden({ ...key, sk: 'item#3' }) }),
    harden({ operation: 'conditionCheck', key, condition }),
  ]);
  const options = harden({ idempotencyKey: 'once' });
  t.deepEqual(await root.transactWrite(requests, options), {
    type: 'ok',
    value: undefined,
  });
  t.deepEqual(
    calls[0].input.TransactItems.map(member => Object.keys(member)[0]),
    ['Put', 'Update', 'Delete', 'ConditionCheck'],
  );
  t.deepEqual(calls[0].input.TransactItems[0].Put.Item.kind, { S: 'coupon' });
  const token = calls[0].input.ClientRequestToken;
  t.is(typeof token, 'string');

  await root.transactWrite(requests, options);
  t.is(calls[1].input.ClientRequestToken, token, 'retries reuse the token');
  await root.transactWrite(requests);
  t.is(calls[2].input.ClientRequestToken, undefined);

  t.deepEqual(
    await root.transactWrite(
      harden([
        harden({
          operation: 'put',
          item: harden({ pk: 'other#a', sk: 'item#1' }),
        }),
      ]),
    ),
    { type: 'invalid-request', reason: 'Key is outside the grant' },
  );
  t.deepEqual(await root.transactWrite(harden([...requests, requests[0]])), {
    type: 'limit-exceeded',
  });
  t.is(calls.length, 3);
});

test('rate limits apply per one-second window', async t => {
  let time = 1000;
  const { calls, control } = makeHarness(() => harden({}), {
    now: () => time,
  });
  const root = control.derive(
    harden({
      ...rootRestriction,
      limits: harden({ ...rootRestriction.limits, ratePerSecond: 1 }),
    }),
    { name: 'root' },
  );
  await null;
  const key = harden({ pk: 'tenant#a', sk: 'item#1' });
  t.deepEqual(await root.get(key), { type: 'ok', value: undefined });
  t.deepEqual(await root.get(key), { type: 'limit-exceeded' });
  time += 1000;
  t.deepEqual(await root.get(key), { type: 'ok', value: undefined });
  t.is(calls.length, 2);
});

test('cancellation revokes a derived grant and inspect reports it', async t => {
  const { calls, control, events } = makeHarness(() => harden({}));
  const root = control.derive(rootRestriction, { name: 'root' });
  /** @type {(reason: Error) => void} */
  let cancel = () => {};
  /** @type {Promise<never>} */
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  const child = await root.derive(
    harden({ operations: harden(['get']) }),
    harden({ cancelled, name: 'child' }),
  );
  t.deepEqual(control.inspect('child'), {
    grantId: 'child',
    parentId: 'root',
    generation: 'generation-1',
    live: true,
    restrictionDigest: control.inspect('child')?.restrictionDigest,
  });
  cancel(Error('cancelled'));
  await cancelled.catch(() => {});
  await null;
  t.false(control.inspect('child')?.live);
  t.true(events.some(e => e.grantId === 'child' && e.operation === 'revoke'));
  t.deepEqual(await child.get(harden({ pk: 'tenant#a', sk: 'item#1' })), {
    type: 'revoked',
  });
  await t.throwsAsync(() => child.derive(harden({}), harden({})), {
    message: 'revoked',
  });
  t.is(control.inspect('missing'), undefined);
  t.false(control.revoke('missing'));
  t.false(control.revoke('child'));
  t.is(calls.length, 0);
});

test('provider exceptions classify retryable throttles as unavailable', async t => {
  const throttled = Object.assign(Error('slow down'), {
    name: 'ThrottlingException',
    $metadata: harden({ requestId: 'request-1' }),
  });
  const { control, events } = makeHarness(() => {
    throw throttled;
  });
  const root = control.derive(rootRestriction, { name: 'root' });
  await null;
  t.deepEqual(await root.get(harden({ pk: 'tenant#a', sk: 'item#1' })), {
    type: 'unavailable',
    retryable: true,
  });
  t.is(events.at(-1)?.requestId, 'request-1');
});

test('aggregated SDK clients are called by method name', async t => {
  const calls = [];
  const control = makeDynamoControl({
    client: harden({
      async getItem(input) {
        calls.push(input);
        return harden({ Item: row });
      },
    }),
    audit: harden({ record() {}, hashKey: () => 'hash' }),
    generation: 'g',
    sealCursor: makeMemoryCursorSealer({ random: () => 'cursor' }),
    catalog,
  });
  const root = control.derive(rootRestriction, { name: 'root' });
  await null;
  const key = harden({ pk: 'tenant#a', sk: 'item#1' });
  t.is((await root.get(key)).type, 'ok');
  t.is(calls.length, 1);
  t.deepEqual(await root.delete(key), {
    type: 'invalid-request',
    reason: 'DynamoDB client does not implement the requested operation',
  });
});
