// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makePromiseKit } from './_promise-kit.js';
import { directoryHost } from './_directory-host.js';
import {
  createPrivateTurnStorage,
  providePrivateTurnStorage,
  providePrivateNetworkStorage,
  retirePrivateTurnStorage,
} from '../src/private-turn-storage.js';

const rootName = 'floot-private-sessions';
const path = id => `${rootName}/${id}`;
const eventName = index => `floot-turn-event-${`${index}`.padStart(20, '0')}`;
const networkName = index =>
  `floot-network-7-session-${`${index}`.padStart(20, '0')}`;
const fixture = (hooks = {}) => {
  const values = new Map();
  const powers = Far('TestHost', directoryHost(values, hooks));
  return { values, powers };
};

test('concurrent creation shares one root; opening and growth never scan host inventory', async t => {
  t.timeout(10_000);
  const f = fixture();
  await Promise.all(
    ['session', 'session2'].map(id => createPrivateTurnStorage(f.powers, id)),
  );
  t.deepEqual(await E(f.powers).list(), [rootName]);
  const noHostList = Far('NoGlobalScan', {
    has: (...names) => E(f.powers).has(...names),
    lookup: (...names) => E(f.powers).lookup(...names),
    storeValue: (value, name) => E(f.powers).storeValue(value, name),
    list: (...names) => {
      if (names.length === 0) throw Error('must not scan global namespace');
      return E(f.powers).list(...names);
    },
    remove: (...names) => E(f.powers).remove(...names),
  });
  const first = await providePrivateTurnStorage(noHostList, 'session');
  const network = await providePrivateNetworkStorage(noHostList, 'session');
  const second = await providePrivateTurnStorage(noHostList, 'session2');
  await Promise.all(
    Array.from({ length: 12_000 }, (_, index) =>
      E(first).storeValue('event', eventName(index)),
    ),
  );
  await E(network).storeValue(harden({ policy: 'off' }), networkName(1));
  t.is((await E(first).list()).length, 12_000);
  t.deepEqual(await E(network).list(), [networkName(1)]);
  t.deepEqual(await E(second).list(), []);
  t.deepEqual(await E(f.powers).list(), [rootName]);
  await t.throwsAsync(createPrivateTurnStorage(f.powers, 'session'), {
    message: /namespace already exists/,
  });
  await Promise.all([E(first).close(), E(second).close(), E(network).close()]);
  await retirePrivateTurnStorage(noHostList, 'session');
  t.deepEqual(await E(await E(f.powers).lookup(rootName)).list(), ['session2']);
  await retirePrivateTurnStorage(f.powers, 'session2');
  t.deepEqual(await E(await E(f.powers).lookup(rootName)).list(), []);
  t.is(
    f.values.size,
    1,
    'all session records released; only the shared root remains',
  );
});

for (const after of [false, true]) {
  test(`terminal directory unlink retries across reconstruction, applied=${after}`, async t => {
    let fail = true;
    const removed = [];
    const reject = name => {
      if (fail && name === path('session')) {
        fail = false;
        throw Error('Unlink failed');
      }
    };
    const f = fixture({
      beforeRemove: name => {
        removed.push(name);
        if (!after) reject(name);
      },
      afterRemove: name => {
        if (after) reject(name);
      },
    });
    await createPrivateTurnStorage(f.powers, 'session');
    await createPrivateTurnStorage(f.powers, 'other');
    const storage = await providePrivateTurnStorage(f.powers, 'session');
    await E(storage).storeValue('record', eventName(1));
    await E(storage).close();
    await t.throwsAsync(retirePrivateTurnStorage(f.powers, 'session'), {
      message: /Unlink failed/,
    });
    t.is(f.values.has(`${path('session')}/schema`), !after);
    const revivedHost = Far('RevivedHost', directoryHost(f.values));
    await retirePrivateTurnStorage(revivedHost, 'session');
    await retirePrivateTurnStorage(revivedHost, 'session');
    t.false(f.values.has(path('session')));
    t.true(f.values.has(`${path('other')}/schema`));
    t.deepEqual(
      removed,
      [path('session')],
      'retirement unlinks once, not one record at a time',
    );
    await t.throwsAsync(E(storage).storeValue('late', eventName(2)), {
      message: /closed/,
    });
  });
}

test('missing, legacy, malformed, and foreign storage is never adopted or deleted', async t => {
  for (const scenario of ['missing', 'legacy', 'wrong-owner', 'unknown']) {
    const f = fixture();
    if (scenario === 'legacy')
      f.values.set(
        'floot-private-turn-7-session-schema',
        harden({ version: 1, sessionId: 'session' }),
      );
    if (['wrong-owner', 'unknown'].includes(scenario)) {
      // eslint-disable-next-line no-await-in-loop
      await createPrivateTurnStorage(f.powers, 'session');
      if (scenario === 'wrong-owner')
        f.values.set(
          `${path('session')}/schema`,
          harden({ version: 2, sessionId: 'other' }),
        );
      else f.values.set(`${path('session')}/unexpected`, 'preserve');
    }
    const before = [...f.values];
    if (scenario !== 'unknown') {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(providePrivateTurnStorage(f.powers, 'session'), {
        message: /schema.*reset required/,
      });
    }
    if (['wrong-owner', 'unknown'].includes(scenario)) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(retirePrivateTurnStorage(f.powers, 'session'), {
        message: /schema|value name/,
      });
    }
    t.deepEqual([...f.values], before);
  }
});

