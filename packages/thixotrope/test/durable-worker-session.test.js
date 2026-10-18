// @ts-check

/** @import { WorkerEngine } from '../src/core/worker-engine.js' */

/**
 * The durable worker transport as the hub's durability envelope: the
 * transport journals host→worker frames before the duct, wakes
 * sleeping workers by replaying the journal suffix into a
 * snapshot-restored incarnation, and absorbs the deterministically
 * regenerated outbound frames with a persisted watermark — while the
 * OCapN hub owns all routing. Exercised here against the in-process
 * peer replay engines; `test/durable-worker-session-xs.test.js` runs
 * the same lifecycle on real XS heap snapshots.
 */
import test from '@endo/ses-ava/test.js';

import { setTimeout as delay } from 'node:timers/promises';

import harden from '@endo/harden';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { E } from '@endo/eventual-send';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeOcapnHub } from '../src/net/hub.js';
import { makeDurableWorkerTransport } from '../src/core/durable-worker-transport.js';
import { makePipeNetwork } from '../src/net/pipe-network.js';
import {
  makePeerJournalReplayEngine,
  makePeerSnapshottingReplayEngine,
} from '../src/core/peer-replay-engine.js';
import { makeMemoryStore } from '../src/store/store-memory.js';
import { makeTestOcapn } from './_util.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();
const transportPowers = {
  timers: nodePowers.timers,
  logging: nodePowers.logging,
};

const textEncoder = new TextEncoder();
/** @param {string} text */
const bytesOf = text => frozenBytes(textEncoder.encode(text));
const SHELL_SWISSNUM = bytesOf('shell');

const COUNTER_SOURCE = `
(() => {
  let count = 0;
  return Far('Counter', {
    incr: () => {
      count += 1;
      return count;
    },
    getCount: () => count,
  });
})()
`;

/**
 * The daemon-shaped wiring: a hub, one worker on a durable transport,
 * and an ordinary OCapN client standing in for the embedder.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {object} options
 * @param {string} options.workerId
 * @param {any} options.engine
 * @param {any} options.store a ThixotropeStore
 * @param {string} [options.debugLabel]
 * @param {number} [options.snapshotEveryDeliveries]
 */
const makeHubKit = async (
  t,
  { workerId, engine, store, debugLabel, snapshotEveryDeliveries },
) => {
  const hub = makeOcapnHub({ codec: syrupCodec });
  /** @type {any} */
  const holder = {};
  const transport = makeDurableWorkerTransport(transportPowers, {
    workerId,
    store: store.provideWorkerStore(workerId),
    engine,
    debugLabel,
    snapshotEveryDeliveries,
    onFrame: (
      /** @type {Uint8Array} */ bytes,
      /** @type {number} */ sequenceNumber,
    ) => holder.sink.deliver(bytes, sequenceNumber),
  });
  holder.sink = hub.attachSession(workerId, {
    send: (/** @type {Uint8Array} */ bytes) => transport.write(bytes),
    durable: true,
  });
  hub.publish('worker', { session: workerId, position: 0n });

  const clientKey = 'c'.repeat(32);
  /** @type {{ sink: any, pending: Array<Uint8Array> }} */
  const outbound = { sink: undefined, pending: [] };
  const pipe = makePipeNetwork({
    codec: syrupCodec,
    workerId: clientKey,
    role: 'worker',
    send: frame => {
      if (outbound.sink === undefined) {
        outbound.pending.push(frame);
      } else {
        outbound.sink.deliver(frame);
      }
    },
  });
  const client = await makeTestOcapn({
    codec: syrupCodec,
    network: pipe.network,
    debugLabel: 'embedder',
  });
  t.teardown(() => client.shutdown());
  const session = await client.provideSession(pipe.peerLocation);
  outbound.sink = hub.attachSession(clientKey, {
    send: (/** @type {Uint8Array} */ bytes) => pipe.deliver(bytes),
  });
  for (const frame of outbound.pending.splice(0)) {
    outbound.sink.deliver(frame);
  }
  return { hub, transport, session };
};

