// @ts-check

import harden from '@endo/harden';
import { sliceBufferToImmutable } from '@endo/immutable-arraybuffer';
import { CapturedUint8Array } from './install-helpers.js';

/**
 * Concatenates a list of immutable `ArrayBuffer` values into a single
 * hardened immutable `ArrayBuffer`.
 *
 * Pure-JS helper. Equivalent in behavior to
 * `bytesToImmutable(concatBytes(buffers.map(bytesFromImmutable)))`,
 * provided as a single-call helper because the composition is common
 * when assembling protocol records from immutable byte fragments.
 *
 * No realm-wide rendezvous is required for this composition: each
 * eval twin of `@endo/bytes` can perform the same composition over the
 * same captured `Uint8Array` constructor and the same
 * `sliceBufferToImmutable` pony, and the resulting immutable
 * `ArrayBuffer` values are equivalent. There is no proposed standard
 * `ArrayBuffer.concatImmutables`; if one arrives later, callers can
 * adopt it without renaming this helper.
 *
 * @param {ReadonlyArray<ArrayBufferLike>} buffers
 * @returns {ArrayBuffer}
 */
export const concatImmutables = buffers => {
  let totalLength = 0;
  for (const b of buffers) {
    totalLength += b.byteLength;
  }
  const result = new CapturedUint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    result.set(new CapturedUint8Array(b.slice(0)), offset);
    offset += b.byteLength;
  }
  const immutable = sliceBufferToImmutable(
    result.buffer,
    result.byteOffset,
    result.byteOffset + result.byteLength,
  );
  return harden(/** @type {ArrayBuffer} */ (immutable));
};
harden(concatImmutables);
