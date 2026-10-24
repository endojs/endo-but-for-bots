// @ts-check

import '@endo/init';

import test from 'ava';

import { expectOk, makeHarness } from './_harness.js';

const C = 'coupons-physical';

/** The guest-coupon grant from section 8 of the design. */
const couponRoot = harden({
  table: 'coupons',
  keySpace: harden([
    harden({ partition: harden({ prefix: 'COUPON#' }) }),
    harden({ partition: harden({ prefix: 'BOOK#' }) }),
  ]),
  indexes: harden({
    queue: harden(
      [
        'COUPON#issued',
        'COUPON#redeeming',
        'COUPON#redeemed',
        'COUPON#retired#redeemed',
        'BOOK',
      ].map(exact =>
        harden({ partition: harden({ exact }), sort: harden({ min: 0 }) }),
      ),
    ),
  }),
  shape: harden({
    readFields: harden(['pk', 'status', 'queue', 'due', 'couponId']),
    writeFields: harden(['pk', 'status', 'queue', 'due', 'couponId']),
    filterFields: harden(['couponId']),
    conditionFields: harden(['status', 'due']),
  }),
});

test('index rows outside the base key space are dropped without a count', async t => {
  const { fake, control } = makeHarness();
  const { capability } = expectOk(t, await control.derive(couponRoot));
  fake.seed(C, {
    pk: 'COUPON#1',
    queue: 'COUPON#issued',
    due: 5,
    status: 'issued',
  });
  // mis-tagged rows from families the grant may not see
  fake.seed(C, {
    pk: 'POOL',
    queue: 'COUPON#issued',
    due: 6,
    secret: 'capacity',
  });
  fake.seed(C, { pk: 'ID#9', queue: 'COUPON#issued', due: 7, secret: 'id' });
  fake.seed(C, {
    pk: 'COUPON#2',
    queue: 'COUPON#issued',
    due: 8,
    status: 'issued',
  });
  const page = expectOk(
    t,
    await capability.query(
      harden({
        index: 'queue',
        partition: 'COUPON#issued',
        sort: harden({ field: 'due', lte: 100 }),
      }),
    ),
  );
  t.deepEqual(
    page.items.map(item => item.pk),
    ['COUPON#1', 'COUPON#2'],
  );
  t.deepEqual(Object.keys(page), ['items'], 'no dropped-row count');
  // a page consisting only of dropped rows is empty, with its continuation
  const narrowPage = expectOk(
    t,
    await capability.query(
      harden({
        index: 'queue',
        partition: 'COUPON#issued',
        limit: 2,
        cursor: undefined,
        sort: harden({ field: 'due', between: harden([6, 7]) }),
      }),
    ),
  );
  t.deepEqual(narrowPage.items, []);
});

test('index queries refuse consistent reads on a GSI but not an LSI', async t => {
  const { calls, control } = makeHarness();
  const { capability: coupons } = expectOk(t, await control.derive(couponRoot));
  t.deepEqual(
    await coupons.query(
      harden({ index: 'queue', partition: 'BOOK', consistent: true }),
    ),
    {
      type: 'invalid-request',
      reason: 'consistent reads are unavailable on a global index',
    },
  );
  t.is(calls.length, 0);
  const { capability: app } = expectOk(
    t,
    await control.derive(harden({ table: 'app' })),
  );
  expectOk(
    t,
    await app.query(
      harden({ index: 'byVisible', partition: 'tenant#a', consistent: true }),
    ),
  );
  t.true(calls.at(-1).input.ConsistentRead);
});

test('index partitions must be in an allowed range of that index', async t => {
  const { calls, control } = makeHarness();
  const { capability } = expectOk(t, await control.derive(couponRoot));
  t.like(
    await capability.query(
      harden({ index: 'queue', partition: 'COUPON#expired' }),
    ),
    {
      type: 'invalid-request',
      reason: 'query partition is outside the grant',
    },
  );
  t.like(
    await capability.query(
      harden({
        index: 'queue',
        partition: 'BOOK',
        sort: harden({ field: 'due', lt: 0 }),
      }),
    ),
    {
      type: 'invalid-request',
      reason: 'sort condition is outside the grant',
    },
  );
  t.deepEqual(calls, []);
});

