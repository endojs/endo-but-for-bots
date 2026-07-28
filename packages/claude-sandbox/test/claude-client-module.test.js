// @ts-nocheck
/* eslint-disable import/order, no-empty-function */

import '@endo/init';
import test from 'ava';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { make, makeCancellationKit } from '../src/claude-client-module.js';

// The module's `make(powers, _context, { env })` runs with `powers`
// being the `@agent` host authority. Provisioning (mount → provideMount
// → slice.make, plus credential materialisation) is lazy: it fires on
// the first `send()`. We trigger that first send but never drain the
// returned reader, so the fake process's stdout is never iterated — the
// assertions are on what provisioning did (mount/provideMount/slice
// env), captured in closures outside the hardened mocks.

const makeFakeSlice = () => {
  let disposed = false;
  const spawnCalls = [];
  const slice = {
    async spawn(argv, opts) {
      spawnCalls.push({ argv: [...argv], opts });
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
  return { slice, spawnCalls, isDisposed: () => disposed };
};

/**
 * Build a mock host agent (`@agent`) plus the caps it resolves by pet
 * name. `sliceBehavior` lets a test make `sandboxFactory.make` throw to
 * exercise the partial-failure cleanup path.
 * @param root0
 * @param root0.credCap
 * @param root0.sliceBehavior
 * @param root0.filesystem
 */
const makeMockHost = ({
  credCap = null,
  sliceBehavior = 'ok',
  // Override the Filesystem cap the powers hands back; `null` simulates a
  // session whose filesystem could not be resolved.
  filesystem,
  // The Endo tool bridge Mount cap; `null` means the session has no bridge.
  mcpMountCap = null,
  // The dedicated persistent Claude config Filesystem cap; `null` means the
  // session was provisioned without one (older sessions / no CONFIG_* env).
  configFsCap = null,
} = {}) => {
  const mountCalls = [];
  const provideMountCalls = [];
  const sliceFactoryCalls = [];
  let unmounted = false;
  let removeMountCount = 0;
  const fake = makeFakeSlice();

  const fsCap = filesystem === undefined ? { kind: 'fake-fs' } : filesystem;
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

  // The per-session powers cap: the four caps by reference + a bounded
  // provideMount. No `lookup` — the client cannot resolve names.
  const powers = {
    async sandboxFactory() {
      return sandboxFactory;
    },
    async fsMounter() {
      return fsMounter;
    },
    async filesystem() {
      return fsCap;
    },
    async configFilesystem() {
      return configFsCap;
    },
    async credentials() {
      return credCap;
    },
    async provideMount(path, petName) {
      const cap = { kind: 'workspace-mount', path, petName };
      provideMountCalls.push({ path, petName, cap });
      return cap;
    },
    async removeMount() {
      removeMountCount += 1;
    },
    // The Endo tool bridge Mount cap bundled by reference (null unless the
    // session was provisioned with one).
    async mcpMount() {
      return mcpMountCap;
    },
  };

  return {
    powers,
    fsCap,
    mcpMountCap,
    mountCalls,
    provideMountCalls,
    sliceFactoryCalls,
    spawnCalls: fake.spawnCalls,
    isUnmounted: () => unmounted,
    isDisposed: () => fake.isDisposed(),
    removeMountCount: () => removeMountCount,
  };
};

const baseEnv = (extra = {}) => ({
  SESSION_ID: 'my-claude-abc',
  CREATED_AT: '2026-01-01T00:00:00.000Z',
  WORKSPACE_MOUNT_POINT: '/tmp/claude-sandbox-my-claude-abc',
  WORKSPACE_PATH: '/workspace',
  BACKEND: 'podman',
  NETWORK: 'private',
  CLAUDE_ROOTFS: 'oci:example/claude:latest',
  ...extra,
});

test('make() requires SESSION_ID and WORKSPACE_MOUNT_POINT', t => {
  const host = makeMockHost();
  t.throws(() => make(host.powers, undefined, { env: {} }), {
    message: /SESSION_ID required/,
  });
  // No FILESYSTEM_NAME requirement any more — the filesystem cap is passed
  // by reference through powers, not by env pet name.
  t.throws(() => make(host.powers, undefined, { env: { SESSION_ID: 's' } }), {
    message: /WORKSPACE_MOUNT_POINT required/,
  });
});

test('first send() mounts the workspace, registers a Mount cap, and mints the slice', async t => {
  const host = makeMockHost();
  const client = make(host.powers, undefined, { env: baseEnv() });

  // Draining the turn runs provisioning (the thing under test).
  await drain(await client.send('hello'));

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
  t.deepEqual(host.spawnCalls[0].opts.env, {
    HOME: '/tmp/claude-home',
    XDG_CONFIG_HOME: '/tmp/claude-home/.config',
    CLAUDE_CONFIG_DIR: '/tmp/claude-home/.claude',
    IS_SANDBOX: '1',
  });
});

test('an MCP bridge mounts the socket dir read-only and passes --mcp-config', async t => {
  const mcpMountCap = { kind: 'mcp-mount' };
  const host = makeMockHost({ mcpMountCap });
  const client = make(host.powers, undefined, {
    env: baseEnv({
      MCP_CONFIG_PATH: '/endo-mcp/mcp.json',
      MCP_INNER_DIR: '/endo-mcp',
    }),
  });
  await drain(await client.send('hello'));

  const { mounts } = host.sliceFactoryCalls[0];
  // Workspace mount first, then the read-only MCP bridge mount.
  t.is(mounts.length, 2);
  t.is(mounts[1].cap, mcpMountCap);
  t.is(mounts[1].innerPath, '/endo-mcp');
  t.is(mounts[1].mode, 'ro');

  const { argv } = host.spawnCalls[0];
  t.true(argv.includes('--mcp-config'));
  t.is(argv[argv.indexOf('--mcp-config') + 1], '/endo-mcp/mcp.json');
  t.true(argv.includes('--strict-mcp-config'));
});

test('without an MCP config the client mounts only the workspace', async t => {
  const host = makeMockHost({ mcpMountCap: { kind: 'mcp-mount' } });
  const client = make(host.powers, undefined, { env: baseEnv() });
  await drain(await client.send('hello'));
  t.is(host.sliceFactoryCalls[0].mounts.length, 1);
  t.false(host.spawnCalls[0].argv.includes('--mcp-config'));
});

test('without a config mount CLAUDE_CONFIG_DIR stays on the ephemeral tmpfs', async t => {
  // Older sessions (no CONFIG_* env) never call configFilesystem() and keep the
  // pre-persistence config location, so they remain functional after deploy.
  const host = makeMockHost();
  const client = make(host.powers, undefined, { env: baseEnv() });
  await drain(await client.send('hello'));
  t.is(host.mountCalls.length, 1);
  t.is(
    host.spawnCalls[0].opts.env.CLAUDE_CONFIG_DIR,
    '/tmp/claude-home/.claude',
  );
});

test('a config mount persists CLAUDE_CONFIG_DIR and resumes a prior transcript', async t => {
  // A fake config backing dir that already holds a Claude transcript, as it
  // would after a pre-restart turn.
  const configHostDir = await mkdtemp(nodePath.join(os.tmpdir(), 'claude-cfg-'));
  t.teardown(() => rm(configHostDir, { recursive: true, force: true }));
  const projectDir = nodePath.join(configHostDir, 'projects', '-workspace');
  await mkdir(projectDir, { recursive: true });
  await writeFile(nodePath.join(projectDir, 'session.jsonl'), '{"type":"user"}\n');

  const host = makeMockHost({ configFsCap: { kind: 'fake-config-fs' } });
  const client = make(host.powers, undefined, {
    env: baseEnv({
      CONFIG_MOUNT_POINT: '/tmp/claude-config-my-claude-abc',
      CONFIG_PET_NAME: 'claude-my-claude-abc-config',
      CLAUDE_CONFIG_INNER_DIR: '/claude-config',
      CLAUDE_CONFIG_HOST_DIR: configHostDir,
    }),
  });
  await drain(await client.send('after restart'));

  // Both the workspace and the config dir were mounted, and the config mount
  // was added to the slice at /claude-config, rw.
  t.is(host.mountCalls.length, 2);
  const configMount = host.sliceFactoryCalls[0].mounts.find(
    m => m.innerPath === '/claude-config',
  );
  t.truthy(configMount);
  t.is(configMount.mode, 'rw');

  // CLAUDE_CONFIG_DIR points at the persistent mount, not the ephemeral tmpfs.
  t.is(host.spawnCalls[0].opts.env.CLAUDE_CONFIG_DIR, '/claude-config');

  // The pre-restart transcript is detected, so the first turn resumes.
  t.true(host.spawnCalls[0].argv.includes('--continue'));
});

test('a config mount with an empty config dir starts a fresh conversation', async t => {
  const configHostDir = await mkdtemp(nodePath.join(os.tmpdir(), 'claude-cfg-'));
  t.teardown(() => rm(configHostDir, { recursive: true, force: true }));

  const host = makeMockHost({ configFsCap: { kind: 'fake-config-fs' } });
  const client = make(host.powers, undefined, {
    env: baseEnv({
      CONFIG_MOUNT_POINT: '/tmp/claude-config-my-claude-abc',
      CONFIG_PET_NAME: 'claude-my-claude-abc-config',
      CLAUDE_CONFIG_INNER_DIR: '/claude-config',
      CLAUDE_CONFIG_HOST_DIR: configHostDir,
    }),
  });
  await drain(await client.send('hello'));
  t.is(host.spawnCalls[0].opts.env.CLAUDE_CONFIG_DIR, '/claude-config');
  // No prior transcript → no resume on the first turn.
  t.false(host.spawnCalls[0].argv.includes('--continue'));
});

test('CONFIG_MOUNT_POINT set but no config cap aborts the turn', async t => {
  // persistConfig is true (CONFIG_* present) but powers.configFilesystem()
  // resolves null — a provisioning bug. Surface it loudly rather than silently
  // dropping persistence.
  const host = makeMockHost({ configFsCap: null });
  const client = make(host.powers, undefined, {
    env: baseEnv({
      CONFIG_MOUNT_POINT: '/tmp/claude-config-my-claude-abc',
      CONFIG_PET_NAME: 'claude-my-claude-abc-config',
      CLAUDE_CONFIG_INNER_DIR: '/claude-config',
    }),
  });
  const events = await drain(await client.send('hello'));
  const last = events[events.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /no config Filesystem cap/);
});

test('provisioning is memoized across sends', async t => {
  const host = makeMockHost();
  const client = make(host.powers, undefined, { env: baseEnv() });
  await drain(await client.send('one'));
  await drain(await client.send('two'));
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
  const host = makeMockHost({ credCap });
  const client = make(host.powers, undefined, { env: baseEnv() });
  await drain(await client.send('hello'));
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
  const host = makeMockHost({ credCap });
  const client = make(host.powers, undefined, { env: baseEnv() });
  await drain(await client.send('hello'));
  t.is(issuedTag, 'my-claude-abc');
  const { env } = host.sliceFactoryCalls[0];
  t.is(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-token');
  t.is(env.ANTHROPIC_API_KEY, undefined);
});

test('a slice-mint failure unmounts the workspace and aborts the turn', async t => {
  const host = makeMockHost({ sliceBehavior: 'throw' });
  const client = make(host.powers, undefined, { env: baseEnv() });
  // Provisioning failures surface as an `abort` event on the reader, not a
  // rejection of send() (the floot turn model).
  const events = await drain(await client.send('hello'));
  const last = events[events.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /slice mint failed/);
  // The 9P mount was released rather than leaked.
  t.is(host.mountCalls.length, 1);
  t.true(host.isUnmounted());
});

test('a missing filesystem cap aborts the turn', async t => {
  // powers.filesystem() resolves to null — the session has no workspace cap.
  const host = makeMockHost({ filesystem: null });
  const client = make(host.powers, undefined, { env: baseEnv() });
  const events = await drain(await client.send('hello'));
  const last = events[events.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /no Filesystem cap/);
});

test('terminate() after provisioning disposes the slice and unmounts', async t => {
  const host = makeMockHost();
  const client = make(host.powers, undefined, { env: baseEnv() });
  await drain(await client.send('hello'));
  await client.terminate();
  t.true(host.isDisposed());
  t.true(host.isUnmounted());
  // The workspace Mount pet name is reclaimed on teardown (no host-root leak).
  t.is(host.removeMountCount(), 1);
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

// Drain a turn's reply reader to completion. The fake slice's stdout is not a
// real @endo/exo-stream reader, so the producer's stdout read errors and the
// turn ends with an `abort` event — which is fine: by then provisioning (the
// thing under test) has already happened. Returns the collected events.
const drain = async reader => {
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

test('cancellation tears down the provisioned session', async t => {
  const host = makeMockHost();
  const { context, cancel } = makeCancellationKit();
  const client = make(host.powers, context, { env: baseEnv() });

  await drain(await client.send('hello')); // provision the slice + mount
  t.is(host.sliceFactoryCalls.length, 1);

  cancel(new Error('Cancelled')); // daemon cancels/collects the formula

  await waitFor(() => host.isDisposed() && host.isUnmounted());
  t.true(host.isDisposed());
  t.true(host.isUnmounted());
});

test('cancellation before any use disposes nothing', async t => {
  const host = makeMockHost();
  const { context, cancel } = makeCancellationKit();
  make(host.powers, context, { env: baseEnv() });

  cancel(new Error('Cancelled'));
  // Give the teardown a chance to (not) run.
  await new Promise(r => setTimeout(r, 50));
  t.is(host.sliceFactoryCalls.length, 0);
  t.is(host.mountCalls.length, 0);
  t.false(host.isUnmounted());
});

test('terminate() before any use creates nothing', async t => {
  const host = makeMockHost();
  const client = make(host.powers, undefined, { env: baseEnv() });
  await client.terminate();
  t.is(host.mountCalls.length, 0);
  t.is(host.sliceFactoryCalls.length, 0);
  t.false(host.isUnmounted());
});
