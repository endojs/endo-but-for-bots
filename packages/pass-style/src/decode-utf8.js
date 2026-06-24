// @ts-check

import harden from '@endo/harden';
import { decodeUtf8 as decodeFromBytes } from '@endo/utf8/decode.js';

/**
 * Decodes a passable `byteArray` value (a frozen `Uint8Array` backed by an
 * immutable `ArrayBuffer`) to a string, substituting U+FFFD for any malformed
 * UTF-8 sequences.
 *
 * Delegates to `@endo/utf8/decode.js`, which internally downgrades a
 * PassableBytes (emulated frozen `Uint8Array` backed by an immutable
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
export const decodeUtf8 = input => decodeFromBytes(input);
harden(decodeUtf8);
