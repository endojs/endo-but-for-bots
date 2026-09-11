// @ts-check
/* global process */

/**
 * The `opencode-sandbox/state-provider` caplet: the host-backed durable
 * session-state provider that creates one 0700 host directory per session and
 * returns a daemon Mount cap for it (see `opencode-state-provider.js` for why
 * opencode's SQLite WAL state cannot live on the 9P workspace). Minted by
 * `setup-host.js` with `@agent` powers, because the sandbox factory only
 * accepts Mount caps the daemon itself minted through `provideHostPath`.
 *
 * Formula env (set by `setup-host.js`) and the daemon-process fallback, which
 * must be `ENDO_`-prefixed to survive the daemon's `allowEnvPass` filter:
 *   ENDO_OPENCODE_STATE_DIR — absolute host root under which per-session state
 *     directories are created. Required here: `setup-host.js` defaults it to
 *     `/var/lib/endo/opencode-state` and records that choice in the minted
 *     formula, but this caplet never guesses a state location on its own.
 *
 * @module
 */

import { Fail } from '@endo/errors';

import { makeOpencodeStateProvider } from './opencode-state-provider.js';

/**
 * Caplet entry point.
 *
 * @param {any} hostAgent - `@agent` host powers (`provideMount`, `remove`,
 *   `makeDirectory`, `has`).
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [wrapper]
 * @returns {object} the OpencodeStateProvider exo.
 */
export const make = (hostAgent, _context, { env = {} } = {}) => {
  const stateRoot =
    env.ENDO_OPENCODE_STATE_DIR || process.env.ENDO_OPENCODE_STATE_DIR;
  if (!stateRoot) {
    throw Fail`ENDO_OPENCODE_STATE_DIR is required`;
  }
  return makeOpencodeStateProvider({ hostAgent, stateRoot });
};
harden(make);
