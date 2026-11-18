// @ts-check

/**
 * A delivery that fails without a deterministic halt drops the incarnation,
 * and the next frame wakes a fresh one that replays the journal suffix. That
 * retry is right for a one-off crash. A worker that crashes the same way on
 * every attempt made every later frame wake it, replay up to the crash, and
 * crash again, with no end: a crash loop that runs for as long as frames
 * keep arriving.
 *
 * With a bound, the transport counts crashes that make no progress, waits
 * before each retry, retries by itself, and turns the run into the same
 * inspectable failure a halt records. Only a crash is counted: a failure of
 * the host's is not the worker's to answer for.
 */
import test from '@endo/ses-ava/test.js';

import { decodeBase64, encodeBase64 } from '@endo/base64';
import harden from '@endo/harden';

import { makeDurableWorkerTransport } from '../src/core/durable-worker-transport.js';
import { WorkerCrashError } from '../src/core/worker-crash-error.js';
import { WorkerHaltError } from '../src/core/worker-engine.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeMemoryStore } from '../src/store/store-memory.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { WorkerStore } from '../src/store/store.js' */

const nodePowers = makeNodePowers();
const workerId = 'e'.repeat(32);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/** @param {string} text */
const frame = text => textEncoder.encode(text);
/** @param {any} message */
const textOf = message => textDecoder.decode(decodeBase64(message.b64));

const crashed = () =>
  new WorkerCrashError('Ironhorse worker exited (signaled)');

/**
 * Timers that fire only when told to, so a test decides when a retry is due
 * and can read the delay it was armed with.
 */
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
 * An engine whose incarnations fail the delivery of named frames, each a
 * given number of times (Infinity: on every attempt), with the error
 * `failWith` makes.
 *
 * @param {Record<string, number>} failures
 * @param {() => Error} [failWith]
 */
const makeFlakyEngine = (failures, failWith = crashed) => {
  const remaining = new Map(Object.entries(failures));
  const log = { starts: 0, failed: 0, delivered: /** @type {string[]} */ ([]) };
  const engine = harden({
    canSnapshot: false,
    start: async () => {
      log.starts += 1;
      return harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t !== 'f') return;
          const text = textOf(message);
          const left = remaining.get(text) ?? 0;
          if (left > 0) {
            remaining.set(text, left - 1);
            log.failed += 1;
            throw failWith();
          }
          log.delivered.push(text);
        },
        snapshot: async () => {
          throw Error('this engine does not snapshot');
        },
        terminate: async () => {},
      });
    },
  });
  return { engine, log };
};

/**
 * @param {ExecutionContext} t
 * @param {any} engine
 * @param {object} [options]
 * @param {boolean} [options.bounded] whether crashes are counted
 * @param {number} [options.crashRetryDelayMs]
 * @param {WorkerStore} [options.store]
 * @param {(frames: unknown[]) => void} [options.onFrames]
 * @param {number} [options.snapshotEveryDeliveries]
 */
const makeKit = (
  t,
  engine,
  {
    bounded = true,
    crashRetryDelayMs = 100,
    store = makeMemoryStore().provideWorkerStore(workerId),
    onFrames = undefined,
    snapshotEveryDeliveries = undefined,
  } = {},
) => {
  // Every test here waits on the serial queue whose wedging it guards.
  t.timeout(10_000);
  const errors = /** @type {string[]} */ ([]);
  const clock = makeManualTimers();
  let fatal = 0;
  const transport = makeDurableWorkerTransport(
    {
      timers: clock.timers,
      logging: {
        ...nodePowers.logging,
        error: (...args) => errors.push(args.map(String).join(' ')),
      },
    },
    {
      workerId,
      store,
      engine,
      maxDeliveryAttempts: bounded ? 3 : undefined,
      crashRetryDelayMs,
      snapshotEveryDeliveries,
      onFrame: () => {},
      onFrames,
      onFatal: () => {
        fatal += 1;
      },
    },
  );
  // The engines here settle in microtasks, so one turn of the event loop
  // drains every operation already queued without queuing another.
  const settle = () => new Promise(resolve => setImmediate(resolve));
  /** Fire the armed retry and let it run. */
  const retry = async () => {
    clock.fire();
    await settle();
  };
  return { store, transport, settle, retry, clock, errors, fatal: () => fatal };
};

