import test from '@endo/ses-ava/test.js';

import { passStyleOf } from '../src/passStyleOf.js';

const { create, defineProperty, freeze } = Object;

test('a brand check that reenters passStyleOf does not recurse', t => {
  // `passStyleOf`'s cycle guard is per call, so a brand check that classifies
  // its own candidate would recurse without bound unless the reentrant check
  // declines.
  const impostor = function SturdyRef() {};
  // Shaped like the shim's prototype, so that only the condition under test
  // can reject the impostor.
  defineProperty(impostor.prototype, Symbol.toStringTag, {
    value: 'SturdyRef',
  });
  const reentrant = freeze(create(impostor.prototype));
  let calls = 0;
  impostor.isSturdyRef = value => {
    calls += 1;
    try {
      passStyleOf(value);
    } catch {
      // The reentrant classification rejects the candidate.
    }
    return true;
  };
  freeze(impostor.prototype);
  freeze(impostor.isSturdyRef);
  freeze(impostor);
  /** @type {any} */ (globalThis).SturdyRef = impostor;
  try {
    t.is(passStyleOf(reentrant), 'sturdyRef');
    t.is(calls, 1);
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
});
