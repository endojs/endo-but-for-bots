// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Far } from '@endo/far';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { makePromiseKit } from '@endo/promise-kit';
import { makeCounterClient } from '../src/counter-client.js';

/** @param {() => boolean} predicate */
const until = async predicate => {
  await null;
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    // Yield to eventual sends and stream pumps without timing assumptions.
    // eslint-disable-next-line no-await-in-loop
    await nextTurn();
  }
  throw new Error('Expected lifecycle transition did not occur');
};

const makeSnapshots = () => {
  const values = [harden({ value: 0n, revision: 0n })];
  let pending;
  let ended = false;
  let closes = 0;
  const close = () => {
    if (ended) return;
    ended = true;
    closes += 1;
    pending?.resolve({ done: true, value: undefined });
    pending = undefined;
  };
  const reader = readerFromIterator(
    harden({
      next() {
        if (ended) return Promise.resolve({ done: true, value: undefined });
        if (values.length)
          return Promise.resolve({ done: false, value: values.shift() });
        pending = makePromiseKit();
        return pending.promise;
      },
      async return() {
        close();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    }),
    { cancelPending: close },
  );
  return {
    reader,
    getCloses: () => closes,
    push(value) {
      const snapshot = harden({ value, revision: value });
      if (pending) {
        const kit = pending;
        pending = undefined;
        kit.resolve({ done: false, value: snapshot });
      } else values.push(snapshot);
    },
  };
};

const makeConnection = counter => {
  const lifetime = makePromiseKit();
  let closes = 0;
  return {
    connection: {
      endowments: Promise.resolve(harden({ counter })),
      closed: lifetime.promise,
      close() {
        closes += 1;
      },
    },
    // Deliberately independent of close(): native socket close callbacks can
    // arrive after an application has already opened a replacement connection.
    finish: () => lifetime.resolve(undefined),
    getCloses: () => closes,
  };
};

const makeHarness = (t, connections) => {
  let opens = 0;
  let state = { status: '', canIncrement: false };
  const client = makeCounterClient({
    connect: () => {
      const connection = connections[opens];
      opens += 1;
      if (!connection) throw new Error('Unexpected extra connection');
      return connection.connection;
    },
    render: update => {
      state = { ...state, ...update };
    },
    retryMs: 1,
  });
  t.teardown(client.close);
  t.timeout(5000);
  return { client, getState: () => state, getOpens: () => opens };
};

test('late incrementer and old close callback cannot replace the current connection', async t => {
  const oldIncrementer = makePromiseKit();
  let oldStarted = false;
  let oldCalls = 0;
  let currentCalls = 0;
  const old = makeConnection(
    Far('Old Counter', {
      makeIncrementer() {
        oldStarted = true;
        return oldIncrementer.promise;
      },
      follow() {
        throw new Error('Stale attempt must not call follow');
      },
    }),
  );
  const snapshots = makeSnapshots();
  const current = makeConnection(
    Far('Current Counter', {
      makeIncrementer: () =>
        Far('Current Incrementer', {
          increment() {
            currentCalls += 1;
          },
        }),
      follow: () => snapshots.reader,
    }),
  );
  const { client, getState, getOpens } = makeHarness(t, [old, current]);
  const first = client.connect();
  await until(() => oldStarted);
  const second = client.connect();
  await until(() => getState().canIncrement);
  oldIncrementer.resolve(
    Far('Old Incrementer', {
      increment() {
        oldCalls += 1;
      },
    }),
  );
  await first;
  old.finish();
  await nextTurn();
  await client.increment();
  t.is(oldCalls, 0);
  t.is(currentCalls, 1);
  t.is(getOpens(), 2);
  t.true(getState().canIncrement);
  t.is(current.getCloses(), 0);
  client.close();
  await second;
  t.is(snapshots.getCloses(), 1);
});

test('late follow result is closed without replacing the active reader', async t => {
  const oldReader = makePromiseKit();
  const staleSnapshots = makeSnapshots();
  const snapshots = makeSnapshots();
  let following = false;
  let calls = 0;
  const old = makeConnection(
    Far('Old Counter', {
      makeIncrementer: () =>
        Far('Old Incrementer', {
          increment() {
            throw new Error('Wrong incrementer');
          },
        }),
      follow() {
        following = true;
        return oldReader.promise;
      },
    }),
  );
  const current = makeConnection(
    Far('Current Counter', {
      makeIncrementer: () =>
        Far('Current Incrementer', {
          increment() {
            calls += 1;
          },
        }),
      follow: () => snapshots.reader,
    }),
  );
  const { client, getState } = makeHarness(t, [old, current]);
  const first = client.connect();
  await until(() => following);
  const second = client.connect();
  await until(() => getState().canIncrement);
  oldReader.resolve(staleSnapshots.reader);
  await first;
  await until(() => staleSnapshots.getCloses() === 1);
  t.is(snapshots.getCloses(), 0);
  await client.increment();
  t.is(calls, 1);
  client.close();
  await second;
  t.is(snapshots.getCloses(), 1);
});

test('duplicate clicks and live snapshots cannot submit while an increment is pending', async t => {
  const response = makePromiseKit();
  const snapshots = makeSnapshots();
  const sequences = [];
  const connection = makeConnection(
    Far('Counter', {
      makeIncrementer: () =>
        Far('Incrementer', {
          increment(sequence) {
            sequences.push(sequence);
            return sequences.length === 1 ? response.promise : undefined;
          },
        }),
      follow: () => snapshots.reader,
    }),
  );
  const { client, getState } = makeHarness(t, [connection]);
  const connected = client.connect();
  await until(() => getState().canIncrement);
  const first = client.increment();
  await until(() => sequences.length === 1);
  await client.increment();
  snapshots.push(7n);
  await until(() => getState().value === 7n);
  t.false(getState().canIncrement);
  await client.increment();
  t.deepEqual(sequences, [1n]);
  response.resolve(undefined);
  await first;
  t.true(getState().canIncrement);
  await client.increment();
  t.deepEqual(sequences, [1n, 2n]);
  client.close();
  await connected;
});

test('late failure of an uncertain increment cannot replay it or disturb a replacement', async t => {
  const response = makePromiseKit();
  const oldSnapshots = makeSnapshots();
  const snapshots = makeSnapshots();
  let oldCalls = 0;
  const sequences = [];
  const old = makeConnection(
    Far('Old Counter', {
      makeIncrementer: () =>
        Far('Old Incrementer', {
          increment() {
            oldCalls += 1;
            return response.promise;
          },
        }),
      follow: () => oldSnapshots.reader,
    }),
  );
  const current = makeConnection(
    Far('Current Counter', {
      makeIncrementer: () =>
        Far('Current Incrementer', {
          increment(sequence) {
            sequences.push(sequence);
          },
        }),
      follow: () => snapshots.reader,
    }),
  );
  const { client, getState, getOpens } = makeHarness(t, [old, current]);
  const first = client.connect();
  await until(() => getState().canIncrement);
  const uncertain = client.increment();
  await until(() => oldCalls === 1);
  const second = client.connect();
  await until(() => getState().canIncrement);
  response.reject(new Error('Old acknowledgement lost'));
  await uncertain;
  await first;
  old.finish();
  await nextTurn();
  t.is(getOpens(), 2);
  t.deepEqual(sequences, []);
  t.is(current.getCloses(), 0);
  t.true(getState().canIncrement);
  await client.increment();
  t.deepEqual(sequences, [1n]);
  client.close();
  await second;
});

test('closing during follow acquisition releases the never-started reader and stays closed', async t => {
  const pendingReader = makePromiseKit();
  const snapshots = makeSnapshots();
  let following = false;
  const connection = makeConnection(
    Far('Counter', {
      makeIncrementer: () => Far('Incrementer', { increment() {} }),
      follow() {
        following = true;
        return pendingReader.promise;
      },
    }),
  );
  const { client, getState, getOpens } = makeHarness(t, [connection]);
  const connected = client.connect();
  await until(() => following);
  client.close();
  pendingReader.resolve(snapshots.reader);
  await connected;
  await until(() => snapshots.getCloses() === 1);
  connection.finish();
  await client.connect();
  await client.increment();
  t.is(getOpens(), 1);
  t.false(getState().canIncrement);
  t.is(connection.getCloses(), 1);
});