test('a worker that crashes on every attempt is retried by itself, then quarantined at the bound', async t => {
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const { store, transport, settle, retry, clock, errors, fatal } = makeKit(
    t,
    engine,
  );
  t.true(transport.write(frame('a')));
  t.true(transport.write(frame('poison')));
  await settle();
  t.is(log.failed, 1);
  t.deepEqual(store.getMeta().crash, {
    index: 1,
    attempts: 1,
    reason: 'Ironhorse worker exited (signaled)',
  });
  t.deepEqual(clock.delays(), [100], 'the first retry waits the base delay');

  await retry();
  t.is(log.failed, 2);
  t.is(store.getMeta().crash?.attempts, 2);
  t.deepEqual(clock.delays(), [200], 'each crash doubles the wait');

  await retry();
  t.is(log.failed, 3, 'the poisoned frame was attempted exactly three times');
  t.is(
    store.getMeta().failure,
    'crashed 3 times without progress, last while replaying journal frame 1: Ironhorse worker exited (signaled)',
  );
  t.is(store.getMeta().crash, undefined, 'the failure replaces the count');
  t.is(fatal(), 1, 'the logical session is retired once');
  t.deepEqual(clock.delays(), [], 'no retry is owed to a quarantined worker');
  t.true(errors.some(line => /quarantined/.test(line)));
  t.false(transport.write(frame('f')), 'a quarantined worker refuses frames');
  await t.throwsAsync(() => transport.wake(), { instanceOf: WorkerHaltError });
});

test('a crash that clears before the bound is retried, delivered and forgotten', async t => {
  const { engine, log } = makeFlakyEngine({ poison: 2 });
  const { store, transport, settle, retry, clock, fatal } = makeKit(t, engine);
  for (const text of ['a', 'poison']) transport.write(frame(text));
  await settle();
  await retry();
  t.is(log.failed, 2);
  t.is(store.getMeta().crash?.attempts, 2);
  await retry();
  t.deepEqual(log.delivered.slice(-2), ['a', 'poison']);
  t.is(store.getMeta().crash, undefined, 'a completed wake clears the count');
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0);
  t.deepEqual(clock.delays(), []);
  t.true(transport.isAwake());
  t.true(transport.write(frame('b')), 'the worker still accepts frames');
  await settle();
  t.is(log.delivered.at(-1), 'b');
});

test('a burst of frames behind a crash is one attempt, not one each', async t => {
  const { engine, log } = makeFlakyEngine({ poison: 1 });
  const { store, transport, settle, retry } = makeKit(t, engine);
  for (const text of ['poison', 'b', 'c', 'd']) {
    t.true(transport.write(frame(text)), 'frames queue in the journal');
  }
  await settle();
  t.is(log.starts, 1, 'the frames behind the crash did not wake the worker');
  t.is(store.getMeta().crash?.attempts, 1);
  await retry();
  t.deepEqual(log.delivered, ['poison', 'b', 'c', 'd']);
  t.is(store.getMeta().crash, undefined);
});

test('a wake while a retry is owed waits for that retry instead of making an attempt of its own', async t => {
  const { engine, log } = makeFlakyEngine({ poison: 2 });
  const { store, transport, settle, retry } = makeKit(t, engine);
  transport.write(frame('poison'));
  await settle();
  let settled = '';
  const note = (/** @type {string} */ how) => () => {
    settled = how;
  };
  // The retry crashes: so does the wake that waited on it, and once only.
  const refused = transport.wake();
  refused.then(note('woke'), note('crashed'));
  await settle();
  t.is(settled, '', 'the wake waits');
  t.is(log.starts, 1, 'and starts nothing');
  await retry();
  await t.throwsAsync(() => refused, { instanceOf: WorkerCrashError });
  t.is(
    store.getMeta().crash?.attempts,
    2,
    'the retry counted; the wake did not',
  );
  // The next retry succeeds: so does the wake that waited on it.
  const woken = transport.wake();
  await retry();
  await woken;
  t.is(log.starts, 3);
  t.true(transport.isAwake());
});

