#!/usr/bin/env node
/**
 * @file Build a publishable .tgz for every public workspace with pnpm.
 *
 * Each tarball is written to `dist/` at the workspace root, named
 * `<scope>-<name>-<version>.tgz`.
 *
 * Freshness guarantee: `dist/` is recursively removed before this script
 * writes anything. There is no incremental mode, no skip-if-newer path, no
 * way to leave a stale `.tgz` behind from a previous run. Combined with
 * `release-npm.mjs` invoking this script unconditionally before publish,
 * the published tarballs are always a function of the current source tree
 * and nothing else. (If you bypass `release:npm` and `npm publish dist/*.tgz`
 * manually after editing source without re-packing, that's on you.)
 *
 * Used by:
 *   - `pnpm pack:all` (dev / CI smoke)
 *   - `pnpm release:npm` (publish flow, via release-npm.mjs)
 *   - `scripts/files.sh` (file inventory)
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @import {SpawnOptions} from 'node:child_process';
 */

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const distDir = path.join(repoRoot, 'dist');

/**
 * Parse and validate pnpm's workspace list before using it to select packages
 * for publication. A missing `private` flag must fail closed: publishing a
 * private package is worse than refusing an ambiguous release.
 *
 * @param {string} json
 * @returns {{path: string, name?: string, private?: boolean}[]}
 */
const parsePnpmWorkspaceList = json => {
  let entries;
  try {
    entries = JSON.parse(json.trim() || '[]');
  } catch (error) {
    throw new Error(
      `pnpm -r list --depth -1 --json returned invalid JSON: ${error.message}`,
      { cause: error },
    );
  }
  if (!Array.isArray(entries)) {
    throw new TypeError('pnpm -r list --depth -1 --json must return an array');
  }
  return entries;
};

/**
 * @param {{path: string, name?: string, private?: boolean}[]} entries
 */
const getPublicWorkspaces = entries =>
  entries.filter(workspace => {
    if (!workspace.name) return false;
    if (workspace.private === true) return false;
    if (workspace.private !== false) {
      throw new Error(
        `pnpm workspace ${workspace.name} has no boolean private flag; refusing to pack it`,
      );
    }
    return true;
  });

// Ask pnpm directly so the public package set comes from the workspace graph.
const { stdout: listStdout } = await execFileAsync(
  'pnpm',
  ['-r', 'list', '--depth', '-1', '--json'],
  { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
);
const workspaces = getPublicWorkspaces(parsePnpmWorkspaceList(listStdout));

if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

/**
 * Run a command, inheriting stdio; reject on non-zero exit.
 * @param {string} cmd
 * @param {string[]} argv
 * @param {SpawnOptions} options
 */
const run = (cmd, argv, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });

for (const ws of workspaces) {
  const pkgDir = ws.path;
  process.stderr.write(`pack-all: ${ws.name}\n`);
  await run('pnpm', ['pack', '--pack-destination', distDir], { cwd: pkgDir });
}

process.stderr.write(
  `\npack-all: ${workspaces.length} tarball(s) in ${path.relative(repoRoot, distDir)}/\n`,
);
