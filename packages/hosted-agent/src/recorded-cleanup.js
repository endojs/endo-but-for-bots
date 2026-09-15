// @ts-check

/**
 * Reclaim the one host resource a lost session worker leaves behind.
 *
 * A native session controller owns its 9P mount and MCP socket locally, in the
 * worker that activated the plan. When that worker is gone — the daemon
 * restarted, or the formula was reconstructed — those owners cannot be
 * recovered, and a reconstructed controller must not invent substitutes for
 * them.
 *
 * Almost everything that implies takes care of itself. The MCP listener died
 * with its process, and `startMcpSocketServer` already unlinks a stale socket
 * before binding. A slice container outlives the worker but is reconciled by
 * the driver's label sweep. The kernel 9P mount is the exception: it was
 * established by an external `mount` program, so it survives every process
 * that knew about it, and nothing else will ever take it down. Left in place
 * it fails every read of the mount point with EIO and blocks the storage owner
 * from removing the session directory, which is why a restarted daemon used to
 * strand a mount per session and refuse the session forever.
 *
 * So this reclaims exactly that, and only against paths the plan recorded:
 * unmount the recorded mount point with the recorded umount program, then
 * remove it, which is what `removeMountPointOnUnmount` promised the mounter
 * would do. Nothing here creates a mount, a scope, or a socket.
 *
 * The safety argument is a check, not an inference. The mount's transport is a
 * unix socket in the session's recorded private socket directory, served by
 * the bridge inside the worker that mounted it. If any of those sockets still
 * accepts a connection, that bridge is alive, this is not a lost worker, and
 * the unmount is refused. Only a socket directory with no live listener — the
 * bridge provably gone — is reclaimed. That is stronger evidence than a fresh
 * mounter kit's `close()`, which proves nothing about mounts it never made.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { lstat, readdir, rmdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { Fail, q } from '@endo/errors';

import { readMountPrograms } from '@endo/9p-server/mount-caplet.js';

/** How long a probe waits for a socket to answer before calling it dead. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Resolve to true when something is listening on this unix socket.
 *
 * ENOENT and ECONNREFUSED both mean no listener: the socket is gone, or it is
 * a leftover inode whose server has exited. Any other outcome — a connection,
 * a timeout, or an error this does not recognise — is reported as a live
 * listener, because none of them is evidence of absence.
 *
 * @param {string} socketPath
 * @param {typeof net} netModule
 */
const socketIsLive = (socketPath, netModule) =>
  new Promise(resolve => {
    const socket = netModule.connect({ path: socketPath });
    const settle = live => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(true));
    socket.once('connect', () => settle(true));
    socket.once('error', error => {
      const code = /** @type {{ code?: string }} */ (error).code;
      settle(code !== 'ENOENT' && code !== 'ECONNREFUSED');
    });
  });

/**
 * A umount that fails because nothing was mounted has reached the state the
 * caller asked for. Every other failure is real and must be reported: this is
 * the only place the mount's release is established.
 *
 * @param {unknown} error
 */
const meansNotMounted = error => {
  const text = `${/** @type {{ stderr?: string, message?: string }} */ (error).stderr ?? ''}${/** @type {{ message?: string }} */ (error).message ?? ''}`;
  return /not mounted|not currently mounted|no mount point specified|not found in \/proc\/self\/mountinfo/i.test(
    text,
  );
};

/**
 * @param {object} recorded The plan's recorded native placement.
 * @param {string} recorded.workspaceMountPoint
 * @param {string} recorded.mounterSocketDir
 * @param {Record<string, string>} [recorded.mounterEnv]
 * @param {object} [powers]
 * @param {(file: string, args: string[]) => Promise<unknown>} [powers.runProgram]
 * @param {(dir: string) => Promise<string[]>} [powers.readDirectory]
 * @param {(target: string) => Promise<boolean>} [powers.isSocket]
 * @param {(dir: string) => Promise<void>} [powers.removeDirectory]
 * @param {typeof net} [powers.netModule]
 */
export const reclaimRecordedMount = async (
  { workspaceMountPoint, mounterSocketDir, mounterEnv = {} },
  {
    runProgram = promisify(execFile),
    readDirectory = dir => readdir(dir),
    isSocket = async target =>
      lstat(target).then(
        stats => stats.isSocket(),
        () => false,
      ),
    removeDirectory = dir => rmdir(dir),
    netModule = net,
  } = {},
) => {
  (typeof workspaceMountPoint === 'string' && workspaceMountPoint !== '') ||
    Fail`A recorded workspace mount point is required to reclaim it`;
  (typeof mounterSocketDir === 'string' && mounterSocketDir !== '') ||
    Fail`A recorded 9P socket directory is required to prove the bridge is gone`;
  // Read the operator's programs from the recorded settings, which
  // `readMounterEnv` already validated when the plan was parsed. A caller
  // cannot choose the program here any more than it can at mount time.
  const { umountProgram } = readMountPrograms(mounterEnv);

  /** @type {string[]} */
  let entries;
  try {
    entries = await readDirectory(mounterSocketDir);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') throw error;
    // No socket directory at all: the bridge cannot be serving.
    entries = [];
  }
  // Only a unix socket can be a bridge endpoint. The directory also holds
  // ordinary files, and connecting to one answers ENOTSOCK, which is not the
  // absence this check is looking for.
  const kinds = await Promise.all(
    entries.map(entry => isSocket(path.join(mounterSocketDir, entry))),
  );
  const sockets = entries.filter((_entry, index) => kinds[index]);
  const live = await Promise.all(
    sockets.map(entry =>
      socketIsLive(path.join(mounterSocketDir, entry), netModule),
    ),
  );
  const holding = sockets.filter((_entry, index) => live[index]);
  holding.length === 0 ||
    Fail`The recorded 9P bridge is still serving ${q(holding)}; its mount is not this owner's to reclaim`;

  const [bin, ...prefix] = umountProgram;
  try {
    await runProgram(bin, [...prefix, '--', workspaceMountPoint]);
  } catch (error) {
    if (!meansNotMounted(error)) throw error;
  }
  try {
    await removeDirectory(workspaceMountPoint);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') throw error;
  }
};
harden(reclaimRecordedMount);