test('a worker session sleeps and wakes by journal replay', async t => {
  const store = makeMemoryStore();
  const workerId = 'd'.repeat(32);
  const { transport, session } = await makeHubKit(t, {
    workerId,
    engine: makePeerJournalReplayEngine(nodePowers),
    store,
    debugLabel: 'sleeper',
  });
  t.false(transport.isAwake(), 'attachment alone does not wake the worker');

  const shell = await E(
    E(session.getBootstrap()).fetch(bytesOf('worker')),
  ).fetch(SHELL_SWISSNUM);
  t.true(transport.isAwake(), 'the first delivery woke the worker');
  const counter = await E(shell).evaluate(COUNTER_SOURCE);
  t.is(await E(counter).incr(), 1);
  t.is(await E(counter).incr(), 2);

  await transport.sleep();
  t.false(transport.isAwake());

  // The next delivery wakes the worker: a fresh peer replays the whole
  // journal (this engine has no snapshots), regenerates every outbound
  // frame it ever sent — all absorbed by the watermark — and then
  // handles the new frame. The hub session never noticed.
  t.is(await E(counter).incr(), 3, 'state survived sleep via replay');
  t.true(transport.isAwake());
  t.is(await E(counter).getCount(), 3);
});

test('a worker session survives snapshot, sleep, and crash', async t => {
  const store = makeMemoryStore();
  const workerId = 'e'.repeat(32);
  const workerStore = store.provideWorkerStore(workerId);
  const { transport, session } = await makeHubKit(t, {
    workerId,
    engine: makePeerSnapshottingReplayEngine(nodePowers),
    store,
    debugLabel: 'napper',
  });

  const shell = await E(
    E(session.getBootstrap()).fetch(bytesOf('worker')),
  ).fetch(SHELL_SWISSNUM);
  const counter = await E(shell).evaluate(COUNTER_SOURCE);
  t.is(await E(counter).incr(), 1);
  t.is(await E(counter).incr(), 2);

  await transport.sleep();
  t.false(transport.isAwake());
  const meta = workerStore.getMeta();
  const snapshotRecord = meta.snapshot;
  if (!snapshotRecord) {
    throw t.fail('sleep did not commit a snapshot');
  }
  t.true(
    (meta.outboundBase ?? 0) > 0,
    'the outbound sequence base advanced with the snapshot',
  );
  t.is(
    workerStore.journalLength(),
    snapshotRecord.cut ?? -1,
    'the journal prefix the snapshot subsumes was truncated',
  );

  t.is(await E(counter).incr(), 3, 'woke from the snapshot');

  // Crash without sleep: the incarnation dies with frames journaled
  // after the snapshot. The next delivery restores the snapshot and
  // replays the journal suffix; the watermark absorbs the regenerated
  // outbound frames.
  await transport.crash();
  t.false(transport.isAwake());
  t.is(await E(counter).incr(), 4, 'crash recovery replayed the suffix');
  t.is(await E(counter).getCount(), 4);

  // Presence identity holds across all of it.
  const registry = await E(shell).evaluate(
    `
    (() => {
      let kept;
      return Far('Registry', {
        keep: thing => {
          kept = thing;
          return 'kept';
        },
        isKept: specimen => specimen === kept,
      });
    })()
    `,
  );
  t.is(await E(registry).keep(counter), 'kept');
  await transport.sleep();
  t.is(
    await E(registry).isKept(counter),
    true,
    'a presence passed before sleep unwraps to the original after wake',
  );
});

test('a retired worker session breaks its imports', async t => {
  const store = makeMemoryStore();
  const workerId = 'f'.repeat(32);
  const { hub, transport, session } = await makeHubKit(t, {
    workerId,
    engine: makePeerJournalReplayEngine(nodePowers),
    store,
    debugLabel: 'retiree',
  });

  const shell = await E(
    E(session.getBootstrap()).fetch(bytesOf('worker')),
  ).fetch(SHELL_SWISSNUM);
  const counter = await E(shell).evaluate(COUNTER_SOURCE);
  t.is(await E(counter).incr(), 1);

  // The daemon pairs the transport's retirement with the hub's, as
  // retireWorkerNow does.
  await transport.retire();
  hub.retireSession(workerId);
  await t.throwsAsync(() => E(counter).incr(), {
    message: /retired/,
  });
});

