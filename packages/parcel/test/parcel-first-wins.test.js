// The other direction of first-wins: when a constructor is ALREADY installed at
// globalThis.Parcel (an eval twin got there first), the shim ADOPTS it
// rather than overwriting it, and refs minted by the twin work through this
// copy. Isolated in its own file (its own process) so its pre-seeded global
// does not perturb the real-install tests.

import test from 'ava';
import {
  makeParcelConstructor,
  provideParcel,
  selectParcel,
} from '../src/parcel-shim.js';
import { open, isParcel } from '../src/parcel-pony.js';

test('first-wins: an already-installed constructor is adopted, not overwritten', async t => {
  await null;
  // A prior eval twin installed first.
  const TwinParcel = makeParcelConstructor();
  Object.defineProperty(globalThis, 'Parcel', {
    value: TwinParcel,
    enumerable: false,
    writable: false,
    configurable: true,
  });

  t.is(selectParcel(), TwinParcel, 'selectParcel adopts the twin');
  t.is(provideParcel(), TwinParcel, 'provideParcel adopts the twin');
  t.is(globalThis.Parcel, TwinParcel, 'the twin install is untouched');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Parcel');
  if (descriptor === undefined) {
    t.fail('Parcel must be an own property');
    return;
  }
  t.false(descriptor.configurable, 'adoption locks a configurable global');
  t.false(descriptor.writable, 'adoption locks a writable global');
  t.throws(
    () =>
      Object.defineProperty(globalThis, 'Parcel', {
        value: makeParcelConstructor(),
      }),
    { instanceOf: TypeError },
    'a later redefinition cannot displace the adopted constructor',
  );

  const ref = new TwinParcel('test:twin', () => 'from the twin');
  t.true(isParcel(ref), "the twin's ref passes this copy's brand check");
  t.is(await open(ref), 'from the twin', 'and opens through this copy');
});
