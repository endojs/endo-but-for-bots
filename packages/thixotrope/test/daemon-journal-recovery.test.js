// @ts-check
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makeMemoryStore } from '../src/store/store-memory.js';
import { WorkerCrashError } from '../src/core/worker-crash-error.js';
import { WorkerHaltError } from '../src/core/worker-engine.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const nodePowers = makeNodePowers();

/** @import { WorkerEngine } from '../src/core/worker-engine.js' */

const makeNetlayer = () => ({
  location: {
    type: 'ocapn-peer',
    transport: 'test',
    designator: 'journal-recovery',
    hints: false,
  },
  shutdown() {},
});

test.serial(
  'startup resumes healthy journal work despite a newly quarantined worker',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const fatal = 'a'.repeat(32);
    const healthy = 'b'.repeat(32);
    const checkpointed = 'c'.repeat(32);
    const quarantined = 'd'.repeat(32);
    for (const id of [fatal, healthy, checkpointed, quarantined]) {
      const worker = store.provideWorkerStore(id);
      worker.setMeta({
        snapshot: { ref: id, cut: id === checkpointed ? 1 : 0 },
        ...(id === quarantined ? { failure: 'previous fatal guest halt' } : {}),
      });
      worker.appendJournal({ b64: 'AQID', hubSequence: '1' });
    }
    /** @type {unknown[]} */
    const started = [];
    /** @type {unknown[]} */
    const delivered = [];
    /** @type {WorkerEngine} */
    const engine = {
      canSnapshot: true,
      start: async ({ snapshot }) => {
        started.push(snapshot);
        return {
          deliver: async message => {
            if (snapshot === fatal) throw new WorkerHaltError('fatal replay');
            delivered.push(message);
          },
          snapshot: async () => snapshot,
          terminate: async () => {},
        };
      },
    };
    const daemon = await makeThixotropeDaemon(nodePowers, {
      store,
      codec: syrupCodec,
      engine,
      makeNetlayer,
    });
    t.teardown(() => daemon.shutdown());
    t.deepEqual(started.sort(), [fatal, healthy]);
    t.deepEqual(delivered, [{ t: 'f', b64: 'AQID' }]);
    t.is(store.provideWorkerStore(fatal).getMeta().failure, 'fatal replay');
    t.true(daemon.getWorker(healthy).isAwake());
    for (const id of [fatal, checkpointed, quarantined]) {
      t.false(daemon.getWorker(id).isAwake());
    }
    // Existing evidence is retained for inspection; startup must not retry it.
    t.is(
      store.provideWorkerStore(quarantined).getMeta().failure,
      'previous fatal guest halt',
    );
    t.is(store.provideWorkerStore(fatal).journalLength(), 1);
    await daemon.shutdown();
    started.length = 0;
    const restored = await makeThixotropeDaemon(nodePowers, {
      store,
      codec: syrupCodec,
      engine,
      makeNetlayer,
    });
    t.teardown(() => restored.shutdown());
    t.deepEqual(
      started,
      [],
      'successful replay checkpointed; both quarantines stay asleep',
    );
  },
);

test.serial(
  'startup still rejects an infrastructure replay failure without quarantine',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const id = 'f'.repeat(32);
    const worker = store.provideWorkerStore(id);
    worker.setMeta({ snapshot: { ref: 'existing-image', cut: 0 } });
    worker.appendJournal({ b64: 'AQID', hubSequence: '1' });
    let terminated = false;
    /** @type {WorkerEngine} */
    const engine = {
      canSnapshot: true,
      start: async () => ({
        deliver: async () => {
          throw Error('injected engine I/O failure');
        },
        snapshot: async () => 'existing-image',
        terminate: async () => {
          terminated = true;
        },
      }),
    };
    await t.throwsAsync(
      () =>
        makeThixotropeDaemon(nodePowers, {
          store,
          codec: syrupCodec,
          engine,
          makeNetlayer,
        }),
      {
        message: /injected engine I\/O failure/,
      },
    );
    t.true(terminated);
    t.is(worker.getMeta().failure, undefined);
    t.is(
      worker.journalLength(),
      1,
      'accepted dispatch remains available for recovery',
    );
  },
);

