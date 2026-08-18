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
 * The read-only vs writable split is a prompt-surface choice: a read-only
 * mount reuses the same `EndoMount` declaration — the type the guest reads is
 * the same in both cases — but its description states that mutating methods
 * reject at the capability, so the model is not told a read-only mount is
 * writable. Runtime read-only enforcement stays the mount cap; this only
 * governs how the prompt describes the authority the guest actually has.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @param {boolean} [options.readOnly] Describe a read-only mount whose mutating
 *   methods reject at the capability.
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
      ? 'Read-only daemon mount; mutating methods reject at the capability.'
      : 'Writable daemon mount rooted at the repository workspace.',
    declaration: fsDeclarations.workspace,
  });
harden(makeWorkspaceGlobal);

/**
 * Build the code-mode global descriptor for a local extended Filesystem.
 * Standalone in-memory and node-fs seams use this surface rather than the raw
 * daemon mount bound by code-mode provisioning.
 *
 * The read-only vs writable split follows the same rule as
 * {@link makeWorkspaceGlobal}: the read-only attenuator in
 * `@endo/platform/fs/extended` keeps every method of the `Filesystem`,
 * `Directory`, `File`, and `OpenFile` contracts present and callable — the
 * mutating ones reject with `EACCES` — so the declared type is genuinely the
 * same in both cases and only the description differs. Advertising a narrowed
 * type would tell the guest that methods it can in fact call do not exist;
 * stating that mutation rejects tells it the authority it actually holds.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @param {boolean} [options.readOnly] Describe a read-only Filesystem whose
 *   mutating methods reject at the capability.
 * @returns {CodeModeGlobal}
 */
export const makeFilesystemGlobal = ({
  name,
  petName = name,
  readOnly = false,
}) =>
  harden({
    name,
    petName,
    description: readOnly
      ? 'Read-only @endo/platform/fs/extended Filesystem; mutating methods reject with EACCES at the capability.'
      : 'Writable @endo/platform/fs/extended Filesystem.',
    declaration: fsDeclarations.filesystem,
  });
harden(makeFilesystemGlobal);
