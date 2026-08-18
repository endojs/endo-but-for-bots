// @ts-check
/// <reference types="ses"/>

/**
 * GitRemote code-mode declarations from `@endo/exo-git`'s checked TypeScript
 * source.  The runtime `GitRemoteInterface` method surface is checked
 * separately for parity (`code-mode-types.test.js`); its result-shape guards
 * are exercised through the real exo in
 * `packages/daemon/test/git-remote.test.js`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  extractTsFileTextIR,
  renderDeclaration,
} from './code-mode-type-extract.js';

const GIT_REMOTE_TYPES_URL = new URL(
  '../../exo-git/src/types.ts',
  import.meta.url,
);

/**
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildGitRemoteIR = () => {
  const fileName = fileURLToPath(GIT_REMOTE_TYPES_URL);
  return extractTsFileTextIR({
    fileName,
    text: readFileSync(fileName, 'utf8'),
    rootType: 'GitRemote',
  });
};
harden(buildGitRemoteIR);

/**
 * @returns {{ gitRemote: { aux: string, body: string } }}
 */
export const buildGitRemoteTypeDeclarations = () =>
  harden({
    gitRemote: renderDeclaration(buildGitRemoteIR(), {
      globalName: 'gitRemote',
      auxPrefix: 'Remote',
    }),
  });
harden(buildGitRemoteTypeDeclarations);