test('numeric sort conditions intersect with the grant interval', async t => {
  const { fake, calls, control } = makeHarness();
  const { capability: root } = expectOk(
    t,
    await control.derive(
      harden({
        table: 'events',
        keySpace: harden([
          harden({
            partition: harden({ exact: 'stream-a' }),
            sort: harden({ min: 10, max: 100 }),
          }),
        ]),
      }),
    ),
  );
  const { capability: child } = expectOk(
    t,
    await root.derive(
      harden({
        keySpace: harden([
          harden({
            partition: harden({ exact: 'stream-a' }),
            sort: harden({ min: 20, max: 30n }),
          }),
        ]),
      }),
    ),
  );
  t.like(
    await child.derive(
      harden({
        keySpace: harden([
          harden({
            partition: harden({ exact: 'stream-a' }),
            sort: harden({ min: 19 }),
          }),
        ]),
      }),
    ),
    { type: 'invalid-request' },
  );
  for (let seq = 0; seq < 40; seq += 1) {
    fake.seed('events-physical', { stream: 'stream-a', seq });
  }
  const page = expectOk(
    t,
    await child.query(
      harden({ partition: 'stream-a', sort: harden({ field: 'seq', gt: 25 }) }),
    ),
  );
  t.deepEqual(
    page.items.map(item => item.seq),
    [26, 27, 28, 29, 30],
  );
  const { input } = calls.at(-1);
  t.regex(input.KeyConditionExpression, /BETWEEN/);
  const all = expectOk(t, await child.query(harden({ partition: 'stream-a' })));
  t.is(all.items.length, 11);
  t.like(
    await child.query(
      harden({
        partition: 'stream-a',
        sort: harden({ field: 'seq', gte: 31 }),
      }),
    ),
    {
      type: 'invalid-request',
      reason: 'sort condition is outside the grant',
    },
  );
  t.like(await child.get(harden({ stream: 'stream-a', seq: 31 })), {
    type: 'invalid-request',
  });
  expectOk(t, await child.get(harden({ stream: 'stream-a', seq: 30n })));
  t.like(
    await control.derive(
      harden({
        table: 'events',
        keySpace: harden([
          harden({
            partition: harden({ prefix: 's' }),
            sort: harden({ prefix: 'x' }),
          }),
        ]),
      }),
    ),
    {
      type: 'invalid-request',
      reason: 'sort prefix requires a string or binary key',
    },
  );
});

test('string sort conditions intersect with the grant prefix', async t => {
  const { fake, calls, control } = makeHarness();
  const { capability } = expectOk(
    t,
    await control.derive(
      harden({
        table: 'app',
        keySpace: harden([
          harden({
            partition: harden({ exact: 'tenant#a' }),
            sort: harden({ prefix: 'item#' }),
          }),
          harden({
            partition: harden({ exact: 'tenant#a' }),
            sort: harden({ prefix: 'zeta#' }),
          }),
        ]),
      }),
    ),
  );
  for (const sk of ['item#1', 'item#2', 'item#3', 'other#1', 'zeta#1']) {
    fake.seed('app-physical', { pk: 'tenant#a', sk });
  }
  // a condition overlapping one range is narrowed to the overlap
  const page = expectOk(
    t,
    await capability.query(
      harden({
        partition: 'tenant#a',
        sort: harden({ field: 'sk', between: harden(['item#2', 'item#9']) }),
      }),
    ),
  );
  t.deepEqual(
    page.items.map(item => item.sk),
    ['item#2', 'item#3'],
  );
  t.regex(calls.at(-1).input.KeyConditionExpression, /begins_with/);
  // one that overlaps two ranges must choose
  t.like(await capability.query(harden({ partition: 'tenant#a' })), {
    type: 'invalid-request',
    reason: 'query must select one allowed sort range',
  });
  t.like(
    await capability.query(
      harden({
        partition: 'tenant#a',
        sort: harden({ field: 'sk', beginsWith: 'other' }),
      }),
    ),
    {
      type: 'invalid-request',
      reason: 'sort condition is outside the grant',
    },
  );
  const narrowed = expectOk(
    t,
    await capability.query(
      harden({
        partition: 'tenant#a',
        sort: harden({ field: 'sk', beginsWith: 'z' }),
      }),
    ),
  );
  t.deepEqual(
    narrowed.items.map(item => item.sk),
    ['zeta#1'],
  );
  t.like(
    await capability.query(
      harden({ partition: 'tenant#a', sort: harden({ field: 'pk', eq: 'x' }) }),
    ),
    {
      type: 'invalid-request',
      reason: 'sort condition must name the sort key',
    },
  );
});

