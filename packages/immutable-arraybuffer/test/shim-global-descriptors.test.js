// @ts-nocheck
// The shim replaces the eleven concrete TypedArray constructors and `DataView`
// on the global object. These tests pin the DESCRIPTOR it leaves behind,
// because getting it wrong is silent here and fatal elsewhere.
//
// SES's `lockdown()` repairs the global object by redefining the intrinsics it
// permits. A non-configurable global aborts it:
//
//     TypeError: Cannot redefine property: BigInt64Array
//
// which is how `test262-harness --host-type node` failed every
// `lockdown()`-calling case in `@endo/test262-runner`'s `ses-xs-parity`
// corpus.
import '../src/shim.js';
import test from 'ava';
import vm from 'node:vm';

import {
  concreteTypedArrayConstructors,
  installEmulatedGlobalConstructors,
} from '../src/lib.js';

const { getOwnPropertyDescriptor, defineProperty } = Object;

test('shim: the emulated global constructors stay configurable and writable', t => {
  const names = [
    ...concreteTypedArrayConstructors.map(({ name }) => name),
    'DataView',
  ];
  t.is(
    names.length,
    12,
    'eleven TypedArray flavors plus DataView; if the upstream list changed, ' +
      'update this count deliberately',
  );
  for (const name of names) {
    const desc = getOwnPropertyDescriptor(globalThis, name);
    t.truthy(desc, `${name} should be an own property of globalThis`);
    t.true(desc.configurable, `${name} must stay configurable for lockdown()`);
    t.true(desc.writable, `${name} must stay writable`);
    t.false(desc.enumerable, `${name} must not be enumerable`);
  }
});

// Why the shim spells the descriptor out instead of letting it merge.
//
// `defineProperty(obj, k, { value })` on an ORDINARY object leaves the other
// attributes as they were -- which is what the shim used to rely on. The
// global object is not always ordinary: in a Node.js `vm` context it is a
// GLOBAL PROXY -- V8's, not an ECMAScript `Proxy`; `util.types.isProxy`
// returns false for it -- and its `defineProperty` interceptor completes a
// partial descriptor with the spec's `false` defaults rather than merging. So the omission that is
// harmless in this realm turns the globals non-configurable in a `vm` one, and
// `test262-harness --host-type node` runs every case in a `vm`.
//
// This runs the REAL install against a `vm` global, which is why it is a
// regression test rather than a restatement: an install that stops spelling
// the attributes out fails here. Asserting the descriptors in this realm
// cannot catch that, because here the partial form merges correctly.
//
// Its limit: this pins the HELPER, not `shim.js`'s use of it. Inlining the
// install back into `shim.js` with a partial descriptor -- the configuration
// that caused this -- passes everything in this file. That case is covered by
// `shim-vm-realm.test.js`, which evaluates the real `shim.js` in a `vm`
// realm; the two are complements, not duplicates.
test('the install leaves a vm global proxy configurable', t => {
  const context = vm.createContext({});
  const vmGlobal = vm.runInContext('globalThis', context);

  t.true(
    getOwnPropertyDescriptor(vmGlobal, 'BigInt64Array').configurable,
    'a fresh vm global starts out configurable',
  );

  installEmulatedGlobalConstructors(vmGlobal);

  for (const name of [
    ...concreteTypedArrayConstructors.map(({ name: n }) => n),
    'DataView',
  ]) {
    const desc = getOwnPropertyDescriptor(vmGlobal, name);
    t.true(desc.configurable, `${name} must stay configurable for lockdown()`);
    t.true(desc.writable, `${name} must stay writable`);
    t.false(desc.enumerable, `${name} must not be enumerable`);
  }
});

// The platform divergence itself, so the reason above cannot be mistaken for
// superstition about `vm`.
test('a vm global proxy resets omitted descriptor attributes', t => {
  const context = vm.createContext({});
  const vmGlobal = vm.runInContext('globalThis', context);
  const original = getOwnPropertyDescriptor(vmGlobal, 'BigInt64Array').value;

  defineProperty(vmGlobal, 'BigInt64Array', { value: function Partial() {} });
  t.false(
    getOwnPropertyDescriptor(vmGlobal, 'BigInt64Array').configurable,
    'the vm global proxy does NOT merge: it fills in configurable: false',
  );

  const ordinary = { BigInt64Array: original };
  defineProperty(ordinary, 'BigInt64Array', { value: function Partial() {} });
  t.true(
    getOwnPropertyDescriptor(ordinary, 'BigInt64Array').configurable,
    'an ordinary object preserves the attributes it already had, which is why ' +
      'this went unnoticed',
  );
});
