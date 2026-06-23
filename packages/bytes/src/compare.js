// @ts-check

import harden from '@endo/harden';

/**
 * Normalize a `Uint8Array` to a mutable `Uint8Array` that supports
 * integer-indexed access (`bytes[i]`).
 *
 * Frozen `Uint8Array` values backed by an immutable `ArrayBuffer` (the
 * byteArray passable form, produced by the `@endo/immutable-arraybuffer` shim)
 * are wrapped as plain objects; integer-indexed access on those wrappers
 * returns `undefined` because they carry no integer-indexed own properties and
 * are not exotic integer-indexed objects.  We detect immutable backing buffers
 * via the `ArrayBuffer.prototype.immutable` accessor and copy to a mutable
 * `Uint8Array` only when necessary.  Plain mutable inputs get a view (no copy).
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
const toIndexableUint8 = input => {
  const buf = /** @type {ArrayBuffer} */ (input.buffer);
  const { byteOffset, byteLength } = input;

  if (/** @type {any} */ (buf).immutable === true) {
    // Copy to a genuine mutable Uint8Array so integer-indexed access works.
    return new Uint8Array(buf.slice(byteOffset, byteOffset + byteLength));
  }

  return new Uint8Array(buf, byteOffset, byteLength);
};

/**
 * Compare two byte sequences lexicographically.
 *
 * Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`
 * (the byteArray passable form) or a plain mutable `Uint8Array`.
 * Immutable inputs are copied to a mutable `Uint8Array` so that
 * integer-indexed comparison works correctly; the
 * `@endo/immutable-arraybuffer` shim's frozen wrappers do not support
 * `bytes[i]` directly.
 *
 * Returns a negative number when `left` sorts before `right`, `0` when
 * the two sequences are byte-for-byte equal, and a positive number when
 * `left` sorts after `right`.  When neither sequence is empty and the
 * shorter is a prefix of the longer, returns the length difference
 * (`leftLength - rightLength`).
 *
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {number}
 */
export const compareBytes = (left, right) => {
  const l = toIndexableUint8(left);
  const r = toIndexableUint8(right);
  const lLen = l.length;
  const rLen = r.length;
  const minLen = lLen < rLen ? lLen : rLen;
  for (let i = 0; i < minLen; i += 1) {
    if (l[i] < r[i]) {
      return -1;
    }
    if (l[i] > r[i]) {
      return 1;
    }
  }
  // When one sequence is a prefix of the other, return the length difference.
  // This matches the `compareUint8Arrays` contract: left-prefix-of-right yields
  // `leftLength - rightLength` (negative), right-prefix-of-left yields `1`.
  if (lLen !== rLen) {
    return lLen - rLen;
  }
  return 0;
};
harden(compareBytes);
