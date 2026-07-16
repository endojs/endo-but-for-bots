// @ts-check
import { assertReadRange } from './assert.js';

/** @import { BlockDevice } from './types.js' */

/**
 * A `BlockDevice` backed by an in-memory `Uint8Array`. Useful for tests
 * and for wrapping data already resident in memory. The backing bytes are
 * captured by reference; each `read` returns a fresh copy so the backing
 * store cannot be mutated through the device.
 *
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {number} [options.sectorSize]
 * @returns {BlockDevice}
 */
export const makeMemoryBlockDevice = (bytes, { sectorSize = 512 } = {}) => {
  const size = bytes.length;
  return harden({
    sectorSize,
    getSize: async () => size,
    read: async (offset, length) => {
      assertReadRange(offset, length, size);
      return bytes.slice(offset, offset + length);
    },
  });
};
harden(makeMemoryBlockDevice);
