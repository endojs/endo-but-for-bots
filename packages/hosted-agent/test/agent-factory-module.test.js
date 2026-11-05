// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeOwnerInventoryParticipant,
  parseReconcileIntervalMs,
} from '@endo/hosted-agent/agent-factory-module.js';

test('the reconcile interval accepts only a usable timer delay', t => {
  t.is(parseReconcileIntervalMs(undefined), 60_000);
  t.is(parseReconcileIntervalMs('1'), 1);
  t.is(parseReconcileIntervalMs('3600000'), 3_600_000);
  t.is(parseReconcileIntervalMs('2147483647'), 2_147_483_647);
  for (const setting of [
    '',
    '0',
    '-1',
    '1.5',
    '1e3',
    '0x10',
    ' 5',
    'Infinity',
    'NaN',
    '2147483648',
    '99999999999999999999999',
  ]) {
    t.throws(
      () => parseReconcileIntervalMs(setting),
      { message: /AGENT_FACTORY_RECONCILE_MS/ },
      setting,
    );
  }
});

/**
 * A root host holding one owner guest whose store compares atomically, as the
 * daemon's does. `rebind` models the owner changing its names between calls.
 *
 * @param {Record<string, string>} [names]
 */
const makeOwnerWorld = (names = {}) => {
  const owner = harden({
    compareAndStoreIdentifier: async (name, expectedId, nextId) => {
      if (names[name] !== expectedId) return false;
      if (nextId === undefined) delete names[name];
      else names[name] = nextId;
      return true;
    },
    identify: async name => names[name],
  });
  const powers = harden({
    has: async petName => petName === 'owner-agent',
    lookup: async () => owner,
  });
  return { names, inventory: makeOwnerInventoryParticipant(powers) };
};

test('naming an agent never overwrites a name the owner holds', async t => {
  const { names, inventory } = makeOwnerWorld({ helper: 'owner-note' });
  await t.throwsAsync(inventory.write('owner', 'helper', 'handle-1'), {
    message: /agent-name-conflict/,
  });
  t.is(names.helper, 'owner-note');
});

test('naming an agent stores once and accepts its own earlier write', async t => {
  const { names, inventory } = makeOwnerWorld();
  await inventory.write('owner', 'helper', 'handle-1');
  await inventory.write('owner', 'helper', 'handle-1');
  t.is(names.helper, 'handle-1');
});

test('removing an agent leaves a replacement the owner bound', async t => {
  const { names, inventory } = makeOwnerWorld({ helper: 'owner-note' });
  await inventory.remove('owner', 'helper', 'handle-1');
  t.is(names.helper, 'owner-note');
  await inventory.remove('owner', 'absent', 'handle-1');
  t.false('absent' in names);
});

test('removing an agent removes its own name', async t => {
  const { names, inventory } = makeOwnerWorld({ helper: 'handle-1' });
  await inventory.remove('owner', 'helper', 'handle-1');
  t.false('helper' in names);
});
