import './_sturdyref-shim-configurable.js';
import '../index.js';
import test from 'ava';

const { getOwnPropertyDescriptor } = Object;
// Installed by ./_sturdyref-shim-configurable.js before lockdown.
const { SturdyRef } = /** @type {any} */ (globalThis);

lockdown();

test('lockdown redefines a configurable SturdyRef as an ordinary universal', t => {
  // Not the first-wins shape, so lockdown does not leave the binding in place;
  // it redefines it like any other universal global, keeping the same value.
  const descriptor = getOwnPropertyDescriptor(globalThis, 'SturdyRef');
  t.is(descriptor?.value, SturdyRef);
  t.true(descriptor?.writable);
  t.true(descriptor?.configurable);
  t.false(descriptor?.enumerable);
});
