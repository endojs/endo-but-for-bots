// @ts-check

import harden from '@endo/harden';

import { bytesFromImmutable } from './from-immutable.js';
import { bytesToImmutable } from './to-immutable.js';
import { concatBytes } from './concat.js';

/**
 * Concatenates a list of byteArray-passable values into a single hardened
 * frozen `Uint8Array` backed by an immutable `ArrayBuffer`.
 *
 * Equivalent to
 * `bytesToImmutable(concatBytes(buffers.map(bytesFromImmutable)))`,
 * provided as a single-call helper because the composition is common
 * when assembling protocol records from immutable byte fragments.
 *
 * The input element type is `ArrayBufferView | ArrayBufferLike` so the
 * helper accepts both the current byteArray shape (frozen `Uint8Array`)
 * and the prior raw-immutable-`ArrayBuffer` shape, easing the
 * cross-version transition.
 *
 * @param {ReadonlyArray<ArrayBufferView | ArrayBufferLike>} buffers
 * @returns {Uint8Array}
 */
export const concatImmutables = buffers =>
  bytesToImmutable(concatBytes(buffers.map(bytesFromImmutable)));
harden(concatImmutables);