test('progress past a crash starts the count afresh', async t => {
  // Two crashes at one frame, a replay past it, then two at a later frame:
  // four crashes in all, but never three without progress.
  const { engine, log } = makeFlakyEngine({ first: 2, second: 2 });
  const { store, transport, settle, retry, fatal } = makeKit(t, engine);
  transport.write(frame('first'));
  await settle();
  await retry();
  await retry();
  t.is(store.getMeta().crash, undefined);
  transport.write(frame('second'));
  await settle();
  t.deepEqual(store.getMeta().crash, {
    index: 1,
    attempts: 1,
    reason: 'Ironhorse worker exited (signaled)',
  });
  await retry();
  await retry();
  t.is(log.failed, 4);
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0);
  t.deepEqual(log.delivered.slice(-2), ['first', 'second']);
});

test('a replay that gets past one crash and meets another has made progress', async t => {
  // The retry delivers the frame that crashed, then crashes on the next.
  const { engine } = makeFlakyEngine({ first: 1, second: 2 });
  const { store, transport, settle, retry } = makeKit(t, engine);
  transport.write(frame('first'));
  transport.write(frame('second'));
  await settle();
  t.like(store.getMeta().crash, { index: 0, attempts: 1 });
  await retry();
  t.like(store.getMeta().crash, { index: 1, attempts: 1 });
  await retry();
  t.like(store.getMeta().crash, { index: 1, attempts: 2 });
  await retry();
  t.is(store.getMeta().crash, undefined);
  t.is(store.getMeta().failure, undefined);
});

test('crashes that land on different frames of one replay still count together', async t => {
  // An asynchronous kill does not land on the same frame every time.
  let starts = 0;
  const engine = harden({
    canSnapshot: false,
    start: async () => {
      starts += 1;
      const victim = starts % 2 === 1 ? 'late' : 'early';
      return harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t === 'f' && textOf(message) === victim) throw crashed();
        },
        snapshot: async () => null,
        terminate: async () => {},
      });
    },
  });
  const { store, transport, settle, retry, fatal } = makeKit(t, engine);
  transport.write(frame('early'));
  transport.write(frame('late'));
  await settle();
  t.like(store.getMeta().crash, { index: 1, attempts: 1 });
  await retry();
  t.like(store.getMeta().crash, { index: 1, attempts: 2 });
  await retry();
  t.regex(String(store.getMeta().failure), /crashed 3 times without progress/);
  t.is(fatal(), 1);
});

test('an incarnation that crashes before it is ready is counted', async t => {
  let starts = 0;
  const engine = harden({
    canSnapshot: false,
    start: async () => {
      starts += 1;
      throw crashed();
    },
  });
  const { store, transport, settle, retry, fatal } = makeKit(t, engine);
  transport.write(frame('a'));
  await settle();
  await retry();
  await retry();
  t.is(starts, 3);
  t.is(
    store.getMeta().failure,
    'crashed 3 times without progress, last while starting: Ironhorse worker exited (signaled)',
  );
  t.is(fatal(), 1);
});

/** An engine whose incarnations crash while they are initialized. */
const makeInitCrashingEngine = () =>
  harden({
    canSnapshot: false,
    start: async () =>
      harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t === 'init') throw crashed();
        },
        snapshot: async () => null,
        terminate: async () => {},
      }),
  });

test('a crash during initialization is reported as one', async t => {
  const { store, transport, settle, retry, fatal } = makeKit(
    t,
    makeInitCrashingEngine(),
  );
  transport.write(frame('a'));
  await settle();
  t.like(store.getMeta().crash, { index: 0, attempts: 1 });
  await retry();
  const waiting = transport.wake();
  await retry();
  const error = await t.throwsAsync(() => waiting, {
    instanceOf: WorkerHaltError,
    message:
      'crashed 3 times without progress, last while initializing: Ironhorse worker exited (signaled)',
  });
  t.true(
    /** @type {Error} */ (error).cause instanceof WorkerCrashError,
    'the failure carries the crash that reached the bound',
  );
  t.is(fatal(), 1);
});

test('a crash with no frame waiting on the worker is not counted', async t => {
  // Nothing is owed a retry, so nothing could ever clear a count: a record
  // left behind would be held against the first frame to arrive, whenever.
  const { store, transport, clock, fatal } = makeKit(
    t,
    makeInitCrashingEngine(),
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => transport.wake(), {
      instanceOf: WorkerCrashError,
    });
  }
  t.is(store.getMeta().crash, undefined);
  t.is(store.getMeta().failure, undefined);
  t.deepEqual(clock.delays(), []);
  t.is(fatal(), 0);
});

