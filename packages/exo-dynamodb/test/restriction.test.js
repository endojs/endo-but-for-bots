// @ts-check

import '@endo/init';

import test from 'ava';
import fc from 'fast-check';

import { constraintContains, keySpaceContains } from '../src/keys.js';
import { narrow, narrowRoot } from '../src/restriction.js';
import { RequestError } from '../src/results.js';
import { appRoot, catalog, expectOk, makeHarness } from './_harness.js';

const table = catalog.app;
const allFields = ['pk', 'sk', 'a', 'b', 'c', 'd'];

/**
 * Arbitrary narrowing of a parent effective restriction: every part is
 * either omitted or a subset of the parent's.
 *
 * @param {import('../src/restriction.js').Effective} parent
 */
const childOf = parent => {
  /** @param {readonly string[] | undefined} list */
  const subset = list =>
    fc.option(fc.subarray([...(list ?? allFields)]), { nil: undefined });
  const prefixes = (
    parent.keySpace ?? [{ partition: { prefix: 'tenant#' } }]
  ).map(range => /** @type {any} */ (range.partition));
  return fc.record(
    {
      keySpace: fc.option(
        prefixes.length === 0
          ? /** @type {fc.Arbitrary<any>} */ (fc.constant([]))
          : fc
              .array(
                fc
                  .tuple(
                    fc.constantFrom(...prefixes),
                    fc.stringMatching(/^[a-z#]{0,3}$/),
                    fc.boolean(),
                  )
                  .map(([constraint, suffix, exact]) => {
                    const base =
                      'exact' in constraint
                        ? constraint.exact
                        : constraint.prefix;
                    const value =
                      'exact' in constraint ? base : `${base}${suffix}`;
                    return harden({
                      partition: harden(
                        exact || 'exact' in constraint
                          ? { exact: value }
                          : { prefix: value },
                      ),
                    });
                  }),
                { maxLength: 3 },
              )
              .map(ranges => harden(ranges)),
        { nil: undefined },
      ),
      shape: fc.record(
        {
          readFields: subset(parent.shape.readFields),
          writeFields: subset(parent.shape.writeFields),
          conditionFields: subset(parent.shape.conditionFields),
          filterFields: subset(parent.shape.filterFields),
        },
        { requiredKeys: [] },
      ),
      indexes: fc.option(
        fc
          .subarray(Object.keys(parent.indexes))
          .map(names =>
            Object.fromEntries(
              names.map(name => [
                name,
                parent.indexes[name] ?? [
                  harden({ partition: harden({ exact: 'coupon' }) }),
                ],
              ]),
            ),
          ),
        { nil: undefined },
      ),
      operations: fc.option(fc.subarray([...parent.operations]), {
        nil: undefined,
      }),
      limits: fc.record(
        {
          pageSize: fc.integer({ min: 1, max: parent.limits.pageSize }),
          transactionSize: fc.integer({
            min: 1,
            max: parent.limits.transactionSize,
          }),
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: [] },
  );
};

/**
 * @param {readonly string[] | undefined} parent
 * @param {readonly string[] | undefined} child
 */
const listShrinks = (parent, child) =>
  parent === undefined ||
  (child !== undefined && child.every(x => parent.includes(x)));

const root = narrowRoot(
  catalog,
  harden({
    table: 'app',
    keySpace: harden([harden({ partition: harden({ prefix: 'tenant#' }) })]),
    shape: harden({
      readFields: harden(allFields),
      writeFields: harden(allFields),
      conditionFields: harden(allFields),
      filterFields: harden(allFields),
    }),
    limits: harden({ pageSize: 50, transactionSize: 10 }),
  }),
).effective;

test('property: three-level chains only decrease authority', t => {
  fc.assert(
    fc.property(
      childOf(root).chain(first => {
        const one = narrow(root, harden(first), table);
        return childOf(one).chain(second => {
          const two = narrow(one, harden(second), table);
          return childOf(two).map(third => [
            one,
            two,
            narrow(two, harden(third), table),
          ]);
        });
      }),
      chain => {
        let parent = root;
        for (const child of chain) {
          t.is(child.table, parent.table);
          t.true(keySpaceContains(parent.keySpace, child.keySpace ?? []));
          if (parent.keySpace !== undefined) t.not(child.keySpace, undefined);
          for (const list of [
            'readFields',
            'writeFields',
            'conditionFields',
            'filterFields',
          ]) {
            t.true(listShrinks(parent.shape[list], child.shape[list]), list);
          }
          t.true(child.operations.every(op => parent.operations.includes(op)));
          t.true(
            Object.keys(child.indexes).every(name => name in parent.indexes),
          );
          t.true(child.limits.pageSize <= parent.limits.pageSize);
          t.true(child.limits.transactionSize <= parent.limits.transactionSize);
          parent = child;
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('property: a widening child is refused, never clamped', t => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant({ shape: { readFields: ['secret-field'] } }),
        fc.constant({ operations: ['scan'] }),
        fc
          .integer({ min: 51, max: 10_000 })
          .map(pageSize => ({ limits: { pageSize } })),
        fc
          .stringMatching(/^[a-z]{1,4}#$/)
          .filter(p => p !== 'tenant#')
          .map(prefix => ({
            keySpace: [{ partition: { prefix } }],
          })),
        fc.constant({ indexes: { unknownIndex: [] } }),
        fc.constant({ table: 'events' }),
      ),
      widening => {
        t.throws(() => narrow(root, harden(widening), table), {
          instanceOf: RequestError,
        });
      },
    ),
    { numRuns: 100 },
  );
});

test('key constraints narrow by appending, exact values, or tighter intervals', t => {
  t.true(constraintContains({ prefix: 'COUPON#' }, { exact: 'COUPON#7' }));
  t.true(constraintContains({ prefix: 'COUPON#' }, { prefix: 'COUPON#7' }));
  t.false(constraintContains({ exact: 'COUPON#7' }, { exact: 'COUPON#70' }));
  t.false(constraintContains({ exact: 'COUPON#7' }, { prefix: 'COUPON#7' }));
  t.false(constraintContains({ prefix: 'COUPON#7' }, { prefix: 'COUPON#' }));
  t.true(constraintContains({ min: 0, max: 10 }, { min: 2, max: 3n }));
  t.true(constraintContains({ min: 0, max: 10 }, { exact: 10 }));
  t.false(constraintContains({ min: 0, max: 10 }, { min: 0 }));
  t.false(constraintContains({ max: 10 }, { exact: 11 }));
  t.true(
    constraintContains(
      { prefix: new Uint8Array([1]) },
      { exact: new Uint8Array([1, 2]) },
    ),
  );
});

test('derivation refusals resolve as invalid-request', async t => {
  const { control, calls } = makeHarness();
  const { capability } = expectOk(t, await control.derive(appRoot));
  /** @type {[any, RegExp][]} */
  const cases = [
    [{ shape: { readFields: ['unknown'] } }, /readFields names unknown/],
    [{ shape: { fixed: { kind: 'other' } } }, /fixed field kind conflicts/],
    [{ shape: { fixed: { nope: 1 } } }, /fixed field nope is not writable/],
    [
      { shape: { guard: { field: 'mystery', eq: 1 } } },
      /unknown field mystery/,
    ],
    [{ shape: { guard: { or: [{ exists: 'pk' }] } } }, /disjunction/],
    [
      { shape: { guard: { not: { and: [{ exists: 'pk' }] } } } },
      /negate a compound/,
    ],
    [{ shape: { guard: { field: 'count', gt: 1 } } }, /equality, beginsWith/],
    [{ operations: ['scan'] }, /operations names scan/],
    [{ limits: { pageSize: 11 } }, /pageSize exceeds/],
    [{ limits: { pageSize: 0 } }, /positive/],
    [{ table: 'events' }, /unexpected field table/],
    [
      { keySpace: [{ partition: { prefix: 'other#' } }] },
      /keySpace is outside/,
    ],
    [
      { keySpace: [{ partition: { prefix: 'tenant#' } }] },
      /keySpace is outside/,
    ],
    [
      { indexes: { byKind: [{ partition: { exact: 'other' } }] } },
      /byKind ranges/,
    ],
    [{ indexes: { missing: [] } }, /missing is outside/],
    [{ keySpace: [{ partition: { min: 1 } }] }, /interval/],
  ];
  for (const [restriction, pattern] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const result = await capability.derive(harden(restriction));
    t.is(result.type, 'invalid-request', JSON.stringify(restriction));
    t.regex(
      /** @type {any} */ (result).reason,
      /** @type {RegExp} */ (pattern),
    );
  }
  t.like(await capability.derive(harden({}), harden({ name: 'x' })), {
    type: 'invalid-request',
  });
  t.like(await capability.derive(harden({}), harden({ cancelled: 'soon' })), {
    type: 'invalid-request',
  });
  t.like(await control.derive(harden({ table: 'nope' })), {
    type: 'invalid-request',
  });
  t.like(
    await control.derive(harden({ table: 'app' }), harden({ name: 'n' })),
    {
      type: 'invalid-request',
      reason: 'named grants require a grant store',
    },
  );
  t.deepEqual(calls, []);
});

test('a fixed value that fails an ancestor guard on that field is refused', async t => {
  const { control } = makeHarness();
  const { capability } = expectOk(
    t,
    await control.derive(
      harden({
        table: 'app',
        shape: harden({
          guard: harden({ field: 'kind', beginsWith: 'coupon' }),
        }),
      }),
    ),
  );
  t.like(
    await capability.derive(
      harden({ shape: harden({ fixed: harden({ kind: 'book' }) }) }),
    ),
    {
      type: 'invalid-request',
      reason: 'fixed field kind fails a guard',
    },
  );
  expectOk(
    t,
    await capability.derive(
      harden({ shape: harden({ fixed: harden({ kind: 'coupon#7' }) }) }),
    ),
  );
});

test('omitted parts inherit and empty parts remove', async t => {
  const { control } = makeHarness();
  const parent = expectOk(t, await control.derive(appRoot));
  const reader = expectOk(
    t,
    await parent.capability.derive(
      harden({ operations: harden(['get', 'query']) }),
    ),
  );
  const [, readerRecord] = expectOk(t, await control.lineage(reader.grantId));
  const rootDigest = expectOk(t, await control.lineage(parent.grantId))[0]
    .restrictionDigest;
  t.not(readerRecord.restrictionDigest, rootDigest);
  // the reader keeps its parent's key space, fields, and indexes
  t.like(
    await reader.capability.query(
      harden({ index: 'byKind', partition: 'coupon' }),
    ),
    {
      type: 'ok',
    },
  );
  t.like(
    await reader.capability.put(harden({ pk: 'tenant#a', sk: 'item#1' })),
    {
      type: 'invalid-request',
      reason: 'operation put is not allowed',
    },
  );
  const noIndexes = expectOk(
    t,
    await parent.capability.derive(harden({ indexes: harden({}) })),
  );
  t.like(
    await noIndexes.capability.query(
      harden({ index: 'byKind', partition: 'coupon' }),
    ),
    { type: 'invalid-request', reason: 'index byKind is outside the grant' },
  );
  const noOps = expectOk(
    t,
    await parent.capability.derive(harden({ operations: harden([]) })),
  );
  t.like(await noOps.capability.get(harden({ pk: 'tenant#a', sk: 'item#1' })), {
    type: 'invalid-request',
  });
});
