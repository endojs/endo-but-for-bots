/**
 * Coerce a byte-array `Uint8Array` to a genuine view only when necessary for
 * historical indexed-access compatibility.
 *
 * This is a stopgap for the ordinary-object wrapper produced by the
 * `@endo/immutable-arraybuffer` emulation.
 * That wrapper is typed as a `Uint8Array`, but `ArrayBuffer.isView` is false and
 * an integer-indexed read such as `bytes[index]` returns `undefined`.
 * Genuine mutable and immutable views pass through without allocation; an
 * emulated view is copied into a fresh mutable `Uint8Array`.
 *
 * Prefer an algorithm that reads `bytes.at(index)` when its performance is
 * acceptable.
 * Any use of this coercion should cite a multi-platform benchmark that compares
 * the indexed algorithm with the corresponding `at(index)` algorithm.
 * The relevant comparison is on platforms where the pure-JavaScript fallback
 * runs, since many bytewise algorithms have faster platform-native equivalents.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export const toIndexableUint8Array = bytes => {
  if (ArrayBuffer.isView(bytes)) {
    return bytes;
  }
  return new Uint8Array(/** @type {Uint8Array} */ (bytes).slice(0));
};
