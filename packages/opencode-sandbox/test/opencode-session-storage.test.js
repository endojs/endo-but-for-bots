// @ts-check
import '@endo/init';
import test from 'ava';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeOpencodeSessionStorage } from '../src/opencode-session-storage.js';

const profile = harden({
  uid: 1000,
  gid: 1000,
  memoryBytes: '536870912',
  cpuQuotaMicros: '200000',
  pids: 128,
  cpuPeriodMicros: 100_000,
  maxConcurrentOperations: 1,
});

/** @param {import('ava').ExecutionContext} t */
const fixture = async t => {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'endo-session-storage-')),
  );
  t.teardown(() => rm(base, { recursive: true, force: true }));
  const roots = harden({
    workspaceDir: path.join(base, 'workspaces'),
    mcpDir: path.join(base, 'private'),
  });
  const id = 'session-a-0123456789ab';
  const plan = harden({
    sessionId: 'session-a',
    sandboxSessionId: id,
    rootfs: `oci:example@sha256:${'a'.repeat(64)}`,
    networkPolicy: 'off',
    workspaceDir: path.join(roots.workspaceDir, id),
    workspaceMountPoint: path.join(base, 'mounts', id),
    mcpDir: path.join(roots.mcpDir, id, 'mcp'),
    mounterSocketDir: path.join(roots.mcpDir, id, '9p'),
    nativeProfile: profile,
  });
  /** @type {string[]} */
  const removedState = [];
  let stateFails = false;
  const stateStorage = harden({
    async removeSessionDirectory(sessionId) {
      if (stateFails) throw Error('state removal refused');
      removedState.push(sessionId);
    },
  });
  const populate = async () => {
    for (const directory of [
      plan.workspaceDir,
      plan.mcpDir,
      plan.mounterSocketDir,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // eslint-disable-next-line no-await-in-loop
      await writeFile(path.join(directory, 'file'), 'data');
    }
  };
  const exists = async directory =>
    access(directory).then(
      () => true,
      () => false,
    );
  const storage = makeOpencodeSessionStorage({ stateStorage, roots });
  return {
    base,
    roots,
    plan,
    storage,
    removedState,
    populate,
    exists,
    failState: () => {
      stateFails = true;
    },
  };
};

test('removal deletes the recorded directories, their private parent, then native state', async t => {
  const f = await fixture(t);
  await f.populate();
  await f.storage.remove(JSON.stringify(f.plan));
  t.false(await f.exists(f.plan.workspaceDir));
  t.false(await f.exists(f.plan.mcpDir));
  t.false(await f.exists(f.plan.mounterSocketDir));
  t.false(
    await f.exists(path.dirname(f.plan.mcpDir)),
    'empty private parent removed',
  );
  t.true(await f.exists(f.roots.mcpDir), 'root retained');
  t.true(await f.exists(f.roots.workspaceDir), 'root retained');
  t.deepEqual(f.removedState, [f.plan.sandboxSessionId]);
});

test('removal is repeatable after native state removal fails', async t => {
  const f = await fixture(t);
  await f.populate();
  f.failState();
  await t.throwsAsync(f.storage.remove(JSON.stringify(f.plan)), {
    message: /state removal refused/,
  });
  t.false(await f.exists(f.plan.workspaceDir));
  // Directories already gone; a retry reaches state removal again.
  const retry = makeOpencodeSessionStorage({
    stateStorage: harden({
      async removeSessionDirectory(sessionId) {
        f.removedState.push(sessionId);
      },
    }),
    roots: f.roots,
  });
  await retry.remove(JSON.stringify(f.plan));
  t.deepEqual(f.removedState, [f.plan.sandboxSessionId]);
});

test('a private parent that still holds a stranger is left in place', async t => {
  const f = await fixture(t);
  await f.populate();
  await writeFile(path.join(path.dirname(f.plan.mcpDir), 'stranger'), 'x');
  await f.storage.remove(JSON.stringify(f.plan));
  t.true(await f.exists(path.join(path.dirname(f.plan.mcpDir), 'stranger')));
});

/** @type {readonly [string, (plan: any, f: any) => Record<string, unknown>, RegExp][]} */
const refused = harden([
  [
    'a workspace outside its root',
    (plan, f) => ({ ...plan, workspaceDir: path.join(f.base, 'elsewhere') }),
    /"workspaceDir" .* is outside this session's directory/,
  ],
  [
    'a workspace equal to its root',
    (plan, f) => ({ ...plan, workspaceDir: f.roots.workspaceDir }),
    /"workspaceDir" .* is outside this session's directory/,
  ],
  [
    'a socket directory under the workspace root',
    (plan, f) => ({
      ...plan,
      mounterSocketDir: path.join(f.roots.workspaceDir, 'other'),
    }),
    /"mounterSocketDir" .* is outside this session's directory/,
  ],
  [
    "a workspace recorded under another session's directory",
    (plan, f) => ({
      ...plan,
      workspaceDir: path.join(f.roots.workspaceDir, 'victim-9999'),
    }),
    /"workspaceDir" .* is outside this session's directory/,
  ],
  [
    "a socket directory recorded under another session's directory",
    (plan, f) => ({
      ...plan,
      mounterSocketDir: path.join(f.roots.mcpDir, 'victim-9999', '9p'),
    }),
    /"mounterSocketDir" .* is outside this session's directory/,
  ],
]);

for (const [name, mutate, message] of refused) {
  test(`removal refuses ${name} before deleting anything`, async t => {
    const f = await fixture(t);
    await f.populate();
    await t.throwsAsync(f.storage.remove(JSON.stringify(mutate(f.plan, f))), {
      message,
    });
    t.true(await f.exists(f.plan.workspaceDir));
    t.deepEqual(f.removedState, []);
  });
}

test('a recorded path that became a symbolic link is refused, and the link survives', async t => {
  const f = await fixture(t);
  await f.populate();
  const elsewhere = path.join(f.base, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'keep'), 'x');
  await rm(f.plan.workspaceDir, { recursive: true, force: true });
  await symlink(elsewhere, f.plan.workspaceDir);
  await t.throwsAsync(f.storage.remove(JSON.stringify(f.plan)), {
    message: /"workspaceDir" is a symbolic link/,
  });
  t.true(await f.exists(path.join(elsewhere, 'keep')));
  t.true(await f.exists(f.plan.mcpDir), 'nothing removed');
  t.deepEqual(f.removedState, []);
});

test('storage roots must be normalized absolute paths', t => {
  const stateStorage = harden({
    async removeSessionDirectory() {
      await null;
    },
  });
  for (const bad of ['relative', '/', '/root/', '/root/../x']) {
    t.throws(
      () =>
        makeOpencodeSessionStorage({
          stateStorage,
          roots: { workspaceDir: bad, mcpDir: '/private' },
        }),
      { message: /storage root "workspace"/ },
    );
  }
});
