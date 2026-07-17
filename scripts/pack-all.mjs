#!/usr/bin/env node
/**
 * @file Build a publishable .tgz for every public workspace using ts-node-pack.
 *
 * npm does not support swapping the pack engine, so we drive ts-node-pack
 * directly. Each tarball is written to `dist/` at the workspace root, named
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
 *   - `npm run pack:all` (dev / CI smoke)
 *   - `npm run release:npm` (publish flow, via release-npm.mjs)
 *   - `scripts/files.sh` (file inventory)
 *   - `scripts/compare-pack.mjs` (legacy-vs-new tarball diff)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { listPublicWorkspaces } from './workspaces.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const distDir = path.join(repoRoot, 'dist');

const workspaces = await listPublicWorkspaces(repoRoot);

if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

/** Run a child process to completion, inheriting stdio. */
const run = (cmd, argv, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });

for (const ws of workspaces) {
  const pkgDir = path.join(repoRoot, ws.location);
  process.stderr.write(`pack-all: ${ws.name}\n`);
  await run('npm', ['exec', '--', 'ts-node-pack', pkgDir], { cwd: distDir });
}

process.stderr.write(
  `\npack-all: ${workspaces.length} tarball(s) in ${path.relative(repoRoot, distDir)}/\n`,
);
