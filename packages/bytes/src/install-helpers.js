/* global globalThis */
// @ts-nocheck

/**
 * Shared helpers for the per-operation install modules in `@endo/bytes`.
 *
 * Captures the realm's original TypedArray, ArrayBuffer, TextEncoder, and
 * TextDecoder constructors once at module init, before any compartment
 * endowment could replace them on `globalThis`. Provides the
 * `installOrAdopt` helper that each per-operation module uses to publish
 * its callable at a registered symbol on the relevant intrinsic.
 *
 * The eslint rule shipped from `@endo/eslint-plugin` whitelists this
 * module as one of the few sites authorized to reach for these
 * constructors directly.
 */

/* eslint-disable new-cap */
const {
  ArrayBuffer: CapturedArrayBuffer,
  Uint8Array: CapturedUint8Array,
  Uint8ClampedArray: CapturedUint8ClampedArray,
  Uint16Array: CapturedUint16Array,
  Uint32Array: CapturedUint32Array,
  Int8Array: CapturedInt8Array,
  Int16Array: CapturedInt16Array,
  Int32Array: CapturedInt32Array,
  Float32Array: CapturedFloat32Array,
  Float64Array: CapturedFloat64Array,
  BigInt64Array: CapturedBigInt64Array,
  BigUint64Array: CapturedBigUint64Array,
  TextEncoder: CapturedTextEncoder,
  TextDecoder: CapturedTextDecoder,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const { defineProperty } = Object;

export {
  CapturedArrayBuffer,
  CapturedUint8Array,
  CapturedUint8ClampedArray,
  CapturedUint16Array,
  CapturedUint32Array,
  CapturedInt8Array,
  CapturedInt16Array,
  CapturedInt32Array,
  CapturedFloat32Array,
  CapturedFloat64Array,
  CapturedBigInt64Array,
  CapturedBigUint64Array,
  CapturedTextEncoder,
  CapturedTextDecoder,
};

/**
 * Install `value` at `intrinsic[symbol]` if no value is already
 * installed, then return whichever value ends up at the rendezvous.
 * The first-writer wins; subsequent installs adopt the existing one.
 *
 * If the intrinsic is non-extensible (post-`lockdown()` without the
 * install having had a chance to run pre-lockdown), the install step
 * silently fails and the function returns the supplied `value` so
 * callers still get a working implementation. The exported callable is
 * the contract; the install on the intrinsic is best-effort.
 *
 * @param {object} intrinsic
 * @param {symbol} symbol
 * @param {Function} value
 * @returns {Function}
 */
export const installOrAdopt = (intrinsic, symbol, value) => {
  const existing = intrinsic[symbol];
  if (existing !== undefined) {
    if (typeof existing !== 'function') {
      throw new TypeError(
        `@endo/bytes: expected callable at ${String(symbol)}`,
      );
    }
    return existing;
  }
  try {
    defineProperty(intrinsic, symbol, {
      value,
      configurable: false,
      writable: false,
      enumerable: false,
    });
  } catch (_err) {
    // The intrinsic is non-extensible (lockdown ran first). Fall back
    // to the local function reference; the package continues to work
    // as a conventional ponyfill. A program that wants the realm-wide
    // rendezvous must import `@endo/bytes` before `lockdown()` runs.
  }
  return value;
};
