// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  lstat,
  mkdtemp,
  open,
  readlink,
  rm,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  makePodmanProviderListenerRuntime,
  makePodmanProviderListenerRuntimeKit,
} from '../src/provider-listener-runtime.js';
import { readHttpText, requestHttp } from './http-client.js';

const digest = `sha256:${'b'.repeat(64)}`;
const limits = harden({
  maxConnections: 1,
  maxRequestBytes: 1024n,
  maxResponseBytes: 1024n,
  timeoutMs: 1000,
});

/** @param {any} t */
const fixture = async (t, publicNetwork = false) => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), 'provider-runtime-test-'),
  );
  t.teardown(() => rm(stateDirectory, { recursive: true, force: true }));
  const children = new Map();
  const removals = [];
  let wrongNamespace = false;
  let removeFails = false;
  let orphan = '';
  let inspections = 0;
  let racePid = false;
  const calls = [];
  const launches = [];
  const host = {
    async readStart(pid) {
      return pid === process.pid ? '123' : null;
    },
    async run(args) {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: orphan };
      if (args[0] === 'rm') {
        if (removeFails) throw Error('removal failed');
        const name = args.at(-1);
        removals.push(name);
        children.get(name)?.kill();
        return { stdout: '' };
      }
      if (args[0] === 'inspect') {
        inspections += 1;
        return {
          stdout: JSON.stringify({
            State: {
              Running: true,
              Pid: racePid && inspections % 2 === 0 ? 4243 : 4242,
            },
            ImageDigest: digest,
            Config: { Labels: { 'io.endo.provider.owner': 'test-owner' } },
            HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true },
          }),
        };
      }
      throw Error('unexpected host operation');
    },
    launch(args) {
      launches.push(args);
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {startProviderListenerWorker} from ${JSON.stringify(new URL('../src/provider-worker.js', import.meta.url).href)}; await startProviderListenerWorker({input:process.stdin,output:process.stdout,makeNetworkListeners:async()=>harden({evidence:{policy:'public-internet',proxyUrl:'http://127.0.0.1:23457',dnsHost:'127.0.0.53'},dispose:async()=>{}})});`,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      children.set(args[args.indexOf('--name') + 1], child);
      return child;
    },
    procfs: {
      async readLink(path) {
        const type = path.split('/').at(-1);
        return `${type === 'mount' ? 'mnt' : type}:[${path.includes('/self/') || wrongNamespace ? '10' : '20'}]`;
      },
      async readFile(path) {
        if (path.endsWith('/net/dev')) return 'heading\nheading\n lo: 0 0\n';
        if (path.endsWith('/net/route')) return 'Iface Destination\n';
        if (path.endsWith('/net/ipv6_route')) return '';
        if (path.endsWith('_map')) return '0 0 65536\n';
        if (path.endsWith('/status'))
          return 'Uid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nNoNewPrivs:\t1\nSeccomp:\t2\nCapEff:\t0\nCapPrm:\t0\nCapBnd:\t0\n';
        throw Error('unexpected procfs path');
      },
    },
  };
  const options = {
    publicInternet: publicNetwork,
    imageRef: `localhost/listener@${digest}`,
    ownerId: 'test-owner',
    stateDirectory,
    host,
  };
  t.teardown(() => {
    for (const child of children.values()) child.kill();
  });
  return {
    calls,
    launches,
    options,
    removals,
    racePid: () => {
      racePid = true;
    },
    wrongNamespace: () => {
      wrongNamespace = true;
    },
    failRemoval: () => {
      removeFails = true;
    },
    allowRemoval: () => {
      removeFails = false;
    },
    orphan: () => {
      orphan = 'abcdef123456\n';
    },
  };
};

test.serial(
  'default Podman commands retain one sanitized operator environment through listener cleanup',
  async t => {
    t.timeout(5000);
    const f = await fixture(t);
    /** @type {Array<{command: string, args: string[], env: Record<string,string>}>} */
    const nativeCalls = [];
    const env = {
      PATH: '/operator/bin',
      HOME: '/operator/home',
      XDG_CONFIG_HOME: '/operator/config',
      XDG_DATA_HOME: '/operator/data',
      XDG_RUNTIME_DIR: '/operator/run',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/operator/bus',
      CONTAINERS_CONF: '/operator/containers.conf',
      REGISTRY_AUTH_FILE: '/operator/auth.json',
      OPENROUTER_API_KEY: 'never-to-child',
      HTTP_PROXY: 'http://host-proxy',
      CONTAINER_HOST: 'ssh://remote',
      CONTAINER_CONNECTION: 'remote',
    };
    const { run, launch, ...otherHost } = f.options.host;
    const kit = makePodmanProviderListenerRuntimeKit({
      ...f.options,
      env,
      host: {
        ...otherHost,
        async executeFile(command, args, options) {
          nativeCalls.push({ command, args, env: options.env });
          return run(args.slice(2));
        },
        spawn(command, args, options) {
          nativeCalls.push({ command, args, env: options.env });
          return launch(args.slice(2));
        },
      },
    });
    t.teardown(kit.close);
    env.HOME = '/changed/after-capture';
    const runtime = await kit.open();
    const listener = await runtime.start({
      endpoint: Far('unused inference', {}),
      limits,
    });
    await listener.observe();
    await listener.stop();
    await kit.close();
    t.true(nativeCalls.some(call => call.args[2] === 'ps'));
    t.true(nativeCalls.some(call => call.args[2] === 'inspect'));
    t.true(nativeCalls.some(call => call.args[2] === 'rm'));
    const first = nativeCalls[0];
    if (!first) throw Error('Expected native commands');
    const captured = first.env;
    for (const call of nativeCalls) {
      t.is(call.command, 'podman');
      t.deepEqual(call.args.slice(0, 2), ['--remote=false', '--syslog=false']);
      // Every command gets a fresh copy of the one captured environment:
      // the same values, never re-read from the ambient process env.
      t.deepEqual(call.env, captured);
      t.like(call.env, {
        HOME: '/operator/home',
        PATH: '/operator/bin',
        XDG_DATA_HOME: '/operator/data',
        XDG_CONFIG_HOME: '/operator/config',
        CONTAINERS_CONF: '/operator/containers.conf',
        REGISTRY_AUTH_FILE: '/operator/auth.json',
      });
      for (const forbidden of [
        'OPENROUTER_API_KEY',
        'HTTP_PROXY',
        'CONTAINER_HOST',
        'CONTAINER_CONNECTION',
      ]) {
        t.false(Object.hasOwn(call.env, forbidden));
      }
    }
    const started = nativeCalls.find(call => call.args[2] === 'run');
    if (!started) throw Error('Expected listener run');
    t.true(started.args.includes('--http-proxy=false'));
    t.false(started.args.some(arg => arg.startsWith('REGISTRY_AUTH_FILE=')));
    t.true(
      started.args.includes('HOME=/home/node'),
      'guest HOME remains explicit',
    );
  },
);

for (const diagnosticsEnabled of [false, true]) {
  test.serial(
    `listener keeps inference alive after repeated oversized stderr (diagnostics=${diagnosticsEnabled})`,
    async t => {
      t.timeout(5000);
      const f = await fixture(t);
      /** @type {ReturnType<typeof spawn> | undefined} */
      let child;
      /** @type {Uint8Array[]} */
      const diagnostics = [];
      const runtime = await makePodmanProviderListenerRuntime({
        ...f.options,
        host: {
          ...f.options.host,
          launch(args) {
            child = f.options.host.launch(args);
            return child;
          },
          ...(diagnosticsEnabled
            ? { onStderr: chunk => diagnostics.push(chunk) }
            : {}),
        },
      });
      t.teardown(runtime.dispose);
      let calls = 0;
      const listener = await runtime.start({
        endpoint: Far('inference after stderr', {
          requestStream() {
            calls += 1;
            let done = false;
            return harden({
              status: 200,
              contentType: 'text/event-stream',
              reader: Far('response', {
                async next() {
                  if (done) return harden({ done: true, value: '' });
                  done = true;
                  return harden({ done: false, value: 'data: healthy\n\n' });
                },
                return() {},
              }),
            });
          },
        }),
        limits,
      });
      if (!child?.stderr) throw Error('Expected listener stderr');
      // The real worker may have emitted startup diagnostics before ready.
      const initialChunks = diagnostics.length;
      const initialBytes = diagnostics.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      );
      const prefix = new Uint8Array(1024).fill(65);
      const oversized = new Uint8Array(8192).fill(66);
      child.stderr.emit('data', prefix);
      child.stderr.emit('data', oversized);
      for (let i = 0; i < 8; i += 1) child.stderr.emit('data', oversized);
      // Each chunk is copied up to 4096 bytes; there is no lifetime total, so
      // the ninth oversized chunk is reported like the first.
      t.is(
        diagnostics.reduce((total, chunk) => total + chunk.byteLength, 0),
        diagnosticsEnabled ? initialBytes + 1024 + 9 * 4096 : 0,
      );
      if (diagnosticsEnabled) {
        t.deepEqual(
          diagnostics.slice(initialChunks).map(chunk => chunk.byteLength),
          [1024, ...Array.from({ length: 9 }, () => 4096)],
        );
        t.true(diagnostics.every(chunk => chunk.buffer.byteLength <= 4096));
        prefix.fill(0);
        oversized.fill(0);
        const synthetic = diagnostics.slice(initialChunks);
        if (synthetic[0]) t.is(synthetic[0][0], 65);
        if (synthetic[1]) t.is(synthetic[1][0], 66);
      }
      const observed = await listener.observe();
      const response = await requestHttp(`${observed.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"allowed"}',
      });
      t.is(await readHttpText(response), 'data: healthy\n\n');
      t.is(calls, 1);
      t.is(f.removals.length, 0);
      await listener.stop();
      t.is(f.removals.length, 1);
    },
  );
}

