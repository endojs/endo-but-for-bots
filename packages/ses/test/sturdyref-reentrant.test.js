import test from 'ava';
import { SturdyRef, payload } from './_sturdyref-reentrant.js';
import '../index.js';

const { getOwnPropertyDescriptor } = Object;

lockdown();

test('lockdown admits the SturdyRef it validated, not a re-pointed global', t => {
  t.not(SturdyRef, payload);
  t.is(/** @type {any} */ (globalThis).SturdyRef, SturdyRef);
  t.is(new Compartment().globalThis.SturdyRef, SturdyRef);
});

test('lockdown restores a re-pointed SturdyRef with the first-wins lock', t => {
  const descriptor = getOwnPropertyDescriptor(globalThis, 'SturdyRef');
  t.is(descriptor?.value, SturdyRef);
  t.false(descriptor?.writable);
  t.false(descriptor?.configurable);
  t.false(descriptor?.enumerable);
  t.throws(() => {
    /** @type {any} */ (globalThis).SturdyRef = payload;
  });
  t.is(/** @type {any} */ (globalThis).SturdyRef, SturdyRef);
});
