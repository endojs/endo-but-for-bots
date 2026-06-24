// @ts-check

import harden from '@endo/harden';

/**
 * Compare two `Uint8Array` values lexicographically, with optional
 * start/end slicing.
 *
 * Returns a negative number when `left` sorts before `right`, `0` when
 * the two sequences are byte-for-byte equal, and a positive number when
 * `left` sorts after `right`.
 *
 * When `leftStart`, `leftEnd`, `rightStart`, or `rightEnd` are provided,
 * the comparison is restricted to those subranges — no extra allocations
 * are needed for in-place subrange comparisons.
 *
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @param {number} [leftStart]
 * @param {number} [leftEnd]
 * @param {number} [rightStart]
 * @param {number} [rightEnd]
 * @returns {number}
 */
export const compareBytes = (
  left,
  right,
  leftStart = 0,
  leftEnd = left.length,
  rightStart = 0,
  rightEnd = right.length,
) => {
  const leftLength = leftEnd - leftStart;
  const rightLength = rightEnd - rightStart;
  let leftIndex = leftStart;
  let rightIndex = rightStart;
  for (;;) {
    if (leftIndex >= leftEnd) {
      // Left exhausted; equal if right is also exhausted, otherwise left < right.
      return leftLength - rightLength;
    }
    if (rightIndex >= rightEnd) {
      // Right exhausted but left is not; left > right.
      return 1;
    }
    if (left[leftIndex] < right[rightIndex]) {
      return -1;
    }
    if (left[leftIndex] > right[rightIndex]) {
      return 1;
    }
    leftIndex += 1;
    rightIndex += 1;
  }
};
harden(compareBytes);
