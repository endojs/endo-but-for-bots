// @ts-check

/**
 * Node build of `@endo/sha256/async`.
 *
 * `node:crypto`'s `createHash('sha256')` is already synchronous and fast, so
 * the async arm simply wraps the synchronous node build in a promise rather
 * than reaching for `crypto.subtle.digest`.  The point of the async API is to
 * let the *browser* use WebCrypto (`src/sha256-browser-async.js`); Node has no
 * async digest worth the extra host round trip, and reusing the sync build
 * keeps the two node arms byte-for-byte identical.
 */

import harden from '@endo/harden';

import { sha256 as sha256Sync } from './sha256-node.js';
import { makeSha256IntoAsync } from './shared.js';

/**
 * One-shot SHA-256 over binary input.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>} the raw 32-byte digest
 */
export const sha256Async = async bytes => sha256Sync(bytes);
harden(sha256Async);

/**
 * Bring-your-own-buffer variant: write the 32-byte digest into `out` at
 * `offset` and resolve to the number of bytes written.
 *
 * @type {(out: Uint8Array, bytes: Uint8Array, offset?: number) => Promise<number>}
 */
export const sha256IntoAsync = makeSha256IntoAsync(sha256Async);
