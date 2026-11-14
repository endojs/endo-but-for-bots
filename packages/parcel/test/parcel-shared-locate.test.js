// A shared constructor (the form SES exposes to child compartments) omits
// `locate`, so the ponyfill's `locate` refuses rather than leaking locations.
// Own file (own process) so the pre-seeded global is isolated.

import test from 'ava';
import { makeParcelConstructor } from '../src/parcel-shim.js';
import { isParcel, locate, open } from '../src/parcel-pony.js';

test('locate is unavailable through a shared constructor', async t => {
  await null;
  const Initial = makeParcelConstructor();
  class SharedParcel {
    static open(parcel) {
      return Initial.open(parcel);
    }

    static isParcel(value) {
      return Initial.isParcel(value);
    }
  }
  Object.defineProperty(globalThis, 'Parcel', {
    value: SharedParcel,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  const parcel = new Initial('test:shared', () => 'shared');
  t.true(isParcel(parcel));
  t.is(await open(parcel), 'shared');
  t.throws(() => locate(parcel), {
    message: /Parcel.locate is not available on the shared constructor/,
  });
});
