// @ts-check

import '@endo/init';

import test from 'ava';
import fc from 'fast-check';

import { attenuate } from '../src/restriction.js';

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
