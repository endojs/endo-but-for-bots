// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { makePromiseKit } from '@endo/promise-kit';
import { deepStrictEqual, rejects } from 'node:assert';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  rm,
  writeFile,
  access,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { makePodmanDriver } from '../src/drivers/podman.js';
import { makeSandboxFactoryKit } from '../src/factory.js';
import { makeGeneratedFileStorage } from '../src/generated-file-storage.js';
import { makeResourceRegistry } from '../src/resource-registry.js';

/** @import { SeccompFilePowers } from '../src/drivers/podman.js' */

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const hasUncertainProducer = error =>
  error instanceof AggregateError
    ? error.errors.some(hasUncertainProducer)
    : error instanceof Error &&
      error.message === 'Podman operation producer effects remain uncertain';

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const hasUncertainStartup = error =>
  error instanceof AggregateError
    ? error.errors.some(hasUncertainStartup)
    : error instanceof Error &&
      error.message === 'Podman operation startup effects remain uncertain';

/**
 * @param {any} t
 * @param {import('../src/generated-file-storage-types.js').GeneratedFileStorage} [storage]
 * @param {SeccompFilePowers} [fs]
 */
const fixture = (t, storage, fs) => {
  const active = new Set();
  const attached = new Map();
  const calls = [];
  const podmanPrefixes = [];
  const failures = new Set();
  const containerIds = new Map();
  const containerNames = new Map();
  let nextContainerId = 0n;
  let identityResult;
  let beforeIdentity;
  let createCode = 0;
  let refuseCreate = false;
  let expectedUncertainty;
  let witnessResult = { code: 0, stdout: 'false\n' };
  let refuseStart = false;
  let refuseWitness = false;
  let failKill = false;
  let closeKill;
  const kills = [];
  let deferCreate = false;
  let deferProxyExit = false;
  let completeCreate;
  let created;
  const creating = new Promise(resolve => {
    created = resolve;
  });
  /**
   * @param {string} name
   * @param {number | null} [code]
   * @param {string | null} [signal]
   */
  const finish = (name, code = 0, signal = null) => {
    const child = attached.get(name);
    if (child) {
      attached.delete(name);
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    }
  };
  const childProcess = {
    spawn(command, args) {
      if (command === 'podman') {
        podmanPrefixes.push(args.slice(0, 2));
        args = args.slice(2);
      }
      calls.push([...args]);
      /** @type {any} */
      const child = new EventEmitter();
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: signal => {
          kills.push(signal);
          return true;
        },
      });
      let sent = false;
      const send = (code, message = '', stdout = '') => {
        if (sent) return;
        sent = true;
        child.stdout.end(stdout);
        child.stderr.end(message);
        child.emit('close', code, null);
      };
      if (args[0] === 'create') {
        if (refuseCreate) throw Error('create spawn refused');
        const name = args[args.indexOf('--name') + 1];
        active.add(name); // Even a failing create may leave its container.
        nextContainerId += 1n;
        const id = nextContainerId.toString(16).padStart(64, '0');
        containerIds.set(name, id);
        containerNames.set(id, name);
        completeCreate = () =>
          send(createCode, createCode ? 'create failed' : '');
        created(name);
        if (!deferCreate) queueMicrotask(completeCreate);
      } else if (args[0] === 'start') {
        if (refuseStart) throw Error('start spawn refused');
        const reference = args.at(-1);
        attached.set(containerNames.get(reference) ?? reference, child);
      } else if (args[0] === 'rm') {
        const reference = args.at(-1);
        const name = containerNames.get(reference) ?? reference;
        queueMicrotask(() => {
          if (failures.has(name)) send(1, 'removal failed');
          else {
            active.delete(name);
            if (!deferProxyExit) finish(name);
            send(0);
          }
        });
      } else if (args.includes('{{.Id}}')) {
        queueMicrotask(() => {
          beforeIdentity?.();
          send(
            identityResult?.code ?? 0,
            '',
            identityResult?.stdout ?? `${containerIds.get(args.at(-1))}\n`,
          );
        });
      } else if (args.includes('{{.State.StartedAt.IsZero}}')) {
        if (refuseWitness) throw Error('startup inspection spawn refused');
        queueMicrotask(() =>
          send(witnessResult.code, '', witnessResult.stdout),
        );
      } else if (args[0] === 'kill') {
        closeKill = () => send(0);
        queueMicrotask(() => {
          if (failKill) child.emit('error', Error('signal command failed'));
          else closeKill();
        });
      } else if (command !== 'podman') {
        queueMicrotask(() => send(1));
      } else if (args[0] === 'image' || args[0] === 'info') {
        queueMicrotask(() => send(0));
      } else throw Error(`Unexpected ${command} ${args[0]}`);
      return child;
    },
  };
  const driver = makePodmanDriver({
    childProcess: /** @type {any} */ (childProcess),
    env: {},
    ownerId: 'cleanup-test',
    generatedFileStorage: storage,
    fs,
  });
  /** @type {any} */
  let slice = {
    operations: makeResourceRegistry(),
    teardownFlight: undefined,
    spec: {
      rootfs: { kind: 'oci', ref: 'test-image' },
      mounts: [],
      scratchHostPath: '',
      network: 'none',
      seccomp: 'default',
      env: {},
      cwd: '/',
    },
    ref: 'test-image',
    runtime: '',
    netBackend: null,
    live: new Map(),
    reserved: new Set(),
    seccompTempPath: null,
    policy: null,
    join: null,
    runtimeDetails: { path: { value: '/usr/bin:/bin', source: 'fallback' } },
  };
  t.teardown(async () => {
    try {
      failures.clear();
      deferProxyExit = false;
      for (const name of attached.keys()) finish(name);
      completeCreate?.();
      closeKill?.();
      if (expectedUncertainty) {
        // These are synthetic processes, all closed above. Assert that the
        // production owner still retains uncertainty; do not fabricate success.
        await rejects(driver.teardown(slice), expectedUncertainty);
        return;
      }
      await driver.teardown(slice);
      await driver.close();
    } finally {
      // Assert outside production catches, including calls made by teardown.
      // AVA assertions cannot run after the test body has finished.
      for (const prefix of podmanPrefixes) {
        deepStrictEqual(prefix, ['--remote=false', '--syslog=false']);
      }
    }
  });
  return {
    driver,
    get slice() {
      return slice;
    },
    async prepare(spec) {
      slice = await driver.prepareSlice({ ...slice.spec, ...spec });
      return slice;
    },
    active,
    calls,
    kills,
    containerIds,
    setIdentity: result => {
      identityResult = result;
    },
    beforeIdentity: callback => {
      beforeIdentity = callback;
    },
    setWitness: result => {
      witnessResult = result;
    },
    refuseStart: () => {
      refuseStart = true;
    },
    refuseWitness: () => {
      refuseWitness = true;
    },
    failKill: () => {
      failKill = true;
    },
    closeKill: () => closeKill?.(),
    failures,
    finish,
    exit: name => attached.get(name)?.emit('exit', 0, null),
    creating,
    deferProxyExit: () => {
      deferProxyExit = true;
    },
    defer: () => {
      deferCreate = true;
    },
    complete: () => completeCreate(),
    failCreate: () => {
      createCode = 1;
    },
    succeedCreate: () => {
      createCode = 0;
    },
    refuseCreate: () => {
      refuseCreate = true;
    },
    expectUncertainty: () => {
      expectedUncertainty = hasUncertainProducer;
    },
    expectStartupUncertainty: () => {
      expectedUncertainty = hasUncertainStartup;
    },
  };
};

