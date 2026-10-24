// @ts-check

/* eslint-disable no-await-in-loop */
import '@endo/init';

import test from 'ava';
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';

import { makeDynamoControl, makeMemoryCursorSealer } from '../../index.js';
import { makeHttpDynamoClient } from './_http-client.js';

/**
 * Runs against DynamoDB Local when `EXO_DYNAMODB_LOCAL_ENDPOINT` names it,
 * for example `http://localhost:8000` after
 * `docker run -p 8000:8000 amazon/dynamodb-local`. The same protocol also
 * runs against `moto_server` with `EXO_DYNAMODB_LOCAL_NO_TOKENS=1`.
 */
const endpoint = process.env.EXO_DYNAMODB_LOCAL_ENDPOINT;
const maybe = endpoint ? test.serial : test.skip;

const tableName = `exo-dynamodb-${Date.now().toString(36)}`;

maybe('data behavior matches DynamoDB Local', async t => {
  const http = makeHttpDynamoClient(/** @type {string} */ (endpoint), fetch);
  await http.control('createTable', {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'queue', AttributeType: 'S' },
      { AttributeName: 'due', AttributeType: 'N' },
    ],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'queue-gsi',
        KeySchema: [
          { AttributeName: 'queue', KeyType: 'HASH' },
          { AttributeName: 'due', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  });
  t.teardown(() => http.control('deleteTable', { TableName: tableName }));
  let cursorNumber = 0;
  const control = makeDynamoControl({
    client: http,
    catalog: harden({
      coupons: harden({
        tableName,
        partitionKey: harden({ name: 'pk', type: 'string' }),
        indexes: harden({
          queue: harden({
            indexName: 'queue-gsi',
            partitionKey: harden({ name: 'queue', type: 'string' }),
            sortKey: harden({ name: 'due', type: 'number' }),
          }),
        }),
      }),
    }),
    audit: harden({ record() {}, hashKey: () => 'k' }),
    sealCursor: makeMemoryCursorSealer({
      random: () => `c${(cursorNumber += 1)}`,
    }),
  });
  const root = await control.derive(
    harden({
      table: 'coupons',
      keySpace: harden([harden({ partition: harden({ prefix: 'COUPON#' }) })]),
      indexes: harden({
        queue: harden([
          harden({ partition: harden({ exact: 'COUPON#issued' }) }),
        ]),
      }),
    }),
  );
  if (root.type !== 'ok') throw Error(root.type);
  const db = root.value.capability;
  // a row outside the key space, written host-side, shares the index partition
  await http.send({
    operation: 'putItem',
    input: {
      TableName: tableName,
      Item: {
        pk: { S: 'POOL' },
        queue: { S: 'COUPON#issued' },
        due: { N: '1' },
      },
    },
  });
  for (const n of [1, 2, 3]) {
    t.like(
      await db.put(
        harden({
          pk: `COUPON#${n}`,
          queue: 'COUPON#issued',
          due: n,
          blob: frozenBytes(new Uint8Array([n])),
        }),
        {
          condition: harden({ not: harden({ exists: 'pk' }) }),
        },
      ),
      { type: 'ok' },
    );
  }
  t.deepEqual(
    await db.put(harden({ pk: 'COUPON#1' }), {
      condition: harden({ not: harden({ exists: 'pk' }) }),
    }),
    { type: 'condition-failed' },
  );
  const seen = [];
  let cursor;
  do {
    const page = await db.query(
      harden({
        index: 'queue',
        partition: 'COUPON#issued',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (page.type !== 'ok') throw Error(JSON.stringify(page));
    seen.push(...page.value.items.map(item => item.pk));
    cursor = page.value.cursor;
  } while (cursor);
  t.deepEqual(seen.sort(), ['COUPON#1', 'COUPON#2', 'COUPON#3']);
  t.like(
    await db.query(
      harden({ index: 'queue', partition: 'COUPON#issued', consistent: true }),
    ),
    {
      type: 'invalid-request',
    },
  );
  const canceled = await db.transactWrite(
    harden([
      harden({
        operation: 'update',
        key: harden({ pk: 'COUPON#1' }),
        patch: harden({ add: harden({ uses: 1 }) }),
      }),
      harden({
        operation: 'conditionCheck',
        key: harden({ pk: 'COUPON#2' }),
        condition: harden({ field: 'due', eq: 99 }),
      }),
    ]),
  );
  t.deepEqual(canceled, {
    type: 'transaction-canceled',
    failures: [{ type: 'none' }, { type: 'condition-failed' }],
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    t.like(
      await db.update(
        harden({ pk: 'COUPON#1' }),
        harden({ add: harden({ uses: 1 }) }),
        {
          idempotencyKey: 'redeem-1',
        },
      ),
      { type: 'ok' },
    );
  }
  const read = await db.get(harden({ pk: 'COUPON#1' }), { consistent: true });
  if (read.type !== 'ok' || read.value === undefined) throw Error('get');
  // DynamoDB and DynamoDB Local honor client request tokens. Emulators that
  // do not (moto) set EXO_DYNAMODB_LOCAL_NO_TOKENS to skip only this check.
  if (!process.env.EXO_DYNAMODB_LOCAL_NO_TOKENS) t.is(read.value.uses, 1);
  t.deepEqual(
    [...thawedBytes(/** @type {Uint8Array} */ (read.value.blob))],
    [1],
  );
});