test.serial(
  'startup rejects a failed fatal-retirement commit after quarantine metadata persists',
  async t => {
    t.timeout(10_000);
    const underlying = makeMemoryStore();
    const id = '9'.repeat(32);
    const worker = underlying.provideWorkerStore(id);
    worker.setMeta({ snapshot: { ref: 'fatal-image', cut: 0 } });
    worker.appendJournal({ b64: 'AQID', hubSequence: '1' });
    let refusedRetirement = false;
    const store = {
      ...underlying,
      setHubState: state => {
        if (state.sessions[id]?.retired) {
          refusedRetirement = true;
          throw Error('injected retirement storage failure');
        }
        underlying.setHubState(state);
      },
    };
    /** @type {WorkerEngine} */
    const engine = {
      canSnapshot: true,
      start: async () => ({
        deliver: async () => {
          throw new WorkerHaltError('fatal replay before retirement');
        },
        snapshot: async () => 'fatal-image',
        terminate: async () => {},
      }),
    };
    await t.throwsAsync(
      () =>
        makeThixotropeDaemon(nodePowers, {
          store,
          codec: syrupCodec,
          engine,
          makeNetlayer,
        }),
      {
        message: /injected retirement storage failure/,
      },
    );
    t.true(refusedRetirement, 'fault reached the hub retirement commit');
    t.is(worker.getMeta().failure, 'fatal replay before retirement');
    t.false(Boolean(underlying.getHubState().sessions[id].retired));
    t.is(worker.journalLength(), 1);
  },
);

/**
 * An engine whose incarnations of one image follow a script, one entry per
 * start with the last repeating: crash on delivery, fail to start as the
 * host's fault would have it, or deliver.
 *
 * @param {string} scripted the snapshot ref of the worker the script is for
 * @param {Array<'crash' | 'host' | 'deliver'>} script
 */
const makeScriptedEngine = (scripted, script) => {
  /** @type {unknown[]} */
  const started = [];
  /** @type {WorkerEngine} */
  const engine = {
    canSnapshot: true,
    start: async ({ snapshot }) => {
      const turn = started.filter(ref => ref === scripted).length;
      started.push(snapshot);
      const step =
        snapshot === scripted
          ? script[Math.min(turn, script.length - 1)]
          : 'deliver';
      if (step === 'host') throw Error('EMFILE: too many open files');
      return {
        deliver: async () => {
          if (step === 'crash') {
            throw new WorkerCrashError('injected worker exit');
          }
        },
        snapshot: async () => snapshot,
        terminate: async () => {},
      };
    },
  };
  return { engine, started };
};

/**
 * @param {ReturnType<typeof makeMemoryStore>} store
 * @param {string[]} ids
 */
const seedWorkers = (store, ids) => {
  for (const id of ids) {
    const worker = store.provideWorkerStore(id);
    worker.setMeta({ snapshot: { ref: id, cut: 0 } });
    worker.appendJournal({ b64: 'AQID', hubSequence: '1' });
  }
};

test.serial(
  'startup retries a worker that crashes during its replay, to the bound, and starts the rest',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const crashing = 'a'.repeat(32);
    const healthy = 'b'.repeat(32);
    seedWorkers(store, [crashing, healthy]);
    const { engine, started } = makeScriptedEngine(crashing, ['crash']);
    const daemon = await makeThixotropeDaemon(nodePowers, {
      store,
      codec: syrupCodec,
      engine,
      makeNetlayer,
      maxDeliveryAttempts: 3,
      crashRetryDelayMs: 20,
    });
    t.teardown(() => daemon.shutdown());
    // Whoever is handed the daemon finds each worker awake or given up on,
    // never still deciding.
    const worker = store.provideWorkerStore(crashing);
    t.is(
      worker.getMeta().failure,
      'crashed 3 times without progress, last while replaying journal frame 0: injected worker exit',
    );
    t.is(started.filter(ref => ref === crashing).length, 3);
    t.false(daemon.getWorker(crashing).isAwake());
    t.true(Boolean(store.getHubState().sessions[crashing].retired));
    t.is(worker.journalLength(), 1, 'the evidence is retained for inspection');
    t.true(
      daemon.getWorker(healthy).isAwake(),
      'one worker given up on does not stop the rest',
    );
  },
);

