/* global globalThis */
// @ts-nocheck

/**
 * Central spackle install for `@endo/bytes`.
 *
 * Installs six operations on the relevant intrinsics via registered
 * `Symbol.for(...)` keys, captures `TextEncoder` and `TextDecoder` once
 * at module load (so a compartment global endowment that later replaces
 * them on `globalThis` cannot redirect the spackle's behavior), and
 * internalizes the freezable `TypedArray` constructor family. The first
 * `@endo/bytes` to load wins the install race; subsequent loads find
 * the symbols already defined and call through.
 *
 * See `packages/immutable-arraybuffer/README.md` §
 * `Ramifications for @endo/bytes as a Spackle` for the design.
 */

import {
  sliceBufferToImmutable,
  optTransferBufferToImmutable,
} from '@endo/immutable-arraybuffer';
import { makePseudoTypedArrayConstructor } from '@endo/immutable-arraybuffer/freezable-typedarray-pony.js';

// Capture intrinsics once at module init, *before* any compartment
// endowment could replace them on `globalThis`.
// The eslint rule shipped from `@endo/eslint-plugin` whitelists this
// module as the one site authorized to reach for these constructors
// directly.
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

// Symbol rendezvous keys per
// `packages/immutable-arraybuffer/README.md` § Symbol rendezvous shape.
const symSliceBufferToImmutable = Symbol.for('sliceBufferToImmutable');
const symTransferBufferToImmutable = Symbol.for('transferBufferToImmutable');
const symConcatImmutables = Symbol.for('concatImmutables');
const symBytesFromImmutable = Symbol.for('bytesFromImmutable');
const symToUtf8String = Symbol.for('toUtf8String');
const symFromUtf8String = Symbol.for('fromUtf8String');
const symFreezableConstructor = Symbol.for('freezableConstructor');

/**
 * Capture the realm's original `TextEncoder` instance once at module
 * load. The encoder is stateless (always emits UTF-8 by spec) and safe
 * to share across calls.
 */
const capturedEncoder = new CapturedTextEncoder();
const capturedLenientDecoder = new CapturedTextDecoder();
const capturedFatalDecoder = new CapturedTextDecoder('utf-8', { fatal: true });

/**
 * Install `value` at `intrinsic[symbol]` if no value is already
 * installed, then return whichever value ends up at the rendezvous.
 * The first-writer wins; subsequent installs adopt the existing one.
 *
 * If the intrinsic is non-extensible (post-`lockdown()` without the
 * spackle having had a chance to install pre-lockdown), the install
 * step silently fails and the function returns the supplied `value`
 * so callers still get a working implementation. This matches the
 * README's "the package works as a conventional ponyfill without
 * the spackle install" guarantee: the install is best-effort, the
 * exported callable is the contract.
 *
 * @param {object} intrinsic
 * @param {symbol} symbol
 * @param {Function} value
 * @returns {Function}
 */
const installOrAdopt = (intrinsic, symbol, value) => {
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
    // as a conventional ponyfill. A program that wants the
    // realm-wide rendezvous must import `@endo/bytes` before
    // `lockdown()` runs.
  }
  return value;
};

// --- Operation 1: sliceBufferToImmutable on ArrayBuffer.prototype ---

/**
 * `installedSlice.call(buffer, start, end)` returns an immutable
 * `ArrayBuffer` whose contents are the copy of the requested window.
 * The function is method-style: `this` is the source buffer.
 *
 * @this {ArrayBuffer}
 * @param {number} [start]
 * @param {number} [end]
 */
function installedSlice(start, end) {
  return sliceBufferToImmutable(this, start, end);
}

const sliceInstalled = installOrAdopt(
  CapturedArrayBuffer.prototype,
  symSliceBufferToImmutable,
  installedSlice,
);

// --- Operation 2: transferBufferToImmutable on ArrayBuffer.prototype ---
// Optional: depends on platform support for structuredClone or
// ArrayBuffer.prototype.transfer.

/** @type {Function | undefined} */
let transferInstalled;
if (optTransferBufferToImmutable !== undefined) {
  /**
   * @this {ArrayBuffer}
   * @param {number} [newLength]
   */
  // eslint-disable-next-line no-inner-declarations
  function installedTransfer(newLength) {
    return optTransferBufferToImmutable(this, newLength);
  }
  transferInstalled = installOrAdopt(
    CapturedArrayBuffer.prototype,
    symTransferBufferToImmutable,
    installedTransfer,
  );
}