test('a failure that is not a crash is the host’s, and is never counted', async t => {
  const { engine, log } = makeFlakyEngine({ unlucky: 10 }, () =>
    Error('ENOSPC: no space left on device'),
  );
  const { store, transport, settle, clock, fatal } = makeKit(t, engine);
  transport.write(frame('unlucky'));
  await settle();
  for (let attempt = 1; attempt < 10; attempt += 1) {
    transport.write(frame(`later ${attempt}`));
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  t.is(log.failed, 10, 'each later frame tries again, as it always has');
  t.is(store.getMeta().crash, undefined);
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0);
  t.deepEqual(clock.delays(), []);
  transport.write(frame('recovered'));
  await settle();
  t.is(log.delivered.at(-1), 'recovered');
});

test('a sink that refuses a frame does not quarantine the guest that emitted it', async t => {
  // The Ironhorse engine hands a delivery's outbound frames to the host
  // inside `deliver`, so a host that cannot store them fails the delivery.
  let disk = 'full';
  const engine = harden({
    canSnapshot: false,
    /** @param {any} options */
    start: async ({ onOutboundBatch }) =>
      harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t !== 'f') return;
          onOutboundBatch([{ t: 'f', b64: encodeBase64(frame('reply')) }]);
        },
        snapshot: async () => null,
        terminate: async () => {},
      }),
  });
  const { store, transport, settle, fatal } = makeKit(t, engine, {
    onFrames: () => {
      if (disk === 'full') throw Error('ENOSPC: no space left on device');
    },
  });
  for (const text of ['a', 'b', 'c', 'd']) {
    transport.write(frame(text));
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0);
  disk = 'freed';
  t.true(transport.write(frame('e')));
  await settle();
  t.true(transport.isAwake(), 'the worker recovers when the host does');
});

test('a restart resumes the count instead of forgetting it', async t => {
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const store = makeMemoryStore().provideWorkerStore(workerId);
  const first = makeKit(t, engine, { store });
  first.transport.write(frame('poison'));
  await first.settle();
  await first.retry();
  t.is(store.getMeta().crash?.attempts, 2);

  // The supervisor process dies and another starts: a fresh transport over
  // the same store, with nothing to tell the first one it is over.
  const second = makeKit(t, engine, { store });
  await t.throwsAsync(() => second.transport.wake(), {
    instanceOf: WorkerHaltError,
    message: /crashed 3 times without progress/,
  });
  t.is(log.failed, 3);
  t.is(second.fatal(), 1);
});

test('a host that stands down forgives the crash whose retry it cancels', async t => {
  // Stopping a supervisor signals its process group, which kills workers in
  // the middle of a request. That is not evidence the worker crashes.
  const { engine } = makeFlakyEngine({ poison: Infinity });
  const store = makeMemoryStore().provideWorkerStore(workerId);
  const first = makeKit(t, engine, { store });
  first.transport.write(frame('poison'));
  await first.settle();
  t.is(store.getMeta().crash?.attempts, 1);
  first.transport.standDown();
  t.is(store.getMeta().crash, undefined, 'the one crash is forgiven');
  t.deepEqual(first.clock.delays(), []);

  const second = makeKit(t, engine, { store });
  second.transport.write(frame('later'));
  await second.settle();
  await second.retry();
  t.is(store.getMeta().crash?.attempts, 2);
  second.transport.end();
  t.is(store.getMeta().crash?.attempts, 1, 'closing forgives only the last');
  t.deepEqual(second.clock.delays(), [], 'a closed transport owes no retry');

  // A worker that does crash every time is still given up on: its retries
  // run, and are counted, whenever the host stays up for them.
  const third = makeKit(t, engine, { store });
  await t.throwsAsync(() => third.transport.wake(), {
    instanceOf: WorkerCrashError,
  });
  await third.retry();
  t.regex(String(store.getMeta().failure), /^crashed 3 times/);
});

test('retirement cancels the retry a crash armed', async t => {
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const { transport, settle, clock } = makeKit(t, engine);
  transport.write(frame('poison'));
  await settle();
  t.deepEqual(clock.delays(), [100]);
  await transport.retire();
  t.deepEqual(clock.delays(), []);
  t.is(log.starts, 1);
});

