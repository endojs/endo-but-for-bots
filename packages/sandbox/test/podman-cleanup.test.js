// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { makePodmanDriver } from '../src/drivers/podman.js';
import { makeResourceRegistry } from '../src/resource-registry.js';

/** @param {any} t */
const fixture = t => {
  const active = new Set();
  const attached = new Map();
  const calls = [];
  const failures = new Set();
  let createCode = 0;
  let deferCreate = false;
  let deferProxyExit = false;
  let completeCreate;
  let created;
  const creating = new Promise(resolve => {
    created = resolve;
  });
  const finish = name => {
    const child = attached.get(name);
    if (child) {
      attached.delete(name);
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    }
  };
  const childProcess = {
    spawn(command, args) {
      calls.push([...args]);
      /** @type {any} */
      const child = new EventEmitter();
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      let sent = false;
      const send = (code, message = '') => {
        if (sent) return;
        sent = true;
        child.stdout.end();
        child.stderr.end(message);
        child.emit('close', code, null);
      };
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name') + 1];
        active.add(name); // Even a failing create may leave its container.
        completeCreate = () =>
          send(createCode, createCode ? 'create failed' : '');
        created(name);
        if (!deferCreate) queueMicrotask(completeCreate);
      } else if (args[0] === 'start') {
        attached.set(args.at(-1), child);
      } else if (args[0] === 'rm') {
        const name = args.at(-1);
        queueMicrotask(() => {
          if (failures.has(name)) send(1, 'removal failed');
          else {
            active.delete(name);
            if (!deferProxyExit) finish(name);
            send(0);
          }
        });
      } else throw Error(`Unexpected ${command} ${args[0]}`);
      return child;
    },
  };
  const driver = makePodmanDriver({
    childProcess: /** @type {any} */ (childProcess),
    env: {},
    ownerId: 'cleanup-test',
  });
  /** @type {any} */
  const slice = {
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
    failures.clear();
    deferProxyExit = false;
    for (const name of attached.keys()) finish(name);
    completeCreate?.();
    await driver.teardown(slice);
  });
  return {
    driver,
    slice,
    active,
    calls,
    failures,
    finish,
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
  };
};

test('successful removal retains ownership until the attached host process exits', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const proc = await f.driver.spawn(f.slice, ['/bin/true'], {});
  const [name] = f.active;
  f.deferProxyExit();
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

test('a failing create and removal retain an admission slot until retry succeeds', async t => {
  t.timeout(3000);
  const f = fixture(t);
  f.slice.policy = {
    request: { resources: { maxConcurrentOperations: 1 } },
    argv: [],
    anchorName: 'anchor',
  };
  f.defer();
  f.failCreate();
  const acquired = f.driver.spawn(f.slice, ['/bin/true'], {});
  const rejected = t.throwsAsync(acquired, {
    message: /admission cleanup pending/,
  });
  const name = await f.creating;
  f.failures.add(name);
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
