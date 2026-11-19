// @ts-check
// Scaffolding of the workspace git and image source tests
// (`resources/environments/impl/git.js`, `image-source.js`): a temporary
// environment directory with a real repository made the way the layout
// makes one, the module over it, and a "container" that runs plain git
// and writes files in the same worktree. AVA skips files starting with an
// underscore.
import '../unit/_m1a-prelude.js';

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  initWorkspaceRepository,
  makeWorkspaceGit,
} from '../../resources/environments/impl/git.js';

const execFileAsync = promisify(execFile);

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ makeBackend?: any, ensureWorkspace?: (key: string) => Promise<void> }} [options]
 */
export const makeWorkspaceFixture = async (t, options = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'thix-env-git-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const key = 'e1';
  const workspace = join(root, 'sessions', key, 'workspace');
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  let ready = false;
  const ensureWorkspace = async () => {
    if (ready) return;
    await mkdir(workspace, { recursive: true });
    await initWorkspaceRepository(workspace);
    ready = true;
  };
  /** @param {string} _key */
  const dirsOf = _key => harden({ workspace });
  const git = makeWorkspaceGit({
    dirsOf,
    ensureWorkspace: options.ensureWorkspace ?? ensureWorkspace,
    ...(options.makeBackend ? { makeBackend: options.makeBackend } : {}),
  });
  await ensureWorkspace();
  /**
   * The container's git: plain git in the worktree, its own home.
   * @param {string[]} args
   */
  const container = async args => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: workspace,
      env: {
        PATH: process.env.PATH || '',
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Container',
        GIT_AUTHOR_EMAIL: 'container@invalid.local',
        GIT_COMMITTER_NAME: 'Container',
        GIT_COMMITTER_EMAIL: 'container@invalid.local',
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  };
  /**
   * @param {string} path relative to the worktree
   * @param {string | Uint8Array} content
   */
  const write = async (path, content) => {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content);
  };
  /**
   * @param {string} op
   * @param {any[]} [args]
   * @param {{ readOnly?: boolean }} [runOptions]
   */
  const run = (op, args, runOptions) =>
    git.run(key, harden({ op, args: args ?? [] }), runOptions);
  return { root, key, workspace, dirsOf, git, run, container, write };
};