test('crash indices are absolute across a snapshot that truncates the journal', async t => {
  const delivered = /** @type {string[]} */ ([]);
  const engine = harden({
    canSnapshot: true,
    start: async () =>
      harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t !== 'f') return;
          if (textOf(message) === 'poison') throw crashed();
          delivered.push(textOf(message));
        },
        snapshot: async () => 'image',
        terminate: async () => {},
      }),
  });
  const { store, transport, settle, retry } = makeKit(t, engine);
  for (const text of ['a', 'b']) transport.write(frame(text));
  await transport.sleep();
  t.is(store.getMeta().snapshot?.cut, 2);
  transport.write(frame('poison'));
  await settle();
  t.like(store.getMeta().crash, { index: 2, attempts: 1 });
  await retry();
  await retry();
  t.regex(
    String(store.getMeta().failure),
    /last while replaying journal frame 2:/,
  );
  t.deepEqual(delivered, ['a', 'b'], 'frames under the snapshot do not replay');
});

test('without a bound, crashes are not counted and every later frame tries again', async t => {
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const { store, transport, settle, clock } = makeKit(t, engine, {
    bounded: false,
  });
  transport.write(frame('poison'));
  await settle();
  for (const text of ['b', 'c', 'd', 'e']) {
    transport.write(frame(text));
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  t.is(log.failed, 5, 'each later frame replays the poisoned one');
  t.is(store.getMeta().crash, undefined);
  t.is(store.getMeta().failure, undefined);
  t.deepEqual(clock.delays(), []);
});

test('a cadence snapshot that fails is attempted again a cadence later, not after every frame', async t => {
  let snapshots = 0;
  let deliveries = 0;
  const engine = harden({
    canSnapshot: true,
    start: async () =>
      harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t === 'f') deliveries += 1;
        },
        snapshot: async () => {
          snapshots += 1;
          throw Error('ENOSPC: no space left on device');
        },
        terminate: async () => {},
      }),
  });
  const { store, transport, settle, clock } = makeKit(t, engine, {
    snapshotEveryDeliveries: 4,
  });
  for (let index = 0; index < 40; index += 1) {
    transport.write(frame(`frame ${index}`));
    // eslint-disable-next-line no-await-in-loop
    await settle();
    // A due snapshot waits for quiet; each frame here is followed by it.
    if (clock.delays().length > 0) clock.fire();
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  t.is(snapshots, 10, 'one attempt per cadence of four deliveries');
  t.true(
    deliveries < 300,
    `a failed snapshot costs one replay, not one per frame (${deliveries} deliveries)`,
  );
  t.is(store.getMeta().failure, undefined, 'a failed snapshot is not a crash');
});

/**
 * An engine whose starts follow a script: an error to throw, or a function
 * that says whether a frame's delivery crashes.
 *
 * @param {Array<Error | ((text: string) => boolean)>} script one entry per
 *   start; the last repeats
 */
const makeScriptedEngine = script => {
  const log = { starts: 0, delivered: /** @type {string[]} */ ([]) };
  const engine = harden({
    canSnapshot: false,
    start: async () => {
      const step = script[Math.min(log.starts, script.length - 1)];
      log.starts += 1;
      if (step instanceof Error) throw step;
      return harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t !== 'f') return;
          if (step(textOf(message))) throw crashed();
          log.delivered.push(textOf(message));
        },
        snapshot: async () => null,
        terminate: async () => {},
      });
    },
  });
  return { engine, log };
};
const crashesOn =
  (/** @type {string} */ victim) => (/** @type {string} */ text) =>
    text === victim;
const healthy = () => false;

test('a retry that fails for a reason of the host’s stays owed, and is not counted', async t => {
  // Frames that arrived while the retry was owed left their delivery to it.
  // Were the retry dropped when the host could not start a process, nothing
  // would deliver them: a redelivery of a frame already journaled is a no-op.
  const { engine, log } = makeScriptedEngine([
    crashesOn('poison'),
    Error('EMFILE: too many open files'),
    Error('EMFILE: too many open files'),
    healthy,
  ]);
  const { store, transport, settle, retry, clock, errors, fatal } = makeKit(
    t,
    engine,
  );
  transport.write(frame('poison'), '1');
  transport.write(frame('b'), '2');
  transport.write(frame('c'), '3');
  await settle();
  t.deepEqual(clock.delays(), [100]);
  await retry();
  t.deepEqual(clock.delays(), [200], 'the retry is owed still, further off');
  t.true(errors.some(line => /retry after a crash failed.*EMFILE/.test(line)));
  await retry();
  t.deepEqual(clock.delays(), [400]);
  t.is(
    store.getMeta().crash?.attempts,
    1,
    'the host’s failures are not crashes',
  );
  await retry();
  t.deepEqual(log.delivered, ['poison', 'b', 'c']);
  t.is(store.getMeta().crash, undefined);
  t.is(fatal(), 0);
  t.deepEqual(clock.delays(), []);
});

