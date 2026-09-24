// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { make } from '../agent.js';

const canonicalName = 'floot-sessions';
const backupName = 'floot-sessions-backup';
const prefix = 'floot-sessions-v1-';
const journalName = sequence =>
  `${prefix}${String(sequence).padStart(20, '0')}`;
const entries = harden([
  {
    id: 'saved',
    title: 'Saved',
    createdAt: 1,
    executionState: 'stopped',
    backendId: 'provider',
    modelId: '',
    systemPrompt: 'Captured prompt.',
  },
]);
const snapshot = (sessions = entries, sequence = 0n) =>
  harden({ version: 1, sequence, sessions });

/**
 * @param {Map<string, any>} store
 * @param {object} [hooks]
 * @param {(name: string) => void} [hooks.beforeStore]
 * @param {(name: string) => void} [hooks.afterStore]
 * @param {(name: string) => void} [hooks.beforeRemove]
 * @param {(name: string) => void} [hooks.beforeLookup]
 */
const makeHost = (
  store,
  {
    beforeStore = () => {},
    afterStore = () => {},
    beforeRemove = () => {},
    beforeLookup = () => {},
  } = {},
) =>
  Far('RegistryHost', {
    list: () => harden([...store.keys()]),
    has: name => store.has(name),
    lookup: name => {
      beforeLookup(name);
      return store.get(name);
    },
    storeValue: (value, name) => {
      beforeStore(name);
      if (store.has(name)) throw Error('Name already exists');
      store.set(name, value);
      afterStore(name);
    },
    remove: name => {
      beforeRemove(name);
      store.delete(name);
    },
    // Registry tests stop before acquiring session resources.
    provideGuest: () => {
      throw Error('Session provisioning disabled in registry test');
    },
  });

test('fresh registry is empty without creating a snapshot', async t => {
  const store = new Map();
  t.deepEqual(await E(make(makeHost(store))).listSessions(), []);
  t.deepEqual([...store.keys()], []);
});

for (const systemPrompt of [undefined, '', '  ', 7]) {
  test(`registry refuses missing or invalid captured prompt before acquisition: ${JSON.stringify(systemPrompt)}`, async t => {
    const invalid = { ...entries[0], systemPrompt };
    const store = new Map([[journalName(0n), snapshot(harden([invalid]))]]);
    const before = [...store.entries()];
    const reads = [];
    const host = makeHost(store, {
      beforeLookup: name => reads.push(name),
      beforeStore: () => t.fail('Unexpected prompt reconstruction'),
      beforeRemove: () => t.fail('Unexpected retirement'),
    });
    await t.throwsAsync(E(make(host)).listSessions(), {
      message: /lacks a captured system prompt/,
    });
    t.deepEqual([...store.entries()], before);
    t.deepEqual(reads, [journalName(0n)]);
  });
}

test('restoration preserves captured admin, custom and delegated prompts without rewriting the registry', async t => {
  const saved = harden([
    {
      ...entries[0],
      presetId: 'machine-admin',
      systemPrompt: 'Original admin instructions.',
    },
    {
      ...entries[0],
      id: 'custom',
      presetId: 'machine-admin',
      systemPrompt: 'Operator custom instructions.',
    },
    {
      ...entries[0],
      id: 'child',
      presetId: 'machine-admin',
      parentSessionId: 'saved',
      systemPrompt: 'Parent-delegated instructions.',
    },
  ]);
  const store = new Map([[journalName(0n), snapshot(saved)]]);
  const before = [...store.entries()];
  const host = makeHost(store, {
    beforeStore: () => t.fail('Unexpected prompt migration'),
    beforeRemove: () => t.fail('Unexpected retirement'),
  });
  t.is((await E(make(host)).listSessions()).length, 3);
  t.deepEqual([...store.entries()], before);
});

