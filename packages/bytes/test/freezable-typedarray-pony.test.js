import test from 'ava';
import { sliceBufferToImmutable } from '@endo/immutable-arraybuffer';
import {
  virtualTypedArrayBufferGetter,
  makePseudoTypedArrayConstructor,
} from '../src/freezable-typedarray-pony.js';

const { apply } = Reflect;

// The pony module's types are intentionally loose (the pseudo-TypedArray
// branch involves a brand-check WeakMap whose value type does not match
// `Uint8Array`), so the test casts at the boundary.
const getBuffer = /** @type {(this: any) => ArrayBuffer} */ (
  /** @type {unknown} */ (virtualTypedArrayBufferGetter)
);

test('makePseudoTypedArrayConstructor wraps an immutable ArrayBuffer', t => {
  // This test exercises the brand-check WeakMap registration on the
  // emulated freezable path. Before the line-193 fix, the
  // `weakMapSet(...)` call was both unapplied (so `this` was undefined,
  // raising "Method WeakMap.prototype.set called on incompatible receiver
  // undefined") and the value was wrapped in an array. Construction with
  // an immutable ArrayBuffer first-arg therefore could never succeed.
  const PseudoUint8Array = /** @type {new (...args: any[]) => any} */ (
    /** @type {unknown} */ (makePseudoTypedArrayConstructor(Uint8Array))
  );
  const realAb = new ArrayBuffer(4);
  const iab = sliceBufferToImmutable(realAb);
  const fta = new PseudoUint8Array(iab);
  t.truthy(fta);
  // The emulated instance has the pseudo prototype.
  t.is(Object.getPrototypeOf(fta), PseudoUint8Array.prototype);
  // The brand-check WeakMap registration succeeded: the getter can
  // recover the hidden genuine TypedArray's underlying buffer via the
  // reverseHiddenBuffers redirect.
  const recoveredBuffer = apply(getBuffer, fta, []);
  t.is(recoveredBuffer, iab);
});

test('makePseudoTypedArrayConstructor forwards a non-immutable first arg', t => {
  // The fall-through branch (firstArg not registered in hiddenBuffers)
  // delegates to the OriginalConstructor via Reflect.construct with
  // new.target = PseudoUint8Array, so the result wears the pseudo
  // prototype but is constructed as a genuine TypedArray view onto the
  // supplied ArrayBuffer.
  const PseudoUint8Array = /** @type {new (...args: any[]) => any} */ (
    /** @type {unknown} */ (makePseudoTypedArrayConstructor(Uint8Array))
  );
  const realAb = new ArrayBuffer(4);
  const ta = new PseudoUint8Array(realAb);
  t.truthy(ta);
  // It is not an emulated freezable TypedArray (no hiddenTypedArrays
  // entry); the virtualTypedArrayBufferGetter therefore returns the
  // backing ArrayBuffer directly.
  const buf = apply(getBuffer, ta, []);
  t.is(buf, realAb);
});

test('virtualTypedArrayBufferGetter returns the real buffer for a genuine TypedArray', t => {
  // The getter must work on genuine TypedArrays as a fall-through (the
  // `|| this` branch at the apply(weakMapGet, ...) site).
  const ab = new ArrayBuffer(8);
  const ta = new Uint8Array(ab);
  const recovered = apply(getBuffer, ta, []);
  t.is(recovered, ab);
});

test('virtualTypedArrayBufferGetter redirects to the immutable wrapper when present', t => {
  // When the underlying buffer has a reverseHiddenBuffers entry (it was
  // created via sliceBufferToImmutable), the getter returns the immutable
  // wrapper rather than leaking the genuine buffer.
  const ab = new ArrayBuffer(4);
  const iab = sliceBufferToImmutable(ab);
  const PseudoUint8Array = /** @type {new (...args: any[]) => any} */ (
    /** @type {unknown} */ (makePseudoTypedArrayConstructor(Uint8Array))
  );
  const fta = new PseudoUint8Array(iab);
  const recovered = apply(getBuffer, fta, []);
  t.is(recovered, iab);
});
