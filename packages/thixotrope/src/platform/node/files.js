// @ts-check
/** @import { FilePowers, FileStat } from '../files.js' */
import harden from '@endo/harden';

/**
 * Node's promise-based `fs`. Descriptors and stat objects stay inside
 * this module; callers receive plain data.
 *
 * @param {object} host
 * @param {import('fs/promises')} host.fsp
 * @param {(path: string) => import('stream').Readable} host.createReadStream
 * @param {(...parts: string[]) => string} host.dirname
 * @param {() => string} host.randomUUID a fresh name for a scratch file
 * @param {() => number | undefined} host.getUserId the user running this
 *   process, when the host has one
 * @returns {FilePowers}
 */
export const makeFilePowers = ({
  fsp,
  createReadStream,
  dirname,
  randomUUID,
  getUserId,
}) => {
  /** @param {string} path */
  const syncPath = async path => {
    const file = await fsp.open(path, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  };

  /** @param {string} path */
  const exists = async path => {
    try {
      await fsp.lstat(path);
      return true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return false;
      throw error;
    }
  };

  /** @param {string} path */
  const isDirectory = async path => {
    try {
      return (await fsp.stat(path)).isDirectory();
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return false;
      throw error;
    }
  };

  /**
   * @param {string} path
   * @param {{ mode?: number }} [options]
   */
  const makeDirectory = async (path, { mode } = {}) => {
    if (await isDirectory(path)) return;
    const parent = dirname(path);
    if (parent !== path && !(await isDirectory(parent))) {
      await makeDirectory(parent, { mode });
    }
    await fsp.mkdir(path, { mode }).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST')
        throw error;
    });
    await syncPath(parent);
  };

  /**
   * @param {import('fs').Stats} stats
   * @returns {FileStat}
   */
  const describe = stats => {
    const kind = stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : stats.isSymbolicLink()
          ? 'symlink'
          : 'other';
    return harden({ kind, mode: stats.mode });
  };

  return harden({
    readText: path => fsp.readFile(path, 'utf8'),
    readBytes: async path => new Uint8Array(await fsp.readFile(path)),
    readChunks: path =>
      harden({
        async *[Symbol.asyncIterator]() {
          for await (const chunk of createReadStream(path)) {
            yield new Uint8Array(chunk);
          }
        },
      }),
    writeTextAtomic: async (path, text, { mode } = {}) => {
      // A scratch name of this call's own, created exclusively, so that
      // two writers to one path can neither publish each other's partial
      // bytes nor remove each other's scratch, and a scratch left by a
      // crash is never reused.
      const scratch = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await fsp.open(scratch, 'wx', mode);
        try {
          await file.writeFile(text);
          await file.sync();
        } finally {
          await file.close();
        }
        await fsp.rename(scratch, path);
        await syncPath(dirname(path));
      } finally {
        await fsp.rm(scratch, { force: true });
      }
    },
    makeDirectory,
    makeTempDirectory: prefix => fsp.mkdtemp(prefix),
    listDirectory: path => fsp.readdir(path),
    rename: (from, to) => fsp.rename(from, to),
    remove: async (path, { recursive = false, force = false } = {}) => {
      const existed = await exists(path);
      await fsp.rm(path, { recursive, force });
      if (existed) await syncPath(dirname(path));
    },
    copyFile: (from, to) => fsp.copyFile(from, to),
    realPath: path => fsp.realpath(path),
    stat: async (path, { followLinks = true } = {}) =>
      describe(await (followLinks ? fsp.stat(path) : fsp.lstat(path))),
    isPrivateToUser: async path => {
      const stats = await fsp.stat(path);
      // No group or other permission bits, and owned by this process's user.
      return stats.mode % 0o100 === 0 && stats.uid === getUserId();
    },
    open: async (path, flags, mode) => {
      const file = await fsp.open(path, flags, mode);
      return harden({
        fd: file.fd,
        writeText: text => file.writeFile(text),
        sync: () => file.sync(),
        close: () => file.close(),
      });
    },
    syncPath,
  });
};
harden(makeFilePowers);