test('successful removal and attach exit retain ownership until native stdio closes', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [name] = f.active;
  f.deferProxyExit();
  f.exit(name);
  let stopped = false;
  const stopping = f.driver.teardown(f.slice).then(() => {
    stopped = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  t.false(f.active.has(name));
  t.true(f.slice.live.has(name));
  t.false(stopped);
  f.finish(name);
  await stopping;
  await proc.wait();
  t.is(f.slice.live.size, 0);
  t.is(f.calls.filter(args => args[0] === 'rm').length, 1);
});

test('failed natural removal retains ownership and disposal retries without rewriting process history', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [name] = f.active;
  f.failures.add(name);
  const failedWait = t.throwsAsync(proc.wait(), { message: /reap failed/ });
  f.finish(name);
  await failedWait;
  t.true(f.slice.live.has(name));
  await t.throwsAsync(f.driver.teardown(f.slice), {
    message: /teardown pending/,
  });
  t.true(f.active.has(name));
  await t.throwsAsync(async () => f.driver.spawn(f.slice, ['/bin/true'], {}), {
    message: /shutting down/,
  });
  f.failures.clear();
  await f.driver.teardown(f.slice);
  t.is(f.active.size, 0);
  t.is(f.slice.live.size, 0);
  await t.throwsAsync(proc.wait(), { message: /reap failed/ });
});

test('teardown coalesces and waits for a pending create before removing its container', async t => {
  t.timeout(3000);
  const f = fixture(t);
  f.defer();
  const acquired = f.driver.spawn(f.slice, ['/bin/true'], {});
  const rejected = t.throwsAsync(acquired, { message: /shutting down/ });
  await f.creating;
  const stopping = f.driver.teardown(f.slice);
  t.is(f.driver.teardown(f.slice), stopping);
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  t.false(stopped);
  f.complete();
  await rejected;
  await stopping;
  t.is(f.active.size, 0);
  t.false(f.calls.some(args => args[0] === 'start'));
});

