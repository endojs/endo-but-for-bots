// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { makeNativeGitBackend } from '@endo/git';
import { makeGit } from '@endo/exo-git';
import { makeMount, lineageOf } from '@endo/daemon/src/mount.js';
import { makeFilePowers } from '@endo/daemon/src/manager-node-powers.js';

/** @import { ExecutionContext } from 'ava' */

const execFileAsync = promisify(execFile);

/**
 * @param {string} cwd
 * @param {string[]} gitArguments
 */
export const git = async (cwd, gitArguments) => {
  const { stdout } = await execFileAsync('git', gitArguments, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  return stdout;
};

/**
 * A `Git` composed over a fresh one-commit repository, as `provideGit` builds
 * it over a physical mount: no daemon, but the same mount, backend and exo.
 *
 * @param {ExecutionContext} t
 */
export const makeWorkspaceGit = async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fae-ws-'));
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q', '-b', 'main']);
  await fs.promises.writeFile(path.join(root, 'README.md'), 'hello\n');
  await git(root, ['add', 'README.md']);
  await git(root, [
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=T',
    'commit',
    '-q',
    '-m',
    'init',
  ]);
  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({
    repoRoot: root,
    identity: { authorName: 'Fae Agent', authorEmail: 'fae@example.test' },
  });
  await backend.assertRepositoryRoot();
  return { git: makeGit({ mount, backend, lineageOf }), root };
};