test('runtime excludes a second live owner and permits reacquisition after disposal', async t => {
  const f = await fixture(t);
  const runtime = await makePodmanProviderListenerRuntime(f.options);
  t.teardown(runtime.dispose);
  await t.throwsAsync(() => makePodmanProviderListenerRuntime(f.options), {
    message: /already active/,
  });
  await runtime.dispose();
  await runtime.dispose();
  const again = await makePodmanProviderListenerRuntime(f.options);
  await again.dispose();
});

test.serial(
  'public runtime uses loopback without a privileged helper and exports fixed resolver evidence',
  async t => {
    t.timeout(5000);
    const f = await fixture(t, true);
    const runtime = await makePodmanProviderListenerRuntime(f.options);
    t.teardown(runtime.dispose);
    const listener = await runtime.start({
      endpoint: Far('unused inference', {}),
      limits,
      network: { endpoint: Far('test egress', {}) },
    });
    const observed = await listener.observe();
    t.deepEqual(observed.network, {
      policy: 'public-internet',
      proxyUrl: 'http://127.0.0.1:23457',
      dnsHost: '127.0.0.53',
      resolverConfigPath: join(f.options.stateDirectory, 'public-resolv.conf'),
    });
    t.false(f.calls.some(args => args[0] === 'run'));
    t.is(f.launches.length, 1);
    t.true(f.launches[0].includes('--cap-drop=ALL'));
    t.false(
      [...f.calls, ...f.launches].some(args =>
        args.some(
          arg =>
            arg.startsWith('--cap-add') ||
            arg === '--privileged' ||
            arg.startsWith('--privileged='),
        ),
      ),
    );
    await listener.stop();
  },
);

