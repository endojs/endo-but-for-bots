// @ts-check
import test from '@endo/ses-ava/test.js';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeDurableWorkerTransport } from '../src/durable-worker-transport.js';
import { makeOcapnHub } from '../src/hub.js';
import { makeMemoryStore } from '../src/store-memory.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

/** @import {WorkerEngine} from '../src/worker-engine.js' */

const workerId = 'a'.repeat(32);

/** A committed outbox that was interrupted before destination acceptance. */
const makeQueuedStore = () => {
  /** @type {any} */
  let state = {
    version: 2,
    refs: {},
    sessions: {
      [workerId]: {
        durable: true,
        queue: ['00', '01'],
        queueSequences: ['9007199254740993', ''],
        nextDelivery: '9007199254740993',
        processedUpTo: '9007199254740995',
      },
    },
  };
  return {
    getState: () => state,
    setState: (/** @type {any} */ value) => {
      state = JSON.parse(JSON.stringify(value));
    },
  };
};

for (const receipt of [false, undefined, Promise.resolve(true)]) {
  test(`unaccepted local handoff retains its payload and identity: ${String(receipt)}`, t => {
    const store = makeQueuedStore();
    const hub = makeOcapnHub({ codec: syrupCodec, store });
    hub.attachSession(workerId, {
      durable: true,
      requireAcceptance: true,
      send: () => receipt,
    });
    t.deepEqual(store.getState().sessions[workerId].queue, ['00', '01']);
    t.deepEqual(store.getState().sessions[workerId].queueSequences, [
      '9007199254740993',
      '',
    ]);
    /** @type {Array<string | undefined>} */
    const accepted = [];
    hub.attachSession(workerId, {
      durable: true,
      requireAcceptance: true,
      send: (_bytes, sequence) => {
        accepted.push(sequence);
        return true;
      },
    });
    t.deepEqual(accepted, ['9007199254740993', '9007199254740994']);
    t.deepEqual(store.getState().sessions[workerId].queue, []);
    t.is(hub.inboundWatermark(workerId), 9_007_199_254_740_995n);
  });
}

test('journal acceptance survives a crash before hub removes its outbox copy', async t => {
  const hubStore = makeQueuedStore();
  const workerStore = makeMemoryStore().provideWorkerStore(workerId);
  /** @type {number[]} */
  const delivered = [];
  /** @type {WorkerEngine} */
  const engine = {
    canSnapshot: false,
    start: async () => ({
      deliver: async message => {
        if (message.t === 'f') delivered.push(1);
      },
      snapshot: async () => null,
      terminate: async () => {},
    }),
  };
  const transport = makeDurableWorkerTransport(nodePowers, {
    workerId,
    store: workerStore,
    engine,
    onFrame: () => {},
  });
  t.teardown(() => transport.retire());
  const hub = makeOcapnHub({ codec: syrupCodec, store: hubStore });
  t.throws(
    () =>
      hub.attachSession(workerId, {
        durable: true,
        requireAcceptance: true,
        send: (bytes, sequence) => {
          t.true(transport.write(bytes, sequence));
          throw Error('crash before outbox removal');
        },
      }),
    { message: 'crash before outbox removal' },
  );
  // End before the scheduled execution begins: only the journal owns this copy.
  transport.end();
  t.is(workerStore.journalLength(), 1);
  t.is(hubStore.getState().sessions[workerId].queue.length, 2);
  const restoredTransport = makeDurableWorkerTransport(nodePowers, {
    workerId,
    store: workerStore,
    engine,
    onFrame: () => {},
  });
  t.teardown(() => restoredTransport.retire());
  const restoredHub = makeOcapnHub({ codec: syrupCodec, store: hubStore });
  restoredHub.attachSession(workerId, {
    durable: true,
    requireAcceptance: true,
    send: restoredTransport.write,
  });
  await restoredTransport.wake();
  t.is(
    workerStore.journalLength(),
    2,
    'retry does not append a second journal copy',
  );
  t.is(delivered.length, 2, 'each of the two logical inputs executes once');
  t.deepEqual(hubStore.getState().sessions[workerId].queue, []);
});

