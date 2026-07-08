// @ts-check

/**
 * Proves the DynamoDB-backed `DaemonDatabase` engine
 * (`src/daemon-database-aws.js`) against the in-memory client-power
 * emulation in `aws-emulator.js`: an engine-agnostic specification (run
 * for parity against the SQLite engine when `better-sqlite3`'s native
 * binding is loadable), a reboot round-trip that proves the write-behind
 * queue flushed everything, and the flush-failure escalation path.
 * Design: `designs/endo-daemon-aws-storage.md` § Test plan.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { makeDaemonDatabaseAws } from '../src/daemon-database-aws.js';
import { makeTableEmulator } from './aws-emulator.js';

const sqliteDatabaseConstructor = await import('better-sqlite3')
  .then(namespace => {
    // Probe construction: the JS wrapper imports even where the native
    // binding is absent or unbuilt, and only construction reveals it.
    const Database = namespace.default;
    const probe = new Database(':memory:');
    probe.close();
    return Database;
  })
  .catch(() => undefined);

/** @param {string} digit */
const num = digit => digit.repeat(64);

/** @param {string} digit */
const id = digit => `${digit.repeat(64)}:${'0'.repeat(64)}`;

/**
 * @template {{ name: string }} T
 * @param {Array<T>} entries
 */
const byName = entries =>
  [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));

/**
 * The engine-agnostic specification: every operation of the
 * `DaemonDatabase` surface, exercised identically against any engine.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {import('../src/daemon-database.js').DaemonDatabase} db
 */
const exerciseDatabase = (t, db) => {
  // -- Formulas --
  const formulaA = { type: 'eval', worker: id('1'), source: '1 + 1' };
  const formulaB = { type: 'worker' };
  db.writeFormula(num('a'), num('e'), /** @type {any} */ (formulaA));
  db.writeFormula(num('b'), num('f'), /** @type {any} */ (formulaB));
  t.true(db.hasFormula(num('a')));
  t.false(db.hasFormula(num('c')));
  t.deepEqual(db.readFormula(num('a')), { node: num('e'), formula: formulaA });
  t.throws(() => db.readFormula(num('c')), {
    instanceOf: ReferenceError,
    message: /No formula exists/,
  });
  t.deepEqual(
    [...db.listFormulas()].sort((x, y) => (x.number < y.number ? -1 : 1)),
    [
      { number: num('a'), node: num('e') },
      { number: num('b'), node: num('f') },
    ],
  );
  t.deepEqual(db.listFormulaNumbersByNode(num('f')), [num('b')]);
  db.deleteFormula(num('b'));
  t.false(db.hasFormula(num('b')));

  // -- Daemon state --
  t.is(db.getState('root_nonce'), undefined);
  db.setState('root_nonce', num('9'));
  t.is(db.getState('root_nonce'), num('9'));

  // -- Agent keys --
  t.is(db.getAgentKey('pub1'), undefined);
  db.writeAgentKey('pub1', 'priv1', id('2'));
  db.writeAgentKey('pub2', 'priv2', id('3'));
  t.true(db.hasAgentKey('pub1'));
  t.deepEqual(db.getAgentKey('pub1'), {
    publicKey: 'pub1',
    privateKey: 'priv1',
    agentId: id('2'),
  });
  t.is(db.listAgentKeys().length, 2);
  db.deleteAgentKey('pub2');
  t.false(db.hasAgentKey('pub2'));

  // -- Remote agent keys --
  t.is(db.getRemoteAgentKey('rpub'), undefined);
  db.writeRemoteAgentKey('rpub', num('d'));
  t.is(db.getRemoteAgentKey('rpub'), num('d'));

  // -- Pet store entries --
  db.writePetStoreEntry(num('a'), 'pet-store', 'alice', id('4'));
  db.writePetStoreEntry(num('a'), 'pet-store', 'bob', id('5'));
  db.writePetStoreEntry(num('a'), 'mailbox-store', 'carol', id('6'));
  t.deepEqual(byName(db.listPetStoreEntries(num('a'), 'pet-store')), [
    { name: 'alice', formulaId: id('4') },
    { name: 'bob', formulaId: id('5') },
  ]);
  // Rename, overwriting an existing target name.
  db.renamePetStoreEntry(num('a'), 'pet-store', 'alice', 'bob');
  t.deepEqual(byName(db.listPetStoreEntries(num('a'), 'pet-store')), [
    { name: 'bob', formulaId: id('4') },
  ]);
  // The other store is isolated.
  t.deepEqual(byName(db.listPetStoreEntries(num('a'), 'mailbox-store')), [
    { name: 'carol', formulaId: id('6') },
  ]);
  db.deletePetStoreEntry(num('a'), 'mailbox-store', 'carol');
  t.deepEqual(db.listPetStoreEntries(num('a'), 'mailbox-store'), []);
  db.deletePetStore(num('a'), 'pet-store');
  t.deepEqual(db.listPetStoreEntries(num('a'), 'pet-store'), []);

  // -- Retention --
  db.writeRetention('guest1', num('a'));
  db.writeRetention('guest1', num('b'));
  db.writeRetention('guest2', num('c'));
  t.deepEqual(
    [...db.listRetention('guest1')].sort((x, y) =>
      x.formulaNumber < y.formulaNumber ? -1 : 1,
    ),
    [{ formulaNumber: num('a') }, { formulaNumber: num('b') }],
  );
  db.replaceRetention('guest1', [num('b'), num('d')]);
  t.deepEqual(
    [...db.listRetention('guest1')].sort((x, y) =>
      x.formulaNumber < y.formulaNumber ? -1 : 1,
    ),
    [{ formulaNumber: num('b') }, { formulaNumber: num('d') }],
  );
  db.deleteRetention('guest1', num('b'));
  t.deepEqual(db.listRetention('guest1'), [{ formulaNumber: num('d') }]);
  db.deleteAllRetention('guest1');
  t.deepEqual(db.listRetention('guest1'), []);
  t.deepEqual(db.listRetention('guest2'), [{ formulaNumber: num('c') }]);

  // -- Synced store --
  db.writeSyncedEntry(num('a'), 'doc', 'locator-1', 7, 'writer-1');
  db.writeSyncedEntry(num('a'), 'tombstone', null, 8, 'writer-2');
  t.deepEqual(byName(db.listSyncedEntries(num('a'))), [
    { name: 'doc', locator: 'locator-1', timestamp: 7, writer: 'writer-1' },
    { name: 'tombstone', locator: null, timestamp: 8, writer: 'writer-2' },
  ]);
  t.deepEqual(db.getSyncedMeta(num('a')), {
    localClock: 0,
    remoteAckedClock: 0,
  });
  db.setSyncedMeta(num('a'), 3, 2);
  t.deepEqual(db.getSyncedMeta(num('a')), {
    localClock: 3,
    remoteAckedClock: 2,
  });
  db.deleteSyncedEntry(num('a'), 'doc');
  t.deepEqual(byName(db.listSyncedEntries(num('a'))), [
    { name: 'tombstone', locator: null, timestamp: 8, writer: 'writer-2' },
  ]);
  db.deleteAllSyncedEntries(num('a'));
  t.deepEqual(db.listSyncedEntries(num('a')), []);
  db.deleteSyncedMeta(num('a'));
  t.deepEqual(db.getSyncedMeta(num('a')), {
    localClock: 0,
    remoteAckedClock: 0,
  });
};

