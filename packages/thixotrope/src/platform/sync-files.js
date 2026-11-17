// @ts-check
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
 *   replace the file's contents as one durable step, optionally with
 *   permission bits for a newly created file; concurrent writers to one
 *   path each publish a whole file, and the last to finish wins
 *   (each through its own scratch file, `<path>.<id>.tmp`; one left behind by
 *   a crash before the rename is never read as a record and may be deleted)
 * @property {(path: string, text: string) => void} appendTextDurable
 * @property {(path: string) => void} makeDirectory create the directory and
 *   any missing ancestors, and persist the new directory entries up to
 *   their nearest existing ancestor
 * @property {(path: string) => string[]} listDirectory
 * @property {(path: string, options?: { recursive?: boolean, force?: boolean }) => void} remove
 *   unlink `path`, and persist the removed directory entry
 * @property {(path: string) => FileStat} stat follows links, so it never
 *   reports `symlink`; the asynchronous twin can be asked not to
 * @property {(path: string) => boolean} isPrivateToUser whether only the
 *   user running this process may read or write `path`; see the
 *   asynchronous twin
 */

// Port only: the host implementation is `node/sync-files.js`.
export {};
