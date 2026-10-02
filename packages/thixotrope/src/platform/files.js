// @ts-check

/**
 * File kind as reported to core. `symlink` is reported only by a `stat`
 * asked not to follow links; `other` covers sockets, devices, and anything
 * the host cannot classify.
 *
 * @typedef {'file' | 'directory' | 'symlink' | 'other'} FileKind
 *
 * @typedef {object} FileStat
 * @property {FileKind} kind
 * @property {number} mode permission bits
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
 * @property {(path: string, text: string, options?: { mode?: number }) => Promise<void>} writeTextAtomic
 *   replace the file's contents as one durable step, optionally with
 *   permission bits for a newly created file; concurrent writers to one
 *   path each publish a whole file, and the last to finish wins
 *   (each through its own scratch file, `<path>.<id>.tmp`; one left behind by
 *   a crash before the rename is never read as a record and may be deleted)
 * @property {(path: string, options?: { mode?: number }) => Promise<void>} makeDirectory
 *   create the directory and any missing ancestors, each with `mode`, and
 *   persist the new directory entries up to their nearest existing ancestor
 * @property {(prefix: string) => Promise<string>} makeTempDirectory
 * @property {(path: string) => Promise<string[]>} listDirectory
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(path: string, options?: { recursive?: boolean, force?: boolean }) => Promise<void>} remove
 *   unlink `path`, and persist the removed directory entry
 * @property {(from: string, to: string) => Promise<void>} copyFile
 * @property {(path: string) => Promise<string>} realPath
 * @property {(path: string, options?: { followLinks?: boolean }) => Promise<FileStat>} stat
 *   describe `path`; with `followLinks: false` a symbolic link is described
 *   itself, as kind `symlink`, rather than its target
 * @property {(path: string) => Promise<boolean>} isPrivateToUser whether
 *   only the user running this process may read or write `path`. The host
 *   decides what ownership and permission mean; one that cannot make the
 *   promise answers false
 * @property {(path: string, flags: string, mode?: number) => Promise<OpenFile>} open
 * @property {(path: string) => Promise<void>} syncPath flush a file or
 *   directory entry to stable storage
 */

// Port only: the host implementation is `node/files.js`.
export {};
