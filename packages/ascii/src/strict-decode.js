import harden from '@endo/harden';

/**
 * Decodes ASCII bytes to a string.
 * Throws a `RangeError` if any byte value exceeds 127.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const strictDecodeAscii = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const code = bytes[i];
    if (code > 127) {
      throw RangeError(
        `strictDecodeAscii: byte at index ${i} has value ${code}, which exceeds the ASCII range (0-127)`,
      );
    }
    s += String.fromCharCode(code);
  }
  return s;
};
harden(strictDecodeAscii);
