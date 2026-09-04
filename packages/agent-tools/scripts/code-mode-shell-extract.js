// @ts-check
/// <reference types="ses"/>

/**
 * Shell code-mode declarations from `@endo/exo-shell`'s checked TypeScript
 * source.  The runtime `ShellInterface` is checked separately for method
 * parity.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  extractTsFileTextIR,
  renderDeclaration,
} from './code-mode-type-extract.js';

const SHELL_TYPES_URL = new URL(
  '../../exo-shell/src/types.ts',
  import.meta.url,
);

/**
 * @returns {import('./code-mode-type-extract.js').GlobalTypeIR}
 */
export const buildShellIR = () => {
  const fileName = fileURLToPath(SHELL_TYPES_URL);
  return extractTsFileTextIR({
    fileName,
    text: readFileSync(fileName, 'utf8'),
    rootType: 'EndoShell',
  });
};
harden(buildShellIR);

/**
 * @returns {{ shell: { aux: string, body: string } }}
 */
export const buildShellTypeDeclarations = () =>
  harden({
    shell: renderDeclaration(buildShellIR(), {
      globalName: 'shell',
      auxPrefix: 'Shell',
    }),
  });
harden(buildShellTypeDeclarations);
