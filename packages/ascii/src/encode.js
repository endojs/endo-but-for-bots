// @ts-check

import harden from '@endo/harden';

/**
 * Encodes ASCII text to bytes, one byte per UTF-16 code unit, asserting that
 * every code unit is in the admitted 7-bit range `0x00`–`0x7f` and hard-failing
 * on the first code unit that is not.
 *
 * Pure JavaScript with no `TextEncoder`, no `node:` imports, and no host
 * globals, so it imports and runs under XS (`xst`) exactly as it does under
 * Node.js and browsers. It replaces the ad-hoc
 * `Uint8Array.from(text, ch => ch.charCodeAt(0))` helper that XS bundles reach
 * for because XS lacks `TextEncoder`, but truncates rather than rejects a
 * non-ASCII code unit.
 *
 * This is the narrow, XS-floor primitive for protocol text that is ASCII by
 * construction: a stray non-ASCII code unit is a bug to surface, not to
 * silently mangle. Callers that need to encode arbitrary Unicode text as UTF-8
 * want a different tool.
 *
 * @param {string} text
 * @param {string} [name] Name of the string, for error diagnostics.
 * @returns {Uint8Array}
 */
export const encodeAscii = (text, name = '<unknown>') => {
  if (typeof text !== 'string') {
    throw TypeError(`ascii: expected a string to encode, got ${typeof text}`);
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    // `charCodeAt` returns an integer in `0`–`0xffff`, so the single
    // upper-bound check admits exactly `0x00`–`0x7f` and rejects everything
    // from `0x80` up, including the non-BMP surrogate halves.
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw RangeError(
        `Non-ASCII code unit 0x${code.toString(16)} at offset ${i} of string ${name}`,
      );
    }
    bytes[i] = code;
  }
  return bytes;
};
harden(encodeAscii);
