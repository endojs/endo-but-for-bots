// @ts-check

import '@endo/init';

import test from 'ava';
import { M } from '@endo/patterns';

import { makeDynamoControl, makeMemoryCursorSealer } from '../index.js';

/** @import { Restriction } from '../types.js' */

const makeHarness = () => {
  const calls = [];
  const events = [];
  let queryPage = 0;
  const client = harden({
    async send(call) {
      calls.push(call);
      if (call.operation === 'getItem') {
        return harden({
          Item: harden({
            pk: harden({ S: 'tenant#a' }),
            sk: harden({ S: 'item#1' }),
            visible: harden({ S: 'yes' }),
            secret: harden({ S: 'hidden' }),
            kind: harden({ S: 'coupon' }),
          }),
        });
      }
      if (call.operation === 'query') {
        queryPage += 1;
        return queryPage === 1
          ? harden({
              Items: harden([]),
              LastEvaluatedKey: harden({
                pk: harden({ S: 'tenant#a' }),
                sk: harden({ S: 'item#0' }),
              }),
            })
          : harden({ Items: harden([]) });
      }
      if (call.operation === 'transactGetItems') {
        return harden({ Responses: harden([harden({})]) });
      }
      return harden({});
    },
  });
  const audit = harden({
    record(event) {
      events.push(event);
    },
    hashKey(key) {
      return `key:${key.pk}`;
    },
  });
  let grantNumber = 0;
  let cursorNumber = 0;
  const control = makeDynamoControl({
    client,
    audit,
    generation: 'generation-1',
    makeGrantId: () => `grant-${(grantNumber += 1)}`,
    sealCursor: makeMemoryCursorSealer({
      random: () => `cursor-${(cursorNumber += 1)}`,
    }),
    now: () => 1000,
    catalog: harden({
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
        }),
      }),
    }),
  });
  return { calls, events, control };
};

