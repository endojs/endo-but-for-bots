// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvironmentRunnerKit } from '../src/environment-runner.js';

const id = `${'a'.repeat(64)}:${'b'.repeat(64)}`;
const recipe = harden({
  policy: { allowedCommands: ['sh'], timeoutMs: 1000, maxOutputBytes: 4096 },
  networkPolicy: 'off',
});
const gate = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};
test.beforeEach(t => t.timeout(5000));

/** @param {any} t */
const fixture = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'environment-test-'));
  t.teardown(() => rm(directory, { force: true, recursive: true }));
  const calls = [];
  let mountGate;
  const mountEntered = gate();
  let scopeFails = false;
  let launch;
  const scope = Far('Scope', {
    makeResolved: async options => {
      launch = options;
      calls.push('slice');
      return Far('Slice', {
        spawn: async argv => {
          calls.push(['spawn', argv]);
          const stdout = bytesReaderFromIterator(
            harden([new TextEncoder().encode('native disk')]),
          );
          const stderr = bytesReaderFromIterator(harden([]));
          return Far('Process', {
            stdout: () => stdout,
            stderr: () => stderr,
            stdin: () =>
              bytesWriterFromIterator(
                harden({
                  next: async () => harden({ value: undefined, done: false }),
                  return: async () => harden({ value: undefined, done: true }),
                }),
              ),
            wait: async () => harden({ code: 0, signal: null }),
            kill: async () => {},
          });
        },
      });
    },
    close: async () => {
      calls.push('scope-close');
      if (scopeFails) throw Error('scope cleanup pending');
    },
  });
  const native = Far('Native', {
    provideScope: async () => {
      calls.push('scope');
      return scope;
    },
  });
  const runtime = {
    openNative: async () => native,
    close: async () => {
      calls.push('runtime-close');
    },
  };
  const storage = {
    prepareSessionDirectory: async key => {
      calls.push(['prepare', key]);
      return { directory };
    },
    removeSessionDirectory: async key => {
      calls.push(['remove', key]);
    },
  };
  const makeMounter = () => ({
    mounter: Far('Mounter', {
      mount: async () => {
        calls.push('mount');
        mountEntered.resolve();
        await mountGate?.promise;
      },
    }),
    close: async () => {
      calls.push('unmount');
    },
  });
  const closed = gate();
  const listener = {
    open: async () => ({
      startKit: bootstrap => {
        calls.push(['network', bootstrap]);
        return {
          value: Promise.resolve({
            closed: closed.promise,
            observe: async () =>
              harden({
                containerName: 'only-network',
                network: {
                  policy: 'public-internet',
                  proxyUrl: 'http://127.0.0.1:23457',
                  dnsHost: '127.0.0.53',
                  resolverConfigPath: '/private/generated/resolv.conf',
                },
              }),
          }),
          stop: async () => {
            calls.push('network-stop');
          },
        };
      },
    }),
    close: async () => {
      calls.push('listener-close');
    },
  };
  const makeEgress = () => ({
    endpoint: Far('PublicEgress', {}),
    dispose: () => {
      calls.push('egress-dispose');
    },
  });
  const kit = makeEnvironmentRunnerKit(
    {
      directory,
      ownerId: 'test',
      imageRef: `localhost/base@sha256:${'c'.repeat(64)}`,
      publicInternet: true,
    },
    { runtime, listener, storage, makeMounter, makeEgress },
  );
  t.teardown(() => kit.close());
  const runner = await kit.open();
  const dependencies = Far('Dependencies', {
    get: async role => {
      t.is(role, 'workspace');
      calls.push('workspace');
      return Far('Mount', {});
    },
  });
  return {
    kit,
    runner,
    dependencies,
    calls,
    getLaunch: () => launch,
    blockMount: () => {
      mountGate = gate();
      return { ...mountGate, entered: mountEntered.promise };
    },
    failScope: value => {
      scopeFails = value;
    },
  };
};

