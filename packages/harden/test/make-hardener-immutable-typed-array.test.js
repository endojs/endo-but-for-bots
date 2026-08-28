// @ts-nocheck

import test from 'ava';

// Install an `ArrayBuffer.prototype.immutable` getter BEFORE make-hardener.js
// evaluates, so its early capture observes the accessor the way it would a
// genuine engine-provided (or already-shimmed) immutable-ArrayBuffer surface.
// This file stays separate from make-hardener.test.js so the accessor cannot
// leak into the sibling test workers.
const immutableBuffers = new WeakSet();
// eslint-disable-next-line no-extend-native
Object.defineProperty(ArrayBuffer.prototype, 'immutable', {
  get() {
    return immutableBuffers.has(this);
  },
  enumerable: false,
  configurable: true,
});

const { makeHardener } = await import('../make-hardener.js');

test('mutable TypedArray still takes the freezeTypedArray carve-out', t => {
  const h = makeHardener();
  const a = new Uint8Array(1);
  t.is(h(a), a);
  t.false(Object.isExtensible(a));
  a[0] = 7;
  t.is(a[0], 7, 'indexed elements of a mutable TypedArray stay writable');
});

test('immutable-backed TypedArray takes the ordinary freeze path', t => {
  const h = makeHardener();
  const a = new Uint8Array(1);
  immutableBuffers.add(a.buffer);
  // In this emulation the buffer only CLAIMS immutability, so the elements are
  // really still writable and the ordinary `Object.freeze` must throw — proof
  // that `harden` routed the immutable-backed view away from
  // `freezeTypedArray`. On an engine with genuine immutable ArrayBuffers the
  // elements are non-writable and this same path freezes without throwing.
  t.throws(() => h(a), { instanceOf: TypeError });
});
