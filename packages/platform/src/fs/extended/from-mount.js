// @ts-check
/**
 * `mountAsFilesystem(rootMount)` —
 * `wrapBackend(makeFromMountBackend(rootMount))`.
 *
 * The 655-line legacy implementation has been replaced with a thin
 * wrapper. The Mount→FsBackend adapter lives in
 * `backends/from-mount-backend.js`; all exo plumbing comes from
 * `wrap-backend.js`.
 *
 * See `designs/endo-fs-backend-seam.md` for the architecture.
 */

import { wrapBackend } from './wrap-backend.js';
import { makeFromMountBackend } from './backends/from-mount-backend.js';

/** @import { Filesystem } from './types.js' */

/**
 * Project an `@endo/daemon` Mount cap into a endo-fs `Filesystem`.
 *
 * A Mount's write authority belongs to the mount, not to this adapter: a
 * read-only mount answers every method of the same interface and rejects the
 * mutating ones at its own boundary, and this package cannot read the
 * daemon-private mount record to tell which it holds. The projected
 * `Filesystem` therefore carries no posture by default, so
 * `isFilesystemReadWrite()` fails closed rather than reporting writable
 * authority that the mount may not confer. A caller that does know the mount's
 * posture — the daemon host that minted it — states it here.
 *
 * @param {object} rootMount
 * @param {{ posture?: 'readOnly' | 'readWrite' }} [opts]
 * @returns {Filesystem}
 */
export const mountAsFilesystem = (rootMount, opts = {}) =>
  wrapBackend(makeFromMountBackend(rootMount), {
    description: 'Mount-adapted FS',
    posture: opts.posture ?? 'unknown',
  });
harden(mountAsFilesystem);