test.serial(
  'startup wakes a worker whose crash during its replay does not repeat',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const flaky = 'c'.repeat(32);
    seedWorkers(store, [flaky]);
    const { engine, started } = makeScriptedEngine(flaky, ['crash', 'deliver']);
    const daemon = await makeThixotropeDaemon(nodePowers, {
      store,
      codec: syrupCodec,
      engine,
      makeNetlayer,
      maxDeliveryAttempts: 3,
      crashRetryDelayMs: 20,
    });
    t.teardown(() => daemon.shutdown());
    t.deepEqual(started, [flaky, flaky]);
    t.true(daemon.getWorker(flaky).isAwake());
    const meta = store.provideWorkerStore(flaky).getMeta();
    t.is(meta.failure, undefined);
    t.is(meta.crash, undefined, 'the replay that completed cleared the count');
  },
);

test.serial(
  'startup gives up on a worker whose crashes before the restart already reached the bound',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const crashing = 'd'.repeat(32);
    seedWorkers(store, [crashing]);
    const worker = store.provideWorkerStore(crashing);
    worker.setMeta({
      ...worker.getMeta(),
      crash: { index: 0, attempts: 2, reason: 'injected worker exit' },
    });
    const { engine, started } = makeScriptedEngine(crashing, ['crash']);
    const daemon = await makeThixotropeDaemon(nodePowers, {
      store,
      codec: syrupCodec,
      engine,
      makeNetlayer,
      maxDeliveryAttempts: 3,
    });
    t.teardown(() => daemon.shutdown());
    t.deepEqual(started, [crashing], 'the third attempt was the last');
    t.regex(
      String(worker.getMeta().failure),
      /^crashed 3 times without progress/,
    );
    t.is(worker.getMeta().crash, undefined);
  },
);

for (const [title, script, starts] of /** @type {const} */ ([
  ['on the first attempt', ['host'], 1],
  ['on the retry of a crash', ['crash', 'host'], 2],
])) {
  test.serial(
    `with a bound, startup still rejects a failure of the host’s ${title}`,
    async t => {
      t.timeout(10_000);
      const store = makeMemoryStore();
      const unlucky = '5'.repeat(32);
      seedWorkers(store, [unlucky]);
      const { engine, started } = makeScriptedEngine(unlucky, [...script]);
      await t.throwsAsync(
        () =>
          makeThixotropeDaemon(nodePowers, {
            store,
            codec: syrupCodec,
            engine,
            makeNetlayer,
            maxDeliveryAttempts: 3,
            crashRetryDelayMs: 20,
          }),
        { message: /EMFILE/ },
      );
      t.is(started.length, starts);
      const worker = store.provideWorkerStore(unlucky);
      t.is(worker.getMeta().failure, undefined, 'the vat is not given up on');
      t.is(worker.journalLength(), 1, 'and its dispatch is kept for next time');
      // Startup stood every transport down as it failed, so nothing retries
      // after the store's lease is released.
      await new Promise(resolve => setTimeout(resolve, 100));
      t.is(started.length, starts);
    },
  );
}

test.serial(
  'without a bound, a crash during startup replay still rejects startup',
  async t => {
    t.timeout(10_000);
    const store = makeMemoryStore();
    const crashing = '7'.repeat(32);
    seedWorkers(store, [crashing]);
    const { engine } = makeScriptedEngine(crashing, ['crash']);
    await t.throwsAsync(
      () =>
        makeThixotropeDaemon(nodePowers, {
          store,
          codec: syrupCodec,
          engine,
          makeNetlayer,
        }),
      { instanceOf: WorkerCrashError, message: 'injected worker exit' },
    );
    const worker = store.provideWorkerStore(crashing);
    t.is(worker.getMeta().failure, undefined);
    t.is(worker.getMeta().crash, undefined);
  },
);
