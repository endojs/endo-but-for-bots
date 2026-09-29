// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
 * @param {string} directory
 * @returns {FileCas}
 */
export const makeFileCas = directory => {
  fs.mkdirSync(directory, { recursive: true });
  /** @param {string} hash */
  const pathOf = hash => {
    if (!HASH.test(hash)) {
      throw Error(`Invalid CAS hash ${hash}`);
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
          fs.writeSync(fd, bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, target);
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
