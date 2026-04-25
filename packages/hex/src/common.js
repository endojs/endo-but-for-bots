// @ts-check

// Shared constants for the @endo/hex encoder and decoder.

export const hexAlphabetLower = '0123456789abcdef';
export const hexAlphabetUpper = '0123456789ABCDEF';

/**
 * Map from ASCII character code to nibble value, or -1 if the code is not a
 * valid hex digit.  Covers both `0-9a-fA-F`.
 *
 * @type {readonly number[]}
 */
export const hexDigitTable = (() => {
  const table = new Array(256).fill(-1);
  for (let i = 0; i < 10; i += 1) {
    table['0'.charCodeAt(0) + i] = i;
  }
  for (let i = 0; i < 6; i += 1) {
    table['a'.charCodeAt(0) + i] = 10 + i;
    table['A'.charCodeAt(0) + i] = 10 + i;
  }
  return table;
})();
