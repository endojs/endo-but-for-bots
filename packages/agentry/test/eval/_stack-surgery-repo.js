// @ts-check

// The per-eval repository fixture for the stack-surgery scenario. It builds the
// intentionally messy branch graph with test-side git; the scenario scorer later
// reads only final repository state through the git capability.

import fs from 'node:fs';
import path from 'node:path';

import {
  EXPECTED_STACK_SURGERY_FILES,
  EXPECTED_STACK_SURGERY_SUMMARIES,
} from '../../src/eval/scenarios/stack-surgery/index.js';
import { initRepo, makePowersOver } from '../_eval-fixture.js';

export { EXPECTED_STACK_SURGERY_FILES, EXPECTED_STACK_SURGERY_SUMMARIES };

/**
 * @param {string} repoRoot
 * @param {string} filePath
 * @param {string} content
 * @returns {Promise<void>}
 */
export const writeRepoFile = async (repoRoot, filePath, content) => {
  const absolute = path.join(repoRoot, filePath);
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  await fs.promises.writeFile(absolute, content);
};
harden(writeRepoFile);

/**
 * @param {import('ava').ExecutionContext} t
 * @returns {Promise<{
 *   repoRoot: string,
 *   workspace: unknown,
 *   git: unknown,
 *   run: (args: string[]) => Promise<{ stdout: string, stderr: string }>,
 * }>}
 */
export const provisionStackSurgeryRepo = async t => {
  const { repoRoot, run } = await initRepo(t, {
    branch: 'main',
    prefix: 'agentry-eval-stack-surgery-',
  });

  await writeRepoFile(
    repoRoot,
    'alpha/index.js',
    `export const alphaName = 'alpha-base';\nexport const alphaMode = 'stable';\n`,
  );
  await writeRepoFile(
    repoRoot,
    'beta/index.js',
    `export const betaName = 'beta-base';\nexport const betaMode = 'stable';\n`,
  );
  await writeRepoFile(
    repoRoot,
    'gamma/index.js',
    `export const gammaName = 'gamma-base';\n`,
  );
  await writeRepoFile(
    repoRoot,
    'docs/stack.md',
    `# Stack Surgery\n\nBase workflow notes.\n`,
  );
  await run(['add', 'alpha', 'beta', 'gamma', 'docs']);
  await run(['commit', '-q', '-m', 'chore: initialize package domains']);

  await run(['switch', '-q', '-c', 'side/gamma-tooling']);
  await writeRepoFile(
    repoRoot,
    'gamma/tooling.js',
    `export const gammaTooling = () => 'ready';\n`,
  );
  await run(['add', 'gamma/tooling.js']);
  await run(['commit', '-q', '-m', 'feat(gamma): add tooling helper']);

  await run(['switch', '-q', 'main']);
  await run(['switch', '-q', '-c', 'side/docs-note']);
  await writeRepoFile(
    repoRoot,
    'docs/stack.md',
    `# Stack Surgery\n\nGamma tooling is replayed before this docs note.\n`,
  );
  await run(['add', 'docs/stack.md']);
  await run(['commit', '-q', '-m', 'docs: note stack surgery workflow']);

  await run(['switch', '-q', 'main']);
  await run(['switch', '-q', '-c', 'topic/stack-surgery']);
  await writeRepoFile(
    repoRoot,
    'alpha/index.js',
    `export const alphaName = 'alpha-stack';\nexport const alphaMode = 'mixed';\n`,
  );
  await writeRepoFile(
    repoRoot,
    'beta/index.js',
    `export const betaName = 'beta-stack';\nexport const betaMode = 'mixed';\n`,
  );
  await run(['add', 'alpha/index.js', 'beta/index.js']);
  await run(['commit', '-q', '-m', 'feat: update alpha and beta stack']);

  await writeRepoFile(
    repoRoot,
    'alpha/index.js',
    `export const alphaName = 'alpha-stack';\nexport const alphaMode = 'surgical';\n`,
  );
  await run(['add', 'alpha/index.js']);
  await run(['commit', '-q', '-m', 'fixup! feat: update alpha and beta stack']);

  await writeRepoFile(
    repoRoot,
    'beta/index.js',
    `export const betaName = 'beta-stack';\nexport const betaMode = 'isolated';\n`,
  );
  await run(['add', 'beta/index.js']);
  await run(['commit', '-q', '-m', 'fixup! feat: update alpha and beta stack']);

  await writeRepoFile(
    repoRoot,
    'beta/stack.test.js',
    `import { betaMode } from './index.js';\n\nexport const betaStackCovered = betaMode === 'isolated';\n`,
  );
  await run(['add', 'beta/stack.test.js']);
  await run(['commit', '-q', '-m', 'test: more coverage']);

  const { workspace, git } = makePowersOver(repoRoot);
  return harden({ repoRoot, workspace, git, run });
};
harden(provisionStackSurgeryRepo);