test('cancelled admission after successful create retains its slot until removal succeeds', async t => {
  t.timeout(3000);
  const f = fixture(t);
  f.slice.policy = {
    request: { resources: { maxConcurrentOperations: 1 } },
    argv: [],
    anchorName: 'anchor',
  };
  f.defer();
  let cancelled = false;
  const acquired = f.driver.spawn(
    f.slice,
    ['/bin/true'],
    {},
    {
      isCancelled: () => cancelled,
    },
  );
  const rejected = t.throwsAsync(acquired, {
    message: /admission cleanup pending/,
  });
  const name = await f.creating;
  f.failures.add(name);
  cancelled = true;
  f.complete();
  await rejected;
  t.is(f.slice.reserved.size, 1);
  await t.throwsAsync(async () => f.driver.spawn(f.slice, ['/bin/true'], {}), {
    message: /concurrent operations/,
  });
  await t.throwsAsync(f.driver.teardown(f.slice), {
    message: /teardown pending/,
  });
  t.true(f.calls.some(args => args[0] === 'rm' && args.at(-1) === 'anchor'));
  f.failures.clear();
  await f.driver.teardown(f.slice);
  t.is(f.slice.reserved.size, 0);
  t.is(f.active.size, 0);
});

test('failed removal does not prevent sibling or anchor cleanup and retains configuration', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'podman-config-test-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'profile.json');
  await writeFile(config, '{}');
  f.slice.seccompTempPath = config;
  const first = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const second = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [bad, good] = f.active;
  f.slice.policy = { anchorName: 'anchor' };
  f.failures.add(bad);
  await t.throwsAsync(f.driver.teardown(f.slice), {
    message: /teardown pending/,
  });
  t.true(f.active.has(bad));
  t.false(f.active.has(good));
  t.is(f.slice.policy, null);
  await access(config);
  f.failures.clear();
  await f.driver.teardown(f.slice);
  await Promise.all([first.wait(), second.wait()]);
  t.like(await t.throwsAsync(access(config)), { code: 'ENOENT' });
});

/** @param {any} t */
const storageFixture = async t => {
  const parent = await mkdtemp(join(tmpdir(), 'podman-generated-,"='));
  t.teardown(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'files');
  const storage = await makeGeneratedFileStorage({
    directory,
    maxBytes: 1024n,
    maxEntries: 10n,
  });
  return { storage, directory };
};

const resolverFiles = harden([
  { innerPath: '/etc/resolv.conf', contents: 'nameserver 127.0.0.53\n' },
]);

test('Podman lazily stages individual read-only files and reuses them across operations', async t => {
  t.timeout(5000);
  const { storage, directory } = await storageFixture(t);
  const f = fixture(t, storage);
  t.true(f.driver.supportsGeneratedFiles);
  t.not(makePodmanDriver().supportsGeneratedFiles, true);
  await f.prepare({ generatedFiles: resolverFiles });
  t.deepEqual(await readdir(directory), []);
  const procs = await Promise.all([
    f.driver.spawn(f.slice, ['/bin/true'], {}),
    f.driver.spawn(f.slice, ['/bin/true'], {}),
  ]);
  const stages = await readdir(directory);
  t.is(stages.length, 1);
  const source = await realpath(join(directory, stages[0], '0'));
  t.is(await readFile(source, 'utf8'), resolverFiles[0].contents);
  const creates = f.calls.filter(args => args[0] === 'create');
  const expected = `type=bind,"source=${source.replaceAll('"', '""')}",target=/etc/resolv.conf,readonly`;
  for (const args of creates) {
    t.deepEqual(
      args.filter((_, i) => args[i - 1] === '--mount'),
      [expected],
    );
  }
  for (const name of [...f.active]) f.finish(name);
  await Promise.all(procs.map(proc => proc.wait()));
  t.is(await readFile(source, 'utf8'), resolverFiles[0].contents);
  const later = await f.driver.spawn(f.slice, ['/bin/true'], {});
  t.deepEqual(await readdir(directory), stages);
  await f.driver.teardown(f.slice);
  await later.wait();
  t.deepEqual(await readdir(directory), []);
  await storage.close();
});

test('Podman retains generated files through failed container removal', async t => {
  t.timeout(5000);
  const { storage, directory } = await storageFixture(t);
  const f = fixture(t, storage);
  await f.prepare({ generatedFiles: resolverFiles });
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [name] = f.active;
  f.failures.add(name);
  await t.throwsAsync(f.driver.teardown(f.slice), {
    message: /teardown pending/,
  });
  t.is((await readdir(directory)).length, 1);
  await t.throwsAsync(storage.close(), { message: /shutdown pending/ });
  f.failures.clear();
  await f.driver.teardown(f.slice);
  await proc.wait();
  t.deepEqual(await readdir(directory), []);
  await storage.close();
});

