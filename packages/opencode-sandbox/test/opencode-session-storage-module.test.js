// @ts-check
import '@endo/init';
import test from 'ava';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { make } from '../src/opencode-session-storage-module.js';

const options = harden({
  env: {
    OPENCODE_WORKSPACE_BASE_DIR: '/workspaces',
    OPENCODE_MCP_DIR: '/private',
  },
});

test('null-powered storage removes the recorded private directories without a provider', async t => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'opencode-null-storage-')),
  );
  t.teardown(() => rm(base, { recursive: true, force: true }));
  const roots = {
    workspace: join(base, 'workspaces'),
    private: join(base, 'private'),
  };
  const plan = {
    sessionId: 'one',
    sandboxSessionId: 'one',
    rootfs: `oci:localhost/opencode@sha256:${'a'.repeat(64)}`,
    networkPolicy: 'off',
    workspaceDir: join(roots.workspace, 'one'),
    workspaceMountPoint: join(roots.private, 'one', 'workspace'),
    mcpDir: join(roots.private, 'one', 'mcp'),
    mounterSocketDir: join(roots.private, 'one', '9p'),
    nativeProfile: {
      uid: 1000,
      gid: 1000,
      memoryBytes: '536870912',
      cpuQuotaMicros: '200000',
      pids: 128,
      cpuPeriodMicros: 100_000,
      maxConcurrentOperations: 1,
    },
  };
  await Promise.all(
    [
      plan.workspaceDir,
      plan.workspaceMountPoint,
      plan.mcpDir,
      plan.mounterSocketDir,
    ].map(directory => mkdir(directory, { recursive: true })),
  );
  const storage = await make(null, undefined, {
    env: {
      OPENCODE_WORKSPACE_BASE_DIR: roots.workspace,
      OPENCODE_MCP_DIR: roots.private,
    },
  });
  await storage.remove(JSON.stringify(plan));
  await storage.remove(JSON.stringify(plan));
  await t.throwsAsync(access(plan.workspaceDir), { code: 'ENOENT' });
  await t.throwsAsync(access(join(roots.private, 'one')), { code: 'ENOENT' });
});

test('storage accepts promised null powers and refuses capabilities', async t => {
  t.truthy(await make(null, undefined, options));
  t.truthy(await make(Promise.resolve(null), undefined, options));
  await t.throwsAsync(
    make(/** @type {any} */ (harden({})), undefined, options),
    {
      message: /requires null powers/,
    },
  );
});