test('the wait before a retry doubles to a ceiling of a minute', async t => {
  const { engine } = makeScriptedEngine([
    crashesOn('poison'),
    Error('EMFILE: too many open files'),
  ]);
  const { transport, settle, retry, clock } = makeKit(t, engine, {
    crashRetryDelayMs: 25_000,
  });
  transport.write(frame('poison'));
  await settle();
  const waits = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    waits.push(...clock.delays());
    // eslint-disable-next-line no-await-in-loop
    await retry();
  }
  t.deepEqual(waits, [25_000, 50_000, 60_000, 60_000]);
});

test('a halt met on a retry is recorded, reported, and ends the retries', async t => {
  let starts = 0;
  const engine = harden({
    canSnapshot: false,
    start: async () => {
      starts += 1;
      const first = starts === 1;
      return harden({
        /** @param {any} message */
        deliver: async message => {
          if (message.t !== 'f') return;
          if (first) throw crashed();
          throw new WorkerHaltError('guest crank halted: budget exhausted');
        },
        snapshot: async () => null,
        terminate: async () => {},
      });
    },
  });
  const { store, transport, settle, retry, clock, errors, fatal } = makeKit(
    t,
    engine,
  );
  transport.write(frame('a'));
  await settle();
  await retry();
  t.deepEqual(store.getMeta(), {
    failure: 'guest crank halted: budget exhausted',
  });
  t.is(fatal(), 1);
  t.deepEqual(clock.delays(), []);
  t.true(
    errors.some(line =>
      /retry after a crash failed.*budget exhausted/.test(line),
    ),
    'a session retired by a timer says why in the log',
  );
});

/**
 * A worker store whose metadata writes fail while `refuses` says so.
 *
 * @param {(meta: any) => boolean} refuses
 */
const makeRefusingStore = refuses => {
  const underlying = makeMemoryStore().provideWorkerStore(workerId);
  /** @type {WorkerStore} */
  const store = {
    ...underlying,
    setMeta: meta => {
      if (refuses(meta)) throw Error('ENOSPC: no space left on device');
      underlying.setMeta(meta);
    },
  };
  return store;
};

test('a count that cannot be written still owes the retry and still counts', async t => {
  let full = true;
  const store = makeRefusingStore(() => full);
  const { engine, log } = makeFlakyEngine({ poison: 2 });
  const { transport, settle, retry, clock, errors } = makeKit(t, engine, {
    store,
  });
  transport.write(frame('poison'));
  await settle();
  t.is(store.getMeta().crash, undefined, 'nothing reached the disk');
  t.deepEqual(clock.delays(), [100], 'the retry is owed all the same');
  t.true(errors.some(line => /crash count not recorded/.test(line)));
  t.true(
    errors.some(line => /delivery failed.*exited \(signaled\)/.test(line)),
    'the crash is reported as itself, not as the write that followed it',
  );
  await retry();
  full = false;
  await retry();
  t.is(log.failed, 2);
  t.deepEqual(log.delivered, ['poison']);
});

test('a failure that cannot be written does not retire the session, and is tried again', async t => {
  let full = false;
  const store = makeRefusingStore(meta => full && meta.failure !== undefined);
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const { transport, settle, retry, clock, errors, fatal } = makeKit(
    t,
    engine,
    {
      store,
    },
  );
  transport.write(frame('poison'));
  await settle();
  await retry();
  full = true;
  await retry();
  t.is(log.failed, 3);
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0, 'only a failure on record retires the session');
  t.false(
    errors.some(line => /quarantined/.test(line)),
    'and nothing claims a quarantine that did not happen',
  );
  t.is(clock.delays().length, 1, 'the retry is owed still');
  full = false;
  await retry();
  t.is(log.failed, 4, 'one more crash, not a fresh count of three');
  t.regex(String(store.getMeta().failure), /^crashed 4 times without progress/);
  t.is(fatal(), 1);
  t.deepEqual(clock.delays(), []);
});

