// @ts-check
import harden from '@endo/harden';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomic service recipes under the caller's exclusive engine lease.
 * A failed write must stop the caller from performing its following effect.
 * @param {string} path
 */
export const makeServiceState = path =>
  harden({
    read: () =>
      existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined,
    /** @param {unknown} value */
    write: value => {
      const temporary = `${path}.tmp`;
      const fd = openSync(temporary, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value));
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
harden(makeServiceState);
