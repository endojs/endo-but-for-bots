// @ts-nocheck

/**
 * Installs `ArrayBuffer.prototype[Symbol.for('sliceToImmutable')]`.
 *
 * The installed method returns an immutable `ArrayBuffer` whose
 * contents are a copy of the requested window of `this`. The function
 * is method-style: `this` is the source buffer.
 *
 * The rendezvous symbol is the same name as the proposed
 * `ArrayBuffer.prototype.sliceToImmutable` method
 * (proposal-immutable-arraybuffer), so a native implementation that
 * later places the standard method at the proposal's name composes
 * cleanly with this install.
 */

import { sliceBufferToImmutable } from '@endo/immutable-arraybuffer';
import { CapturedArrayBuffer, installOrAdopt } from './install-helpers.js';

const symSliceToImmutable = Symbol.for('sliceToImmutable');

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
  symSliceToImmutable,
  installedSlice,
);

export { symSliceToImmutable };
