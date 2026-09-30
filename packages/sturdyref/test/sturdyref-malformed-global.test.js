// @ts-nocheck
// First-wins guards against a malformed pre-existing global: a value at
// globalThis.SturdyRef that is not a constructor with enliven and isSturdyRef
// statics is rejected loudly rather than silently adopted. Own file (own
// process) so the pre-seeded global is isolated.

import '@endo/init';
import test from 'ava';
import harden from '@endo/harden';
import { selectSturdyRef } from '../src/sturdyref-shim.js';

test('first-wins: a malformed pre-existing SturdyRef is rejected', t => {
  // An earlier draft's `{ fromLocation, toLocation }` namespace shape is
  // not a constructor, so it is rejected.
  Object.defineProperty(globalThis, 'SturdyRef', {
    value: harden({ fromLocation: () => {}, toLocation: () => {} }),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  t.throws(() => selectSturdyRef(), {
    message: /enliven and isSturdyRef/,
  });
});
