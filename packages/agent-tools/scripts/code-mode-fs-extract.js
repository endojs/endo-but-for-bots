// @ts-check
/// <reference types="ses"/>

/**
 * Filesystem-specific code-mode type extraction: the `workspace` declaration,
 * built with the generic TypeScript renderer from `@endo/platform`'s checked
 * `fs/extended` typedef source.
 *
 * `workspace` reads `packages/platform/src/fs/extended/types.ts` (the
 * `Filesystem` interface and the capability types it reaches), the same
 * authored source the `wrapBackend` exos are typechecked against. Named
 * parameters and concrete result records survive, where the runtime
 * `M.interface` guards would only have offered positional `arg0` names and
 * `Promise<unknown>` returns: the guards deliberately validate record shapes
 * loosely (`M.any()`), which is the right call at the trust boundary and the
 * wrong source for a prompt surface.
 *
 * The stream types this source reaches (`PassableReader`,
 * `PassableBytesReader`, `PassableBytesWriter`) live in `@endo/exo-stream`;
 * the shared extractor follows the `@endo/*` import and inlines them from
 * their real definitions.
 *
 * Guard-canonical DERIVATION for the filesystem (synthesizing the printed
 * types from `FilesystemInterface` instead of the TypeScript) is what this
 * module used to do and is now TABLED, matching the git decision: the guards
 * stay the runtime enforcement layer, and the divergence gate in
 * `test/code-mode-types.test.js` keeps the printed types aligned with them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  extractTsFileTextIR,
  renderDeclaration,
} from './code-mode-type-extract.js';

const FS_TYPES_TS_URL = new URL(
  '../../platform/src/fs/extended/types.ts',
  import.meta.url,
);

const WORKSPACE_ROOT_TYPE = 'Filesystem';

/**
 * Build the `workspace` IR from the checked `fs/extended` capability types.
 *
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildWorkspaceIR = () => {
  const fileName = fileURLToPath(FS_TYPES_TS_URL);
  return extractTsFileTextIR({
    fileName,
    text: readFileSync(fileName, 'utf8'),
    rootType: WORKSPACE_ROOT_TYPE,
  });
};
harden(buildWorkspaceIR);

/**
 * Render the `workspace` `{ aux, body }` declaration strings.
 *
 * @returns {Record<'workspace', { aux: string, body: string }>}
 */
export const buildFsTypeDeclarations = () =>
  harden({ workspace: renderDeclaration(buildWorkspaceIR()) });
harden(buildFsTypeDeclarations);
