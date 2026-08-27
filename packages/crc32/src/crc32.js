// @ts-check
/* eslint-disable no-bitwise -- CRC-32 polynomial arithmetic */

import harden from '@endo/harden';

// Adapted from the MIT-licensed CRC-32 implementation that previously lived
// in `@endo/zip`, itself derived from pako's `lib/zlib/crc32.js`
// (https://github.com/nodeca/pako).

const { apply } = Reflect;

// The intrinsic `%TypedArray%.prototype` `[Symbol.toStringTag]` and `length`
// getters, captured so a genuine byte view can be branded and measured without
// trusting any property the caller can override. The toStringTag getter reads
// the `[[TypedArrayName]]` internal slot and returns `undefined` for any
// receiver that is not a genuine typed array (a `DataView`, a bare proxy, a
// plain lookalike); the length getter reads the true intrinsic length, so a
// `length`-overriding subclass cannot spoof it.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayToStringTagGetter =
  /** @type {(this: unknown) => string | undefined} */ (
    /** @type {PropertyDescriptor} */ (
      Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)
    ).get
  );
const typedArrayLengthGetter = /** @type {(this: unknown) => number} */ (
  /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')
  ).get
);
// The intrinsic `%TypedArray%.prototype.at` method, captured the same way so a
// genuine byte view can be probed for a detached *or out-of-bounds* backing
// buffer without trusting an overriding `.at`. `%TypedArray%.prototype.at`
// begins with the ValidateTypedArray abstract operation, which throws a
// `TypeError` when the view is detached OR out of bounds over a resized
// (shrunk) resizable `ArrayBuffer`; the intrinsic `length` getter reports 0 in
// BOTH those cases rather than throwing, so without this probe such a view
// would silently checksum as empty. Probing with `.at(0)` — rather than a
// direct `buffer.detached` read, a plain `[[Get]]` an own data property can
// shadow (`Object.defineProperty(buffer, 'detached', { value: false })` then
// `transfer()` fails the guard open) and one absent (silently permissive) on
// engines predating ES2024 (XS, the Node `^20.17.0` floor) — is unspoofable,
// portable, and allocates nothing. Unlike the older zero-length-view
// construction probe it also rejects the out-of-bounds case, and it returns
// `undefined` without throwing for a genuinely empty in-bounds view (which is
// accepted).
const typedArrayAt = /** @type {(this: unknown, index: number) => unknown} */ (
  typedArrayPrototype.at
);

/**
 * The `[[TypedArrayName]]` tags whose elements are single bytes. A view of one
 * of these kinds (`Uint8Array`, `Uint8ClampedArray`, `Int8Array`) is
 * byte-oriented and safe to read by index on the engine's fast path; every
 * other typed-array kind is a multi-byte view whose elements are not bytes.
 *
 * @param {string} tag
 * @returns {boolean}
 */
const isSingleByteViewTag = tag =>
  tag === 'Uint8Array' || tag === 'Uint8ClampedArray' || tag === 'Int8Array';

