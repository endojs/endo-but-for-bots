// @ts-check
import { E } from '@endo/far';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import process from 'node:process';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeMemoryStore } from '../src/store/store-memory.js';

test.serial(
  'native adapters run in fresh processes and retire without replay',
  async t => {
    t.timeout(30_000);
    const powers = makeNodePowers();
    const daemon = await makeThixotropeDaemon(powers, {
      store: makeMemoryStore(),
      engine: makePeerJournalReplayEngine(powers),
      nativeWorkers: powers.nativeWorkers,
      codec: syrupCodec,
      makeNetlayer: ({ handlers, logger }) =>
        makeTcpNetLayer({ handlers, logger }),
    });
    t.teardown(() => daemon.shutdown());
    const launcher = daemon.makeResource('native-adapter', {
      moduleUrl: new URL('./fixtures/native-resource.js', import.meta.url).href,
    });
    const incarnation = await E(launcher).create();
    const root = await E(incarnation).getRoot();
    const pid = await E(root).pid();
    t.not(pid, process.pid);
    t.is(await E(root).echo('ready'), 'ready');
    await t.throwsAsync(() => E(root).exit());
    await t.throwsAsync(() => E(root).echo('retired'));
    const replacement = await E(launcher).create();
    const nextRoot = await E(replacement).getRoot();
    t.not(await E(nextRoot).pid(), pid);
    t.is(await E(nextRoot).echo('new incarnation'), 'new incarnation');
    await E(replacement).retire();
    await t.throwsAsync(() => E(nextRoot).echo('retired'));
  },
);

test.serial('native shutdown closes a process awaiting its root', async t => {
  t.timeout(5000);
  const { makeNativeAdapters } = await import('../src/native/adapters.js');
  let reportExit;
  let resolveClosed;
  let rejectRoot;
  let rootRequested;
  const requested = new Promise(resolve => {
    rootRequested = resolve;
  });
  const closed = new Promise(resolve => {
    resolveClosed = resolve;
  });
  let terminated = false;
  const adapters = makeNativeAdapters(
    {
      random: makeNodePowers().random,
      nativeWorkers: {
        start: async ({ onExit }) => {
          reportExit = onExit;
          return {
            send() {},
            closed,
            terminate: async () => {
              terminated = true;
              reportExit();
              resolveClosed();
            },
          };
        },
      },
    },
    {
      hub: {
        attachSession: () => ({ deliver() {} }),
        forgetSession: () => rejectRoot?.(Error('Root retired')),
      },
      importBootstrap: () => ({
        fetch: () => {
          rootRequested();
          return new Promise((_resolve, reject) => {
            rejectRoot = reject;
          });
        },
      }),
    },
  );
  t.teardown(() => adapters.shutdown());
  const creating = adapters.resource({ moduleUrl: 'fixture' }).create();
  const rejected = t.throwsAsync(() => creating, { message: /Root retired/ });
  await requested;
  await adapters.shutdown();
  await rejected;
  t.true(terminated);
});

test.serial('failed native startup reports exit before rejecting', async t => {
  t.timeout(10_000);
  let exited = false;
  await t.throwsAsync(
    () =>
      makeNodePowers().nativeWorkers.start({
        id: 'failed-start',
        moduleUrl: new URL(
          './fixtures/absent-native-module.js',
          import.meta.url,
        ).href,
        onFrame() {},
        onExit: () => {
          exited = true;
          throw Error('Exit callback failed');
        },
      }),
    { message: /Exit callback failed/ },
  );
  t.true(exited);
});
