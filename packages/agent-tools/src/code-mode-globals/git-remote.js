// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '../code-mode/types.js' */

import { gitRemoteDeclarations } from '../../generated/code-mode-globals/git-remote-declarations.js';

/** The GitRemote capability's generated TypeScript declaration. */
export { gitRemoteDeclarations };

/**
 * Build the code-mode global descriptor for a granted `GitRemote`.
 * The controller, credentials, and endpoint construction authority remain
 * outside the guest-facing descriptor.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @returns {CodeModeGlobal}
 */
export const makeGitRemoteGlobal = ({ name, petName = name }) =>
  harden({
    name,
    petName,
    description:
      'Granted GitRemote capability for policy-bounded fetch, pull, push, and inspection.',
    declaration: gitRemoteDeclarations.gitRemote,
  });
harden(makeGitRemoteGlobal);