test('native provisioning is inert and storage cannot be deleted before stop ACK', async t => {
  const f = await fixture(t);
  const controller = await E(f.runner).provideEnvironment(
    id,
    recipe,
    f.dependencies,
  );
  t.deepEqual(f.calls, []);
  await t.throwsAsync(E(f.runner).removeEnvironmentStorage(id), {
    message: /must stop/,
  });
  await E(controller).stop();
  await E(f.runner).removeEnvironmentStorage(id);
  t.is(f.calls.filter(c => Array.isArray(c) && c[0] === 'remove').length, 1);
});

test('Shell uses retained native HOME and exact projected workspace without scratch', async t => {
  const f = await fixture(t);
  const controller = await E(f.runner).provideEnvironment(
    id,
    recipe,
    f.dependencies,
  );
  const shell = await E(controller).open();
  const result = await E(shell).exec('sh', harden(['-c', 'true']));
  t.is(result.stdout, 'native disk');
  const launch = f.getLaunch();
  t.is(launch.network, 'none');
  t.is(launch.env.HOME, '/home/node');
  t.is(launch.env.CARGO_HOME, '/home/node/.cargo');
  t.is(launch.env.CARGO_TARGET_DIR, '/home/node/target');
  t.is(launch.scratchHostPath, '');
  t.deepEqual(
    launch.mounts.map(m => m.innerPath),
    ['/workspace', '/home/node'],
  );
  await E(controller).stop();
  t.true(f.calls.indexOf('scope-close') < f.calls.indexOf('unmount'));
  t.false(f.calls.some(c => Array.isArray(c) && c[0] === 'remove'));
});

test('network-only worker has no inference grant and only generated resolver bind', async t => {
  const f = await fixture(t);
  const controller = await E(f.runner).provideEnvironment(
    id,
    harden({ ...recipe, networkPolicy: 'public-internet' }),
    f.dependencies,
  );
  await E(controller).open();
  const bootstrap = f.calls.find(
    c => Array.isArray(c) && c[0] === 'network',
  )[1];
  t.deepEqual(Object.keys(bootstrap), ['network']);
  const launch = f.getLaunch();
  t.is(launch.networkRef, 'only-network');
  t.is(launch.env.HTTPS_PROXY, 'http://127.0.0.1:23457');
  t.deepEqual(launch.mounts.at(-1), {
    hostPath: '/private/generated/resolv.conf',
    innerPath: '/etc/resolv.conf',
    mode: 'ro',
  });
  await E(controller).stop();
  t.true(f.calls.indexOf('egress-dispose') < f.calls.indexOf('unmount'));
});

test('stop during mount drains late acquisition, never admits a slice, then unmounts', async t => {
  const f = await fixture(t);
  const mount = f.blockMount();
  const controller = await E(f.runner).provideEnvironment(
    id,
    recipe,
    f.dependencies,
  );
  const opened = t.throwsAsync(E(controller).open(), { message: /stopped/ });
  await mount.entered;
  const stop = E(controller).stop();
  mount.resolve();
  await opened;
  await stop;
  t.false(f.calls.includes('slice'));
  t.true(f.calls.includes('unmount'));
});

test('failed scope cleanup retains deletion fence and original mounter until retry', async t => {
  const f = await fixture(t);
  const controller = await E(f.runner).provideEnvironment(
    id,
    recipe,
    f.dependencies,
  );
  await E(controller).open();
  f.failScope(true);
  await t.throwsAsync(E(controller).stop(), { message: /cleanup pending/ });
  t.false(f.calls.includes('unmount'));
  await t.throwsAsync(E(f.runner).removeEnvironmentStorage(id), {
    message: /must stop/,
  });
  f.failScope(false);
  await E(controller).stop();
  await E(f.runner).removeEnvironmentStorage(id);
  t.true(f.calls.includes('unmount'));
});
