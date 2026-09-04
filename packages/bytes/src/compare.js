import harden from '@endo/harden';
import { toIndexableUint8Array } from './indexed.js';

/**
 * Compare two byte sequences lexicographically.
 *
 * Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`
 * (the byteArray passable form) or a plain mutable `Uint8Array`. A genuine
 * view is compared in place; an emulated `@endo/immutable-arraybuffer` wrapper
 * (typed `Uint8Array` but `ArrayBuffer.isView === false`, so `bytes[i]` reads
 * `undefined`) is first copied into a mutable `Uint8Array` so that
 * integer-indexed comparison works correctly.
 *
 * Returns a negative number when `left` sorts before `right`, `0` when
 * the two sequences are byte-for-byte equal, and a positive number when
 * `left` sorts after `right`. When neither sequence is empty and the
 * shorter is a prefix of the longer, returns the length difference
 * (`leftLength - rightLength`).
 *
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {number}
 */
export const compareBytes = (left, right) => {
  const l = toIndexableUint8Array(left);
  const r = toIndexableUint8Array(right);
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
  // When one sequence is a prefix of the other, return the length difference
  // (`leftLength - rightLength`): a left-prefix-of-right sorts first (negative
  // result), a right-prefix-of-left sorts last (positive result).
  if (lLen !== rLen) {
    return lLen - rLen;
  }
  return 0;
};
harden(compareBytes);