/**
 * The byte length of `bytes` when it is a genuine single-byte-per-element
 * ArrayBuffer view (`Uint8Array`, `Uint8ClampedArray`, `Int8Array`), or
 * `undefined` when `bytes` is not a genuine typed array at all (a `DataView`, a
 * bare proxy, a plain lookalike) and must be routed to the validating `.at`
 * branch. A genuine but multi-byte view (`Uint16Array`, `Float64Array`, ...) is
 * neither: its elements are not bytes, and reading it through `.at` would
 * silently checksum its element *values* rather than its underlying bytes, so
 * this throws for it rather than returning `undefined`.
 *
 * The kind is read through the intrinsic `%TypedArray%.prototype`
 * `[Symbol.toStringTag]` getter, which reads the `[[TypedArrayName]]` internal
 * slot directly and returns `undefined` for any receiver without that slot —
 * the exact typed-array brand, at any length, unspoofable by an overriding
 * property. `ArrayBuffer.isView` is NOT this brand: it is `true` for every
 * `DataView` and every typed-array element kind, so the indexed fast path it
 * used to gate silently checksummed non-byte views as if their elements were
 * bytes.
 *
 * A genuine single-byte view whose backing `ArrayBuffer` has been detached (or
 * transferred), or whose window now exceeds a shrunk resizable `ArrayBuffer`
 * (out of bounds), is rejected with a `TypeError` rather than measured: the
 * intrinsic `length` getter reports 0 for both cases instead of throwing, so
 * either would otherwise silently checksum as empty — indistinguishable from a
 * real zero-length view, exactly the plausible-but-wrong checksum this module
 * exists to prevent. Both are probed by invoking the intrinsic
 * `%TypedArray%.prototype.at`, whose ValidateTypedArray step throws a
 * `TypeError` for a detached AND an out-of-bounds view (and returns `undefined`
 * without throwing for a genuinely empty in-bounds view, which is accepted).
 * This subsumes the older construct-a-zero-length-view probe, which caught
 * detachment only; it cannot be shadowed by a caller-planted `detached`
 * property (unlike a direct read of the ES2024 `ArrayBuffer.prototype.detached`
 * accessor) and works on engines predating that accessor. A `SharedArrayBuffer`
 * cannot detach or shrink out of bounds, so `.at` succeeds over it and
 * shared-buffer views are still accepted (their reads are unsynchronized, so a
 * checksum over a shared buffer is not an integrity guarantee — see the `crc32`
 * doc).
 *
 * @param {object} bytes
 * @returns {number | undefined}
 */
const genuineByteViewLength = bytes => {
  let tag;
  try {
    tag = apply(typedArrayToStringTagGetter, bytes, []);
  } catch {
    return undefined;
  }
  if (tag === undefined) {
    // Not a genuine typed array: route to the validating `.at` branch.
    return undefined;
  }
  if (!isSingleByteViewTag(tag)) {
    // A genuine but multi-byte view. Its elements are not bytes, so it must
    // neither be read on the byte fast path nor fall through to `.at` (which
    // reads elements, not bytes); reject it outright.
    throw TypeError(
      `@endo/crc32: bytes must be a single-byte view (Uint8Array, Uint8ClampedArray, Int8Array) or an emulated byte view; a ${tag} is a multi-byte view whose elements are not bytes`,
    );
  }
  // Genuine single-byte view: reject a detached (or transferred) backing
  // buffer, AND a view whose window now exceeds a shrunk resizable
  // `ArrayBuffer` (out of bounds), before measuring. The intrinsic `length`
  // getter returns 0 for both rather than throwing, so an unchecked such view
  // would silently checksum as empty — the producer-side fail-open this module
  // exists to prevent. Probe with the intrinsic `%TypedArray%.prototype.at`,
  // whose ValidateTypedArray step throws a `TypeError` for a detached AND an
  // out-of-bounds view alike (and returns `undefined` without throwing for a
  // genuinely empty in-bounds view, which passes). This subsumes the older
  // construct-a-zero-length-view probe — which caught detachment only — cannot
  // be defeated by a caller-planted own `detached` property (unlike reading
  // `.detached` directly, a plain `[[Get]]` an own property shadows and one
  // silently permissive where the accessor is absent), and works on engines
  // predating that accessor. A `SharedArrayBuffer` cannot detach or shrink out
  // of bounds, so `.at` succeeds for shared buffers and they pass through.
  try {
    apply(typedArrayAt, bytes, [0]);
  } catch {
    throw TypeError(
      '@endo/crc32: bytes is a view over a detached or out-of-bounds ArrayBuffer, which reads as empty rather than throwing',
    );
  }
  // Read the true intrinsic length (which equals byteLength for a single-byte
  // view).
  return apply(typedArrayLengthGetter, bytes, []);
};

const table = new Uint32Array(256);
for (let index = 0; index < table.length; index += 1) {
  let coefficient = index;
  for (let bit = 0; bit < 8; bit += 1) {
    coefficient =
      coefficient & 1 ? 0xedb8_8320 ^ (coefficient >>> 1) : coefficient >>> 1;
  }
  table[index] = coefficient >>> 0;
}

