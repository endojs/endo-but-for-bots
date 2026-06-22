// @ts-check

import harden from '@endo/harden';
import { strictDecodeUtf8 as strictDecodeFromBytes } from '@endo/utf8/strict-decode.js';

/**
 * Decodes a passable `byteArray` value (a frozen `Uint8Array` backed by an
 * immutable `ArrayBuffer`) to a string.
 * Throws a `TypeError` on any malformed UTF-8 sequence rather than
 * substituting U+FFFD.
 *
 * Delegates to `@endo/utf8/strict-decode.js`, which handles immutable-backed
 * `Uint8Array` values by detecting the `ArrayBuffer.prototype.immutable`
 * accessor and copying to a mutable buffer only when `TextDecoder.decode`
 * requires it.
 *
 * Also accepts plain mutable `Uint8Array` values, any other `ArrayBufferView`,
 * or a bare `ArrayBufferLike`, for composability with non-passable inputs.
 *
 * @param {ArrayBufferView | ArrayBufferLike} input
 * @returns {string}
 */
export const strictDecodeUtf8 = input => strictDecodeFromBytes(input);
harden(strictDecodeUtf8);
