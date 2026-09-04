// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '../code-mode/types.js' */

import { httpDeclarations } from '../../generated/code-mode-globals/http-declarations.js';

/** The HttpClient capability's generated TypeScript declaration. */
export { httpDeclarations };

/**
 * Build the code-mode global descriptor for a confined `HttpClient`.
 * The declaration describes the client and response capabilities, not the
 * host's policy grant or its controller facet.
 *
 * @param {object} options
 * @param {string} options.name JS-identifier lexical binding name.
 * @param {string | string[]} [options.petName] Pet name to look the capability
 *   up by; defaults to `name`.
 * @returns {CodeModeGlobal}
 */
export const makeHttpGlobal = ({ name, petName = name }) =>
  harden({
    name,
    petName,
    description:
      'Confined HttpClient capability for policy-bounded outbound requests.',
    declaration: httpDeclarations.http,
  });
harden(makeHttpGlobal);
