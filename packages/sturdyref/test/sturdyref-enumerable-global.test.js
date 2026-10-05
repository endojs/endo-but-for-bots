// @ts-nocheck
// Adopting a pre-existing global that is non-configurable but still writable
// and enumerable locks it (non-writable) without trying to change its
// enumerability, which a non-configurable property would reject. Isolated in
// its own file (its own process) so the pre-seeded global does not leak.

import '@endo/init';
import test from 'ava';
import {
  makeSturdyRefConstructor,
  selectSturdyRef,
} from '../src/sturdyref-shim.js';

test('first-wins: a non-configurable enumerable writable global is locked', t => {
  const TwinSturdyRef = makeSturdyRefConstructor();
  Object.defineProperty(globalThis, 'SturdyRef', {
    value: TwinSturdyRef,
    enumerable: true,
    writable: true,
    configurable: false,
  });
  t.is(selectSturdyRef(), TwinSturdyRef);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SturdyRef');
  t.false(descriptor.writable);
  t.false(descriptor.configurable);
  t.true(descriptor.enumerable);
});
