// @ts-check

import '@endo/init';

import test from 'ava';

import { appRoot, expectOk, makeHarness } from './_harness.js';

/**
 * Run guest source in a fresh compartment whose only endowments are the
 * capabilities placed in its powers. The compartment has no module map, no
 * environment, and no network.
 */
test('a confined guest cannot escape its derived capability', async t => {
  const { fake, calls, control } = makeHarness();
  fake.seed('app-physical', {
    pk: 'tenant#a',
    sk: 'item#1',
    visible: 'yes',
    secret: 'hidden',
    kind: 'coupon',
  });
  fake.seed('app-physical', { pk: 'tenant#a', sk: 'item#2', kind: 'coupon' });
  fake.seed('app-physical', { pk: 'tenant#a', sk: 'item#3', kind: 'coupon' });
  const root = expectOk(t, await control.derive(appRoot));
  const restriction = harden({
    keySpace: harden([
      harden({
        partition: harden({ exact: 'tenant#a' }),
        sort: harden({ prefix: 'item#' }),
      }),
    ]),
    shape: harden({ readFields: harden(['pk', 'sk', 'visible']) }),
    operations: harden(['get', 'query', 'put']),
  });
  const guestGrant = expectOk(t, await root.capability.derive(restriction));
  const sibling = expectOk(t, await root.capability.derive(restriction));
  const siblingPage = expectOk(
    t,
    await sibling.capability.query(harden({ partition: 'tenant#a', limit: 1 })),
  );

  const compartment = new Compartment({
    __options__: true,
    globals: harden({
      powers: harden({
        db: guestGrant.capability,
        siblingCursor: siblingPage.cursor,
      }),
    }),
  });
  const attempts = await compartment.evaluate(`(async () => {
    const { db, siblingCursor } = powers;
    const report = {};
    const attempt = async (name, thunk) => {
      try {
        report[name] = await thunk();
      } catch (error) {
        report[name] = { threw: String(error && error.name) };
      }
    };
    await attempt('environment', () => typeof process === 'undefined' ? 'absent' : 'present');
    await attempt('fetch', () => typeof fetch === 'undefined' ? 'absent' : 'present');
    await attempt('ownKeys', () => Reflect.ownKeys(db).map(String));
    await attempt('client', () => db.client === undefined && db.send === undefined && db.control === undefined ? 'absent' : 'present');
    await attempt('parent', () => db.parent === undefined && db.withdraw === undefined && db.lineage === undefined ? 'absent' : 'present');
    await attempt('mutate', () => { db.get = () => 'forged'; return 'mutated'; });
    await attempt('rawCommand', () => db.put({ pk: 'tenant#a', sk: 'item#9' }, { TableName: 'app-physical', ConditionExpression: 'attribute_exists(secret)' }));
    await attempt('scan', () => typeof db.scan);
    await attempt('siblingCursor', () => db.query({ partition: 'tenant#a', limit: 1, cursor: siblingCursor }));
    await attempt('hiddenField', () => db.get({ pk: 'tenant#a', sk: 'item#1' }, { fields: ['secret'] }));
    await attempt('widen', () => db.derive({ shape: { readFields: ['secret'] } }));
    await attempt('allowed', () => db.get({ pk: 'tenant#a', sk: 'item#1' }));
    return report;
  })()`);

  t.is(attempts.environment, 'absent');
  t.is(attempts.fetch, 'absent');
  // The guest has no module map, and SES refuses dynamic import syntax.
  await t.throwsAsync(() => compartment.import('@aws-sdk/client-dynamodb'));
  t.throws(() => compartment.evaluate(`import('@aws-sdk/client-dynamodb')`));
  t.false(
    attempts.ownKeys.some(name =>
      /client|send|control|withdraw|table/i.test(name),
    ),
  );
  t.is(attempts.client, 'absent');
  t.is(attempts.parent, 'absent');
  t.truthy(attempts.mutate.threw);
  t.like(attempts.rawCommand, { type: 'invalid-request' });
  t.is(attempts.scan, 'undefined');
  t.like(attempts.siblingCursor, {
    type: 'invalid-request',
    reason: 'cursor belongs to another grant',
  });
  t.like(attempts.hiddenField, { type: 'invalid-request' });
  t.like(attempts.widen, { type: 'invalid-request' });
  t.deepEqual(attempts.allowed, {
    type: 'ok',
    value: { pk: 'tenant#a', sk: 'item#1', visible: 'yes' },
  });
  t.false(JSON.stringify(attempts).includes('"hidden"'));
  t.is(calls.filter(call => call.operation !== 'query').length, 1);
});
