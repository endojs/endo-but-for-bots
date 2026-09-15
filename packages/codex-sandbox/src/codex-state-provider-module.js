// @ts-check

/**
 * `make-unconfined` entry point for `codex-sandbox/state-provider`.
 *
 * Constructed with slot-free `null` powers: this provider is filesystem
 * authority over one configured root and imports no daemon host authority.
 * OpenCode's equivalent takes `@agent` because its legacy client facade needs
 * `provideMount`; Codex's state never becomes a daemon Mount, so it needs none.
 *
 * @module
 */

import { Fail } from '@endo/errors';

import {
  assertCodexStateRoot,
  makeCodexStateProvider,
} from './codex-state-provider.js';

/**
 * @param {null | Promise<null>} powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env = {} } = {}) => {
  // Read the configuration before waiting for powers, so a misconfigured root
  // is refused whether or not the powers slot ever resolves.
  const stateRoot = assertCodexStateRoot(env.ENDO_CODEX_STATE_DIR);
  (await powers) === null || Fail`Codex state provider requires null powers`;
  return makeCodexStateProvider({ stateRoot });
};
harden(make);
