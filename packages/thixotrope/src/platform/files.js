// @ts-check
import harden from '@endo/harden';

/**
 * File kind as reported to core; `other` covers sockets, devices, and
 * anything the host cannot classify.
 *
 * @typedef {'file' | 'directory' | 'other'} FileKind
 *
 * @typedef {object} FileStat
 * @property {FileKind} kind
 * @property {number} mode permission bits
 * @property {number | undefined} uid owning user, when meaningful
 *
 * @typedef {object} OpenFile
 * @property {number | undefined} fd raw descriptor, for handing to
 *   {@link ProcessPowers.spawn} as a stdio target
 * @property {(text: string) => Promise<void>} writeText
 * @property {() => Promise<void>} sync
 * @property {() => Promise<void>} close
 *
 * Asynchronous file capability. Return values are plain data so no host
 * descriptor type escapes into core. `writeTextAtomic` and `syncPath`
 * exist because durable state must be on disk before dependent effects;
 * a platform without sync tells core so by refusing those methods.
 *
 * @typedef {object} FilePowers
 * @property {(path: string) => Promise<string>} readText
 * @property {(path: string) => Promise<Uint8Array>} readBytes
 * @property {(path: string) => AsyncIterable<Uint8Array>} readChunks
 * @property {(path: string, text: string) => Promise<void>} writeTextAtomic
 * @property {(path: string, options?: { recursive?: boolean, mode?: number }) => Promise<void>} makeDirectory
 *   create the directory, recursively when asked, and persist the new
 *   directory entries up to their nearest existing ancestor
 * @property {(prefix: string) => Promise<string>} makeTempDirectory
 * @property {(path: string) => Promise<string[]>} listDirectory
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(path: string, options?: { recursive?: boolean, force?: boolean }) => Promise<void>} remove
 * @property {(from: string, to: string) => Promise<void>} copyFile
 * @property {(path: string) => Promise<string>} realPath
 * @property {(path: string) => Promise<FileStat>} stat
 * @property {(path: string, mode: number) => Promise<void>} chmod
 * @property {(path: string, flags: string, mode?: number) => Promise<OpenFile>} open
 * @property {(path: string) => Promise<void>} syncPath flush a file or
 *   directory entry to stable storage
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
    writeTextAtomic: async (path, text) => {
      const temporary = `${path}.tmp`;
      try {
        await fsp.writeFile(temporary, text);
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
