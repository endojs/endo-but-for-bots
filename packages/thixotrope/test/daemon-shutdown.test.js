// @ts-check
import test from '@endo/ses-ava/test.js';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeThixotropeDaemon } from '../src/daemon.js';
import { makePeerJournalReplayEngine } from '../src/peer-replay-engine.js';
import { makeMemoryStore } from '../src/store-fs.js';

test.serial(
  'failed sleep drains other workers before releasing ownership',
  async t => {
    t.timeout(5000);
    const raw = makePeerJournalReplayEngine();
    let releaseSlow = () => {};
    const slowGate = new Promise(resolve => {
      releaseSlow = () => resolve(undefined);
    });
    let sawSlow = () => {};
    const slowStarted = new Promise(resolve => {
      sawSlow = () => resolve(undefined);
    });
    let released = false;
    let networkStopped = false;
    const events = [];
    let starts = 0;
    const daemon = await makeThixotropeDaemon({
      store: makeMemoryStore(),
      codec: syrupCodec,
      engine: {
        ...raw,
        canSnapshot: true,
        acquireStore: async () => async () => {
          released = true;
          events.push('released');
        },
        start: async options => {
          starts += 1;
          const id = starts;
          const worker = await raw.start(options);
          return {
            ...worker,
            snapshot: async () => {
              throw Error('injected snapshot failure');
            },
            terminate: async () => {
              if (id === 2) {
                sawSlow();
                await slowGate;
              }
              await worker.terminate();
              events.push(`terminated ${id}`);
            },
          };
        },
      },
      makeNetlayer: () => ({
        location: {
          type: 'ocapn-peer',
          transport: 'test',
          designator: 'shutdown',
          hints: false,
        },
        shutdown: () => {
          networkStopped = true;
        },
      }),
    });
    t.teardown(async () => {
      releaseSlow();
      await daemon.crash().catch(() => {});
    });
    const first = await daemon.createWorker();
    const second = await daemon.createWorker();
    t.is(await first.evaluate('1'), 1);
    t.is(await second.evaluate('2'), 2);
    const closing = daemon.shutdown();
    const rejected = t.throwsAsync(() => closing, {
      message: /injected snapshot failure/,
    });
    await slowStarted;
    t.false(released, 'slow worker still owns a live incarnation');
    t.is(
      daemon.crash(),
      closing,
      'concurrent callers wait for the same cleanup',
    );
    releaseSlow();
    await rejected;
    t.true(networkStopped);
    t.deepEqual(events, ['terminated 1', 'terminated 2', 'released']);
    await t.throwsAsync(() => second.wake(), { message: /closed/ });
    t.is(starts, 2, 'closed transports cannot launch another incarnation');
  },
);
