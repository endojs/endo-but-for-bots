// @ts-check

import harden from '@endo/harden';
import { installedSliceToImmutable } from './install-to-immutable.js';

/**
 * Wraps a `Uint8Array` view's contents in an immutable `ArrayBuffer`.
 *
 * Calls through to the realm's `ArrayBuffer.prototype[Symbol.for('sliceToImmutable')]`
 * slot installed by `@endo/bytes` (see `./install-to-immutable.js`).
 * When the immutable-`ArrayBuffer` shim or a native implementation
 * later puts the standardized `ArrayBuffer.prototype.sliceToImmutable`
 * at the same rendezvous, this function prefers the installed value.
 * The resulting buffer carries the `'byteArray'` passStyle and is safe
 * to share across vat boundaries. The result is hardened so it is
 * passable.
 *
 * Honors the view's `byteOffset` and `byteLength`, so passing a
 * `subarray` copies only that window.
 *
 * @param {Uint8Array} view
 * @returns {ArrayBuffer} A hardened immutable `ArrayBuffer`.
 */
export const bytesToImmutable = view => {
  const immutable = installedSliceToImmutable.call(
    /** @type {ArrayBuffer} */ (view.buffer),
    view.byteOffset,
    view.byteOffset + view.byteLength,
  );
  return harden(immutable);
};
harden(bytesToImmutable);