test('closed and failed workers decline new handoffs without journaling', async t => {
  const workerStore = makeMemoryStore().provideWorkerStore(workerId);
  /** @type {WorkerEngine} */
  const engine = {
    canSnapshot: false,
    start: async () => {
      throw Error('declined handoff must not start worker');
    },
  };
  const transport = makeDurableWorkerTransport(nodePowers, {
    workerId,
    store: workerStore,
    engine,
    onFrame: () => {},
  });
  t.teardown(() => transport.retire());
  workerStore.setMeta({ failure: 'quarantined' });
  t.false(transport.write(new Uint8Array([0]), '1'));
  workerStore.setMeta({});
  transport.end();
  t.false(transport.write(new Uint8Array([0]), '1'));
  t.is(workerStore.journalLength(), 0);
});

test('failed hub commit cannot leak effects through a duplicate delivery', t => {
  const stored = makeQueuedStore();
  let failing = false;
  let writable = false;
  let sent = 0;
  const hub = makeOcapnHub({
    codec: syrupCodec,
    logError: () => {},
    store: {
      getState: stored.getState,
      setState: state => {
        if (failing) throw Error('store unavailable');
        stored.setState(state);
      },
    },
  });
  const sink = hub.attachSession(workerId, {
    durable: true,
    requireAcceptance: true,
    send: () => {
      if (!writable) return false;
      sent += 1;
      return true;
    },
  });
  writable = true;
  failing = true;
  const frame = new Uint8Array([0]);
  const sequence = 9_007_199_254_740_996n;
  t.throws(() => sink.deliver(frame, sequence), {
    message: 'store unavailable',
  });
  t.throws(() => sink.deliver(frame, sequence), {
    message: 'store unavailable',
  });
  t.throws(() => sink.flush(), { message: 'store unavailable' });
  t.is(
    sent,
    0,
    'no failed-commit effects may escape through either retry path',
  );
  failing = false;
  sink.deliver(frame, sequence);
  t.is(sent, 2);
  t.is(stored.getState().sessions[workerId].processedUpTo, String(sequence));
});

test('reconciling durable retirement after restart does not advance the epoch twice', t => {
  const store = makeQueuedStore();
  const hub = makeOcapnHub({ codec: syrupCodec, store });
  hub.retireSession(workerId);
  const retired = JSON.stringify(store.getState());
  const restored = makeOcapnHub({ codec: syrupCodec, store });
  restored.retireSession(workerId);
  t.is(JSON.stringify(store.getState()), retired);
  // An explicit new attachment still selects the next incarnation namespace.
  restored.attachSession(workerId, { send: () => true });
  t.false(store.getState().sessions[workerId].retired);
});

test('an old transport tombstone cannot retire a replacement using the same alias', t => {
  const store = makeQueuedStore();
  const hub = makeOcapnHub({ codec: syrupCodec, store });
  const oldEpoch = hub.getSessionEpoch(workerId);
  t.is(hub.getSessionEpoch('absent'), 0);
  t.false(Object.hasOwn(store.getState().sessions, 'absent'));
  hub.retireSession(workerId, oldEpoch);
  hub.attachSession(workerId, { durable: true, send: () => true });
  hub.publish('replacement', { session: workerId, position: 0n });
  const replacement = JSON.stringify(store.getState());
  const restored = makeOcapnHub({ codec: syrupCodec, store });
  t.is(restored.getSessionEpoch(workerId), oldEpoch + 1);
  restored.retireSession(workerId, oldEpoch);
  t.is(JSON.stringify(store.getState()), replacement);
  t.false(store.getState().sessions[workerId].retired);
  restored.retireSession(workerId, restored.getSessionEpoch(workerId));
  t.true(store.getState().sessions[workerId].retired);
});
