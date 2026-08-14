// @ts-nocheck

import test from 'ava';

test.serial('decodes an emulated frozen Uint8Array', async t => {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const nativeTypedArraySlice = typedArrayPrototype.slice;
  const emulatedBytesToGenuineBytes = new WeakMap();
  const emulatedBytes = Object.freeze(Object.create(Uint8Array.prototype));
  emulatedBytesToGenuineBytes.set(
    emulatedBytes,
    Uint8Array.of(0x41, 0x42, 0x43),
  );

  // Model the freezable-TypedArray shim's amplification of an emulated wrapper
  // through %TypedArrayPrototype%.slice. Import the decoder while the shim is
  // installed so it captures the same intrinsic the real shim provides.
  typedArrayPrototype.slice = function slice(...args) {
    const genuineBytes = emulatedBytesToGenuineBytes.get(this);
    return Reflect.apply(nativeTypedArraySlice, genuineBytes || this, args);
  };
  const { decodeAscii } = await import('../src/decode.js?emulated-test');
  typedArrayPrototype.slice = nativeTypedArraySlice;

  t.false(ArrayBuffer.isView(emulatedBytes));
  t.is(emulatedBytes[0], undefined);
  t.is(decodeAscii(emulatedBytes), 'ABC');
});
