// @ts-check

// Node.js implementation: thin bridge over `node:crypto`.

import { createHash } from 'node:crypto';

/**
 * One-shot SHA-256 over binary input, returning the raw 32-byte digest.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}  // length 32
 */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

/**
 * Bring-your-own-buffer variant: write the 32-byte digest into `out`
 * at `offset` and return the number of bytes written (32). Throws
 * RangeError if `out.length - offset < 32`.
 * @param {Uint8Array} out
 * @param {Uint8Array} bytes
 * @param {number} [offset=0]
 * @returns {number}
 */
export const sha256Into = (out, bytes, offset = 0) => {
  if (out.length - offset < 32) {
    throw new RangeError('output buffer too small for SHA-256 digest');
  }
  out.set(createHash('sha256').update(bytes).digest(), offset);
  return 32;
};
