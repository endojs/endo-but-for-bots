// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { makePodmanDriver } from '../src/drivers/podman.js';
import { acquireRuntimeOwnership } from '../src/runtime-ownership.js';
import { makeSandboxRuntime } from '../src/runtime.js';

/** @import { GeneratedFileStage } from '../src/generated-file-storage-types.js' */

const opts = harden({
  rootfs: { kind: 'oci', ref: 'test-image' },
  generatedFiles: [
    { innerPath: '/etc/resolv.conf', contents: 'nameserver 127.0.0.53\n' },
  ],
});

/** @param {import('ava').ExecutionContext} t */
const fixture = async t => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'endo-runtime-'));
  const directory = await fs.realpath(parent);
  const config = {
    directory,
    ownerId: 'test-owner',
    maxBytes: 1024n,
    maxEntries: 10n,
  };
  const faults = {
    unlink: false,
    rmdir: false,
    teardown: false,
    drivers: false,
    driverClose: false,
    driverCloseSync: false,
  };
  /** @type {Array<ReturnType<typeof makeSandboxRuntime>>} */
  const runtimes = [];
  /** @type {Array<() => void>} */
  const unblock = [];
  let probes = 0;
  let driverCloses = 0;
  let file = '';
  const filesystem = {
    ...fs,
    unlink: async path => {
      if (faults.unlink) throw Error('marker removal failed');
      return fs.unlink(path);
    },
    rmdir: async path => {
      if (faults.rmdir) throw Error('storage removal failed');
      return fs.rmdir(path);
    },
  };
  t.teardown(async () => {
    for (const release of unblock) release();
    Object.assign(faults, {
      unlink: false,
      rmdir: false,
      teardown: false,
      drivers: false,
      driverClose: false,
      driverCloseSync: false,
    });
    for (const runtime of runtimes) {
      // eslint-disable-next-line no-await-in-loop
      await runtime.close();
    }
    await fs.rm(parent, { recursive: true, force: true });
  });
  /**
   * @param {typeof fs} [fsPower]
   * @param {Parameters<typeof makeSandboxRuntime>[1]['makeDriver']} [driverBuilder]
   */
  const make = (fsPower, driverBuilder) => {
    const runtime = makeSandboxRuntime(config, {
      fs: fsPower ?? filesystem,
      scratchProvider: /** @type {any} */ ({
        provideScratchMount: async () => {
          throw Error('no scratch');
        },
      }),
      makeDriver:
        driverBuilder ??
        (storage => {
          if (faults.drivers) throw Error('driver construction failed');
          return {
            name: 'podman',
            close: () => {
              driverCloses += 1;
              if (faults.driverCloseSync) throw Error('driver close threw');
              if (faults.driverClose)
                return Promise.reject(Error('driver closure pending'));
              return Promise.resolve();
            },
            supportsGeneratedFiles: true,
            probe: async () => {
              probes += 1;
              return {
                available: true,
                details: { lifecycle: { available: true } },
              };
            },
            prepareSlice: async spec => {
              const stage = storage.makeStage(spec.generatedFiles ?? [], []);
              const [mount] = await stage.prepare();
              file = mount?.hostPath ?? '';
              return stage;
            },
            spawn: async () => {
              throw Error('unused spawn');
            },
            teardown: async stage => {
              if (faults.teardown) throw Error('container removal failed');
              await /** @type {GeneratedFileStage} */ (stage).release();
            },
          };
        }),
    });
    runtimes.push(runtime);
    return runtime;
  };
  return {
    directory,
    config,
    make,
    faults,
    unblock,
    probes: () => probes,
    driverCloses: () => driverCloses,
    file: () => file,
    marker: join(directory, 'test-owner.owner'),
    storageRoot: join(directory, 'test-owner.files'),
  };
};

test('runtime ownership excludes concurrent opens and releases only after files are gone', async t => {
  const f = await fixture(t);
  const first = f.make();
  const opening = first.open();
  t.is(first.open(), opening);
  const factory = await opening;
  const oldToken = await fs.readlink(f.marker);
  const second = f.make();
  await t.throwsAsync(second.open(), { message: /EEXIST/ });
  t.is(f.probes(), 0);
  await E(factory).make(opts);
  t.is(await fs.readFile(f.file(), 'utf8'), opts.generatedFiles[0].contents);
  const closing = first.close();
  t.is(first.close(), closing);
  t.is(f.driverCloses(), 1, 'driver admission closes synchronously');
  await t.throwsAsync(E(factory).make(opts), {
    message: /owner has been cancelled/,
  });
  await closing;
  await t.throwsAsync(fs.lstat(f.storageRoot), { message: /ENOENT/ });
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
  const next = f.make();
  await next.open();
  const nextToken = await fs.readlink(f.marker);
  t.not(nextToken, oldToken);
  await first.close();
  t.is(await fs.readlink(f.marker), nextToken);
});

