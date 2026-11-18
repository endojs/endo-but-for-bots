// @ts-check

/**
 * The cadence snapshot of an awake worker. Once `snapshotEveryDeliveries`
 * deliveries have accrued since the last snapshot, one is due; it waits until
 * the transport has had nothing queued for `CADENCE_IDLE_MS`, so it lands
 * between turns instead of between one turn's deliveries, and is taken at
 * once only when `CADENCE_FORCE_FACTOR` cadences have accrued.
 */
import test from '@endo/ses-ava/test.js';

import { decodeBase64 } from '@endo/base64';
import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';

import {
  CADENCE_FORCE_FACTOR,
  CADENCE_IDLE_MS,
  makeDurableWorkerTransport,
} from '../src/core/durable-worker-transport.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeMemoryStore } from '../src/store/store-memory.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { PromiseKit } from '@endo/promise-kit' */

const nodePowers = makeNodePowers();
const workerId = 'c'.repeat(32);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/** @param {number} i */
const frame = i => textEncoder.encode(`frame ${i}`);

/** Timers that fire only when told to. */
const makeManualTimers = () => {
  /** @type {Array<{ callback: () => void, delayMs: number }>} */
  let armed = [];
  return {
    timers: harden({
      now: () => 0,
      monotonicNow: () => 0,
      /**
       * @param {() => void} callback
       * @param {number} delayMs
       */
      setTimer: (callback, delayMs) => {
        const timer = { callback, delayMs };
        armed.push(timer);
        return timer;
      },
      /** @param {unknown} handle */
      clearTimer: handle => {
        armed = armed.filter(timer => timer !== handle);
      },
    }),
    delays: () => armed.map(({ delayMs }) => delayMs),
    /** Fire the one armed timer. */
    fire: () => {
      const [timer, ...rest] = armed;
      if (timer === undefined || rest.length > 0) {
        throw Error(`expected one armed timer, found ${armed.length}`);
      }
      armed = [];
      timer.callback();
    },
  };
};

/**
 * A snapshotting engine that records each incarnation's deliveries, and
 * whose delivery of a frame can be held in flight.
 */
const makeEngine = () => {
  const log = {
    /** @type {Array<{ from: unknown, delivered: string[] }>} */
    incarnations: [],
    /** @type {string[]} */
    snapshots: [],
  };
  /** @type {Map<string, PromiseKit<void>>} */
  const holds = new Map();
  const engine = harden({
    canSnapshot: true,
    /** @param {{ snapshot: unknown }} options */
    start: async ({ snapshot }) => {
      const incarnation = {
        from: snapshot,
        delivered: /** @type {string[]} */ ([]),
      };
      log.incarnations.push(incarnation);
      return harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t !== 'f') return;
          const text = textDecoder.decode(decodeBase64(message.b64));
          const hold = holds.get(text);
          if (hold !== undefined) await hold.promise;
          incarnation.delivered.push(text);
        },
        snapshot: async () => {
          const ref = `snapshot-${log.snapshots.length + 1}`;
          log.snapshots.push(ref);
          return ref;
        },
        terminate: async () => {},
      });
    },
    releaseSnapshot: async () => {},
  });
  /** @param {number} i hold the delivery of frame `i` until released */
  const hold = i => {
    /** @type {PromiseKit<void>} */
    const kit = makePromiseKit();
    holds.set(`frame ${i}`, kit);
    return () => kit.resolve();
  };
  return { engine, log, hold };
};

/**
 * @param {ExecutionContext} t
 * @param {number} snapshotEveryDeliveries
 */
const makeKit = (t, snapshotEveryDeliveries) => {
  t.timeout(10_000);
  const store = makeMemoryStore().provideWorkerStore(workerId);
  const clock = makeManualTimers();
  const { engine, log, hold } = makeEngine();
  /** @type {string[]} */
  const errors = [];
  const transport = makeDurableWorkerTransport(
    {
      timers: clock.timers,
      logging: {
        ...nodePowers.logging,
        error: (...args) => errors.push(args.map(String).join(' ')),
      },
    },
    { workerId, store, engine, snapshotEveryDeliveries, onFrame: () => {} },
  );
  // The engine settles in microtasks: one turn of the event loop drains
  // every operation already queued.
  const settle = () => new Promise(resolve => setImmediate(resolve));
  /**
   * Write frames `from` up to but not including `to`, each delivered before
   * the next is written.
   *
   * @param {number} from
   * @param {number} to
   */
  const writeEach = async (from, to) => {
    for (let i = from; i < to; i += 1) {
      transport.write(frame(i));
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }
  };
  return { store, clock, log, hold, transport, settle, writeEach, errors };
};

