// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makePromiseKit } from './_promise-kit.js';

import {
  createPrivateTurnStorage,
  providePrivateTurnStorage,
} from '../src/private-turn-storage.js';

const eventName = index => `floot-turn-event-${`${index}`.padStart(20, '0')}`;
const prefix = 'floot-private-turn-7-session-';
const schemaName = `${prefix}schema`;

for (const fails of [false, true]) {
  test(`private storage close drains admitted writes and fences old facet: fails=${fails}`, async t => {
    const values = new Map([
      [schemaName, harden({ version: 1, sessionId: 'session' })],
    ]);
    const entered = makePromiseKit();
    const release = makePromiseKit();
    const host = Far('DelayedPrivateStorage', {
      list: () => harden([...values.keys()]),
      lookup: name => values.get(name),
      storeValue: async (value, name) => {
        entered.resolve(undefined);
        await release.promise;
        values.set(name, value);
        if (fails) throw Error('Write acknowledgement lost');
      },
      remove: name => {
        values.delete(name);
      },
    });
    const storage = await providePrivateTurnStorage(host, 'session');
    const writing = E(storage).storeValue(
      harden({ value: 'retained' }),
      eventName(0),
    );
    void writing.catch(() => {});
    await entered.promise;
    let settled = false;
    const closing = E(storage)
      .close()
      .finally(() => {
        settled = true;
      });
    void closing.catch(() => {});
    await t.throwsAsync(E(storage).list(), { message: /closed/ });
    t.false(settled);
    release.resolve(undefined);
    if (fails) {
      await t.throwsAsync(writing, { message: /acknowledgement/ });
      await t.throwsAsync(closing, { message: /uncertain storage/ });
    } else {
      await writing;
      await closing;
    }
    await t.throwsAsync(E(storage).storeValue('late', eventName(1)), {
      message: /closed/,
    });
    const restored = await providePrivateTurnStorage(host, 'session');
    t.deepEqual(await E(restored).lookup(eventName(0)), { value: 'retained' });
  });
}
const fixture = () => {
  const values = new Map();
  const calls = [];
  let failName;
  let failRemove = false;
  const powers = Far('TestPetstore', {
    list: () => {
      calls.push(['list']);
      return harden([...values.keys()]);
    },
    lookup: name => {
      calls.push(['lookup', name]);
      return values.get(name);
    },
    storeValue: (value, name) => {
      calls.push(['storeValue', name]);
      values.set(name, value);
      if (name === failName) throw Error('Lost acknowledgement');
    },
    remove: name => {
      calls.push(['remove', name]);
      if (failRemove) throw Error('Removal failed');
      values.delete(name);
    },
  });
  return {
    values,
    powers,
    calls,
    fail: name => {
      failName = name;
    },
    failRemoval: value => {
      failRemove = value;
    },
  };
};

test('creation publishes exact schema and opening is read-only', async t => {
  const host = fixture();
  await createPrivateTurnStorage(host.powers, 'session');
  t.deepEqual(host.values.get(schemaName), {
    version: 1,
    sessionId: 'session',
  });
  t.deepEqual([...host.values.keys()], [schemaName]);
  host.calls.length = 0;
  const storage = await providePrivateTurnStorage(host.powers, 'session');
  t.deepEqual(await E(storage).list(), []);
  t.deepEqual(host.calls, [['list'], ['lookup', schemaName]]);
  await t.throwsAsync(createPrivateTurnStorage(host.powers, 'session'), {
    message: /namespace already exists/,
  });
  t.false(host.calls.some(([method]) => method === 'storeValue'));
});

test('missing schema and orphaned values are never adopted', async t => {
  const host = fixture();
  await t.throwsAsync(providePrivateTurnStorage(host.powers, 'session'), {
    message: /schema missing.*reset required/,
  });
  host.values.set(`${prefix}${eventName(1)}`, 'orphan');
  await t.throwsAsync(providePrivateTurnStorage(host.powers, 'session'), {
    message: /schema missing/,
  });
  await t.throwsAsync(createPrivateTurnStorage(host.powers, 'session'), {
    message: /namespace already exists/,
  });
  t.deepEqual([...host.values.values()], ['orphan']);
  t.false(host.calls.some(([method]) => method !== 'list'));
});

