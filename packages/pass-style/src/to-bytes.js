// @ts-check

import '@endo/immutable-arraybuffer/shim.js';
import harden from '@endo/harden';

/**
 * Wraps a `Uint8Array` view's contents in a hardened frozen `Uint8Array`
 * backed by an immutable `ArrayBuffer`, producing a passable byteArray
 * value.
 *
 * Calls the `sliceToImmutable` method installed by
 * `@endo/immutable-arraybuffer/shim.js` on `ArrayBuffer.prototype`,
 * then wraps the resulting immutable `ArrayBuffer` in a fresh
 * `Uint8Array` and hardens that wrapper.
 * Importing this module triggers the shim install, so the caller does
 * not need to arrange for it separately.
 * The resulting wrapper carries the `'byteArray'` passStyle and is safe
 * to share across vat boundaries.
 * Hardening the wrapper also hardens the underlying immutable buffer.
 *
 * Honors the view's `byteOffset` and `byteLength`, so passing a
 * `subarray` copies only that window.
 *
 * @param {Uint8Array} view
 * @returns {Uint8Array} A hardened frozen `Uint8Array` backed by an
 *   immutable `ArrayBuffer`.
 */
export const toBytes = view => {
  const buffer = /** @type {ArrayBuffer} */ (view.buffer);
  const immutable = buffer.sliceToImmutable(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  );
  return harden(new Uint8Array(immutable));
};
harden(toBytes);
