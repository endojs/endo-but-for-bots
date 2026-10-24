// @ts-check

import '@endo/init';

import test from 'ava';

import { makeMemoryGrantStore, reincarnateDynamoControl } from '../index.js';
import { appRoot, expectOk, makeHarness } from './_harness.js';

const key = harden({ pk: 'tenant#a', sk: 'item#1' });

/** @returns {{ promise: Promise<never>, reject: (reason?: unknown) => void }} */
const makeCancel = () => {
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = /** @type {Promise<never>} */ (
    new Promise((_, rejectPromise) => {
      reject = rejectPromise;
    })
  );
  promise.catch(() => {});
  return { promise, reject };
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('cancellation revokes a grant, its descendants, and forwarded copies', async t => {
  const { calls, control } = makeHarness();
  const root = expectOk(t, await control.derive(appRoot));
  const cancel = makeCancel();
  const child = expectOk(
    t,
    await root.capability.derive(
      harden({}),
      harden({ cancelled: cancel.promise }),
    ),
  );
  const grandchild = expectOk(t, await child.capability.derive(harden({})));
  const forwarded = harden({ held: child.capability }).held;
  expectOk(t, await grandchild.capability.get(key));
  const sent = calls.length;
  cancel.reject(Error('session over'));
  await settle();
  t.deepEqual(await child.capability.get(key), { type: 'revoked' });
  t.deepEqual(await forwarded.get(key), { type: 'revoked' });
  t.deepEqual(await grandchild.capability.get(key), { type: 'revoked' });
  t.deepEqual(await grandchild.capability.derive(harden({})), {
    type: 'revoked',
  });
  t.is(calls.length, sent, 'no revoked request reached the client');
  expectOk(t, await root.capability.get(key));
  const lineage = expectOk(t, await control.lineage(grandchild.grantId));
  t.deepEqual(
    lineage.map(entry => entry.live),
    [true, false, true],
    'the grandchild gate is open but its parent is closed',
  );
});

test('control withdrawal closes a subtree', async t => {
  const { calls, control } = makeHarness();
  const root = expectOk(t, await control.derive(appRoot));
  const child = expectOk(t, await root.capability.derive(harden({})));
  t.deepEqual(await control.withdraw(root.grantId), {
    type: 'ok',
    value: undefined,
  });
  t.deepEqual(await child.capability.get(key), { type: 'revoked' });
  t.deepEqual(await root.capability.put(harden({ ...key })), {
    type: 'revoked',
  });
  t.deepEqual(await control.withdraw(root.grantId), {
    type: 'ok',
    value: undefined,
  });
  t.like(await control.withdraw('nope'), { type: 'invalid-request' });
  t.like(await control.lineage('nope'), { type: 'invalid-request' });
  t.is(calls.length, 0);
});

test('a revocation that lands just before dispatch is seen with no send', async t => {
  const { calls, control } = makeHarness();
  const root = expectOk(t, await control.derive(appRoot));
  const child = expectOk(t, await root.capability.derive(harden({})));
  // The withdrawal closes the gate in the same turn, before dispatch.
  const withdrawal = control.withdraw(child.grantId);
  t.deepEqual(await child.capability.get(key), { type: 'revoked' });
  expectOk(t, await withdrawal);
  t.is(calls.length, 0);
});

test('revocation is prospective for an in-flight request', async t => {
  const { fake, events, control } = makeHarness();
  const root = expectOk(t, await control.derive(appRoot));
  const child = expectOk(t, await root.capability.derive(harden({})));
  fake.onSend(() => {
    void control.withdraw(child.grantId);
  });
  const result = await child.capability.put(harden({ ...key, visible: 'yes' }));
  t.deepEqual(
    result,
    { type: 'ok', value: undefined },
    'the sent write commits',
  );
  t.truthy(fake.peek('app-physical', key));
  t.true(
    events.some(
      event => event.operation === 'put' && event.completedAfterRevocation,
    ),
  );
  fake.onSend(undefined);
  t.deepEqual(await child.capability.get(key), { type: 'revoked' });
});

test('restart rebinds live named grants and never tombstoned ones', async t => {
  const grantStore = makeMemoryGrantStore();
  const first = makeHarness({ grantStore, generation: 'generation-1' });
  const ledger = expectOk(
    t,
    await first.control.derive(appRoot, harden({ name: 'coupon-ledger' })),
  );
  const cancel = makeCancel();
  const session = expectOk(
    t,
    await first.control.derive(
      harden({ ...appRoot, limits: harden({ pageSize: 5 }) }),
      harden({ name: 'session', cancelled: cancel.promise }),
    ),
  );
  const withdrawn = expectOk(
    t,
    await first.control.derive(appRoot, harden({ name: 'withdrawn' })),
  );
  t.like(
    await first.control.derive(appRoot, harden({ name: 'coupon-ledger' })),
    {
      type: 'invalid-request',
      reason: 'grant coupon-ledger is already bound',
    },
  );
  cancel.reject();
  await settle();
  t.deepEqual(await session.capability.get(key), { type: 'revoked' });
  expectOk(t, await first.control.withdraw(withdrawn.grantId));
  t.deepEqual(grantStore.snapshot().tombstones, ['withdrawn']);
  t.like(await first.control.derive(appRoot, harden({ name: 'withdrawn' })), {
    type: 'invalid-request',
    reason: 'grant withdrawn was withdrawn',
  });

  first.fake.seed('app-physical', { ...key, kind: 'coupon' });
  first.fake.seed('app-physical', {
    pk: 'tenant#a',
    sk: 'item#2',
    kind: 'coupon',
  });
  const page = expectOk(
    t,
    await ledger.capability.query(harden({ partition: 'tenant#a', limit: 1 })),
  );
  t.truthy(page.cursor);
  const oldDigest = expectOk(t, await first.control.lineage(ledger.grantId))[0]
    .restrictionDigest;

  const second = makeHarness({ fake: first.fake, generation: 'generation-2' });
  const { control, named } = await reincarnateDynamoControl({
    ...second.powers,
    grantStore,
    previous: first.control,
  });
  t.deepEqual(Object.keys(named).sort(), ['coupon-ledger', 'session']);
  const rebound = expectOk(t, named['coupon-ledger']);
  expectOk(t, named.session);
  const [record] = expectOk(t, await control.lineage(rebound.grantId));
  t.is(record.generation, 'generation-2');
  t.is(record.restrictionDigest, oldDigest, 'same effective restriction');

  // old-generation facets fail closed, including derive
  t.deepEqual(await ledger.capability.get(key), { type: 'revoked' });
  t.deepEqual(await ledger.capability.derive(harden({})), { type: 'revoked' });
  t.deepEqual(await first.control.derive(appRoot), { type: 'revoked' });
  // old cursors are refused by the new generation
  t.like(
    await rebound.capability.query(
      harden({ partition: 'tenant#a', limit: 1, cursor: page.cursor }),
    ),
    { type: 'invalid-request' },
  );
  t.like(await control.derive(appRoot, harden({ name: 'withdrawn' })), {
    type: 'invalid-request',
  });

  // an idempotent domain retry converges on DynamoDB state
  const create = () =>
    rebound.capability.put(
      harden({ pk: 'tenant#a', sk: 'item#7', visible: 'once' }),
      {
        condition: harden({ not: harden({ exists: 'pk' }) }),
      },
    );
  expectOk(t, await create());
  t.deepEqual(await create(), { type: 'condition-failed' });
  t.is(
    first.fake.peek('app-physical', { pk: 'tenant#a', sk: 'item#7' }).visible,
    'once',
  );
});

test('a failed tombstone still closes the gate and reports unavailable', async t => {
  const grantStore = harden({
    ...makeMemoryGrantStore(),
    putTombstone() {
      throw Error('disk full');
    },
  });
  const { control } = makeHarness({ grantStore });
  const grant = expectOk(
    t,
    await control.derive(appRoot, harden({ name: 'n' })),
  );
  t.deepEqual(await control.withdraw(grant.grantId), {
    type: 'unavailable',
    retryable: true,
  });
  t.deepEqual(await grant.capability.get(key), { type: 'revoked' });
});

test('audit events correlate use without item values', async t => {
  const { fake, events, control } = makeHarness();
  const root = expectOk(t, await control.derive(appRoot));
  const cancel = makeCancel();
  const child = expectOk(
    t,
    await root.capability.derive(
      harden({}),
      harden({ cancelled: cancel.promise }),
    ),
  );
  await root.capability.derive(harden({ operations: harden(['scan']) }));
  await child.capability.put(harden({ ...key, secret: 'TOP-SECRET-VALUE' }));
  await child.capability.put(harden({ ...key }), {
    condition: harden({ not: harden({ exists: 'pk' }) }),
  });
  await child.capability.get(harden({ pk: 'other#a', sk: 'item#1' }));
  await child.capability.transactWrite(
    harden([
      harden({
        operation: 'conditionCheck',
        key,
        condition: harden({ field: 'visible', eq: 'never' }),
      }),
    ]),
  );
  fake.onSend(() => cancel.reject());
  await child.capability.get(key);
  await settle();
  fake.onSend(undefined);
  await child.capability.get(key);

  const outcomes = events.map(event => `${event.operation}:${event.outcome}`);
  for (const expected of [
    'derive:ok',
    'derive:invalid-request',
    'put:ok',
    'put:condition-failed',
    'get:invalid-request',
    'transactWrite:transaction-canceled',
    'revoke:revoked',
    'get:revoked',
  ]) {
    t.true(outcomes.includes(expected), expected);
  }
  t.true(events.some(event => event.completedAfterRevocation === true));
  for (const event of events) {
    t.is(event.generation, 'generation-1');
    t.is(event.logicalTable, 'app');
    t.is(typeof event.restrictionDigest, 'string');
  }
  const childEvents = events.filter(event => event.grantId === child.grantId);
  t.true(childEvents.every(event => event.parentId === root.grantId));
  const serialized = JSON.stringify(events);
  for (const forbidden of [
    'TOP-SECRET-VALUE',
    'tenant#a',
    'item#1',
    'app-physical',
    'never',
  ]) {
    t.false(serialized.includes(forbidden), forbidden);
  }
  t.true(events.some(event => event.keyHash === 'hash:2'));
});
