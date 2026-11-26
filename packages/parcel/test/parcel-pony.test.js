// The side-effect-free public entry delegates to the realm's selected
// constructor. Own file (own process) so the pre-lockdown install is isolated.

import test from 'ava';
import harden from '@endo/harden';
import * as parcelPony from '../index.js';
import { makeParcelConstructor } from '../no-shim.js';

const { isParcel, locate, makeParcel, open } = parcelPony;

test('ponyfill functions delegate to the selected constructor', async t => {
  await null;
  const parcel = makeParcel('test:pony', location => `opened ${location}`);
  const Installed = globalThis.Parcel;
  t.is(typeof Installed, 'function', 'makeParcel installs the shim');
  t.true(Installed.isParcel(parcel));
  t.true(isParcel(parcel));
  t.false(isParcel(harden({})));
  t.is(locate(parcel), 'test:pony');
  t.is(await open(parcel), 'opened test:pony');
  t.not(makeParcelConstructor(), Installed, 'each constructor is fresh');
  t.throws(() => locate(new (makeParcelConstructor())('x', () => {})), {
    message: /expects a Parcel/,
  });
});

test('ponyfill entry exports only the public delegation surface', t => {
  t.deepEqual(Object.keys(parcelPony), [
    'isParcel',
    'locate',
    'makeParcel',
    'open',
  ]);
});
