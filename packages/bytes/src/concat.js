import harden from '@endo/harden';
import { toIndexableUint8Array } from './indexed.js';

/**
 * Concatenates a list of byte chunks into a single contiguous `Uint8Array`.
 *
 * Accepts a mix of plain mutable `Uint8Array` chunks and frozen
 * `Uint8Array` chunks backed by an immutable `ArrayBuffer` (the
 * byteArray passable form).  Genuine views (`ArrayBuffer.isView === true`) —
 * mutable or genuine-immutable alike — are read in place with no per-chunk
 * copy; an emulated `@endo/immutable-arraybuffer` wrapper (typed `Uint8Array`
 * but `isView(wrapper) === false`) is thawed once per chunk so
 * `Uint8Array.prototype.set`'s native fast path reads its real bytes.  Only
 * the output allocation is new for genuine-view inputs.
 *
 * Empty input yields an empty `Uint8Array`.
 *
 * @param {ReadonlyArray<Uint8Array>} chunks
 * @returns {Uint8Array}
 */
export const concatBytes = chunks => {
  const indexableChunks = chunks.map(toIndexableUint8Array);
  let totalLength = 0;
  for (const chunk of indexableChunks) {
    totalLength += chunk.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of indexableChunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
harden(concatBytes);
