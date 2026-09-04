// @ts-check

/**
 * Node build of `@endo/sha256`: `node:crypto`'s SHA-256.
 *
 * Only this file imports `node:crypto`.  Every consumer that has to
 * survive a bundler imports `@endo/sha256` instead, and the bundler's
 * conditions steer it away from here.
 */

import { createHash } from 'node:crypto';

import harden from '@endo/harden';

import { DIGEST_LENGTH, assertBytes, makeSha256Into } from './shared.js';

/**
 * One-shot SHA-256 over binary input.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} the raw 32-byte digest
 */
export const sha256 = bytes => {
  const digest = createHash('sha256')
    .update(assertBytes(bytes, 'bytes'))
    .digest();
  // Copy off the `Buffer` so the result is a plain `Uint8Array`, the
  // same type every other condition build returns.  A `Buffer` would
  // leak Node-only methods (`toString('base64')`, `readUInt32BE`) that
  // callers must not come to depend on.
  return new Uint8Array(
    digest.buffer,
    digest.byteOffset,
    DIGEST_LENGTH,
  ).slice();
};
harden(sha256);

/**
 * Bring-your-own-buffer variant: write the 32-byte digest into `out` at
 * `offset` and return the number of bytes written.
 *
 * @type {(out: Uint8Array, bytes: Uint8Array, offset?: number) => number}
 */
export const sha256Into = makeSha256Into(sha256);
