// @ts-check

import '@endo/init';

import test from 'ava';
import fc from 'fast-check';

import {
  applyFixed,
  attenuate,
  keyAllowed,
  sameValue,
} from '../src/restriction.js';

const operations = harden([
  'get',
  'put',
  'update',
  'delete',
  'query',
  'conditionCheck',
  'transactGet',
  'transactWrite',
]);
const fields = harden(['pk', 'sk', 'visible', 'secret', 'status']);

test('three-level restriction chains monotonically reduce sets and limits', t => {
  const setArbitrary = values =>
    fc.uniqueArray(fc.constantFrom(...values), {
      minLength: 0,
      maxLength: values.length,
    });
  const restrictionArbitrary = fc.record({
    operations: setArbitrary(operations),
    readFields: setArbitrary(fields),
    writeFields: setArbitrary(fields),
    indexes: setArbitrary(['byKind', 'byStatus']),
    pageSize: fc.integer({ min: 1, max: 1000 }),
    transactionSize: fc.integer({ min: 1, max: 100 }),
    itemSize: fc.integer({ min: 128, max: 500_000 }),
    ratePerSecond: fc.integer({ min: 1, max: 10_000 }),
  });
  fc.assert(
    fc.property(
      restrictionArbitrary,
      restrictionArbitrary,
      restrictionArbitrary,
      (first, second, third) => {
        const asRestriction = value =>
          harden({
            operations: value.operations,
            readFields: value.readFields,
            writeFields: value.writeFields,
            indexes: value.indexes,
            limits: harden({
              pageSize: value.pageSize,
              transactionSize: value.transactionSize,
              itemSize: value.itemSize,
              ratePerSecond: value.ratePerSecond,
            }),
          });
        const root = attenuate(
          undefined,
          harden({ table: 'app', ...asRestriction(first) }),
        );
        const child = attenuate(root, asRestriction(second));
        const grandchild = attenuate(child, asRestriction(third));
        for (const property of [
          'operations',
          'readFields',
          'writeFields',
          'indexes',
        ]) {
          t.true(
            grandchild[property].every(value =>
              child[property].includes(value),
            ),
          );
          t.true(
            child[property].every(value => root[property].includes(value)),
          );
        }
        for (const property of [
          'pageSize',
          'transactionSize',
          'itemSize',
          'ratePerSecond',
        ]) {
          const rootLimits = /** @type {any} */ (root.limits);
          const childLimits = /** @type {any} */ (child.limits);
          const grandchildLimits = /** @type {any} */ (grandchild.limits);
          const rootValue = Number(rootLimits[property]);
          const childValue = Number(childLimits[property]);
          const grandchildValue = Number(grandchildLimits[property]);
          t.true(grandchildValue <= childValue);
          t.true(childValue <= rootValue);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('children cannot reselect tables or contradict fixed fields', t => {
  const parent = attenuate(
    undefined,
    harden({ table: 'app', fixed: harden({ kind: 'coupon' }) }),
  );
  t.throws(() => attenuate(parent, harden({ table: 'other' })), {
    message: 'A child restriction cannot select a table',
  });
  t.throws(
    () => attenuate(parent, harden({ fixed: harden({ kind: 'other' }) })),
    { message: 'Fixed field "kind" conflicts with its parent' },
  );
  t.deepEqual(
    attenuate(parent, harden({ fixed: harden({ kind: 'coupon' }) })).fixed,
    { kind: 'coupon' },
  );
  t.throws(() => applyFixed(harden({ kind: 'other' }), parent), {
    message: 'Field "kind" conflicts with a fixed value',
  });
});

test('binary and numeric keys compare by value, not identity', t => {
  const table = harden({
    partitionKey: harden({ name: 'pk', type: 'binary' }),
    sortKey: harden({ name: 'sk', type: 'number' }),
  });
  const ranges = harden([
    harden({
      partition: harden({ prefix: new Uint8Array([1, 2]) }),
      sort: harden({ exact: 7 }),
    }),
  ]);
  t.true(keyAllowed({ pk: new Uint8Array([1, 2, 3]), sk: 7 }, table, ranges));
  t.false(keyAllowed({ pk: new Uint8Array([1]), sk: 7 }, table, ranges));
  t.false(keyAllowed({ pk: new Uint8Array([1, 3]), sk: 7 }, table, ranges));
  t.false(keyAllowed({ pk: new Uint8Array([1, 2]), sk: 8 }, table, ranges));
  t.true(sameValue(new Uint8Array([4]), new Uint8Array([4])));
  t.false(sameValue(new Uint8Array([4]), new Uint8Array([4, 5])));
  t.true(sameValue(harden({ a: 1n }), harden({ a: 1n })));
});