for (const marker of ['manifest', 'ready', 'resolution']) {
  test(`old migration-${marker} is refused even beside valid schema`, async t => {
    const host = fixture();
    host.values.set(`${prefix}migration-${marker}`, true);
    await t.throwsAsync(providePrivateTurnStorage(host.powers, 'session'), {
      message: /Legacy private journal requires session reset/,
    });
    host.values.set(schemaName, harden({ version: 1, sessionId: 'session' }));
    await t.throwsAsync(providePrivateTurnStorage(host.powers, 'session'), {
      message: /Legacy private journal requires session reset/,
    });
    await t.throwsAsync(createPrivateTurnStorage(host.powers, 'session'), {
      message: /namespace already exists/,
    });
    t.false(host.calls.some(([method]) => method !== 'list'));
  });
}

test('schema shape, version, and session identity are exact', async t => {
  const invalid = harden([
    null,
    undefined,
    true,
    'schema',
    [],
    {},
    { version: 1 },
    { sessionId: 'session' },
    { version: 2, sessionId: 'session' },
    { version: '1', sessionId: 'session' },
    { version: 1, sessionId: 'other' },
    { version: 1, sessionId: 'session', extra: true },
  ]);
  for (const schema of invalid) {
    const host = fixture();
    host.values.set(schemaName, schema);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(providePrivateTurnStorage(host.powers, 'session'), {
      message: /Invalid private journal schema/,
    });
    t.deepEqual(host.calls, [['list'], ['lookup', schemaName]]);
  }
});

test('both entrypoints validate IDs before accessing host authority', async t => {
  const host = fixture();
  for (const id of ['', '../session', 'a/b', 'a b', 'x'.repeat(129), 5, null]) {
    // Deliberately exercise the untyped boundary, including regex coercion.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      createPrivateTurnStorage(host.powers, /** @type {any} */ (id)),
      {
        message: /Invalid journal session ID/,
      },
    );
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      providePrivateTurnStorage(host.powers, /** @type {any} */ (id)),
      {
        message: /Invalid journal session ID/,
      },
    );
  }
  t.deepEqual(host.calls, []);
});

test('lost schema acknowledgement leaves immutable orphan for read-only revival', async t => {
  const host = fixture();
  host.fail(schemaName);
  await t.throwsAsync(createPrivateTurnStorage(host.powers, 'session'), {
    message: /Lost acknowledgement/,
  });
  host.fail(undefined);
  await t.throwsAsync(createPrivateTurnStorage(host.powers, 'session'), {
    message: /namespace already exists/,
  });
  const storage = await providePrivateTurnStorage(host.powers, 'session');
  t.deepEqual(await E(storage).list(), []);
  t.is(host.calls.filter(([method]) => method === 'storeValue').length, 1);
});

test('ordinary guest copies cannot alter private history, unlike full host authority', async t => {
  const host = fixture();
  const guest = fixture();
  guest.values.set(eventName(1), 'old untrusted history');
  await createPrivateTurnStorage(host.powers, 'session');
  const storage = await providePrivateTurnStorage(host.powers, 'session');
  t.deepEqual(await E(storage).list(), []);
  await E(storage).storeValue('private', eventName(1));
  guest.values.set(eventName(1), 'forged');
  t.is(await E(storage).lookup(eventName(1)), 'private');
  guest.values.clear();
  const revived = await providePrivateTurnStorage(host.powers, 'session');
  t.is(await E(revived).lookup(eventName(1)), 'private');
  t.deepEqual(guest.calls, []);
  // The intentionally endowed full host remains an administrator, not isolated.
  await E(host.powers).storeValue(
    'admin modification',
    `${prefix}${eventName(1)}`,
  );
  t.is(await E(storage).lookup(eventName(1)), 'admin modification');
});