test('Podman teardown drains pending staging and prevents container creation', async t => {
  t.timeout(5000);
  const { promise: preparing, resolve: began } = makePromiseKit();
  const { promise: pending, resolve: resume } = makePromiseKit();
  t.teardown(() => resume(undefined));
  let released = false;
  const f = fixture(t, {
    makeStage: () => ({
      prepare: async () => {
        began(undefined);
        await pending;
        return [];
      },
      release: async () => {
        released = true;
      },
    }),
    close: async () => {},
  });
  await f.prepare({ generatedFiles: resolverFiles });
  const acquired = f.driver.spawn(f.slice, ['/bin/true'], {});
  const rejected = t.throwsAsync(acquired, { message: /shutting down/ });
  await preparing;
  const stopping = f.driver.teardown(f.slice);
  t.false(released);
  resume(undefined);
  await rejected;
  await stopping;
  t.true(released);
  t.false(f.calls.some(args => args[0] === 'create'));
});

test('Podman retries generated-file release after all containers are removed', async t => {
  t.timeout(5000);
  let releases = 0;
  const f = fixture(t, {
    makeStage: () => ({
      prepare: async () => [],
      release: async () => {
        releases += 1;
        if (releases === 1) throw Error('staging deletion failed');
      },
    }),
    close: async () => {},
  });
  await f.prepare({ generatedFiles: resolverFiles });
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  await t.throwsAsync(f.driver.teardown(f.slice), {
    message: /staging deletion failed/,
  });
  t.is(f.active.size, 0);
  const removals = f.calls.filter(args => args[0] === 'rm').length;
  await f.driver.teardown(f.slice);
  await proc.wait();
  t.is(releases, 2);
  t.is(f.calls.filter(args => args[0] === 'rm').length, removals);
});

test('Podman refuses invalid generated destinations and exact policies before any acquisition', async t => {
  const f = fixture(t, {
    makeStage: () => {
      throw Error('must not allocate');
    },
    close: async () => {},
  });
  for (const innerPath of [
    '/run/config',
    '/var/tmp/config',
    '/etc/a\rfile',
    '/etc/../file',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      f.prepare({ generatedFiles: [{ innerPath, contents: '' }] }),
      {
        message: /overlaps|CR or NUL|canonical/,
      },
    );
  }
  await t.throwsAsync(
    f.prepare({ generatedFiles: resolverFiles, policy: {} }),
    {
      message: /exact slice policy/,
    },
  );
  t.deepEqual(f.calls, []);
});

test('Podman quotes complete bind fields for caller mounts and scratch', async t => {
  const f = fixture(t);
  f.slice.spec.mounts = [
    { hostPath: '/host,readonly', innerPath: '/work"=\nfile', mode: 'rw' },
  ];
  f.slice.spec.scratchHostPath = '/scratch,source=/another';
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const create = f.calls.find(args => args[0] === 'create');
  t.deepEqual(
    create?.filter((_, i) => create[i - 1] === '--mount'),
    [
      'type=bind,"source=/host,readonly","target=/work""=\nfile"',
      'type=bind,"source=/scratch,source=/another",target=/scratch',
    ],
  );
  await f.driver.teardown(f.slice);
  await proc.wait();
});

for (const failure of ['serialization', 'write', 'validation']) {
  test(`failed seccomp ${failure} retains the directory until deletion succeeds`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'podman-prepare-files-'));
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    let denyRemoval = true;
    const fs = await import('node:fs/promises');
    const f = fixture(t, undefined, {
      ...fs,
      mkdtemp: () => mkdtemp(join(directory, 'profile-')),
      writeFile: async (...args) => {
        if (failure === 'write') throw Error('profile write failed');
        await writeFile(...args);
      },
      rm: async (...args) => {
        if (denyRemoval) throw Error('profile directory removal failed');
        await rm(...args);
      },
    });
    t.teardown(() => {
      denyRemoval = false;
    });
    /** @type {any} */
    const profile = {};
    if (failure === 'serialization') profile.self = profile;
    const error = await t.throwsAsync(
      f.prepare({
        seccomp: { profile },
        // Validation happens after materialization, before any policy anchor.
        ...(failure === 'validation'
          ? { policy: {}, network: 'broker-only' }
          : {}),
      }),
      { instanceOf: AggregateError, message: /preparation cleanup pending/ },
    );
    t.regex(String(error?.errors[1]), /profile directory removal failed/);
    const [name] = await readdir(directory);
    t.truthy(name);
    await t.throwsAsync(f.driver.closeSlices(), {
      message: /slice cleanup pending/,
    });
    await access(join(directory, name));
    denyRemoval = false;
    await f.driver.closeSlices();
    t.deepEqual(await readdir(directory), []);
    await t.throwsAsync(async () => f.prepare({}), {
      message: /shutting down/,
    });
  });
}

