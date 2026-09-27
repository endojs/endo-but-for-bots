// @ts-nocheck
// The other direction of first-wins: when a namespace is ALREADY installed at
// globalThis.SturdyRef (an eval twin got there first), the shim ADOPTS it rather
// than overwriting it. Isolated in its own file (its own process) so its
// pre-seeded global does not perturb the real-install tests.

import '@endo/init';
import test from 'ava';
import harden from '@endo/harden';
import { provideSturdyRef, selectSturdyRef } from '../src/sturdyref-pony.js';

test('first-wins: an already-installed namespace is adopted, not overwritten', t => {
  const preExisting = harden({
    fromLocation: () => {
      throw new Error('should not be called');
    },
    toLocation: () => {
      throw new Error('should not be called');
    },
    sentinel: 'the twin that won the race',
  });
  // A prior eval twin installed first.
  Object.defineProperty(globalThis, 'SturdyRef', {
    value: preExisting,
    enumerable: false,
    writable: false,
    configurable: true,
  });

  t.is(
    selectSturdyRef(),
    preExisting,
    'selectSturdyRef adopts the existing one',
  );
  t.is(
    provideSturdyRef(),
    preExisting,
    'provideSturdyRef adopts the existing one',
  );
  t.is(
    globalThis.SturdyRef,
    preExisting,
    'the pre-existing install is untouched',
  );
});
