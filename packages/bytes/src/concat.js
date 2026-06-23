import harden from '@endo/harden';

/**
 * Normalize a `Uint8Array` to a mutable `Uint8Array` that
 * `Uint8Array.prototype.set` will accept.
 *
 * `Uint8Array.prototype.set` uses a native fast path for TypedArray sources
 * that reads through the internal buffer representation, bypassing any proxy
 * `[[Get]]` trap.  Frozen `Uint8Array` values backed by an immutable
 * `ArrayBuffer` (the byteArray passable form, produced by the
 * `@endo/immutable-arraybuffer` shim) are exposed as proxy objects; the
 * native `set` fast path may read zeros or throw when the backing buffer is
 * immutable.  We detect immutable buffers via the
 * `ArrayBuffer.prototype.immutable` accessor (installed by the shim) and copy
 * to a fresh mutable `Uint8Array` only when necessary.
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
const toMutableChunk = input => {
  const buf = /** @type {ArrayBuffer} */ (input.buffer);
  const { byteOffset, byteLength } = input;

  // When the backing buffer is immutable (shim or native stage-3), copy to
  // a fresh mutable Uint8Array so `result.set(chunk, offset)` works.
  if (/** @type {any} */ (buf).immutable === true) {
    return new Uint8Array(buf.slice(byteOffset, byteOffset + byteLength));
  }

  // Mutable buffer: return a Uint8Array view (no copy).
  return new Uint8Array(buf, byteOffset, byteLength);
};

/**
 * Concatenates a list of byte chunks into a single contiguous `Uint8Array`.
 *
 * Accepts a mix of plain mutable `Uint8Array` chunks and frozen
 * `Uint8Array` chunks backed by an immutable `ArrayBuffer` (the
 * byteArray passable form).  For mutable inputs, no per-chunk copy is made.
 * For immutable inputs, a single copy per chunk is made to satisfy
 * `Uint8Array.prototype.set`'s native fast path.  Only the output
 * allocation is new for mutable inputs.
 *
 * Empty input yields an empty `Uint8Array`.
 *
 * @param {ReadonlyArray<Uint8Array>} inputs
 * @returns {Uint8Array}
 */
export const concatBytes = inputs => {
  const chunks = inputs.map(toMutableChunk);
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
  return result;
};
harden(concatBytes);