/**
 * Compute an IEEE CRC-32 checksum over a range of bytes.
 *
 * Passing a checksum returned by an earlier call as `previous` continues the
 * checksum, permitting incremental processing without exposing mutable state.
 *
 * `bytes` is any mutable or immutable, genuine or emulated single-byte
 * ArrayBuffer view. A genuine single-byte view — one whose intrinsic
 * `%TypedArray%.prototype` `[Symbol.toStringTag]` is `Uint8Array`,
 * `Uint8ClampedArray`, or `Int8Array` — is read by index on the engine's
 * typed-array fast path. A genuine but multi-byte view (a `Uint16Array`,
 * `Float64Array`, ... — any other typed-array kind) has the same brand but its
 * elements are not bytes, so it throws rather than being checksummed over its
 * element values. Everything else is read through the `.at`/`.length` protocol
 * and every byte is validated to be an integer in `[0, 255]`, so an emulated
 * immutable byte-array view is accepted through its own conforming
 * `.at`/`.length`, while a non-conforming input throws rather than silently
 * checksumming: a bare proxy or plain lookalike (whose intrinsic toStringTag
 * getter reports `undefined`, so its `.length` must be a non-negative safe
 * integer no greater than `2**32 - 1` — the largest a real single-byte view
 * could back, which also bounds the `.at` loop rather than letting a tiny
 * object declare a near-`Number.MAX_SAFE_INTEGER` length and spin the loop
 * effectively forever — and its `.at` is validated per byte, with a throwing
 * `.at` getter surfaced as a branded `TypeError`), a `DataView` (no `.length`,
 * no `.at`), and an `.at` that yields `undefined` or a non-byte. A
 * `length`-overriding `Uint8Array` subclass cannot spoof the range because the
 * fast path reads its true intrinsic length. A genuine view over a detached (or
 * transferred) `ArrayBuffer`, or one out of bounds over a shrunk resizable
 * `ArrayBuffer`, throws rather than checksumming as empty (its intrinsic length
 * reads as 0 without throwing in both cases). A `SharedArrayBuffer`-backed
 * view is accepted, but its bytes are read unsynchronized, so a checksum over a
 * shared buffer is not an integrity guarantee. No separate brand-check ceremony
 * is required of the caller.
 *
 * @param {Uint8Array | Uint8ClampedArray | Int8Array | { readonly length: number, at(index: number): number | undefined }} bytes
 * @param {number} [length] number of bytes to consume
 * @param {number} [index] starting byte index
 * @param {number} [previous] checksum of all preceding bytes
 * @returns {number} unsigned 32-bit checksum
 * @throws {TypeError} if `bytes` is not an object, is a genuine multi-byte view
 *   (`Uint16Array`, `Float64Array`, ...) whose elements are not bytes, is a view
 *   over a detached or out-of-bounds `ArrayBuffer`, or is an emulated view whose
 *   `.at` is missing, throws, or yields a value that is not an integer in
 *   `[0, 255]`.
 * @throws {RangeError} if the emulated `.length`, the range arguments, or
 *   `previous` are out of their permitted bounds.
 */
