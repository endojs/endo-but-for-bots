// @ts-check

/**
 * Direction-neutral byte framing for the HTTP client.
 *
 * A body that crosses CapTP has to arrive in bounded pieces rather than as one
 * value: the same fixed-size framing that lets a response body be hauled
 * incrementally lets a request body be produced incrementally. The framing
 * carries no policy — the byte caps live with the confinement that enforces
 * them — so the only thing this module decides is how large a piece is.
 */

import harden from '@endo/harden';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';

/**
 * Frame size for either direction. The value trades per-frame overhead against
 * memory residency and is not security-relevant: the response byte cap and the
 * request byte cap are enforced by the confinement, not by the frame size.
 */
export const FRAME_BYTES = 16 * 1024;
harden(FRAME_BYTES);

/**
 * Yield `bytes` in fixed-size frames. A fresh generator per call keeps each
 * consumer independent of every other consumer of the same buffer.
 *
 * @param {Uint8Array} bytes
 * @param {number} [frameBytes]
 * @returns {AsyncGenerator<Uint8Array, void, undefined>}
 */
export const generateByteFrames = async function* generateByteFrames(
  bytes,
  frameBytes = FRAME_BYTES,
) {
  await null;
  for (let offset = 0; offset < bytes.length; offset += frameBytes) {
    yield bytes.slice(offset, offset + frameBytes);
  }
};
harden(generateByteFrames);

/**
 * Wrap a byte buffer as a passable bytes reader that hauls it in frames.
 *
 * @param {Uint8Array} bytes
 * @param {number} [frameBytes]
 */
export const makeFramedBytesReader = (bytes, frameBytes = FRAME_BYTES) =>
  bytesReaderFromIterator(generateByteFrames(bytes, frameBytes));
harden(makeFramedBytesReader);
