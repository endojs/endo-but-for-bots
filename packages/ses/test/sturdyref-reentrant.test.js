import test from 'ava';
import { SturdyRef, payload } from './_sturdyref-reentrant.js';
import '../index.js';

lockdown();

test('lockdown admits the SturdyRef it validated, not a re-pointed global', t => {
  t.not(SturdyRef, payload);
  t.is(/** @type {any} */ (globalThis).SturdyRef, SturdyRef);
  t.is(new Compartment().globalThis.SturdyRef, SturdyRef);
});
