// @ts-check
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
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

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MOUNT_DIRECTORY = 'opencode-state';
const OWNERS_DIRECTORY = '.owners';

/** @param {string} nativePath */
const lstatIfPresent = async nativePath => {
  try {
    return await lstat(nativePath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return undefined;
    }
    // A failed observation is not proof that cleanup has already completed.
    throw error;
  }
};

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
 * @param {string} stateRoot - absolute host directory for session state.
 */
const makeStateStorageOperations = stateRoot => {
  (typeof stateRoot === 'string' && path.isAbsolute(stateRoot)) ||
    Fail`stateRoot must be an absolute path`;

  /** @param {string} sessionId */
  const sessionPaths = sessionId => {
    SESSION_ID_PATTERN.test(sessionId) || Fail`Invalid session id`;
    return harden({
      // Concatenation (not path.resolve) so a crafted id cannot escape; the
      // id pattern already forbids separators, and this makes it explicit.
      directory: `${stateRoot}/${sessionId}`,
      ownerMarker: `${stateRoot}/${OWNERS_DIRECTORY}/${sessionId}`,
    });
  };

  /**
   * The `.owners/` directory is provider-owned and sits outside the mounted
   * session dir. Refuse to follow a symlink at its path: chmod/mkdir through
   * one would let a stale or planted link redirect provider writes to an
   * arbitrary host path.
   *
   * @param {string} resolvedRoot - canonical state root (already symlink-free)
   */
  const inspectOwnersDirectory = async resolvedRoot => {
    const owners = `${stateRoot}/${OWNERS_DIRECTORY}`;
    const info = await lstatIfPresent(owners);
    if (info?.isSymbolicLink()) {
      throw Fail`Ownership directory must not be a symlink: ${owners}`;
    }
    if (info && !info.isDirectory()) {
      throw Fail`Ownership directory is not a directory: ${owners}`;
    }
    if (info) {
      (await realpath(owners)) === `${resolvedRoot}/${OWNERS_DIRECTORY}` ||
        Fail`Ownership directory contains symbolic links`;
    }
    return info;
  };

  /** @param {string} resolvedRoot */
  const ensureOwnersDirectory = async resolvedRoot => {
    const owners = `${stateRoot}/${OWNERS_DIRECTORY}`;
    if (!(await inspectOwnersDirectory(resolvedRoot))) {
      try {
        await mkdir(owners, { mode: 0o700 });
      } catch (error) {
        // A concurrent preparation may have won the create; re-verify
        // below instead of failing the session.
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') {
          throw error;
        }
      }
    }
    await inspectOwnersDirectory(resolvedRoot);
    await chmod(owners, 0o700);
    return owners;
  };

  /**
   * Classify an ownership marker without ever following a symlink at its path:
   * a planted link could otherwise redirect reads (or the later write) at a
   * file outside the state tree.
   *
   * @param {string} ownerMarker
   * @param {string} sessionId
   * @returns {Promise<'absent' | 'owned' | 'foreign'>}
   */
  const readMarkerState = async (ownerMarker, sessionId) => {
    const info = await lstatIfPresent(ownerMarker);
    if (!info) return 'absent';
    info.isSymbolicLink() &&
      Fail`Ownership marker must not be a symlink: ${ownerMarker}`;
    info.isFile() ||
      Fail`Ownership marker is not a regular file: ${ownerMarker}`;
    const marker = await readFile(ownerMarker, 'utf8');
    return marker.trim() === sessionId ? 'owned' : 'foreign';
  };

  /**
   * @param {string} sessionId
   * @returns {Promise<string | undefined>} the directory, or undefined when
   *   the session has no state directory (already removed).
   */
  const assertOwnedDirectory = async sessionId => {
    const { directory, ownerMarker } = sessionPaths(sessionId);
    const rootInfo = await lstatIfPresent(stateRoot);
    if (!rootInfo) return undefined;
    rootInfo.isSymbolicLink() &&
      Fail`State root must not be a symlink: ${stateRoot}`;
    rootInfo.isDirectory() || Fail`State root is not a directory`;
    await inspectOwnersDirectory(await realpath(stateRoot));
    const info = await lstatIfPresent(directory);
    if (!info) return undefined;
    info.isSymbolicLink() && Fail`Session state path is a symbolic link`;
    info.isDirectory() || Fail`Session state path is not a directory`;
    (await readMarkerState(ownerMarker, sessionId)) === 'owned' ||
      Fail`Session state directory is not owned by this session`;
    return directory;
  };

  /**
   * Create or reopen native state without any daemon formulation or lookup.
   * @param {string} sessionId
   * @returns {Promise<{directory: string}>}
   */
  const prepareSessionDirectory = async sessionId => {
    const { directory, ownerMarker } = sessionPaths(sessionId);
    const rootInfo = await lstatIfPresent(stateRoot);
    rootInfo?.isSymbolicLink() &&
      Fail`State root must not be a symlink: ${stateRoot}`;
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const resolvedRoot = await realpath(stateRoot);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch {
      // Already present: verify rather than recreate. A symlinked path or a
      // directory owned by another session must not be reused.
      const info = await lstatIfPresent(directory);
      (!info || !info.isDirectory()) &&
        Fail`Cannot create session state directory`;
      (await realpath(directory)) === `${resolvedRoot}/${sessionId}` ||
        Fail`Session state path contains symbolic links`;
      (await readMarkerState(ownerMarker, sessionId)) === 'owned' ||
        Fail`Session state directory is not owned by this session`;
    }
    const info = await stat(directory);
    info.isDirectory() || Fail`Session state path is not a directory`;
    // Verify the canonical path before chmod or any write, so a swapped link
    // cannot redirect them outside the state tree.
    (await realpath(directory)) === `${resolvedRoot}/${sessionId}` ||
      Fail`Session state path contains symbolic links`;
    await chmod(directory, 0o700);
    await ensureOwnersDirectory(resolvedRoot);
    const markerState = await readMarkerState(ownerMarker, sessionId);
    markerState !== 'foreign' ||
      Fail`Session state directory is not owned by this session`;
    if (markerState === 'owned') {
      // Normalize a pre-existing marker rather than trusting its mode.
      await chmod(ownerMarker, 0o600);
    }
    if (markerState === 'absent') {
      // O_NOFOLLOW: never write through a symlink swapped in after the lstat.
      /* eslint-disable no-bitwise */
      const flags =
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW;
      /* eslint-enable no-bitwise */
      const handle = await open(ownerMarker, flags, 0o600);
      try {
        await handle.writeFile(`${sessionId}\n`);
      } finally {
        await handle.close();
      }
      await chmod(ownerMarker, 0o600);
    }
    return harden({ directory });
  };

  /**
   * Destroy-side native cleanup after the owner has stopped its sandbox.
   * Never called on a plain terminate/cancel, which must keep the state. Only
   * a directory carrying this session's (provider-owned) marker is removed,
   * and a missing directory is already removed.
   * @param {string} sessionId
   */
  const removeSessionDirectory = async sessionId => {
    const { ownerMarker } = sessionPaths(sessionId);
    const directory = await assertOwnedDirectory(sessionId);
    (await readMarkerState(ownerMarker, sessionId)) !== 'foreign' ||
      Fail`Session state directory is not owned by this session`;
    if (directory === undefined) {
      // Directory already gone; drop any orphaned ownership marker too.
      await rm(ownerMarker, { force: true });
      return;
    }
    await rm(directory, { recursive: true, force: true });
    await rm(ownerMarker, { force: true });
  };

  return harden({
    prepareSessionDirectory,
    removeSessionDirectory,
    assertOwnedDirectory,
  });
};

/**
 * Native state authority confined to one configured root. This requires no
 * daemon host powers and returns only copy data. The administrative owner must
 * stop the sandbox and release its Mount formulas before deleting native state.
 * Keep the original provider identity for later removal; another provider's
 * current root is not the placement of an existing session.
 * The administrative owner must serialize preparation and removal for each
 * session, including across provider instances. This storage has no independent
 * queue or takeover mechanism. Its root and ancestors must remain under stable
 * host control, outside guest mounts; path checks do not prevent concurrent
 * replacement of ancestor directories by another host process.
 * @param {object} options
 * @param {string} options.stateRoot
 */
export const makeOpencodeStateStorage = ({ stateRoot }) => {
  const { prepareSessionDirectory, removeSessionDirectory } =
    makeStateStorageOperations(stateRoot);
  return makeExo(
    'OpencodeStateStorage',
    M.interface('OpencodeStateStorage', {
      prepareSessionDirectory: M.call(M.string()).returns(M.promise()),
      removeSessionDirectory: M.call(M.string()).returns(M.promise()),
    }),
    { prepareSessionDirectory, removeSessionDirectory },
  );
};
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
