// @ts-check

import harden from '@endo/harden';
import { decodeUtf8 as decodeFromBytes } from '@endo/utf8/decode.js';

/**
 * Decodes a passable `byteArray` value (a frozen `Uint8Array` backed by an
 * immutable `ArrayBuffer`) to a string, substituting U+FFFD for any malformed
 * UTF-8 sequences.
 *
 * Delegates to `@endo/utf8/decode.js`, which handles immutable-backed
 * `Uint8Array` values by detecting the `ArrayBuffer.prototype.immutable`
 * accessor and copying to a mutable buffer only when `TextDecoder.decode`
 * requires it.
 * The copy is from the immutable backing buffer to a fresh mutable buffer;
 * the caller's `Uint8Array` wrapper is not modified.
 *
 * Also accepts plain mutable `Uint8Array` values, any other `ArrayBufferView`,
 * or a bare `ArrayBufferLike`, for composability with non-passable inputs.
 *
 * @param {ArrayBufferView | ArrayBufferLike} input
 * @returns {string}
 */
export const decodeUtf8 = input => decodeFromBytes(input);
harden(decodeUtf8);
