// @ts-check
import { E } from '@endo/far';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makePeerJournalReplayEngine } from '../src/core/peer-replay-engine.js';
import { QUICK_EXIT_MS, makeNativeAdapters } from '../src/native/adapters.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeFsStore } from '../src/store/store-fs.js';

/** @import { ExecutionContext } from 'ava' */

const fixturePath = fileURLToPath(
  new URL('./fixtures/native-resource.js', import.meta.url),
);

/**
 * A daemon over a filesystem store in a fresh directory, holding the
 * single-file fixture bundled the way an installation stores it, so a
 * launcher naming the bundle's digest starts a real process from it. The
 * bundle is stored once the daemon is up, as an installation stores it: a
 * start frees every bundle no launcher names.
 * @param {ExecutionContext} t
 */
const makeNativeFixture = async t => {
  const path = await mkdtemp('/tmp/thix-native-adapter-');
  t.teardown(() => rm(path, { recursive: true, force: true }));
  const powers = makeNodePowers();
  const store = makeFsStore(powers, path);
  const daemon = await makeThixotropeDaemon(powers, {
    store,
    engine: makePeerJournalReplayEngine(powers),
    nativeWorkers: powers.nativeWorkers,
    codec: syrupCodec,
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });
  t.teardown(() => daemon.shutdown());
  const bundleDigest = store.putBundle(
    await powers.bundler.bundleNative(fixturePath),
  );
  return { daemon, store, bundleDigest, powers };
};

/**
 * Timers the test advances by hand: a monotonic clock and a queue of armed
 * callbacks with their delays.
 */
const makeFakeTimers = () => {
  let clock = 0;
  /** @type {Array<{callback: () => void, delay: number}>} */
  const armed = [];
  return {
    timers: {
      now: () => clock,
      monotonicNow: () => clock,
      /**
       * @param {() => void} callback
       * @param {number} delay
       */
      setTimer: (callback, delay) => {
        const handle = { callback, delay };
        armed.push(handle);
        return handle;
      },
      /** @param {unknown} handle */
      clearTimer: handle => {
        const index = armed.indexOf(/** @type {any} */ (handle));
        if (index >= 0) armed.splice(index, 1);
      },
    },
    /** @param {number} ms */
    advance: ms => {
      clock += ms;
    },
    /** The delays armed so far, in order. */
    delays: () => armed.map(({ delay }) => delay),
    /** Fire every armed timer, as if all delays elapsed. */
    fireAll: () => {
      for (const { callback } of armed.splice(0)) callback();
    },
  };
};

/** Let every microtask and immediate queued so far run. */
const settled = () => new Promise(resolve => setImmediate(resolve));

/**
 * A launcher over fake processes the test can end by hand, with fake timers,
 * recording every exit notice it delivers.
 */
const makeExitFixture = () => {
  const fake = makeFakeTimers();
  /** @type {Array<{owner: string, terminated: boolean, exit: () => void}>} */
  const children = [];
  /** @type {string[]} */
  const exits = [];
  const adapters = makeNativeAdapters(
    {
      random: makeNodePowers().random,
      timers: fake.timers,
      nativeWorkers: {
        start: async ({ bundleDigest, onExit }) => {
          /** @type {() => void} */
          let resolveClosed = () => {};
          const closed = new Promise(resolve => {
            resolveClosed = () => resolve(undefined);
          });
          const child = {
            owner: bundleDigest,
            terminated: false,
            exit: () => {
              onExit();
              resolveClosed();
            },
          };
          children.push(child);
          return {
            send() {},
            closed,
            terminate: async () => {
              child.terminated = true;
              child.exit();
            },
          };
        },
      },
    },
    {
      hub: {
        attachSession: () => ({ deliver() {} }),
        forgetSession: () => {},
      },
      importBootstrap: () => ({ fetch: async () => 'root' }),
      bundlePath: digest => `/bundles/${digest}`,
      onAdapterExit: owner => exits.push(owner),
    },
  );
  /** @param {string} owner */
  const launcherOf = owner =>
    adapters.resource({ key: owner, workerId: owner });
  return { adapters, fake, children, exits, launcherOf };
};

