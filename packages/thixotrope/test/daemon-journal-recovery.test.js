// @ts-check
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';

import { makeThixotropeDaemon } from '../src/daemon.js';
import { makeMemoryStore } from '../src/store-memory.js';
import { WorkerHaltError } from '../src/worker-engine.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

/** @import { WorkerEngine } from '../src/worker-engine.js' */

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
