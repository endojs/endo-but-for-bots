// @ts-check
/** @import { NodePowers } from './platform/node-powers.js' */
import harden from '@endo/harden';

/** @import { SyncStringAtom } from './sync-string-atom.js' */

/**
 * Atomic string storage under the caller's exclusive engine lease.
 * A failed write must stop the caller from performing its following effect.
 * @param {NodePowers} powers
 * @param {string} path
 * @returns {SyncStringAtom}
 */
export const makeFileSyncStringAtom = (powers, path) => {
  const {
    closeSync,
    existsSync,
    fsyncSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
  } = powers.fs;
  const { dirname } = powers.path;
  return harden({
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    /** @param {string} value */
    write: value => {
      const temporary = `${path}.tmp`;
      const fd = openSync(temporary, 'w', 0o600);
      try {
        writeFileSync(fd, value);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temporary, path);
        const directory = openSync(dirname(path), 'r');
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  });
};
harden(makeFileSyncStringAtom);
