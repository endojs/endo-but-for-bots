// @ts-check

import harden from '@endo/harden';

/**
 * Compare two mutable `Uint8Array` values lexicographically.
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
  const lLen = left.length;
  const rLen = right.length;
  const minLen = lLen < rLen ? lLen : rLen;
  for (let i = 0; i < minLen; i += 1) {
    if (left[i] < right[i]) {
      return -1;
    }
    if (left[i] > right[i]) {
      return 1;
    }
  }
  // When one sequence is a prefix of the other, return the length difference.
  // left-prefix-of-right yields `leftLength - rightLength` (negative);
  // right-prefix-of-left yields a positive number.
  if (lLen !== rLen) {
    return lLen - rLen;
  }
  return 0;
};
harden(compareBytes);