test('runtime requires explicit operator public network enablement', async t => {
  const f = await fixture(t);
  const runtime = await makePodmanProviderListenerRuntime(f.options);
  t.teardown(runtime.dispose);
  await t.throwsAsync(
    () =>
      runtime.start({
        endpoint: Far('unused inference', {}),
        limits,
        network: { endpoint: Far('test egress', {}) },
      }),
    { message: /not configured by the operator/ },
  );
});

test('runtime recovers a dead owner and sweeps only its exactly labelled orphan', async t => {
  const f = await fixture(t);
  await symlink('999999-1', join(f.options.stateDirectory, 'test-owner.lock'));
  f.orphan();
  const runtime = await makePodmanProviderListenerRuntime(f.options);
  t.teardown(runtime.dispose);
  t.deepEqual(f.removals, ['abcdef123456']);
});

test.serial(
  'controlled namespace admission preserves live workers until explicit disposal',
  async t => {
    // Two workers each permit two 10s startup handshakes and up to 6s
    // shutdown. Keep one finite deadline above that combined 52s budget,
    // including some headroom for scheduling and filesystem work in CI.
    t.timeout(60_000);
    t.log('creating runtime fixture');
    const f = await fixture(t);
    t.log('acquiring runtime');
    const runtime = await makePodmanProviderListenerRuntime(f.options);
    t.teardown(runtime.dispose);
    t.log('starting first worker');
    const first = await runtime.start({
      endpoint: Far('inference', {}),
      limits,
    });
    t.log('retrying cleanup with first worker live');
    await runtime.retryCleanup();
    t.is(f.removals.length, 0);
    t.log('starting second worker');
    const second = await runtime.start({
      endpoint: Far('inference', {}),
      limits,
    });
    t.log('observing both workers');
    t.not(
      (await first.observe()).containerName,
      (await second.observe()).containerName,
    );
    t.log('disposing both workers');
    await runtime.dispose();
    t.log('disposal completed');
    t.is(f.removals.length, 2);
  },
);

