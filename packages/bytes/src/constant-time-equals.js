import harden from '@endo/harden';
import { toIndexableUint8Array } from './indexed.js';

/**
 * Compares two byte sequences without data-dependent early exits.
 *
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {boolean}
 */
export const constantTimeBytesEqual = (left, right) => {
  const indexableLeft = toIndexableUint8Array(left);
  const indexableRight = toIndexableUint8Array(right);
  if (indexableLeft.length !== indexableRight.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < indexableLeft.length; index += 1) {
    // Constant-time byte comparison: bitwise OR over byte XORs.
    // eslint-disable-next-line no-bitwise
    difference |= indexableLeft[index] ^ indexableRight[index];
  }
  return difference === 0;
};
harden(constantTimeBytesEqual);
