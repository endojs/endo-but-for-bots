// @ts-nocheck
/* global setTimeout */
/* eslint-disable import/order, no-empty-function */

import '@endo/init';
import test from 'ava';

import { make } from '../src/claude-client-module.js';

// The module's `make(powers, _context, { env })` runs with `powers`
// being the `@agent` host authority. Provisioning (mount → provideMount
// → slice.make, plus credential materialisation) is lazy: it fires on
// the first `send()`. We trigger that first send but never drain the
// returned reader, so the fake process's stdout is never iterated — the
// assertions are on what provisioning did (mount/provideMount/slice
// env), captured in closures outside the hardened mocks.

const makeFakeSlice = () => {
  let disposed = false;
  const slice = {
    async spawn(argv, opts) {
      return {
        argv: [...argv],
        opts,
        async stdout() {
          return harden({ kind: 'fake-stdout' });
        },
        async kill() {},
        async wait() {
          return harden({ code: 0, signal: null });
        },
      };
    },
    async dispose() {
      disposed = true;
    },
  };
  return { slice, isDisposed: () => disposed };
};

/**
 * Build a mock host agent (`@agent`) plus the caps it resolves by pet
 * name. `sliceBehavior` lets a test make `sandboxFactory.make` throw to
 * exercise the partial-failure cleanup path.
 */
const makeMockHost = ({
  fsName = 'my-fs',
  credName,
  credCap,
  sliceBehavior = 'ok',
} = {}) => {
  const mountCalls = [];
  const provideMountCalls = [];
  const sliceFactoryCalls = [];
  let unmounted = false;
  const fake = makeFakeSlice();

  const fsCap = { kind: 'fake-fs' };
  const mountHandle = {
    async unmount() {
      unmounted = true;
    },
  };
  const fsMounter = {
    async mount(fs, mountPoint, opts) {
      mountCalls.push({ fs, mountPoint, opts });
      return mountHandle;
    },
  };
  const sandboxFactory = {
    async make(opts) {
      sliceFactoryCalls.push(opts);
      if (sliceBehavior === 'throw') {
        throw new Error('slice mint failed');
      }
      return fake.slice;
    },
  };

  const registry = {
    'sandbox-factory': sandboxFactory,
    'fs-mounter': fsMounter,
    [fsName]: fsCap,
  };
  if (credName) registry[credName] = credCap;

  const hostAgent = {
    async lookup(name) {
      return registry[name];
    },
    async provideMount(path, petName) {
      const cap = { kind: 'workspace-mount', path, petName };
      provideMountCalls.push({ path, petName, cap });
      return cap;
    },
  };

  return {
    hostAgent,
    fsCap,
    mountCalls,
    provideMountCalls,
    sliceFactoryCalls,
    isUnmounted: () => unmounted,
    isDisposed: () => fake.isDisposed(),
  };
};

const baseEnv = (extra = {}) => ({
  SESSION_ID: 'my-claude-abc',
  CREATED_AT: '2026-01-01T00:00:00.000Z',
  FILESYSTEM_NAME: 'my-fs',
  WORKSPACE_MOUNT_POINT: '/tmp/claude-sandbox-my-claude-abc',
  WORKSPACE_PATH: '/workspace',
  BACKEND: 'podman',
  NETWORK: 'private',
  CLAUDE_ROOTFS: 'oci:example/claude:latest',
  ...extra,
});

test('make() requires SESSION_ID, FILESYSTEM_NAME, WORKSPACE_MOUNT_POINT', t => {
  const host = makeMockHost();
  t.throws(() => make(host.hostAgent, undefined, { env: {} }), {
    message: /SESSION_ID required/,
  });
  t.throws(
    () => make(host.hostAgent, undefined, { env: { SESSION_ID: 's' } }),
    { message: /FILESYSTEM_NAME required/ },
  );
  t.throws(
    () =>
      make(host.hostAgent, undefined, {
        env: { SESSION_ID: 's', FILESYSTEM_NAME: 'f' },
      }),
    { message: /WORKSPACE_MOUNT_POINT required/ },
  );
});

test('first send() mounts the workspace, registers a Mount cap, and mints the slice', async t => {
  const host = makeMockHost();
  const client = make(host.hostAgent, undefined, { env: baseEnv() });

  // Trigger lazy provisioning; we do not drain the reader (stdout is
  // never iterated).
  await client.send('hello');

  t.is(host.mountCalls.length, 1);
  t.is(host.mountCalls[0].fs, host.fsCap);
  t.is(host.mountCalls[0].mountPoint, '/tmp/claude-sandbox-my-claude-abc');
  t.true(host.mountCalls[0].opts.lazyUnmount);

  t.is(host.provideMountCalls.length, 1);
  t.is(host.provideMountCalls[0].path, '/tmp/claude-sandbox-my-claude-abc');

  t.is(host.sliceFactoryCalls.length, 1);
  const opts = host.sliceFactoryCalls[0];
  t.deepEqual(opts.rootfs, { kind: 'oci', ref: 'example/claude:latest' });
  t.is(opts.network, 'private');
  t.is(opts.cwd, '/workspace');
  t.is(opts.mounts[0].cap, host.provideMountCalls[0].cap);
  t.is(opts.mounts[0].innerPath, '/workspace');
  // No credential named → no secret env.
  t.deepEqual(opts.env, {});
});

