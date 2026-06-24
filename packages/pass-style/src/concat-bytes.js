// @ts-check

import harden from '@endo/harden';
import { concatBytes as concatMutableBytes } from '@endo/bytes/concat.js';

import { thawnBytes } from './from-bytes.js';
import { frozenBytes } from './to-bytes.js';

/**
 * Concatenates a list of passable byteArray values into a single passable
 * byteArray (frozen `Uint8Array` backed by an immutable `ArrayBuffer`).
 *
 * Each input byteArray is first extracted to a mutable `Uint8Array` via
 * `thawnBytes`, then the mutable chunks are concatenated by
 * `@endo/bytes/concat.js`, and the result is wrapped back into a passable
 * byteArray via `frozenBytes`.
 *
 * @param {ReadonlyArray<Uint8Array>} buffers
 * @returns {Uint8Array}
 */
export const concatBytes = buffers => {
  return frozenBytes(concatMutableBytes(buffers.map(thawnBytes)));
};
harden(concatBytes);
