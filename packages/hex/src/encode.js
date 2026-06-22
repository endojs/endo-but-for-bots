/* eslint no-bitwise: ["off"] */

import harden from '@endo/harden';

// Capture `Reflect.apply` once at module load; we prefer it to
// `Function.prototype.call` even where `.call` is assumed to be
// primordial, so a tampered `Function.prototype.call` cannot redirect
// the dispatched native intrinsic invocation.
const { apply } = Reflect;
const { isView } = ArrayBuffer;

const hexAlphabet = '0123456789abcdef';

/**
 * Normalize an `ArrayBufferView | ArrayBufferLike` to an indexed-readable
 * `Uint8Array`-shaped object without copying bytes.
 *
 * For a frozen `Uint8Array` backed by an immutable `ArrayBuffer` (the
 * byteArray passable form), this returns the input unchanged — both
 * the JS polyfill and native `toHex` read through the frozen view without
 * needing a mutable copy.
 *
 * @param {ArrayBufferView | ArrayBufferLike} input
 * @returns {Uint8Array}
 */
const asUint8View = input => {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(/** @type {ArrayBufferLike} */ (input));
};

/**
 * Pure-JavaScript hex encoder, exported for benchmarking and for
 * environments where the native TC39 `Uint8Array.prototype.toHex`
 * intrinsic (proposal-arraybuffer-base64) is unavailable or has been
 * removed.  See `encodeHex` below for the dispatched default.
 *
 * Emits lowercase hex.  Callers that need uppercase can call
 * `.toUpperCase()` on the result.
 *
 * Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`
 * (the byteArray passable form) without an intermediate copy.  The
 * polyfill uses `for...of` iteration rather than integer-indexed access
 * because the `@endo/immutable-arraybuffer` shim wraps frozen TypedArrays
 * as plain objects whose `[Symbol.iterator]` delegates to the underlying
 * genuine TypedArray (via `amplifyTypedArray`) while integer-indexed
 * access (`bytes[i]`) returns `undefined` — the wrapper carries no
 * integer-indexed own properties and is not an exotic integer-indexed
 * object.
 *
 * @param {ArrayBufferView | ArrayBufferLike} input
 * @returns {string}
 */
export const jsEncodeHex = input => {
  // Normalize to something iterable.  For the shim's frozen Uint8Array proxy,
  // `asUint8View` returns the proxy itself (instanceof Uint8Array is true due
  // to the shared prototype); `for...of` then delegates to the shim's
  // `[Symbol.iterator]` → `amplifyTypedArray` path which reads from the
  // hidden genuine TypedArray.  For bare ArrayBufferLike inputs, we wrap in
  // a fresh mutable Uint8Array whose iterator works normally.
  const bytes = asUint8View(input);
  // Pre-allocate the output array using `bytes.length`, which is delegated
  // correctly by the shim wrapper.
  const chars = new Array(bytes.length * 2);
  let j = 0;
  for (const b of bytes) {
    chars[j] = hexAlphabet[b >>> 4];
    chars[j + 1] = hexAlphabet[b & 0x0f];
    j += 2;
  }
  return chars.join('');
};
harden(jsEncodeHex);

// Capture the native TC39 `Uint8Array.prototype.toHex` intrinsic at
// module load, before any caller can reach `encodeHex` and before SES
// lockdown freezes the prototype.  Post-lockdown mutation cannot
// redirect the dispatched binding.
const toHex = /** @type {any} */ (Uint8Array.prototype).toHex;
const nativeToHex =
  typeof toHex === 'function' ? /** @type {() => string} */ (toHex) : undefined;

/**
 * Encodes bytes as a lowercase hex string.
 *
 * Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`
 * (the byteArray passable form), any other `ArrayBufferView`, or a
 * bare `ArrayBufferLike` — without an expensive intermediate copy.
 *
 * Dispatches to the native `Uint8Array.prototype.toHex` intrinsic when
 * available (stage-4 TC39 proposal-arraybuffer-base64) and the input's
 * backing buffer is mutable.  For frozen `Uint8Array` values backed by an
 * immutable `ArrayBuffer` (byteArray passable form) and for all other
 * non-plain-`Uint8Array` inputs, the call falls through to the pure-JavaScript
 * polyfill.  The polyfill uses `for...of` iteration, which the
 * `@endo/immutable-arraybuffer` shim delegates correctly via its
 * `[Symbol.iterator]` → `amplifyTypedArray` path, producing the correct
 * bytes without an intermediate copy.
 *
 * @param {ArrayBufferView | ArrayBufferLike} input
 * @returns {string}
 */
export const encodeHex =
  nativeToHex !== undefined
    ? input => {
        // Use the native intrinsic only when the backing buffer is mutable.
        // For immutable ArrayBuffers (shim or native stage-3), the frozen
        // Uint8Array wrapper is a plain object that the native C++ toHex
        // cannot handle: it reads via internal TypedArray exotic slots, not
        // through the wrapper's delegated accessors.  The polyfill's for...of
        // path (via the shim's [Symbol.iterator] → amplifyTypedArray delegate)
        // works correctly without a copy.
        if (
          input instanceof Uint8Array &&
          /** @type {any} */ (input.buffer).immutable !== true
        ) {
          return apply(nativeToHex, input, []);
        }
        return jsEncodeHex(input);
      }
    : jsEncodeHex;
harden(encodeHex);