test('closing slices drains a late preparation while cleaning existing contexts immediately', async t => {
  t.timeout(5000);
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'podman-prepare-drain-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const { promise: entered, resolve: began } = makePromiseKit();
  const { promise: waiting, resolve: resume } = makePromiseKit();
  const { promise: removed, resolve: didRemove } = makePromiseKit();
  let firstDirectory;
  let defer = false;
  const f = fixture(t, undefined, {
    ...fs,
    mkdtemp: () => mkdtemp(join(directory, 'profile-')),
    writeFile: async (...args) => {
      if (defer) {
        began(undefined);
        await waiting;
      }
      await writeFile(...args);
    },
    rm: async (...args) => {
      await rm(...args);
      if (args[0] === firstDirectory) didRemove(undefined);
    },
  });
  t.teardown(() => resume(undefined));
  await f.prepare({ seccomp: { profile: {} } });
  const [first] = await readdir(directory);
  firstDirectory = join(directory, first);
  defer = true;
  const acquired = f.prepare({ seccomp: { profile: {} } });
  const rejected = t.throwsAsync(acquired, { message: /shutting down/ });
  await entered;
  const stopping = f.driver.closeSlices();
  t.is(f.driver.closeSlices(), stopping);
  // The first directory's cleanup must not wait for the second writer.
  await removed;
  t.like(await t.throwsAsync(access(join(directory, first))), {
    code: 'ENOENT',
  });
  t.is((await readdir(directory)).length, 1);
  await t.throwsAsync(async () => f.driver.probe(), {
    message: /shutting down/,
  });
  await t.throwsAsync(async () => f.driver.spawn(f.slice, ['/bin/true'], {}), {
    message: /shutting down/,
  });
  resume(undefined);
  await rejected;
  await stopping;
  t.deepEqual(await readdir(directory), []);
});

/** @param {ReturnType<typeof fixture>} f */
const limitToOneOperation = f => {
  f.slice.policy = {
    request: { resources: { maxConcurrentOperations: 1 } },
    argv: [],
    anchorName: 'anchor',
  };
};

test('cancelled create retains its slot and configuration across native closure and successful rm', async t => {
  t.timeout(5000);
  const f = fixture(t);
  limitToOneOperation(f);
  f.defer();
  f.expectUncertainty();
  let released = false;
  f.slice.generatedStage = {
    prepare: async () => [],
    release: async () => {
      released = true;
    },
  };
  const { cancelled, cancel } = makeCancelKit();
  const acquired = f.driver.spawn(f.slice, ['/bin/true'], {}, { cancelled });
  const rejected = t.throwsAsync(acquired, {
    message: /admission cleanup pending/,
  });
  const name = await f.creating;
  cancel();
  await rejected;
  t.deepEqual(f.kills, ['SIGKILL']);
  t.false(f.calls.some(args => args[0] === 'rm'));
  t.true(f.active.has(name));
  t.is(f.slice.reserved.size, 1);
  t.false(released);
  // Even a later code 0 cannot rewrite the interrupted command's outcome.
  f.complete();
  await Promise.resolve();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const failure = await t.throwsAsync(f.driver.teardown(f.slice), {
      instanceOf: AggregateError,
      message: /teardown pending/,
    });
    t.true(hasUncertainProducer(failure));
    t.is(f.slice.reserved.size, 1);
    t.false(released);
  }
  t.false(f.active.has(name));
});

test('failed create removal cannot turn uncertain effects into a free admission slot', async t => {
  const f = fixture(t);
  limitToOneOperation(f);
  f.failCreate();
  f.expectUncertainty();
  await t.throwsAsync(f.driver.spawn(f.slice, ['/bin/true'], {}), {
    message: /admission cleanup pending/,
  });
  t.is(f.active.size, 0, 'best-effort removal ran');
  t.is(f.slice.reserved.size, 1);
  await t.throwsAsync(async () => f.driver.spawn(f.slice, ['/bin/true'], {}), {
    message: /concurrent operations/,
  });
  f.succeedCreate();
  // A different slice on the same driver remains usable.
  const sibling = {
    ...f.slice,
    policy: null,
    operations: makeResourceRegistry(),
    reserved: new Set(),
    live: new Map(),
  };
  t.teardown(() => f.driver.teardown(sibling));
  const proc = await f.driver.spawn(sibling, ['/bin/true'], {});
  const [name] = f.active;
  f.finish(name);
  await proc.wait();
  await f.driver.teardown(sibling);
  t.is(f.slice.reserved.size, 1);
});

