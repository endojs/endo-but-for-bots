// @ts-check
/* global process */

/**
 * The `claude-sandbox/state-provider` caplet: host-backed durable per-session
 * state — each session's persistent Claude config directory, which holds the
 * conversation transcript — as one 0700 host directory per session under a
 * configured root, owned through the provider's `.owners/` markers (see
 * `@endo/hosted-agent/session-state-storage.js`). It returns host paths only;
 * the native controller binds the directory into the slice directly. To be
 * minted by `setup-host.js` (nothing mints it yet) with `@none`: it ignores
 * its powers and needs no daemon Mount facade.
 *
 * Formula env (to be set by `setup-host.js`) and the daemon-process fallback,
 * which must be `ENDO_`-prefixed to survive the daemon's `allowEnvPass` filter:
 *   ENDO_CLAUDE_STATE_DIR — absolute host root under which per-session state
 *     directories are created.
 *
 * @module
 */

import { Fail } from '@endo/errors';
import { makeSessionStateStorage } from '@endo/hosted-agent/session-state-storage.js';

/**
 * @param {unknown} _powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (_powers, _context, { env = {} } = {}) => {
  const stateRoot =
    env.ENDO_CLAUDE_STATE_DIR || process.env.ENDO_CLAUDE_STATE_DIR;
  if (typeof stateRoot !== 'string' || stateRoot === '') {
    throw Fail`ENDO_CLAUDE_STATE_DIR is required`;
  }
  return makeSessionStateStorage({ stateRoot });
};
harden(make);