test.serial(
  'controlled namespace mismatch refuses admission and retries failed removal',
  async t => {
    // Startup permits two 10s handshakes, then cleanup can spend 1s per
    // stop attempt and 5s waiting for the child. Keep a finite test deadline
    // that lets those runtime deadlines finish on a busy CI worker.
    t.timeout(30_000);
    const f = await fixture(t);
    const runtime = await makePodmanProviderListenerRuntime(f.options);
    t.teardown(runtime.dispose);
    f.wrongNamespace();
    f.failRemoval();
    const error = await t.throwsAsync(
      () => runtime.start({ endpoint: Far('inference', {}), limits }),
      { instanceOf: AggregateError },
    );
    t.regex(error.errors[0].message, /isolation is not proved/);
    t.regex(error.errors[1].message, /removal failed/);
    f.allowRemoval();
    await runtime.retryCleanup();
    t.is(f.removals.length, 1);
  },
);

test.serial(
  'controlled PID replacement during procfs reads refuses admission',
  async t => {
    t.timeout(5000);
    const f = await fixture(t);
    const runtime = await makePodmanProviderListenerRuntime(f.options);
    t.teardown(runtime.dispose);
    f.racePid();
    await t.throwsAsync(
      () => runtime.start({ endpoint: Far('inference', {}), limits }),
      { message: /startup failed/ },
    );
    t.is(f.removals.length, 1);
  },
);

test('inert runtime and same-tick close perform no native acquisition', async t => {
  t.timeout(5000);
  const f = await fixture(t);
  const stateDirectory = join(f.options.stateDirectory, 'absent');
  const kit = makePodmanProviderListenerRuntimeKit({
    ...f.options,
    stateDirectory,
  });
  t.teardown(kit.close);
  await t.throwsAsync(() => lstat(stateDirectory), { code: 'ENOENT' });
  const opening = kit.open();
  const closing = kit.close();
  await t.throwsAsync(opening, { message: /disposed/ });
  await closing;
  await t.throwsAsync(() => lstat(stateDirectory), { code: 'ENOENT' });
  t.deepEqual(f.calls, []);
});

test('close drains a held identity read and fences subsequent lock acquisition', async t => {
  t.timeout(5000);
  const f = await fixture(t);
  let release = () => {};
  const pending = new Promise(resolve => {
    release = () => resolve('123');
  });
  let entered = () => {};
  const admission = new Promise(resolve => {
    entered = () => resolve(undefined);
  });
  const kit = makePodmanProviderListenerRuntimeKit({
    ...f.options,
    host: {
      ...f.options.host,
      readStart: async () => {
        entered();
        return pending;
      },
    },
  });
  t.teardown(async () => {
    release();
    await kit.close();
  });
  const opening = kit.open();
  const failedOpen = t.throwsAsync(opening, { message: /disposed/ });
  await admission;
  const closing = kit.close();
  let finished = false;
  void closing.then(() => {
    finished = true;
  });
  await Promise.resolve();
  t.false(finished);
  release();
  await failedOpen;
  await closing;
  await t.throwsAsync(
    () => readlink(join(f.options.stateDirectory, 'test-owner.lock')),
    { code: 'ENOENT' },
  );
  t.deepEqual(f.calls, []);
});

