import './_sturdyref-shim-first.js';
import '../index.js';
import test from 'ava';

lockdown();

const { isFrozen, getOwnPropertyNames, getOwnPropertyDescriptor } = Object;
// Installed by ./_sturdyref-shim-first.js before lockdown.
const { SturdyRef } = /** @type {any} */ (globalThis);

// Lockdown neither deletes nor unfreezes the shim's non-configurable, frozen
// start-compartment binding even without a SturdyRef permit, so each test
// below also checks what a child compartment sees, which only the permit
// provides.

test('SturdyRef installed before lockdown survives lockdown', t => {
  t.is(typeof SturdyRef, 'function');
  const expectedNames = [
    'enliven',
    'isSturdyRef',
    'length',
    'name',
    'prototype',
  ];
  t.deepEqual(getOwnPropertyNames(SturdyRef).sort(), expectedNames);
  const c = new Compartment();
  t.deepEqual(
    c.evaluate('Object.getOwnPropertyNames(SturdyRef)').sort(),
    expectedNames,
  );
});

test("lockdown leaves the shim's locked start-compartment binding", t => {
  const descriptor = getOwnPropertyDescriptor(globalThis, 'SturdyRef');
  t.is(descriptor?.value, SturdyRef);
  t.false(descriptor?.writable);
  t.false(descriptor?.configurable);

  // A child compartment's binding is the ordinary writable, configurable one.
  const c = new Compartment();
  const childDescriptor = getOwnPropertyDescriptor(c.globalThis, 'SturdyRef');
  t.is(childDescriptor?.value, SturdyRef);
  t.true(childDescriptor?.writable);
  t.true(childDescriptor?.configurable);
});

test('lockdown hardens the SturdyRef constructor and prototype', t => {
  t.true(isFrozen(SturdyRef));
  t.true(isFrozen(SturdyRef.prototype));
  t.true(isFrozen(SturdyRef.enliven));
  t.true(isFrozen(SturdyRef.isSturdyRef));
  const c = new Compartment();
  t.true(
    c.evaluate(`[
      SturdyRef,
      SturdyRef.prototype,
      SturdyRef.enliven,
      SturdyRef.isSturdyRef,
    ].every(Object.isFrozen)`),
  );
});

test('child compartments share the identical SturdyRef', t => {
  const c = new Compartment();
  t.is(c.globalThis.SturdyRef, SturdyRef);
  t.is(c.evaluate('SturdyRef'), SturdyRef);
  t.is(c.evaluate('SturdyRef.prototype'), SturdyRef.prototype);

  const grandchild = c.evaluate('new Compartment()');
  t.is(grandchild.globalThis.SturdyRef, SturdyRef);
});

test('refs minted in a child compartment are recognized in the parent', async t => {
  const c = new Compartment({ __options__: true, globals: { harden } });
  const ref = c.evaluate(`new SturdyRef(harden({ enliven: () => 'live' }))`);
  t.true(SturdyRef.isSturdyRef(ref));
  t.is(Object.prototype.toString.call(ref), '[object SturdyRef]');
  const live = await SturdyRef.enliven(ref);
  t.is(live, 'live');
});

test('a compartment cannot replace the shared SturdyRef', t => {
  const c = new Compartment();
  t.throws(() => c.evaluate('SturdyRef.enliven = () => {}'));
  t.throws(() => c.evaluate('SturdyRef.prototype.foo = 1'));
  // The compartment's own global binding is replaceable, as for any shared
  // intrinsic, without affecting the realm's constructor.
  c.evaluate('globalThis.SturdyRef = undefined');
  t.is(new Compartment().globalThis.SturdyRef, SturdyRef);
});
