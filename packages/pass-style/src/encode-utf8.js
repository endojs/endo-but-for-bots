// @ts-check

import harden from '@endo/harden';
import { encodeUtf8 as encodeToMutableBytes } from '@endo/utf8/encode.js';

import { toBytes } from './to-bytes.js';

/**
 * Encodes a string as a passable `byteArray` value: a hardened frozen
 * `Uint8Array` backed by an immutable `ArrayBuffer`.
 *
 * Delegates to `@endo/utf8/encode.js` for the UTF-8 encoding itself, then
 * wraps the resulting mutable `Uint8Array` via `toBytes` to produce the
 * immutable passable form.
 *
 * This is the pass-style-aware counterpart to `@endo/utf8`'s `encodeUtf8`.
 * The `@endo/utf8` function produces a plain mutable `Uint8Array`; this
 * function produces a passable `byteArray` that can cross vat boundaries.
 *
 * @param {string} s
 * @returns {Uint8Array} A hardened frozen `Uint8Array` backed by an immutable
 *   `ArrayBuffer` (the byteArray passable form).
 */
export const encodeUtf8 = s => toBytes(encodeToMutableBytes(s));
harden(encodeUtf8);