test.serial(
  'native adapters run in fresh processes and retire without replay',
  async t => {
    t.timeout(30_000);
    const { daemon, bundleDigest } = await makeNativeFixture(t);
    const launcher = /** @type {{create: () => Promise<any>}} */ (
      daemon.makeResource('native-adapter', { key: bundleDigest })
    );
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

test.serial(
  'retiring a manager closes the adapters it launched and no others',
  async t => {
    t.timeout(5000);
    /** @type {Array<{owner: string, terminated: boolean}>} */
    const children = [];
    const adapters = makeNativeAdapters(
      {
        random: makeNodePowers().random,
        timers: makeFakeTimers().timers,
        nativeWorkers: {
          start: async ({ bundleDigest }) => {
            const child = { owner: bundleDigest, terminated: false };
            children.push(child);
            let resolveClosed;
            const closed = new Promise(resolve => {
              resolveClosed = resolve;
            });
            return {
              send() {},
              closed,
              terminate: async () => {
                child.terminated = true;
                resolveClosed();
              },
            };
          },
        },
      },
      {
        hub: {
          attachSession: () => ({ deliver() {} }),
          forgetSession: () => {},
        },
        importBootstrap: () => ({ fetch: async () => 'root' }),
        bundlePath: digest => `/bundles/${digest}`,
      },
    );
    t.teardown(() => adapters.shutdown());
    const launcherOf = owner =>
      adapters.resource({ key: owner, workerId: owner });
    await launcherOf('a').create();
    await launcherOf('a').create();
    await launcherOf('b').create();
    await adapters.retireWorker('a');
    t.deepEqual(
      children.map(child => child.terminated),
      [true, true, false],
    );
    await t.throwsAsync(() => launcherOf('a').create(), {
      message: /retired vat/,
    });
    await adapters.retireWorker('a');
    t.false(children[2].terminated, 'b is untouched');
    await adapters.retireWorker('c');
    await adapters.shutdown();
    t.true(children[2].terminated);
  },
);

test.serial('native shutdown closes a process awaiting its root', async t => {
  t.timeout(5000);
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
      timers: makeFakeTimers().timers,
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
      bundlePath: digest => `/bundles/${digest}`,
    },
  );
  t.teardown(() => adapters.shutdown());
  const creating = adapters.resource({ key: 'fixture' }).create();
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
        bundlePath: fileURLToPath(
          new URL('./fixtures/absent-native-bundle.cjs', import.meta.url),
        ),
        bundleDigest: '0'.repeat(64),
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

test.serial(
  'an incarnation that exits on its own is reported to its owner; one that is retired is not',
  async t => {
    const { adapters, fake, children, exits, launcherOf } = makeExitFixture();
    t.teardown(() => adapters.shutdown());
    const incarnation = await launcherOf('a').create();
    await E(incarnation).retire();
    t.deepEqual(fake.delays(), [], 'a retirement is not an exit to report');
    await launcherOf('a').create();
    fake.advance(QUICK_EXIT_MS);
    children[1].exit();
    await settled();
    t.deepEqual(
      fake.delays(),
      [0],
      'a long-lived incarnation is reported at once',
    );
    fake.fireAll();
    t.deepEqual(exits, ['a']);
  },
);

test.serial(
  'consecutive quick exits back off the notice, and a long life resets it',
  async t => {
    const { adapters, fake, children, exits, launcherOf } = makeExitFixture();
    t.teardown(() => adapters.shutdown());
    /** @type {number[]} */
    const observed = [];
    for (let n = 0; n < 7; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await launcherOf('a').create();
      fake.advance(QUICK_EXIT_MS - 1);
      children[n].exit();
      // eslint-disable-next-line no-await-in-loop
      await settled();
      observed.push(...fake.delays());
      fake.fireAll();
    }
    t.deepEqual(observed, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    t.is(exits.length, 7);
    await launcherOf('a').create();
    fake.advance(QUICK_EXIT_MS);
    children[7].exit();
    await settled();
    t.deepEqual(
      fake.delays(),
      [0],
      'a long-lived incarnation resets the backoff',
    );
    fake.fireAll();
    await launcherOf('b').create();
    fake.advance(1);
    children[8].exit();
    await settled();
    t.deepEqual(fake.delays(), [1000], 'owners back off independently');
  },
);

test.serial(
  "a pending exit notice is dropped by the owner's retirement and by shutdown",
  async t => {
    const { adapters, fake, children, exits, launcherOf } = makeExitFixture();
    await launcherOf('a').create();
    await launcherOf('b').create();
    children[0].exit();
    children[1].exit();
    await settled();
    t.deepEqual(fake.delays(), [1000, 1000]);
    await adapters.retireWorker('a');
    t.deepEqual(fake.delays(), [1000], "the retired owner's notice is cleared");
    await adapters.shutdown();
    t.deepEqual(fake.delays(), [], 'shutdown clears the rest');
    fake.fireAll();
    t.deepEqual(exits, []);
  },
);

test.serial(
  'a process that exits on its own is reported to the vat that owns it, which may rebuild',
  async t => {
    t.timeout(30_000);
    const { daemon, bundleDigest } = await makeNativeFixture(t);
    const worker = await daemon.createWorker({ debugLabel: 'owner' });
    // The owner's lifecycle object, held by the vat and registered for
    // notices as a manager's is; it counts what the host tells it.
    const lifecycle = await worker.evaluate(`(() => {
      globalThis.notices = { started: 0, exited: 0 };
      return Far('Lifecycle', {
        started: () => { notices.started += 1; },
        exited: () => { notices.exited += 1; },
        counts: () => harden({ ...notices }),
      });
    })()`);
    worker.notifyOnStart(lifecycle);
    const launcher = /** @type {{create: () => Promise<any>}} */ (
      daemon.makeResource('native-adapter', {
        workerId: worker.workerId,
        key: bundleDigest,
      })
    );
    const incarnation = await E(launcher).create();
    const root = await E(incarnation).getRoot();
    await t.throwsAsync(() => E(root).exit(), undefined, 'the process ends');
    // A quick exit is reported after the first backoff step.
    const deadline = Date.now() + 15_000;
    let counts = await E(lifecycle).counts();
    while (counts.exited === 0 && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 100));
      // eslint-disable-next-line no-await-in-loop
      counts = await E(lifecycle).counts();
    }
    t.deepEqual(counts, { started: 0, exited: 1 });
    const replacement = await E(launcher).create();
    await E(replacement).retire();
    await new Promise(resolve => setTimeout(resolve, 200));
    t.deepEqual(
      await E(lifecycle).counts(),
      { started: 0, exited: 1 },
      'a retirement is not reported',
    );
  },
);

test.serial(
  'a stored bundle that does not match its digest refuses to start, and says so',
  async t => {
    t.timeout(30_000);
    const { daemon, store, bundleDigest } = await makeNativeFixture(t);
    const launcher = /** @type {{create: () => Promise<any>}} */ (
      daemon.makeResource('native-adapter', { key: bundleDigest })
    );
    const incarnation = await E(launcher).create();
    await E(incarnation).retire();
    // The same path, other bytes: the digest the launcher names no longer
    // describes the file, and the process is the one that notices.
    await writeFile(
      store.bundlePath(bundleDigest),
      'module.exports = { make: () => undefined };\n',
    );
    await t.throwsAsync(() => E(launcher).create(), {
      message: /exited before readiness/,
    });
    // The process says why on its stderr, which the daemon only inherits.
    const child = fork(
      fileURLToPath(
        new URL('../src/platform/node/native-worker-entry.js', import.meta.url),
      ),
      ['tampered', store.bundlePath(bundleDigest), bundleDigest],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] },
    );
    let stderr = '';
    child.stderr?.on('data', chunk => {
      stderr += chunk;
    });
    const code = await new Promise(resolve => child.once('exit', resolve));
    t.is(code, 1);
    t.regex(stderr, /does not match its installed digest/);
  },
);

test.serial(
  'a launcher recorded before bundling refuses to launch and asks for a reinstallation',
  async t => {
    const { adapters } = makeExitFixture();
    t.teardown(() => adapters.shutdown());
    const launcher = adapters.resource({
      moduleUrl: 'file:///resource/ephemeral.js',
      resourceIdentity: { directory: '/resource', digest: 'x' },
      workerId: 'a',
    });
    await t.throwsAsync(() => launcher.create(), {
      message: /installed before its ephemeral module was bundled/,
    });
  },
);
