// @ts-check

import '@endo/immutable-arraybuffer/shim.js';
import harden from '@endo/harden';

/**
 * Wraps a `Uint8Array` view's contents in an immutable `ArrayBuffer`.
 *
 * Calls the `ArrayBuffer.prototype.sliceToImmutable` method installed
 * by the `@endo/immutable-arraybuffer` shim. This module imports the
 * shim itself so callers do not need to arrange for it to be installed
 * first; the shim's race-to-install yields silently to any prior
 * installer, so multiple importers across realm twins coexist without
 * conflict. The resulting buffer carries the `'byteArray'` passStyle
 * and is safe to share across vat boundaries. The result is hardened
 * so it is passable.
 *
 * Honors the view's `byteOffset` and `byteLength`, so passing a
 * `subarray` copies only that window.
 *
 * @param {Uint8Array} view
 * @returns {ArrayBuffer} A hardened immutable `ArrayBuffer`.
 */
export const bytesToImmutable = view => {
  const immutable =
    /** @type {ArrayBuffer} */ (view.buffer).sliceToImmutable(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    );
  return harden(immutable);
};
harden(bytesToImmutable);
