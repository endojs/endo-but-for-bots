import harden from '@endo/harden';

/**
 * Encodes a string as ASCII bytes (one byte per character).
 * Throws a `RangeError` if any character code exceeds 127 (out of range 0-127).
 *
 * @param {string} s
 * @returns {Uint8Array}
 */
export const encodeAscii = s => {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code > 127) {
      throw RangeError(
        `encodeAscii: character at index ${i} has code ${code}, which exceeds the ASCII range (0-127)`,
      );
    }
    bytes[i] = code;
  }
  return bytes;
};
harden(encodeAscii);