test('failed initialization sweep and failed lock release remain retryable', async t => {
  const f = await fixture(t);
  let failSweep = true;
  let failUnlink = true;
  const lockPath = join(f.options.stateDirectory, 'test-owner.lock');
  const kit = makePodmanProviderListenerRuntimeKit({
    ...f.options,
    host: {
      ...f.options.host,
      run: async args => {
        if (failSweep) throw Error('sweep failed');
        return f.options.host.run(args);
      },
      unlink: async path => {
        if (failUnlink) throw Error('lock release failed');
        await unlink(path);
      },
    },
  });
  t.teardown(async () => {
    failSweep = false;
    failUnlink = false;
    await kit.close();
  });
  await t.throwsAsync(kit.open(), { message: /sweep failed/ });
  await t.throwsAsync(kit.close(), { message: /sweep failed/ });
  t.truthy(await readlink(lockPath));
  failSweep = false;
  await t.throwsAsync(kit.close(), { message: /lock release failed/ });
  t.truthy(await readlink(lockPath));
  failUnlink = false;
  await kit.close();
  await t.throwsAsync(() => readlink(lockPath), { code: 'ENOENT' });
  // A successful old owner must not remove a new owner's marker.
  await symlink('successor', lockPath);
  await kit.close();
  t.is(await readlink(lockPath), 'successor');
});

test('resolver file handle survives failed initialization close for retry', async t => {
  const f = await fixture(t, true);
  let failClose = true;
  let closes = 0;
  const kit = makePodmanProviderListenerRuntimeKit({
    ...f.options,
    host: {
      ...f.options.host,
      open: async (path, flags, mode) => {
        const file = await open(path, flags, mode);
        return {
          writeFile: data => file.writeFile(data),
          chmod: permissions => file.chmod(permissions),
          close: async () => {
            closes += 1;
            if (failClose) throw Error('file close failed');
            await file.close();
          },
        };
      },
    },
  });
  t.teardown(async () => {
    failClose = false;
    await kit.close();
  });
  await t.throwsAsync(kit.open(), { message: /file close failed/ });
  await t.throwsAsync(kit.close(), { message: /file close failed/ });
  failClose = false;
  await kit.close();
  await kit.close();
  t.is(closes, 3);
  t.deepEqual(f.calls, []);
});

test('failed recovery reservation release is retained without removing a live foreign lock', async t => {
  const f = await fixture(t);
  const live = await makePodmanProviderListenerRuntime(f.options);
  t.teardown(live.dispose);
  let failRelease = true;
  const reservation = join(f.options.stateDirectory, 'test-owner.recover');
  const kit = makePodmanProviderListenerRuntimeKit({
    ...f.options,
    host: {
      ...f.options.host,
      rmdir: async path => {
        if (failRelease) throw Error('reservation release failed');
        await rmdir(path);
      },
    },
  });
  t.teardown(async () => {
    failRelease = false;
    await kit.close();
  });
  await t.throwsAsync(kit.open(), { message: /reservation release failed/ });
  await t.throwsAsync(kit.close(), { message: /reservation release failed/ });
  t.true((await lstat(reservation)).isDirectory());
  failRelease = false;
  await kit.close();
  await t.throwsAsync(() => lstat(reservation), { code: 'ENOENT' });
  t.truthy(await readlink(join(f.options.stateDirectory, 'test-owner.lock')));
  await live.dispose();
});

test.serial(
  'runtime close owns a listener acquired while shutdown is pending',
  async t => {
    t.timeout(5000);
    const f = await fixture(t);
    let release = () => {};
    const pending = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    let entered = () => {};
    const admission = new Promise(resolve => {
      entered = () => resolve(undefined);
    });
    let held = false;
    const kit = makePodmanProviderListenerRuntimeKit({
      ...f.options,
      host: {
        ...f.options.host,
        run: async args => {
          if (args[0] === 'inspect' && !held) {
            held = true;
            entered();
            await pending;
          }
          return f.options.host.run(args);
        },
      },
    });
    t.teardown(async () => {
      release();
      await kit.close();
    });
    const runtime = await kit.open();
    const starting = runtime.start({ endpoint: Far('inference', {}), limits });
    const rejected = t.throwsAsync(starting, { message: /startup failed/ });
    await admission;
    const closing = kit.close();
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    t.false(finished);
    release();
    await rejected;
    await closing;
    t.is(f.removals.length, 1);
    await t.throwsAsync(
      () => readlink(join(f.options.stateDirectory, 'test-owner.lock')),
      { code: 'ENOENT' },
    );
    await t.throwsAsync(
      () => runtime.start({ endpoint: Far('later', {}), limits }),
      { message: /disposed/ },
    );
  },
);

