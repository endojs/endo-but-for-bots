/* global globalThis */
import '../shim.js';
import harden from '@endo/harden';

const {
  ArrayBuffer,
  Reflect,
  Uint8Array,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const { sliceToImmutable } = /**
   @type {{
  sliceToImmutable: typeof ArrayBuffer.prototype.slice,
}} */ (/** @type {unknown} */ (ArrayBuffer.prototype));
const { isView } = ArrayBuffer;
const { apply } = Reflect;

/**
 * The shared byte-conversion utilities that pair with the immutable
 * `ArrayBuffer` shim: `frozenBytes` produces a hardened frozen
 * `Uint8Array` backed by an immutable `ArrayBuffer`, and `thawedBytes`
 * copies such a value's contents back out into a fresh mutable
 * `Uint8Array`. They are inverses over the byte contents.
 *
 * Importing this module triggers the `@endo/immutable-arraybuffer/shim.js`
 * install (so the emulated freezable `Uint8Array` constructor is present),
 * the same side effect the shim export provides on its own. The shim
 * remains available as the separate `@endo/immutable-arraybuffer/shim.js`
 * export for callers that only want the platform install.
 */

/**
 * Wraps a `Uint8Array` view's contents in a hardened frozen `Uint8Array`
 * backed by an immutable `ArrayBuffer`.
 *
 * Slices the view's window into a fresh immutable `ArrayBuffer`, then wraps
 * that in a fresh `Uint8Array` and hardens the wrapper. The resulting
 * wrapper carries the `'byteArray'` passStyle and is safe to share across
 * vat boundaries. Hardening the wrapper also hardens the underlying
 * immutable buffer.
 *
 * Honors the view's `byteOffset` and `byteLength`, so passing a
 * `subarray` copies only that window.
 *
 * @param {Uint8Array} view
 * @returns {Uint8Array} A hardened frozen `Uint8Array` backed by an
 *   immutable `ArrayBuffer`.
 */
export const frozenBytes = view => {
  const immutable = apply(
    /** @type {typeof ArrayBuffer.prototype.slice} */ (sliceToImmutable),
    /** @type {ArrayBuffer} */ (view.buffer),
    [view.byteOffset, view.byteOffset + view.byteLength],
  );
  return harden(new Uint8Array(immutable));
};
harden(frozenBytes);

/**
 * Copies the contents of a `Uint8Array` into a fresh mutable `Uint8Array`.
 *
 * The hardened frozen `Uint8Array` produced by `frozenBytes` cannot itself
 * be written through, and consumers such as `TextDecoder.decode` reject
 * views over immutable buffers. This helper produces a working mutable
 * `Uint8Array` copy that callers can pass to those APIs.
 *
 * The parameter type is `Uint8Array` - the narrowed byteArray shape (issue
 * #573), never a bare `ArrayBufferLike` nor some other `ArrayBufferView`.
 * `ArrayBuffer.isView` distinguishes a genuine view from the shim's ordinary
 * emulated wrapper. The result is always a fresh, mutable `Uint8Array`.
 *
 * This function is intentionally unary because callers use it directly as an
 * `Array.prototype.map` callback. It must not inspect the callback's index or
 * array arguments and cannot acquire an options-bag parameter.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export const thawedBytes = bytes => {
  if (!isView(bytes)) {
    // An emulated frozen `Uint8Array` wrapper, whose `.slice` is the
    // freezable-TypedArray method installed by the shim, amplifying the
    // immutable backing to a mutable copy.
    // eslint-disable-next-line @endo/no-polymorphic-call
    return new Uint8Array(/** @type {Uint8Array} */ (bytes).slice(0));
  }
  // A genuine view (including a genuine view over an immutable buffer):
  // copy its window out of the backing buffer. `.slice` here reaches the
  // `ArrayBuffer` method - the shim's replacement, which amplifies an
  // immutable backing buffer to its mutable copy.
  return new Uint8Array(
    // eslint-disable-next-line @endo/no-polymorphic-call
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
};
harden(thawedBytes);
