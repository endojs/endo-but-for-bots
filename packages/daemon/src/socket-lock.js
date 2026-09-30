// @ts-check
/* global process, setTimeout */

import { readlinkSync, rmSync } from 'node:fs';
import { readFile, readlink, rm, symlink } from 'node:fs/promises';

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
export const isProcessAlive = pid => {
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
export const readSocketLockOwner = async lockPath => {
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

/**
 * Wait up to `socketLockWaits * socketLockWaitMs` for a live-pid owner to
 * start serving before treating its marker as abandoned.
 */
const socketLockWaits = 4;
const socketLockWaitMs = 125;

/**
 * How long a claimer waits for a live but silent socket owner to start
 * serving. Exported so clients probing a booting daemon wait just as long.
 */
export const socketLockWindowMs = socketLockWaits * socketLockWaitMs;

/** Rounds of contention to tolerate before refusing the lock. */
const socketLockAttempts = 3;

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

/**
 * The exit status of a daemon that declined to start because another live
 * daemon owns its state directory (`EX_UNAVAILABLE` in `sysexits.h`). A
 * supervisor can list it in `RestartPreventExitStatus=` so that a duplicate
 * does not crash-loop.
 */
export const stateLockDeclinedExitCode = 69;

/**
 * The single-instance marker for an ephemeral state directory. The socket
 * lock guards a pathname only while binding it; this one is claimed before a
 * daemon touches its workers or its database and held for the life of the
 * process, because the state directory is what two daemons corrupt when they
 * share it.
 *
 * @param {string} ephemeralStatePath
 */
export const stateLockPath = ephemeralStatePath =>
  `${ephemeralStatePath}/endo.lock`;

/**
 * The kernel's start time of a process, in clock ticks since boot, or
 * `undefined` where `/proc` is unavailable. A pid alone cannot tell a live
 * owner from an unrelated process that inherited its pid; the pair can.
 *
 * @param {number} pid
 * @returns {Promise<string | undefined>}
 */
const readProcessStartTime = async pid => {
  if (process.platform !== 'linux') {
    return undefined;
  }
  const stat = await readFile(`/proc/${pid}/stat`, 'utf-8').catch(
    () => undefined,
  );
  if (stat === undefined) {
    return undefined;
  }
  // The command name in field 2 may contain spaces and parentheses, so count
  // fields from the last closing parenthesis. Start time is field 22.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19];
};

/**
 * @param {string} lockPath
 * @returns {Promise<{ pid: number, startTime?: string } | undefined>}
 */
const readStateLockOwner = async lockPath => {
  const target = await readlink(lockPath).catch(error => {
    const { code } = /** @type {NodeJS.ErrnoException} */ (error);
    if (code === 'ENOENT' || code === 'EINVAL') {
      return undefined;
    }
    throw error;
  });
  if (target === undefined) {
    return undefined;
  }
  const [pidText, startTime] = target.trim().split(':');
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  return startTime ? { pid, startTime } : { pid };
};

/**
 * The pid holding the state lock, if it is still the process that claimed
 * it.
 *
 * @param {string} lockPath
 * @returns {Promise<number | undefined>}
 */
export const readLiveStateLockOwner = async lockPath => {
  const owner = await readStateLockOwner(lockPath);
  if (owner === undefined || !isProcessAlive(owner.pid)) {
    return undefined;
  }
  if (owner.startTime !== undefined) {
    const startTime = await readProcessStartTime(owner.pid);
    if (startTime !== undefined && startTime !== owner.startTime) {
      return undefined;
    }
  }
  return owner.pid;
};

/**
 * Claim the state lock for this process. The marker is a symlink whose target
 * records `<pid>` or `<pid>:<start time>`, created exclusively as the socket
 * lock is. A marker whose owner is alive is never taken over; one whose owner
 * is gone is removed and the claim retried.
 *
 * @param {string} lockPath
 * @returns {Promise<{ claimed: true } | { claimed: false, owner: number }>}
 */
export const claimStateLock = async lockPath => {
  const startTime = await readProcessStartTime(process.pid);
  const target =
    startTime === undefined ? `${process.pid}` : `${process.pid}:${startTime}`;
  for (let attempt = 0; attempt < socketLockAttempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const created = await symlink(target, lockPath).then(
      () => true,
      error => {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
          return false;
        }
        throw error;
      },
    );
    if (created) {
      return { claimed: true };
    }
    // eslint-disable-next-line no-await-in-loop
    const owner = await readLiveStateLockOwner(lockPath);
    if (owner !== undefined) {
      return { claimed: false, owner };
    }
    // eslint-disable-next-line no-await-in-loop
    await rm(lockPath, { force: true });
  }
  const owner = (await readStateLockOwner(lockPath))?.pid ?? 0;
  return { claimed: false, owner };
};

/**
 * Release the state lock if this process still holds it. Synchronous so that
 * it can run from a process `exit` handler.
 *
 * @param {string} lockPath
 */
export const releaseStateLockSync = lockPath => {
  let target;
  try {
    target = readlinkSync(lockPath);
  } catch {
    return;
  }
  if (Number(target.split(':')[0]) !== process.pid) {
    return;
  }
  rmSync(lockPath, { force: true });
};
