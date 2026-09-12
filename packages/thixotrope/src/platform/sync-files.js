// @ts-check
import harden from '@endo/harden';

/** @import { FileStat } from './files.js' */

/**
 * Synchronous durable file capability. The daemon's "disk before graph"
 * invariant needs writes to have reached stable storage before the effect
 * that depends on them, so these methods block; hosts that cannot make that
 * promise should not offer this power.
 *
 * `writeTextAtomic` swaps a fully synced temporary file into place and
 * persists the directory entry; `appendTextDurable` appends and syncs.
 * Both leave the caller with no descriptor to manage.
 *
 * @typedef {object} SyncFilePowers
 * @property {(path: string) => string} readText
 * @property {(path: string) => boolean} exists
 * @property {(path: string, text: string, options?: { mode?: number }) => void} writeTextAtomic
 * @property {(path: string, text: string) => void} appendTextDurable
 * @property {(path: string, options?: { recursive?: boolean }) => void} makeDirectory
 * @property {(path: string) => string[]} listDirectory
 * @property {(path: string, options?: { recursive?: boolean, force?: boolean }) => void} remove
 * @property {(path: string) => FileStat} stat
 *
 * @param {object} host
 * @param {import('fs')} host.fs
 * @param {(...parts: string[]) => string} host.dirname
 * @returns {SyncFilePowers}
 */
export const makeSyncFilePowers = ({ fs, dirname }) => {
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
      const temporary = `${path}.tmp`;
      const fd = fs.openSync(temporary, 'w', mode);
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(temporary, path);
        syncPath(dirname(path));
      } finally {
        fs.rmSync(temporary, { force: true });
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
      return harden({ kind, mode: stats.mode, uid: stats.uid });
    },
  });
};
harden(makeSyncFilePowers);
