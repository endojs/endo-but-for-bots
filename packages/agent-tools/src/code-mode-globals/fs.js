// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '../code-mode/types.js' */

import { fsDeclarations } from '../../generated/code-mode-globals/fs-declarations.js';

/**
 * The generated TypeScript declarations for the two supported code-mode
 * filesystem surfaces. `workspace` is the raw daemon mount provisioned to a
 * code-mode session; `filesystem` is the extended Filesystem used by the
 * standalone local seams.
 * A consumer composing its own code-mode agent can read these directly to
 * inject the matching surface into a hand-built global.
 */
export { fsDeclarations };

/**
 * Build the code-mode global descriptor for the raw daemon mount bound as the
 * repository `workspace` by code-mode provisioning.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @returns {CodeModeGlobal}
 */
export const makeWorkspaceGlobal = ({ name, petName = name }) =>
  harden({
    name,
    petName,
    description: 'Daemon mount rooted at the repository workspace.',
    declaration: fsDeclarations.workspace,
  });
harden(makeWorkspaceGlobal);

/**
 * Build the code-mode global descriptor for a local extended Filesystem.
 * Standalone in-memory and node-fs seams use this surface rather than the raw
 * daemon mount bound by code-mode provisioning.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @returns {CodeModeGlobal}
 */
export const makeFilesystemGlobal = ({ name, petName = name }) =>
  harden({
    name,
    petName,
    description: 'Writable @endo/platform/fs/extended Filesystem.',
    declaration: fsDeclarations.filesystem,
  });
harden(makeFilesystemGlobal);
