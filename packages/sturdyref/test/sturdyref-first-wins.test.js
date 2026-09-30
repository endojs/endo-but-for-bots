// @ts-nocheck
// The other direction of first-wins: when a constructor is ALREADY installed at
// globalThis.SturdyRef (an eval twin got there first), the shim ADOPTS it
// rather than overwriting it, and refs minted by the twin work through this
// copy. Isolated in its own file (its own process) so its pre-seeded global
// does not perturb the real-install tests.

import '@endo/init';
import test from 'ava';
import {
  makeSturdyRefConstructor,
  provideSturdyRef,
  selectSturdyRef,
  enliven,
  isSturdyRef,
} from '../src/sturdyref-pony.js';

test('first-wins: an already-installed constructor is adopted, not overwritten', async t => {
  // A prior eval twin installed first.
  const TwinSturdyRef = makeSturdyRefConstructor();
  Object.defineProperty(globalThis, 'SturdyRef', {
    value: TwinSturdyRef,
    enumerable: false,
    writable: false,
    configurable: true,
  });

  t.is(selectSturdyRef(), TwinSturdyRef, 'selectSturdyRef adopts the twin');
  t.is(provideSturdyRef(), TwinSturdyRef, 'provideSturdyRef adopts the twin');
  t.is(globalThis.SturdyRef, TwinSturdyRef, 'the twin install is untouched');

  const ref = new TwinSturdyRef({ enliven: () => 'from the twin' });
  t.true(isSturdyRef(ref), "the twin's ref passes this copy's brand check");
  t.is(await enliven(ref), 'from the twin', 'and enlivens through this copy');
});
