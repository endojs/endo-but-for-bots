// @ts-check
/** @import { SyncFilePowers } from '../sync-files.js' */
import harden from '@endo/harden';

/**
 * Node's synchronous `fs` calls, including the `fsync` that makes the
 * "disk before graph" invariant hold.
 *
 * @param {object} host
 * @param {import('fs')} host.fs
 * @param {(...parts: string[]) => string} host.dirname
 * @param {() => string} host.randomUUID a fresh name for a scratch file
 * @param {() => number | undefined} host.getUserId the user running this
 *   process, when the host has one
 * @returns {SyncFilePowers}
 */
export const makeSyncFilePowers = ({ fs, dirname, randomUUID, getUserId }) => {
  /** @param {string} path */
  const syncPath = path => {
    const fd = fs.openSync(path, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };

  /** @param {string} path */
  const makeDirectory = path => {
    if (fs.existsSync(path)) return;
    const parent = dirname(path);
    if (parent !== path && !fs.existsSync(parent)) makeDirectory(parent);
    fs.mkdirSync(path, { recursive: true });
    syncPath(parent);
  };

  return harden({
    readText: path => fs.readFileSync(path, 'utf8'),
    exists: path => fs.existsSync(path),
    writeTextAtomic: (path, text, { mode } = {}) => {
      // See the asynchronous twin: a scratch of this call's own, created
      // exclusively, so concurrent writers and a crashed predecessor cannot
      // interfere.
      const scratch = `${path}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(scratch, 'wx', mode);
        try {
          fs.writeFileSync(fd, text);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(scratch, path);
        syncPath(dirname(path));
      } finally {
        fs.rmSync(scratch, { force: true });
      }
    },
    appendTextDurable: (path, text) => {
      const fd = fs.openSync(path, 'a');
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    makeDirectory,
    listDirectory: path => fs.readdirSync(path),
    remove: (path, { recursive = false, force = false } = {}) => {
      const existed = fs.existsSync(path);
      fs.rmSync(path, { recursive, force });
      if (existed) syncPath(dirname(path));
    },
    stat: path => {
      const stats = fs.statSync(path);
      const kind = stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : 'other';
      return harden({ kind, mode: stats.mode });
    },
    isPrivateToUser: path => {
      const stats = fs.statSync(path);
      // No group or other permission bits, and owned by this process's user.
      return stats.mode % 0o100 === 0 && stats.uid === getUserId();
    },
  });
};
harden(makeSyncFilePowers);
