// @ts-check
/// <reference types="ses"/>

/**
 * Filesystem-specific code-mode type extraction: the `workspace` declaration is
 * built from the daemon mount surface that the provisioning host actually
 * binds.
 *
 * The local `filesystem` declaration remains available for the package's
 * standalone in-memory and node-fs seams. It is deliberately separate from
 * `workspace`: those seams bind a `Filesystem`, while code-mode provisioning
 * binds a raw `EndoMount`.
 *
 * Both declarations use checked, type-only sources and the same generic
 * renderer. The mount source is a re-export of `@endo/daemon`'s own
 * `EndoMount`: the extractor flattens the interface inheritance and the
 * overloads it finds there and inlines the types it reaches, so the printed
 * contract is self-contained without a hand-maintained copy to drift.
 *
 * The runtime `M.interface` guards remain the enforcement layer. The
 * divergence gate in `test/code-mode-types.test.js` keeps both generated
 * declarations aligned with the capabilities they describe.
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

const DAEMON_MOUNT_TYPES_TS_URL = new URL(
  '../src/code-mode-globals/daemon-mount-types.ts',
  import.meta.url,
);

const FILESYSTEM_ROOT_TYPE = 'Filesystem';
const WORKSPACE_ROOT_TYPE = 'DaemonMount';

/**
 * Build the local Filesystem IR used by the standalone seam helpers.
 *
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildFilesystemIR = () => {
  const fileName = fileURLToPath(FS_TYPES_TS_URL);
  return extractTsFileTextIR({
    fileName,
    text: readFileSync(fileName, 'utf8'),
    rootType: FILESYSTEM_ROOT_TYPE,
  });
};
harden(buildFilesystemIR);

/**
 * Build the `workspace` IR from the daemon's own `EndoMount` contract, reached
 * through the checked re-export beside the code-mode globals.
 *
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildWorkspaceIR = () => {
  const fileName = fileURLToPath(DAEMON_MOUNT_TYPES_TS_URL);
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
 * @returns {Record<'filesystem' | 'workspace', { aux: string, body: string }>}
 */
export const buildFsTypeDeclarations = () =>
  harden({
    filesystem: renderDeclaration(buildFilesystemIR()),
    workspace: renderDeclaration(buildWorkspaceIR(), { auxPrefix: 'Mount' }),
  });
harden(buildFsTypeDeclarations);
