// @ts-check

/**
 * Codex's daemon-owned session state authority: one host directory per session
 * under a configured root, with the ownership markers and symlink refusals the
 * shared `@endo/hosted-agent/session-state-storage.js` already implements for
 * Claude and OpenCode.
 *
 * It exists as a formula of its own rather than as part of the backend for the
 * reason Claude's and OpenCode's do: the backend caplet is pinned to a release
 * checkout and is re-minted on every setup run, and durable state must not be
 * re-created — or lose its markers — each time it is.
 *
 * `locateSessionDirectory` is the one method the shared storage does not
 * publish. Codex reads a thread checkpoint before it provisions anything, and
 * `prepareSessionDirectory` would create the directory to answer that, leaving
 * a state directory behind for a session that never started.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { makeStateStorageOperations } from '@endo/hosted-agent/session-state-storage.js';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { isAbsolute, normalize } from 'node:path';

export const CodexStateProviderInterface = M.interface('CodexStateProvider', {
  prepareSessionDirectory: M.call(M.string()).returns(M.promise()),
  removeSessionDirectory: M.call(M.string()).returns(M.promise()),
  locateSessionDirectory: M.call(M.string()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

/**
 * @param {unknown} value
 * @param {string} label
 */
export const assertCodexStateRoot = (value, label = 'ENDO_CODEX_STATE_DIR') => {
  (typeof value === 'string' &&
    value.length > 0 &&
    isAbsolute(value) &&
    normalize(value) === value &&
    value !== '/') ||
    Fail`${b(label)} must be a normalized, absolute, non-root path, got ${q(value)}`;
  return /** @type {string} */ (value);
};
harden(assertCodexStateRoot);

/**
 * @param {{ stateRoot: string }} options
 */
export const makeCodexStateProvider = ({ stateRoot }) => {
  const {
    prepareSessionDirectory,
    removeSessionDirectory,
    assertOwnedDirectory,
  } = makeStateStorageOperations(assertCodexStateRoot(stateRoot, 'stateRoot'));
  return makeExo('CodexStateProvider', CodexStateProviderInterface, {
    prepareSessionDirectory,
    removeSessionDirectory,
    /** @param {string} sessionId */
    locateSessionDirectory: async sessionId => {
      const directory = await assertOwnedDirectory(sessionId);
      return directory === undefined ? harden({}) : harden({ directory });
    },
    help: () =>
      'Owns one host directory per Codex session under a configured root: the audit journal, its anchors, and the thread checkpoint. Removal refuses a directory without this session’s ownership marker.',
  });
};
harden(makeCodexStateProvider);
