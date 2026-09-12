// @ts-check
/** @import { SyncFilePowers } from '../platform/sync-files.js' */
import harden from '@endo/harden';

/** @import { SyncStringAtom } from './sync-string-atom.js' */

/**
 * Atomic string storage under the caller's exclusive engine lease.
 * A failed write must stop the caller from performing its following effect.
 * @param {SyncFilePowers} syncFiles
 * @param {string} path
 * @returns {SyncStringAtom}
 */
export const makeFileSyncStringAtom = (syncFiles, path) =>
  harden({
    read: () => (syncFiles.exists(path) ? syncFiles.readText(path) : undefined),
    /** @param {string} value */
    write: value => syncFiles.writeTextAtomic(path, value, { mode: 0o600 }),
  });
harden(makeFileSyncStringAtom);