for (const identity of [
  {},
  { model: 'claude-cli' },
  { model: 'vendor/model' },
  { backendId: 'provider' },
  { backendId: 'provider', modelId: '', model: 'vendor/model' },
  { backendId: 'test', modelId: '' },
  { backendId: ' ', modelId: 'm' },
  { backendId: 'provider', modelId: ' ' },
]) {
  test(`legacy or incomplete persisted identity is refused without resource acquisition: ${JSON.stringify(identity)}`, async t => {
    const invalid = {
      id: 'legacy',
      title: 'Legacy',
      createdAt: 1,
      ...identity,
    };
    const store = new Map([[journalName(0n), snapshot(harden([invalid]))]]);
    const before = [...store.entries()];
    const reads = [];
    const host = makeHost(store, {
      beforeLookup: name => reads.push(name),
      beforeStore: () => t.fail('Unexpected migration'),
      beforeRemove: () => t.fail('Unexpected retirement'),
    });
    await t.throwsAsync(E(make(host)).listSessions(), {
      message: /explicit backend\/model identity/,
    });
    t.deepEqual([...store.entries()], before);
    t.false(reads.some(name => name.startsWith('session-agent-')));
  });
}

test('explicit direct pin and configured default survive registry restoration without hosted semantics', async t => {
  const store = new Map([
    [
      journalName(0n),
      snapshot(
        harden([
          { ...entries[0], id: 'pinned', modelId: 'vendor/pin' },
          { ...entries[0], id: 'default', modelId: '' },
        ]),
      ),
    ],
    [
      'llm-provider',
      harden({ provider: 'openrouter', model: 'vendor/default' }),
    ],
  ]);
  const factory = make(makeHost(store));
  const sessions = await E(factory).listSessions();
  t.like(
    sessions.find(entry => entry.id === 'pinned'),
    {
      backendId: 'provider',
      modelId: 'vendor/pin',
      effectiveModelId: 'vendor/pin',
      model: 'vendor/pin',
    },
  );
  t.like(
    sessions.find(entry => entry.id === 'default'),
    {
      backendId: 'provider',
      modelId: '',
      effectiveModelId: 'vendor/default',
      model: '',
    },
  );
  const session = await E(factory).getSession('pinned');
  t.deepEqual(await E(session).getExecutionState(), {
    state: 'stopped',
    supported: false,
  });
  await t.throwsAsync(E(session).emergencyStop(), {
    message: /no hosted sandbox/,
  });
  await E(factory).renameSession('pinned', 'Preserved pin');
  t.like(
    store.get(journalName(1n)).sessions.find(entry => entry.id === 'pinned'),
    { backendId: 'provider', modelId: 'vendor/pin' },
  );
});