test('guards bound reads and writes at every level', async t => {
  const { fake, calls, control } = makeHarness();
  const { capability: root } = expectOk(
    t,
    await control.derive(
      harden({
        table: 'app',
        shape: harden({ guard: harden({ field: 'kind', eq: 'coupon' }) }),
      }),
    ),
  );
  // An accidentally permissive child guard is still bounded by its parent.
  const { capability: child } = expectOk(
    t,
    await root.derive(
      harden({
        shape: harden({ guard: harden({ not: harden({ exists: 'locked' }) }) }),
      }),
    ),
  );
  fake.seed('app-physical', { pk: 'p', sk: '1', kind: 'coupon' });
  fake.seed('app-physical', { pk: 'p', sk: '2', kind: 'book' });
  fake.seed('app-physical', { pk: 'p', sk: '3', kind: 'coupon', locked: true });
  t.deepEqual(
    expectOk(t, await child.get(harden({ pk: 'p', sk: '2' }))),
    undefined,
  );
  t.deepEqual(
    expectOk(t, await child.get(harden({ pk: 'p', sk: '3' }))),
    undefined,
  );
  const page = expectOk(t, await child.query(harden({ partition: 'p' })));
  t.deepEqual(
    page.items.map(item => item.sk),
    ['1'],
  );
  // put evaluates guards against the complete item
  t.like(await child.put(harden({ pk: 'p', sk: '4', kind: 'book' })), {
    type: 'invalid-request',
    reason: 'write fails the guard on kind',
  });
  t.like(
    await child.put(harden({ pk: 'p', sk: '4', kind: 'coupon', locked: 1 })),
    {
      type: 'invalid-request',
    },
  );
  const sends = calls.length;
  expectOk(t, await child.put(harden({ pk: 'p', sk: '4', kind: 'coupon' })));
  t.is(calls.length, sends + 1);
  // update proves touched fields statically and untouched ones server-side
  t.like(
    await child.update(
      harden({ pk: 'p', sk: '1' }),
      harden({ set: harden({ kind: 'book' }) }),
    ),
    {
      type: 'invalid-request',
    },
  );
  t.deepEqual(
    await child.update(
      harden({ pk: 'p', sk: '2' }),
      harden({ set: harden({ note: 'x' }) }),
    ),
    { type: 'condition-failed' },
    'an untouched guard field is a condition on the stored item',
  );
  t.like(
    await child.update(
      harden({ pk: 'p', sk: '1' }),
      harden({ add: harden({ kind: 1 }) }),
    ),
    {
      type: 'invalid-request',
      reason: 'update cannot prove the guard on kind',
    },
  );
  expectOk(
    t,
    await child.update(
      harden({ pk: 'p', sk: '1' }),
      harden({ set: harden({ note: 'y' }) }),
    ),
  );
  t.is(fake.peek('app-physical', { pk: 'p', sk: '1' }).note, 'y');
  // delete conditions on every guard
  t.deepEqual(await child.delete(harden({ pk: 'p', sk: '3' })), {
    type: 'condition-failed',
  });
  t.truthy(fake.peek('app-physical', { pk: 'p', sk: '3' }));
});

test('fixed attributes are injected into updates', async t => {
  const { fake, control } = makeHarness();
  const { capability } = expectOk(
    t,
    await control.derive(
      harden({
        table: 'app',
        shape: harden({
          writeFields: harden(['kind', 'v']),
          fixed: harden({ kind: 'coupon' }),
        }),
      }),
    ),
  );
  expectOk(
    t,
    await capability.update(
      harden({ pk: 'p', sk: 'new' }),
      harden({ set: harden({ v: 1 }) }),
    ),
  );
  t.deepEqual(fake.peek('app-physical', { pk: 'p', sk: 'new' }), {
    pk: 'p',
    sk: 'new',
    v: 1,
    kind: 'coupon',
  });
  t.like(
    await capability.update(
      harden({ pk: 'p', sk: 'new' }),
      harden({ remove: harden(['kind']) }),
    ),
    {
      type: 'invalid-request',
      reason: 'fixed field kind cannot be changed',
    },
  );
  t.like(
    await capability.update(
      harden({ pk: 'p', sk: 'new' }),
      harden({ set: harden({ pk: 'q' }) }),
    ),
    {
      type: 'invalid-request',
    },
  );
});
