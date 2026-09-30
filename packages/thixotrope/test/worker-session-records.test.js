// @ts-check
/**
 * The endpoint's durable session records: resource descriptions that a
 * restart re-seats, and what retires them.
 */
import test from '@endo/ses-ava/test.js';

import { Far } from '@endo/far';

import { makeMemoryStore } from '../src/store/store-memory.js';
import { makeWorkerSessionRecords } from '../src/core/worker-session-records.js';

const ENDPOINT_ID = 'e'.repeat(32);

const makeFixture = () => {
  const store = makeMemoryStore();
  /** @type {Array<any>} */
  const restored = [];
  let made = 0;
  const records = makeWorkerSessionRecords({
    store,
    resources: {
      counter: description => {
        made += 1;
        return Far('Counter', { describe: () => description });
      },
    },
    reportError: error => {
      throw error;
    },
  });
  const connection = {};
  records.registerWorkerConnection(connection, ENDPOINT_ID);
  records.registerResumedSession(ENDPOINT_ID, {
    provideImport: () => Far('Import', {}),
    restoreExport: (/** @type {bigint} */ position, /** @type {any} */ value) =>
      restored.push(['export', position, value]),
    restorePendingResolver: (/** @type {any} */ obligation) =>
      restored.push(['resolver', obligation]),
    advanceAnswerPosition: () => {},
  });
  const tables = () =>
    /** @type {any} */ (
      store.provideWorkerStore(ENDPOINT_ID).getTablesRecord()
    );
  return { store, records, connection, restored, tables, count: () => made };
};

test('retiring a resource forgets its instance and nulls its export records', t => {
  const { records, connection, tables, count } = makeFixture();
  const first = records.provideResource('counter', { n: 1 });
  t.is(records.provideResource('counter', { n: 1 }), first, 'memoised');
  t.is(count(), 1);
  records.sessionHooks.onExport(connection, 'o+5', first);
  t.deepEqual(tables().exports['o+5'], {
    kind: 'resource',
    name: 'counter',
    description: { n: 1 },
  });

  t.true(records.retireResource('counter', { n: 1 }));
  t.is(tables().exports['o+5'], null, 'a restart seats a tombstone there');
  const second = records.provideResource('counter', { n: 1 });
  t.not(second, first, 'the factory runs again for the same description');
  t.is(count(), 2);
  t.false(
    records.retireResource('counter', { n: 2 }),
    'nothing to retire for a description never provided',
  );
});

test('an export the peer released loses its record', t => {
  const { records, connection, tables } = makeFixture();
  const instance = records.provideResource('counter', { n: 3 });
  records.sessionHooks.onExport(connection, 'o+7', instance);
  t.truthy(tables().exports['o+7']);
  records.sessionHooks.onExportReleased(connection, 'o+7');
  t.false('o+7' in (tables().exports ?? {}));
  // Releasing an unrecorded slot is a no-op, not an error.
  records.sessionHooks.onExportReleased(connection, 'o+8');
});

test('restore re-seats exports and drops answer obligations after breaking them', t => {
  const { store, records, restored, tables } = makeFixture();
  store.provideWorkerStore(ENDPOINT_ID).setTablesRecord({
    exports: {
      'o+1': { kind: 'resource', name: 'counter', description: { n: 9 } },
      'o+2': null,
      'p+7': { kind: 'resource', name: 'counter', description: { n: 7 } },
    },
    pendingResolvers: {
      'o-1': { kind: 'answer', position: '1' },
      'o-2': { kind: 'promise', position: '7' },
    },
  });
  records.restoreWorker(ENDPOINT_ID);
  const exports = restored.filter(([kind]) => kind === 'export');
  t.deepEqual(
    exports.map(([, position]) => position),
    [1n, 2n, 7n],
  );
  const resolvers = restored.filter(([kind]) => kind === 'resolver');
  t.deepEqual(
    resolvers.map(([, o]) => [o.resolverPosition, o.target.kind]),
    [
      [1n, 'answer'],
      [2n, 'promise'],
    ],
  );
  t.deepEqual(
    tables().pendingResolvers,
    {
      'o-1': { kind: 'answer', position: '1', brokenAtEpoch: 1 },
      'o-2': { kind: 'promise', position: '7' },
    },
    'a broken answer is kept for one more boot, marked with the epoch',
  );
  t.is(tables().answerEpoch, 1);
  // The second boot re-breaks it (the first boot may have crashed before the
  // hub persisted the break) and then drops it.
  restored.length = 0;
  records.restoreWorker(ENDPOINT_ID);
  t.deepEqual(
    restored
      .filter(([kind]) => kind === 'resolver')
      .map(([, o]) => [o.resolverPosition, o.target.kind]),
    [
      [1n, 'answer'],
      [2n, 'promise'],
    ],
  );
  t.deepEqual(Object.keys(tables().pendingResolvers), ['o-2']);
  t.is(tables().answerEpoch, 2);
});

test('a retired promise export re-seats as a broken promise', async t => {
  const { store, records, restored } = makeFixture();
  store.provideWorkerStore(ENDPOINT_ID).setTablesRecord({
    exports: { 'p+4': null, 'o+5': null },
    pendingResolvers: { 'o-1': { kind: 'promise', position: '4' } },
  });
  records.restoreWorker(ENDPOINT_ID);
  const exports = restored.filter(([kind]) => kind === 'export');
  t.is(exports.length, 2);
  t.true(exports[0][2] instanceof Promise, 'a promise position gets a promise');
  await t.throwsAsync(exports[0][2], {
    message: 'Promise export was retired before it settled',
  });
  t.false(
    exports[1][2] instanceof Promise,
    'an object position gets an object',
  );
  t.is(
    restored.filter(([kind]) => kind === 'resolver').length,
    1,
    'the listener is re-linked to the broken promise, not dropped',
  );
});

test('a promise obligation whose export was released is dropped, not restored', t => {
  const { store, records, restored, tables } = makeFixture();
  store.provideWorkerStore(ENDPOINT_ID).setTablesRecord({
    exports: {},
    pendingResolvers: { 'o-3': { kind: 'promise', position: '4' } },
  });
  records.restoreWorker(ENDPOINT_ID);
  t.deepEqual(restored, [], 'nothing to re-link');
  t.deepEqual(tables().pendingResolvers, {});
});

test('releasing a promise export drops the obligation that names it', t => {
  const { records, connection, tables } = makeFixture();
  const instance = records.provideResource('counter', { n: 5 });
  records.sessionHooks.onExport(connection, 'p+9', instance);
  records.sessionHooks.onPendingResolver(connection, 'o-6', {
    kind: 'promise',
    position: 9n,
  });
  t.truthy(tables().exports['p+9']);
  t.truthy(tables().pendingResolvers['o-6']);
  records.sessionHooks.onExportReleased(connection, 'p+9');
  t.false('p+9' in tables().exports);
  t.false('o-6' in tables().pendingResolvers);
});