test('provisioning is memoized across sends', async t => {
  const host = makeMockHost();
  const client = make(host.hostAgent, undefined, { env: baseEnv() });
  await client.send('one');
  await client.send('two');
  t.is(host.mountCalls.length, 1);
  t.is(host.sliceFactoryCalls.length, 1);
});

test('an apiKey credential lands in ANTHROPIC_API_KEY', async t => {
  const credCap = {
    async issue() {
      return {
        async materialise() {
          return 'sk-ant-secret';
        },
      };
    },
  };
  const host = makeMockHost({ credName: 'my-creds', credCap });
  const client = make(host.hostAgent, undefined, {
    env: baseEnv({ CREDENTIALS_NAME: 'my-creds' }),
  });
  await client.send('hello');
  t.is(host.sliceFactoryCalls[0].env.ANTHROPIC_API_KEY, 'sk-ant-secret');
});

test('an oauthToken credential lands in CLAUDE_CODE_OAUTH_TOKEN', async t => {
  let issuedTag;
  const credCap = {
    // eslint-disable-next-line no-underscore-dangle
    async __getMethodNames__() {
      return ['kind', 'issue', 'revoke', 'rotate', 'help'];
    },
    async kind() {
      return 'oauthToken';
    },
    async issue(tag) {
      issuedTag = tag;
      return {
        async materialise() {
          return 'sk-ant-oat-token';
        },
      };
    },
  };
  const host = makeMockHost({ credName: 'oauth-creds', credCap });
  const client = make(host.hostAgent, undefined, {
    env: baseEnv({ CREDENTIALS_NAME: 'oauth-creds' }),
  });
  await client.send('hello');
  t.is(issuedTag, 'my-claude-abc');
  const { env } = host.sliceFactoryCalls[0];
  t.is(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-token');
  t.is(env.ANTHROPIC_API_KEY, undefined);
});

test('a slice-mint failure unmounts the workspace and rejects the send', async t => {
  const host = makeMockHost({ sliceBehavior: 'throw' });
  const client = make(host.hostAgent, undefined, { env: baseEnv() });
  await t.throwsAsync(() => client.send('hello'), {
    message: /slice mint failed/,
  });
  // The 9P mount was released rather than leaked.
  t.is(host.mountCalls.length, 1);
  t.true(host.isUnmounted());
});

test('an unknown filesystem rejects the send', async t => {
  const host = makeMockHost();
  const client = make(host.hostAgent, undefined, {
    env: baseEnv({ FILESYSTEM_NAME: 'nope' }),
  });
  await t.throwsAsync(() => client.send('hello'), {
    message: /Unknown filesystem/,
  });
});

test('terminate() after provisioning disposes the slice and unmounts', async t => {
  const host = makeMockHost();
  const client = make(host.hostAgent, undefined, { env: baseEnv() });
  await client.send('hello');
  await client.terminate();
  t.true(host.isDisposed());
  t.true(host.isUnmounted());
  const status = await client.status();
  t.true(status.terminated);
});

const waitFor = async (pred, deadlineMs = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > deadlineMs) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 10));
  }
};

test('cancellation tears down the provisioned session', async t => {
  const host = makeMockHost();
  let cancel;
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  // `whenCancelled()` rejects with the cancellation reason.
  const context = { whenCancelled: () => cancelled };
  const client = make(host.hostAgent, context, { env: baseEnv() });

  await client.send('hello'); // provision the slice + mount
  t.is(host.sliceFactoryCalls.length, 1);

  cancel(new Error('Cancelled')); // daemon cancels/collects the formula

  await waitFor(() => host.isDisposed() && host.isUnmounted());
  t.true(host.isDisposed());
  t.true(host.isUnmounted());
});

test('cancellation before any use disposes nothing', async t => {
  const host = makeMockHost();
  let cancel;
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  const context = { whenCancelled: () => cancelled };
  make(host.hostAgent, context, { env: baseEnv() });

  cancel(new Error('Cancelled'));
  // Give the teardown a chance to (not) run.
  await new Promise(r => setTimeout(r, 50));
  t.is(host.sliceFactoryCalls.length, 0);
  t.is(host.mountCalls.length, 0);
  t.false(host.isUnmounted());
});

test('terminate() before any use creates nothing', async t => {
  const host = makeMockHost();
  const client = make(host.hostAgent, undefined, { env: baseEnv() });
  await client.terminate();
  t.is(host.mountCalls.length, 0);
  t.is(host.sliceFactoryCalls.length, 0);
  t.false(host.isUnmounted());
});
