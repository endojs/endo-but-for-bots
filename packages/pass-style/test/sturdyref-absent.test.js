import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { makeSturdyRefConstructor } from '@endo/sturdyref';

import { passStyleOf } from '../src/passStyleOf.js';

test('without the shim, no SturdyRef global appears', t => {
  t.is(/** @type {any} */ (globalThis).SturdyRef, undefined);
});

test('without the shim, a ponyfill ref is not passable', t => {
  // Only the realm's shared constructor can vouch for a ref. Without it,
  // a ref is a frozen object with no methods and a foreign prototype.
  const Pony = makeSturdyRefConstructor();
  const ref = new Pony({ enliven: () => 'x' });
  harden(ref);
  t.throws(() => passStyleOf(ref));
});