test('all journal value classes work, schema and arbitrary host names do not', async t => {
  const host = fixture();
  await createPrivateTurnStorage(host.powers, 'session');
  const storage = await providePrivateTurnStorage(host.powers, 'session');
  const valid = [
    eventName(1),
    'floot-turn-content-00000000000000000001-input',
    'floot-turn-snapshot-00000000000000000001',
    'floot-turn-archive-00000000000000000001',
  ];
  await Promise.all(valid.map(name => E(storage).storeValue(name, name)));
  t.deepEqual(await E(storage).list(), valid);
  t.deepEqual(
    await Promise.all(valid.map(name => E(storage).lookup(name))),
    valid,
  );
  for (const name of [
    'schema',
    schemaName,
    'migration-ready',
    '../secret',
    'floot-turn-event-1',
    5,
    null,
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(storage).lookup(name), { message: /value name/ });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(storage).storeValue('bad', name), {
      message: /value name/,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(storage).remove(name), { message: /value name/ });
  }
  t.deepEqual(await E(storage).list(), valid);
  t.is(host.values.size, 5);
});

test('serialized writes preserve immutability without poisoning on rejection', async t => {
  const host = fixture();
  await createPrivateTurnStorage(host.powers, 'session');
  const storage = await providePrivateTurnStorage(host.powers, 'session');
  const first = E(storage).storeValue('first', eventName(1));
  const second = E(storage).storeValue('overwrite', eventName(1));
  await first;
  await t.throwsAsync(second, { message: /immutable/ });
  t.is(await E(storage).lookup(eventName(1)), 'first');
  await E(storage).storeValue('next', eventName(2));
});

test('lost event acknowledgement poisons every queued operation; revival sees committed value', async t => {
  t.timeout(10_000);
  const host = fixture();
  await createPrivateTurnStorage(host.powers, 'session');
  const storage = await providePrivateTurnStorage(host.powers, 'session');
  host.fail(`${prefix}${eventName(1)}`);
  const failed = E(storage).storeValue('committed', eventName(1));
  const checks = [
    E(storage).list(),
    E(storage).lookup(eventName(1)),
    E(storage).storeValue('not stored', eventName(2)),
    E(storage).remove(eventName(1)),
  ].map(operation =>
    t.throwsAsync(operation, { message: /uncertain storage/ }),
  );
  await t.throwsAsync(failed, { message: /Lost acknowledgement/ });
  await Promise.all(checks);
  host.fail(undefined);
  const revived = await providePrivateTurnStorage(host.powers, 'session');
  t.deepEqual(await E(revived).list(), [eventName(1)]);
  t.is(await E(revived).lookup(eventName(1)), 'committed');
  await t.throwsAsync(E(revived).storeValue('overwrite', eventName(1)), {
    message: /immutable/,
  });
  await E(revived).storeValue('next', eventName(2));
});

test('snapshot-covered removal failure does not poison and can be retried', async t => {
  const host = fixture();
  await createPrivateTurnStorage(host.powers, 'session');
  const storage = await providePrivateTurnStorage(host.powers, 'session');
  await E(storage).storeValue('covered event', eventName(1));
  await E(storage).storeValue(
    'snapshot',
    'floot-turn-snapshot-00000000000000000001',
  );
  host.failRemoval(true);
  await t.throwsAsync(E(storage).remove(eventName(1)), {
    message: /Removal failed/,
  });
  t.is(await E(storage).lookup(eventName(1)), 'covered event');
  await E(storage).storeValue('next', eventName(2));
  host.failRemoval(false);
  await E(storage).remove(eventName(1));
  t.false((await E(storage).list()).includes(eventName(1)));
  await t.throwsAsync(E(storage).remove(eventName(1)), {
    message: /Unknown private journal value/,
  });
});

test('prefix-sharing session IDs have disjoint storage', async t => {
  const host = fixture();
  await createPrivateTurnStorage(host.powers, 'a-b');
  const first = await providePrivateTurnStorage(host.powers, 'a-b');
  await E(first).storeValue('first', eventName(1));
  await createPrivateTurnStorage(host.powers, 'a');
  const second = await providePrivateTurnStorage(host.powers, 'a');
  t.deepEqual(await E(second).list(), []);
  await E(second).storeValue('second', eventName(1));
  t.is(await E(first).lookup(eventName(1)), 'first');
  t.is(await E(second).lookup(eventName(1)), 'second');
});
