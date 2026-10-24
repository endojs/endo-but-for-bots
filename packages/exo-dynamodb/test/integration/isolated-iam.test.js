// @ts-check

import '@endo/init';

import test from 'ava';

import { makeDynamoControl, makeMemoryCursorSealer } from '../../index.js';

/**
 * Proves IAM and the capability are independent ceilings against real AWS.
 * The operator provisions two tables and runs the test under a role whose
 * policy permits only `EXO_DYNAMODB_IAM_ALLOWED_TABLE`. The broker catalog is
 * intentionally over-broad and names both. Requires the optional
 * `@aws-sdk/client-dynamodb` package, which this package does not depend on.
 */
const allowedTable = process.env.EXO_DYNAMODB_IAM_ALLOWED_TABLE;
const deniedTable = process.env.EXO_DYNAMODB_IAM_DENIED_TABLE;
const region = process.env.AWS_REGION;
const maybe = allowedTable && deniedTable && region ? test.serial : test.skip;

maybe(
  'broker denials need no AWS call and IAM denies an over-broad broker',
  async t => {
    const specifier = '@aws-sdk/client-dynamodb';
    const { DynamoDB } = await import(specifier);
    const sdk = new DynamoDB({ region });
    let sends = 0;
    const client = harden({
      getItem: input => {
        sends += 1;
        return sdk.getItem(input);
      },
    });
    const schema = harden({
      partitionKey: harden({ name: 'pk', type: 'string' }),
    });
    const control = makeDynamoControl({
      client,
      catalog: /** @type {any} */ (
        harden({
          allowed: harden({
            ...schema,
            tableName: /** @type {string} */ (allowedTable),
          }),
          denied: harden({
            ...schema,
            tableName: /** @type {string} */ (deniedTable),
          }),
        })
      ),
      audit: harden({ record() {}, hashKey: () => 'k' }),
      sealCursor: makeMemoryCursorSealer({ random: () => `${Math.random()}` }),
    });
    const allowed = await control.derive(
      harden({
        table: 'allowed',
        keySpace: harden([harden({ partition: harden({ prefix: 'test#' }) })]),
      }),
    );
    const denied = await control.derive(harden({ table: 'denied' }));
    if (allowed.type !== 'ok' || denied.type !== 'ok') throw Error('derive');
    t.like(await allowed.value.capability.get(harden({ pk: 'test#1' })), {
      type: 'ok',
    });
    t.is(sends, 1);
    // The broker refuses with no AWS call.
    t.like(await allowed.value.capability.get(harden({ pk: 'other#1' })), {
      type: 'invalid-request',
    });
    t.is(sends, 1);
    // The broker admits, and IAM refuses.
    t.deepEqual(await denied.value.capability.get(harden({ pk: 'test#1' })), {
      type: 'unavailable',
      retryable: false,
    });
    t.is(sends, 2);
  },
);