test('failed container cleanup retains files and marker until retry', async t => {
  const f = await fixture(t);
  const runtime = f.make();
  const factory = await runtime.open();
  await E(factory).make(opts);
  f.faults.teardown = true;
  await t.throwsAsync(runtime.close(), { message: /runtime shutdown pending/ });
  t.is(
    f.driverCloses(),
    1,
    'driver close is attempted despite factory failure',
  );
  await fs.access(f.file());
  await fs.readlink(f.marker);
  await t.throwsAsync(f.make().open(), { message: /EEXIST/ });
  f.faults.teardown = false;
  await runtime.close();
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
});

test('failed storage or marker removal retains retry ownership in dependency order', async t => {
  const f = await fixture(t);
  const runtime = f.make();
  await runtime.open();
  f.faults.rmdir = true;
  await t.throwsAsync(runtime.close(), { message: /storage removal failed/ });
  await fs.readlink(f.marker);
  f.faults.rmdir = false;
  f.faults.unlink = true;
  await t.throwsAsync(runtime.close(), { message: /marker removal failed/ });
  await t.throwsAsync(fs.lstat(f.storageRoot), { message: /ENOENT/ });
  await fs.readlink(f.marker);
  f.faults.unlink = false;
  await runtime.close();
});

test('construction failure leaves a controller that can release its acquisitions', async t => {
  const f = await fixture(t);
  f.faults.drivers = true;
  const runtime = f.make();
  await t.throwsAsync(runtime.open(), {
    message: /driver construction failed/,
  });
  await fs.readlink(f.marker);
  await fs.access(f.storageRoot);
  t.is(f.probes(), 0);
  await runtime.close();
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
});

test('existing markers and abandoned storage refuse startup without a probe', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.marker, 'unproved old owner');
  await t.throwsAsync(f.make().open(), { message: /EEXIST/ });
  t.is(await fs.readFile(f.marker, 'utf8'), 'unproved old owner');
  await fs.unlink(f.marker);
  await fs.mkdir(f.storageRoot);
  await fs.writeFile(join(f.storageRoot, 'retained'), 'old configuration');
  const runtime = f.make();
  await t.throwsAsync(runtime.open(), { message: /EEXIST/ });
  await runtime.close();
  t.is(
    await fs.readFile(join(f.storageRoot, 'retained'), 'utf8'),
    'old configuration',
  );
  t.is(f.probes(), 0);
});

test('close during ownership acquisition drains publication before releasing it', async t => {
  t.timeout(3000);
  const f = await fixture(t);
  const started = makePromiseKit();
  const gate = makePromiseKit();
  f.unblock.push(() => gate.resolve(undefined));
  const runtime = f.make({
    ...fs,
    symlink: async (target, path, type) => {
      await fs.symlink(target, path, type);
      started.resolve(undefined);
      await gate.promise;
    },
  });
  const rejected = t.throwsAsync(runtime.open(), {
    message: /runtime is closing/,
  });
  await started.promise;
  let closed = false;
  const closing = runtime.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  t.false(closed);
  gate.resolve(undefined);
  await rejected;
  await closing;
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
  await t.throwsAsync(fs.lstat(f.storageRoot), { message: /ENOENT/ });
});

test('an old release cannot unlink a changed ownership marker', async t => {
  const f = await fixture(t);
  const ownership = await acquireRuntimeOwnership(f.config);
  const token = await fs.readlink(f.marker);
  await fs.unlink(f.marker);
  await fs.symlink('another-owner', f.marker);
  await t.throwsAsync(ownership.release(), { message: /ownership changed/ });
  t.is(await fs.readlink(f.marker), 'another-owner');
  await fs.unlink(f.marker);
  await fs.symlink(token, f.marker);
  const releasing = ownership.release();
  t.is(ownership.release(), releasing);
  await releasing;
});

test('a runtime closed before open acquires nothing', async t => {
  const f = await fixture(t);
  const runtime = f.make();
  await runtime.close();
  t.throws(() => runtime.open(), { message: /runtime is closing/ });
  t.deepEqual(await fs.readdir(f.directory), []);
});

test('driver cleanup failure retains storage and the marker after factory cleanup succeeds', async t => {
  const f = await fixture(t);
  const runtime = f.make();
  const factory = await runtime.open();
  await E(factory).make(opts);
  f.faults.driverClose = true;
  const failure = await t.throwsAsync(runtime.close(), {
    instanceOf: AggregateError,
    message: /runtime shutdown pending/,
  });
  t.regex(String(failure?.errors[0]), /driver closure pending/);
  t.is(f.driverCloses(), 1);
  await fs.access(f.storageRoot);
  await fs.readlink(f.marker);
  await t.throwsAsync(f.make().open(), { message: /EEXIST/ });
  f.faults.driverClose = false;
  await runtime.close();
  t.is(f.driverCloses(), 2);
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
});

