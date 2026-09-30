// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { q } from '@endo/errors';

/**
 * @typedef {object} FileCas
 * @property {(bytes: Uint8Array) => string} put Store bytes; returns sha256 hex.
 * @property {(hash: string) => Uint8Array} get Read bytes; throws if absent.
 * @property {(hash: string) => boolean} has
 */

const HASH = /^[0-9a-f]{64}$/u;

/**
 * A filesystem content-addressed store with the same on-disk shape as
 * `@endo/daemon-cas` (one file per blob, named by its sha256 hex, written
 * to a random temporary name and atomically renamed). The registry writes
 * tarball blobs, file blobs, and tree manifests here before the SQLite
 * transaction that makes a version visible, so a crash can leave only
 * unreachable blobs, never a visible row without its content.
 *
 * Blobs are written synchronously: they are bounded by the publish and
 * archive limits, and synchronous writes keep the write-then-commit
 * ordering obvious.
 *
 * This is deliberately not `@endo/mem-cas`'s `CasInterface` or
 * `@endo/daemon-cas`'s `makeContentStore`. Those are asynchronous and
 * exposed as remotable objects for the daemon's CapTP world; here every
 * write must be durable (fsynced file and directory) before a synchronous
 * better-sqlite3 transaction commits, and the store is a module-private
 * helper of a plain Node service, with no remote callers. Sharing the
 * on-disk layout keeps a later move onto `@endo/daemon-cas` (or the Rust
 * CAS that replaces it) a change of implementation, not of data. That
 * move is tracked with the design's storage phase (#1361).
 *
 * @param {string} directory
 * @returns {FileCas}
 */
export const makeFileCas = directory => {
  fs.mkdirSync(directory, { recursive: true });
  /** @param {string} hash */
  const pathOf = hash => {
    if (!HASH.test(hash)) {
      throw Error(`Invalid CAS hash ${q(hash)}`);
    }
    return path.join(directory, hash);
  };
  return harden({
    put(bytes) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      const target = pathOf(hash);
      if (!fs.existsSync(target)) {
        const temporary = path.join(
          directory,
          `.tmp-${randomBytes(16).toString('hex')}`,
        );
        const fd = fs.openSync(temporary, 'wx', 0o644);
        try {
          // writeSync may write fewer bytes than requested; a short write
          // renamed into place would sit under the hash of the full bytes.
          let offset = 0;
          while (offset < bytes.byteLength) {
            offset += fs.writeSync(fd, bytes, offset);
          }
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, target);
        // Make the rename itself durable before the caller commits a row
        // that names this blob.
        const directoryFd = fs.openSync(directory, 'r');
        try {
          fs.fsyncSync(directoryFd);
        } finally {
          fs.closeSync(directoryFd);
        }
      }
      return hash;
    },
    get(hash) {
      return new Uint8Array(fs.readFileSync(pathOf(hash)));
    },
    has(hash) {
      return fs.existsSync(pathOf(hash));
    },
  });
};
harden(makeFileCas);
