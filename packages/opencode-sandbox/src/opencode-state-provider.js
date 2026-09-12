// @ts-check
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
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
 * configured root and mints a **daemon mount** for it through the host agent's
 * `provideMount`. The sandbox factory resolves every Mount cap through
 * `@agent.provideHostPath`, which only accepts daemon-minted mounts — so the
 * cap must be minted here, by the daemon, rather than composed by a wrapper.
 *
 * Ownership: a session's marker lives in a provider-owned `.owners/`
 * directory beside (never inside) the mounted session directory, so the
 * sandboxed guest — which gets the session directory rw — cannot delete or
 * rewrite it. removeSession refuses anything without that marker. The
 * provider mints only under the bounded session id, and the host pet name is
 * a variadic path (`has(...name)` / `remove(...name)`).
 */

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MOUNT_DIRECTORY = 'opencode-state';
const OWNERS_DIRECTORY = '.owners';

/** Default pet name for the state provider under the sandbox namespace. */
export const DEFAULT_STATE_PROVIDER_NAME = 'state-provider';
harden(DEFAULT_STATE_PROVIDER_NAME);

const OpencodeStateProviderInterface = M.interface('OpencodeStateProvider', {
  provideSessionMount: M.call(M.string()).returns(M.promise()),
  removeSession: M.call(M.string()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * @param {object} options
 * @param {any} options.hostAgent - a host-authority cap with
 *   `provideMount(absolutePath, petName)` / `remove(...petName)` /
 *   `makeDirectory(petName)` / `has(...petName)`.
 * @param {string} options.stateRoot - absolute host directory for session state.
 */
export const makeOpencodeStateProvider = ({ hostAgent, stateRoot }) => {
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
      name: ['opencode-state', sessionId],
    });
  };

  const ensureOwnersDirectory = async () => {
    const owners = `${stateRoot}/${OWNERS_DIRECTORY}`;
    await mkdir(owners, { recursive: true, mode: 0o700 });
    await chmod(owners, 0o700);
    return owners;
  };

  /**
   * @param {string} sessionId
   * @returns {Promise<string | undefined>} the directory, or undefined when
   *   the session has no state directory (already removed).
   */
  const assertOwnedDirectory = async sessionId => {
    const { directory, ownerMarker } = sessionPaths(sessionId);
    const info = await lstat(directory).catch(() => undefined);
    if (!info) return undefined;
    info.isDirectory() || Fail`Session state path is not a directory`;
    info.isSymbolicLink() && Fail`Session state path is a symbolic link`;
    const marker = await readFile(ownerMarker, 'utf8').catch(() => undefined);
    marker !== undefined && marker.trim() === sessionId
      ? undefined
      : Fail`Session state directory is not owned by this session`;
    return directory;
  };

  const ensureMountDirectory = async () => {
    if (!(await E(hostAgent).has(MOUNT_DIRECTORY))) {
      await E(hostAgent).makeDirectory([MOUNT_DIRECTORY]);
    }
  };

  /**
   * Create or reopen the session's state directory and return a daemon-minted
   * Mount cap for it. Idempotent across reincarnation.
   * @param {string} sessionId
   */
  const provideSessionMount = async sessionId => {
    const { directory, ownerMarker, name } = sessionPaths(sessionId);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const resolvedRoot = await realpath(stateRoot);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch {
      // Already present: verify rather than recreate. A symlinked path or a
      // directory owned by another session must not be reused.
      const info = await lstat(directory).catch(() => undefined);
      (!info || !info.isDirectory()) &&
        Fail`Cannot create session state directory`;
      (await realpath(directory)) === `${resolvedRoot}/${sessionId}` ||
        Fail`Session state path contains symbolic links`;
      const marker = await readFile(ownerMarker, 'utf8').catch(() => undefined);
      marker !== undefined && marker.trim() === sessionId
        ? undefined
        : Fail`Session state directory is not owned by this session`;
    }
    await chmod(directory, 0o700);
    const info = await stat(directory);
    info.isDirectory() || Fail`Session state path is not a directory`;
    (await realpath(directory)) === `${resolvedRoot}/${sessionId}` ||
      Fail`Session state path contains symbolic links`;
    await ensureOwnersDirectory();
    await writeFile(ownerMarker, `${sessionId}\n`, { mode: 0o600 });
    await ensureMountDirectory();
    // Replace any stale mount name for this session before re-minting.
    if (await E(hostAgent).has(...name)) {
      await E(hostAgent).remove(...name);
    }
    return E(hostAgent).provideMount(directory, name);
  };

  /**
   * Destroy-side cleanup: unmount the session state and delete its directory.
   * Never called on a plain terminate/cancel, which must keep the state. Only
   * a directory carrying this session's (provider-owned) marker is removed,
   * and a missing directory is already removed.
   * @param {string} sessionId
   */
  const removeSession = async sessionId => {
    const { ownerMarker, name } = sessionPaths(sessionId);
    const directory = await assertOwnedDirectory(sessionId);
    if (await E(hostAgent).has(...name)) {
      await E(hostAgent).remove(...name);
    }
    if (directory === undefined) {
      // Directory already gone; drop any orphaned ownership marker too.
      await rm(ownerMarker, { force: true });
      return;
    }
    await rm(directory, { recursive: true, force: true });
    await rm(ownerMarker, { force: true });
  };

  return makeExo('OpencodeStateProvider', OpencodeStateProviderInterface, {
    provideSessionMount,
    removeSession,
    help: () =>
      'Durable per-session state for the opencode sandbox: provideSessionMount(sessionId) creates a 0700 host directory (with an ownership marker) and returns a daemon Mount cap; removeSession(sessionId) unmounts and deletes it (destroy only, marker-checked).',
  });
};
harden(makeOpencodeStateProvider);
