// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '../code-mode/types.js' */

import { shellDeclarations } from '../../generated/code-mode-globals/shell-declarations.js';

/**
 * The Shell capability's generated TypeScript declaration.
 * A host decides the command allowlist and other policy when it constructs the
 * capability; this descriptor only describes the granted capability.
 */
export { shellDeclarations };

/**
 * Build the code-mode global descriptor for an `@endo/exo-shell` Shell.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @returns {CodeModeGlobal}
 */
export const makeShellGlobal = ({ name, petName = name }) =>
  harden({
    name,
    petName,
    description:
      'Daemon-backed Shell capability with an allowlisted argv-only command surface.',
    declaration: shellDeclarations.shell,
  });
harden(makeShellGlobal);
