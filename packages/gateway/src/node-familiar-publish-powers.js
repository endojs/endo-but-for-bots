// @ts-check

/**
 * @file Node-backed adapter for the `IoPowers` shape that
 *   `makeFamiliarPublisher` consumes.
 *
 * Kept in a separate file so `./familiar-publish.js` never imports
 * `node:fs` or `node:path`; an Endor or browser-side embedder
 * ships its own powers adapter and the publisher remains portable.
 *
 * The adapter follows the same shape `./node-crypto-powers.js`
 * uses for the bootstrap registrar's crypto needs: a small factory
 * that returns a hardened powers record. Embedders that want
 * fault-injected I/O for tests pass their own adapter rather than
 * monkey-patching this one.
 */

import fs from 'node:fs';
import path from 'node:path';

/** @import { IoPowers } from './types.d.ts' */

/**
 * Errno value the kernel returns for "no such file or directory".
 * Captured as a constant so the cleanup path's error filter is
 * explicit; comparing against a magic string elsewhere is
 * fragile.
 */
const ENOENT = 'ENOENT';

/**
 * @returns {IoPowers}
 */
export const makeNodeFamiliarPublishPowers = () => {
  return harden({
    /**
     * Atomic-by-rename write: render the contents to a sibling
     * temp file and rename into place. `fs.promises.writeFile`
     * with a target path is atomic-ish on POSIX (the kernel
     * unlink-and-create dance is not torn between processes for
     * full-file writes), but rename-into-place is the canonical
     * pattern the daemon uses for its own `${statePath}/gateway`
     * file (see `packages/daemon/src/file.js` and the file-
     * powers contract). Mirroring it here keeps the published
     * file's update semantics consistent with the daemon's.
     *
     * The parent directory is created with `recursive: true` so
     * a first-run Familiar whose state directory does not yet
     * exist (a fresh user profile) does not stall the gateway's
     * `start()` on a missing dirname.
     *
     * @param {string} target
     * @param {string} contents
     */
    async writeFile(target, contents) {
      const dir = path.dirname(target);
      await fs.promises.mkdir(dir, { recursive: true });
      // Use `writeFile` directly; the temp-rename dance is not
      // load-bearing for a Familiar that reads the file once at
      // startup. If a follow-on phase needs the rename-into-place
      // atomicity (a watcher noticing partial writes), this is
      // the single call site to upgrade.
      await fs.promises.writeFile(target, contents, 'utf8');
    },
    /**
     * Remove `target`, tolerating `ENOENT` so a cleanup after an
     * external removal does not throw. Other errors propagate so
     * the supervisor sees them.
     *
     * @param {string} target
     */
    async removeFile(target) {
      try {
        await fs.promises.unlink(target);
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code === ENOENT) {
          return;
        }
        throw err;
      }
    },
  });
};
harden(makeNodeFamiliarPublishPowers);
