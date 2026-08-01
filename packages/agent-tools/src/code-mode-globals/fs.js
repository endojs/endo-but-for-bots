// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '../code-mode/evaluate-tool.js' */

import { fsDeclarations } from '../../generated/code-mode-globals/fs-declarations.js';

/**
 * The filesystem exo's generated TypeScript declarations, keyed by code-mode
 * surface: `workspace` (the local adapter), `daemonMount` (the writable
 * daemon mount), and `daemonMountReadOnly` (its structural read-only view).
 * A consumer composing its own code-mode agent can read these directly to
 * inject the workspace types into a hand-built global.
 */
export { fsDeclarations };

/**
 * Build the code-mode global descriptor for a writable
 * `@endo/platform/fs/extended` Filesystem (the repository `workspace`).
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @returns {CodeModeGlobal}
 */
export const makeLocalFilesystemGlobal = ({ name, petName = name }) =>
  harden({
    name,
    petName,
    description:
      'Local @endo/platform/fs/extended Filesystem adapter; not a daemon EndoMount.',
    declaration: fsDeclarations.workspace,
  });
harden(makeLocalFilesystemGlobal);

/**
 * Backward-compatible name for the local platform filesystem adapter.
 * It remains distinct from `makeDaemonMountGlobal`, whose declaration is the
 * daemon's `EndoMount` contract rather than `@endo/platform/fs/extended`.
 *
 * @deprecated Use {@link makeLocalFilesystemGlobal}.
 */
export const makeWorkspaceGlobal = makeLocalFilesystemGlobal;
harden(makeWorkspaceGlobal);

/**
 * Build a code-mode global descriptor for a daemon-backed `EndoMount`.
 * `readOnly` selects the declaration matching the capability surface already
 * granted by the host; it does not mint or attenuate that capability.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @param {boolean} [options.readOnly] Describe the structural read-only view.
 * @returns {CodeModeGlobal}
 */
export const makeDaemonMountGlobal = ({
  name,
  petName = name,
  readOnly = false,
}) =>
  harden({
    name,
    petName,
    description: readOnly
      ? 'Read-only daemon EndoMount view (ReadableTree) for confined repository inspection.'
      : 'Read/write daemon EndoMount capability for a confined repository.',
    declaration: readOnly
      ? fsDeclarations.daemonMountReadOnly
      : fsDeclarations.daemonMount,
  });
harden(makeDaemonMountGlobal);