test('create spawn with no acquired child releases its slot without operation removal', async t => {
  const f = fixture(t);
  limitToOneOperation(f);
  f.refuseCreate();
  await t.throwsAsync(f.driver.spawn(f.slice, ['/bin/true'], {}), {
    message: /create spawn refused/,
  });
  t.is(f.slice.reserved.size, 0);
  t.is(f.active.size, 0);
  t.false(f.calls.some(args => args[0] === 'rm'));
  await f.driver.teardown(f.slice);
});

test('generic operations disable automatic restart and inherited healthchecks', async t => {
  const f = fixture(t);
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const create = f.calls.find(args => args[0] === 'create');
  t.true(create?.includes('--restart=no'));
  t.true(create?.includes('--no-healthcheck'));
  // Attached streams reach the caller; Podman keeps no journal copy.
  t.true(create?.includes('--log-driver=none'));
  await f.driver.teardown(f.slice);
  await proc.wait();
});

test('operation controls keep the resolved full ID across name replacement and removal retry', async t => {
  const f = fixture(t);
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [name] = f.active;
  const id = f.containerIds.get(name);
  const identity = f.calls.find(args => args.includes('{{.Id}}'));
  t.is(identity?.at(-1), name);
  t.is(f.calls.find(args => args[0] === 'start')?.at(-1), id);
  // create stdout is empty in this fixture, as permitted by passthrough logs.
  // A later name lookup would now resolve a different container.
  f.containerIds.set(name, 'f'.repeat(64));
  await proc.kill('SIGTERM');
  t.is(f.calls.find(args => args[0] === 'kill')?.at(-1), id);
  f.failures.add(name);
  await t.throwsAsync(f.driver.teardown(f.slice), {
    instanceOf: AggregateError,
  });
  f.failures.clear();
  await f.driver.teardown(f.slice);
  await proc.wait();
  const removals = f.calls.filter(args => args[0] === 'rm');
  t.true(removals.length >= 2);
  t.true(removals.every(args => args.at(-1) === id));
});

for (const identity of [
  { stdout: '' },
  { stdout: 'a'.repeat(12) },
  { stdout: `${'a'.repeat(64)}\n${'b'.repeat(64)}` },
  { code: 125, stdout: 'a'.repeat(64) },
]) {
  test(`unresolved operation identity cleans by reserved name: ${JSON.stringify(identity)}`, async t => {
    const f = fixture(t);
    limitToOneOperation(f);
    f.setIdentity(identity);
    await t.throwsAsync(f.driver.spawn(f.slice, ['/bin/true'], {}), {
      message: /no full container id/,
    });
    const create = f.calls.find(args => args[0] === 'create');
    const name = create[create.indexOf('--name') + 1];
    t.false(f.calls.some(args => args[0] === 'start'));
    t.deepEqual(
      f.calls.filter(args => args[0] === 'rm').map(args => args.at(-1)),
      [name],
    );
    t.is(f.slice.reserved.size, 0);
  });
}

test('cancellation during identity inspection retains the resolved ID for cleanup', async t => {
  const f = fixture(t);
  limitToOneOperation(f);
  const kit = makeCancelKit();
  f.beforeIdentity(kit.cancel);
  await t.throwsAsync(
    f.driver.spawn(f.slice, ['/bin/true'], {}, { cancelled: kit.cancelled }),
    { message: /admission aborted/ },
  );
  const [id] = f.containerIds.values();
  t.false(f.calls.some(args => args[0] === 'start'));
  t.deepEqual(
    f.calls.filter(args => args[0] === 'rm').map(args => args.at(-1)),
    [id],
  );
  t.is(f.slice.reserved.size, 0);
});

for (const status of [
  { code: 1, signal: null },
  { code: 42, signal: null },
  { code: 125, signal: null },
  { code: 137, signal: null },
  { code: null, signal: 'SIGTERM' },
]) {
  test(`a positive startup witness permits cleanup after attached exit ${JSON.stringify(status)}`, async t => {
    t.timeout(5000);
    const f = fixture(t);
    const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
    const [name] = f.active;
    const id = f.containerIds.get(name);
    f.finish(name, status.code, status.signal);
    t.deepEqual(await proc.wait(), status);
    const witnessAt = f.calls.findIndex(args =>
      args.includes('{{.State.StartedAt.IsZero}}'),
    );
    const removalAt = f.calls.findIndex(args => args[0] === 'rm');
    t.true(witnessAt >= 0 && witnessAt < removalAt);
    t.is(f.calls[witnessAt].at(-1), id);
    t.is(f.slice.live.size, 0);
  });
}

