// @ts-check
/** @import { FilePowers } from '../files.js' */
import harden from '@endo/harden';

/**
 * Node's promise-based `fs`. Descriptors and stat objects stay inside
 * this module; callers receive plain data.
 *
 * @param {object} host
 * @param {import('fs/promises')} host.fsp
 * @param {(path: string) => import('stream').Readable} host.createReadStream
 * @param {(...parts: string[]) => string} host.dirname
 * @returns {FilePowers}
 */
export const makeFilePowers = ({ fsp, createReadStream, dirname }) => {
  /** @param {string} path */
  const syncPath = async path => {
    const file = await fsp.open(path, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  };

  /**
   * @param {string} path
   * @param {{ recursive?: boolean, mode?: number }} [options]
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

  return harden({
    readText: path => fsp.readFile(path, 'utf8'),
    readBytes: path => fsp.readFile(path),
    readChunks: path => createReadStream(path),
    writeTextAtomic: async (path, text, { mode } = {}) => {
      const temporary = `${path}.tmp`;
      try {
        await fsp.writeFile(temporary, text, { mode });
        await syncPath(temporary);
        await fsp.rename(temporary, path);
        await syncPath(dirname(path));
      } finally {
        await fsp.rm(temporary, { force: true });
      }
    },
    makeDirectory,
    makeTempDirectory: prefix => fsp.mkdtemp(prefix),
    listDirectory: path => fsp.readdir(path),
    rename: (from, to) => fsp.rename(from, to),
    remove: (path, { recursive = false, force = false } = {}) =>
      fsp.rm(path, { recursive, force }),
    copyFile: (from, to) => fsp.copyFile(from, to),
    realPath: path => fsp.realpath(path),
    stat: async path => {
      const stats = await fsp.stat(path);
      const kind = stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : 'other';
      return harden({ kind, mode: stats.mode, uid: stats.uid });
    },
    chmod: (path, mode) => fsp.chmod(path, mode),
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
