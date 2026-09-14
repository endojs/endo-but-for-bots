// @ts-check
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import {
  makeSessionStateStorage,
  makeStateStorageOperations,
} from '@endo/hosted-agent/session-state-storage.js';
import { M } from '@endo/patterns';

/**
 * Durable, host-backed session state for @endo/opencode-sandbox.
 *
 * opencode forces SQLite WAL, which needs same-host shared memory and must not
 * run on 9P/FUSE. This provider creates one host directory per session under a
 * configured root. Native storage preparation returns only a host path record;
 * it neither creates nor receives daemon Mount capabilities. The compatibility
 * provider composes that storage with host `provideMount` for existing callers.
 *
 * Ownership: a session's marker lives in a provider-owned `.owners/`
 * directory beside (never inside) the mounted session directory, so the
 * sandboxed guest — which gets the session directory rw — cannot delete or
 * rewrite it. Removal refuses an existing directory without that marker. The
 * provider operates only under its configured root and validated session id.
 * These APIs are host-only: a returned path is native placement information,
 * not guest filesystem authority or proof that a running sandbox has stopped.
 */

const MOUNT_DIRECTORY = 'opencode-state';

/** Default pet name for the state provider under the sandbox namespace. */
export const DEFAULT_STATE_PROVIDER_NAME = 'state-provider';
harden(DEFAULT_STATE_PROVIDER_NAME);

const OpencodeStateProviderInterface = M.interface('OpencodeStateProvider', {
  prepareSessionDirectory: M.call(M.string()).returns(M.promise()),
  removeSessionDirectory: M.call(M.string()).returns(M.promise()),
  provideSessionMount: M.call(M.string()).returns(M.promise()),
  removeSession: M.call(M.string()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Native state authority confined to one configured root; see
 * `@endo/hosted-agent/session-state-storage.js`.
 * @param {object} options
 * @param {string} options.stateRoot
 */
export const makeOpencodeStateStorage = ({ stateRoot }) =>
  makeSessionStateStorage({ stateRoot });
harden(makeOpencodeStateStorage);

/**
 * Compose native state with the legacy daemon Mount facade. New administrative
 * owners use only the data-returning methods; the legacy methods still acquire
 * Mount capabilities in this worker and are not suitable for that boundary.
 * @param {object} options
 * @param {any} options.hostAgent
 * @param {string} options.stateRoot
 */
export const makeOpencodeStateProvider = ({ hostAgent, stateRoot }) => {
  const {
    prepareSessionDirectory,
    removeSessionDirectory,
    assertOwnedDirectory,
  } = makeStateStorageOperations(stateRoot);

  /** @param {string} sessionId */
  const provideSessionMount = async sessionId => {
    const { directory } = await prepareSessionDirectory(sessionId);
    const name = [MOUNT_DIRECTORY, sessionId];
    if (!(await E(hostAgent).has(MOUNT_DIRECTORY))) {
      await E(hostAgent).makeDirectory([MOUNT_DIRECTORY]);
    }
    // Replace any stale mount name for this session before re-minting.
    if (await E(hostAgent).has(...name)) {
      await E(hostAgent).remove(...name);
    }
    return E(hostAgent).provideMount(directory, name);
  };

  /** @param {string} sessionId */
  const removeSession = async sessionId => {
    await assertOwnedDirectory(sessionId);
    const name = [MOUNT_DIRECTORY, sessionId];
    if (await E(hostAgent).has(...name)) {
      await E(hostAgent).remove(...name);
    }
    await removeSessionDirectory(sessionId);
  };

  return makeExo('OpencodeStateProvider', OpencodeStateProviderInterface, {
    prepareSessionDirectory,
    removeSessionDirectory,
    provideSessionMount,
    removeSession,
    help: () =>
      'Host-only native state: prepareSessionDirectory(sessionId) returns {directory}; removeSessionDirectory(sessionId) deletes owned storage after sandbox cleanup. Legacy provideSessionMount/removeSession additionally create/remove daemon Mount names.',
  });
};
harden(makeOpencodeStateProvider);
