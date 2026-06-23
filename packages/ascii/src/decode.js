import harden from '@endo/harden';

/**
 * Decodes ASCII bytes to a string.
 * Bytes outside the ASCII range (0-127) are passed through without
 * error; use `strictDecodeAscii` to reject them.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const decodeAscii = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
};
harden(decodeAscii);
