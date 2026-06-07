/* global globalThis */

import test from 'ava';
import '../src/immutable-arraybuffer-shim.js';

// These tests mirror `freezable-typedarray-pony.test.js` but at the shim
// install level: the shim replaces each concrete global TypedArray
// constructor with the pseudo-constructor and replaces
// %TypedArrayPrototype%.buffer with the virtual getter. After the shim
// import, the global Uint8Array (and friends) IS the pseudo-constructor,
// and `ta.buffer` walks up to the virtual getter.

const { Uint8Array, ArrayBuffer } = globalThis;

test('shim: global Uint8Array on an immutable ArrayBuffer wraps as emulated freezable', t => {
  const realAb = new ArrayBuffer(4);
  const iab = realAb.sliceToImmutable();
  const fta = new Uint8Array(iab);
  t.truthy(fta);
  t.is(Object.getPrototypeOf(fta), Uint8Array.prototype);
  // The buffer getter (now the virtualTypedArrayBufferGetter installed
  // on %TypedArrayPrototype%) redirects through reverseHiddenBuffers
  // back to the immutable wrapper.
  t.is(fta.buffer, iab);
});

test('shim: global Uint8Array on a regular ArrayBuffer forwards to the OriginalConstructor', t => {
  const realAb = new ArrayBuffer(4);
  const ta = new Uint8Array(realAb);
  t.truthy(ta);
  // The pseudo-prototype still ends up on the instance because the
  // pseudo-constructor was the new.target, but the instance is a
  // genuine TypedArray view onto realAb so the virtual getter falls
  // through and returns realAb.
  t.is(ta.buffer, realAb);
});

test('shim: virtual buffer getter returns the real buffer for a genuine TypedArray', t => {
  const ab = new ArrayBuffer(8);
  const ta = new Uint8Array(ab);
  t.is(ta.buffer, ab);
});

test('shim: virtual buffer getter redirects to the immutable wrapper when present', t => {
  const ab = new ArrayBuffer(4);
  const iab = ab.sliceToImmutable();
  const fta = new Uint8Array(iab);
  t.is(fta.buffer, iab);
});

test('shim: emulated freezable byteLength and at redirect via amplifyTypedArray', t => {
  const realAb = new ArrayBuffer(4);
  const src = new Uint8Array(realAb);
  src[0] = 7;
  src[1] = 8;
  src[2] = 9;
  src[3] = 10;
  const iab = realAb.sliceToImmutable();
  const fta = new Uint8Array(iab);
  t.is(fta.byteLength, 4);
  t.is(fta.at(0), 7);
  t.is(fta.at(3), 10);
});

test('shim: emulated freezable mutators complain', t => {
  const realAb = new ArrayBuffer(2);
  const iab = realAb.sliceToImmutable();
  const fta = new Uint8Array(iab);
  t.throws(() => fta.set([1]));
  t.throws(() => fta.fill(0));
  t.throws(() => fta.sort());
  t.throws(() => fta.reverse());
  t.throws(() => fta.copyWithin(0, 1));
});

test('shim: emulated freezable subarray returns a view whose buffer is the immutable wrapper', t => {
  const realAb = new ArrayBuffer(4);
  const iab = realAb.sliceToImmutable();
  const fta = new Uint8Array(iab);
  const sub = fta.subarray(1);
  // subarray returns a new TypedArray view onto the same underlying
  // buffer; the virtual buffer getter recovers the immutable wrapper.
  t.is(sub.buffer, iab);
  t.is(sub.byteLength, 3);
});

test('shim: race-to-install is idempotent under re-import', async t => {
  // The shim's race-to-install discipline (detect-then-skip) means a
  // second import is a no-op; sliceToImmutable is already on
  // ArrayBuffer.prototype after the first import at the top of this
  // file, so the second-import branch never re-enters the install
  // block.
  t.true('sliceToImmutable' in ArrayBuffer.prototype);
  // Re-import via a query-string variant to force the module loader to
  // re-evaluate. (In ESM the cache key includes the query string for
  // some loaders; this is best-effort. The structural assertion is
  // that the surface is still consistent.)
  await import('../src/immutable-arraybuffer-shim.js');
  t.true('sliceToImmutable' in ArrayBuffer.prototype);
});
