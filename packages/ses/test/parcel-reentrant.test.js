import test from 'ava';
import { Parcel, payload } from './_parcel-reentrant.js';
import '../index.js';

const { getOwnPropertyDescriptor } = Object;

lockdown();

test('lockdown admits the Parcel it validated, not a re-pointed global', t => {
  t.not(Parcel, payload);
  t.is(/** @type {any} */ (globalThis).Parcel, Parcel);
  const shared = new Compartment().globalThis.Parcel;
  t.not(shared, payload);
  t.not(shared, Parcel);
  t.is(shared.prototype, Parcel.prototype);
});

test('lockdown restores a re-pointed Parcel with the first-wins lock', t => {
  const descriptor = getOwnPropertyDescriptor(globalThis, 'Parcel');
  t.is(descriptor?.value, Parcel);
  t.false(descriptor?.writable);
  t.false(descriptor?.configurable);
  t.false(descriptor?.enumerable);
  t.throws(() => {
    /** @type {any} */ (globalThis).Parcel = payload;
  });
  t.is(/** @type {any} */ (globalThis).Parcel, Parcel);
});