for (const witness of [
  { code: 0, stdout: 'true\n', refused: false },
  { code: 0, stdout: '', refused: false },
  { code: 125, stdout: 'false\n', refused: false },
  { code: 0, stdout: 'false\n', refused: true },
]) {
  test(`removal without a startup witness retains ownership: ${JSON.stringify(witness)}`, async t => {
    t.timeout(5000);
    const f = fixture(t);
    f.setWitness(witness);
    if (witness.refused) f.refuseWitness();
    f.expectStartupUncertainty();
    let released = false;
    f.slice.generatedStage = {
      prepare: async () => [],
      release: async () => {
        released = true;
      },
    };
    const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
    const failure = await t.throwsAsync(f.driver.teardown(f.slice));
    t.true(hasUncertainStartup(failure));
    await t.throwsAsync(proc.wait(), {
      message: /startup effects remain uncertain/,
    });
    t.is(f.active.size, 0, 'removal still stops the container');
    t.is(f.slice.live.size, 1);
    t.false(released);
    const calls = f.calls.length;
    // Once rm deletes the record, a plausible later answer is not evidence
    // about that startup. Retry neither queries nor removes it again.
    f.setWitness({ code: 0, stdout: 'false\n' });
    await t.throwsAsync(f.driver.teardown(f.slice));
    t.is(f.calls.length, calls);
    t.false(released);
  });
}

test('failed removal preserves the opportunity to retry startup observation', async t => {
  t.timeout(5000);
  const f = fixture(t);
  f.setWitness({ code: 125, stdout: '' });
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [name] = f.active;
  f.failures.add(name);
  await t.throwsAsync(f.driver.teardown(f.slice));
  f.failures.clear();
  f.setWitness({ code: 0, stdout: 'false\n' });
  await f.driver.teardown(f.slice);
  await proc.wait();
  t.is(f.slice.live.size, 0);
  t.is(
    f.calls.filter(args => args.includes('{{.State.StartedAt.IsZero}}')).length,
    2,
  );
});

test('a positive witness survives a removal failure without another inspection', async t => {
  t.timeout(5000);
  const f = fixture(t);
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [name] = f.active;
  f.failures.add(name);
  await t.throwsAsync(f.driver.teardown(f.slice));
  f.failures.clear();
  f.setWitness({ code: 125, stdout: '' });
  await f.driver.teardown(f.slice);
  await proc.wait();
  t.is(
    f.calls.filter(args => args.includes('{{.State.StartedAt.IsZero}}')).length,
    1,
  );
});

test('a start with no acquired child needs no startup witness', async t => {
  const f = fixture(t);
  f.refuseStart();
  await t.throwsAsync(f.driver.spawn(f.slice, ['/bin/true'], {}), {
    message: /start spawn refused/,
  });
  t.false(f.calls.some(args => args.includes('{{.State.StartedAt.IsZero}}')));
  t.is(f.active.size, 0);
});

test('driver close drains a healthy create without aborting its producer', async t => {
  t.timeout(5000);
  const f = fixture(t);
  await f.prepare({});
  f.defer();
  const pending = f.driver.spawn(f.slice, ['/bin/true'], {});
  const rejected = t.throwsAsync(pending, { message: /shutting down/ });
  await f.creating;
  const closing = f.driver.close();
  t.is(f.driver.close(), closing);
  t.deepEqual(f.kills, []);
  f.complete();
  await rejected;
  await closing;
  t.is(f.active.size, 0);
  t.false(f.calls.some(args => args[0] === 'start'));
  t.deepEqual(f.kills, []);
});

test('driver close permits witness and removal retries and fences completed handles', async t => {
  t.timeout(5000);
  const f = fixture(t);
  await f.prepare({});
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [name] = f.active;
  f.failures.add(name);
  await t.throwsAsync(f.driver.close(), { message: /slice cleanup pending/ });
  f.failures.clear();
  await f.driver.close();
  await proc.wait();
  t.deepEqual(f.kills, [], 'container removal handles the attach process');
  const count = f.calls.length;
  await proc.kill('SIGKILL');
  await f.driver.close();
  t.is(f.calls.length, count);
});

test('failed signaling retains native closure without poisoning later removal', async t => {
  t.timeout(5000);
  const f = fixture(t);
  await f.prepare({});
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  f.failKill();
  await t.throwsAsync(proc.kill('SIGTERM'), {
    message: /signal command failed/,
  });
  await t.throwsAsync(f.driver.close(), {
    message: /native command closure pending/,
  });
  t.is(f.active.size, 0);
  await proc.wait();
  const count = f.calls.length;
  await proc.kill('SIGKILL');
  t.is(f.calls.length, count);
  f.closeKill();
  await Promise.resolve();
  await f.driver.close();
});

