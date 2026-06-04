// @ts-check

import harden from '@endo/harden';
import { concatImmutablesFunction } from './spackle-install.js';

/**
 * Concatenates a list of immutable `ArrayBuffer` values into a single
 * hardened immutable `ArrayBuffer`.
 *
 * Calls through to the realm's `ArrayBuffer[Symbol.for('concatImmutables')]`
 * slot installed by the `@endo/bytes` spackle (see
 * `./spackle-install.js`). Equivalent in behavior to
 * `bytesToImmutable(concatBytes(buffers.map(bytesFromImmutable)))`,
 * provided as a single-call helper because the composition is common
 * when assembling protocol records from immutable byte fragments.
 *
 * @param {ReadonlyArray<ArrayBufferLike>} buffers
 * @returns {ArrayBuffer}
 */
export const concatImmutables = buffers =>
  harden(/** @type {ArrayBuffer} */ (concatImmutablesFunction(buffers)));
harden(concatImmutables);
