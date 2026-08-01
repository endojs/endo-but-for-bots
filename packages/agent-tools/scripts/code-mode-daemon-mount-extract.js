// @ts-check
/// <reference types="ses"/>

/**
 * Daemon-mount code-mode declarations from the focused prompt contract in
 * `src/code-mode-globals/daemon-mount-types.ts`.
 *
 * The contract is a flattened representation of `@endo/daemon`'s
 * `EndoMount`, `EndoMountFile`, and `ReadableTreeView` declarations.  The
 * runtime method-name divergence gate compares it with `MountInterface` and
 * `ReadableTreeInterface`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  extractTsFileTextIR,
  renderDeclaration,
} from './code-mode-type-extract.js';

const DAEMON_MOUNT_TYPES_URL = new URL(
  '../src/code-mode-globals/daemon-mount-types.ts',
  import.meta.url,
);

/**
 * @returns {{ daemonMount: import('./code-mode-type-extract.js').GlobalTypeIR, daemonMountReadOnly: import('./code-mode-type-extract.js').GlobalTypeIR }}
 */
export const buildDaemonMountIRs = () => {
  const fileName = fileURLToPath(DAEMON_MOUNT_TYPES_URL);
  const text = readFileSync(fileName, 'utf8');
  return harden({
    daemonMount: extractTsFileTextIR({
      fileName,
      text,
      rootType: 'DaemonMount',
    }),
    daemonMountReadOnly: extractTsFileTextIR({
      fileName,
      text,
      rootType: 'DaemonMountReadOnly',
    }),
  });
};
harden(buildDaemonMountIRs);

/**
 * @returns {Record<'daemonMount' | 'daemonMountReadOnly', { aux: string, body: string }>}
 */
export const buildDaemonMountTypeDeclarations = () => {
  const { daemonMount, daemonMountReadOnly } = buildDaemonMountIRs();
  return harden({
    daemonMount: renderDeclaration(daemonMount, { auxPrefix: 'Mount' }),
    daemonMountReadOnly: renderDeclaration(daemonMountReadOnly, {
      auxPrefix: 'ReadOnlyMount',
    }),
  });
};
harden(buildDaemonMountTypeDeclarations);
