// First-wins guards against a malformed pre-existing global: a value at
// globalThis.Parcel that is not a constructor with open and isParcel
// statics is rejected loudly rather than silently adopted. Own file (own
// process) so the pre-seeded global is isolated.

import test from 'ava';
import harden from '@endo/harden';
import { selectParcel } from '../src/parcel-shim.js';

test('first-wins: a malformed pre-existing Parcel is rejected', t => {
  // An earlier draft's `{ fromLocation, toLocation }` namespace shape is
  // not a constructor, so it is rejected.
  Object.defineProperty(globalThis, 'Parcel', {
    value: harden({ fromLocation: () => {}, toLocation: () => {} }),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  t.throws(() => selectParcel(), {
    message: /initial or shared Parcel constructor/,
  });
});
