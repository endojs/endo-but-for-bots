// @ts-check

import harden from '@endo/harden';

/** @param {unknown} bytes */
export const assertUint8Array = bytes => {
  if (!(bytes instanceof Uint8Array)) {
    throw TypeError('sha256: expected a Uint8Array');
  }
};
harden(assertUint8Array);

/**
 * @param {Uint8Array} output
 * @param {number} offset
 */
export const assertOutput = (output, offset) => {
  assertUint8Array(output);
  if (!Number.isInteger(offset) || offset < 0 || output.length - offset < 32) {
    throw RangeError('sha256Into: output too small');
  }
};
harden(assertOutput);
