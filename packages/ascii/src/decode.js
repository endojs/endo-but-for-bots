// @ts-check

import harden from '@endo/harden';

/**
 * Decodes bytes to ASCII text, one UTF-16 code unit per byte, asserting that
 * every byte is in the admitted 7-bit range `0x00`–`0x7f` and hard-failing on
 * the first byte that is not. It is the exact inverse of `encodeAscii`: what
 * `encodeAscii` admits, `decodeAscii` round-trips, and what `encodeAscii`
 * rejects, `decodeAscii` refuses to have produced.
 *
 * Pure JavaScript with no `TextDecoder`, no `node:` imports, and no host
 * globals, so it imports and runs under XS (`xst`) exactly as it does under
 * Node.js and browsers. It is also the strict counterpart the `TextDecoder`
 * label `'ascii'` is not: per the WHATWG Encoding Standard that label is an
 * alias for `windows-1252`, so `new TextDecoder('ascii', { fatal: true })`
 * silently maps bytes `0x80`–`0xff` to Latin-1/windows-1252 characters instead
 * of throwing — the exact trap this primitive avoids.
 *
 * @param {Uint8Array} bytes
 * @param {string} [name] Name of the bytes, for error diagnostics.
 * @returns {string}
 */
export const decodeAscii = (bytes, name = '<unknown>') => {
  if (!(bytes instanceof Uint8Array)) {
    throw TypeError(
      `ascii: expected a Uint8Array to decode, got ${typeof bytes}`,
    );
  }
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte > 0x7f) {
      throw RangeError(
        `Non-ASCII byte 0x${byte.toString(16)} at offset ${i} of bytes ${name}`,
      );
    }
    text += String.fromCharCode(byte);
  }
  return text;
};
harden(decodeAscii);
