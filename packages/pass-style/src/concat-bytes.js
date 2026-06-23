// @ts-check

import harden from '@endo/harden';
import { concatBytes as concatMutableBytes } from '@endo/bytes/concat.js';

import { fromBytes } from './from-bytes.js';
import { toBytes } from './to-bytes.js';

/**
 * Concatenates a list of passable byteArray values into a single passable
 * byteArray (frozen `Uint8Array` backed by an immutable `ArrayBuffer`).
 *
 * Each input byteArray is first extracted to a mutable `Uint8Array` via
 * `fromBytes`, then the mutable chunks are concatenated by
 * `@endo/bytes/concat.js`, and the result is wrapped back into a passable
 * byteArray via `toBytes`.
 *
 * @param {ReadonlyArray<Uint8Array>} buffers
 * @returns {Uint8Array}
 */
export const concatBytes = buffers => {
  return toBytes(concatMutableBytes(buffers.map(fromBytes)));
};
harden(concatBytes);
