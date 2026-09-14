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
 * @property {(path: string, text: string) => void} appendTextDurable
 * @property {(path: string, options?: { recursive?: boolean }) => void} makeDirectory
 * @property {(path: string) => string[]} listDirectory
 * @property {(path: string, options?: { recursive?: boolean, force?: boolean }) => void} remove
 * @property {(path: string) => FileStat} stat
 */

// Port only: the host implementation is `node/sync-files.js`.
export {};