/** @type {Restriction} */
const rootRestriction = harden({
  table: 'app',
  ranges: harden([
    harden({
      partition: harden({ prefix: 'tenant#' }),
      sort: harden({ prefix: 'item#' }),
    }),
  ]),
  indexes: harden(['byKind']),
  readFields: harden(['pk', 'sk', 'visible', 'secret', 'kind']),
  writeFields: harden(['pk', 'sk', 'visible', 'secret', 'kind']),
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

test('recursive attenuation checks every ancestor before sending', async t => {
  const { calls, control, events } = makeHarness();
  const root = control.derive(rootRestriction, { name: 'root' });
  const child = await root.derive(
    harden({
      ranges: harden([
        harden({
          partition: harden({ prefix: 'tenant#a' }),
          sort: harden({ prefix: 'item#' }),
        }),
      ]),
      readFields: harden(['pk', 'sk', 'visible']),
      operations: harden(['get', 'put', 'query', 'transactGet']),
      limits: harden({ pageSize: 2 }),
    }),
    harden({}),
  );
  const grandchild = await child.derive(
    harden({
      ranges: harden([
        harden({
          partition: harden({ exact: 'tenant#a' }),
          sort: harden({ exact: 'item#1' }),
        }),
      ]),
      operations: harden(['get']),
    }),
    harden({}),
  );

  t.deepEqual(await grandchild.get(harden({ pk: 'tenant#a', sk: 'item#1' })), {
    type: 'ok',
    value: { pk: 'tenant#a', sk: 'item#1', visible: 'yes' },
  });
  t.is(calls.length, 1);
  t.true(events.some(event => event.operation === 'get'));
  t.false(JSON.stringify(events).includes('hidden'));
  t.false(JSON.stringify(events).includes('physical-table'));

  t.deepEqual(await grandchild.get(harden({ pk: 'tenant#b', sk: 'item#1' })), {
    type: 'invalid-request',
    reason: 'Key is outside the grant',
  });
  t.is(calls.length, 1, 'denial happened before the client');

  t.deepEqual(
    await grandchild.put(
      harden({ pk: 'tenant#a', sk: 'item#1', visible: 'yes' }),
    ),
    { type: 'invalid-request', reason: 'Operation (a string) is not allowed' },
  );
  t.is(calls.length, 1);
});

test('fixed fields, conditions, and transaction member rights are bounded', async t => {
  const { calls, control } = makeHarness();
  const root = control.derive(rootRestriction, { name: 'root' });
  await null;

  t.deepEqual(
    await root.put(
      harden({ pk: 'tenant#a', sk: 'item#1', visible: 'yes' }),
      harden({
        condition: harden({ op: 'not-exists', field: 'visible' }),
      }),
    ),
    { type: 'ok', value: undefined },
  );
  t.deepEqual(calls[0].input.Item.kind, { S: 'coupon' });
  t.false('ReturnValuesOnConditionCheckFailure' in calls[0].input);

  const reader = await root.derive(
    harden({ operations: harden(['transactGet']) }),
    harden({}),
  );
  t.deepEqual(
    await reader.transactGet(
      harden([harden({ key: harden({ pk: 'tenant#a', sk: 'item#1' }) })]),
    ),
    {
      type: 'invalid-request',
      reason: 'Transaction get member is not allowed',
    },
  );
  t.is(calls.length, 1);
});

test('pagination cursors are grant-bound and revocation closes descendants', async t => {
  const { calls, control } = makeHarness();
  const root = control.derive(rootRestriction, { name: 'root' });
  const child = await root.derive(
    harden({
      ranges: harden([harden({ partition: harden({ exact: 'tenant#a' }) })]),
      readFields: harden(['pk', 'sk']),
    }),
    harden({}),
  );
  const first = await child.query(harden({ partition: 'tenant#a', limit: 2 }));
  t.is(first.type, 'ok');
  if (first.type !== 'ok') return;
  t.truthy(first.value.cursor);
  t.deepEqual(
    await child.query(
      harden({ partition: 'tenant#a', limit: 2, cursor: 'forged' }),
    ),
    { type: 'invalid-request', reason: 'Cursor is invalid' },
  );
  t.deepEqual(
    await root.query(
      harden({ partition: 'tenant#a', limit: 2, cursor: first.value.cursor }),
    ),
    { type: 'invalid-request', reason: 'Cursor belongs to another grant' },
  );
  t.true(control.revoke('root'));
  t.deepEqual(await child.get(harden({ pk: 'tenant#a', sk: 'item#1' })), {
    type: 'revoked',
  });
  t.is(calls.length, 1);
});

test('typed updates compile without raw expression authority', async t => {
  const { calls, control } = makeHarness();
  const root = control.derive(rootRestriction, { name: 'root' });
  await null;
  t.deepEqual(
    await root.update(
      harden({ pk: 'tenant#a', sk: 'item#1' }),
      harden({ set: harden({ visible: 'changed' }) }),
      harden({
        condition: harden({ op: 'eq', field: 'visible', value: 'yes' }),
      }),
    ),
    { type: 'ok', value: undefined },
  );
  t.is(calls.length, 1);
  t.is(calls[0].operation, 'updateItem');
  t.is(calls[0].input.UpdateExpression, 'SET #u0 = :u0');
  t.is(calls[0].input.ConditionExpression, '#n0 = :v0');
  t.false('ReturnValuesOnConditionCheckFailure' in calls[0].input);
});

test('AWS exceptions become safe tagged failures', async t => {
  const makeFailingControl = error =>
    makeDynamoControl({
      client: harden({
        async send() {
          throw error;
        },
      }),
      catalog: harden({
        app: harden({
          tableName: 'physical-table',
          partitionKey: harden({ name: 'pk', type: 'string' }),
          sortKey: harden({ name: 'sk', type: 'string' }),
        }),
      }),
      audit: harden({ record() {}, hashKey: () => 'hash' }),
      generation: 'g',
      sealCursor: makeMemoryCursorSealer({ random: () => 'cursor' }),
    }).derive(rootRestriction, { name: 'root' });

  await null;

  const condition = Error('private provider detail');
  condition.name = 'ConditionalCheckFailedException';
  t.deepEqual(
    await makeFailingControl(condition).put(
      harden({ pk: 'tenant#a', sk: 'item#1', visible: 'yes' }),
    ),
    { type: 'condition-failed' },
  );

  const canceled = /** @type {Error & { CancellationReasons: any[] }} */ (
    Error('private cancellation detail')
  );
  canceled.name = 'TransactionCanceledException';
  canceled.CancellationReasons = harden([
    harden({ Code: 'ConditionalCheckFailed', Item: harden({ secret: 'x' }) }),
    harden({ Code: 'TransactionConflict' }),
  ]);
  t.deepEqual(
    await makeFailingControl(canceled).transactWrite(
      harden([
        harden({
          operation: 'delete',
          key: harden({ pk: 'tenant#a', sk: 'item#1' }),
        }),
      ]),
    ),
    {
      type: 'transaction-canceled',
      failures: [{ type: 'condition-failed' }, { type: 'conflict' }],
    },
  );
});

test('query bounds and closed expressions fail before send', async t => {
  const { calls, control } = makeHarness();
  const root = control.derive(rootRestriction, { name: 'root' });
  const child = await root.derive(
    harden({
      ranges: harden([harden({ partition: harden({ exact: 'tenant#a' }) })]),
    }),
    harden({}),
  );

  t.deepEqual(await child.query(harden({ partition: 'tenant#b' })), {
    type: 'invalid-request',
    reason: 'Query partition is outside the grant',
  });
  t.deepEqual(
    await child.put(
      harden({ pk: 'tenant#a', sk: 'item#1', visible: 'yes' }),
      harden({
        condition: /** @type {any} */ (
          harden({ op: 'raw', field: 'visible', value: 'yes' })
        ),
      }),
    ),
    { type: 'invalid-request', reason: 'Unknown condition operation' },
  );
  t.is(calls.length, 0);
});

test('complete-item guards and fixed fields make partial updates fail closed', async t => {
  const { calls, control } = makeHarness();
  const shaped = control.derive(
    harden({ ...rootRestriction, itemShape: M.record() }),
    { name: 'shaped' },
  );
  await null;
  t.deepEqual(
    await shaped.update(
      harden({ pk: 'tenant#a', sk: 'item#1' }),
      harden({ set: harden({ visible: 'yes' }) }),
    ),
    {
      type: 'invalid-request',
      reason: 'Partial updates are unavailable with a complete-item guard',
    },
  );
  const root = control.derive(rootRestriction, { name: 'other-root' });
  t.deepEqual(
    await root.transactWrite(
      harden([
        harden({
          operation: 'update',
          key: harden({ pk: 'tenant#a', sk: 'item#1' }),
          patch: harden({ set: harden({ kind: 'other' }) }),
        }),
      ]),
    ),
    { type: 'invalid-request', reason: 'A fixed field cannot be updated' },
  );
  t.is(calls.length, 0);
});

test('revocation is prospective for an admitted request', async t => {
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const pending = new Promise(resolve => {
    release = resolve;
  });
  const { calls } = makeHarness();
  calls.length = 0;
  const client = harden({
    async send(call) {
      calls.push(call);
      await pending;
      return harden({});
    },
  });
  const isolated = makeDynamoControl({
    client,
    catalog: harden({
      app: harden({
        tableName: 'physical-table',
        partitionKey: harden({ name: 'pk', type: 'string' }),
        sortKey: harden({ name: 'sk', type: 'string' }),
      }),
    }),
    audit: harden({ record() {}, hashKey: () => 'hash' }),
    generation: 'g',
    sealCursor: makeMemoryCursorSealer({ random: () => 'cursor' }),
  });
  const root = isolated.derive(rootRestriction, { name: 'root' });
  const operation = root.get(harden({ pk: 'tenant#a', sk: 'item#1' }));
  await Promise.resolve();
  isolated.revoke('root');
  release();
  t.deepEqual(await operation, { type: 'ok', value: undefined });
  t.is(calls.length, 1);
});
