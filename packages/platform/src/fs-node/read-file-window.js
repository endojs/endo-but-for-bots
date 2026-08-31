// @ts-check

import harden from '@endo/harden';

/** @import { FileHandle } from 'node:fs/promises' */

/**
 * Raw-byte size of one windowed read. Reads loop in chunks of this size so a
 * huge requested `length` against a small (or unknown-size) source never drives
 * an unbounded single allocation: the per-iteration buffer stays bounded even
 * when `length` is a `Number.MAX_SAFE_INTEGER`-style end-of-content sentinel.
 */
export const READ_WINDOW_CHUNK_BYTES = 64 * 1024;

/**
 * Read `[offset, offset + length)` from an open `node:fs` file handle by
 * looping until the source signals EOF (a zero-length read), concatenating
 * short reads.
 *
 * A single `handle.read` can return fewer bytes than requested *without* being
 * at EOF — procfs / sysfs / a FIFO / a signal-interrupted read all short-read,
 * and those virtual sources report a stale or zero `stat().size`. Deriving the
 * count from `stat().size`, or treating the first short read as EOF, would
 * silently truncate the window to nothing and let a `getInfo` / `text` caller
 * mint a false content address (the SHA-256 of the empty string) for a source
 * that has content. So this never stats for a length and never stops on a short
 * read: only a zero-length read ends the loop.
 *
 * The `read` seam is injected (rather than reading `handle` directly) so a
 * regression test can supply a fake source whose reads return short.
 *
 * @param {(buffer: Uint8Array, position: number, wanted: number) => Promise<number>} read
 *   Fill `buffer[0, wanted)` from `position`; resolve to the number of bytes
 *   actually read (`0` signals EOF).
 * @param {number} offset  byte position to start at
 * @param {number} length  maximum bytes to return (may exceed what the source has)
 * @param {number} [chunkBytes]
 * @returns {Promise<Uint8Array>}
 */
export const readWindowToEnd = async (
  read,
  offset,
  length,
  chunkBytes = READ_WINDOW_CHUNK_BYTES,
) => {
  if (length <= 0) {
    return new Uint8Array(0);
  }
  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  let position = offset;
  for (;;) {
    const wanted = Math.min(chunkBytes, length - total);
    if (wanted <= 0) {
      break;
    }
    const buffer = new Uint8Array(wanted);
    // eslint-disable-next-line no-await-in-loop
    const bytesRead = await read(buffer, position, wanted);
    if (bytesRead === 0) {
      break;
    }
    parts.push(bytesRead === wanted ? buffer : buffer.subarray(0, bytesRead));
    total += bytesRead;
    position += bytesRead;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  const out = new Uint8Array(total);
  let destination = 0;
  for (const part of parts) {
    out.set(part, destination);
    destination += part.length;
  }
  return out;
};
harden(readWindowToEnd);

/**
 * `readWindowToEnd` over a `node:fs/promises` `FileHandle`: the production
 * `read` seam is `handle.read`.
 *
 * @param {FileHandle} handle
 * @param {number} offset
 * @param {number} length
 * @param {number} [chunkBytes]
 * @returns {Promise<Uint8Array>}
 */
export const readFileHandleWindow = async (
  handle,
  offset,
  length,
  chunkBytes = READ_WINDOW_CHUNK_BYTES,
) =>
  readWindowToEnd(
    async (buffer, position, wanted) => {
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      return bytesRead;
    },
    offset,
    length,
    chunkBytes,
  );
harden(readFileHandleWindow);
