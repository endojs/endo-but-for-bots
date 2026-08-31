/* eslint no-bitwise: ["off"] */

import { toIndexableUint8Array } from '@endo/bytes/indexed.js';
import harden from '@endo/harden';

// Capture `Reflect.apply` once at module load; we prefer it to
// `Function.prototype.call` even where `.call` is assumed to be
// primordial, so a tampered `Function.prototype.call` cannot redirect
// the dispatched native intrinsic invocation.
const { apply } = Reflect;

const hexAlphabet = '0123456789abcdef';

/**
 * Pure-JavaScript hex encoder, exported for benchmarking and for
 * environments where the native TC39 `Uint8Array.prototype.toHex`
 * intrinsic (proposal-arraybuffer-base64) is unavailable or has been
 * removed. See `encodeHex` below for the dispatched default.
 *
 * Emits lowercase hex. Callers that need uppercase can call
 * `.toUpperCase()` on the result.
 *
 * Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`. A genuine
 * view is indexed directly. An emulated `@endo/immutable-arraybuffer` wrapper
 * is copied once because it has no integer-indexed internal slots.
 *
 * @param {Uint8Array} input
 * @returns {string}
 */
export const jsEncodeHex = input => {
  const bytes = toIndexableUint8Array(input);
  const chars = new Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    const j = i * 2;
    chars[j] = hexAlphabet[b >>> 4];
    chars[j + 1] = hexAlphabet[b & 0x0f];
  }
  return chars.join('');
};
harden(jsEncodeHex);

// Capture the native TC39 `Uint8Array.prototype.toHex` intrinsic at
// module load, before any caller can reach `encodeHex` and before SES
// lockdown freezes the prototype. Post-lockdown mutation cannot
// redirect the dispatched binding.
const toHex = /** @type {any} */ (Uint8Array.prototype).toHex;
const nativeToHex =
  typeof toHex === 'function' ? /** @type {() => string} */ (toHex) : undefined;

/**
 * Encodes bytes as a lowercase hex string.
 *
 * Accepts a `Uint8Array` (the byteArray passable form): a plain mutable one,
 * a genuine frozen view over an immutable `ArrayBuffer`, or an emulated
 * `@endo/immutable-arraybuffer` wrapper — without an expensive intermediate
 * copy.
 *
 * Dispatches to the native `Uint8Array.prototype.toHex` intrinsic when
 * available (stage-4 TC39 proposal-arraybuffer-base64) and the input's
 * backing buffer is mutable. For frozen `Uint8Array` values backed by an
 * immutable `ArrayBuffer` (byteArray passable form) and for all other
 * non-plain-`Uint8Array` inputs, the call falls through to the pure-JavaScript
 * polyfill. The polyfill preserves the indexed loop's fast path for genuine
 * views and copies only an emulated immutable wrapper.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const encodeHex =
  nativeToHex !== undefined
    ? bytes => {
        // Use the native intrinsic only when the backing buffer is mutable.
        // For immutable ArrayBuffers (shim or native stage-3), the frozen
        // Uint8Array wrapper is a plain object that the native C++ toHex
        // cannot handle: it reads via internal TypedArray exotic slots, not
        // through the wrapper's delegated accessors. The polyfill normalizes
        // that wrapper before entering its indexed loop.
        if (
          bytes instanceof Uint8Array &&
          /** @type {any} */ (bytes.buffer).immutable !== true
        ) {
          return apply(nativeToHex, bytes, []);
        }
        return jsEncodeHex(bytes);
      }
    : jsEncodeHex;
harden(encodeHex);