test('a due cadence snapshot waits while the worker is busy, then is taken once it has been idle', async t => {
  const { store, clock, log, transport, settle, writeEach } = makeKit(t, 4);
  await writeEach(0, 3);
  t.deepEqual(clock.delays(), [], 'not due before the cadence');
  await writeEach(3, 4);
  t.deepEqual(log.snapshots, [], 'due, but not taken between deliveries');
  t.deepEqual(clock.delays(), [CADENCE_IDLE_MS], 'waiting for quiet');

  // Busy: each further frame restarts the wait.
  await writeEach(4, 7);
  t.deepEqual(log.snapshots, []);
  t.deepEqual(clock.delays(), [CADENCE_IDLE_MS], 'one wait, not one per frame');

  clock.fire();
  await settle();
  t.deepEqual(log.snapshots, ['snapshot-1'], 'one snapshot after the quiet');
  t.deepEqual(store.getMeta().snapshot, { ref: 'snapshot-1', cut: 7 });
  t.is(store.readJournal().length, 0, 'the journal is truncated to the cut');
  t.true(transport.isAwake(), 'a cadence snapshot leaves the worker awake');
  t.deepEqual(clock.delays(), [], 'nothing more is due');
});

test('a snapshot that falls due while a delivery is in flight is taken when the queue empties', async t => {
  const { store, clock, log, hold, transport, settle, writeEach } = makeKit(
    t,
    4,
  );
  await writeEach(0, 3);
  const release = hold(3);
  transport.write(frame(3));
  transport.write(frame(4));
  await settle();
  t.deepEqual(clock.delays(), [], 'no wait while a delivery is in flight');
  release();
  await settle();
  t.deepEqual(log.snapshots, []);
  t.deepEqual(clock.delays(), [CADENCE_IDLE_MS], 'the due snapshot was kept');
  clock.fire();
  await settle();
  t.deepEqual(store.getMeta().snapshot, { ref: 'snapshot-1', cut: 5 });
});

test('a worker that is never idle snapshots at the forced limit', async t => {
  const cadence = 2;
  const forced = CADENCE_FORCE_FACTOR * cadence;
  const { store, clock, log, writeEach } = makeKit(t, cadence);
  // The wait is cleared by each frame and never fires.
  await writeEach(0, forced - 1);
  t.deepEqual(log.snapshots, [], 'deferred while frames keep coming');
  await writeEach(forced - 1, forced);
  t.deepEqual(log.snapshots, ['snapshot-1'], 'taken at the forced limit');
  t.is(store.getMeta().snapshot?.cut, forced);
  t.deepEqual(clock.delays(), [], 'nothing more is due');
  await writeEach(forced, 2 * forced);
  t.deepEqual(log.snapshots, ['snapshot-1', 'snapshot-2']);
  t.is(store.getMeta().snapshot?.cut, 2 * forced);
});

test('a crash between a snapshot falling due and being taken replays the whole suffix', async t => {
  const { store, clock, log, transport, settle, writeEach } = makeKit(t, 4);
  await writeEach(0, 5);
  t.deepEqual(clock.delays(), [CADENCE_IDLE_MS]);
  await transport.crash();
  t.deepEqual(clock.delays(), [], 'the wait ends with the incarnation');
  t.deepEqual(log.snapshots, []);
  t.is(store.getMeta().snapshot, undefined);

  await writeEach(5, 6);
  t.is(log.incarnations.length, 2);
  t.deepEqual(
    log.incarnations[1],
    {
      from: null,
      delivered: [0, 1, 2, 3, 4, 5].map(i => `frame ${i}`),
    },
    'the new incarnation replays every frame since the last snapshot, in order',
  );
  t.deepEqual(clock.delays(), [CADENCE_IDLE_MS], 'still due after the wake');
  clock.fire();
  await settle();
  t.deepEqual(store.getMeta().snapshot, { ref: 'snapshot-1', cut: 6 });
});

test('a sleep while a snapshot is deferred takes its own snapshot, once', async t => {
  const { store, clock, log, transport, settle, writeEach } = makeKit(t, 4);
  await writeEach(0, 5);
  t.deepEqual(clock.delays(), [CADENCE_IDLE_MS]);
  await transport.sleep();
  await settle();
  t.false(transport.isAwake());
  t.deepEqual(log.snapshots, ['snapshot-1'], 'the sleep snapshot, no other');
  t.deepEqual(store.getMeta().snapshot, { ref: 'snapshot-1', cut: 5 });
  t.deepEqual(clock.delays(), [], 'nothing is left armed');

  await writeEach(5, 6);
  t.deepEqual(
    log.incarnations[1],
    { from: 'snapshot-1', delivered: ['frame 5'] },
    'the wake replays only past the cut',
  );
});

test('retirement while a snapshot is deferred takes none', async t => {
  const { clock, log, transport, settle, writeEach } = makeKit(t, 4);
  await writeEach(0, 5);
  t.deepEqual(clock.delays(), [CADENCE_IDLE_MS]);
  await transport.retire();
  await settle();
  t.deepEqual(clock.delays(), []);
  t.deepEqual(log.snapshots, []);
});
