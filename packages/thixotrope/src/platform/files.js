// @ts-check

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
 */

// Port only: the host implementation is `node/files.js`.
export {};
