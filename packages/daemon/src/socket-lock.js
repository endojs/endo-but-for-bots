// @ts-check
/* global process, setTimeout */

import { readlink, rm, symlink } from 'node:fs/promises';

/**
 * The marker guarding a Unix socket pathname, named after the socket so
 * that whoever removes the socket can remove the marker with it.
 *
 * @param {string} path
 */
export const socketLockPath = path => `${path}.lock`;

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {number} pid */
const isProcessAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
};

/**
 * @param {string} lockPath
 * @returns {Promise<number | undefined>} the recorded pid, or `undefined` if
 * the marker is gone or was not written by us.
 */
const readSocketLockOwner = async lockPath => {
  const target = await readlink(lockPath).catch(error => {
    const { code } = /** @type {NodeJS.ErrnoException} */ (error);
    // EINVAL means the marker is not a symlink, so it is not ours to honour.
    if (code === 'ENOENT' || code === 'EINVAL') {
      return undefined;
    }
    throw error;
  });
  if (target === undefined) {
    return undefined;
  }
  const pid = Number(target.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * Create the marker with its owner already recorded. `symlink` is an
 * exclusive create — it fails with EEXIST when the name is taken — and it
 * carries the pid in the same syscall, so no claimer sees an ownerless
 * marker and no temporary file can be orphaned.
 *
 * @param {string} lockPath
 * @returns {Promise<boolean>} whether this process now holds the marker
 */
const createSocketLock = async lockPath =>
  symlink(`${process.pid}`, lockPath).then(
    () => true,
    error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
        return false;
      }
      throw error;
    },
  );

/** Rounds of contention to tolerate before refusing the lock. */
const socketLockAttempts = 3;

/**
 * Wait up to `socketLockWaits * socketLockWaitMs` for a live-pid owner to
 * start serving before treating its marker as abandoned.
 */
const socketLockWaits = 4;
const socketLockWaitMs = 125;

/**
 * @param {string} lockPath
 * @param {() => Promise<boolean>} socketIsLive
 * @param {number} attemptsLeft
 * @param {number} waitsLeft
 * @returns {Promise<boolean>}
 */
const attemptSocketLock = async (
  lockPath,
  socketIsLive,
  attemptsLeft,
  waitsLeft,
) => {
  await null;
  if (await createSocketLock(lockPath)) {
    return true;
  }
  if (attemptsLeft <= 1) {
    return false;
  }

  // The marker exists. Reclaim it only if nobody is behind it.
  const ownerPid = await readSocketLockOwner(lockPath);
  if (ownerPid !== undefined && isProcessAlive(ownerPid)) {
    if (await socketIsLive()) {
      return false;
    }
    if (waitsLeft > 0) {
      // The pid is alive but silent: either a peer between its claim and its
      // bind, which waiting resolves, or a process that inherited the pid of
      // a daemon that died holding the marker. Waiting is not an attempt, so
      // a peer that is merely slow is not counted against.
      await delay(socketLockWaitMs);
      return attemptSocketLock(
        lockPath,
        socketIsLive,
        attemptsLeft,
        waitsLeft - 1,
      );
    }
  }
  await rm(lockPath, { force: true });
  return attemptSocketLock(lockPath, socketIsLive, attemptsLeft - 1, waitsLeft);
};

/**
 * Claim the socket lock. A marker is refused while its owner is serving the
 * pathname, and reclaimed when the owner is dead, unreadable, or never binds.
 *
 * @param {string} lockPath
 * @param {() => Promise<boolean>} socketIsLive whether anything answers on
 * the pathname the marker guards.
 * @returns {Promise<boolean>}
 */
export const claimSocketLock = (lockPath, socketIsLive) =>
  attemptSocketLock(
    lockPath,
    socketIsLive,
    socketLockAttempts,
    socketLockWaits,
  );

/** @param {string} lockPath */
export const releaseSocketLock = async lockPath => {
  const ownerPid = await readSocketLockOwner(lockPath);
  if (ownerPid !== process.pid) {
    return;
  }
  await rm(lockPath, { force: true });
};
