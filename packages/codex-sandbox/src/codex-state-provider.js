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
  prepareCliDirectory: M.call(M.string()).returns(M.promise()),
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
  const root = assertCodexStateRoot(stateRoot, 'stateRoot');
  const records = makeStateStorageOperations(root);
  // The leading dot cannot be a session id. Each CLI home and its ownership
  // marker are separate from host audit/checkpoint files, and only the home
  // leaf may be mounted rw into a sandbox.
  const cli = makeStateStorageOperations(`${root}/.cli`);
  return makeExo('CodexStateProvider', CodexStateProviderInterface, {
    prepareSessionDirectory: records.prepareSessionDirectory,
    /** @param {string} sessionId */
    prepareCliDirectory: async sessionId => {
      // Establish and validate the host-controlled ancestry before creating
      // the nested CLI root. Session lifecycle serialization belongs to the
      // daemon owner, as for all shared state-storage operations.
      await records.prepareSessionDirectory(sessionId);
      return cli.prepareSessionDirectory(sessionId);
    },
    /** @param {string} sessionId */
    removeSessionDirectory: async sessionId => {
      // Refuse an unowned tree before removing either half. Neither path is a
      // native-stop proof; the daemon storage owner supplies that barrier.
      await records.assertOwnedDirectory(sessionId);
      await cli.assertOwnedDirectory(sessionId);
      await cli.removeSessionDirectory(sessionId);
      await records.removeSessionDirectory(sessionId);
    },
    /** @param {string} sessionId */
    locateSessionDirectory: async sessionId => {
      const directory = await records.assertOwnedDirectory(sessionId);
      return directory === undefined ? harden({}) : harden({ directory });
    },
    help: () =>
      'Owns separate host records and guest-writable CLI home directories for each Codex session. Only the CLI home may enter the sandbox. Removal refuses unowned directories and requires the caller to have stopped native work.',
  });
};
harden(makeCodexStateProvider);
