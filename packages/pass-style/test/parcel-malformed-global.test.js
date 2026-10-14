import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { passStyleOf } from '../src/passStyleOf.js';

const mutableTest =
  Object.getOwnPropertyDescriptor(globalThis, 'Parcel')?.configurable !== false
    ? test
    : test.skip;

mutableTest('a Parcel global without isParcel vouches for nothing', t => {
  // Something other than the shim claimed the global. Recognition must not
  // trust it, and must not throw while looking.
  // The constructor and prototype are frozen, so only the missing
  // `isParcel` can disqualify it.
  const impostor = function Parcel() {};
  Object.defineProperty(impostor.prototype, Symbol.toStringTag, {
    value: 'Parcel',
  });
  Object.freeze(impostor.prototype);
  Object.freeze(impostor);
  /** @type {any} */ (globalThis).Parcel = impostor;
  try {
    const ref = harden(Object.create(impostor.prototype));
    t.throws(() => passStyleOf(ref));
  } finally {
    delete (/** @type {any} */ (globalThis).Parcel);
  }
});
