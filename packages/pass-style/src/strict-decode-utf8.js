// @ts-check

import harden from '@endo/harden';
import { strictDecodeUtf8 as strictDecodeFromBytes } from '@endo/utf8/strict-decode.js';

/**
 * Decodes a passable `byteArray` value (a frozen `Uint8Array` backed by an
 * immutable `ArrayBuffer`) to a string.
 * Throws a `TypeError` on any malformed UTF-8 sequence rather than
 * substituting U+FFFD.
 *
 * Delegates to `@endo/utf8/strict-decode.js`, which internally downgrades
 * a PassableBytes (emulated frozen `Uint8Array` backed by an immutable
 * `ArrayBuffer`) to a plain mutable `Uint8Array` copy before passing to
 * `TextDecoder.decode`, which rejects immutable-backed views.
 * Authentic mutable `Uint8Array` values are passed through without a copy.
 *
 * Also accepts plain mutable `Uint8Array` values for composability with
 * non-passable inputs.
 *
 * @param {Uint8Array} input
 * @returns {string}
 */
export const strictDecodeUtf8 = input => strictDecodeFromBytes(input);
harden(strictDecodeUtf8);