test('stale takeover retains its sweep before recovery reservation cleanup can fail', async t => {
  const f = await fixture(t);
  const lockPath = join(f.options.stateDirectory, 'test-owner.lock');
  const recoveryPath = join(f.options.stateDirectory, 'test-owner.recover');
  await symlink('999999-1', lockPath);
  f.orphan();
  let failRecovery = true;
  let failSweep = true;
  const kit = makePodmanProviderListenerRuntimeKit({
    ...f.options,
    host: {
      ...f.options.host,
      rmdir: async path => {
        if (failRecovery) throw Error('reservation release failed');
        await rmdir(path);
      },
      run: async args => {
        if (failSweep && args[0] === 'ps') throw Error('sweep failed');
        return f.options.host.run(args);
      },
    },
  });
  t.teardown(async () => {
    failRecovery = false;
    failSweep = false;
    await kit.close();
  });
  await t.throwsAsync(kit.open(), { message: /reservation release failed/ });
  const ownedIdentity = await readlink(lockPath);
  t.not(ownedIdentity, '999999-1');
  failRecovery = false;
  await t.throwsAsync(kit.close(), { message: /sweep failed/ });
  t.is(await readlink(lockPath), ownedIdentity);
  t.true((await lstat(recoveryPath)).isDirectory());
  t.deepEqual(f.removals, []);
  failSweep = false;
  await kit.close();
  t.deepEqual(f.removals, ['abcdef123456']);
  await t.throwsAsync(() => readlink(lockPath), { code: 'ENOENT' });
  await t.throwsAsync(() => lstat(recoveryPath), { code: 'ENOENT' });
});

test('retained listener stopped before its queue turn acquires no native child', async t => {
  t.timeout(5000);
  const f = await fixture(t);
  const runtime = await makePodmanProviderListenerRuntime(f.options);
  t.teardown(runtime.dispose);
  const kit = runtime.startKit({ endpoint: Far('unused', {}), limits });
  const stopping = kit.stop();
  await t.throwsAsync(kit.value, { message: /inactive/ });
  await stopping;
  t.is(f.launches.length, 0);
  t.is(f.removals.length, 0);
});

test.serial(
  'failed listener acquisition retains A-only cleanup while B stays live',
  async t => {
    t.timeout(5000);
    const f = await fixture(t);
    let bName;
    let failA = false;
    const runtime = await makePodmanProviderListenerRuntime({
      ...f.options,
      host: {
        ...f.options.host,
        run: async args => {
          const name = args.at(-1);
          if (bName !== undefined && name !== bName) {
            if (args[0] === 'inspect') throw Error('A admission failed');
            if (args[0] === 'rm' && failA) throw Error('A removal failed');
          }
          return f.options.host.run(args);
        },
      },
    });
    t.teardown(async () => {
      failA = false;
      await runtime.dispose();
    });
    const b = await runtime.start({ endpoint: Far('b', {}), limits });
    bName = (await b.observe()).containerName;
    failA = true;
    const a = runtime.startKit({ endpoint: Far('a', {}), limits });
    await t.throwsAsync(a.value, { message: /startup and cleanup failed/ });
    t.deepEqual(f.removals, []);
    await t.throwsAsync(a.stop(), { message: /A removal failed/ });
    failA = false;
    await a.stop();
    await a.stop();
    t.is(f.removals.length, 1);
    t.not(f.removals[0], bName);
    t.is((await b.observe()).containerName, bName);
    t.truthy(await readlink(join(f.options.stateDirectory, 'test-owner.lock')));
  },
);

