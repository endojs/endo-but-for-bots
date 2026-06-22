// @ts-check

import harden from '@endo/harden';

import { fromBytes } from './from-bytes.js';
import { toBytes } from './to-bytes.js';

// concatMutable is inlined here rather than imported from @endo/bytes to
// avoid adding a dependency on that package from @endo/pass-style.
// The implementation is identical: accumulate total length, allocate once,
// then copy each chunk in a single pass.

/**
 * Concatenates a list of byteArray-passable values into a single hardened
 * frozen `Uint8Array` backed by an immutable `ArrayBuffer`.
 *
 * Equivalent to `toBytes(concatMutableBytes(buffers.map(fromBytes)))`,
 * provided as a single-call helper because the composition is common
 * when assembling protocol records from immutable byte fragments.
 *
 * The input element type is `ArrayBufferView | ArrayBufferLike` so the
 * helper accepts both the current byteArray shape (frozen `Uint8Array`)
 * and the prior raw-immutable-`ArrayBuffer` shape, easing the
 * cross-version transition.
 *
 * @param {ReadonlyArray<ArrayBufferView | ArrayBufferLike>} buffers
 * @returns {Uint8Array}
 */
export const concatBytes = buffers => {
  const chunks = buffers.map(fromBytes);
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return toBytes(result);
};
harden(concatBytes);
