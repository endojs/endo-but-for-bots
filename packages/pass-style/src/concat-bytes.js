// @ts-check

import harden from '@endo/harden';
import { concatBytes as concatMutableBytes } from '@endo/bytes/concat.js';

import { toBytes } from './to-bytes.js';

// `@endo/bytes/concat.js` concatenates byte chunks, accepting both plain
// mutable `Uint8Array` values and frozen `Uint8Array` values backed by an
// immutable `ArrayBuffer` (the byteArray passable form).  Immutable chunks
// are detected via `ArrayBuffer.prototype.immutable` and copied to a mutable
// buffer before `Uint8Array.prototype.set` is called, working around the
// native TypedArray fast path that bypasses the shim proxy.  The accumulation
// result is a plain mutable `Uint8Array`; `toBytes` wraps it into the passable
// byteArray form.
//
// Dependency direction: `@endo/bytes` is a runtime dependency of
// `@endo/pass-style`.  The reverse direction (`@endo/pass-style` as a dep of
// `@endo/bytes`) exists only as a devDependency in `@endo/bytes` and is used
// only in tests — there is no runtime cycle.

/**
 * Concatenates a list of byteArray-passable values into a single hardened
 * frozen `Uint8Array` backed by an immutable `ArrayBuffer`.
 *
 * Accepts a mix of plain mutable `Uint8Array` values and frozen
 * `Uint8Array` values backed by an immutable `ArrayBuffer` (the byteArray
 * passable form).
 *
 * @param {ReadonlyArray<Uint8Array>} buffers
 * @returns {Uint8Array}
 */
export const concatBytes = buffers => {
  return toBytes(concatMutableBytes(buffers));
};
harden(concatBytes);