export const crc32 = (bytes, length = undefined, index = 0, previous = 0) => {
  if (typeof bytes !== 'object' || bytes === null) {
    throw TypeError(
      `@endo/crc32: bytes must be an ArrayBuffer view, got ${typeof bytes}`,
    );
  }

  const genuineLength = genuineByteViewLength(bytes);
  const genuine = genuineLength !== undefined;

  /** @type {number} */
  let byteLength;
  if (genuine) {
    byteLength = /** @type {number} */ (genuineLength);
  } else {
    /** @type {unknown} */
    let rawLength;
    try {
      rawLength = /** @type {{ length?: unknown }} */ (bytes).length;
    } catch (cause) {
      throw TypeError(
        '@endo/crc32: bytes must be a genuine or emulated ArrayBuffer view, not a proxy or lookalike',
        { cause },
      );
    }
    // Validate the emulated view's declared length as a non-negative safe
    // integer, in the same shape as the `index`/`rangeLength` guards below.
    // Without this an untrusted `.length` of `NaN`/`undefined`/non-numeric
    // makes both bounds comparisons (`index > byteLength`,
    // `rangeLength > byteLength - index`) vacuously false, so the range guard
    // becomes a no-op and an explicit `length` argument reads past the view's
    // real end.
    if (
      !Number.isSafeInteger(rawLength) ||
      /** @type {number} */ (rawLength) < 0
    ) {
      throw RangeError(
        `@endo/crc32: emulated view length must be a non-negative safe integer, got ${typeof rawLength === 'number' ? rawLength : typeof rawLength}`,
      );
    }
    // Bound the declared length to what a real single-byte ArrayBuffer view
    // could back (`2**32 - 1`). A safe integer alone still admits values up to
    // `Number.MAX_SAFE_INTEGER`, so a ~50-byte object declaring that length
    // would spin the `.at` loop for order-of-a-year of synchronous CPU — an
    // effectively unbounded loop. Capping at `0xffff_ffff` keeps the loop
    // bounded by a plausible real-buffer size.
    if (/** @type {number} */ (rawLength) > 0xffff_ffff) {
      throw RangeError(
        `@endo/crc32: emulated view length must not exceed 2**32 - 1 (a real byte view cannot be larger), got ${rawLength}`,
      );
    }
    byteLength = /** @type {number} */ (rawLength);
  }

  const rangeLength = length === undefined ? byteLength : length;
  if (!Number.isSafeInteger(index) || index < 0) {
    throw RangeError(
      `@endo/crc32: index must be a non-negative safe integer, got ${index}`,
    );
  }
  if (!Number.isSafeInteger(rangeLength) || rangeLength < 0) {
    throw RangeError(
      `@endo/crc32: length must be a non-negative safe integer, got ${rangeLength}`,
    );
  }
  if (index > byteLength || rangeLength > byteLength - index) {
    throw RangeError(
      `@endo/crc32: range [${index}, ${index + rangeLength}) exceeds ${byteLength} bytes`,
    );
  }
  if (
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous > 0xffff_ffff
  ) {
    throw RangeError(
      `@endo/crc32: previous must be an unsigned 32-bit integer, got ${previous}`,
    );
  }

  let checksum = previous ^ 0xffff_ffff;
  const end = index + rangeLength;
  if (genuine) {
    // Genuine single-byte view: indexed reads take V8/XS's typed-array
    // elements-kind fast path, which `.at` does not, so we never pay the
    // per-byte protocol cost on the hot loop shared with `@endo/zip`. The
    // `[Symbol.toStringTag]` intrinsic-getter brand above is what makes this
    // branch safe: a wide view throws outright, and a `DataView`, a bare proxy,
    // and a plain lookalike all fall to the validating `.at` branch, so a
    // non-byte element is never folded through `& 0xff` here. A
    // `length`-overriding subclass reaches here but its true intrinsic length
    // was read for the bounds. (`Int8Array` values are the same bytes reinterpreted as
    // signed; `checksum ^ byte & 0xff` recovers the unsigned byte, so the
    // fast path agrees with the `.at` path.)
    const view = /** @type {Uint8Array} */ (bytes);
    for (let offset = index; offset < end; offset += 1) {
      checksum = table[(checksum ^ view[offset]) & 0xff] ^ (checksum >>> 8);
    }
  } else {
    // Emulated view: read through the `.at` protocol and validate every byte,
    // so an `.at` that yields `undefined` or a non-uint8 value throws rather
    // than folding to a plausible-but-wrong checksum. `.at` is captured once
    // (not re-resolved per byte on the untrusted receiver) and invoked through
    // the intrinsic `apply`.
    const emulated = /** @type {{ at(index: number): unknown }} */ (bytes);
    /** @type {unknown} */
    let at;
    try {
      at = emulated.at;
    } catch (cause) {
      // Mirror the untrusted `.length` read: a throwing `.at` getter must
      // surface as a branded `@endo/crc32:` TypeError, not a raw escape.
      throw TypeError(
        '@endo/crc32: bytes must be a genuine or emulated ArrayBuffer view, not a proxy or lookalike',
        { cause },
      );
    }
    if (typeof at !== 'function') {
      throw TypeError(
        '@endo/crc32: bytes must be a genuine byte view or expose an `.at` method',
      );
    }
    for (let offset = index; offset < end; offset += 1) {
      const byte = apply(at, emulated, [offset]);
      if (
        typeof byte !== 'number' ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 0xff
      ) {
        throw TypeError(
          `@endo/crc32: byte at index ${offset} is not an integer in [0, 255], got ${typeof byte === 'number' ? byte : typeof byte}`,
        );
      }
      checksum = table[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
    }
  }
  return (checksum ^ 0xffff_ffff) >>> 0;
};
harden(crc32);
