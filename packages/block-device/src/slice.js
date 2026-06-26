// @ts-check
import { makeError, q, X } from '@endo/errors';
import { assertReadRange } from './assert.js';

/** @import { BlockDevice } from './types.js' */

/**
 * A `BlockDevice` view over a contiguous byte range of an underlying
 * device. This is how a partition or a LUKS *data segment* is carved out
 * of a whole-disk device without copying: the slice translates its own
 * `[0, size)` address space into `[offset, offset + size)` on the parent.
 *
 * @param {BlockDevice} device
 * @param {number} offset Byte offset of the slice within `device`.
 * @param {number} [size] Length of the slice in bytes; defaults to the
 *   remainder of `device` after `offset`.
 * @param {object} [options]
 * @param {number} [options.sectorSize]
 * @returns {BlockDevice}
 */
export const makeSlicedBlockDevice = (
  device,
  offset,
  size = undefined,
  { sectorSize = device.sectorSize } = {},
) => {
  if (!Number.isInteger(offset) || offset < 0) {
    throw makeError(
      X`Slice offset must be a non-negative integer, got ${q(offset)}`,
    );
  }
  let sliceSize = size;
  return harden({
    sectorSize,
    getSize: async () => {
      if (sliceSize === undefined) {
        sliceSize = (await device.getSize()) - offset;
      }
      return sliceSize;
    },
    read: async (sliceOffset, length) => {
      if (sliceSize === undefined) {
        sliceSize = (await device.getSize()) - offset;
      }
      assertReadRange(sliceOffset, length, sliceSize);
      return device.read(offset + sliceOffset, length);
    },
  });
};
harden(makeSlicedBlockDevice);
