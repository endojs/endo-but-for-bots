// @ts-nocheck
// Adopting a pre-existing global that is non-configurable but still writable
// and enumerable locks it (non-writable) without trying to change its
// enumerability, which a non-configurable property would reject. Isolated in
// its own file (its own process) so the pre-seeded global does not leak.

import '@endo/init';
import test from 'ava';
import { makeParcelConstructor, selectParcel } from '../src/parcel-shim.js';

test('first-wins: a non-configurable enumerable writable global is locked', t => {
  const TwinParcel = makeParcelConstructor();
  Object.defineProperty(globalThis, 'Parcel', {
    value: TwinParcel,
    enumerable: true,
    writable: true,
    configurable: false,
  });
  t.is(selectParcel(), TwinParcel);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Parcel');
  t.false(descriptor.writable);
  t.false(descriptor.configurable);
  t.true(descriptor.enumerable);
});
