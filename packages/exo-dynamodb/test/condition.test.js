// @ts-check

import '@endo/init';

import test from 'ava';

import {
  assertCondition,
  assertGuard,
  evaluateCondition,
  makeExpressionBuilder,
} from '../src/condition.js';
import { marshalValue } from '../src/marshal.js';
import { RequestError } from '../src/results.js';
import { parseCondition } from './_fake-dynamodb.js';

/** @type {any[]} */
const conditions = harden([
  { field: 'a', eq: 1 },
  { field: 'a', ne: 1 },
  { field: 'a', lt: 2 },
  { field: 'a', lte: 1 },
  { field: 'a', gt: 0n },
  { field: 'a', gte: 1 },
  { field: 'a', between: [0, 3] },
  { field: 's', beginsWith: 'ab' },
  { exists: 'missing' },
  { not: { exists: 'missing' } },
  {
    and: [
      { field: 'a', eq: 1 },
      { or: [{ exists: 'x' }, { field: 's', eq: 'abc' }] },
    ],
  },
]);

test('compiled conditions agree with in-memory evaluation', t => {
  const item = harden({ a: 1, s: 'abc' });
  for (const [index, condition] of conditions.entries()) {
    assertCondition(condition);
    const builder = makeExpressionBuilder(value =>
      marshalValue(value, { binary: 'bytes' }),
    );
    const text = builder.condition(condition);
    const { ExpressionAttributeNames = {}, ExpressionAttributeValues = {} } =
      /** @type {any} */ (builder.maps());
    t.false(/\ba\b|\bs\b|abc/.test(text.replace(/#n\d+|:v\d+/g, '')), text);
    t.is(
      parseCondition(
        text,
        ExpressionAttributeNames,
        ExpressionAttributeValues,
      )(item),
      evaluateCondition(condition, item),
      `condition ${index}`,
    );
  }
});

test('malformed conditions are refused as caller errors', t => {
  for (const bad of [
    {},
    { and: [] },
    { field: 'a' },
    { field: 'a', eq: 1, ne: 2 },
    { field: 'a', lt: {} },
    { field: 'a', between: [3, 1] },
    { field: 'a', matches: '.*' },
    { exists: '' },
    { not: { exists: 'a' }, extra: true },
    'a = :v',
  ]) {
    t.throws(() => assertCondition(harden(bad)), { instanceOf: RequestError });
  }
  /** @type {any} */
  let deep = { exists: 'a' };
  for (let n = 0; n < 20; n += 1) deep = { not: deep };
  t.throws(() => assertCondition(harden(deep)), { message: /deep/ });
  t.throws(
    () =>
      assertCondition(harden({ exists: 'a' }), field => {
        if (field === 'a') throw new RequestError('no a');
      }),
    { message: 'no a' },
  );
});

test('the guard language is conjunctive', t => {
  assertGuard(
    harden({
      and: [
        { field: 'k', eq: 'x' },
        { field: 'p', beginsWith: 'q' },
        { not: { exists: 'z' } },
      ],
    }),
  );
  for (const bad of [
    { or: [{ exists: 'a' }] },
    { not: { and: [{ exists: 'a' }] } },
    { not: { not: { exists: 'a' } } },
    { field: 'a', gt: 1 },
    { field: 'a', eq: { nested: true } },
  ]) {
    t.throws(() => assertGuard(harden(bad)), { instanceOf: RequestError });
  }
});