test('idle sleeping reports awake until the snapshot commits', async t => {
  t.timeout(10_000);
  const snapshotStarted = Promise.withResolvers();
  const snapshot = Promise.withResolvers();
  const terminated = Promise.withResolvers();
  const workerId = 'a'.repeat(32);
  const store = makeMemoryStore().provideWorkerStore(workerId);
  let snapshots = 0;
  const transport = makeDurableWorkerTransport(transportPowers, {
    workerId,
    store,
    idleSleepMs: 1,
    onFrame: () => {},
    engine: harden({
      canSnapshot: true,
      start: async () =>
        harden({
          deliver: async () => {},
          snapshot: () => {
            snapshots += 1;
            snapshotStarted.resolve(undefined);
            return snapshot.promise;
          },
          terminate: async () => {
            terminated.resolve(undefined);
          },
        }),
    }),
  });
  t.teardown(async () => {
    snapshot.resolve('snapshot');
    await transport.retire();
  });
  await transport.wake();
  // Read-only polling must not postpone the idle timer.
  while (snapshots === 0) {
    t.true(transport.isAwake());
    // eslint-disable-next-line no-await-in-loop
    await delay(1);
  }
  await snapshotStarted.promise;
  // The idle threshold has elapsed, but sleeping is not yet complete.
  t.true(transport.isAwake());
  t.is(store.getMeta().snapshot, undefined);
  snapshot.resolve('snapshot');
  await terminated.promise;
  t.false(transport.isAwake());
  t.is(store.getMeta().snapshot?.ref, 'snapshot');
  t.is(snapshots, 1);
});

test('an awake worker snapshots on a delivery cadence and replays only past the cut', async t => {
  t.timeout(10_000);
  const workerId = 'b'.repeat(32);
  const store = makeMemoryStore().provideWorkerStore(workerId);
  let deliveries = 0;
  let snapshots = 0;
  /** @type {number[]} */
  const sequences = [];
  const transport = makeDurableWorkerTransport(transportPowers, {
    workerId,
    store,
    snapshotEveryDeliveries: 3,
    onFrame: (_bytes, sequenceNumber) => {
      sequences.push(sequenceNumber);
    },
    engine: harden({
      canSnapshot: true,
      start: async ({ onOutbound }) =>
        harden({
          // Echo each frame, so the outbound numbering is observable.
          deliver: async message => {
            if (message.t !== 'f') return;
            deliveries += 1;
            onOutbound(harden({ t: 'f', b64: message.b64 }));
          },
          snapshot: async () => {
            snapshots += 1;
            return `snapshot-${snapshots}`;
          },
          terminate: async () => {},
        }),
    }),
  });
  t.teardown(() => transport.retire());
  /** @param {number} i */
  const frame = i => frozenBytes(textEncoder.encode(`frame ${i}`));
  /**
   * One frame at a time: a wake is a barrier, running after every
   * operation queued before it, so each delivery completes first.
   * @param {number} i
   */
  const writeOne = async i => {
    transport.write(frame(i));
    await transport.wake();
  };

  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await writeOne(i);
  }
  t.true(transport.isAwake(), 'a cadence snapshot leaves the worker awake');
  t.is(snapshots, 2, 'at the third and the sixth delivery');
  t.is(store.getMeta().snapshot?.cut, 6);
  t.is(store.getMeta().outboundBase, 6);
  t.is(store.journalLength(), 7);
  t.is(store.readJournal().length, 1, 'the subsumed prefix was truncated');
  t.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7], 'numbering runs on');

  await transport.crash();
  deliveries = 0;
  await writeOne(7);
  t.is(deliveries, 2, 'the wake replayed only the entry past the cut');
  t.deepEqual(
    sequences.slice(7),
    [7, 8],
    'the regenerated frame keeps its number and the new one follows',
  );
  t.is(snapshots, 2, 'two deliveries since the cut: no snapshot yet');

  // A burst queues its deliveries ahead of the snapshot the third one asks
  // for, so one snapshot covers the whole burst.
  for (let i = 8; i < 13; i += 1) transport.write(frame(i));
  // The burst's deliveries queued ahead of the first barrier, and the
  // snapshot the third of them asked for queued behind it; the second
  // barrier waits for that snapshot to commit.
  await transport.wake();
  await transport.wake();
  t.is(snapshots, 3, 'one snapshot for the burst');
  t.is(store.getMeta().snapshot?.cut, 13);
  t.is(store.readJournal().length, 0);
});

