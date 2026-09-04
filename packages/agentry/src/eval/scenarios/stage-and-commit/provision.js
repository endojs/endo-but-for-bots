// @ts-check
/// <reference types="ses"/>

import fs from 'node:fs';
import path from 'node:path';

import { initRepo, makePowersOver } from '../../repo.js';

/** @import { EndoGit } from '@endo/exo-git' */
/** @import { CodeModePower } from '@endo/agent-tools/code-mode/types.js' */

/**
 * Provision a real git repository for the stage-and-commit scenario.
 *
 * @param {object} options
 * @param {string} options.path Repository-relative path of the untracked file.
 * @param {string} options.content Its content.
 * @returns {Promise<{
 *   repoRoot: string,
 *   workspace: CodeModePower,
 *   git: EndoGit,
 *   shell: unknown,
 *   cleanup: () => Promise<void>,
 * }>}
 */
export const provisionStageAndCommitRepo = async ({
  path: filePath,
  content,
}) => {
  const { repoRoot, run, cleanup } = await initRepo({ branch: 'main' });
  const targetPath = path.resolve(repoRoot, filePath);
  const relativePath = path.relative(repoRoot, targetPath);
  if (
    relativePath === '' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    await cleanup();
    throw new Error('stage-and-commit path must stay within the repository');
  }
  try {
    await fs.promises.writeFile(path.join(repoRoot, '.keep'), '');
    await run(['add', '.keep']);
    await run(['commit', '-q', '-m', 'chore: initialize repository']);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, content);

    const { workspace, git, shell } = makePowersOver(repoRoot);
    return harden({ repoRoot, workspace, git, shell, cleanup });
  } catch (error) {
    await cleanup();
    throw error;
  }
};
harden(provisionStageAndCommitRepo);