test('a store that cannot be read while a retry fails leaves the retry owed and a waiting wake answered', async t => {
  const underlying = makeMemoryStore().provideWorkerStore(workerId);
  let unreadable = false;
  /** @type {WorkerStore} */
  const store = {
    ...underlying,
    getMeta: () => {
      if (unreadable) throw Error('EIO: i/o error');
      return underlying.getMeta();
    },
  };
  const { engine, log } = makeFlakyEngine({ poison: 1 });
  const { transport, settle, retry, clock } = makeKit(t, engine, { store });
  transport.write(frame('poison'));
  await settle();
  const waiting = transport.wake();
  unreadable = true;
  await retry();
  await t.throwsAsync(
    () => waiting,
    { message: /EIO/ },
    'the wake is answered',
  );
  t.deepEqual(clock.delays(), [200], 'and the retry is owed still');
  unreadable = false;
  await retry();
  t.deepEqual(log.delivered, ['poison']);
});

test('standing down and closing do not throw when the store cannot be read', async t => {
  const underlying = makeMemoryStore().provideWorkerStore(workerId);
  let unreadable = false;
  /** @type {WorkerStore} */
  const store = {
    ...underlying,
    getMeta: () => {
      if (unreadable) throw Error('EIO: i/o error');
      return underlying.getMeta();
    },
  };
  const { engine } = makeFlakyEngine({ poison: Infinity });
  const { transport, settle, clock, errors } = makeKit(t, engine, { store });
  transport.write(frame('poison'));
  await settle();
  unreadable = true;
  t.notThrows(() => transport.standDown());
  t.notThrows(() => transport.end());
  t.deepEqual(clock.delays(), [], 'the retry is cancelled all the same');
  t.true(errors.some(line => /crash count not recorded/.test(line)));
});

test('once the host is standing down a crash is neither counted nor retried', async t => {
  // The stop that the host is obeying signals its workers too. A worker one
  // crash short of the bound must not be given up on for that.
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const store = makeMemoryStore().provideWorkerStore(workerId);
  store.appendJournal({ b64: encodeBase64(frame('poison')) });
  store.setMeta({ crash: { index: 0, attempts: 2, reason: 'earlier' } });
  const { transport, clock, fatal } = makeKit(t, engine, { store });
  transport.standDown();
  await t.throwsAsync(() => transport.wake(), { instanceOf: WorkerCrashError });
  t.is(log.failed, 1);
  t.deepEqual(store.getMeta().crash, {
    index: 0,
    attempts: 2,
    reason: 'earlier',
  });
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0);
  t.deepEqual(clock.delays(), []);
});

test('a halt raised by a start is passed on as it always was, not recorded', async t => {
  const engine = harden({
    canSnapshot: false,
    start: async () => {
      throw new WorkerHaltError('fatal while booting');
    },
  });
  const { store, transport, settle, fatal } = makeKit(t, engine);
  transport.write(frame('a'));
  await settle();
  await t.throwsAsync(() => transport.wake(), {
    instanceOf: WorkerHaltError,
    message: 'fatal while booting',
  });
  t.is(store.getMeta().failure, undefined);
  t.is(fatal(), 0);
});

test('a failure whose write landed and then threw retires the session at the next retry, and ends the retries', async t => {
  const underlying = makeMemoryStore().provideWorkerStore(workerId);
  let torn = true;
  /** @type {WorkerStore} */
  const store = {
    ...underlying,
    setMeta: meta => {
      underlying.setMeta(meta);
      if (torn && meta.failure !== undefined) {
        throw Error('EIO: directory not synced');
      }
    },
  };
  const { engine, log } = makeFlakyEngine({ poison: Infinity });
  const { transport, settle, retry, clock, fatal } = makeKit(t, engine, {
    store,
  });
  transport.write(frame('poison'));
  await settle();
  await retry();
  await retry();
  t.regex(String(store.getMeta().failure), /^crashed 3 times/);
  t.is(fatal(), 0, 'the write threw, so the session was left alone');
  t.is(clock.delays().length, 1);
  torn = false;
  await retry();
  t.is(fatal(), 1, 'the retry found the failure on record and retired it');
  t.is(log.failed, 3, 'without waking the worker again');
  t.deepEqual(clock.delays(), [], 'and nothing more is owed');
});