test('a never-idle worker still bounds its journal by the snapshot cadence', async t => {
  const store = makeMemoryStore();
  const workerId = '9'.repeat(32);
  const workerStore = store.provideWorkerStore(workerId);
  const { transport, session } = await makeHubKit(t, {
    workerId,
    engine: makePeerSnapshottingReplayEngine(nodePowers),
    store,
    debugLabel: 'busy',
    snapshotEveryDeliveries: 2,
  });

  const shell = await E(
    E(session.getBootstrap()).fetch(bytesOf('worker')),
  ).fetch(SHELL_SWISSNUM);
  const counter = await E(shell).evaluate(COUNTER_SOURCE);
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    t.is(await E(counter).incr(), i);
  }
  await transport.wake();
  t.true(transport.isAwake(), 'never slept');
  const { snapshot } = workerStore.getMeta();
  if (!snapshot) throw t.fail('no snapshot was taken while awake');
  t.true((snapshot.cut ?? 0) > 0);
  t.true(
    workerStore.journalLength() - (snapshot.cut ?? 0) <= 2,
    'the journal suffix stays within the cadence',
  );

  await transport.crash();
  t.is(await E(counter).incr(), 6, 'recovered from the awake snapshot');
  t.is(await E(counter).getCount(), 6);
});

test('completed-crank batches retain individual identities across replay and snapshot', async t => {
  t.timeout(10_000);
  const store = makeMemoryStore().provideWorkerStore('e'.repeat(32));
  /** @type {number[][]} */
  const batches = [];
  /** @type {WorkerEngine} */
  const engine = {
    canSnapshot: true,
    start: async ({ onOutboundBatch }) => ({
      deliver: async () => {
        onOutboundBatch?.([
          { t: 'f', b64: 'AQID' },
          { t: 'f', b64: 'BAUG' },
        ]);
      },
      snapshot: async () => 'snapshot',
      terminate: async () => {},
    }),
  };
  const options = {
    workerId: 'e'.repeat(32),
    store,
    engine,
    onFrame: () => t.fail('batch-capable engine must use the batch callback'),
    onFrames: (
      /** @type {Array<{bytes: Uint8Array, sequenceNumber: number}>} */ frames,
    ) => batches.push(frames.map(frame => frame.sequenceNumber)),
  };
  const transport = makeDurableWorkerTransport(transportPowers, options);
  t.teardown(() => transport.retire());
  await transport.wake();
  t.true(transport.write(frozenBytes(new Uint8Array([1])), '1'));
  await transport.crash();
  await transport.wake();
  t.deepEqual(batches, [
    [1, 2],
    [3, 4],
    [1, 2],
    [3, 4],
  ]);
  await transport.sleep();
  t.is(store.getMeta().hubDelivery, '1');
  t.is(store.getMeta().outboundBase, 4);
  t.deepEqual(store.readJournal(), []);
  await transport.retire();
  const restored = makeDurableWorkerTransport(transportPowers, options);
  t.teardown(() => restored.retire());
  // After host restart and truncation, a retained hub tail is already owned.
  t.true(restored.write(frozenBytes(new Uint8Array([1])), '1'));
  t.is(store.journalLength(), 1);
  await restored.wake();
  t.true(restored.write(frozenBytes(new Uint8Array([2])), '2'));
  await restored.crash();
  t.deepEqual(batches.at(-1), [5, 6]);
});