test('factory and driver cleanup failures are preserved in the same attempt', async t => {
  const f = await fixture(t);
  const runtime = f.make();
  const factory = await runtime.open();
  await E(factory).make(opts);
  f.faults.teardown = true;
  f.faults.driverClose = true;
  const failure = await t.throwsAsync(runtime.close(), {
    instanceOf: AggregateError,
    message: /runtime shutdown pending/,
  });
  t.is(failure?.errors.length, 2);
  t.regex(String(failure?.errors[0]), /factory shutdown pending/);
  t.regex(String(failure?.errors[1]), /driver closure pending/);
  t.is(f.driverCloses(), 1, 'no hidden retry in this attempt');
  await fs.access(f.file());
  await fs.readlink(f.marker);
});

test('runtime retains ownership for an actual Podman driver pending native closure', async t => {
  t.timeout(5000);
  const f = await fixture(t);
  /** @type {any} */
  let child;
  const finish = () => {
    child?.stdout.end();
    child?.stderr.end();
    child?.emit('close', null, 'SIGKILL');
  };
  f.unblock.push(finish);
  const runtime = f.make(undefined, storage =>
    makePodmanDriver({
      ownerId: f.config.ownerId,
      generatedFileStorage: storage,
      childProcess: /** @type {any} */ ({
        spawn: () => {
          child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill: () => true,
          });
          queueMicrotask(() => child.emit('error', Error('probe unavailable')));
          return child;
        },
      }),
    }),
  );
  const factory = await runtime.open();
  const [probe] = await E(factory).listBackends();
  t.false(probe.available);
  const failure = await t.throwsAsync(runtime.close(), {
    instanceOf: AggregateError,
    message: /runtime shutdown pending/,
  });
  t.regex(String(failure?.errors[0]), /native command closure pending/);
  await fs.access(f.storageRoot);
  await fs.readlink(f.marker);
  finish();
  await Promise.resolve();
  await runtime.close();
  await t.throwsAsync(fs.lstat(f.storageRoot), { message: /ENOENT/ });
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
});

test('close during driver construction owns the returned late controller', async t => {
  t.timeout(5000);
  const f = await fixture(t);
  /** @type {Promise<void> | undefined} */
  let closing;
  let driverCloses = 0;
  const runtime = f.make(undefined, storage => {
    closing = runtime.close();
    const driver = makePodmanDriver({
      ownerId: f.config.ownerId,
      generatedFileStorage: storage,
    });
    return {
      ...driver,
      close: () => {
        driverCloses += 1;
        return driver.close();
      },
    };
  });
  await t.throwsAsync(runtime.open(), { message: /runtime is closing/ });
  await closing;
  t.is(driverCloses, 1);
  await t.throwsAsync(fs.lstat(f.storageRoot), { message: /ENOENT/ });
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
});

test('close during storage creation retains its late acquisition before release', async t => {
  t.timeout(5000);
  const f = await fixture(t);
  const started = makePromiseKit();
  const gate = makePromiseKit();
  f.unblock.push(() => gate.resolve(undefined));
  const runtime = f.make({
    ...fs,
    mkdir: async (path, options) => {
      await fs.mkdir(path, options);
      if (path === f.storageRoot) {
        started.resolve(undefined);
        await gate.promise;
      }
      return undefined;
    },
  });
  const rejected = t.throwsAsync(runtime.open(), {
    message: /runtime is closing/,
  });
  await started.promise;
  let closed = false;
  const closing = runtime.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  t.false(closed);
  await fs.access(f.storageRoot);
  await fs.readlink(f.marker);
  gate.resolve(undefined);
  await rejected;
  await closing;
  t.is(f.probes(), 0);
  t.is(f.driverCloses(), 0, 'no driver was constructed');
  await t.throwsAsync(fs.lstat(f.storageRoot), { message: /ENOENT/ });
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
});

test('synchronous driver close failure still permits factory cleanup and later retry', async t => {
  const f = await fixture(t);
  const runtime = f.make();
  const factory = await runtime.open();
  await E(factory).make(opts);
  f.faults.driverCloseSync = true;
  const closing = runtime.close();
  const failure = await t.throwsAsync(closing, {
    instanceOf: AggregateError,
    message: /runtime shutdown pending/,
  });
  t.regex(String(failure?.errors[0]), /driver close threw/);
  await t.throwsAsync(fs.lstat(f.file()), { message: /ENOENT/ });
  await fs.access(f.storageRoot);
  await fs.readlink(f.marker);
  f.faults.driverCloseSync = false;
  await runtime.close();
  await t.throwsAsync(fs.lstat(f.marker), { message: /ENOENT/ });
});
