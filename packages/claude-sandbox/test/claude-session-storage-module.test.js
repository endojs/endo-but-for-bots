// @ts-check
import '@endo/init';
import test from 'ava';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Far } from '@endo/far';

import { make } from '../src/claude-session-storage-module.js';
import { make as makeStateProvider } from '../src/claude-state-provider-module.js';

const profile = harden({
  uid: 1000,
  gid: 1000,
  memoryBytes: '536870912',
  cpuQuotaMicros: '200000',
  pids: 128,
  cpuPeriodMicros: 100_000,
  maxConcurrentOperations: 1,
});

const exists = async p =>
  access(p).then(
    () => true,
    () => false,
  );

test('the storage caplet requires both roots and removes one recorded plan through the state provider', async t => {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'claude-storage-')),
  );
  t.teardown(() => rm(base, { recursive: true, force: true }));
  const roots = {
    workspaceDir: path.join(base, 'ws'),
    mcpDir: path.join(base, 'private'),
  };
  /** @type {string[]} */
  const removedState = [];
  const stateStorage = Far('State', {
    async removeSessionDirectory(id) {
      removedState.push(id);
    },
  });
  t.throws(
    () =>
      make(stateStorage, undefined, { env: { CLAUDE_MCP_DIR: roots.mcpDir } }),
    {
      message: /CLAUDE_WORKSPACE_BASE_DIR is required/,
    },
  );
  t.throws(
    () =>
      make(stateStorage, undefined, {
        env: { CLAUDE_WORKSPACE_BASE_DIR: roots.workspaceDir },
      }),
    { message: /CLAUDE_MCP_DIR is required/ },
  );
  const storage = make(stateStorage, undefined, {
    env: {
      CLAUDE_WORKSPACE_BASE_DIR: roots.workspaceDir,
      CLAUDE_MCP_DIR: roots.mcpDir,
    },
  });
  const id = 'session-a-0123456789ab';
  const plan = {
    sessionId: 'session-a',
    sandboxSessionId: id,
    rootfs: `oci:example@sha256:${'a'.repeat(64)}`,
    networkPolicy: 'off',
    credentialKind: 'apiKey',
    workspaceDir: path.join(roots.workspaceDir, id),
    workspaceMountPoint: path.join(roots.mcpDir, id, 'workspace'),
    mcpDir: path.join(roots.mcpDir, id, 'mcp'),
    mounterSocketDir: path.join(roots.mcpDir, id, '9p'),
    nativeProfile: profile,
  };
  await Promise.all(
    [plan.workspaceDir, plan.mcpDir, plan.mounterSocketDir].map(directory =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );
  await storage.remove(JSON.stringify(plan));
  t.false(await exists(plan.workspaceDir));
  t.false(await exists(path.dirname(plan.mcpDir)), 'private parent removed');
  t.true(await exists(roots.mcpDir), 'root retained');
  t.deepEqual(removedState, [id]);
  // An OpenCode-shaped plan is not a Claude plan.
  await t.throwsAsync(
    storage.remove(JSON.stringify({ ...plan, credentialKind: undefined })),
    { message: /Claude credential kind must be one of/ },
  );
});

test.serial(
  'the state provider caplet requires its root, reads the formula env before the process env, and prepares owned directories',
  async t => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'claude-state-'));
    t.teardown(() => rm(base, { recursive: true, force: true }));
    // Hermetic against a deployment shell that exports the fallback.
    const previous = process.env.ENDO_CLAUDE_STATE_DIR;
    t.teardown(() => {
      if (previous === undefined) delete process.env.ENDO_CLAUDE_STATE_DIR;
      else process.env.ENDO_CLAUDE_STATE_DIR = previous;
    });
    delete process.env.ENDO_CLAUDE_STATE_DIR;
    t.throws(() => makeStateProvider(null, undefined, { env: {} }), {
      message: /ENDO_CLAUDE_STATE_DIR is required/,
    });
    process.env.ENDO_CLAUDE_STATE_DIR = path.join(base, 'ambient');
    const ambient = makeStateProvider(null, undefined, { env: {} });
    t.is(
      (await ambient.prepareSessionDirectory('session-b')).directory,
      path.join(base, 'ambient', 'session-b'),
      'the daemon-process fallback applies when the formula env is silent',
    );
    const provider = makeStateProvider(null, undefined, {
      env: { ENDO_CLAUDE_STATE_DIR: path.join(base, 'state') },
    });
    const { directory } = await provider.prepareSessionDirectory('session-a');
    t.is(
      directory,
      path.join(base, 'state', 'session-a'),
      'the formula env wins',
    );
    t.true(await exists(directory));
    await provider.removeSessionDirectory('session-a');
    t.false(await exists(directory));
  },
);
