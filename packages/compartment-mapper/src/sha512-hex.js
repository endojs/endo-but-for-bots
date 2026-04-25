// @ts-check
/**
 * SHA-512 hex hash factory using `@endo/hex` to format the digest.
 *
 * Kept in a separate module from `node-powers.js` so consumers that
 * load `node-powers.js` before SES lockdown (e.g. test scaffolding
 * that imports `'ses'` directly and runs `lockdown()` later) do not
 * pull `@endo/hex` into their pre-lockdown import graph.
 * `@endo/hex` calls `harden()` at module top level via `@endo/harden`,
 * which installs a fallback `harden` if no real implementation is
 * present yet.  That fallback then prevents `lockdown()` from
 * succeeding.  Production callers that initialize SES via `@endo/init`
 * before requiring this module are unaffected and benefit from the
 * shared hex implementation, which dispatches to the native
 * `Uint8Array.prototype.toHex` intrinsic when available.
 *
 * @module
 */

import harden from '@endo/harden';
import { encodeHex } from '@endo/hex';

/**
 * @import {CryptoInterface} from './types/node-powers.js'
 * @import {HashFn} from './types/powers.js'
 */

/**
 * Creates a {@link HashFn} suitable for the optional `computeSha512`
 * parameter of {@link import('./node-powers.js').makeReadPowers}.
 * Delegates digest formatting to `@endo/hex`'s `encodeHex`, which
 * dispatches to the native `Uint8Array.prototype.toHex` intrinsic
 * when available.
 *
 * If both `computeSha512` and `crypto` are passed to `makeReadPowers`,
 * `computeSha512` wins and `crypto` is unused for hashing.
 *
 * @param {CryptoInterface} crypto - the Node `node:crypto` module or a
 *   compatible adapter.
 * @returns {HashFn}
 */
export const makeComputeSha512 = crypto => {
  /** @type {HashFn} */
  const computeSha512 = bytes => {
    const hash = crypto.createHash('sha512');
    hash.update(bytes);
    return encodeHex(hash.digest());
  };
  return harden(computeSha512);
};
harden(makeComputeSha512);
