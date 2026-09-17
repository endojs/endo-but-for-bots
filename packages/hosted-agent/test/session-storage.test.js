// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSessionStorage } from '../src/session-storage.js';

test('dynamic-tool adapters remove private storage without inventing an MCP directory', async t => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'endo-dynamic-storage-')),
  );
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const privateRoot = join(root, 'private');
  const parent = join(privateRoot, 'session-a');
  const operatorWorkspace = join(root, 'operator');
  const plan = harden({
    sandboxSessionId: 'session-a',
    workspaceHostPath: operatorWorkspace,
    workspaceMountPoint: join(parent, 'workspace'),
    mounterSocketDir: join(parent, '9p'),
  });
  await mkdir(operatorWorkspace);
  await writeFile(join(operatorWorkspace, 'keep'), 'operator data');
  await mkdir(plan.workspaceMountPoint, { recursive: true });
  await mkdir(plan.mounterSocketDir);
  await writeFile(join(plan.mounterSocketDir, 'socket-record'), 'owned');
  const removed = [];
  const storage = makeSessionStorage({
    roots: { workspaceDir: join(root, 'workspaces'), mcpDir: privateRoot },
    readPlan: () => plan,
    stateStorage: harden({
      async removeSessionDirectory(id) {
        await t.throwsAsync(access(parent), { code: 'ENOENT' });
        removed.push(id);
      },
    }),
  });
  await storage.remove('{}');
  await storage.remove('{}');
  t.deepEqual(removed, ['session-a', 'session-a']);
  await t.notThrowsAsync(access(join(operatorWorkspace, 'keep')));
  await t.notThrowsAsync(access(privateRoot));
});
