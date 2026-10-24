// @ts-check

/* eslint-disable no-await-in-loop */
import '@endo/init';

import test from 'ava';
import { makeCopySet } from '@endo/patterns';

import { appRoot, expectOk, makeHarness } from './_harness.js';

const T = 'app-physical';

test('derive results carry the capability and grant id', async t => {
  const { control } = makeHarness();
  const root = expectOk(t, await control.derive(appRoot));
  t.is(typeof root.grantId, 'string');
  const child = expectOk(
    t,
    await root.capability.derive(harden({ operations: harden(['get']) })),
  );
  t.not(child.grantId, root.grantId);
  const lineage = expectOk(t, await control.lineage(child.grantId));
  t.deepEqual(
    lineage.map(entry => entry.grantId),
    [root.grantId, child.grantId],
  );
  t.is(lineage[1].parentId, root.grantId);
  t.true(lineage.every(entry => entry.live));
});

test('recursive checks deny before send at every level', async t => {
  const { calls, control } = makeHarness();
  const { capability: root } = expectOk(t, await control.derive(appRoot));
  const { capability: child } = expectOk(
    t,
    await root.derive(
      harden({
        keySpace: harden([
          harden({
            partition: harden({ exact: 'tenant#a' }),
            sort: harden({ prefix: 'item#' }),
          }),
        ]),
        shape: harden({
          readFields: harden(['pk', 'sk', 'visible']),
          writeFields: harden(['pk', 'sk', 'visible']),
          conditionFields: harden(['visible']),
          filterFields: harden(['visible']),
        }),
        operations: harden(['get', 'put', 'update', 'query', 'transactWrite']),
      }),
    ),
  );
  const { capability: grandchild } = expectOk(
    t,
    await child.derive(
      harden({
        keySpace: harden([
          harden({
            partition: harden({ exact: 'tenant#a' }),
            sort: harden({ exact: 'item#1' }),
          }),
        ]),
        operations: harden(['get', 'put', 'query']),
      }),
    ),
  );

  const denied = async (promise, pattern) => {
    const result = await promise;
    t.is(result.type, 'invalid-request', JSON.stringify(result));
    if (pattern) t.regex(/** @type {any} */ (result).reason, pattern);
  };
  // key outside the grandchild's exact sort key
  await denied(
    grandchild.get(harden({ pk: 'tenant#a', sk: 'item#10' })),
    /key/,
  );
  // prefix outside the child
  await denied(child.get(harden({ pk: 'tenant#b', sk: 'item#1' })), /key/);
  // malformed key shape
  await denied(child.get(harden({ pk: 'tenant#a' })), /key/);
  // operation removed
  await denied(
    grandchild.delete(harden({ pk: 'tenant#a', sk: 'item#1' })),
    /delete/,
  );
  // unwritable field
  await denied(
    grandchild.put(harden({ pk: 'tenant#a', sk: 'item#1', secret: 'x' })),
    /secret/,
  );
  // conflicting fixed field
  await denied(
    grandchild.put(harden({ pk: 'tenant#a', sk: 'item#1', kind: 'other' })),
    /fixed/,
  );
  // condition field not allowed
  await denied(
    grandchild.put(harden({ pk: 'tenant#a', sk: 'item#1' }), {
      condition: harden({ field: 'count', eq: 1 }),
    }),
    /condition field count/,
  );
  // raw expression escape hatches are not options
  await denied(
    child.put(harden({ pk: 'tenant#a', sk: 'item#1' }), {
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
    /unexpected field/,
  );
  // unreadable projection
  await denied(
    child.get(harden({ pk: 'tenant#a', sk: 'item#1' }), {
      fields: harden(['secret']),
    }),
    /secret/,
  );
  // index removed by omission is still inherited, but the GSI forbids
  // consistent reads
  await denied(
    child.query(
      harden({ index: 'byKind', partition: 'coupon', consistent: true }),
    ),
    /consistent/,
  );
  // index partition outside the grant
  await denied(
    child.query(harden({ index: 'byKind', partition: 'other' })),
    /partition/,
  );
  // filter field not allowed for the grandchild's ancestors
  await denied(
    grandchild.query(
      harden({
        partition: 'tenant#a',
        filter: harden({ field: 'count', eq: 1 }),
      }),
    ),
    /filter field count/,
  );
  // filters cannot name key attributes
  await denied(
    child.query(
      harden({
        partition: 'tenant#a',
        filter: harden({ field: 'sk', eq: 'x' }),
      }),
    ),
    /key field/,
  );
  // forged cursor
  await denied(
    child.query(harden({ partition: 'tenant#a', cursor: 'forged' })),
    /cursor/,
  );
  // transaction rights: the grandchild has no transactWrite
  await denied(
    grandchild.transactWrite(
      harden([
        harden({
          operation: 'put',
          item: harden({ pk: 'tenant#a', sk: 'item#1' }),
        }),
      ]),
    ),
    /transactWrite/,
  );
  // transaction member needs its own right: the child has no delete
  await denied(
    child.transactWrite(
      harden([
        harden({
          operation: 'delete',
          key: harden({ pk: 'tenant#a', sk: 'item#1' }),
        }),
      ]),
    ),
    /delete/,
  );
  // a member outside the key space fails the whole transaction
  await denied(
    child.transactWrite(
      harden([
        harden({
          operation: 'put',
          item: harden({ pk: 'tenant#a', sk: 'item#1' }),
        }),
        harden({
          operation: 'put',
          item: harden({ pk: 'tenant#z', sk: 'item#1' }),
        }),
      ]),
    ),
    /key/,
  );
  t.deepEqual(calls, [], 'no denied request reached the client');
});

test('positive point operations compile typed conditions and patches', async t => {
  const { fake, calls, control } = makeHarness();
  const { capability } = expectOk(t, await control.derive(appRoot));
  const key = harden({ pk: 'tenant#a', sk: 'item#1' });
  t.deepEqual(
    await capability.put(
      harden({ ...key, visible: 'yes', secret: 's', count: 1 }),
      {
        condition: harden({ not: harden({ exists: 'pk' }) }),
      },
    ),
    { type: 'ok', value: undefined },
  );
  t.deepEqual(fake.peek(T, key), {
    ...key,
    visible: 'yes',
    secret: 's',
    count: 1,
    kind: 'coupon',
  });
  t.deepEqual(
    await capability.put(harden({ ...key }), {
      condition: harden({ not: harden({ exists: 'pk' }) }),
    }),
    { type: 'condition-failed' },
  );
  const updated = expectOk(
    t,
    await capability.update(
      key,
      harden({ set: harden({ visible: 'no' }), add: harden({ count: 2 }) }),
      { condition: harden({ field: 'count', between: harden([0, 5]) }) },
    ),
  );
  t.like(updated, { visible: 'no', count: 3, kind: 'coupon' });
  const updateCall = calls.find(call => call.operation === 'updateItem');
  t.regex(
    updateCall.input.UpdateExpression,
    /^SET #n\d = :v\d, #n\d = :v\d ADD #n\d :v\d$/,
  );
  t.is(updateCall.input.ReturnValues, 'ALL_NEW');
  t.deepEqual(
    await capability.update(key, harden({ set: harden({ visible: 'x' }) }), {
      condition: harden({ field: 'count', gt: 10 }),
    }),
    { type: 'condition-failed' },
  );
  const removed = expectOk(
    t,
    await capability.delete(key, {
      condition: harden({ field: 'visible', beginsWith: 'n' }),
    }),
  );
  t.like(removed, { visible: 'no' });
  t.is(fake.peek(T, key), undefined);
  for (const call of calls) {
    t.false('ReturnValuesOnConditionCheckFailure' in call.input);
  }
});

test('sets marshal through add and delete patches', async t => {
  const { fake, control } = makeHarness();
  const { capability } = expectOk(
    t,
    await control.derive(
      harden({
        table: 'app',
        shape: harden({ writeFields: harden(['tags']) }),
      }),
    ),
  );
  const key = harden({ pk: 'p', sk: 's' });
  expectOk(
    t,
    await capability.update(
      key,
      harden({ add: harden({ tags: makeCopySet(['a', 'b']) }) }),
    ),
  );
  expectOk(
    t,
    await capability.update(
      key,
      harden({ delete: harden({ tags: makeCopySet(['a']) }) }),
    ),
  );
  t.deepEqual(fake.peek(T, key).tags, makeCopySet(['b']));
});

test('transactions validate every member and preserve cancellation positions', async t => {
  const { fake, calls, control } = makeHarness();
  const { capability } = expectOk(t, await control.derive(appRoot));
  fake.seed(T, { pk: 'tenant#a', sk: 'item#2', kind: 'coupon', count: 1 });
  const result = await capability.transactWrite(
    harden([
      harden({
        operation: 'put',
        item: harden({ pk: 'tenant#a', sk: 'item#1' }),
      }),
      harden({
        operation: 'conditionCheck',
        key: harden({ pk: 'tenant#a', sk: 'item#2' }),
        condition: harden({ field: 'count', eq: 99 }),
      }),
      harden({
        operation: 'update',
        key: harden({ pk: 'tenant#a', sk: 'item#2' }),
        patch: harden({ add: harden({ count: 1 }) }),
      }),
    ]),
  );
  t.deepEqual(result, {
    type: 'transaction-canceled',
    failures: [
      { type: 'none' },
      { type: 'condition-failed' },
      { type: 'none' },
    ],
  });
  t.is(fake.peek(T, { pk: 'tenant#a', sk: 'item#1' }), undefined);
  const call = calls.at(-1);
  t.deepEqual(
    call.input.TransactItems.map(member => Object.keys(member)[0]),
    ['Put', 'ConditionCheck', 'Update'],
  );
  t.is(call.input.ReturnConsumedCapacity, 'NONE');
  t.deepEqual(await capability.transactWrite(harden([])), {
    type: 'limit-exceeded',
    limit: 'transaction',
    retryable: false,
  });
  const five = harden(
    [1, 2, 3, 4, 5].map(n =>
      harden({
        operation: 'put',
        item: harden({ pk: 'tenant#a', sk: `item#${n}` }),
      }),
    ),
  );
  t.deepEqual(await capability.transactWrite(five), {
    type: 'limit-exceeded',
    limit: 'transaction',
    retryable: false,
  });
  const got = expectOk(
    t,
    await capability.transactGet(
      harden([
        harden({
          key: harden({ pk: 'tenant#a', sk: 'item#2' }),
          fields: harden(['count']),
        }),
        harden({ key: harden({ pk: 'tenant#a', sk: 'item#3' }) }),
      ]),
    ),
  );
  t.deepEqual(got, [{ count: 1 }, undefined]);
});

test('idempotency keys reach individual writes and transactions', async t => {
  const { fake, calls, control } = makeHarness();
  const { capability: root } = expectOk(t, await control.derive(appRoot));
  const { capability: sibling } = expectOk(t, await root.derive(harden({})));
  const key = harden({ pk: 'tenant#a', sk: 'item#1' });
  const bump = harden({ add: harden({ count: 1 }) });
  t.deepEqual(await root.update(key, bump, { idempotencyKey: 'op-1' }), {
    type: 'ok',
    value: undefined,
  });
  t.deepEqual(await root.update(key, bump, { idempotencyKey: 'op-1' }), {
    type: 'ok',
    value: undefined,
  });
  t.is(fake.peek(T, key).count, 1, 'a retried idempotent write applies once');
  const tokens = calls.map(call => call.input.ClientRequestToken);
  t.is(tokens[0], tokens[1]);
  t.true(String(tokens[0]).length <= 36);
  await sibling.update(key, bump, { idempotencyKey: 'op-1' });
  t.not(
    calls.at(-1).input.ClientRequestToken,
    tokens[0],
    'grants cannot collide',
  );
  t.is(fake.peek(T, key).count, 2);
  t.deepEqual(
    await root.put(harden({ ...key }), {
      idempotencyKey: 'op-2',
      condition: harden({ not: harden({ exists: 'pk' }) }),
    }),
    { type: 'condition-failed' },
  );
  await root.transactWrite(
    harden([
      harden({
        operation: 'put',
        item: harden({ pk: 'tenant#a', sk: 'item#9' }),
      }),
    ]),
    { idempotencyKey: 'tx-1' },
  );
  t.is(calls.at(-1).input.ClientRequestToken.length, 36);
});

test('query projects, pages, and returns empty pages with a cursor', async t => {
  const { fake, calls, control } = makeHarness();
  const { capability } = expectOk(t, await control.derive(appRoot));
  for (let n = 0; n < 5; n += 1) {
    fake.seed(T, {
      pk: 'tenant#a',
      sk: `item#${n}`,
      visible: n % 2 ? 'yes' : 'no',
      secret: 's',
      kind: 'coupon',
    });
  }
  const { capability: reader } = expectOk(
    t,
    await capability.derive(
      harden({ shape: harden({ readFields: harden(['sk', 'visible']) }) }),
    ),
  );
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = expectOk(
      t,
      await reader.query(
        harden({
          partition: 'tenant#a',
          filter: harden({ field: 'visible', eq: 'yes' }),
          limit: 2,
          ...(cursor ? { cursor } : {}),
        }),
      ),
    );
    pages += 1;
    seen.push(...page.items);
    cursor = page.cursor;
    t.false('count' in page);
  } while (cursor !== undefined);
  t.is(pages, 3);
  t.deepEqual(seen, [
    { sk: 'item#1', visible: 'yes' },
    { sk: 'item#3', visible: 'yes' },
  ]);
  const empty = expectOk(
    t,
    await reader.query(
      harden({
        partition: 'tenant#a',
        filter: harden({ field: 'visible', eq: 'none' }),
        limit: 2,
      }),
    ),
  );
  t.deepEqual(empty.items, []);
  t.is(typeof empty.cursor, 'string', 'an empty filtered page may continue');
  t.true(
    calls.every(
      call =>
        !('ExclusiveStartKey' in call.input) ||
        typeof call.input.ExclusiveStartKey === 'object',
    ),
  );
  // cursors are bound to the grant and query
  t.like(
    await capability.query(
      harden({
        partition: 'tenant#a',
        limit: 2,
        filter: harden({ field: 'visible', eq: 'none' }),
        cursor: empty.cursor,
      }),
    ),
    { type: 'invalid-request', reason: 'cursor belongs to another grant' },
  );
  t.like(
    await reader.query(
      harden({ partition: 'tenant#a', descending: true, cursor: empty.cursor }),
    ),
    { type: 'invalid-request', reason: 'cursor belongs to another query' },
  );
  t.deepEqual(
    await reader.query(harden({ partition: 'tenant#a', limit: 11 })),
    {
      type: 'limit-exceeded',
      limit: 'page',
      retryable: false,
    },
  );
});

test('provider failures collapse to safe tagged results', async t => {
  const leaky = name =>
    Object.assign(
      new Error(
        'Requested resource not found: Table: app-physical, key secret',
      ),
      { name, $metadata: { requestId: 'aws-request-1' } },
    );
  /** @type {any} */
  let failure = leaky('ResourceNotFoundException');
  const { control, events } = makeHarness({
    client: harden({
      async send() {
        throw failure;
      },
    }),
  });
  const { capability } = expectOk(t, await control.derive(appRoot));
  const key = harden({ pk: 'tenant#a', sk: 'item#1' });
  t.deepEqual(await capability.get(key), {
    type: 'unavailable',
    retryable: false,
  });
  failure = leaky('ProvisionedThroughputExceededException');
  t.deepEqual(await capability.get(key), {
    type: 'unavailable',
    retryable: true,
  });
  failure = Object.assign(new TypeError('socket hang up: app-physical'), {});
  const result = await capability.get(key);
  t.deepEqual(result, { type: 'unavailable', retryable: false });
  t.false(JSON.stringify(result).includes('app-physical'));
  t.is(events.at(-2).requestId, 'aws-request-1');
});

test('rate limits are per grant per second and retryable', async t => {
  let time = 0;
  const { calls, control } = makeHarness({ now: () => time });
  const { capability } = expectOk(
    t,
    await control.derive(
      harden({ ...appRoot, limits: harden({ requestsPerSecond: 2 }) }),
    ),
  );
  const key = harden({ pk: 'tenant#a', sk: 'item#1' });
  expectOk(t, await capability.get(key));
  expectOk(t, await capability.get(key));
  t.deepEqual(await capability.get(key), {
    type: 'limit-exceeded',
    limit: 'rate',
    retryable: true,
  });
  t.is(calls.length, 2);
  time = 1000;
  expectOk(t, await capability.get(key));
});

test('item size limit counts the injected item', async t => {
  const { calls, control } = makeHarness();
  const { capability } = expectOk(t, await control.derive(appRoot));
  t.deepEqual(
    await capability.put(
      harden({ pk: 'tenant#a', sk: 'item#1', secret: 'x'.repeat(5000) }),
    ),
    { type: 'limit-exceeded', limit: 'item-size', retryable: false },
  );
  t.is(calls.length, 0);
});

test('aggregated SDK clients are called by method name', async t => {
  const seen = [];
  const { control } = makeHarness({
    client: harden({
      async getItem(input) {
        seen.push(input);
        return harden({});
      },
    }),
  });
  const { capability } = expectOk(t, await control.derive(appRoot));
  expectOk(t, await capability.get(harden({ pk: 'tenant#a', sk: 'item#1' })));
  t.is(seen[0].TableName, 'app-physical');
});
