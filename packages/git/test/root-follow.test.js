// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeGit } from '@endo/exo-git';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { makeNativeGitBackend } from '../src/index.js';

/** @import { GitRootTransition } from '@endo/exo-git' */

const execFileAsync = promisify(execFile);

const within = (promise, label) =>
  Promise.race([
    promise,
    delay(5000).then(() => {
      throw new Error(`timed out: ${label}`);
    }),
  ]);

const commitFile = async (repoRoot, content, message) => {
  await fs.promises.writeFile(path.join(repoRoot, 'root.txt'), content);
  await execFileAsync('git', ['add', 'root.txt'], { cwd: repoRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', message],
    { cwd: repoRoot },
  );
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  });
  return stdout.trim();
};

test('native polling watcher preserves rapid external commit advancement', async t => {
  const repoRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'git-root-follow-'),
  );
  t.teardown(() => fs.promises.rm(repoRoot, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });

  const backend = makeNativeGitBackend({ repoRoot, rootPollIntervalMs: 10 });
  const mount = makeExo('NativeRootFollowTestMount', undefined, {});
  const git = makeGit(
    /** @type {Parameters<typeof makeGit>[0]} */ (
      /** @type {unknown} */ ({
        mount,
        backend,
        lineageOf: () => undefined,
      })
    ),
  );
  const roots = iterateReader(E(git).followRootChanges());
  t.deepEqual(await roots.next(), {
    done: false,
    value: { type: 'snapshot', revision: 0n, position: null },
  });
  // Publish immediately after the snapshot. The provider passes that exact
  // position into the watcher so this handoff has no observation gap.
  const commit1 = await commitFile(repoRoot, 'one\n', 'one');
  const commit2 = await commitFile(repoRoot, 'two\n', 'two');

  const first = /** @type {GitRootTransition} */ (
    (await within(roots.next(), 'first external commit')).value
  );
  const second = /** @type {GitRootTransition} */ (
    (await within(roots.next(), 'second external commit')).value
  );
  t.like(first, {
    type: 'transition',
    fromRevision: 0n,
    toRevision: 1n,
    position: {
      commitOid: commit1,
      tree: { algorithm: 'git-sha1-tree' },
    },
  });
  t.like(second, {
    type: 'transition',
    fromRevision: 1n,
    toRevision: 2n,
    position: {
      commitOid: commit2,
      tree: { algorithm: 'git-sha1-tree' },
    },
  });
  t.not(first.position.tree.hash, second.position.tree.hash);

  const firstFile = /** @type {any} */ (
    await E(await E(first.position.root).root()).lookup('root.txt')
  );
  const firstBlob = await E(firstFile).snapshot();
  const firstInfo = await E(firstBlob).getInfo();
  const { stdout: firstBlobOid } = await execFileAsync(
    'git',
    ['rev-parse', `${commit1}:root.txt`],
    { cwd: repoRoot },
  );
  t.is(firstInfo.hash, firstBlobOid.trim());

  await roots.return();
});