// --- Operation 3: concatImmutables on ArrayBuffer ---
// Installed on the ArrayBuffer constructor rather than the prototype,
// since it does not operate on a single buffer instance.

function installedConcatImmutables(buffers) {
  let totalLength = 0;
  for (const b of buffers) {
    totalLength += b.byteLength;
  }
  const result = new CapturedUint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    result.set(new CapturedUint8Array(b.slice(0)), offset);
    offset += b.byteLength;
  }
  return sliceBufferToImmutable(
    result.buffer,
    result.byteOffset,
    result.byteOffset + result.byteLength,
  );
}

const concatImmutablesInstalled = installOrAdopt(
  CapturedArrayBuffer,
  symConcatImmutables,
  installedConcatImmutables,
);

// --- Operation 4: bytesFromImmutable on Uint8Array ---
// Installed on the Uint8Array constructor; returns a fresh mutable
// Uint8Array copy of an immutable buffer.

function installedBytesFromImmutable(buffer) {
  return new CapturedUint8Array(buffer.slice(0));
}

const bytesFromImmutableInstalled = installOrAdopt(
  CapturedUint8Array,
  symBytesFromImmutable,
  installedBytesFromImmutable,
);

// --- Operation 5: toUtf8String on Uint8Array ---
// Decoder install. Captures the realm's original TextDecoder once at
// module load (both lenient and fatal modes).

function installedToUtf8String(view, options = undefined) {
  if (options !== undefined && options.fatal) {
    return capturedFatalDecoder.decode(view);
  }
  return capturedLenientDecoder.decode(view);
}

const toUtf8StringInstalled = installOrAdopt(
  CapturedUint8Array,
  symToUtf8String,
  installedToUtf8String,
);

// --- Operation 6: fromUtf8String on Uint8Array ---
// Encoder install. Captures the realm's original TextEncoder once.

function installedFromUtf8String(s) {
  return capturedEncoder.encode(s);
}

const fromUtf8StringInstalled = installOrAdopt(
  CapturedUint8Array,
  symFromUtf8String,
  installedFromUtf8String,
);

// --- Operation 7: freezable TypedArray constructor family ---
// One symbol per TypedArray family; the spackle installs
// `makePseudoTypedArrayConstructor(C)` at `C[Symbol.for('freezableConstructor')]`
// for each TypedArray constructor `C`.

const typedArrayFamilies = [
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
];

/** @type {Map<Function, Function>} */
const freezableConstructorsByFamily = new Map();
for (const Ctor of typedArrayFamilies) {
  if (Ctor !== undefined) {
    const installed = installOrAdopt(
      Ctor,
      symFreezableConstructor,
      makePseudoTypedArrayConstructor(Ctor),
    );
    freezableConstructorsByFamily.set(Ctor, installed);
  }
}

// Public surface of the spackle module: function references that the
// other source files in this package call through. After this module
// has loaded, the registered symbols on the intrinsics are populated
// and these references match either our install or an existing one.

export const sliceFunction = sliceInstalled;
export const transferFunction = transferInstalled;
export const concatImmutablesFunction = concatImmutablesInstalled;
export const bytesFromImmutableFunction = bytesFromImmutableInstalled;
export const toUtf8StringFunction = toUtf8StringInstalled;
export const fromUtf8StringFunction = fromUtf8StringInstalled;
export const getFreezableConstructor = Ctor =>
  freezableConstructorsByFamily.get(Ctor);

// Captured constructor references for use by other modules in this
// package. The eslint rule whitelists this module's site as the only
// authorized direct reference to `Uint8Array` and friends, so callers
// inside this package source go through these re-exports rather than
// reaching for the bare intrinsic.
export const Uint8ArrayCaptured = CapturedUint8Array;

// Re-export the symbol keys for callers that need to detect the install.
export const symbols = {
  sliceBufferToImmutable: symSliceBufferToImmutable,
  transferBufferToImmutable: symTransferBufferToImmutable,
  concatImmutables: symConcatImmutables,
  bytesFromImmutable: symBytesFromImmutable,
  toUtf8String: symToUtf8String,
  fromUtf8String: symFromUtf8String,
  freezableConstructor: symFreezableConstructor,
};