test('deletion recovery takes precedence over a persisted stopped state', async t => {
  t.timeout(5000);
  const store = new Map([
    [
      journalName(0n),
      snapshot(harden([{ ...entries[0], lifecycle: 'deleting' }])),
    ],
  ]);
  const factory = make(makeHost(store));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if ((await E(factory).listSessions()).length === 0) {
      t.pass();
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  t.fail('Stopped session deletion was not recovered');
});

for (const names of [
  [canonicalName],
  [backupName],
  [canonicalName, backupName],
]) {
  test(`legacy-only registry is rejected without reading or modifying roots: ${names.join(',')}`, async t => {
    const store = new Map(names.map(name => [name, entries]));
    const before = [...store.entries()];
    const host = makeHost(store, {
      beforeLookup: name => {
        if (names.includes(name)) t.fail('Legacy value was read');
      },
      beforeStore: () => t.fail('Legacy registry was migrated'),
      beforeRemove: () => t.fail('Legacy root was removed'),
    });
    await t.throwsAsync(E(make(host)).listSessions(), {
      message: /legacy.*unsupported|unsupported.*legacy/i,
    });
    t.deepEqual([...store.entries()], before);
  });
}

test('modern snapshot wins and leaves legacy roots untouched', async t => {
  const store = new Map([
    [canonicalName, entries],
    [backupName, entries],
    [journalName(0n), snapshot(harden([]))],
  ]);
  const before = [...store.entries()];
  const host = makeHost(store, {
    beforeLookup: name => {
      if ([canonicalName, backupName].includes(name))
        t.fail('Legacy root was read');
    },
    beforeRemove: () => t.fail('Legacy root was removed'),
  });
  t.deepEqual(await E(make(host)).listSessions(), []);
  t.deepEqual([...store.entries()], before);
});

for (const corrupt of [
  harden({ version: 2, sequence: 1n, sessions: [] }),
  harden({ version: 1, sequence: 0n, sessions: [] }),
  harden({ version: 1, sequence: 1, sessions: [] }),
  harden({ version: 1, sequence: 1n, sessions: {} }),
]) {
  test(`corrupt newest snapshot fails closed: ${String(corrupt.version)}/${typeof corrupt.sequence}/${Array.isArray(corrupt.sessions)}`, async t => {
    const store = new Map([
      [journalName(0n), snapshot()],
      [journalName(1n), corrupt],
    ]);
    await t.throwsAsync(E(make(makeHost(store))).listSessions(), {
      message: /registry journal is corrupt/,
    });
    t.is(store.size, 2);
  });
}

test('a failed write leaves the prior snapshot recoverable after restart', async t => {
  const store = new Map([[journalName(0n), snapshot()]]);
  const factory = make(
    makeHost(store, {
      beforeStore: () => {
        throw Error('Storage unavailable');
      },
    }),
  );
  await t.throwsAsync(E(factory).renameSession('saved', 'Not committed'), {
    message: 'Storage unavailable',
  });
  t.is(store.size, 1);
  t.is((await E(make(makeHost(store))).listSessions())[0].title, 'Saved');
});

test('a lost journal acknowledgement does not wedge later saves', async t => {
  t.timeout(5000);
  let fail = true;
  const store = new Map([[journalName(0n), snapshot()]]);
  const host = makeHost(store, {
    afterStore: () => {
      if (fail) throw Error('Acknowledgement lost');
    },
  });
  const factory = make(host);
  await t.throwsAsync(E(factory).renameSession('saved', 'Uncertain'), {
    message: 'Acknowledgement lost',
  });
  t.is(store.get(journalName(1n)).sessions[0].title, 'Uncertain');
  fail = false;
  await E(factory).renameSession('saved', 'Latest');
  t.is(store.get(journalName(1n)).sessions[0].title, 'Uncertain');
  t.is(store.get(journalName(2n)).sessions[0].title, 'Latest');
  t.is((await E(make(host)).listSessions())[0].title, 'Latest');
});

test('a lost acknowledgement reloads the committed newest snapshot', async t => {
  const store = new Map([[journalName(0n), snapshot()]]);
  const host = makeHost(store, {
    afterStore: () => {
      throw Error('Acknowledgement lost');
    },
  });
  await t.throwsAsync(E(make(host)).renameSession('saved', 'Committed'), {
    message: 'Acknowledgement lost',
  });
  t.is((await E(make(makeHost(store))).listSessions())[0].title, 'Committed');
});

test('load failure can be retried without falling back to an older snapshot', async t => {
  let unavailable = true;
  const store = new Map([[journalName(0n), snapshot()]]);
  const factory = make(
    makeHost(store, {
      beforeLookup: name => {
        if (unavailable && name === journalName(0n))
          throw Error('Snapshot unavailable');
      },
    }),
  );
  await t.throwsAsync(E(factory).listSessions(), {
    message: 'Snapshot unavailable',
  });
  unavailable = false;
  t.is((await E(factory).listSessions())[0].id, 'saved');
});

test('snapshot pruning occurs after a durable newer snapshot and retains four snapshots', async t => {
  const store = new Map([[journalName(0n), snapshot()]]);
  let latest = 0n;
  const durableAtRemoval = [];
  const host = makeHost(store, {
    afterStore: name => {
      latest = store.get(name).sequence;
    },
    beforeRemove: () => durableAtRemoval.push(store.has(journalName(latest))),
  });
  const factory = make(host);
  for (let index = 1; index <= 8; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(factory).renameSession('saved', `Version ${index}`);
  }
  t.true(durableAtRemoval.length > 0);
  t.true(durableAtRemoval.every(Boolean));
  t.deepEqual([...store.keys()].sort(), [5n, 6n, 7n, 8n].map(journalName));
  t.is((await E(make(host)).listSessions())[0].title, 'Version 8');
});

test('failed obsolete-snapshot pruning never rolls back a committed snapshot', async t => {
  const store = new Map(
    [0n, 1n, 2n, 3n, 4n].map(n => [journalName(n), snapshot(entries, n)]),
  );
  const factory = make(
    makeHost(store, {
      beforeRemove: () => {
        throw Error('Cleanup unavailable');
      },
    }),
  );
  await E(factory).renameSession('saved', 'Durable');
  t.true(store.has(journalName(5n)));
  t.true(store.has(journalName(0n)));
  t.is((await E(make(makeHost(store))).listSessions())[0].title, 'Durable');
});
