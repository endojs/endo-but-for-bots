import test from 'ava';
import { Parcel } from './_parcel-deleted.js';
import '../index.js';

const { getOwnPropertyDescriptor } = Object;

lockdown();

test('lockdown restores a Parcel deleted during sampling, locked', t => {
  const descriptor = getOwnPropertyDescriptor(globalThis, 'Parcel');
  t.is(descriptor?.value, Parcel);
  t.false(descriptor?.writable);
  t.false(descriptor?.configurable);
  t.false(descriptor?.enumerable);
});

test('a child compartment still receives the ordinary shared binding', t => {
  const descriptor = getOwnPropertyDescriptor(
    new Compartment().globalThis,
    'Parcel',
  );
  t.not(descriptor?.value, Parcel);
  t.true(descriptor?.writable);
  t.true(descriptor?.configurable);
});
