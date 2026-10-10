// @ts-check

/**
 * Endor build of `@endo/sha256/async`.
 *
 * Endor's host digest (`hostSha256Bytes`) is synchronous, so the async arm
 * wraps the synchronous Endor build in a promise.  The async API exists for
 * the browser's asynchronous WebCrypto; under Endor there is no async digest
 * primitive, and reusing the sync build keeps the two Endor arms identical and
 * still needs no new Rust.
 */

import harden from '@endo/harden';

import { sha256 as sha256Sync } from './sha256-endor.js';
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
