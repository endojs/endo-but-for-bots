/**
 * Tests for {@link git-clean-arguments.mjs}
 *
 * Run with: `yarn exec ava scripts/git-clean-arguments.test.mjs`
 *
 * @module
 */

import test from 'ava';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitCleanArguments } from './git-clean-arguments.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Make a scratch repository with the real `.gitignore`, a tracked file under
 * `.yarn/` (so `git clean` descends into it), the Yarn install state, an
 * installed dependency, and two stray ignored files.
 */
const makeScratchRepo = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-clean-arguments-'));
  /** @param {string[]} commandArguments */
  const git = (...commandArguments) =>
    execFileSync('git', commandArguments, { cwd: directory });
  git('init', '-q');
  await copyFile(join(repoRoot, '.gitignore'), join(directory, '.gitignore'));
  await mkdir(join(directory, '.yarn', 'patches'), { recursive: true });
  await writeFile(join(directory, '.yarn', 'patches', 'tracked.patch'), '');
  await writeFile(join(directory, '.yarn', 'install-state.gz'), '');
  await writeFile(join(directory, '.yarn', 'stray'), '');
  await mkdir(join(directory, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(directory, 'node_modules', 'dep', 'index.js'), '');
  await writeFile(join(directory, 'yarn-error.log'), '');
  git('add', '.gitignore', '.yarn/patches/tracked.patch');
  return { directory, git };
};

test('git clean preserves the install state and node_modules', async t => {
  const { directory, git } = await makeScratchRepo();
  git(...gitCleanArguments);
  t.true(existsSync(join(directory, '.yarn', 'install-state.gz')));
  t.true(existsSync(join(directory, 'node_modules', 'dep', 'index.js')));
  t.true(existsSync(join(directory, '.yarn', 'patches', 'tracked.patch')));
  t.false(existsSync(join(directory, '.yarn', 'stray')));
  t.false(existsSync(join(directory, 'yarn-error.log')));
});

test('without the negated exclude, git clean deletes the install state', async t => {
  const { directory, git } = await makeScratchRepo();
  const negatedExcludeIndex = gitCleanArguments.indexOf(
    '!.yarn/install-state.gz',
  );
  t.not(negatedExcludeIndex, -1);
  git(
    ...gitCleanArguments.slice(0, negatedExcludeIndex - 1),
    ...gitCleanArguments.slice(negatedExcludeIndex + 1),
  );
  t.false(existsSync(join(directory, '.yarn', 'install-state.gz')));
});

test('the root clean script uses the shared arguments', async t => {
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, 'package.json'), 'utf8'),
  );
  /** @param {string} argument */
  const quote = argument =>
    /^[\w./-]+$/.test(argument) ? argument : `'${argument}'`;
  t.is(
    packageJson.scripts.clean,
    ['git', ...gitCleanArguments].map(quote).join(' '),
  );
});
