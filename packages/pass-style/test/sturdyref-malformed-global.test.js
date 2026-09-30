import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { passStyleOf } from '../src/passStyleOf.js';

test('a SturdyRef global without isSturdyRef vouches for nothing', t => {
  // Something other than the shim claimed the global. Recognition must not
  // trust it, and must not throw while looking.
  // The constructor and prototype are frozen, so only the missing
  // `isSturdyRef` can disqualify it.
  const impostor = function SturdyRef() {};
  Object.defineProperty(impostor.prototype, Symbol.toStringTag, {
    value: 'SturdyRef',
  });
  Object.freeze(impostor.prototype);
  Object.freeze(impostor);
  /** @type {any} */ (globalThis).SturdyRef = impostor;
  try {
    const ref = harden(Object.create(impostor.prototype));
    t.throws(() => passStyleOf(ref));
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
});
