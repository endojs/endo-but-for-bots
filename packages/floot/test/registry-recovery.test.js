// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { make } from '../agent.js';

const backupName = 'floot-sessions-backup';
const journalName = 'floot-sessions-v1-00000000000000000000';
const entries = harden([{ id: 'saved', title: 'Saved', createdAt: 1 }]);

const makeHost = (
  store,
  {
    beforeStore = () => {},
    afterStore = () => {},
    beforeRemove = () => {},
  } = {},
) =>
  Far('RegistryHost', {
    list: () => harden([...store.keys()]),
    has: name => store.has(name),
    lookup: name => store.get(name),
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
    // Registry tests deliberately stop before acquiring session resources.
    provideGuest: () => {
      throw Error('Session provisioning disabled in registry test');
    },
  });

for (const canonical of [undefined, harden([])]) {
  test(`legacy backup wins over ${canonical ? 'stale' : 'missing'} canonical registry`, async t => {
    const store = new Map([[backupName, entries]]);
    if (canonical) store.set('floot-sessions', canonical);
    const host = makeHost(store, {
      beforeStore: () => t.true(store.has(backupName)),
      beforeRemove: () => t.deepEqual(store.get(journalName).sessions, entries),
    });
    t.is((await E(make(host)).listSessions())[0].id, 'saved');
    t.false(store.has(backupName));
    t.deepEqual(store.get(journalName).sessions, entries);
    t.is((await E(make(host)).listSessions())[0].id, 'saved');
  });
}

test('failed legacy migration retains its root and retries on load', async t => {
  let fail = true;
  const store = new Map([[backupName, entries]]);
  const host = makeHost(store, {
    beforeStore: () => {
      if (fail) throw Error('Storage unavailable');
    },
  });
  const factory = make(host);
  await t.throwsAsync(() => E(factory).listSessions(), {
    message: 'Storage unavailable',
  });
  t.true(store.has(backupName));
  t.false(store.has(journalName));
  fail = false;
  t.is((await E(factory).listSessions())[0].id, 'saved');
  t.false(store.has(backupName));
});

test('journal wins over leftover backup and failed cleanup retries after restart', async t => {
  let fail = true;
  const store = new Map([
    [backupName, entries],
    [journalName, harden({ version: 1, sequence: 0n, sessions: [] })],
  ]);
  const host = makeHost(store, {
    beforeRemove: () => {
      if (fail) throw Error('Cleanup unavailable');
    },
  });
  t.deepEqual(await E(make(host)).listSessions(), []);
  t.true(store.has(backupName));
  fail = false;
  t.deepEqual(await E(make(host)).listSessions(), []);
  t.false(store.has(backupName));
});

test('a lost journal acknowledgement does not wedge later saves', async t => {
  t.timeout(5000);
  let fail = true;
  const store = new Map([['floot-sessions', entries]]);
  const host = makeHost(store, {
    afterStore: () => {
      if (fail) throw Error('Acknowledgement lost');
    },
  });
  const factory = make(host);
  await t.throwsAsync(() => E(factory).renameSession('saved', 'Uncertain'), {
    message: 'Acknowledgement lost',
  });
  t.is(store.get(journalName).sessions[0].title, 'Uncertain');
  fail = false;
  await E(factory).renameSession('saved', 'Latest');
  t.is(store.get(journalName).sessions[0].title, 'Uncertain');
  t.is((await E(make(host)).listSessions())[0].title, 'Latest');
});

test('a lost migration acknowledgement recovers its journal on retry', async t => {
  t.timeout(5000);
  const store = new Map([[backupName, entries]]);
  const host = makeHost(store, {
    afterStore: () => {
      throw Error('Acknowledgement lost');
    },
  });
  const factory = make(host);
  await t.throwsAsync(() => E(factory).listSessions(), {
    message: 'Acknowledgement lost',
  });
  t.true(store.has(backupName));
  t.deepEqual(store.get(journalName).sessions, entries);
  t.is((await E(factory).listSessions())[0].id, 'saved');
  t.false(store.has(backupName));
});