test('preparation close before admission acquires nothing and leaves the driver open', async t => {
  const f = fixture(t);
  const kit = f.driver.prepareSliceKit(f.slice.spec);
  const rejected = t.throwsAsync(kit.value, {
    message: /preparation is closed/,
  });
  const closing = kit.close();
  t.is(kit.close(), closing);
  await closing;
  await rejected;
  t.deepEqual(f.calls, []);
  const sibling = f.driver.prepareSliceKit(f.slice.spec);
  const context = await sibling.value;
  const stopped = sibling.close();
  await t.throwsAsync(async () => f.driver.spawn(context, ['/bin/true'], {}), {
    message: /shutting down/,
  });
  await stopped;
});

test('factory scopes retry failed preparation without stopping a sibling on the same driver and allocator', async t => {
  t.timeout(5000);
  const directory = await mkdtemp(join(tmpdir(), 'podman-factory-scopes-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const storage = await makeGeneratedFileStorage({
    directory: join(directory, 'generated'),
    maxBytes: 100n,
    maxEntries: 3n,
  });
  t.teardown(() => storage.close());
  const fs = await import('node:fs/promises');
  let denyRemoval = true;
  const f = fixture(t, storage, {
    ...fs,
    mkdtemp: () => mkdtemp(join(directory, 'profile-')),
    writeFile: async () => {
      throw Error('profile write failed');
    },
    rm: async (...args) => {
      if (denyRemoval) throw Error('profile removal failed');
      await rm(...args);
    },
  });
  // Only availability is simulated; both scopes use the same actual driver
  // preparation, spawn, cleanup, and generated-file storage implementation.
  const driver = {
    ...f.driver,
    probe: async () => ({
      available: true,
      details: { lifecycle: { available: true } },
    }),
  };
  const makeFactory = () =>
    makeSandboxFactoryKit({
      drivers: [driver],
      scratchProvider: /** @type {any} */ ({}),
    });
  const first = makeFactory();
  const second = makeFactory();
  t.teardown(() => second.close());
  t.teardown(() => first.close());
  t.teardown(() => {
    denyRemoval = false;
    for (const name of f.active) f.finish(name);
  });
  await t.throwsAsync(
    first.makeResolved({
      rootfs: { kind: 'oci', ref: 'test-image' },
      seccomp: { profile: {} },
    }),
    { message: /construction cleanup pending/ },
  );
  const sibling = await second.makeResolved({
    rootfs: { kind: 'oci', ref: 'test-image' },
    generatedFiles: [{ innerPath: '/etc/scoped.conf', contents: 'sibling' }],
  });
  const process = await E(sibling).spawn(['/bin/true']);
  t.is(f.active.size, 1);
  await t.throwsAsync(first.close(), { message: /shutdown pending/ });
  t.is(f.active.size, 1);
  t.false(f.calls.some(args => args[0] === 'rm'));
  denyRemoval = false;
  await first.close();
  t.is(f.active.size, 1);
  const another = await E(sibling).spawn(['/bin/true']);
  t.is(f.active.size, 2);
  const names = [...f.active];
  t.not(names[0], names[1]);
  // The controlled children finish here; this fixture's signal command does
  // not simulate guest exit. Native reap/timeout behavior has separate tests.
  for (const name of names) f.finish(name);
  await E(process).wait();
  await E(another).wait();
  await second.close();
  t.is(f.active.size, 0);
  t.deepEqual(await readdir(join(directory, 'generated')), []);
});

test('preparation close drains a held write and does not publish its late context', async t => {
  t.timeout(5000);
  const fs = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'podman-scoped-drain-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const entered = makePromiseKit();
  const resume = makePromiseKit();
  const f = fixture(t, undefined, {
    ...fs,
    mkdtemp: () => mkdtemp(join(directory, 'profile-')),
    writeFile: async (...args) => {
      entered.resolve(undefined);
      await resume.promise;
      await writeFile(...args);
    },
  });
  t.teardown(() => resume.resolve(undefined));
  const kit = f.driver.prepareSliceKit({
    ...f.slice.spec,
    seccomp: { profile: {} },
  });
  const rejected = t.throwsAsync(kit.value, {
    message: /preparation is closed/,
  });
  await entered.promise;
  let closed = false;
  const closing = kit.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  t.false(closed);
  t.is((await readdir(directory)).length, 1);
  resume.resolve(undefined);
  await rejected;
  await closing;
  t.deepEqual(await readdir(directory), []);
  const sibling = await f.prepare({});
  await f.driver.teardown(sibling);
});
