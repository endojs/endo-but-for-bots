// @ts-nocheck

/**
 * Installs `ArrayBuffer.prototype.sliceToImmutable`.
 *
 * The installed method returns an immutable `ArrayBuffer` whose
 * contents are a copy of the requested window of `this`. The function
 * is method-style: `this` is the source buffer.
 *
 * The rendezvous key is the proposed standard name
 * `sliceToImmutable` (proposal-immutable-arraybuffer), so a native
 * implementation or the `@endo/immutable-arraybuffer` shim that
 * places the standard method at the same name composes cleanly with
 * this install: `installOrAdopt` finds the existing method and adopts
 * it as the canonical reference.
 */

import { sliceBufferToImmutable } from '@endo/immutable-arraybuffer';
import { CapturedArrayBuffer, installOrAdopt } from './install-helpers.js';

/**
 * @this {ArrayBuffer}
 * @param {number} [start]
 * @param {number} [end]
 */
function installedSlice(start, end) {
  return sliceBufferToImmutable(this, start, end);
}

export const installedSliceToImmutable = installOrAdopt(
  CapturedArrayBuffer.prototype,
  'sliceToImmutable',
  installedSlice,
);
