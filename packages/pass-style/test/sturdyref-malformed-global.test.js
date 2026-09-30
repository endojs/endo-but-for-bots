import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { passStyleOf } from '../src/passStyleOf.js';

test('a SturdyRef global without isSturdyRef vouches for nothing', t => {
  // Something other than the shim claimed the global. Recognition must not
  // trust it, and must not throw while looking.
  const impostor = function SturdyRef() {};
  /** @type {any} */ (globalThis).SturdyRef = impostor;
  try {
    const ref = harden(Object.create(impostor.prototype));
    t.throws(() => passStyleOf(ref));
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
});
