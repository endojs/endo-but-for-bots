// @ts-check

/**
 * Endor build of `@endo/sha256`.
 *
 * This implementation depends on the Endor host contract, not on a
 * particular JavaScript engine. Both Endor/XS and Endor/IronHorse provide
 * `hostSha256Bytes` before evaluating application modules.
 */

import harden from '@endo/harden';
import { assertBytes, assertDigest, makeSha256Into } from './shared.js';

/**
 * One-shot SHA-256 over binary input.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} the raw 32-byte digest
 */
export const sha256 = bytes => {
  const { hostSha256Bytes } = /** @type {Record<string, any>} */ (globalThis);
  if (typeof hostSha256Bytes !== 'function') {
    throw Error('@endo/sha256: Endor hostSha256Bytes is unavailable');
  }
  const raw = hostSha256Bytes(assertBytes(bytes, 'bytes'));
  if (!(raw instanceof ArrayBuffer) && !(raw instanceof Uint8Array)) {
    throw Error(
      `@endo/sha256: hostSha256Bytes returned ${typeof raw}, expected an ArrayBuffer or Uint8Array`,
    );
  }
  // Copy so a host that reuses a scratch buffer cannot mutate a digest the
  // caller has already published as a content address.
  return assertDigest(
    raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw).slice(),
    'hostSha256Bytes',
  );
};
harden(sha256);

/**
 * Bring-your-own-buffer variant: write the 32-byte digest into `out` at
 * `offset` and return the number of bytes written.
 *
 * @type {(out: Uint8Array, bytes: Uint8Array, offset?: number) => number}
 */
export const sha256Into = makeSha256Into(sha256);
