// @ts-nocheck
// Lib-level unit tests for the freezable-TypedArray emulation.
// These tests exercise the property-record and pseudo-constructor machinery in
// isolation (with the ArrayBuffer-side shim installed so that
// `sliceBufferToImmutable` and friends are available via the prototype).
import '../src/shim.js';
import test from 'ava';
import {
  sliceBufferToImmutable,
  makePseudoTypedArrayConstructor,
  amplifyTypedArray,
  virtualTypedArrayBufferGetter,
  _amplifyTypedArrayForTests,
} from '../src/lib.js';

const { getPrototypeOf } = Object;

// ---------------------------------------------------------------------------
// makePseudoTypedArrayConstructor - wrapping an immutable ArrayBuffer
// ---------------------------------------------------------------------------

test('makePseudoTypedArrayConstructor wraps an immutable ArrayBuffer', t => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const iab = sliceBufferToImmutable(ab);

  const PseudoUint8Array = makePseudoTypedArrayConstructor(Uint8Array);
  const view = new PseudoUint8Array(iab);

  // The wrapper's prototype is Uint8Array.prototype (no intermediate prototype).
  t.is(getPrototypeOf(view), Uint8Array.prototype);

  // The amplifier returns the hidden genuine TypedArray, not the wrapper itself.
  const hidden = _amplifyTypedArrayForTests(view);
  t.not(hidden, view);

  // The buffer getter via `virtualTypedArrayBufferGetter` returns the
  // immutable wrapper.
  const buf = virtualTypedArrayBufferGetter.call(view);
  t.is(buf, iab);
  t.true(buf.immutable);
});

// ---------------------------------------------------------------------------
// makePseudoTypedArrayConstructor - forwarding a non-immutable first arg
// ---------------------------------------------------------------------------

test('makePseudoTypedArrayConstructor forwards a non-immutable first arg', t => {
  const realAb = new ArrayBuffer(4);
  new Uint8Array(realAb).set([10, 20, 30, 40]);

  const PseudoUint8Array = makePseudoTypedArrayConstructor(Uint8Array);
  const view = new PseudoUint8Array(realAb);

  // Fallthrough path: the result is a genuine TypedArray, not a wrapper.
  t.is(getPrototypeOf(view), Uint8Array.prototype);

  // The amplifier returns the view itself (no entry in hiddenTypedArrays).
  t.is(_amplifyTypedArrayForTests(view), view);

  // Mutators work normally on the genuine view.
  view[0] = 99;
  t.is(view[0], 99);
});

// ---------------------------------------------------------------------------
// virtualTypedArrayBufferGetter - returns genuine buffer for a genuine
// TypedArray (fallthrough path)
// ---------------------------------------------------------------------------

test('virtualTypedArrayBufferGetter returns the real buffer for a genuine TypedArray', t => {
  const realAb = new ArrayBuffer(4);
  const view = new Uint8Array(realAb);

  const buf = virtualTypedArrayBufferGetter.call(view);
  t.is(buf, realAb);
  t.false(buf.immutable);
});

// ---------------------------------------------------------------------------
// virtualTypedArrayBufferGetter - redirects to the immutable wrapper when
// the TypedArray is an emulated freezable
// ---------------------------------------------------------------------------

test('virtualTypedArrayBufferGetter redirects to the immutable wrapper when present', t => {
  const ab = new ArrayBuffer(4);
  const iab = sliceBufferToImmutable(ab);

  const PseudoUint8Array = makePseudoTypedArrayConstructor(Uint8Array);
  const view = new PseudoUint8Array(iab);

  const buf = virtualTypedArrayBufferGetter.call(view);
  t.is(buf, iab);
  t.true(buf.immutable);
});

// ---------------------------------------------------------------------------
// amplifyTypedArray - exported wrapper around _amplifyTypedArrayForTests
// ---------------------------------------------------------------------------

test('amplifyTypedArray returns the hidden genuine TypedArray for a wrapper', t => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([5, 6, 7, 8]);
  const iab = sliceBufferToImmutable(ab);

  const PseudoUint8Array = makePseudoTypedArrayConstructor(Uint8Array);
  const view = new PseudoUint8Array(iab);

  const amplified = amplifyTypedArray(view);
  t.not(amplified, view);
  // The amplified value is a genuine Uint8Array, so its indexed reads return
  // the underlying bytes (unchanged, because the buffer is immutable).
  t.is(amplified[0], 5);
  t.is(amplified[3], 8);
});

test('amplifyTypedArray returns the receiver itself for a genuine TypedArray', t => {
  const view = new Uint8Array(new ArrayBuffer(4));
  t.is(amplifyTypedArray(view), view);
});
