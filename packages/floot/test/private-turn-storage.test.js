// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { providePrivateTurnStorage } from '../src/private-turn-storage.js';

const eventName = index => `floot-turn-event-${`${index}`.padStart(20, '0')}`;
const fixture = () => {
  const values = new Map();
  let failName;
  const powers = Far('TestPetstore', {
    list: () => harden([...values.keys()]),
    lookup: name => values.get(name),
    storeValue: (value, name) => {
      values.set(name, value);
      if (name === failName) throw Error('Lost acknowledgement');
    },
  });
  return {
    values,
    powers,
    fail: name => {
      failName = name;
    },
  };
};

test('private storage separates ordinary guest names, not a delegated administrator', async t => {
  const host = fixture();
  const guest = fixture();
  const { storage, migration } = await providePrivateTurnStorage(
    host.powers,
    'session',
    guest.powers,
  );
  await E(storage).storeValue('private', eventName(1));
  guest.values.set(eventName(1), 'forged');
  t.is(await E(storage).lookup(eventName(1)), 'private');
  t.deepEqual(await migration.status(), { required: false });
  t.deepEqual(await E(guest.powers).list(), [eventName(1)]);
  await t.throwsAsync(E(storage).lookup('migration-manifest'), {
    message: /event name/,
  });
  await t.throwsAsync(E(storage).storeValue('overwrite', eventName(1)), {
    message: /immutable/,
  });
  // The intentionally endowed full host remains an administrator, not isolated.
  const target = `floot-private-turn-7-session-${eventName(1)}`;
  await E(host.powers).storeValue('admin modification', target);
  t.is(await E(storage).lookup(eventName(1)), 'admin modification');
});

test('partial copy with lost acknowledgement preserves copied items on revival', async t => {
  const host = fixture();
  const guest = fixture();
  guest.values.set(eventName(1), 'original');
  guest.values.set(eventName(2), 'second');
  host.fail(`floot-private-turn-7-session-${eventName(1)}`);
  await t.throwsAsync(
    providePrivateTurnStorage(host.powers, 'session', guest.powers),
    { message: /Lost acknowledgement/ },
  );
  guest.values.set(eventName(1), 'changed');
  host.fail(undefined);
  const { storage, migration } = await providePrivateTurnStorage(
    host.powers,
    'session',
    guest.powers,
  );
  t.is(await E(storage).lookup(eventName(1)), 'original');
  t.is(await E(storage).lookup(eventName(2)), 'second');
  t.deepEqual(await migration.status(), { required: true });
  await migration.resolve('Checked imported evidence independently');
  guest.values.clear();
  guest.values.set(eventName(99), 'malformed new legacy history');
  const revived = await providePrivateTurnStorage(
    host.powers,
    'session',
    guest.powers,
  );
  t.deepEqual(await revived.migration.status(), {
    required: true,
    resolution: 'Checked imported evidence independently',
  });
  t.is(await E(revived.storage).lookup(eventName(1)), 'original');
});

test('resolution acknowledgement loss poisons the incarnation but survives revival', async t => {
  const host = fixture();
  const guest = fixture();
  guest.values.set(eventName(1), 'legacy');
  const { migration } = await providePrivateTurnStorage(
    host.powers,
    'session',
    guest.powers,
  );
  await t.throwsAsync(migration.resolve('  '), { message: /nonempty/ });
  host.fail('floot-private-turn-7-session-migration-resolution');
  await t.throwsAsync(migration.resolve('Reviewed'), {
    message: /Lost acknowledgement/,
  });
  await t.throwsAsync(migration.status(), { message: /uncertain storage/ });
  host.fail(undefined);
  const revived = await providePrivateTurnStorage(
    host.powers,
    'session',
    guest.powers,
  );
  t.deepEqual(await revived.migration.status(), {
    required: true,
    resolution: 'Reviewed',
  });
});

test('rejects malformed migration sequence before any private write', async t => {
  const host = fixture();
  const guest = fixture();
  guest.values.set(eventName(2), 'gap');
  await t.throwsAsync(
    providePrivateTurnStorage(host.powers, 'session', guest.powers),
    { message: /missing or malformed/ },
  );
  t.is(host.values.size, 0);
});

test('full legacy capacity leaves resolution outside the event budget', async t => {
  t.timeout(10_000);
  const host = fixture();
  const guest = fixture();
  for (let index = 1; index <= 10_000; index += 1) {
    guest.values.set(eventName(index), `event-${index}`);
  }
  const { storage, migration } = await providePrivateTurnStorage(
    host.powers,
    'session',
    guest.powers,
  );
  t.is((await E(storage).list()).length, 10_000);
  await migration.resolve('Imported evidence independently checked');
  t.truthy((await migration.status()).resolution);
  t.is((await E(storage).list()).length, 10_000);
});

test('prefix-sharing session IDs have disjoint storage', async t => {
  const host = fixture();
  const guest = fixture();
  const first = await providePrivateTurnStorage(
    host.powers,
    'a-b',
    guest.powers,
  );
  await E(first.storage).storeValue('first', eventName(1));
  const second = await providePrivateTurnStorage(
    host.powers,
    'a',
    guest.powers,
  );
  t.deepEqual(await E(second.storage).list(), []);
  await E(second.storage).storeValue('second', eventName(1));
  t.is(await E(first.storage).lookup(eventName(1)), 'first');
});

test('erased legacy history still requires durable acknowledgment', async t => {
  const host = fixture();
  const guest = fixture();
  const migrated = await providePrivateTurnStorage(
    host.powers,
    'existing',
    guest.powers,
    { legacyRequired: true },
  );
  t.deepEqual(await migrated.migration.status(), { required: true });
  t.deepEqual(await E(migrated.storage).list(), []);
  // A later caller cannot downgrade the factory-owned provenance anchor.
  const revived = await providePrivateTurnStorage(
    host.powers,
    'existing',
    guest.powers,
    { legacyRequired: false },
  );
  t.deepEqual(await revived.migration.status(), { required: true });
  await revived.migration.resolve(
    'Checked externally despite missing legacy evidence',
  );
  t.truthy((await revived.migration.status()).resolution);
  const fresh = await providePrivateTurnStorage(
    host.powers,
    'new',
    guest.powers,
    { legacyRequired: false },
  );
  t.deepEqual(await fresh.migration.status(), { required: false });
  // Once established privately, ordinary revival must not create a new fence.
  const freshRevived = await providePrivateTurnStorage(
    host.powers,
    'new',
    guest.powers,
    { legacyRequired: true },
  );
  t.deepEqual(await freshRevived.migration.status(), { required: false });
});