test('aws engine passes the database specification', async t => {
  const table = makeTableEmulator();
  const db = await makeDaemonDatabaseAws({ tablePowers: table });
  exerciseDatabase(t, db);
  await db.flushed();
});

const sqliteTest = sqliteDatabaseConstructor === undefined ? test.skip : test;
sqliteTest('sqlite engine passes the same specification (parity)', async t => {
  const { makeDaemonDatabase } = await import('../src/daemon-database.js');
  const statePath = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'endo-daemon-db-parity-'),
  );
  const db = makeDaemonDatabase(/** @type {any} */ ({ statePath }), {
    Database: sqliteDatabaseConstructor,
  });
  try {
    exerciseDatabase(t, db);
  } finally {
    db.close();
    await fs.promises.rm(statePath, { recursive: true, force: true });
  }
});

test('write-behind flush persists everything a rebooted engine needs', async t => {
  const table = makeTableEmulator();
  const first = await makeDaemonDatabaseAws({ tablePowers: table });

  first.writeFormula(
    num('a'),
    num('e'),
    /** @type {any} */ ({ type: 'worker' }),
  );
  first.setState('root_nonce', num('9'));
  first.writeAgentKey('pub1', 'priv1', id('2'));
  first.writeRemoteAgentKey('rpub', num('d'));
  first.writePetStoreEntry(num('a'), 'pet-store', 'alice', id('4'));
  first.writePetStoreEntry(num('a'), 'pet-store', 'bob', id('5'));
  first.renamePetStoreEntry(num('a'), 'pet-store', 'alice', 'carol');
  first.writeRetention('guest1', num('b'));
  first.writeSyncedEntry(num('a'), 'doc', null, 7, 'writer-1');
  first.setSyncedMeta(num('a'), 3, 2);
  await first.flushed();

  // A second engine over the same table warms its mirror from the
  // flushed state alone; with the emulator's page size of 2 this also
  // exercises scan-cursor pagination.
  const second = await makeDaemonDatabaseAws({ tablePowers: table });
  t.deepEqual(second.readFormula(num('a')), {
    node: num('e'),
    formula: { type: 'worker' },
  });
  t.is(second.getState('root_nonce'), num('9'));
  t.deepEqual(second.getAgentKey('pub1'), {
    publicKey: 'pub1',
    privateKey: 'priv1',
    agentId: id('2'),
  });
  t.is(second.getRemoteAgentKey('rpub'), num('d'));
  t.deepEqual(byName(second.listPetStoreEntries(num('a'), 'pet-store')), [
    { name: 'bob', formulaId: id('5') },
    { name: 'carol', formulaId: id('4') },
  ]);
  t.deepEqual(second.listRetention('guest1'), [{ formulaNumber: num('b') }]);
  t.deepEqual(byName(second.listSyncedEntries(num('a'))), [
    { name: 'doc', locator: null, timestamp: 7, writer: 'writer-1' },
  ]);
  t.deepEqual(second.getSyncedMeta(num('a')), {
    localClock: 3,
    remoteAckedClock: 2,
  });
});

test('a failing flush escalates once and poisons the queue', async t => {
  let failing = false;
  let escalations = 0;
  const table = makeTableEmulator({
    beforeWrite: () => {
      if (failing) {
        throw new Error('injected DynamoDB outage');
      }
    },
  });
  const db = await makeDaemonDatabaseAws({
    tablePowers: table,
    onFlushError: () => {
      escalations += 1;
    },
  });

  db.setState('before', 'durable');
  await db.flushed();

  failing = true;
  db.setState('during', 'lost');
  db.setState('later', 'also-lost');
  await t.throwsAsync(() => db.flushed(), {
    message: /injected DynamoDB outage/,
  });
  t.is(escalations, 1);

  // The mirror still answers (the daemon decides whether to panic),
  // but nothing after the failure reached the table.
  t.is(db.getState('during'), 'lost');
  failing = false;
  t.is(table.snapshot().get('state|before'), 'durable');
  t.false(table.snapshot().has('state|during'));
  t.false(table.snapshot().has('state|later'));
});