test('schema shape, version, and owner are exact', async t => {
  const f = fixture();
  await createPrivateTurnStorage(f.powers, 'session');
  const invalid = harden([
    null,
    undefined,
    true,
    'schema',
    [],
    {},
    { version: 2 },
    { sessionId: 'session' },
    { version: 1, sessionId: 'session' },
    { version: '2', sessionId: 'session' },
    { version: 2, sessionId: 'other' },
    { version: 2, sessionId: 'session', extra: true },
  ]);
  for (const schema of invalid) {
    f.values.set(`${path('session')}/schema`, schema);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(providePrivateTurnStorage(f.powers, 'session'), {
      message: /Invalid private journal schema/,
    });
  }
});

test('entrypoints validate IDs before using host authority', async t => {
  for (const id of ['', '../session', 'a/b', 'a b', 'x'.repeat(129), 5, null]) {
    for (const operation of [
      createPrivateTurnStorage,
      providePrivateTurnStorage,
      providePrivateNetworkStorage,
      retirePrivateTurnStorage,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(
        operation(Far('NoAuthority'), /** @type {any} */ (id)),
        { message: /Invalid journal session ID/ },
      );
    }
  }
});

for (const fails of [false, true]) {
  test(`close drains admitted writes and fences old facets: fails=${fails}`, async t => {
    t.timeout(5000);
    const entered = makePromiseKit();
    const release = makePromiseKit();
    t.teardown(() => release.resolve(undefined));
    const f = fixture({
      afterStore: async (_value, name) => {
        if (!name.endsWith(eventName(0))) return;
        entered.resolve(undefined);
        await release.promise;
        if (fails) throw Error('Write acknowledgement lost');
      },
    });
    await createPrivateTurnStorage(f.powers, 'session');
    const storage = await providePrivateTurnStorage(f.powers, 'session');
    const writing = E(storage).storeValue('retained', eventName(0));
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
    const restored = await providePrivateTurnStorage(f.powers, 'session');
    t.is(await E(restored).lookup(eventName(0)), 'retained');
  });
}

test('lost acknowledgement poisons queued operations; revival retains immutable committed record', async t => {
  t.timeout(5000);
  let fail = true;
  const f = fixture({
    afterStore: (_value, name) => {
      if (fail && name.endsWith(eventName(1)))
        throw Error('Lost acknowledgement');
    },
  });
  await createPrivateTurnStorage(f.powers, 'session');
  const storage = await providePrivateTurnStorage(f.powers, 'session');
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
  fail = false;
  const revived = await providePrivateTurnStorage(f.powers, 'session');
  t.deepEqual(await E(revived).list(), [eventName(1)]);
  t.is(await E(revived).lookup(eventName(1)), 'committed');
  await t.throwsAsync(E(revived).storeValue('overwrite', eventName(1)), {
    message: /immutable/,
  });
  await E(revived).storeValue('next', eventName(2));
});

test('all journal classes are isolated from schema, other sessions and network audit', async t => {
  const f = fixture();
  await createPrivateTurnStorage(f.powers, 'session');
  const storage = await providePrivateTurnStorage(f.powers, 'session');
  const network = await providePrivateNetworkStorage(f.powers, 'session');
  const valid = [
    eventName(1),
    'floot-turn-content-00000000000000000001-input',
    'floot-turn-snapshot-00000000000000000001',
    'floot-turn-archive-00000000000000000001',
  ];
  await Promise.all(valid.map(name => E(storage).storeValue(name, name)));
  t.deepEqual(await E(storage).list(), valid);
  for (const name of [
    'schema',
    '../secret',
    'floot-turn-event-1',
    networkName(1),
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
  await t.throwsAsync(E(network).storeValue('wrong', eventName(2)), {
    message: /value name/,
  });
  await t.throwsAsync(
    E(network).storeValue(
      'other owner',
      'floot-network-5-other-00000000000000000001',
    ),
    { message: /value name/ },
  );
});

test('snapshot removal failures can be retried without poisoning writes', async t => {
  let fail = true;
  const f = fixture({
    beforeRemove: () => {
      if (fail) throw Error('Removal failed');
    },
  });
  await createPrivateTurnStorage(f.powers, 'session');
  const storage = await providePrivateTurnStorage(f.powers, 'session');
  await E(storage).storeValue('covered', eventName(1));
  await t.throwsAsync(E(storage).remove(eventName(1)), {
    message: /Removal failed/,
  });
  await E(storage).storeValue('next', eventName(2));
  fail = false;
  await E(storage).remove(eventName(1));
  await t.throwsAsync(E(storage).remove(eventName(1)), {
    message: /Unknown private journal value/,
  });
});
