// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '../code-mode/evaluate-tool.js' */

import { fsDeclarations } from '../../generated/code-mode-globals/fs-declarations.js';

/**
 * The filesystem exo's generated TypeScript declarations, keyed by code-mode
 * surface: `workspace` (writable) and `workspaceReadOnly` (inspection only).
 * A consumer composing its own code-mode agent can read these directly to
 * inject the workspace types into a hand-built global.
 */
export { fsDeclarations };

/**
 * Build the code-mode global descriptor for an
 * `@endo/platform/fs/extended` repository Filesystem.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @param {boolean} [options.readOnly] Select the inspection-only prompt
 *   declaration and description.
 * @returns {CodeModeGlobal}
 */
export const makeWorkspaceGlobal = ({
  name,
  petName = name,
  readOnly = false,
}) =>
  harden({
    name,
    petName,
    description: readOnly
      ? 'Read-only @endo/platform/fs/extended Filesystem for repository inspection.'
      : 'Writable @endo/platform/fs/extended Filesystem for the repository.',
    declaration: readOnly
      ? fsDeclarations.workspaceReadOnly
      : fsDeclarations.workspace,
  });
harden(makeWorkspaceGlobal);
