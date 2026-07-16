// @ts-check
import { open } from 'node:fs/promises';
import { makeError, q, X } from '@endo/errors';
import { assertReadRange } from './src/assert.js';

/** @import { BlockDevice } from './src/types.js' */

/**
 * A `BlockDevice` backed by a Node file descriptor: a regular file, a disk
 * image, or a raw device node. On macOS the intended target is a raw disk
 * device such as `/dev/rdisk4` (the *raw*, unbuffered node — use
 * `diskutil list` to find it and `diskutil unmountDisk` before reading).
 *
 * Raw device nodes report a `stat` size of `0`, so for those the byte size
 * must be supplied explicitly via `options.size`; for regular files the
 * size is taken from `stat`.
 *
 * The returned device holds an open file handle. Call `close()` to release
 * it. `close` is added alongside the `BlockDevice` surface.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {number} [options.size] Byte size; required for raw device nodes.
 * @param {number} [options.sectorSize]
 * @returns {Promise<BlockDevice & { close: () => Promise<void> }>}
 */
export const makeFileBlockDevice = async (
  path,
  { size = undefined, sectorSize = 512 } = {},
) => {
  const handle = await open(path, 'r');
  let deviceSize = size;
  if (deviceSize === undefined) {
    const stat = await handle.stat();
    deviceSize = stat.size;
    if (deviceSize === 0) {
      await handle.close();
      throw makeError(
        X`${q(path)} reports zero size; pass an explicit { size } (raw device nodes do not report their size via stat)`,
      );
    }
  }
  const finalSize = deviceSize;

  return harden({
    sectorSize,
    getSize: async () => finalSize,
    read: async (offset, length) => {
      assertReadRange(offset, length, finalSize);
      const buffer = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        // eslint-disable-next-line no-await-in-loop
        const { bytesRead } = await handle.read(
          buffer,
          read,
          length - read,
          offset + read,
        );
        if (bytesRead === 0) {
          throw makeError(
            X`Short read from ${q(path)}: got ${q(read)} of ${q(length)} bytes at ${q(offset)}`,
          );
        }
        read += bytesRead;
      }
      return buffer;
    },
    close: async () => {
      await handle.close();
    },
  });
};
harden(makeFileBlockDevice);
