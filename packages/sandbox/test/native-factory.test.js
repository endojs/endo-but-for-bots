// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSandboxFactoryKit } from '../src/factory.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { SliceSpec } from '../src/types.js' */
/** @import { NativeSandboxMakeOpts } from '../src/native-factory-types.js' */

/** @type {NativeSandboxMakeOpts} */
const approved = harden({
  rootfs: { kind: 'mount', hostPath: '/runtime/rootfs', mode: 'ro' },
  mounts: [{ hostPath: '/runtime/workspace', innerPath: '/work', mode: 'rw' }],
  scratchHostPath: '/runtime/scratch',
  network: 'none',
});

/**
 * @param {ExecutionContext} t
 * @param {{prepare?: () => Promise<unknown>, backend?: 'podman' | 'bwrap'}} [options]
 */
const fixture = (t, { prepare, backend = 'bwrap' } = {}) => {
  /** @type {SliceSpec[]} */
  const specs = [];
  /** @type {unknown[]} */
  const removed = [];
  let mountCalls = 0;
  let failCleanup = false;
  const noMounts = async () => {
    mountCalls += 1;
    throw Error('Native factory must not acquire or resolve Mounts');
  };
  const kit = makeSandboxFactoryKit({
    scratchProvider: {
      provideScratchMount: noMounts,
      provideHostPath: noMounts,
    },
    drivers: [
      {
        name: backend,
        probe: async () => ({
          available: true,
          details: { lifecycle: { available: true } },
        }),
        prepareSlice: async spec => {
          specs.push(spec);
          return prepare ? prepare() : {};
        },
        spawn: async () => {
          throw Error('No process requested');
        },
        teardown: async slice => {
          if (failCleanup) throw Error('Native removal pending');
          removed.push(slice);
        },
      },
    ],
  });
  t.teardown(async () => {
    failCleanup = false;
    await kit.close();
  });
  return {
    ...kit,
    specs,
    removed,
    mountCalls: () => mountCalls,
    failCleanup: () => {
      failCleanup = true;
    },
    allowCleanup: () => {
      failCleanup = false;
    },
  };
};

test('native profile reaches explicit Podman without legacy rlimit defaults', async t => {
  const f = fixture(t, { backend: 'podman' });
  const nativeProfile = harden({
    uid: 1000,
    gid: 1000,
    memoryBytes: 536_870_912n,
    pids: 128,
    cpuQuotaMicros: 200_000n,
    cpuPeriodMicros: 100_000,
    maxConcurrentOperations: 2,
  });
  /** @type {NativeSandboxMakeOpts} */
  const opts = harden({ ...approved, backend: 'podman', nativeProfile });
  const slice = await f.makeResolved(opts);
  t.deepEqual(f.specs[0].nativeProfile, nativeProfile);
  t.false(Object.hasOwn(f.specs[0], 'limits'));
  await E(slice).dispose();
  for (const backend of /** @type {const} */ ([undefined, 'auto', 'bwrap'])) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => f.makeResolved({ ...opts, backend }), {
      message: /require explicit Podman/,
    });
  }
  await t.throwsAsync(() => f.makeResolved({ ...opts, limits: {} }), {
    message: /cannot mix/,
  });
  t.is(f.specs.length, 1);
});

test('native preparation consumes explicit paths without daemon mount authority', async t => {
  const f = fixture(t);
  const handle = await f.makeResolved(approved);
  t.like(f.specs[0], approved);
  t.is(f.mountCalls(), 0);
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(/** @type {any} */ (handle)).__getMethodNames__();
  t.deepEqual([...methods].sort(), [
    '__getInterfaceGuard__',
    '__getMethodNames__',
    'dispose',
    'help',
    'policy',
    'reset',
    'spawn',
  ]);
  const publicFactory = /** @type {any} */ (f.factory);
  // eslint-disable-next-line no-underscore-dangle
  const publicMethods = await E(publicFactory).__getMethodNames__();
  t.false(publicMethods.includes('makeResolved'));
  await t.throwsAsync(() => E(f.factory).make(/** @type {any} */ (approved)), {
    message: /rootfs/,
  });
  await E(handle).dispose();
  t.is(f.removed.length, 1);
});

test('native preparation has no implicit scratch and shares network validation', async t => {
  const f = fixture(t);
  const handle = await f.makeResolved({
    rootfs: { kind: 'oci', ref: 'image' },
  });
  t.is(f.specs[0].scratchHostPath, '');
  t.is(f.mountCalls(), 0);
  await t.throwsAsync(() => f.makeResolved({ ...approved, network: 'join' }), {
    message: /requires a networkRef/,
  });
  t.is(f.specs.length, 1);
  await E(handle).dispose();
});

test('native late preparation shares the factory close fence and failed cleanup owner', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  const ready = makePromiseKit();
  const context = {};
  const f = fixture(t, {
    prepare: async () => {
      entered.resolve(undefined);
      return ready.promise;
    },
  });
  t.teardown(() => ready.resolve(context));
  f.failCleanup();
  const rejected = t.throwsAsync(f.makeResolved(approved), {
    message: /construction cleanup pending/,
  });
  await entered.promise;
  const failedClose = t.throwsAsync(f.close(), {
    message: /factory shutdown pending/,
  });
  ready.resolve(context);
  await rejected;
  await failedClose;
  await t.throwsAsync(() => f.makeResolved(approved), {
    message: /owner has been cancelled/,
  });
  await t.throwsAsync(
    () => E(f.factory).make(harden({ rootfs: { kind: 'host-bind' } })),
    { message: /owner has been cancelled/ },
  );
  t.deepEqual(f.removed, []);
  f.allowCleanup();
  await f.close();
  t.deepEqual(f.removed, [context]);
});

test('native acquisition and spawning refuse imported capabilities', async t => {
  const f = fixture(t);
  const foreign = f.factory;
  const before = f.specs.length;
  const unexpected = harden({ ...approved, extra: foreign });
  t.throws(() => f.makeResolved(unexpected), {
    message: /copy data/,
  });
  t.is(f.specs.length, before);
  const handle = await f.makeResolved(approved);
  const spawnOpts = harden({ cwd: '/work', stdin: foreign });
  await t.throwsAsync(E(handle).spawn(['test'], spawnOpts), {
    message: /stdin|unmatched|unexpected/,
  });
});

test('native factory works without scratch authority and refuses capability construction', async t => {
  let prepared = 0;
  const kit = makeSandboxFactoryKit({
    scratchProvider: null,
    drivers: [
      {
        name: 'bwrap',
        probe: async () => ({
          available: true,
          details: { lifecycle: { available: true } },
        }),
        prepareSlice: async () => {
          prepared += 1;
          return {};
        },
        spawn: async () => {
          throw Error('unused spawn');
        },
        teardown: async () => {},
      },
    ],
  });
  t.teardown(() => kit.close());
  const handle = await kit.makeResolved(approved);
  t.is(prepared, 1);
  await t.throwsAsync(E(kit.factory).make({ rootfs: { kind: 'minimal' } }), {
    message: /requires a scratch provider/,
  });
  t.is(prepared, 1);
  await E(handle).dispose();
});
