import test from '@endo/ses-ava/test.js';

import { passStyleOf } from '../src/passStyleOf.js';

const { create, defineProperty, freeze } = Object;

test('a brand check that throws or answers truthy rejects the candidate', t => {
  // Only a brand check that returns exactly `true` recognizes a SturdyRef.
  // One that throws must not break classification of the candidate.
  const impostor = function SturdyRef() {};
  // Shaped like the shim's prototype, so that only the condition under test
  // can reject the impostor.
  defineProperty(impostor.prototype, Symbol.toStringTag, {
    value: 'SturdyRef',
  });
  const throwing = freeze(create(impostor.prototype));
  const truthy = freeze(create(impostor.prototype));
  impostor.isSturdyRef = value => {
    if (value === throwing) {
      throw Error('boom');
    }
    return 1;
  };
  freeze(impostor.prototype);
  freeze(impostor.isSturdyRef);
  freeze(impostor);
  /** @type {any} */ (globalThis).SturdyRef = impostor;
  try {
    t.throws(() => passStyleOf(throwing));
    t.throws(() => passStyleOf(truthy));
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
});
