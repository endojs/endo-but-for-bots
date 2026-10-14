import test from '@endo/ses-ava/test.js';

import { passStyleOf } from '../src/passStyleOf.js';

const { create, defineProperty, freeze } = Object;
const mutableTest =
  Object.getOwnPropertyDescriptor(globalThis, 'Parcel')?.configurable !== false
    ? test
    : test.skip;

mutableTest(
  'a brand check that throws or answers truthy rejects the candidate',
  t => {
    // Only a brand check that returns exactly `true` recognizes a Parcel.
    // One that throws must not break classification of the candidate.
    const impostor = function Parcel() {};
    // Shaped like the shim's prototype, so that only the condition under test
    // can reject the impostor.
    defineProperty(impostor.prototype, Symbol.toStringTag, {
      value: 'Parcel',
    });
    const throwing = freeze(create(impostor.prototype));
    const truthy = freeze(create(impostor.prototype));
    impostor.isParcel = value => {
      if (value === throwing) {
        throw Error('boom');
      }
      return 1;
    };
    freeze(impostor.prototype);
    freeze(impostor.isParcel);
    freeze(impostor);
    /** @type {any} */ (globalThis).Parcel = impostor;
    try {
      t.throws(() => passStyleOf(throwing));
      t.throws(() => passStyleOf(truthy));
    } finally {
      delete (/** @type {any} */ (globalThis).Parcel);
    }
  },
);