test.serial(
  'per-listener stop drains its admitted acquisition before final removal',
  async t => {
    t.timeout(5000);
    const f = await fixture(t);
    let release = () => {};
    const pending = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    let entered = () => {};
    const admission = new Promise(resolve => {
      entered = () => resolve(undefined);
    });
    let held = false;
    const runtime = await makePodmanProviderListenerRuntime({
      ...f.options,
      host: {
        ...f.options.host,
        run: async args => {
          if (args[0] === 'inspect' && !held) {
            held = true;
            entered();
            await pending;
          }
          return f.options.host.run(args);
        },
      },
    });
    t.teardown(async () => {
      release();
      await runtime.dispose();
    });
    const kit = runtime.startKit({ endpoint: Far('inference', {}), limits });
    const rejected = t.throwsAsync(kit.value, { message: /startup failed/ });
    await admission;
    const stopping = kit.stop();
    t.is(kit.stop(), stopping);
    let finished = false;
    void stopping.then(() => {
      finished = true;
    });
    await Promise.resolve();
    t.false(finished);
    t.deepEqual(f.removals, []);
    release();
    await rejected;
    await stopping;
    await kit.stop();
    t.is(f.removals.length, 1);
    t.truthy(await readlink(join(f.options.stateDirectory, 'test-owner.lock')));
  },
);

test.serial(
  'listener error retains native close proof and scoped retry without stopping a sibling',
  async t => {
    t.timeout(15_000);
    const f = await fixture(t);
    let capture = false;
    let release = () => {};
    /** @type {EventEmitter | undefined} */
    let failedChild;
    let closed = () => {};
    const nativeClosed = new Promise(resolve => {
      closed = () => resolve(undefined);
    });
    const runtime = await makePodmanProviderListenerRuntime({
      ...f.options,
      host: {
        ...f.options.host,
        launch: args => {
          const child = f.options.host.launch(args);
          if (!capture) return child;
          // Keep actual pipes and child teardown, but hold delivery of the
          // lifecycle acknowledgement to the runtime until explicitly released.
          const lifecycle = Object.assign(new EventEmitter(), {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
          });
          child.on('error', error => lifecycle.emit('error', error));
          child.once('close', (...closeArgs) => {
            release = () => {
              lifecycle.emit('close', ...closeArgs);
            };
            closed();
          });
          failedChild = lifecycle;
          return lifecycle;
        },
      },
    });
    t.teardown(async () => {
      // AVA awaits teardowns in reverse order. Release before asking the
      // runtime to drain, including when an assertion fails while close waits.
      capture = false;
      for (const args of f.launches) {
        // eslint-disable-next-line no-await-in-loop
        await f.options.host.run(['rm', args[args.indexOf('--name') + 1]]);
      }
      if (failedChild) await nativeClosed;
      release();
      await runtime.dispose();
    });
    const b = await runtime.start({ endpoint: Far('b', {}), limits });
    const bName = (await b.observe()).containerName;
    capture = true;
    const a = runtime.startKit({ endpoint: Far('a', {}), limits });
    await a.value;
    if (failedChild === undefined)
      throw Error('Listener child was not acquired');
    failedChild.emit('error', Error('injected child error'));
    failedChild.emit('error', Error('repeated child error'));
    await t.throwsAsync(a.stop(), { message: /timed out/ });
    await nativeClosed;
    t.is((await b.observe()).containerName, bName);
    t.false(f.removals.includes(bName));
    t.truthy(await readlink(join(f.options.stateDirectory, 'test-owner.lock')));
    release();
    await a.stop();
    t.is((await b.observe()).containerName, bName);
  },
);

test.serial(
  'listener error promptly rejects an unfinished handshake',
  async t => {
    t.timeout(5000);
    const f = await fixture(t);
    const runtime = await makePodmanProviderListenerRuntime({
      ...f.options,
      host: {
        ...f.options.host,
        launch: args => {
          const child = f.options.host.launch(args);
          queueMicrotask(() => child.emit('error', Error('handshake failed')));
          return child;
        },
      },
    });
    t.teardown(runtime.dispose);
    const a = runtime.startKit({ endpoint: Far('a', {}), limits });
    await t.throwsAsync(a.value, { message: /startup failed/ });
    await a.stop();
    t.is(f.removals.length, 1);
  },
);
